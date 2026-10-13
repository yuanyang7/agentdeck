// Chats waiting for a plan limit to reset, so they continue by themselves
// (lib/hub.mjs) even after a restart, and whether that happens at all.
// Shape:
//   { enabled, chats: [{ agent, sessionId, dir, at, label, settings,
//                        queue: [{ text, images, settings }] }] }
// `at` is when the chat continues (ms), `label` the limit it hit ("5-hour
// limit"), `settings` the ones its last turn ran with, and `queue` the
// messages sent while it waits.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.agentdeck');
const FILE = path.join(DIR, 'resume.json');

let state = { enabled: true, chats: [] };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {}

function save() {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

// On unless turned off; turning it off leaves chats already waiting alone.
export const autoResume = () => state.enabled !== false;

export function setAutoResume(on) {
  state.enabled = !!on;
  save();
}

export const pausedChats = () => (Array.isArray(state.chats) ? state.chats : []);

export function setPausedChats(chats) {
  if (!chats.length && !pausedChats().length) return;
  state.chats = chats;
  save();
}
