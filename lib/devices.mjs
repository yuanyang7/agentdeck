// Which browsers may use agentdeck. Each one has to be approved once: a new
// browser gets a random device key in a cookie and waits, showing a short
// code, until someone types that code on a device that is already approved,
// or in a terminal on the host (`npm run approve`). Only the waiting browser
// is ever shown its code, so a request nobody is looking at can't be
// approved by accident. The password, when one is set, approves a browser
// too.
//
// Approved devices are kept by a hash of their key, so restarts don't sign
// anyone out and the file holds nothing a browser could log in with. Shape:
//   { devices: [{ id, hash, name, machine, addedAt, lastSeen }] }
// Requests waiting for approval live in memory only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = path.join(os.homedir(), '.agentdeck');
const FILE = path.join(DIR, 'devices.json');
const HOST_KEY_FILE = path.join(DIR, 'host-key');

const WAIT = 10 * 60_000; // a request lapses after this
const MAX_WAITING = 5;
const SEEN_SAVE = 60 * 60_000; // last-seen times reach the file at most this often
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // nothing that reads as another

const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');

let devices = [];
try {
  devices = JSON.parse(fs.readFileSync(FILE, 'utf8')).devices || [];
} catch {}
const byHash = new Map(devices.map((d) => [d.hash, d]));
let savedAt = 0;

function save() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  savedAt = Date.now();
}

export const newKey = () => crypto.randomBytes(32).toString('hex');

// The terminal's credential: a random key in a file only this user can read.
export function hostKey() {
  let key = '';
  try {
    key = fs.readFileSync(HOST_KEY_FILE, 'utf8').trim();
  } catch {}
  if (key) return key;
  key = newKey();
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(HOST_KEY_FILE, key, { mode: 0o600 });
  return key;
}

export const validKey = (key) => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key);

// The approved device a key belongs to, or null.
export function deviceFor(key) {
  const d = validKey(key) ? byHash.get(hash(key)) : null;
  if (!d) return null;
  d.lastSeen = Date.now();
  if (d.lastSeen - savedAt > SEEN_SAVE) save();
  return d;
}

// "Safari on iPhone", from a User-Agent header.
export function nameOf(ua = '') {
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'A browser';
  const system = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux|CrOS/.test(ua) ? 'Linux'
    : '';
  return system ? `${browser} on ${system}` : browser;
}

// ---------- waiting requests ----------

const requests = new Map(); // key hash -> { id, code, name, machine, at }
// Key hashes of browsers that were denied or removed, so their pages say so
// rather than ask again on their own.
const refused = new Map(); // key hash -> 'denied' | 'removed'

function prune() {
  for (const [h, r] of requests) if (Date.now() - r.at > WAIT) requests.delete(h);
}

function newCode() {
  const taken = new Set([...requests.values()].map((r) => r.code));
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (taken.has(code));
  return code;
}

// "k7q 4md" or "K7Q-4MD" -> "K7Q4MD".
const normalCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// What approvers see of a request: everything but the code.
const listedRequest = (r) => ({ id: r.id, name: r.name, machine: r.machine, at: r.at, expiresAt: r.at + WAIT });
// What the waiting browser itself sees.
const shown = (r) => ({ ...listedRequest(r), code: r.code });

// Where a browser stands: approved, waiting (with its code), denied, removed,
// or none (it never asked, or its request lapsed).
export function statusOf(key) {
  if (!validKey(key)) return { status: 'none' };
  if (deviceFor(key)) return { status: 'approved' };
  prune();
  const h = hash(key);
  const r = requests.get(h);
  if (r) return { status: 'waiting', ...shown(r) };
  return { status: refused.get(h) || 'none' };
}

// Asks for approval, or returns the request already waiting. Asking again
// after a denial is allowed: the code on the approving side is what keeps a
// stranger out, not the number of tries.
export function ask(key, { name, machine }) {
  const s = statusOf(key);
  if (s.status === 'approved' || s.status === 'waiting') return { ...s, created: false };
  if (requests.size >= MAX_WAITING) return { error: 'Too many devices are waiting for approval. Try again in a few minutes.' };
  const h = hash(key);
  refused.delete(h);
  const r = { id: crypto.randomBytes(6).toString('hex'), code: newCode(), name, machine, at: Date.now() };
  requests.set(h, r);
  return { status: 'waiting', ...shown(r), created: true };
}

export function waiting() {
  prune();
  return [...requests.values()].map(listedRequest);
}

function add(h, { name, machine }) {
  const now = Date.now();
  const d = { id: crypto.randomBytes(6).toString('hex'), hash: h, name, machine, addedAt: now, lastSeen: now };
  devices.push(d);
  byHash.set(h, d);
  save();
  return d;
}

// Approves the request showing `code`, as typed by whoever approves it.
// `id`, if given, is the request the code was typed for, and must be the one
// showing it. Returns { device } or { error }.
export function approve(code, id) {
  prune();
  const want = normalCode(code);
  const found = [...requests].find(([, r]) => (id ? r.id === id : r.code === want));
  if (!found) return { error: id ? 'This device is no longer waiting.' : 'No device is waiting with that code.' };
  const [h, r] = found;
  if (r.code !== want) return { error: "That code doesn't match. Type the code shown on the device you're adding." };
  requests.delete(h);
  return { device: listed(add(h, r)) };
}

export function deny(id) {
  prune();
  const found = [...requests].find(([, r]) => r.id === id);
  if (!found) return false;
  requests.delete(found[0]);
  refused.set(found[0], 'denied');
  return true;
}

// Approves a browser outright, for the password.
export function approveKey(key, info) {
  const h = hash(key);
  requests.delete(h);
  refused.delete(h);
  return listed(byHash.get(h) || add(h, info));
}

// ---------- approved devices ----------

const listed = (d) => ({ id: d.id, name: d.name, machine: d.machine, addedAt: d.addedAt, lastSeen: d.lastSeen });

export function list() {
  return devices.map(listed);
}

export function revoke(id) {
  const d = devices.find((x) => x.id === id);
  if (!d) return false;
  devices = devices.filter((x) => x !== d);
  byHash.delete(d.hash);
  refused.set(d.hash, 'removed');
  save();
  return true;
}
