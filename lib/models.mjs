// The model and effort each chat uses, so every device continues a chat with
// the same ones instead of its own browser's last choice. Like tags, this
// lives in a sidecar file because agents have no place for it. Shape:
//   { sessions: { ['agent:sessionId']: { model, effort } } }
// null means the agent's default. Recorded whenever a turn starts
// (lib/hub.mjs) and when the pickers change in an open chat (server.mjs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.agentdeck');
const FILE = path.join(DIR, 'models.json');

let sessions = {};
try {
  sessions = JSON.parse(fs.readFileSync(FILE, 'utf8')).sessions || {};
} catch {}

function save() {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
  fs.renameSync(tmp, FILE);
}

// The chat's { model, effort }, or null for chats from before this was kept.
export function modelOf(agent, sessionId) {
  return sessions[`${agent}:${sessionId}`] || null;
}

// Returns true if this changed what was stored.
export function setModel(agent, sessionId, { model, effort }) {
  const key = `${agent}:${sessionId}`;
  const next = { model: model || null, effort: effort || null };
  const old = sessions[key];
  if (old && old.model === next.model && old.effort === next.effort) return false;
  sessions[key] = next;
  save();
  return true;
}
