// Central configuration, read from environment with safe defaults.

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: int('PORT', 8080),
  dataDir: process.env.DATA_DIR || '/data',
  // PIN required when the server is exposed beyond localhost.
  // Set PIN= in .env; leave empty to skip (safe only on 127.0.0.1).
  pin: process.env.PIN || '',
  // 'chrome' uses the system-installed Google Chrome (better for Google/Gmail).
  // Leave empty to use Playwright's bundled Chromium.
  browserChannel: process.env.BROWSER_CHANNEL || '',
  // Outbound proxy for all browser sessions, e.g. socks5://host:port
  proxyServer: process.env.PROXY_SERVER || '',
  proxyUsername: process.env.PROXY_USERNAME || '',
  proxyPassword: process.env.PROXY_PASSWORD || '',
  // Public IP/host of this server — used for neko's WebRTC NAT1TO1 setting
  // so ICE candidates point somewhere the viewer's browser can reach.
  publicHost: process.env.PUBLIC_HOST || '',
  // Optional: mirrors the live activity log to a Telegram chat and sends
  // cookies there automatically once a login is detected. Both must be set
  // for it to do anything — see src/telegram.js.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  gmailClientId: process.env.GMAIL_CLIENT_ID || '',
  gmailClientSecret: process.env.GMAIL_CLIENT_SECRET || '',
};
