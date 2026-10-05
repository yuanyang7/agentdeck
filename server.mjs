// agentdeck: a small web UI for driving coding-agent conversations (Claude
// Code, Codex, opencode) on this machine from other devices on your Tailscale
// network.
//
// This file is the HTTP layer. Live turns are run by lib/hub.mjs, and each
// agent is adapted to a common shape in lib/agents/.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hub, BusyError } from './lib/hub.mjs';
import { backends, availableBackends } from './lib/agents/index.mjs';
import { tagsOf, setTags, quickTags, setQuickTags } from './lib/tags.mjs';
import { isUnread, markRead } from './lib/reads.mjs';
import { settingsOf, setSettings } from './lib/chat-settings.mjs';

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

function magicDnsName() {
  try {
    const status = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' }));
    return status.Self?.DNSName?.replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

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
  return tokens.has(parseCookies(req).agentdeck_token);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const hub = new Hub();

// ---------- projects ----------

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
      byDir.set(dir, { dir, name: e.name, lastModified: 0, sessions: 0, recent: [], attention: [], tagged: [] });
    }
  }
  const agents = await availableBackends();
  const lists = await Promise.allSettled(agents.map((b) => b.listSessions()));
  for (const [index, r] of lists.entries()) {
    if (r.status === 'rejected') {
      console.error('listSessions failed:', r.reason);
      continue;
    }
    for (const s of r.value) {
      if (!s.dir || !fs.existsSync(s.dir)) continue;
      const p = byDir.get(s.dir) || { dir: s.dir, name: path.basename(s.dir), lastModified: 0, sessions: 0, recent: [], attention: [], tagged: [] };
      const agent = agents[index].id;
      const key = `${agent}:${s.id}`;
      const live = hub.get(key);
      const chat = { ...s, agent, key, dir: s.dir, running: !!live?.running,
        pendingCount: live?.pending.size || 0, unread: isUnread(agent, s.id), tags: tagsOf(agent, s.id) };
      p.sessions += 1;
      p.lastModified = Math.max(p.lastModified, s.updatedAt || 0);
      p.recent.push(chat);
      if (chat.pendingCount || chat.unread || chat.running) p.attention.push(chat);
      if (chat.tags.length) p.tagged.push(chat); // for the sidebar's all-workspace tag view
      byDir.set(s.dir, p);
    }
  }
  for (const c of hub.live.values()) {
    if (!c.running || c.sessionId || !byDir.has(c.dir)) continue;
    const p = byDir.get(c.dir);
    const chat = { agent: c.agent, id: null, key: c.key, dir: c.dir, title: '(starting…)',
      updatedAt: Date.now(), running: true, pendingCount: c.pending.size, unread: false, tags: [] };
    p.recent.push(chat);
    p.attention.push(chat);
    p.lastModified = Math.max(p.lastModified, chat.updatedAt);
  }
  for (const p of byDir.values()) {
    p.recent.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    p.attention.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    p.recent = p.recent.slice(0, 3);
  }
  return [...byDir.values()].sort((a, b) => b.lastModified - a.lastModified || a.name.localeCompare(b.name));
}

// Every agent's conversations in one folder, newest first.
async function listConversations(dir) {
  const out = [];
  for (const b of await availableBackends()) {
    let sessions = [];
    try {
      sessions = await b.listSessions(dir);
    } catch (err) {
      console.error(`${b.id} listSessions failed:`, err);
    }
    for (const s of sessions) {
      const key = `${b.id}:${s.id}`;
      const live = hub.get(key);
      out.push({ ...s, agent: b.id, key, dir, running: !!live?.running, pendingCount: live?.pending.size || 0, unread: isUnread(b.id, s.id), tags: tagsOf(b.id, s.id) });
    }
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  // Brand-new conversations that haven't reported an id yet.
  for (const c of hub.starting(dir)) {
    out.unshift({ agent: c.agent, id: null, key: c.key, dir, title: '(starting…)', updatedAt: Date.now(), running: true, pendingCount: c.pending.size, tags: [] });
  }
  return out;
}

// ---------- http ----------

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/agentdeck-icon.png': ['public/agentdeck-icon.png', 'image/png'],
  '/favicon.png': ['public/favicon.png', 'image/png'],
  '/apple-touch-icon.png': ['public/apple-touch-icon.png', 'image/png'],
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

async function readJson(req, limit = 5_000_000) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) throw new Error('Body too large');
  }
  return data ? JSON.parse(data) : {};
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the API's per-image limit

