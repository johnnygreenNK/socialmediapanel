// Live viewer WebSocket — auth, input forwarding, CDP screencast.
// Screencast at ~15 FPS (everyNthFrame:4) — smooth without hammering CPU.

import { getAccount, getAccountByRef } from './accounts.js';
import * as browser from './browser.js';
import { isLocked, recordFailure, recordSuccess } from './pinGuard.js';

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
    let dpr = 1;
    let closed = false;

    function isTargetGone(err) {
      const m = String(err?.message || '');
      return m.includes('Target closed') || m.includes('Target page') || m.includes('Session closed');
    }

    async function closeCleanly() {
      if (closed) return;
      closed = true;
      try { await cdp.send('Page.stopScreencast'); } catch { /* ignore */ }
      try { await cdp.detach(); } catch { /* ignore */ }
      try { socket.close(4409, 'session_not_running'); } catch { /* ignore */ }
    }

    // --- screencast ---
    cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
      if (closed) return;
      try {
        socket.send(JSON.stringify({ t: 'frame', data }));
        await cdp.send('Page.screencastFrameAck', { sessionId });
      } catch (err) {
        if (isTargetGone(err)) await closeCleanly();
      }
    });

    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        everyNthFrame: 2,   // ~30 FPS
      });
    } catch (err) {
      if (isTargetGone(err)) { await closeCleanly(); return; }
    }

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
          await page.setViewportSize({ width, height });
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor: dpr, mobile: false,
            screenWidth: width, screenHeight: height,
          });
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
        } else if (msg.t === 'key') {
          await cdp.send('Input.dispatchKeyEvent', {
            type: msg.type,
            key: msg.key, code: msg.code, text: msg.text,
            windowsVirtualKeyCode: msg.keyCode,
            modifiers: msg.modifiers || 0,
          });
        }
      } catch (err) {
        if (isTargetGone(err)) await closeCleanly();
      }
    };
    for (const raw of early.splice(0)) await onMessage(raw);

    // --- cleanup on WS close ---
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      try { await cdp.send('Page.stopScreencast'); } catch { /* ignore */ }
      try { await cdp.detach(); } catch { /* ignore */ }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}
