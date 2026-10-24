// HttpOnly session token store.
//
// On successful PIN auth the server mints a random 64-hex-char token and sends
// it as an HttpOnly SameSite=Strict cookie.  JavaScript on the page can never
// read it (XSS-safe), but the browser sends it automatically with every
// same-origin request — fetch, EventSource, WebSocket upgrade alike.

import { randomBytes } from 'node:crypto';

const store = new Map(); // token -> { createdAt }
const TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export function createSession() {
  const token = randomBytes(32).toString('hex'); // 64 hex chars
  store.set(token, { createdAt: Date.now() });
  return token;
}

export function validateSession(token) {
  if (!token || token.length !== 64 || !/^[0-9a-f]+$/.test(token)) return false;
  const s = store.get(token);
  if (!s) return false;
  if (Date.now() - s.createdAt > TTL_MS) { store.delete(token); return false; }
  return true;
}

export function deleteSession(token) {
  if (token) store.delete(token);
}

// Prune expired sessions once an hour — avoids unbounded memory growth.
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of store) {
    if (now - s.createdAt > TTL_MS) store.delete(t);
  }
}, 60 * 60 * 1000);