function validImages(list) {
  if (!Array.isArray(list) || list.length > MAX_IMAGES) return false;
  return list.every(
    (i) =>
      i && IMAGE_TYPES.has(i.mediaType) && typeof i.data === 'string' &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(i.data) && i.data.length * 0.75 <= MAX_IMAGE_BYTES,
  );
}

const FILE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const NAME = /^[\w.\/:@\[\]-]{1,200}$/; // model and effort values
const SESSION_ID = /^[\w-]+$/;
const validName = (v) => !v || (typeof v === 'string' && NAME.test(v)); // empty: the agent's default

function validAnswers(a) {
  return a === undefined || (Array.isArray(a) && a.every((x) => Array.isArray(x) && x.every((s) => typeof s === 'string')));
}

// A chat's { model, effort, mode }. Chats this app hasn't recorded (from
// before it kept them, or used elsewhere) get what the agent says they last
// used, recorded so this happens once per chat. Records from before modes
// were kept get only the mode filled in.
async function chatSettings(backend, sessionId, dir) {
  const known = settingsOf(backend.id, sessionId);
  if (known?.mode || !backend.lastSettings) return known;
  const last = await backend.lastSettings(sessionId, dir).catch(() => null);
  const { modes } = await backend.options();
  const mode = modes.some((m) => m.value === last?.mode) ? last.mode : null;
  if (!mode && (known || !last)) return known;
  setSettings(backend.id, sessionId, known ? { ...known, mode } : { ...last, mode });
  return settingsOf(backend.id, sessionId);
}

