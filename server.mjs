// claude-web: a small web UI for driving Claude Code conversations on this
// machine from other devices on your Tailscale network.
//
// One server process owns every running turn, so any browser that connects
// sees the same live conversation. A conversation accepts one turn at a time;
// the lock releases itself when the turn finishes.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  query,
  listSessions,
  getSessionMessages,
} from '@anthropic-ai/claude-agent-sdk';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7878);
const PASSWORD = process.env.PASSWORD || '';
const PROJECT_ROOTS = (process.env.PROJECT_ROOTS || path.join(os.homedir(), 'code'))
  .split(':')
  .filter(Boolean);

function detectHost() {
  if (process.env.HOST) return process.env.HOST;
  try {
    const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
    if (ip) return ip;
  } catch {}
  console.warn('Tailscale IP not found; listening on 127.0.0.1 only. Set HOST to override.');
  return '127.0.0.1';
}
const HOST = detectHost();

// ---------- auth ----------

const tokens = new Set();

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function authed(req) {
  if (!PASSWORD) return true;
  return tokens.has(parseCookies(req).cw_token);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- live state ----------

// key -> { key, sessionId, dir, running, query, mode, buffer: [], pending: Map }
// key is the sessionId once known; a brand-new conversation uses a temp key
// until the SDK reports its session id.
const live = new Map();
const clients = new Set(); // SSE responses

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

function emit(state, event) {
  const ev = { key: state.key, sessionId: state.sessionId, ...event };
  // Keep the in-progress turn so viewers that join mid-turn can catch up.
  if (event.type !== 'status') state.buffer.push(ev);
  broadcast(ev);
}

function statusOf(state) {
  return {
    type: 'status',
    running: state.running,
    mode: state.mode,
    dir: state.dir,
    pending: [...state.pending.values()].map((p) => p.request),
  };
}

function rekey(state, sessionId) {
  if (state.sessionId === sessionId) return;
  const oldKey = state.key;
  live.delete(oldKey);
  state.key = sessionId;
  state.sessionId = sessionId;
  live.set(sessionId, state);
  broadcast({ type: 'session_bound', key: oldKey, sessionId, dir: state.dir });
}

async function runTurn(state, text, mode, model) {
  state.running = true;
  state.mode = mode;
  state.buffer = [];
  emit(state, { type: 'user_text', text });
  emit(state, statusOf(state));

  const options = {
    cwd: state.dir,
    permissionMode: mode,
    includePartialMessages: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    canUseTool: (toolName, input, opts) => askPermission(state, toolName, input, opts),
  };
  if (state.sessionId) options.resume = state.sessionId;
  if (model) options.model = model;
  if (mode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;

  try {
    const q = query({ prompt: text, options });
    state.query = q;
    for await (const msg of q) {
      if (msg.session_id && !state.sessionId) rekey(state, msg.session_id);
      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (msg.parent_tool_use_id) continue;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          broadcast({ key: state.key, sessionId: state.sessionId, type: 'delta', text: ev.delta.text });
        }
        continue;
      }
      if (msg.type === 'assistant' || msg.type === 'user') {
        emit(state, {
          type: 'message',
          message: {
            type: msg.type,
            uuid: msg.uuid,
            message: msg.message,
            parent_tool_use_id: msg.parent_tool_use_id ?? null,
          },
        });
      } else if (msg.type === 'result') {
        emit(state, {
          type: 'result',
          subtype: msg.subtype,
          cost: msg.total_cost_usd,
          duration: msg.duration_ms,
          error: msg.subtype === 'success' ? null : (msg.errors || []).join('\n') || msg.subtype,
        });
      }
    }
  } catch (err) {
    emit(state, { type: 'error', error: String(err?.message || err) });
  } finally {
    for (const p of state.pending.values()) p.resolve({ behavior: 'deny', message: 'Turn ended.' });
    state.pending.clear();
    state.running = false;
    state.query = null;
    emit(state, statusOf(state));
    broadcast({ type: 'sessions_changed', dir: state.dir });
  }
}

function askPermission(state, toolName, input, opts) {
  const id = crypto.randomUUID();
  const request = {
    id,
    toolName,
    input,
    title: opts.title || null,
    reason: opts.decisionReason || null,
    blockedPath: opts.blockedPath || null,
    canAlways: Array.isArray(opts.suggestions) && opts.suggestions.length > 0,
  };
  return new Promise((resolve) => {
    state.pending.set(id, { request, resolve, suggestions: opts.suggestions });
    opts.signal?.addEventListener('abort', () => {
      if (state.pending.delete(id)) {
        resolve({ behavior: 'deny', message: 'Aborted.' });
        emit(state, statusOf(state));
      }
    });
    emit(state, statusOf(state));
  });
}

// ---------- projects ----------

// Temporary per-session folders made by the Claude desktop app.
const HIDDEN_DIR = /\/Library\/Application Support\/Claude\/|^\/private\/tmp\/|^\/tmp\//;

async function listProjects() {
  const byDir = new Map();
  for (const root of PROJECT_ROOTS) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      byDir.set(dir, { dir, name: e.name, lastModified: 0, sessions: 0 });
    }
  }
  try {
    for (const s of await listSessions()) {
      if (!s.cwd || HIDDEN_DIR.test(s.cwd) || !fs.existsSync(s.cwd)) continue;
      const p = byDir.get(s.cwd) || { dir: s.cwd, name: path.basename(s.cwd), lastModified: 0, sessions: 0 };
      p.sessions += 1;
      p.lastModified = Math.max(p.lastModified, s.lastModified || 0);
      byDir.set(s.cwd, p);
    }
  } catch (err) {
    console.error('listSessions failed:', err);
  }
  return [...byDir.values()].sort((a, b) => b.lastModified - a.lastModified || a.name.localeCompare(b.name));
}

