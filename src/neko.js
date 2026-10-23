// neko-based browser session manager.
//
// Each account gets its own neko Docker container (Chromium + Xvfb + GStreamer,
// streamed to the browser over WebRTC). It replaces the old Playwright-launched
// headless Chrome: better quality AND smoother motion at the same time, since
// WebRTC's video codec only sends what changed between frames instead of a
// fresh full-size JPEG every time (see neko.js's header comment history / the
// conversation that led here for the full reasoning).
//
// Our own automation (password/email capture, cookie export, activity log)
// still works exactly as before — we attach to the SAME Chrome neko drives via
// Playwright's connectOverCDP, rather than launching our own browser.
//
// Networking note: this host is an LXC container (not a full VM), which blocks
// the sysctl writes Docker normally does when creating a fresh network
// namespace. --network host sidesteps that entirely (confirmed working via a
// PoC) — but it also means every neko container shares the HOST's port space,
// so each account needs its own CDP/web/WebRTC ports (see accounts.js's
// `slot` field).

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { chromium } from 'playwright';
import { config } from './config.js';
import { getAccount, loadAccounts, saveAccount } from './accounts.js';

const exec = promisify(execCb);

const sessions = new Map(); // accountId -> { browser, context, page, ports, lastActivity }
const starting = new Map(); // accountId -> Promise

const activityLog = [];
const MAX_LOG_ENTRIES = 300;
function pushLog(accountId, type, message) {
  activityLog.push({ ts: Date.now(), accountId, type, message });
  if (activityLog.length > MAX_LOG_ENTRIES) activityLog.shift();
}
export function getLogs(since = 0) {
  return activityLog.filter((e) => e.ts > since);
}
export const logActivity = pushLog;

// Port ranges: each account's `slot` picks a unique, non-overlapping block.
const BASE_CDP_PORT = 19000;      // CDP — localhost-only, used by us (never public)
const BASE_NEKO_PORT = 18100;     // neko's own web UI — reverse-proxied by us
const BASE_WEBRTC_PORT = 52000;   // WebRTC media (UDP) — must be reachable directly
const WEBRTC_RANGE_SIZE = 50;
const PROXY_RELAY = 'http://127.0.0.1:18080'; // local relay that adds upstream proxy auth

function portsFor(account) {
  const slot = account.slot ?? 0;
  const webrtcStart = BASE_WEBRTC_PORT + slot * WEBRTC_RANGE_SIZE;
  return {
    cdp: BASE_CDP_PORT + slot,
    neko: BASE_NEKO_PORT + slot,
    webrtcStart,
    webrtcEnd: webrtcStart + WEBRTC_RANGE_SIZE - 1,
  };
}

function containerName(accountId) {
  return `neko-${accountId}`;
}

function profileDir(accountId) {
  return path.join(config.dataDir, 'neko-profiles', accountId);
}

async function launch(accountId) {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`unknown account: ${accountId}`);

  const ports = portsFor(account);
  const name = containerName(accountId);
  const dir = profileDir(accountId);
  await fsp.mkdir(dir, { recursive: true });
  await exec(`chown -R 1000:1000 ${JSON.stringify(dir)}`).catch(() => {});

  // Clear out any stale container left over from a crash.
  await exec(`docker rm -f ${name}`).catch(() => {});

  const args = [
    'docker run -d',
    `--name ${name}`,
    '--network host',
    `-v ${JSON.stringify(dir)}:/home/neko/.config/chromium`,
    '-e NEKO_DESKTOP_SCREEN=1920x1080@30',
    // Grant control automatically — no "request control" click needed. We're
    // always the only viewer, and we just hid that button's UI anyway.
    '-e NEKO_SESSION_IMPLICIT_HOSTING=true',
    // No login screen inside neko itself: our own /account/login route
    // already checked the PIN before redirecting here, and each account's
    // port isn't published anywhere, so a second password prompt is pure
    // friction with no real security benefit in this single-operator setup.
    '-e NEKO_MEMBER_PROVIDER=noauth',
    // We serve plain HTTP (no TLS in front), but neko's session cookie
    // defaults to Secure — the browser silently refuses to store/send it
    // over HTTP, so the session never persists and it looks like it keeps
    // bouncing back to a login/join screen. Session cookies aren't carrying
    // any real secret here anyway (noauth + our own PIN already gate this).
    '-e NEKO_SESSION_COOKIE_SECURE=false',
    `-e NEKO_WEBRTC_EPR=${ports.webrtcStart}-${ports.webrtcEnd}`,
    `-e NEKO_WEBRTC_NAT1TO1=${config.publicHost}`,
    `-e NEKO_SERVER_BIND=:${ports.neko}`,
    `-e NEKO_CDP_PORT=${ports.cdp}`,
    `-e NEKO_PROXY=${config.proxyServer ? PROXY_RELAY : 'direct://'}`,
    'neko-poc:latest',
  ].join(' ');

  await exec(args);

  // Wait for CDP to actually come up before handing back control.
  const cdpUrl = `http://127.0.0.1:${ports.cdp}`;
  let browser;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!browser) {
    await exec(`docker logs ${name} --tail 40`).catch(() => {});
    throw new Error(`neko container for ${accountId} never exposed CDP on ${cdpUrl}`);
  }

  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());

  await attachCapture(context, accountId);
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) pushLog(accountId, 'nav', frame.url());
  });

  if (account.startUrl) {
    await page.goto(account.startUrl).catch(() => {});
  }

  const s = { browser, context, page, ports, lastActivity: Date.now() };
  sessions.set(accountId, s);
  browser.on('disconnected', () => {
    if (sessions.get(accountId) === s) sessions.delete(accountId);
  });

  pushLog(accountId, 'open', 'Sesja uruchomiona');
  return s;
}

