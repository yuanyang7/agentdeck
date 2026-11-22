// How big each model's context window is, as the agents last reported it,
// so a chat opened later can say how full its context is. Claude Code tells
// the window only at the end of a turn (a result's modelUsage), and its
// transcripts don't record it, so it is kept here. A chat's own window wins
// over its model's: the same model can run with a larger window (a `[1m]`
// model). Shape:
//   { models: { [model]: tokens }, sessions: { ['agent:sessionId']: tokens } }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.agentdeck');
const FILE = path.join(DIR, 'context.json');
const MAX_SESSIONS = 2000;

let models = {};
let sessions = {};
try {
  ({ models = {}, sessions = {} } = JSON.parse(fs.readFileSync(FILE, 'utf8')));
} catch {}

function save() {
  const keys = Object.keys(sessions);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete sessions[k];
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ models, sessions }, null, 2));
  fs.renameSync(tmp, FILE);
}

// `claude-opus-5-5[1m]` → `claude-opus-5-5`, the name its replies carry.
const bare = (model) => String(model).replace(/\[.*\]$/, '');

export function windowOf(agent, sessionId, model) {
  return (sessionId && sessions[`${agent}:${sessionId}`]) || (model && models[bare(model)]) || null;
}

export function setWindow(agent, sessionId, model, tokens) {
  if (!(tokens > 0)) return;
  let changed = false;
  if (model && models[bare(model)] !== tokens) {
    models[bare(model)] = tokens;
    changed = true;
  }
  const key = sessionId && `${agent}:${sessionId}`;
  if (key && sessions[key] !== tokens) {
    delete sessions[key]; // re-added last, so the oldest are dropped first
    sessions[key] = tokens;
    changed = true;
  }
  if (changed) save();
}
