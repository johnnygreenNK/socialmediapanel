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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: true, // behind Caddy / tunnel
});

// ── Security headers ──────────────────────────────────────────────────────────
app.addHook('onSend', async (req, reply) => {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'no-referrer');
  reply.header(
    'content-security-policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https:; connect-src 'self' wss: ws:; frame-src 'self'; object-src 'none'",
  );
});

await app.register(websocket);
await app.register(panelRoutes);
await app.register(viewerRoutes);

await app.register(fstatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
});

app.get('/healthz', async () => ({ ok: true }));

process.on('unhandledRejection', (err) => {
  app.log.error({ err }, 'unhandled rejection (ignored, server stays up)');
});
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaught exception (ignored, server stays up)');
});

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down, persisting profiles');
  telegram.stopPolling();
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

browser.startIdleReaper(app.log);
telegram.startPolling();
