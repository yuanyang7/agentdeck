// The model, effort and permission mode each chat uses, so every device
// continues a chat the same way instead of with its own browser's last
// choice. Like tags, this lives in a sidecar file because agents have no
// place for it. Shape:
//   { sessions: { ['agent:sessionId']: { model, effort, mode } } }
// A null model or effort means the agent's default; a null mode, its default
// mode. Recorded whenever a turn starts or its mode changes (lib/hub.mjs) and
// when the pickers change in an open chat (server.mjs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.agentdeck');
const FILE = path.join(DIR, 'chat-settings.json');
// Before modes were kept too, this was models.json.
const OLD_FILE = path.join(DIR, 'models.json');

let sessions = {};
try {
  sessions = JSON.parse(fs.readFileSync(fs.existsSync(FILE) ? FILE : OLD_FILE, 'utf8')).sessions || {};
} catch {}

function save() {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
  fs.renameSync(tmp, FILE);
}

export const cleanSettings = (s) => ({ model: s?.model || null, effort: s?.effort || null, mode: s?.mode || null });

// The chat's { model, effort, mode }, or null for chats not recorded yet.
export function settingsOf(agent, sessionId) {
  const s = sessions[`${agent}:${sessionId}`];
  return s ? cleanSettings(s) : null;
}

// Returns true if this changed what was stored.
export function setSettings(agent, sessionId, settings) {
  const key = `${agent}:${sessionId}`;
  const next = cleanSettings(settings);
  const old = sessions[key] && cleanSettings(sessions[key]);
  if (old && old.model === next.model && old.effort === next.effort && old.mode === next.mode) return false;
  sessions[key] = next;
  save();
  return true;
}
