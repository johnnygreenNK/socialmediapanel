// In-memory brute-force guard for the PIN.
//
// checkPin() used to be a plain string comparison with no limit on retries
// — a 4-digit PIN (10,000 combinations) is trivial to brute-force over the
// network with no rate limiting at all. After a few wrong guesses from one
// IP, this locks that IP out for an exponentially growing delay instead of
// letting it keep guessing freely.
//
// Deliberately simple (process memory only, resets on restart, no
// persistence) — the goal is to make guessing impractical over the network,
// not to replace the PIN with real multi-user auth.

const attempts = new Map(); // ip -> { count, lockedUntil }
const MAX_FREE_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 15 * 60_000;

export function lockoutRemainingMs(ip) {
  const e = attempts.get(ip);
  if (!e || !e.lockedUntil) return 0;
  return Math.max(0, e.lockedUntil - Date.now());
}

export function isLocked(ip) {
  return lockoutRemainingMs(ip) > 0;
}

export function recordFailure(ip) {
  const e = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  e.count++;
  if (e.count > MAX_FREE_ATTEMPTS) {
    const extra = e.count - MAX_FREE_ATTEMPTS;
    e.lockedUntil = Date.now() + Math.min(BASE_LOCKOUT_MS * 2 ** (extra - 1), MAX_LOCKOUT_MS);
  }
  attempts.set(ip, e);
}

export function recordSuccess(ip) {
  attempts.delete(ip);
}
