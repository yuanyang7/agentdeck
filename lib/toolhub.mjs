// Tool Hub (~/code/tool-hub): the local control panel that starts and stops
// each project's dev server. When it runs, the chat header shows a project
// bar for the open workspace's tool: whether it's up, Open, Restart and a
// link into the hub. Without a hub nothing shows, and nothing here blocks.
//
// The hub is found by probing `GET /api/tools` at TOOL_HUB_URL (default
// http://127.0.0.1:8765; `off` disables it). The answer is kept for 30 s;
// a failed probe counts as "no hub" for the same 30 s, then is tried again.
// A chat's folder maps to the tool whose `dir` resolves to the same path.

import fs from 'node:fs';
import path from 'node:path';

const setting = (process.env.TOOL_HUB_URL || '').trim();
export const enabled = setting.toLowerCase() !== 'off';
export const url = enabled ? (setting || 'http://127.0.0.1:8765').replace(/\/+$/, '') : '';
const base = enabled ? new URL(url) : null;
export const port = base ? Number(base.port) || (base.protocol === 'https:' ? 443 : 80) : 0;
// Pages reach a local hub, and the ports it relays, under the host they used
// for agentdeck; a hub somewhere else is reached by its own name.
export const host = base && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(base.hostname) ? base.hostname : '';

const FRESH = 30_000;
const TIMEOUT = 3_000;

let cache = null; // { at, promise: Promise<tools[] | null> }

async function fetchTools() {
  try {
    const res = await fetch(`${url}/api/tools`, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return null;
    const list = await res.json();
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

// The hub's tools, or null when there's no hub. Fetched at most once per
// FRESH, whatever the outcome.
export function tools() {
  if (!enabled) return Promise.resolve(null);
  if (!cache || Date.now() - cache.at >= FRESH) cache = { at: Date.now(), promise: fetchTools() };
  return cache.promise;
}

// Nothing to await at startup: the first page asking will find the answer.
export function probe() {
  if (!enabled) return;
  tools().then((list) => console.log(list ? `Tool Hub: ${url} (${list.length} tools)` : `Tool Hub: none at ${url}`));
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// The tool whose folder is `dir`, as { id, name, emoji, running, port }, or
// null. `running` is the hub's word for it (started by the hub or found
// listening from the tool's folder). Resolves to undefined when there's no
// hub, so a caller can tell "no hub" from "no tool".
export async function toolFor(dir) {
  const list = await tools();
  if (!list) return undefined;
  const want = realpath(dir);
  const t = list.find((x) => typeof x.dir === 'string' && realpath(x.dir) === want);
  if (!t) return null;
  return { id: t.id, name: t.name || t.id, emoji: t.emoji || '', running: !!(t.running || t.external), port: t.port || 0 };
}

async function post(action, id) {
  const res = await fetch(`${url}/api/${action}/${encodeURIComponent(id)}`, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT * 10) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data.msg || '';
}

// Restarts a tool through the hub and returns the hub's message. A hub
// without `POST /api/restart/<id>` yet (404) gets a stop and then a start.
export async function restart(id) {
  let message;
  try {
    message = await post('restart', id);
  } catch (err) {
    if (err.status !== 404) throw err;
    message = `${await post('stop', id)}; ${await post('start', id)}`;
  }
  cache = null; // the status changed; the next page asking should see it
  await settle(id);
  return message;
}

// The hub can answer "started" before the tool is listening (a launchd job
// returns at once), and its answer is kept for 30 s — so wait for the tool to
// come up before anyone asks, or the bar would hide Open for the next half
// minute. A few tries: each one is a full tools listing from the hub.
async function settle(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const list = await tools();
    const t = list && list.find((x) => x.id === id);
    if (t && (t.running || t.external)) return;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
    cache = null;
  }
}
