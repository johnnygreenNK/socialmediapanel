// Live viewer over WebSocket.
//
// Out: the remote page is streamed as JPEG frames via CDP Page.startScreencast,
//      forwarded to the browser as data-URL strings drawn into an <img>.
// In:  the browser sends mouse/keyboard events, dispatched into the page via
//      CDP Input.dispatch{Mouse,Key}Event.
//
// No auth: the server only listens on 127.0.0.1. Coordinates are in the
// remote page's own pixel space (the client scales before sending). The client
// sends { t: 'resize', width, height } so the remote page fills its viewer.

import { getAccount, getAccountByRef } from './accounts.js';
import * as browser from './browser.js';
import { config } from './config.js';

export default async function viewerRoutes(app) {
  app.get('/api/accounts/:id/viewer', { websocket: true }, async (socket, req) => {
    const accountId = req.params.id;

    // The client sends its size as soon as the socket opens, before the setup
    // below finishes, so hold early messages until the handler is ready.
    let onMessage = null;
    const early = [];
    socket.on('message', (raw) => (onMessage ? onMessage(raw) : early.push(raw)));

    // --- auth + preconditions ---
    if (config.pin) {
      const provided = req.headers['x-pin'] || req.query?.pin || '';
      if (provided !== config.pin) {
        socket.close(4401, 'invalid_pin');
        return;
      }
    }

    // Support both /api/accounts/:id/viewer and ref-based lookup
    let resolvedId = accountId;
    if (accountId.startsWith('ref:')) {
      const acc = await getAccountByRef(accountId.slice(4));
      if (!acc) { socket.close(4404, 'unknown_ref'); return; }
      resolvedId = acc.id;
    } else if (!await getAccount(accountId)) {
      socket.close(4404, 'unknown_account');
      return;
    }
    const cdp = await browser.newCdpSession(resolvedId).catch(() => null);
    if (!cdp) {
      socket.close(4409, 'session_not_running'); // call /start first
      return;
    }
    browser.logActivity(resolvedId, 'open', `Ktoś wszedł na podgląd (${accountId})`);

    const send = (obj) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    };

    // --- outbound: screencast frames ---
    // Chromium only captures the next frame once we ack this one, so we use
    // that as backpressure: don't ack until the current frame has actually
    // been WRITTEN to the socket. Ack too early (before the slow link below
    // drains) and frames pile up faster than they can be delivered, which
    // looks exactly like a choppy, low-fps stream even though capture itself
    // is fine.
    // Temporary diagnostics: log actual achieved fps + per-frame send time
    // every 5s so we have real numbers instead of guessing at tuning values.
    let frameCount = 0;
    let sendTimeTotal = 0;
    let bytesTotal = 0;
    let statsStart = Date.now();
    const statsTimer = setInterval(() => {
      const elapsed = (Date.now() - statsStart) / 1000;
      if (frameCount > 0) {
        req.log.info({
          accountId: resolvedId,
          fps: (frameCount / elapsed).toFixed(1),
          avgSendMs: (sendTimeTotal / frameCount).toFixed(1),
          avgKB: (bytesTotal / frameCount / 1024).toFixed(1),
        }, 'viewer stream stats');
      }
      frameCount = 0; sendTimeTotal = 0; bytesTotal = 0; statsStart = Date.now();
    }, 5000);

    const onFrame = async ({ data, sessionId }) => {
      browser.touchActivity(resolvedId);
      if (socket.readyState !== socket.OPEN) return;
      const t0 = Date.now();
      await new Promise((resolve) => {
        socket.send(JSON.stringify({ t: 'frame', data }), () => resolve());
      });
      frameCount++;
      sendTimeTotal += Date.now() - t0;
      bytesTotal += data.length;
      try {
        await cdp.send('Page.screencastFrameAck', { sessionId });
      } catch {
        /* page may have navigated/closed */
      }
    };
    cdp.on('Page.screencastFrame', onFrame);

    // Stream at the page's current size; restarted when the client resizes.
    // Chromium only emits screencast frames when something repaints, so a
    // still page would never show its new size: send one snapshot right away.
    const startScreencast = async (width, height) => {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 72,
        maxWidth: width,
        maxHeight: height,
        everyNthFrame: 1,
      });
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
      send({ t: 'frame', data });
    };

    const page = browser.getPage(resolvedId);
    const vp = page.viewportSize() || browser.DEFAULT_VIEWPORT;
    try {
      await startScreencast(vp.width, vp.height);
    } catch {
      socket.close(4500, 'screencast_failed');
      return;
    }

    // --- inbound: input events ---
    onMessage = async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      browser.touchActivity(resolvedId);
      try {
        if (msg.t === 'resize') {
          // Scale the client's reported window size down to fit the cap
          // while keeping ITS aspect ratio — clamping width/height independently
          // distorts the ratio (e.g. a wide desktop window ends up looking like
          // a tablet's) because object-fit:contain then pillarboxes the result.
          const reqW = Math.max(1, Math.round(msg.width));
          const reqH = Math.max(1, Math.round(msg.height));
          const scale = Math.min(1, 1600 / reqW, 900 / reqH);
          const width = Math.max(320, Math.round(reqW * scale));
          const height = Math.max(240, Math.round(reqH * scale));
          await page.setViewportSize({ width, height });
          await cdp.send('Page.stopScreencast');
          await startScreencast(width, height);
        } else if (msg.t === 'mouse') {
          await cdp.send('Input.dispatchMouseEvent', {
            type: msg.type, // mousePressed | mouseReleased | mouseMoved | mouseWheel
            x: msg.x,
            y: msg.y,
            button: msg.button || 'none',
            buttons: msg.buttons || 0,
            clickCount: msg.clickCount || 0,
            deltaX: msg.deltaX || 0,
            deltaY: msg.deltaY || 0,
            modifiers: msg.modifiers || 0,
          });
        } else if (msg.t === 'key') {
          await cdp.send('Input.dispatchKeyEvent', {
            type: msg.type, // keyDown | keyUp | char | rawKeyDown
            key: msg.key,
            code: msg.code,
            text: msg.text,
            windowsVirtualKeyCode: msg.keyCode,
            modifiers: msg.modifiers || 0,
          });
        }
      } catch {
        /* ignore transient CDP errors (navigation mid-dispatch) */
      }
    };
    for (const raw of early.splice(0)) await onMessage(raw);

    // --- cleanup ---
    const cleanup = async () => {
      clearInterval(statsTimer);
      cdp.off('Page.screencastFrame', onFrame);
      try {
        await cdp.send('Page.stopScreencast');
      } catch {
        /* ignore */
      }
      try {
        await cdp.detach();
      } catch {
        /* ignore */
      }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}
