import { randomBytes } from 'node:crypto';

const store = new Map(); // token -> { createdAt, username }
const TTL_MS = 24 * 60 * 60 * 1000;

export function createSession(username) {
  const token = randomBytes(32).toString('hex');
  store.set(token, { createdAt: Date.now(), username: username || '' });
  return token;
}

export function validateSession(token) {
  if (!token || token.length !== 64 || !/^[0-9a-f]+$/.test(token)) return false;
  const s = store.get(token);
  if (!s) return false;
  if (Date.now() - s.createdAt > TTL_MS) { store.delete(token); return false; }
  return true;
}

export function getSessionUser(token) {
  if (!validateSession(token)) return null;
  return store.get(token)?.username || null;
}

export function deleteSession(token) {
  if (token) store.delete(token);
}

export function deleteSessionsByUsername(username) {
  for (const [token, s] of store) {
    if (s.username === username) store.delete(token);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of store) {
    if (now - s.createdAt > TTL_MS) store.delete(t);
  }
}, 60 * 60 * 1000);
