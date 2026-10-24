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

// Two independent counters: per-IP (stops network spraying) and per-username
// (stops X-Forwarded-For spoofing to bypass the IP limit).
const byIp       = new Map(); // ip       -> { count, lockedUntil }
const byUsername = new Map(); // username -> { count, lockedUntil }

const MAX_FREE_ATTEMPTS = 5;
const BASE_LOCKOUT_MS   = 30_000;
const MAX_LOCKOUT_MS    = 15 * 60_000;

function remainingMs(map, key) {
  const e = map.get(key);
  if (!e || !e.lockedUntil) return 0;
  return Math.max(0, e.lockedUntil - Date.now());
}

function bump(map, key) {
  const e = map.get(key) || { count: 0, lockedUntil: 0 };
  e.count++;
  if (e.count > MAX_FREE_ATTEMPTS) {
    const extra = e.count - MAX_FREE_ATTEMPTS;
    e.lockedUntil = Date.now() + Math.min(BASE_LOCKOUT_MS * 2 ** (extra - 1), MAX_LOCKOUT_MS);
  }
  map.set(key, e);
}

export function lockoutRemainingMs(ip, username) {
  return Math.max(remainingMs(byIp, ip), username ? remainingMs(byUsername, username) : 0);
}

export function isLocked(ip, username) {
  return lockoutRemainingMs(ip, username) > 0;
}

export function recordFailure(ip, username) {
  bump(byIp, ip);
  if (username) bump(byUsername, username);
}

export function recordSuccess(ip, username) {
  byIp.delete(ip);
  if (username) byUsername.delete(username);
}
