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

// A single uncaught rejection anywhere (e.g. a Playwright call racing a
// browser crash) used to take the entire panel down with it, killing every
// account's session at once. Log it and keep running instead.
process.on('unhandledRejection', (err) => {
  app.log.error({ err }, 'unhandled rejection (ignored, server stays up)');
});
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaught exception (ignored, server stays up)');
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
