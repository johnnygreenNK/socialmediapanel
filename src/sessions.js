// Session store + per-IP brute-force guard for the login endpoint.

import { randomBytes } from 'node:crypto';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessions = new Map(); // token -> { username, expiresAt }

const loginAttempts = new Map(); // ip -> { count, lockedUntil }
const MAX_FREE_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 15 * 60_000;

export function lockoutRemainingMs(ip) {
  const e = loginAttempts.get(ip);
  if (!e?.lockedUntil) return 0;
  return Math.max(0, e.lockedUntil - Date.now());
}

export function isLocked(ip) {
  return lockoutRemainingMs(ip) > 0;
}

export function recordFailure(ip) {
  const e = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  e.count++;
  if (e.count > MAX_FREE_ATTEMPTS) {
    const extra = e.count - MAX_FREE_ATTEMPTS;
    e.lockedUntil = Date.now() + Math.min(BASE_LOCKOUT_MS * 2 ** (extra - 1), MAX_LOCKOUT_MS);
  }
  loginAttempts.set(ip, e);
}

export function recordSuccess(ip) {
  loginAttempts.delete(ip);
}

export function createSession(username) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return s.username;
}

export function deleteSession(token) {
  sessions.delete(token);
}

// Prune expired sessions once per hour
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(token);
  }
}, 60 * 60 * 1000);
