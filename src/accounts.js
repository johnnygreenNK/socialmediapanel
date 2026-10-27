// Account registry.
//
// Accounts are stored in DATA_DIR/accounts.json so the user can add/remove
// them from the panel UI without editing source files. If that file does not
// exist the built-in defaults below are used and written out on the first save.
//
// id       — used as the on-disk profile dir name; must be unique, URL-safe.
// label    — shown in the panel.
// startUrl — where Chromium navigates when the session starts.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';

export const DEFAULT_ACCOUNTS = [
  { id: 'facebook', ref: '484295014', label: 'Facebook', startUrl: 'https://www.facebook.com/' },
  // useProxy:false — this proxy's anti-abuse throttling hangs/aborts real
  // Chrome traffic to Google domains, while a direct connection from this
  // VPS reaches Gmail fine (confirmed: curl through the proxy reaches
  // Google ok, Chrome through the proxy to non-Google sites is ok too —
  // only Chrome-to-Google via this proxy fails, so skip it for Gmail).
  { id: 'gmail', ref: '738201645', label: 'Gmail', startUrl: 'https://mail.google.com/mail/u/0/', useProxy: false },
];

function accountsPath() {
  return path.join(config.dataDir, 'accounts.json');
}

// Every mutation does read-file → modify → write-file. Several accounts run
// concurrently and each one's login-form capture can trigger a save at any
// time, so two saves (e.g. a new account being created and another
// account's password being captured) can land close enough together that
// the second one reads the file BEFORE the first one's write lands, then
// writes back its own now-stale copy — silently discarding the first
// change. This queue forces every read-modify-write through one at a time,
// so each one always starts from the previous one's result.
let writeChain = Promise.resolve();
function serialize(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => {}, () => {}); // one failure must not wedge the queue
  return run;
}

async function readAccountsFile() {
  try {
    const raw = await fsp.readFile(accountsPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    // A fresh copy each time — callers push/mutate the returned array, and
    // DEFAULT_ACCOUNTS is a shared module-level constant, not a template.
    return DEFAULT_ACCOUNTS.map((a) => ({ ...a }));
  }
}

export async function loadAccounts() {
  return serialize(async () => {
    const list = await readAccountsFile();
    // Migration: assign ref + a stable port slot (for the neko container's
    // CDP/web/WebRTC ports) to any account that doesn't have one yet.
    let dirty = false;
    let nextSlot = list.reduce((max, a) => Math.max(max, a.slot ?? -1), -1) + 1;
    for (const a of list) {
      if (!a.ref) { a.ref = genRef(); dirty = true; }
      if (a.slot === undefined) { a.slot = nextSlot++; dirty = true; }
    }
    if (dirty) {
      await fsp.writeFile(accountsPath(), JSON.stringify(list, null, 2));
    }
    return list;
  });
}

export async function getAccount(id) {
  const list = await loadAccounts();
  return list.find((a) => a.id === id) || null;
}

export async function getAccountByRef(ref) {
  const list = await loadAccounts();
  return list.find((a) => a.ref === ref) || null;
}

function genRef() {
  // 96 bits of entropy (24 hex chars) — brute-forcing is infeasible.
  // Existing accounts keep their legacy 9-digit numeric refs; this only
  // affects newly created accounts. getAccountByRef() is a plain string
  // comparison so both formats work without any migration.
  return randomBytes(12).toString('hex');
}

export async function saveAccount(acc) {
  // Uses readAccountsFile() directly (not loadAccounts()) and does its own
  // read+write inside a single serialize() call — loadAccounts() already
  // serializes itself, and nesting a second serialize() inside one that's
  // still running would deadlock (each would wait on the other).
  return serialize(async () => {
    const list = await readAccountsFile();
    const idx = list.findIndex((a) => a.id === acc.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...acc };
    } else {
      const nextSlot = list.reduce((max, a) => Math.max(max, a.slot ?? -1), -1) + 1;
      list.push({ ref: genRef(), slot: nextSlot, ...acc });
    }
    await fsp.mkdir(path.dirname(accountsPath()), { recursive: true });
    await fsp.writeFile(accountsPath(), JSON.stringify(list, null, 2));
    return list;
  });
}

export async function deleteAccount(id) {
  return serialize(async () => {
    const list = await readAccountsFile();
    const next = list.filter((a) => a.id !== id);
    await fsp.mkdir(path.dirname(accountsPath()), { recursive: true });
    await fsp.writeFile(accountsPath(), JSON.stringify(next, null, 2));
    return next;
  });
}
