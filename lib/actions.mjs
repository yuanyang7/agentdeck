// Quick actions: the buttons in the header that do something on the host
// with one click. "Restart" is built in and restarts agentdeck itself. The
// others are the user's own shell commands (macros), kept on the host so
// every device shows the same buttons. Shape:
//   { actions: [{ id, icon, label, command, restart }] }
// `restart` means agentdeck restarts once the command has succeeded.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = path.join(os.homedir(), '.agentdeck');
const FILE = path.join(DIR, 'actions.json');

export const MAX_ACTIONS = 12;
const MAX_ICON = 8; // one emoji, which may be several code units
const MAX_LABEL = 24;
const MAX_COMMAND = 1000;
const ID = /^[0-9a-f]{8}$/;

export const RESTART = Object.freeze({ id: 'restart', icon: '↻', label: 'Restart', command: '', restart: true, builtin: true });

const squash = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

// One action as stored, or an { error } saying what's wrong with it.
function clean(raw, taken) {
  if (!raw || typeof raw !== 'object') return { error: 'Bad action' };
  const icon = squash(raw.icon).slice(0, MAX_ICON);
  const label = squash(raw.label);
  const command = String(raw.command ?? '').trim();
  const restart = !!raw.restart;
  if (!label) return { error: 'Every action needs a label.' };
  if (label.length > MAX_LABEL) return { error: `Labels can be at most ${MAX_LABEL} characters.` };
  if (command.length > MAX_COMMAND) return { error: `Commands can be at most ${MAX_COMMAND} characters.` };
  if (!command && !restart) return { error: `"${label}" needs a command, or to restart agentdeck.` };
  let id = typeof raw.id === 'string' && ID.test(raw.id) && !taken.has(raw.id) ? raw.id : '';
  while (!id || taken.has(id)) id = crypto.randomBytes(4).toString('hex');
  taken.add(id);
  return { id, icon, label, command, restart };
}

// The whole custom list checked: { actions } or { error }.
export function normalize(list) {
  if (!Array.isArray(list)) return { error: 'Bad actions' };
  if (list.length > MAX_ACTIONS) return { error: `At most ${MAX_ACTIONS} actions.` };
  const taken = new Set([RESTART.id]);
  const actions = [];
  for (const raw of list) {
    const a = clean(raw, taken);
    if (a.error) return a;
    actions.push(a);
  }
  return { actions };
}

let custom = [];
try {
  custom = normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')).actions).actions || [];
} catch {}

function save() {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ actions: custom }, null, 2));
  fs.renameSync(tmp, FILE);
}

// Every action, the built-in one first.
export const list = () => [RESTART, ...custom];

export const find = (id) => list().find((a) => a.id === id) || null;

// Replaces the custom actions. Returns { actions } (the full list) or { error }.
export function setActions(list) {
  const r = normalize(list);
  if (r.error) return r;
  custom = r.actions;
  save();
  return { actions: [RESTART, ...custom] };
}
