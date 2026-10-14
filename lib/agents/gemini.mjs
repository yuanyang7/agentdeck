// Gemini, through Google's Antigravity CLI (`agy`), using the Google account
// signed in to it on this machine (free accounts get a weekly quota). Each
// turn runs `agy` in print mode with JSON events in and out; conversations
// are Antigravity's own, so they also continue in the CLI
// (`agy --conversation <id>`). The list of conversations comes from its
// summaries database and their history from each conversation's own
// database in ~/.gemini/antigravity-cli.
//
// Print mode can't ask before an action: anything the mode doesn't allow is
// refused, and the turn ends with a note saying so.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { ItemList, clip } from '../items.mjs';
import { CHAT_MODE, CHAT_MODE_LABEL, UPLOADS_DIR, isChatMode, chatPrompt } from '../chat-mode.mjs';

const HOME = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const SUMMARIES = path.join(HOME, 'conversation_summaries.db');
const CONVERSATIONS = path.join(HOME, 'conversations');

let binary;
function findBinary() {
  if (binary !== undefined) return binary;
  if (process.env.AGY_BIN) return (binary = process.env.AGY_BIN);
  try {
    binary = execFileSync('which', ['agy'], { encoding: 'utf8' }).trim() || null;
  } catch {
    binary = null;
  }
  const local = path.join(os.homedir(), '.local', 'bin', 'agy');
  return (binary ||= fs.existsSync(local) ? local : null);
}

// node:sqlite is experimental, so it's loaded only when needed (it may print
// a warning once).
let sqlitePromise = null;
const loadSqlite = () => (sqlitePromise ||= import('node:sqlite').then((m) => m.DatabaseSync, () => null));

