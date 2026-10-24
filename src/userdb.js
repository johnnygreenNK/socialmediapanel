// Panel user database — stored in DATA_DIR/users.json.
// Passwords hashed with Node.js built-in crypto.scrypt (N=16384, r=8, p=1).
// Uses the same serialized read/write queue as accounts.js to prevent
// concurrent-write race conditions.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scryptAsync = promisify(scrypt);
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const HASH_LEN = 64;

function usersPath() {
  return path.join(config.dataDir, 'users.json');
}

let writeChain = Promise.resolve();
function serialize(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => {}, () => {});
  return run;
}

async function readUsersFile() {
  try {
    const raw = await fsp.readFile(usersPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeUsersFile(list) {
  await fsp.mkdir(path.dirname(usersPath()), { recursive: true });
  await fsp.writeFile(usersPath(), JSON.stringify(list, null, 2));
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, HASH_LEN, SCRYPT_PARAMS);
  return `${salt}:${hash.toString('hex')}`;
}

async function checkPassword(password, stored) {
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  const derived = await scryptAsync(password, salt, HASH_LEN, SCRYPT_PARAMS);
  const a = Buffer.from(derived.toString('hex'));
  const b = Buffer.from(hashHex);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

function validateUsername(u) {
  if (!u || u.length > 64) return false;
  return /^[a-z0-9_-]+$/.test(u);
}

export async function createUser(username, password) {
  const u = normalizeUsername(username);
  if (!validateUsername(u)) throw new Error('invalid_username');
  if (!password || password.length < 8) throw new Error('password_too_short');
  if (password.length > 1024) throw new Error('password_too_long');
  return serialize(async () => {
    const list = await readUsersFile();
    if (list.some(x => x.username === u)) throw new Error('username_taken');
    const passwordHash = await hashPassword(password);
    const user = { id: randomBytes(8).toString('hex'), username: u, passwordHash, createdAt: Date.now(), active: true };
    list.push(user);
    await writeUsersFile(list);
    return { id: user.id, username: user.username, createdAt: user.createdAt };
  });
}

export async function verifyUser(username, password) {
  const u = normalizeUsername(username);
  const list = await readUsersFile();
  const user = list.find(x => x.username === u && x.active);
  if (!user) {
    // Run dummy hash to prevent timing-based enumeration
    await scryptAsync('dummy', 'aabbccdd', HASH_LEN, SCRYPT_PARAMS);
    return null;
  }
  const ok = await checkPassword(password, user.passwordHash);
  if (!ok) return null;
  return { id: user.id, username: user.username };
}

export async function listUsers() {
  const list = await readUsersFile();
  return list.map(u => ({ id: u.id, username: u.username, createdAt: u.createdAt, active: u.active }));
}

export async function deleteUser(username) {
  const u = normalizeUsername(username);
  return serialize(async () => {
    const list = await readUsersFile();
    const idx = list.findIndex(x => x.username === u);
    if (idx < 0) return null;
    const [removed] = list.splice(idx, 1);
    await writeUsersFile(list);
    return { id: removed.id, username: removed.username };
  });
}

export async function userExists(username) {
  const u = normalizeUsername(username);
  const list = await readUsersFile();
  return list.some(x => x.username === u);
}

export async function userCount() {
  const list = await readUsersFile();
  return list.length;
}
