// User store — panel accounts created only via Telegram by the owner.
// Passwords are hashed with scrypt (Node built-in, no extra dependencies).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';

const usersFile = () => path.join(config.dataDir, 'users.json');

async function loadUsers() {
  try {
    return JSON.parse(await readFile(usersFile(), 'utf8'));
  } catch {
    return [];
  }
}

async function saveUsers(users) {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(usersFile(), JSON.stringify(users, null, 2), 'utf8');
}

export async function listUsers() {
  const users = await loadUsers();
  return users.map(({ username, createdAt }) => ({ username, createdAt }));
}

export async function userCount() {
  return (await loadUsers()).length;
}

export async function createUser(username, password) {
  if (!username || !password) throw new Error('Username and password are required');
  if (!/^[a-z0-9_.-]{1,32}$/.test(username)) throw new Error('Username must be 1-32 chars: a-z, 0-9, _ . -');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');

  const users = await loadUsers();
  if (users.find((u) => u.username === username)) throw new Error(`User "${username}" already exists`);

  const salt = randomBytes(64).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  users.push({ username, hash, salt, createdAt: new Date().toISOString() });
  await saveUsers(users);
}

export async function verifyUser(username, password) {
  const users = await loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    // Perform a dummy scrypt to prevent timing-based username enumeration
    scryptSync('dummy', 'dummy_salt_for_timing', 64);
    return false;
  }
  try {
    const hashBuf = scryptSync(password, user.salt, 64);
    return timingSafeEqual(hashBuf, Buffer.from(user.hash, 'hex'));
  } catch {
    return false;
  }
}

export async function deleteUser(username) {
  const users = await loadUsers();
  const filtered = users.filter((u) => u.username !== username);
  if (filtered.length === users.length) throw new Error(`User "${username}" not found`);
  await saveUsers(filtered);
}