// Same capture mechanism as the old Playwright-launched browser.js: walks
// into shadow DOM (Google's login forms live there) and reports typed
// email/password/other-field activity back through an exposed binding.
async function attachCapture(context, accountId) {
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

  await context.addInitScript(() => {
    const report = (type, value) => {
      try { window.__spCapture({ type, value }); } catch { /* binding not ready yet */ }
    };
    const fieldLabel = (el) =>
      el.getAttribute('aria-label') || el.placeholder || el.name || el.id || el.type || 'pole';
    const bind = (el) => {
      if (el.__spBound) return;
      el.__spBound = true;
      let hadValue = Boolean(el.value);
      const handler = () => {
        const v = el.value;
        const has = Boolean(v);
        if (has && !hadValue) {
          if (el.type === 'password') report('password', v);
          else if (el.type === 'email' || /email|login|user/i.test(`${el.name || ''} ${el.id || ''}`)) {
            report('email', v);
          } else {
            report('fill', fieldLabel(el));
          }
        } else if (!has && hadValue) {
          report('clear', fieldLabel(el));
        }
        hadValue = has;
      };
      el.addEventListener('blur', handler);
      el.addEventListener('change', handler);
    };
    const scanRoot = (root) => {
      root
        .querySelectorAll('input[type="password"], input[type="email"], input[type="text"], input[type="tel"], input[type="search"], input[type="number"], textarea')
        .forEach(bind);
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) scanRoot(el.shadowRoot);
      });
    };
    const watch = (root) => {
      scanRoot(root);
      new MutationObserver(() => scanRoot(root)).observe(root, { childList: true, subtree: true });
    };
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = origAttachShadow.call(this, init);
      watch(root);
      return root;
    };
    watch(document);
  });
}

export async function start(accountId) {
  if (sessions.has(accountId)) {
    sessions.get(accountId).lastActivity = Date.now();
    return status(accountId);
  }
  if (!starting.has(accountId)) {
    starting.set(accountId, launch(accountId).finally(() => starting.delete(accountId)));
  }
  await starting.get(accountId);
  return status(accountId);
}

export function touchActivity(accountId) {
  const s = sessions.get(accountId);
  if (s) s.lastActivity = Date.now();
}

export async function stop(accountId) {
  const s = sessions.get(accountId);
  sessions.delete(accountId);
  if (s) await s.browser.close().catch(() => {});
  await exec(`docker stop ${containerName(accountId)}`).catch(() => {});
  return { running: false };
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

export function status(accountId) {
  const s = sessions.get(accountId);
  return {
    accountId,
    running: Boolean(s),
    lastActivity: s ? s.lastActivity : null,
    nekoPort: s ? s.ports.neko : null,
  };
}

export function listStatus() {
  return [...sessions.keys()].map((id) => status(id));
}

// Resolve an account's neko web-UI port for the reverse proxy, starting the
// session first if it isn't running yet.
export async function portFor(accountId) {
  await start(accountId);
  return sessions.get(accountId)?.ports.neko ?? null;
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const REAPER_INTERVAL_MS = 60 * 1000;

export function startIdleReaper(log = console) {
  setInterval(() => {
    const now = Date.now();
    for (const [accountId, s] of sessions) {
      if (now - s.lastActivity > IDLE_TIMEOUT_MS) {
        log.info({ accountId }, 'stopping idle neko session');
        stop(accountId).catch((err) => log.error({ err, accountId }, 'idle stop failed'));
      }
    }
  }, REAPER_INTERVAL_MS);
}

export async function shutdownAll() {
  const accounts = await loadAccounts();
  await Promise.all(accounts.map((a) => stop(a.id).catch(() => {})));
}
