// Usage stats across the agents, read from what they already keep on disk:
// Claude Code's transcripts (~/.claude/projects/*/*.jsonl), Codex's rollout
// files (~/.codex/sessions/**/*.jsonl) and opencode's database
// (~/.local/share/opencode/opencode.db). Nothing new is recorded; this only
// aggregates what's there.
//
// Everything is folded into hour buckets so the page can slice any range and
// draw time-of-day charts without refetching:
//   row:     { t, agent, dir, model, prompts, replies, tin, tout }
//            t = epoch ms at the start of the hour; prompts = messages the
//            user typed; replies = model messages; tin/tout = fresh input and
//            output tokens where the agent records them.
//   session: { t, agent, dir }  (one per conversation, t = when it started)
//
// The transcript folders hold gigabytes, so files are scanned line by line
// with cheap string checks instead of parsing every line, and each file's
// buckets are cached by mtime+size in ~/.agentdeck/stats-cache.json. After the
// first scan only new or appended files are read again.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

// Temporary per-session folders made by the Claude desktop app (as in
// lib/agents/claude.mjs); their chats aren't the user's projects.
const HIDDEN_DIR = /\/Library\/Application Support\/Claude\/|^\/private\/tmp\/|^\/tmp\//;

const CACHE_FILE = path.join(os.homedir(), '.agentdeck', 'stats-cache.json');
const CACHE_VERSION = 1;

const HOUR = 3600_000;
const hourOf = (ms) => Math.floor(ms / HOUR) * HOUR;

// ---------- per-file bucket maps ----------

// While scanning one file, buckets collect per (hour, model) counts; the
// file's dir and agent are constant and added when the rows are merged.
function bump(buckets, ms, model, field, by = 1) {
  if (!ms) return;
  const key = `${hourOf(ms)}|${model || ''}`;
  const b = buckets.get(key) || { t: hourOf(ms), model: model || '', prompts: 0, replies: 0, tin: 0, tout: 0 };
  b[field] += by;
  buckets.set(key, b);
}

const bucketRows = (buckets) => [...buckets.values()].filter((b) => b.prompts || b.replies || b.tin || b.tout);

const capture = (re, line) => re.exec(line)?.[1] || null;

// A JSON string value captured by regex still has its escapes; paths with
// unusual characters are rare, so fall back to the raw text.
function unescapeJson(s) {
  if (!s || !s.includes('\\')) return s;
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

function* jsonlFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const n of names) {
    const full = path.join(dir, n.name);
    if (n.isDirectory()) yield* jsonlFiles(full);
    else if (n.name.endsWith('.jsonl')) yield full;
  }
}

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) fn(line);
}

// ---------- Claude Code ----------

function claudeProjectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

// One transcript file is one conversation. Prompts are user entries that
// aren't tool results, meta lines or subagent internals; replies and tokens
// come from assistant entries, deduplicated by the API message id because the
// transcript writes one line per content block.
async function scanClaudeFile(file) {
  const buckets = new Map();
  let dir = null;
  let firstAt = null;
  let lastMsgId = null;
  await eachLine(file, (line) => {
    if (line.length < 20 || line[0] !== '{') return;
    const at = Date.parse(capture(/"timestamp":"([^"]+)"/, line) || '') || null;
    if (at && !firstAt) firstAt = at;
    if (!dir) dir = unescapeJson(capture(/"cwd":"([^"]+)"/, line));
    // Quotes inside JSON strings are escaped, so these sequences only match
    // real type keys. Assistant goes first: its entries never carry
    // "type":"user", while a user entry can nest other block types.
    if (line.includes('"type":"assistant"')) {
      const model = capture(/"model":"([^"]+)"/, line);
      if (model === '<synthetic>') return; // an error placeholder, not a reply
      const msgId = capture(/"id":"(msg_[^"]+)"/, line);
      if (msgId && msgId === lastMsgId) return; // another block of the same reply
      lastMsgId = msgId;
      bump(buckets, at, model, 'replies');
      bump(buckets, at, model, 'tin', Number(capture(/"input_tokens":(\d+)/, line)) || 0);
      bump(buckets, at, model, 'tout', Number(capture(/"output_tokens":(\d+)/, line)) || 0);
    } else if (line.includes('"type":"user"')) {
      if (
        line.includes('"isSidechain":true') || line.includes('"isMeta":true') ||
        line.includes('"tool_use_id"') || line.includes('"toolUseResult"') ||
        line.includes('"isCompactSummary":true') || line.includes('<local-command-')
      ) return;
      bump(buckets, at, null, 'prompts');
    }
  });
  return { dir, rows: bucketRows(buckets), session: firstAt ? { t: firstAt } : null };
}

// ---------- Codex ----------

const codexSessionsDir = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

// One rollout file is one thread. The model comes from the latest
// turn_context; prompts are user response_items, skipping the context blocks
// Codex injects (they start with a <tag>); tokens come from token_count
// events, whose last_token_usage covers the turn just finished.
async function scanCodexFile(file) {
  const buckets = new Map();
  let dir = null;
  let firstAt = null;
  let model = null;
  await eachLine(file, (line) => {
    if (line.length < 20 || line[0] !== '{') return;
    const at = Date.parse(capture(/"timestamp":"([^"]+)"/, line) || '') || null;
    if (at && !firstAt) firstAt = at;
    // The first "type" key is the entry's own; later ones belong to the payload.
    const type = capture(/"type":"(\w+)"/, line);
    if (type === 'session_meta') {
      dir ||= unescapeJson(capture(/"cwd":"([^"]+)"/, line));
    } else if (type === 'turn_context') {
      model = capture(/"model":"([^"]+)"/, line) || model;
    } else if (type === 'response_item') {
      if (line.includes('"role":"user"')) {
        if (!line.includes('"text":"<')) bump(buckets, at, model, 'prompts');
      } else if (line.includes('"role":"assistant"')) {
        bump(buckets, at, model, 'replies');
      }
    } else if (type === 'event_msg' && line.includes('"last_token_usage"')) {
      const usage = capture(/"last_token_usage":(\{[^}]*\})/, line);
      if (!usage) return;
      const cached = Number(capture(/"cached_input_tokens":(\d+)/, usage)) || 0;
      bump(buckets, at, model, 'tin', Math.max(0, (Number(capture(/"input_tokens":(\d+)/, usage)) || 0) - cached));
      bump(buckets, at, model, 'tout', Number(capture(/"output_tokens":(\d+)/, usage)) || 0);
    }
  });
  return { dir, rows: bucketRows(buckets), session: firstAt ? { t: firstAt } : null };
}