// ---------- http ----------

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/vendor/marked.js': ['node_modules/marked/lib/marked.umd.js', 'text/javascript; charset=utf-8'],
  '/vendor/purify.js': ['node_modules/dompurify/dist/purify.js', 'text/javascript; charset=utf-8'],
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 5_000_000) throw new Error('Body too large');
  }
  return data ? JSON.parse(data) : {};
}

const MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (STATIC[p] && req.method === 'GET') {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(ROOT, file)), { 'content-type': type });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const { password } = await readJson(req);
      if (!PASSWORD || (typeof password === 'string' && safeEqual(password, PASSWORD))) {
        const t = crypto.randomBytes(32).toString('hex');
        tokens.add(t);
        return send(res, 200, { ok: true }, {
          'set-cookie': `cw_token=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        });
      }
      return send(res, 401, { error: 'Wrong password' });
    }

    if (!p.startsWith('/api/')) return send(res, 404, 'Not found');
    if (!authed(req)) return send(res, 401, { error: 'login required', needPassword: true });

    if (p === '/api/me') return send(res, 200, { ok: true, host: os.hostname() });

    if (p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': hi\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (p === '/api/projects') return send(res, 200, await listProjects());

    if (p === '/api/sessions') {
      const dir = url.searchParams.get('dir');
      const sessions = (await listSessions({ dir })).filter((s) => !s.cwd || s.cwd === dir);
      const out = sessions
        .sort((a, b) => b.lastModified - a.lastModified)
        .map((s) => ({ ...s, running: !!live.get(s.sessionId)?.running }));
      // Brand-new conversations that haven't reported an id yet.
      for (const st of live.values()) {
        if (!st.sessionId && st.dir === dir && st.running) {
          out.unshift({ sessionId: null, key: st.key, summary: '(starting…)', lastModified: Date.now(), running: true });
        }
      }
      return send(res, 200, out);
    }

    const m = p.match(/^\/api\/sessions\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const key = m[1];
      const dir = url.searchParams.get('dir') || undefined;
      const state = live.get(key);
      const messages = state?.sessionId || !state ? await getSessionMessages(key, { dir }) : [];
      // While a turn is running, transcript-on-disk may lag; the client
      // replays the buffer on top and de-duplicates by uuid.
      return send(res, 200, {
        messages,
        live: state ? { ...statusOf(state), buffer: state.running ? state.buffer : [] } : null,
      });
    }

    if (p === '/api/send' && req.method === 'POST') {
      const { sessionId, dir, text, mode = 'default', model } = await readJson(req);
      if (!text || typeof text !== 'string') return send(res, 400, { error: 'Empty message' });
      if (!MODES.has(mode)) return send(res, 400, { error: 'Bad mode' });
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return send(res, 400, { error: 'Project folder not found' });
      }
      let state = sessionId ? live.get(sessionId) : null;
      if (state?.running) {
        return send(res, 409, { error: 'Claude is still working on this conversation. Wait for it to finish or press Stop.' });
      }
      if (!state) {
        const key = sessionId || `new-${crypto.randomUUID()}`;
        state = { key, sessionId: sessionId || null, dir, running: false, query: null, mode, buffer: [], pending: new Map() };
        live.set(key, state);
      }
      state.dir = dir;
      runTurn(state, text, mode, model);
      return send(res, 200, { key: state.key });
    }

    if (p === '/api/permission' && req.method === 'POST') {
      const { key, id, allow, always, message, answers } = await readJson(req);
      const state = live.get(key);
      const pending = state?.pending.get(id);
      if (!pending) return send(res, 404, { error: 'This request was already answered.' });
      state.pending.delete(id);
      if (allow) {
        const result = { behavior: 'allow', updatedInput: pending.request.input };
        if (answers) result.updatedInput = { ...pending.request.input, answers };
        if (always && pending.suggestions) result.updatedPermissions = pending.suggestions;
        pending.resolve(result);
      } else {
        pending.resolve({ behavior: 'deny', message: message || 'The user denied this action.' });
      }
      emit(state, { type: 'permission_answered', id, allow: !!allow });
      emit(state, statusOf(state));
      return send(res, 200, { ok: true });
    }

    if (p === '/api/interrupt' && req.method === 'POST') {
      const { key } = await readJson(req);
      const state = live.get(key);
      if (!state?.running || !state.query) return send(res, 200, { ok: true });
      try {
        await state.query.interrupt();
      } catch {
        state.query.close();
      }
      return send(res, 200, { ok: true });
    }

    if (p === '/api/mode' && req.method === 'POST') {
      const { key, mode } = await readJson(req);
      if (!MODES.has(mode)) return send(res, 400, { error: 'Bad mode' });
      const state = live.get(key);
      if (state) {
        state.mode = mode;
        if (state.running && state.query) await state.query.setPermissionMode(mode).catch(() => {});
        emit(state, statusOf(state));
      }
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`claude-web listening on http://${HOST}:${PORT}`);
  console.log(PASSWORD ? 'Password protection: on' : 'Password protection: off (set PASSWORD to enable)');
  console.log(`Project roots: ${PROJECT_ROOTS.join(', ')}`);
});
