// Fastify entrypoint.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fstatic from '@fastify/static';
import { config } from './config.js';
import panelRoutes from './routes/panel.js';
import viewerRoutes from './viewer.js';
import * as browser from './browser.js';
import * as telegram from './telegram.js';
import { userCount } from './userdb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: true, // behind Caddy / tunnel
});

await app.register(websocket);
await app.register(panelRoutes);
await app.register(viewerRoutes);

// Serve the bundled reference client (public/). Your own HTML/CSS front end can
// replace this, or embed public/viewer.js directly.
await app.register(fstatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
  index: false,  // disable automatic index.html — our route guard handles /
});

app.get('/healthz', async () => ({ ok: true }));

// Playwright calls racing a browser crash produce unhandled rejections —
// log them and keep running so one crashed session doesn't kill all others.
// For uncaught exceptions we distinguish Playwright/CDP errors (safe to
// continue) from anything else, which gets re-thrown after logging because
// an unknown exception may leave the process in a broken state.
process.on('unhandledRejection', (err) => {
  app.log.error({ err }, 'unhandled rejection (server stays up)');
});
process.on('uncaughtException', (err) => {
  const msg = String(err?.message || '');
  const isPlaywright = /Target closed|Target page|Session closed|Browser.*closed|Protocol error/i.test(msg);
  if (isPlaywright) {
    app.log.error({ err }, 'uncaught Playwright error (server stays up)');
    return;
  }
  app.log.fatal({ err }, 'uncaught exception — restarting');
  process.exit(1);
});

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down, persisting profiles');
  await browser.shutdownAll();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Warn if no panel users exist yet — admin should create one via Telegram /adduser
const count = await userCount().catch(() => 0);
if (count === 0) {
  app.log.warn('No panel users found. Create one via Telegram: /adduser <login> <password>');
}

// Accounts launch lazily on first access (see /start routes) and idle ones
// are stopped automatically — see browser.js's reaper. Running every account
// 24/7 overloads small VPS boxes once more than a couple of accounts exist.
browser.startIdleReaper(app.log);

// Listen for /adduser commands from the admin's Telegram account.
telegram.startCommandListener(config.publicHost);