// ---------- opencode ----------

// opencode keeps everything in sqlite; node:sqlite reads it directly (and is
// experimental, so it may print a warning once). Parsed results are cached by
// the database's mtime. Subagent sessions (parent_id) are left out.
let sqlitePromise = null;
const loadSqlite = () => (sqlitePromise ||= import('node:sqlite').then((m) => m.DatabaseSync, () => null));

let opencodeCache = { stamp: null, rows: [], sessions: [] };

function opencodeStamp(db) {
  try {
    const s = fs.statSync(db);
    let wal = 0;
    try {
      wal = fs.statSync(db + '-wal').mtimeMs;
    } catch {}
    return `${s.mtimeMs}:${s.size}:${wal}`;
  } catch {
    return null;
  }
}

async function scanOpencode() {
  const file = path.join(os.homedir(), '.local/share/opencode/opencode.db');
  const stamp = opencodeStamp(file);
  if (!stamp) return { rows: [], sessions: [] };
  if (opencodeCache.stamp === stamp) return opencodeCache;
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) return { rows: [], sessions: [] };
  let db;
  const buckets = new Map(); // `${hour}|${dir}|${model}` -> row
  const sessions = [];
  try {
    db = new DatabaseSync(file, { readOnly: true });
    for (const s of db.prepare('select directory, time_created from session where parent_id is null').all()) {
      sessions.push({ t: Number(s.time_created), agent: 'opencode', dir: s.directory });
    }
    const messages = db
      .prepare('select s.directory dir, m.data data from message m join session s on s.id = m.session_id where s.parent_id is null')
      .all();
    for (const m of messages) {
      let d;
      try {
        d = JSON.parse(m.data);
      } catch {
        continue;
      }
      const at = d.time?.created;
      if (!at) continue;
      const model = d.modelID || d.model?.modelID || null;
      const key = `${hourOf(at)}|${m.dir}|${model || ''}`;
      const b = buckets.get(key) || { t: hourOf(at), agent: 'opencode', dir: m.dir, model: model || '', prompts: 0, replies: 0, tin: 0, tout: 0 };
      if (d.role === 'user') b.prompts += 1;
      else if (d.role === 'assistant') {
        b.replies += 1;
        b.tin += d.tokens?.input || 0;
        b.tout += d.tokens?.output || 0;
      }
      buckets.set(key, b);
    }
  } catch (err) {
    console.error('stats: opencode database:', err.message);
    return { rows: [], sessions: [] };
  } finally {
    db?.close();
  }
  opencodeCache = { stamp, rows: [...buckets.values()], sessions };
  return opencodeCache;
}

// ---------- file cache ----------

let fileCache = null; // path -> { mtime, size, dir, rows, session }
let cacheDirty = false;

function loadCache() {
  if (fileCache) return;
  fileCache = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw.v === CACHE_VERSION) for (const [k, v] of Object.entries(raw.files)) fileCache.set(k, v);
  } catch {}
}

function saveCache() {
  if (!cacheDirty) return;
  cacheDirty = false;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, files: Object.fromEntries(fileCache) }));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (err) {
    console.error('stats: could not save cache:', err.message);
  }
}

async function scanFiles(agent, dir, scanFile, out) {
  const seen = new Set();
  for (const file of jsonlFiles(dir)) {
    seen.add(file);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    let entry = fileCache.get(file);
    if (!entry || entry.mtime !== stat.mtimeMs || entry.size !== stat.size) {
      try {
        entry = { mtime: stat.mtimeMs, size: stat.size, ...(await scanFile(file)) };
      } catch (err) {
        console.error(`stats: ${file}:`, err.message);
        continue;
      }
      fileCache.set(file, entry);
      cacheDirty = true;
    }
    if (!entry.dir || HIDDEN_DIR.test(entry.dir)) continue;
    for (const r of entry.rows) out.rows.push({ ...r, agent, dir: entry.dir });
    if (entry.session) out.sessions.push({ ...entry.session, agent, dir: entry.dir });
  }
  // Forget deleted files so the cache doesn't grow forever.
  for (const k of fileCache.keys()) {
    if (k.startsWith(dir + path.sep) && !seen.has(k)) {
      fileCache.delete(k);
      cacheDirty = true;
    }
  }
}

// ---------- entry point ----------

let inFlight = null;

export function collect() {
  // One scan at a time; concurrent requests share it.
  return (inFlight ||= (async () => {
    try {
      loadCache();
      const out = { rows: [], sessions: [] };
      await scanFiles('claude', claudeProjectsDir(), scanClaudeFile, out);
      await scanFiles('codex', codexSessionsDir(), scanCodexFile, out);
      const oc = await scanOpencode();
      out.rows.push(...oc.rows);
      out.sessions.push(...oc.sessions);
      saveCache();
      return { ...out, at: Date.now() };
    } finally {
      inFlight = null;
    }
  })());
}
