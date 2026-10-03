// Chat tags live in a sidecar file rather than in the transcripts, because
// agents don't have a place for them (Claude Code's own session tag holds
// only one string). Shape:
//   { sessions: { ['agent:sessionId']: string[] }, quick: string[] }
// `quick` is the saved list offered as one-click choices in the tag editor.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.agentdeck');
const TAGS_FILE = path.join(DIR, 'tags.json');
// Migrated from the pre-rename location ~/.claude-web/tags.json on first run.
const OLD_TAGS_FILE = path.join(os.homedir(), '.claude-web', 'tags.json');
export const MAX_TAGS = 10;
const MAX_QUICK = 50;
const MAX_TAG_LEN = 30;

let store = { sessions: {}, quick: [] };
try {
  if (!fs.existsSync(TAGS_FILE) && fs.existsSync(OLD_TAGS_FILE)) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.copyFileSync(OLD_TAGS_FILE, TAGS_FILE);
  }
  const raw = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
  if (raw.sessions) store = { sessions: raw.sessions, quick: raw.quick || [] };
  else store = { sessions: raw, quick: [...new Set(Object.values(raw).flat())] }; // first version: bare map
  // Before there were several agents, keys were bare Claude session ids.
  store.sessions = Object.fromEntries(
    Object.entries(store.sessions).map(([k, v]) => [k.includes(':') ? k : `claude:${k}`, v]),
  );
} catch {}

export function normalizeTags(list, max) {
  const out = [];
  for (const raw of list) {
    const t = String(raw).trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LEN);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, max);
}

function save() {
  fs.mkdirSync(path.dirname(TAGS_FILE), { recursive: true });
  const tmp = TAGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, TAGS_FILE);
}

export function tagsOf(agent, sessionId) {
  return store.sessions[`${agent}:${sessionId}`] || [];
}

export function setTags(agent, sessionId, list) {
  const clean = normalizeTags(list, MAX_TAGS);
  if (clean.length) store.sessions[`${agent}:${sessionId}`] = clean;
  else delete store.sessions[`${agent}:${sessionId}`];
  // Anything applied to a chat is remembered as a quick tag.
  store.quick = normalizeTags([...store.quick, ...clean], MAX_QUICK);
  save();
  return clean;
}

export function quickTags() {
  return store.quick;
}

export function setQuickTags(list) {
  store.quick = normalizeTags(list, MAX_QUICK);
  save();
  return store.quick;
}
