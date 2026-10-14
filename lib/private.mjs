// Private chats (incognito): a chat that gets no memory and keeps none, is
// never listed, and is deleted from its agent's own store when the user
// leaves it. Agents always write their sessions to disk, so a private chat
// exists there while it is open; this file remembers which sessions those
// are, so the sidebar leaves them out and a start of agentdeck deletes any
// that a closed page left behind. Shape: { sessions: ['agent:sessionId', …] }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.agentdeck');
const FILE = path.join(DIR, 'private.json');

let sessions = new Set();
try {
  sessions = new Set(JSON.parse(fs.readFileSync(FILE, 'utf8')).sessions || []);
} catch {}

function save() {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ sessions: [...sessions] }, null, 2));
  fs.renameSync(tmp, FILE);
}

export const isPrivate = (agent, sessionId) => sessions.has(`${agent}:${sessionId}`);

export function add(agent, sessionId) {
  if (sessions.has(`${agent}:${sessionId}`)) return;
  sessions.add(`${agent}:${sessionId}`);
  save();
}

export function remove(agent, sessionId) {
  if (!sessions.delete(`${agent}:${sessionId}`)) return;
  save();
}

// Every private session still recorded, as [{ agent, sessionId }].
export function list() {
  return [...sessions].map((k) => {
    const i = k.indexOf(':');
    return { agent: k.slice(0, i), sessionId: k.slice(i + 1) };
  });
}
