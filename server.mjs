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
import net from 'node:net';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Hub, BusyError } from './lib/hub.mjs';
import { backends, availableBackends } from './lib/agents/index.mjs';
import { tagsOf, setTags, quickTags, setQuickTags } from './lib/tags.mjs';
import { isUnread, markRead } from './lib/reads.mjs';
import { settingsOf, setSettings } from './lib/chat-settings.mjs';
import { workspaceIndex, enabled as workspaceIndexEnabled } from './lib/workspace-index.mjs';
import { rootFolders, checkFolders, mentionedFolders } from './lib/folders.mjs';
import * as devices from './lib/devices.mjs';
import * as actions from './lib/actions.mjs';
import * as toolhub from './lib/toolhub.mjs';
import { routeTask, MODEL as ROUTE_MODEL } from './lib/router.mjs';
import * as feedbackloop from './lib/feedbackloop.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STARTED = Date.now(); // pages compare this to tell a restarted server from the old one
const PORT = Number(process.env.PORT || 7878);
const PASSWORD = process.env.PASSWORD || '';
const PROJECT_ROOTS = (process.env.PROJECT_ROOTS || path.join(os.homedir(), 'code'))
  .split(':')
  .filter(Boolean)
  .map((r) => path.resolve(r));

function detectHost() {
  if (process.env.HOST) return process.env.HOST;
  try {
    const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
    // With Tailscale stopped the CLI still prints the address, but no
    // interface has it, and listening there would fail.
    const up = Object.values(os.networkInterfaces()).flat().some((a) => a?.address === ip);
    if (ip && up) return ip;
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

// Every browser has to be approved once (lib/devices.mjs), and then sends its
// device key in a cookie. The terminal on the host (`npm run approve`) sends
// the host key instead.
const DEVICE_COOKIE = 'agentdeck_device';
const HOST_KEY = devices.hostKey();

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const deviceKey = (req) => parseCookies(req)[DEVICE_COOKIE];

// Browsers keep a cookie for at most 400 days; /api/me renews it on each visit.
const deviceCookie = (key) => `${DEVICE_COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function fromHost(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  return !!m && safeEqual(m[1], HOST_KEY);
}

// A page from another site, or from another port of this host, must not be
// able to drive agentdeck through a browser that has it open. Browsers say
// where a request comes from; tools like curl don't, and need a key anyway.
function crossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

// DNS rebinding: a site can point its own name at this machine to get around
// the same-origin rule, and then the Host header carries that name. So only
// this machine's own names are accepted: IP addresses, localhost, its
// MagicDNS name (full, as `tailscale serve` uses it, and short) and
// ALLOWED_HOSTS.
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

// A device key lives in a cookie, and browsers keep cookies per host name, so
// the same browser opening agentdeck under the IP and then under the MagicDNS
// name has to be approved twice. The page is sent to one name instead: the
// MagicDNS name, or CANONICAL_HOST (`off` turns it off, a name uses that one).
const CANONICAL = (process.env.CANONICAL_HOST || '').trim().toLowerCase().replace(/\.$/, '');

const hostOf = (req) => (req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

let hostNames = new Set();
let canonicalHost = null;
let hostNamesAt = 0;

function lookUpNames() {
  const magic = magicDnsName()?.toLowerCase();
  canonicalHost = CANONICAL === 'off' ? null : CANONICAL || magic || null;
  hostNames = new Set(['localhost', ...ALLOWED_HOSTS]);
  if (magic) hostNames.add(magic).add(magic.split('.')[0]);
  if (canonicalHost) hostNames.add(canonicalHost);
  hostNamesAt = Date.now();
}
lookUpNames();

function knownHost(req) {
  const host = hostOf(req);
  if (!host || net.isIP(host.replace(/^\[|\]$/g, '')) || hostNames.has(host)) return true;
  // Tailscale may have come up, or the machine been renamed, since the last look.
  if (Date.now() - hostNamesAt < 60_000) return false;
  lookUpNames();
  return hostNames.has(host);
}

// Where to send the page when it was opened under another of this machine's
// names, so every browser keeps one cookie and so needs one approval. Only
// the page itself moves: files, the API and the terminal's calls answer under
// any name. `?stay` opens it under the name as typed, for a device the
// canonical name doesn't resolve on, and a name in ALLOWED_HOSTS is left
// alone, since it was added on purpose (a LAN name off the tailnet, say).
function canonicalPage(req, url) {
  if (CANONICAL === 'off' || url.searchParams.has('stay')) return null;
  // Tailscale may not have been up when the names were last looked up.
  if (!canonicalHost && Date.now() - hostNamesAt > 60_000) lookUpNames();
  const host = hostOf(req);
  if (!canonicalHost || !host || host === canonicalHost || ALLOWED_HOSTS.includes(host)) return null;
  const port = /:(\d+)$/.exec(req.headers.host || '')?.[1];
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${canonicalHost}${port ? `:${port}` : ''}${url.pathname}${url.search}`;
}

// Wrong passwords per address, to slow down guessing.
const failures = new Map(); // address -> times of recent wrong passwords
const MAX_FAILURES = 5;
const FAILURE_WINDOW = 10 * 60_000;

function recentFailures(addr) {
  const recent = (failures.get(addr) || []).filter((t) => Date.now() - t < FAILURE_WINDOW);
  if (recent.length) failures.set(addr, recent);
  else failures.delete(addr);
  return recent;
}

const execFileP = promisify(execFile);

// Which tailnet machine a request comes from, as Tailscale names it, to show
// in the approval prompt. `tailscale serve` passes the client's address along.
async function machineOf(req) {
  let ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') {
    ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (!net.isIP(ip)) return 'localhost';
  }
  try {
    const { stdout } = await execFileP('tailscale', ['whois', '--json', ip], { timeout: 3000 });
    return JSON.parse(stdout).Node?.Name?.split('.')[0] || ip;
  } catch {
    return ip;
  }
}

