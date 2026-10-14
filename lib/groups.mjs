// Asking several agents the same thing: a group is one conversation per
// agent, started from one message in one folder and shown side by side. The
// conversations are the agents' own; only which ones belong together is kept
// here, like tags, since agents have no place for it. Shape:
//   { groups: { [id]: { dir, agents: [id, …], members: { [agent]: sessionId }, createdAt } } }
// A member's session id is filled in once its agent reports it (lib/hub.mjs);
// an agent that never got that far stays listed without one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.agentdeck');
const FILE = path.join(DIR, 'groups.json');
export const GROUP_ID = /^[0-9a-f]{32}$/;
export const MAX_MEMBERS = 8;

let groups = {};
try {
  groups = JSON.parse(fs.readFileSync(FILE, 'utf8')).groups || {};
} catch {}
// session key -> group id
const byKey = new Map();
for (const [id, g] of Object.entries(groups)) for (const [agent, sid] of Object.entries(g.members || {})) if (sid) byKey.set(`${agent}:${sid}`, id);

function save() {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ groups }, null, 2));
  fs.renameSync(tmp, FILE);
}

// The group `id` as { id, dir, agents, members, createdAt }, or null.
export function group(id) {
  const g = groups[id];
  return g ? { id, ...g } : null;
}

// The group a conversation belongs to, as { id, agents }, or null.
export function groupOf(agent, sessionId) {
  const id = byKey.get(`${agent}:${sessionId}`);
  return id ? { id, agents: groups[id].agents } : null;
}

// Makes the group if it is new and lists `agent` in it; records its session
// id when given. `dir` is where every member runs.
export function join(id, dir, agent, sessionId) {
  const g = (groups[id] ||= { dir, agents: [], members: {}, createdAt: Date.now() });
  if (!g.agents.includes(agent)) {
    if (g.agents.length >= MAX_MEMBERS) throw new Error(`At most ${MAX_MEMBERS} agents in a group.`);
    g.agents.push(agent);
  }
  if (sessionId && g.members[agent] !== sessionId) {
    g.members[agent] = sessionId;
    byKey.set(`${agent}:${sessionId}`, id);
  }
  save();
}

// A member got a new session id (moved as Codex does, or forked into a
// group later): points the group at it.
export function rebind(agent, from, to) {
  const id = byKey.get(`${agent}:${from}`);
  if (!id) return;
  byKey.delete(`${agent}:${from}`);
  groups[id].members[agent] = to;
  byKey.set(`${agent}:${to}`, id);
  save();
}
