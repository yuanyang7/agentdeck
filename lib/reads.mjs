// Which chats have finished a turn that no browser was watching, so they can
// carry an "unread" marker in the chat list. Like tags, this lives in a sidecar
// file because agents have no place for it. Shape:
//   { unread: { ['agent:sessionId']: true } }
// A chat is flagged when one of its turns finishes (lib/hub.mjs) and unflagged
// when any browser opens it or watches the turn finish (server.mjs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.agentdeck');
const FILE = path.join(DIR, 'reads.json');

let unread = {};
try {
  unread = JSON.parse(fs.readFileSync(FILE, 'utf8')).unread || {};
} catch {}

function save() {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ unread }, null, 2));
  fs.renameSync(tmp, FILE);
}

export function isUnread(agent, sessionId) {
  return !!unread[`${agent}:${sessionId}`];
}

export function markUnread(agent, sessionId) {
  const key = `${agent}:${sessionId}`;
  if (unread[key]) return;
  unread[key] = true;
  save();
}

export function markRead(agent, sessionId) {
  const key = `${agent}:${sessionId}`;
  if (!unread[key]) return;
  delete unread[key];
  save();
}