const deviceInfo = async (req) => ({ name: devices.nameOf(req.headers['user-agent']), machine: await machineOf(req) });

// Live event streams -> the device that opened them, so revoking a device
// cuts its pages off at once.
const streams = new Map();

// Every conversation starts with a map of the projects (lib/workspace-index.mjs),
// and a message naming one of them offers it as an extra folder (lib/folders.mjs).
const hub = new Hub({
  instructions: () => workspaceIndex(listProjects, PROJECT_ROOTS),
  mentions: (text, dir, dirs) => mentionedFolders(text, rootFolders(PROJECT_ROOTS), dir, dirs),
});

// ---------- quick actions ----------

// Under launchd, systemd or pm2 the supervisor starts agentdeck again as soon
// as it exits. Started by hand (`npm start`), it starts itself again: a shell
// waits for this process to end, which frees the port, then runs the same
// command in the same folder with the same environment. launchd is asked
// rather than read from the environment, because everything an agent runs
// inside agentdeck inherits that environment, including a test server.
function supervised() {
  if (process.env.AGENTDECK_SUPERVISED) return process.env.AGENTDECK_SUPERVISED !== '0';
  if (process.platform === 'darwin') {
    try {
      return execFileSync('launchctl', ['list'], { encoding: 'utf8' }).split('\n').some((l) => l.startsWith(`${process.pid}\t`));
    } catch {
      return false;
    }
  }
  return (process.ppid === 1 && !!process.env.INVOCATION_ID) || !!process.env.pm_id;
}
const SUPERVISED = supervised();

