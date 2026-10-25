// Live viewer WebSocket — auth, input forwarding, and pull-based screenshot loop.
// Screenshots are taken every ~1 s (much lighter than CDP screencast push).

import { getAccount, getAccountByRef } from './accounts.js';
import * as browser from './browser.js';
import { isLocked, recordFailure, recordSuccess } from './pinGuard.js';

const SCREENSHOT_INTERVAL_MS = 1000;

export default async function viewerRoutes(app) {
  app.get('/api/accounts/:id/viewer', { websocket: true }, async (socket, req) => {
    const accountId = req.params.id;

    // Hold early messages until the handler is ready.
    let onMessage = null;
    const early = [];
    socket.on('message', (raw) => (onMessage ? onMessage(raw) : early.push(raw)));

    // --- auth ---
    if (isLocked(req.ip)) {
      socket.close(4429, 'too_many_attempts');
      return;
    }
    {
      const { validateSession } = await import('./session.js');
      const cookieToken = (req.headers.cookie || '').match(/(?:^|;\s*)__sp_s=([0-9a-f]{64})/)?.[1];
      const isAdminSession = cookieToken && validateSession(cookieToken);
      const refParam = req.query?.ref || '';
      let isValidRef = false;
      if (refParam && !isAdminSession) {
        const refAcc = await getAccountByRef(refParam);
        isValidRef = Boolean(refAcc && refAcc.id === accountId);
      }
      if (!isAdminSession && !isValidRef) {
        recordFailure(req.ip);
        socket.close(4401, 'unauthorized');
        return;
      }
      recordSuccess(req.ip);
    }

    let resolvedId = accountId;
    if (accountId.startsWith('ref:')) {
      const acc = await getAccountByRef(accountId.slice(4));
      if (!acc) { socket.close(4404, 'unknown_ref'); return; }
      resolvedId = acc.id;
    } else if (!await getAccount(accountId)) {
      socket.close(4404, 'unknown_account');
      return;
    }

    let cdp = await browser.newCdpSession(resolvedId).catch(() => null);
    if (!cdp) {
      socket.close(4409, 'session_not_running');
      return;
    }
    browser.logActivity(resolvedId, 'open', `Ktoś wszedł na podgląd (${accountId})`);

    const page = browser.getPage(resolvedId);
    const vp = page.viewportSize() || browser.DEFAULT_VIEWPORT;
    let currentSize = { width: vp.width, height: vp.height };
    let dpr = 1;

    // --- screenshot loop ---
    let screenshotTimer = null;
    let closed = false;

    function send(obj) {
      try {
        if (socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(obj));
      } catch { /* ignore */ }
    }

    async function sendScreenshot() {
      if (closed) return;
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 65, timeout: 4000 });
        if (!closed) send({ t: 'frame', data: buf.toString('base64') });
      } catch (err) {
        const msg = String(err?.message || '');
        if (msg.includes('Target closed') || msg.includes('Target page')) {
          closed = true;
          socket.close(4409, 'session_not_running');
          return;
        }
      }
      if (!closed) screenshotTimer = setTimeout(sendScreenshot, SCREENSHOT_INTERVAL_MS);
    }

    // First screenshot immediately, then loop
    sendScreenshot();

    // --- inbound: resize + input events ---
    onMessage = async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      browser.touchActivity(resolvedId);
      try {
        if (msg.t === 'resize') {
          const reqW = Math.max(1, Math.round(msg.width));
          const reqH = Math.max(1, Math.round(msg.height));
          const scale = Math.min(1, 2560 / reqW, 1440 / reqH);
          const width  = Math.max(320, Math.round(reqW * scale));
          const height = Math.max(240, Math.round(reqH * scale));
          const requestedDpr = Math.max(1, Number(msg.dpr) || 1);
          dpr = Math.min(requestedDpr, Math.max(1, 2600 / width));
          currentSize = { width, height };
          await page.setViewportSize({ width, height });
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor: dpr, mobile: false,
            screenWidth: width, screenHeight: height,
          });
          // Take a screenshot right away after resize
          clearTimeout(screenshotTimer);
          sendScreenshot();
        } else if (msg.t === 'mouse') {
          await cdp.send('Input.dispatchMouseEvent', {
            type: msg.type,
            x: msg.x, y: msg.y,
            button: msg.button || 'none',
            buttons: msg.buttons || 0,
            clickCount: msg.clickCount || 0,
            deltaX: msg.deltaX || 0,
            deltaY: msg.deltaY || 0,
            modifiers: msg.modifiers || 0,
          });
          // Refresh screen after mouse interaction
          clearTimeout(screenshotTimer);
          screenshotTimer = setTimeout(sendScreenshot, 150);
        } else if (msg.t === 'key') {
          await cdp.send('Input.dispatchKeyEvent', {
            type: msg.type,
            key: msg.key, code: msg.code, text: msg.text,
            windowsVirtualKeyCode: msg.keyCode,
            modifiers: msg.modifiers || 0,
          });
          clearTimeout(screenshotTimer);
          screenshotTimer = setTimeout(sendScreenshot, 150);
        }
      } catch { /* ignore transient CDP errors */ }
    };
    for (const raw of early.splice(0)) await onMessage(raw);

    // --- cleanup ---
    const cleanup = async () => {
      closed = true;
      clearTimeout(screenshotTimer);
      try { await cdp.detach(); } catch { /* ignore */ }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}