async function query(file, sql, ...params) {
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync || !fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// ---------- protobuf ----------

// Steps are stored as protobuf without a published schema; these read the
// few fields needed by number. decode() returns field number -> values
// (Buffers for strings and messages, numbers otherwise).
function decode(buf) {
  const fields = new Map();
  let i = 0;
  const varint = () => {
    let n = 0;
    let shift = 1;
    for (;;) {
      const b = buf[i++];
      if (b === undefined) throw new Error('truncated');
      n += (b & 0x7f) * shift;
      shift *= 128;
      if (!(b & 0x80)) return n;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    let value;
    switch (key & 7) {
      case 0: value = varint(); break;
      case 1: value = buf.readDoubleLE(i); i += 8; break;
      case 2: { const n = varint(); value = buf.subarray(i, i + n); i += n; break; }
      case 5: value = buf.readUInt32LE(i); i += 4; break;
      default: throw new Error('unsupported wire type');
    }
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push(value);
  }
  return fields;
}

// The first value at a path of field numbers, as a string.
function str(buf, ...pathFields) {
  let node = buf;
  for (const f of pathFields) {
    if (!Buffer.isBuffer(node)) return null;
    try {
      node = decode(node).get(f)?.[0];
    } catch {
      return null;
    }
    if (node === undefined) return null;
  }
  return Buffer.isBuffer(node) ? node.toString('utf8') : null;
}

// ---------- messages → items ----------

// The workspace index goes in front of a new chat's first message (agy takes
// no extra instructions), between these markers, and is left out wherever
// the message is shown.
const CONTEXT_OPEN = '<agentdeck-context>';
const CONTEXT_CLOSE = '</agentdeck-context>';
const withoutContext = (text) => text.replace(/^\s*<agentdeck-context>[\s\S]*?<\/agentdeck-context>\s*/, '');

// Step types in a conversation's database, and in its live events.
const USER_INPUT = 14;
const RESPONSE = 15;
const DONE = 3;

// agy's tools take CamelCase arguments.
const SUMMARY_KEYS = ['CommandLine', 'AbsolutePath', 'TargetFile', 'DirectoryPath', 'SearchPath', 'Query', 'Url', 'Pattern'];

function toolCard(id, name, args, dir) {
  const key = SUMMARY_KEYS.find((k) => typeof args?.[k] === 'string');
  const arg = key ? args[key] : args?.toolSummary || '';
  const { toolAction, toolSummary, ...shown } = args || {};
  return {
    id,
    kind: 'tool',
    name,
    summary: (dir ? arg.split(dir + '/').join('') : arg).split('\n')[0].slice(0, 160),
    detail: args?.CommandLine ? '$ ' + args.CommandLine : JSON.stringify(shown, null, 2),
  };
}

function stepItem(id, row, dir) {
  const payload = Buffer.from(row.step_payload || []);
  if (row.step_type === USER_INPUT) {
    const text = withoutContext(str(payload, 19, 2) || '').trim();
    return text ? { id, kind: 'user', text, images: [] } : null;
  }
  if (row.step_type === RESPONSE) {
    const text = str(payload, 20, 1);
    return text?.trim() ? { id, kind: 'text', text } : null;
  }
  // A tool step: the call is field 5.4, its result 140.2.1.
  const name = str(payload, 5, 4, 2);
  if (!name) return null;
  let args = {};
  try {
    args = JSON.parse(str(payload, 5, 4, 3) || '{}');
  } catch {}
  const refused = row.status !== DONE;
  return {
    ...toolCard(id, name, args, dir),
    status: refused ? 'error' : 'done',
    output: clip(str(payload, 140, 2, 1) || (refused ? 'Not allowed in this mode' : '')),
  };
}

// ---------- modes ----------

// Print mode refuses whatever needs permission, so the default allows reads
// in the project and nothing else.
// Chat (lib/chat-mode.mjs) is Read only with the chat instructions in front
// of the first message.
const MODES = {
  [CHAT_MODE]: { label: CHAT_MODE_LABEL, args: [] },
  default: { label: 'Read only (no edits or commands)', args: [] },
  'accept-edits': { label: 'Edits allowed, no commands', args: ['--mode', 'accept-edits'] },
  plan: { label: 'Plan', args: ['--mode', 'plan'] },
  full: { label: 'Full access', args: ['--dangerously-skip-permissions'], unrestricted: true },
};

const DENIED = { command: 'run commands', write_file: 'edit files' };

function deniedNotice(denied = []) {
  const what = [...new Set(denied.map((d) => DENIED[d.action] || d.display_name || d.action))];
  if (!what.length) return null;
  return `Gemini wasn’t allowed to ${what.join(' or ')} in this mode. Pick a mode that allows it and ask again.`;
}

// ---------- backend ----------

let optionsCache = null;

function listModels() {
  return new Promise((resolve, reject) => {
    execFile(findBinary(), ['models'], { timeout: 60_000 }, (err, stdout, stderr) => {
      const out = String(stdout) + String(stderr);
      if (/sign in/i.test(out)) return reject(new Error(SIGN_IN));
      if (err) return reject(err);
      const models = out
        .split('\n')
        .map((l) => l.split('\t'))
        .filter((p) => p.length >= 2 && p[0].trim())
        .map(([value, label]) => ({ value: value.trim(), label: label.trim() }));
      resolve(models);
    });
  });
}

const SIGN_IN = 'Antigravity CLI isn’t signed in on this machine. Run `agy` in a terminal there, sign in, then try again.';

export default {
  id: 'gemini',
  label: 'Gemini',

  async available() {
    return !!findBinary();
  },

  async options() {
    if (optionsCache) return optionsCache;
    let models = null;
    try {
      models = await listModels();
    } catch (err) {
      console.error('gemini options:', err.message);
    }
    const options = {
      modes: Object.entries(MODES).map(([value, m]) => ({ value, label: m.label, ...(m.unrestricted && { unrestricted: true }) })),
      defaultMode: 'default',
      models: models || [],
      defaultModel: null,
      efforts: [],
      defaultEffort: null,
      images: false,
      usage: false,
      fork: false,
      readOnlyMode: 'default',
    };
    if (models?.length) optionsCache = options;
    return options;
  },

  // Conversations started from the CLI, newest first; subagents' are left out.
  async listSessions(dir) {
    const rows = await query(
      SUMMARIES,
      "select conversation_id, title, preview, last_modified_time, workspace_uris from conversation_summaries where parent_conversation_id = '' order by last_modified_time desc",
    );
    const want = dir && realpath(dir);
    const out = [];
    for (const r of rows) {
      let folder = null;
      try {
        const uri = JSON.parse(r.workspace_uris || '[]')[0];
        if (uri?.startsWith('file://')) folder = decodeURIComponent(new URL(uri).pathname);
      } catch {}
      if (!folder || (dir && folder !== dir && realpath(folder) !== want)) continue;
      out.push({
        id: r.conversation_id,
        dir: dir || folder,
        title: r.title || withoutContext(r.preview || '').split('\n')[0].slice(0, 120) || 'Untitled',
        updatedAt: Date.parse(String(r.last_modified_time).replace(' ', 'T')) || 0,
        branch: null,
      });
    }
    return out;
  },

  async history(sessionId, dir) {
    if (!/^[\w-]+$/.test(sessionId)) return [];
    const rows = await query(path.join(CONVERSATIONS, `${sessionId}.db`), 'select idx, step_type, status, step_payload from steps order by idx');
    const list = new ItemList();
    for (const row of rows) {
      const item = stepItem(`${sessionId}:${row.idx}`, row, dir);
      if (item) list.put(item);
    }
    return list.values();
  },

  startTurn(turn) {
    const { dir, settings } = turn;
    let child = null;
    let interrupted = false;

    const done = (async () => {
      const bin = findBinary();
      if (!bin) throw new Error('Antigravity CLI is not installed');
      const mode = MODES[settings.mode] || MODES.default;
      const args = [
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        ...(turn.sessionId ? ['--conversation', turn.sessionId] : []),
        ...(settings.model ? ['--model', settings.model] : []),
        ...mode.args,
        ...[...(settings.dirs || []), ...(isChatMode(settings.mode) ? [UPLOADS_DIR] : [])].flatMap((d) => ['--add-dir', d]),
        '-p=',
      ];
      child = spawn(bin, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
      const exited = new Promise((resolve) => {
        child.on('exit', resolve);
        child.on('error', (err) => {
          stderr += err.message;
          resolve(null);
        });
      });

      let text = turn.text || '';
      const context = [isChatMode(settings.mode) && chatPrompt('Gemini'), turn.instructions].filter(Boolean).join('\n\n');
      if (!turn.sessionId && context) text = `${CONTEXT_OPEN}\n${context}\n${CONTEXT_CLOSE}\n\n${text}`;
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ event: 'user', message: { content: text } }) + '\n');
      turn.item({ id: `turn-${Date.now()}:user`, kind: 'user', text: turn.text || '', images: [] });

      let cid = turn.sessionId;
      let result = null;
      const started = new Set(); // ids of text items already shown
      for await (const line of readline.createInterface({ input: child.stdout })) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.event === 'init' && ev.conversation_id && !turn.sessionId) {
          cid = ev.conversation_id;
          turn.bind(cid);
        } else if (ev.event === 'step_update') {
          const s = ev.step_update;
          const id = `${s.conversation_id}:${s.step_index}`;
          if (s.step_type === 'agent_response' && s.text_delta) {
            if (started.has(id)) turn.delta(id, s.text_delta);
            else {
              started.add(id);
              turn.item({ id, kind: 'text', text: s.text_delta });
            }
          } else if (s.step_type === 'tool' && s.tool_info) {
            const info = s.tool_info;
            turn.item({
              ...toolCard(id, info.name || s.tool_name, info.parameters, dir),
              status: s.state === 'ACTIVE' ? 'running' : s.state === 'DONE' ? 'done' : 'error',
              output: clip(info.error?.message || info.output || ''),
            });
          }
        } else if (ev.event === 'result') {
          result = ev.result;
        }
      }
      await exited;

      if (interrupted || ['CANCELED', 'INTERRUPTED'].includes(result?.status)) {
        turn.item({ id: `${cid}:interrupted-${Date.now()}`, kind: 'notice', text: 'Interrupted' });
        return {};
      }
      const denied = deniedNotice(result?.denied_actions);
      if (denied) turn.item({ id: `${cid}:denied-${Date.now()}`, kind: 'notice', text: denied });
      if (!result) {
        const last = stderr.trim().split('\n').at(-1) || 'Antigravity CLI stopped without a reply.';
        return { error: /sign in/i.test(stderr) ? SIGN_IN : last };
      }
      if (result.status !== 'SUCCESS') return { error: result.error || `Gemini: ${result.status}` };
      return { duration: result.duration_seconds != null ? result.duration_seconds * 1000 : undefined };
    })();

    return {
      done,
      async interrupt() {
        if (child && child.exitCode === null) {
          interrupted = true;
          child.kill('SIGINT');
        }
      },
    };
  },
};
