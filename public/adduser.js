const $ = (s) => document.querySelector(s);

// Session is handled by HttpOnly cookie — no PIN in JS needed.
const api = (path, opts = {}) => {
  const headers = {
    ...(opts.body ? { 'content-type': 'application/json' } : {}),
    ...(opts.headers || {}),
  };
  return fetch(path, { credentials: 'same-origin', ...opts, headers });
};

function labelToId(s) {
  return s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
}

function toast(message, kind = 'success', duration = 4000) {
  let container = $('#toastContainer');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  const icon = document.createElement('div');
  icon.className = 'toast-icon';
  icon.textContent = kind === 'success' ? '✓' : (kind === 'error' ? '!' : 'ℹ');
  const text = document.createElement('div');
  text.className = 'toast-text';
  text.textContent = message;
  el.append(icon, text);
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-in'));
  setTimeout(() => {
    el.classList.remove('toast-in');
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/* ── Auth check on load ── */
(async () => {
  const res = await fetch('/api/accounts', { credentials: 'same-origin' }).catch(() => null);
  if (!res || res.status === 401) location.replace('/login');
})();

/* ── Logout ── */
$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  location.replace('/login');
});

/* ── Load mini account list ── */
async function renderMiniList() {
  const res = await api('/api/accounts').catch(() => null);
  if (!res || !res.ok) return;
  const accounts = await res.json();
  const list = $('#acctMiniList');
  list.innerHTML = '';
  if (accounts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'min-acct-empty';
    empty.textContent = 'Brak kont.';
    list.append(empty);
    return;
  }
  for (const a of accounts) {
    const row = document.createElement('div');
    row.className = 'min-acct';

    const name = document.createElement('span');
    name.className = 'min-acct-name';
    name.textContent = a.label;

    const del = document.createElement('button');
    del.className = 'min-acct-del';
    del.textContent = '×';
    del.title = 'Usuń konto';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Usunąć "${a.label}"?`)) return;
      await api(`/api/accounts/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
      renderMiniList();
    };

    row.append(name, del);
    list.append(row);
  }
}

renderMiniList();

/* ── Platform buttons → create account ── */
document.querySelectorAll('.plat-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const name = $('#addName').value.trim();
    if (!name) {
      $('#addName').focus();
      $('#addName').style.borderColor = 'var(--red)';
      toast('Wpisz imię / nazwę przed wyborem platformy', 'error');
      return;
    }
    $('#addName').style.borderColor = '';
    const id = labelToId(`${name}-${btn.dataset.platform}`);
    if (!id) { toast('Nazwa zawiera niedozwolone znaki', 'error'); return; }
    const platLabel = btn.querySelector('span:not(.plat-icon)')?.textContent.trim() || btn.dataset.platform;
    const proxyUrl = $('#addProxy').value.trim();
    const body = { id, label: `${name} – ${platLabel}`, startUrl: btn.dataset.url };
    if (proxyUrl) body.proxyUrl = proxyUrl;

    btn.disabled = true;
    btn.style.opacity = '0.5';

    try {
      const res = await api('/api/accounts', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        const errMap = {
          invalid_proxy_url: 'Nieprawidłowy format proxy. Użyj: socks5://user:pass@host:port lub http://user:pass@host:port',
        };
        toast(errMap[e.error] || `Błąd: ${e.error || res.status}`, 'error', 6000);
        return;
      }

      // Fetch the newly created account to get its ref
      const acctRes = await api(`/api/accounts`);
      const accounts = await acctRes.json();
      const acc = accounts.find(a => a.id === id);
      const ref = acc?.ref || '';
      const link = ref ? `${location.origin}/account/login?ref=${ref}` : '';

      $('#genLink').value = link;
      $('#linkResult').style.display = '';
      toast(`Konto "${name} – ${platLabel}" utworzone!`, 'success');
      renderMiniList();
    } catch (err) {
      toast(`Błąd połączenia: ${err.message}`, 'error', 6000);
    } finally {
      btn.disabled = false;
      btn.style.opacity = '';
    }
  });
});

/* ── Copy link ── */
$('#copyLinkBtn').addEventListener('click', () => {
  const link = $('#genLink').value;
  if (!link) return;
  navigator.clipboard.writeText(link).then(() => {
    toast('Link skopiowany!', 'success');
  }).catch(() => {
    $('#genLink').select();
    document.execCommand('copy');
    toast('Link skopiowany!', 'success');
  });
});

/* ── Add another ── */
$('#addAnotherBtn').addEventListener('click', () => {
  $('#linkResult').style.display = 'none';
  $('#addName').value = '';
  $('#addProxy').value = '';
  $('#addName').focus();
});