function restart() {
  console.log(`Restarting${SUPERVISED ? ' (the supervisor starts agentdeck again)' : ''}…`);
  hub.broadcast({ type: 'restarting' });
  // Let the event reach every page before the streams close.
  setTimeout(() => {
    if (!SUPERVISED) {
      const wait = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done; exec "$@"`;
      spawn('/bin/sh', ['-c', wait, 'sh', process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
        cwd: process.cwd(), env: process.env, detached: true, stdio: 'inherit',
      }).unref();
    }
    process.exit(0);
  }, 300);
}

const ACTION_TIMEOUT = 60_000;
const MAX_OUTPUT = 100_000;

// Runs a custom action's command in `cwd` through the user's shell and
// collects what it prints: { code, output, timedOut, ms }.
function runCommand(command, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let truncated = false;
    let timedOut = false;
    const child = spawn(process.env.SHELL || '/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, AGENTDECK_DIR: ROOT, AGENTDECK_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // its own process group, so a timeout kills what it started too
    });
    const take = (chunk) => {
      if (output.length < MAX_OUTPUT) output += chunk;
      else truncated = true;
    };
    child.stdout.setEncoding('utf8').on('data', take);
    child.stderr.setEncoding('utf8').on('data', take);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, ACTION_TIMEOUT);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, output: err.message, timedOut: false, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: output.trimEnd() + (truncated ? '\n…' : ''), timedOut, ms: Date.now() - started });
    });
  });
}

const runningTurns = () => [...hub.live.values()].filter((c) => c.running).length;

// ---------- project bar (Tool Hub) ----------

// The open workspace's tool in Tool Hub (lib/toolhub.mjs), with the links the
// page needs. The hub relays each tool's port on the Tailscale IP, so a tool
// is reached under the host the page used for agentdeck, and so is the hub.
async function hubStatus(req, dir) {
  if (!toolhub.enabled) return { hub: null, disabled: true };
  const tool = await toolhub.toolFor(dir);
  if (tool === undefined) return { hub: null };
  const host = toolhub.host || (req.headers.host || 'localhost').replace(/:\d+$/, '');
  const base = `http://${host}`;
  return {
    hub: { url: `${base}:${toolhub.port}/${tool ? `#tool=${encodeURIComponent(tool.id)}` : ''}` },
    tool: tool && {
      ...tool,
      url: tool.port ? `${base}:${tool.port}/` : '',
      self: sameFolder(dir, ROOT), // agentdeck itself: the page restarts it the built-in way
    },
  };
}

// ---------- project bar (feedback-loop) ----------

// The bug queue of the open workspace's feedback-loop target
// (lib/feedbackloop.mjs). `counts` is null while the CLI's answer is missing,
// and Report still works then. `sub` is where the chat's folder sits inside
// the enrolled one, '' at its top.
async function feedbackStatus(req, dir) {
  if (!feedbackloop.enabled) return { feedback: null, disabled: true };
  const root = feedbackloop.enrolledRoot(dir);
  if (!root || !feedbackloop.available()) return { feedback: null };
  const s = await feedbackloop.status(root);
  return {
    feedback: {
      target: s?.target || path.basename(root),
      repo: s?.repo || '',
      sub: path.relative(root, fs.realpathSync(dir)),
      counts: s?.counts || null,
      dashboard: feedbackloop.dashboardUrl(s, (req.headers.host || 'localhost').replace(/:\d+$/, '')),
    },
  };
}

function sameFolder(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

// ---------- projects ----------

async function listProjects() {
  const byDir = new Map();
  // `inRoot`: directly under a project root, rather than any folder with chats.
  for (const { dir, name } of rootFolders(PROJECT_ROOTS)) {
    byDir.set(dir, { dir, name, inRoot: true, lastModified: 0, sessions: 0, recent: [], attention: [], tagged: [] });
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
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
};
const MAX_IMAGE_FILE_BYTES = 50 * 1024 * 1024; // videos and audio are streamed, so they have no cap

const UPLOADS = path.join(os.homedir(), '.agentdeck', 'uploads');
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

// The byte range a `Range: bytes=a-b` header asks for, or null for the whole
// file. Throws when the range can't be satisfied.
function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2])); // the last N bytes
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) throw new RangeError('Range not satisfiable');
  return { start, end };
}

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
    if (!knownHost(req)) {
      return send(res, 403, `agentdeck doesn't answer to the name ${req.headers.host}. Add it to ALLOWED_HOSTS if it's yours.`);
    }

    if (p === '/' && req.method === 'GET') {
      const to = canonicalPage(req, url);
      // 302, never 301: a browser must not remember this if the name changes.
      if (to) return send(res, 302, `agentdeck is at ${to}\n`, { location: to });
    }

    if (STATIC[p] && req.method === 'GET') {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(ROOT, file)), { 'content-type': type });
    }

    if (!p.startsWith('/api/')) return send(res, 404, 'Not found');
    if (crossSite(req)) return send(res, 403, { error: 'Requests from other sites are refused.' });

    if (p === '/api/pair') {
      // A browser that isn't approved yet: GET says where it stands, POST
      // asks for approval (once; asking again returns the same request).
      let key = deviceKey(req);
      const status = devices.statusOf(key);
      if (req.method !== 'POST' || status.status === 'approved' || status.status === 'waiting') {
        return send(res, 200, { ...status, password: !!PASSWORD });
      }
      const headers = {};
      if (!devices.validKey(key)) {
        key = devices.newKey();
        headers['set-cookie'] = deviceCookie(key);
      }
      const { created, error, ...asked } = devices.ask(key, await deviceInfo(req));
      if (error) return send(res, 429, { error }, headers);
      if (created) hub.broadcast({ type: 'devices_changed' });
      return send(res, 200, { ...asked, password: !!PASSWORD }, headers);
    }

    if (p === '/api/login' && req.method === 'POST') {
      // The password approves this browser, as an approved device would.
      if (!PASSWORD) return send(res, 400, { error: 'No password is set on the host.' });
      const addr = req.socket.remoteAddress;
      if (recentFailures(addr).length >= MAX_FAILURES) {
        return send(res, 429, { error: 'Too many wrong passwords. Try again in a few minutes.' });
      }
      const { password } = await readJson(req);
      if (typeof password !== 'string' || !safeEqual(password, PASSWORD)) {
        failures.set(addr, [...recentFailures(addr), Date.now()]);
        return send(res, 401, { error: 'Wrong password' });
      }
      let key = deviceKey(req);
      if (!devices.validKey(key)) key = devices.newKey();
      devices.approveKey(key, await deviceInfo(req));
      hub.broadcast({ type: 'devices_changed' });
      return send(res, 200, { ok: true }, { 'set-cookie': deviceCookie(key) });
    }

    const device = devices.deviceFor(deviceKey(req));
    if (!device && !fromHost(req)) return send(res, 401, { error: 'This device is not approved yet.', needApproval: true });

    if (p === '/api/me') {
      return send(res, 200, { ok: true, host: os.hostname(), device: device?.id || null, since: STARTED },
        device ? { 'set-cookie': deviceCookie(deviceKey(req)) } : {});
    }

    if (p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': hi\n\n');
      hub.clients.add(res);
      if (device) streams.set(res, device.id);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        hub.clients.delete(res);
        streams.delete(res);
      });
      return;
    }

    if (p === '/api/devices') {
      return send(res, 200, { devices: devices.list(), waiting: devices.waiting(), current: device?.id || null });
    }

    if (p === '/api/devices/approve' && req.method === 'POST') {
      // `code` is what the approver typed from the new device's screen; the
      // API never hands it out. `id` is the request it was typed for, if any.
      const { code, id } = await readJson(req);
      const approved = devices.approve(code, typeof id === 'string' ? id : undefined);
      if (approved.error) return send(res, 400, { error: approved.error });
      hub.broadcast({ type: 'devices_changed' });
      return send(res, 200, { device: approved.device });
    }

    if (p === '/api/devices/deny' && req.method === 'POST') {
      const { id } = await readJson(req);
      if (!devices.deny(id)) return send(res, 404, { error: 'This device is no longer waiting.' });
      hub.broadcast({ type: 'devices_changed' });
      return send(res, 200, { ok: true });
    }

    if (p === '/api/devices/revoke' && req.method === 'POST') {
      const { id } = await readJson(req);
      if (!devices.revoke(id)) return send(res, 404, { error: 'No such device.' });
      // Its open pages lose the live stream now and ask for approval again.
      for (const [stream, owner] of streams) {
        if (owner !== id) continue;
        hub.clients.delete(stream);
        streams.delete(stream);
        stream.end();
      }
      hub.broadcast({ type: 'devices_changed' });
      return send(res, 200, { ok: true });
    }

    if (p === '/api/actions') {
      // The quick-action buttons. POST replaces the custom ones.
      if (req.method === 'POST') {
        const { actions: list } = await readJson(req);
        const r = actions.setActions(list);
        if (r.error) return send(res, 400, { error: r.error });
        hub.broadcast({ type: 'actions_changed' });
      }
      return send(res, 200, { actions: actions.list(), supervised: SUPERVISED });
    }

    if (p === '/api/actions/run' && req.method === 'POST') {
      // Runs one action. `dir` is the open workspace, where its command runs.
      // A restart stops every running turn, so unless `force` is set it is
      // refused while turns run, and the browser asks first.
      const { id, dir, force } = await readJson(req);
      const action = actions.find(id);
      if (!action) return send(res, 404, { error: 'No such action.' });
      const busy = () => {
        const n = runningTurns();
        return n ? `${n} conversation${n === 1 ? ' is' : 's are'} mid-turn and would be stopped.` : '';
      };
      if (action.restart && !force && busy()) return send(res, 409, { error: busy(), running: runningTurns() });
      let result = { code: 0, output: '', timedOut: false, ms: 0 };
      if (action.command) {
        if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.existsSync(dir)) return send(res, 400, { error: 'Project folder not found' });
        result = await runCommand(action.command, dir);
      }
      // Turns may have started while the command ran; don't cut them off.
      const blocked = action.restart && result.code === 0 && !force ? busy() : '';
      const restarting = action.restart && result.code === 0 && !blocked;
      send(res, 200, { ...result, restarting, blocked });
      if (restarting) restart();
      return;
    }

    if (p === '/api/hub' && req.method === 'GET') {
      // The project bar: Tool Hub's tool for the open workspace, if any.
      const dir = url.searchParams.get('dir') || '';
      if (!path.isAbsolute(dir)) return send(res, 400, { error: 'Project folder not found' });
      return send(res, 200, await hubStatus(req, dir));
    }

    if (p === '/api/hub/restart' && req.method === 'POST') {
      // Restarts the workspace's dev server through the hub; the answer is
      // the hub's own message.
      const { dir } = await readJson(req);
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) return send(res, 400, { error: 'Project folder not found' });
      const tool = await toolhub.toolFor(dir);
      if (!tool) return send(res, 404, { error: tool === undefined ? 'Tool Hub is not running.' : 'This folder is not a Tool Hub tool.' });
      try {
        return send(res, 200, { message: await toolhub.restart(tool.id) });
      } catch (err) {
        return send(res, 502, { error: `Tool Hub: ${err.message}` });
      }
    }

    if (p === '/api/feedback' && req.method === 'GET') {
      // The project bar's bug queue, when the workspace is in feedback-loop.
      const dir = url.searchParams.get('dir') || '';
      if (!path.isAbsolute(dir) || !fs.existsSync(dir)) return send(res, 400, { error: 'Project folder not found' });
      return send(res, 200, await feedbackStatus(req, dir));
    }

    if (p === '/api/feedback/report' && req.method === 'POST') {
      // Files a bug against the workspace's feedback-loop target; answers
      // `{ number, url, target }`.
      const { dir, title, body = '', severity = 'medium', ready = false } = await readJson(req);
      if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.existsSync(dir)) return send(res, 400, { error: 'Project folder not found' });
      const root = feedbackloop.available() && feedbackloop.enrolledRoot(dir);
      if (!root) return send(res, 404, { error: 'This folder is not in feedback-loop.' });
      const t = typeof title === 'string' ? title.trim() : '';
      if (!t || t.length > 200 || t.startsWith('--')) return send(res, 400, { error: t.startsWith('--') ? "A title can't start with --." : 'A title of up to 200 characters is needed.' });
      if (typeof body !== 'string' || body.length > 20_000) return send(res, 400, { error: 'The details are too long.' });
      if (!['low', 'medium', 'high'].includes(severity)) return send(res, 400, { error: 'Severity is low, medium or high.' });
      const sub = path.relative(root, fs.realpathSync(dir));
      try {
        return send(res, 200, await feedbackloop.report(root, {
          title: t,
          body: sub ? `${body.trim()}\n\nFolder: \`${sub}\``.trim() : body.trim(),
          severity,
          ready: ready === true,
        }));
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }

    if (p === '/api/agents') {
      return send(res, 200, (await availableBackends()).map((b) => ({ id: b.id, label: b.label })));
    }

    if (p === '/api/options') {
      const backend = await backendFor(url.searchParams.get('agent'));
      if (!backend) return send(res, 404, { error: 'Unknown agent' });
      return send(res, 200, await backend.options());
    }

    if (p === '/api/commands') {
      // Skills and slash commands for the composer's `/` menu.
      const backend = await backendFor(url.searchParams.get('agent'));
      if (!backend) return send(res, 404, { error: 'Unknown agent' });
      const dir = url.searchParams.get('dir') || '';
      if (!path.isAbsolute(dir) || !fs.existsSync(dir)) return send(res, 400, { error: 'Project folder not found' });
      // A skill can be listed twice, e.g. Codex reads both .agents/skills
      // and .codex/skills; `/name` runs the first.
      const list = backend.commands ? await backend.commands(dir) : [];
      return send(res, 200, list.filter((c, i) => list.findIndex((x) => x.name === c.name) === i));
    }

    if (p === '/api/usage') {
      const backend = await backendFor(url.searchParams.get('agent') || 'claude');
      if (!backend?.usage) return send(res, 404, { error: 'No usage for this agent' });
      return send(res, 200, await backend.usage());
    }

    if (p === '/api/file' && req.method === 'GET') {
      // Image, video and audio files on this machine that an agent showed or
      // linked to.
      const asked = url.searchParams.get('path') || '';
      const file = asked.startsWith('~/') ? path.join(os.homedir(), asked.slice(2)) : asked;
      const type = FILE_TYPES[path.extname(file).toLowerCase()];
      if (!path.isAbsolute(file) || !type) return send(res, 400, { error: 'Not an image, video or audio path' });
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        return send(res, 404, { error: 'File not found' });
      }
      const streamed = /^(video|audio)\//.test(type);
      if (!stat.isFile() || (!streamed && stat.size > MAX_IMAGE_FILE_BYTES)) return send(res, 404, { error: 'File not found' });
      // Players fetch videos and audio in ranges to seek, and Safari won't
      // play them without that.
      let range;
      try {
        range = byteRange(req.headers.range, stat.size);
      } catch {
        return send(res, 416, '', { 'content-range': `bytes */${stat.size}` });
      }
      const { start, end } = range || { start: 0, end: stat.size - 1 };
      res.writeHead(range ? 206 : 200, {
        'content-type': type,
        'content-length': stat.size ? end - start + 1 : 0,
        'accept-ranges': 'bytes',
        ...(range && { 'content-range': `bytes ${start}-${end}/${stat.size}` }),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // SVG can carry scripts; never let one run on this origin.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
      if (!stat.size) return res.end();
      return fs
        .createReadStream(file, { start, end })
        .on('error', () => res.destroy())
        .pipe(res);
    }

    if (p === '/api/upload' && req.method === 'POST') {
      // A file dropped or picked in the composer. A browser never tells the
      // page where a file lives, and it may be on another device, so the file
      // is copied to the host and the message refers to it by that path.
      const name = path.basename(url.searchParams.get('name') || '').replace(/[^\p{L}\p{N}._@+-]/gu, '_').replace(/^\.+/, '') || 'file';
      const dir = path.join(UPLOADS, crypto.randomBytes(4).toString('hex'));
      const file = path.join(dir, name.slice(-120));
      if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) return send(res, 413, { error: 'File too large (max 500 MB)' });
      fs.mkdirSync(dir, { recursive: true });
      let size = 0;
      try {
        await pipeline(
          req,
          new Transform({
            transform(chunk, _, done) {
              size += chunk.length;
              done(size > MAX_UPLOAD_BYTES ? new Error('File too large (max 500 MB)') : null, chunk);
            },
          }),
          fs.createWriteStream(file),
        );
      } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true });
        return send(res, 413, { error: err.message });
      }
      return send(res, 200, { path: file });
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

    if (p === '/api/route' && req.method === 'POST') {
      // "Just ask": which project a task is about, decided by a cheap model
      // from the workspace index (lib/router.mjs). The page then sends the
      // task to a new chat there.
      const { text = '' } = await readJson(req);
      if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: 'Empty message' });
      const projects = await listProjects();
      if (!projects.some((x) => x.inRoot)) return send(res, 400, { error: 'No projects under the project roots.' });
      try {
        return send(res, 200, { ...(await routeTask(text, projects, PROJECT_ROOTS)), model: ROUTE_MODEL });
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }

    if (p === '/api/send' && req.method === 'POST') {
      const { agent = 'claude', sessionId, key, dir, text = '', images = [], mode, model, effort, dirs } = await readJson(req, 80_000_000);
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
      if (!opts.modes.some((x) => x.value === (mode || opts.defaultMode))) return send(res, 400, { error: 'Bad mode' });
      if (!validName(model) || !validName(effort)) return send(res, 400, { error: 'Bad model or effort' });
      if (typeof dir !== 'string' || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return send(res, 400, { error: 'Project folder not found' });
      }
      // A page from before folders were kept sends none: keep the chat's.
      const folders = checkFolders(dirs === undefined && sessionId ? settingsOf(agent, sessionId)?.dirs : dirs, dir);
      if (folders.error) return send(res, 400, { error: folders.error });
      const settings = { mode: mode || opts.defaultMode, model, effort, dirs: folders.dirs };
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
      // The pickers or folders changed in an open chat: remember it for every
      // device. `dir` is the chat's own folder.
      const { agent, sessionId, model, effort, mode, dirs, dir } = await readJson(req);
      const backend = await backendFor(agent);
      if (!backend) return send(res, 400, { error: 'Unknown agent' });
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return send(res, 400, { error: 'Bad session' });
      if (!validName(model) || !validName(effort)) return send(res, 400, { error: 'Bad model or effort' });
      if (mode && !(await backend.options()).modes.some((x) => x.value === mode)) return send(res, 400, { error: 'Bad mode' });
      const folders = checkFolders(dirs === undefined ? settingsOf(agent, sessionId)?.dirs : dirs, dir);
      if (folders.error) return send(res, 400, { error: folders.error });
      hub.settingsChanged(agent, sessionId, { model, effort, mode, dirs: folders.dirs });
      return send(res, 200, { ok: true });
    }

    if (p === '/api/fork' && req.method === 'POST') {
      // Branches a chat: a copy of it up to the end of one turn, as a new
      // session of the same agent, which the browser then opens.
      const { agent = 'claude', sessionId, dir, itemId } = await readJson(req);
      const backend = await backendFor(agent);
      if (!backend) return send(res, 400, { error: 'Unknown agent' });
      if (!backend.fork) return send(res, 400, { error: `${backend.label} cannot fork conversations.` });
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return send(res, 400, { error: 'Bad session' });
      if (typeof itemId !== 'string' || !itemId || itemId.length > 200) return send(res, 400, { error: 'Bad message' });
      if (dir != null && (typeof dir !== 'string' || !fs.existsSync(dir))) return send(res, 400, { error: 'Project folder not found' });
      // Mid-turn the transcript is incomplete, so the copy would be too.
      if (hub.find(agent, sessionId)?.running) return send(res, 409, { error: 'Wait for this turn to finish before forking.' });
      let forked;
      try {
        forked = await backend.fork(sessionId, dir || undefined, itemId);
      } catch (err) {
        return send(res, 400, { error: String(err?.message || err) });
      }
      // The branch continues with the same model, effort and mode, and keeps
      // the tags of the chat it came from.
      const settings = settingsOf(agent, sessionId);
      if (settings) setSettings(agent, forked.sessionId, settings);
      const tags = tagsOf(agent, sessionId);
      if (tags.length) setTags(agent, forked.sessionId, tags);
      hub.broadcast({ type: 'sessions_changed', dir });
      return send(res, 200, { agent, sessionId: forked.sessionId, whole: !!forked.whole });
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
  if (canonicalHost) {
    console.log(`Open on every device: http://${canonicalHost}:${PORT}`);
    console.log('  The page under another name is sent here, so each browser is approved once.');
  }
  const approved = devices.list().length;
  console.log(`Approved devices: ${approved}${approved ? '' : ' (open agentdeck in a browser, then run `npm run approve` here)'}`);
  if (PASSWORD) console.log('Password: on (it also approves a device)');
  console.log(`Project roots: ${PROJECT_ROOTS.join(', ')}`);
  console.log(`Workspace index for agents: ${workspaceIndexEnabled ? 'on' : 'off'}`);
  availableBackends().then((list) => console.log(`Agents: ${list.map((b) => b.label).join(', ')}`));
  toolhub.probe(); // prints whether a Tool Hub answered, once it has (or hasn't)
});

// Exit through process.exit so agents' child processes are cleaned up.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

// Also answer on localhost so it can be opened on the host itself.
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '0.0.0.0' && HOST !== '::') {
  const local = http.createServer((req, res) => server.emit('request', req, res));
  local.on('error', (err) => console.warn(`Not listening on localhost:${PORT}: ${err.message}`));
  local.listen(PORT, '127.0.0.1', () => console.log(`Also on http://localhost:${PORT}`
    + (canonicalHost ? ', which opens the name above (add ?stay to keep localhost)' : '')));
}