async function backendFor(agent) {
  const b = backends.get(agent);
  if (!b || !(await availableBackends()).includes(b)) return null;
  return b;
}

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
          'set-cookie': `agentdeck_token=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
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
      hub.clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        hub.clients.delete(res);
      });
      return;
    }

    if (p === '/api/agents') {
      return send(res, 200, (await availableBackends()).map((b) => ({ id: b.id, label: b.label })));
    }

    if (p === '/api/options') {
      const backend = await backendFor(url.searchParams.get('agent'));
      if (!backend) return send(res, 404, { error: 'Unknown agent' });
      return send(res, 200, await backend.options());
    }

    if (p === '/api/usage') {
      const backend = await backendFor(url.searchParams.get('agent') || 'claude');
      if (!backend?.usage) return send(res, 404, { error: 'No usage for this agent' });
      return send(res, 200, await backend.usage());
    }

    if (p === '/api/file' && req.method === 'GET') {
      // Image files on this machine that an agent showed or linked to.
      const asked = url.searchParams.get('path') || '';
      const file = asked.startsWith('~/') ? path.join(os.homedir(), asked.slice(2)) : asked;
      const type = FILE_TYPES[path.extname(file).toLowerCase()];
      if (!path.isAbsolute(file) || !type) return send(res, 400, { error: 'Not an image path' });
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        return send(res, 404, { error: 'File not found' });
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return send(res, 404, { error: 'File not found' });
      return send(res, 200, fs.readFileSync(file), {
        'content-type': type,
        'x-content-type-options': 'nosniff',
        // SVG can carry scripts; never let one run on this origin.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
    }

    if (p === '/api/projects') return send(res, 200, await listProjects());

    if (p === '/api/sessions') return send(res, 200, await listConversations(url.searchParams.get('dir')));

    const m = p.match(/^\/api\/sessions\/([\w-]+)\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const [, agent, id] = m;
      const backend = await backendFor(agent);
      if (!backend) return send(res, 404, { error: 'Unknown agent' });
      const dir = url.searchParams.get('dir') || undefined;
      // `id` is a session id, or a temp key while a new conversation starts.
      const conv = hub.get(id) || hub.find(agent, id);
      const items = conv && !conv.sessionId ? [] : await backend.history(conv?.sessionId || id, dir);
      // While a turn is running the history may lag; the browser merges the
      // live items on top by id.
      // Opening a chat counts as reading it. `id` may be a temp key of a
      // conversation that is still starting, which has no stored state yet.
      const sessionId = conv?.sessionId || (id.startsWith('new-') ? null : id);
      if (sessionId) {
        markRead(agent, sessionId);
        hub.broadcast({ type: 'sessions_changed', dir });
      }
      return send(res, 200, { items, live: conv ? hub.snapshot(conv) : null, settings: sessionId ? await chatSettings(backend, sessionId, dir) : null });
    }

    if (p === '/api/send' && req.method === 'POST') {
      const { agent = 'claude', sessionId, key, dir, text = '', images = [], mode, model, effort } = await readJson(req, 80_000_000);
      const backend = await backendFor(agent);
      if (!backend) return send(res, 400, { error: 'Unknown agent' });
      if (typeof text !== 'string') return send(res, 400, { error: 'Bad message' });
      if (!validImages(images)) {
        return send(res, 400, { error: `Images must be PNG, JPEG, GIF or WebP, at most ${MAX_IMAGES}, each under 5 MB.` });
      }
      if (!text.trim() && !images.length) return send(res, 400, { error: 'Empty message' });
      if (sessionId != null && (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId))) {
        return send(res, 400, { error: 'Bad session' });
      }
      if (key != null && (typeof key !== 'string' || !/^new-[\w-]{1,64}$/.test(key))) return send(res, 400, { error: 'Bad key' });
      // Sent while a turn runs, the message waits in the chat's queue.
      const opts = await backend.options();
      const settings = { mode: mode || opts.defaultMode, model, effort };
      if (!opts.modes.some((x) => x.value === settings.mode)) return send(res, 400, { error: 'Bad mode' });
      if (!validName(model) || !validName(effort)) return send(res, 400, { error: 'Bad model or effort' });
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return send(res, 400, { error: 'Project folder not found' });
      }
      try {
        return send(res, 200, { key: hub.start(backend, { sessionId, key, dir, text, images, settings }) });
      } catch (err) {
        if (err instanceof BusyError) return send(res, 409, { error: err.message });
        throw err;
      }
    }

    if (p === '/api/permission' && req.method === 'POST') {
      const { key, id, allow, always, message, answers } = await readJson(req);
      if (!validAnswers(answers)) return send(res, 400, { error: 'Bad answers' });
      const answer = { allow: !!allow, always: !!always, message: typeof message === 'string' ? message : undefined, answers };
      if (!hub.answer(key, id, answer)) return send(res, 404, { error: 'This request was already answered.' });
      return send(res, 200, { ok: true });
    }

    if (p === '/api/interrupt' && req.method === 'POST') {
      // Also drops the chat's queue; the dropped messages come back so the
      // browser can restore them to its composer.
      const { key } = await readJson(req);
      const dropped = await hub.interrupt(key);
      return send(res, 200, { ok: true, dropped: dropped.map(({ text, images }) => ({ text, images })) });
    }

    if (p === '/api/unqueue' && req.method === 'POST') {
      const { key, id } = await readJson(req);
      const message = hub.unqueue(key, id);
      if (!message) return send(res, 404, { error: 'That message already started.' });
      return send(res, 200, { text: message.text, images: message.images });
    }

    if (p === '/api/send-now' && req.method === 'POST') {
      // Stops the running turn and starts this queued message next.
      const { key, id } = await readJson(req);
      if (!(await hub.sendNow(key, id))) return send(res, 404, { error: 'That message already started.' });
      return send(res, 200, { ok: true });
    }

    if (p === '/api/mode' && req.method === 'POST') {
      const { key, mode } = await readJson(req);
      const conv = hub.get(key);
      const opts = conv && (await backends.get(conv.agent).options());
      if (conv && !opts.modes.some((x) => x.value === mode)) return send(res, 400, { error: 'Bad mode' });
      await hub.setMode(key, mode);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      // The pickers changed in an open chat: remember it for every device.
      const { agent, sessionId, model, effort, mode } = await readJson(req);
      const backend = await backendFor(agent);
      if (!backend) return send(res, 400, { error: 'Unknown agent' });
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return send(res, 400, { error: 'Bad session' });
      if (!validName(model) || !validName(effort)) return send(res, 400, { error: 'Bad model or effort' });
      if (mode && !(await backend.options()).modes.some((x) => x.value === mode)) return send(res, 400, { error: 'Bad mode' });
      hub.settingsChanged(agent, sessionId, { model, effort, mode });
      return send(res, 200, { ok: true });
    }

    if (p === '/api/read' && req.method === 'POST') {
      // Marks a chat read: sent when a browser watches its turn finish. The
      // key is preferred because it also resolves temp keys of conversations
      // that just got their session id; otherwise fall back to the session id.
      const { key, agent, sessionId, dir } = await readJson(req);
      const conv = key ? hub.get(key) : null;
      const a = conv?.agent || agent;
      const sid = conv?.sessionId || sessionId;
      if (!a || !backends.has(a) || typeof sid !== 'string' || !SESSION_ID.test(sid)) {
        return send(res, 400, { error: 'Bad session' });
      }
      markRead(a, sid);
      hub.broadcast({ type: 'sessions_changed', dir });
      return send(res, 200, { ok: true });
    }

    if (p === '/api/tags' && req.method === 'POST') {
      const { agent = 'claude', sessionId, dir, tags: list } = await readJson(req);
      if (!backends.has(agent)) return send(res, 400, { error: 'Unknown agent' });
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return send(res, 400, { error: 'Bad session' });
      if (!Array.isArray(list)) return send(res, 400, { error: 'Bad tags' });
      const tags = setTags(agent, sessionId, list);
      hub.broadcast({ type: 'sessions_changed', dir });
      return send(res, 200, { tags, quick: quickTags() });
    }

    if (p === '/api/quicktags') {
      if (req.method === 'POST') {
        const { quick } = await readJson(req);
        if (!Array.isArray(quick)) return send(res, 400, { error: 'Bad tags' });
        setQuickTags(quick);
      }
      return send(res, 200, { quick: quickTags() });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`agentdeck listening on http://${HOST}:${PORT}`);
  const name = HOST.startsWith('100.') && magicDnsName();
  if (name) console.log(`Open from other devices: http://${name}:${PORT}  (or http://${name.split('.')[0]}:${PORT})`);
  console.log(PASSWORD ? 'Password protection: on' : 'Password protection: off (set PASSWORD to enable)');
  console.log(`Project roots: ${PROJECT_ROOTS.join(', ')}`);
  availableBackends().then((list) => console.log(`Agents: ${list.map((b) => b.label).join(', ')}`));
});

// Exit through process.exit so agents' child processes are cleaned up.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

// Also answer on localhost so it can be opened on the host itself.
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '0.0.0.0' && HOST !== '::') {
  const local = http.createServer((req, res) => server.emit('request', req, res));
  local.on('error', (err) => console.warn(`Not listening on localhost:${PORT}: ${err.message}`));
  local.listen(PORT, '127.0.0.1', () => console.log(`Also on http://localhost:${PORT}`));
}
