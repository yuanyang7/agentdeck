// opencode, through its HTTP server. The first time it's needed this starts a
// private `opencode serve` on localhost (or uses OPENCODE_URL if set), keeps
// one subscription to its event stream and routes events to running turns by
// session id. Conversations are opencode's own sessions, so they also open in
// the opencode TUI.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { ItemList, toolItem, clip, dataUrl } from '../items.mjs';

function findBinary() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  try {
    return execFileSync('which', ['opencode'], { encoding: 'utf8' }).trim() || null;
  } catch {}
  const local = path.join(os.homedir(), '.opencode', 'bin', 'opencode');
  return fs.existsSync(local) ? local : null;
}

// ---------- server process ----------

let server = null; // Promise<{ url, headers }>
let child = null;
const routes = new Map(); // sessionId -> event handler of the turn running it

function startServer() {
  if (process.env.OPENCODE_URL) {
    const pw = process.env.OPENCODE_SERVER_PASSWORD;
    const headers = pw ? { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') } : {};
    return Promise.resolve({ url: process.env.OPENCODE_URL.replace(/\/$/, ''), headers });
  }
  const bin = findBinary();
  if (!bin) return Promise.reject(new Error('opencode is not installed'));
  const password = crypto.randomBytes(24).toString('hex');
  const headers = { authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') };
  return new Promise((resolve, reject) => {
    child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('opencode server did not start')), 30_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const m = out.match(/listening on (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ url: m[1].replace(/\/$/, ''), headers });
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`opencode server exited (${code})`));
      child = null;
      server = null;
      for (const handle of routes.values()) handle({ type: 'server.exited' });
    });
  });
}

process.on('exit', () => child?.kill());

// Resolves once the event stream is connected too, so a turn never sends a
// prompt before it can hear the reply.
function ensureServer() {
  if (!server) {
    const starting = startServer().then(async (s) => {
      await new Promise((resolve) => subscribe(s, starting, resolve));
      return s;
    });
    server = starting;
    starting.catch(() => server === starting && (server = null));
  }
  return server;
}

async function call(method, pathname, { query = {}, body } = {}) {
  const s = await ensureServer();
  const url = new URL(s.url + pathname);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { ...s.headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`opencode: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// One long-lived subscription to every directory's events, kept while this
// server is the current one. If it drops, it reconnects and lets running
// turns check whether they finished meanwhile.
async function subscribe(s, owner, connected) {
  let first = true;
  while (server === owner) {
    try {
      const res = await fetch(s.url + '/global/event', { headers: s.headers });
      if (!res.ok) throw new Error(`event stream: ${res.status}`);
      if (first) connected();
      else for (const handle of routes.values()) handle({ type: 'resync' });
      first = false;
      let buf = '';
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          try {
            dispatch(JSON.parse(data).payload);
          } catch (err) {
            console.error('opencode event:', err);
          }
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function dispatch(ev) {
  const p = ev?.properties || {};
  // A subagent's child session reports to the turn that started it.
  if (ev?.type === 'session.created' && p.info?.parentID && routes.has(p.info.parentID)) {
    routes.set(p.info.id, routes.get(p.info.parentID));
  }
  const sessionId = p.sessionID || p.part?.sessionID || p.info?.sessionID;
  routes.get(sessionId)?.(ev);
}

// ---------- messages → items ----------

const isImage = (part) => part.type === 'file' && /^image\//.test(part.mime || '');

function userItem(messageId, parts) {
  const text = parts.filter((p) => p.type === 'text' && !p.synthetic && !p.ignored).map((p) => p.text).join('\n\n');
  return { id: messageId, kind: 'user', text, images: parts.filter(isImage).map((p) => p.url) };
}

const TOOL_STATUS = { pending: 'running', running: 'running', completed: 'done', error: 'error' };

function partItem(part, dir) {
  if (part.type === 'text' && !part.synthetic && !part.ignored) return { id: part.id, kind: 'text', text: part.text };
  if (part.type === 'reasoning') return { id: part.id, kind: 'thinking', text: part.text };
  if (part.type === 'tool') {
    const st = part.state || {};
    const output = st.status === 'error' ? st.error : st.output ?? st.metadata?.output;
    return {
      ...toolItem(part.id, part.tool, st.input, dir),
      status: TOOL_STATUS[st.status] || 'running',
      output: output == null ? '' : clip(output),
    };
  }
  return null;
}

function errorText(error) {
  if (!error) return null;
  if (error.name === 'MessageAbortedError') return 'Interrupted';
  return error.data?.message || error.name || 'Error';
}

// ---------- permissions ----------

// 'ask' runs the build agent but asks before edits and shell commands;
// every other mode is an opencode agent with its configured permissions.
const ASK_RULES = ['edit', 'bash'].map((permission) => ({ permission, pattern: '*', action: 'ask' }));
const rulesFor = (mode) => (mode === 'ask' ? ASK_RULES : []);
const agentFor = (mode) => (mode === 'ask' ? 'build' : mode);

function permissionRequest(p) {
  const detail = p.metadata?.diff || p.metadata?.command || (p.patterns || []).join('\n') || JSON.stringify(p.metadata, null, 2);
  return {
    kind: 'permission',
    title: `opencode wants to use ${p.permission}`,
    detail: String(detail),
    canAlways: (p.always || []).length > 0,
  };
}

function questionRequest(p) {
  return {
    kind: 'question',
    title: 'opencode has a question',
    questions: (p.questions || []).map((q) => ({
      question: q.question,
      header: q.header,
      options: q.options || [],
      multiple: !!q.multiple,
    })),
  };
}

// ---------- backend ----------

let optionsCache = null;

export default {
  id: 'opencode',
  label: 'opencode',

  async available() {
    return !!(process.env.OPENCODE_URL || findBinary());
  },

  async options() {
    if (optionsCache) return optionsCache;
    const [config, providers, agents] = await Promise.all([
      call('GET', '/config'),
      call('GET', '/config/providers'),
      call('GET', '/agent'),
    ]);
    const models = [];
    for (const p of providers.providers) {
      for (const [id, m] of Object.entries(p.models)) {
        if (m.capabilities?.toolcall === false) continue;
        models.push({ value: `${p.id}/${id}`, label: `${p.name} · ${m.name || id}`, efforts: Object.keys(m.variants || {}) });
      }
    }
    const def = config.model && models.find((m) => m.value === config.model);
    const primary = agents.filter((a) => !a.hidden && a.mode !== 'subagent' && !['compaction', 'summary', 'title'].includes(a.name));
    optionsCache = {
      modes: [
        { value: 'ask', label: 'Ask before actions' },
        ...primary.map((a) => ({ value: a.name, label: a.name[0].toUpperCase() + a.name.slice(1) })),
      ],
      defaultMode: 'ask',
      models,
      defaultModel: def?.label || config.model || null,
      efforts: [],
      defaultEffort: null,
      images: true,
      usage: false,
    };
    return optionsCache;
  },

  async listSessions(dir) {
    const sessions = await call('GET', '/session', { query: { directory: dir, roots: 'true' } });
    return sessions
      .filter((s) => !s.parentID && !s.time?.archived)
      .map((s) => ({ id: s.id, dir: dir || s.directory, title: s.title || 'Untitled', updatedAt: s.time?.updated, branch: null }));
  },

  async history(sessionId, dir) {
    const list = new ItemList();
    for (const { info, parts } of await call('GET', `/session/${sessionId}/message`, { query: { directory: dir } })) {
      if (info.role === 'user') {
        list.put(userItem(info.id, parts));
        continue;
      }
      for (const part of parts) {
        const item = partItem(part, dir);
        if (item) list.put(item);
      }
      const error = errorText(info.error);
      if (error) list.put({ id: `${info.id}:error`, kind: 'notice', text: error, error: error !== 'Interrupted' });
    }
    return list.values();
  },

  startTurn(turn) {
    const { dir, settings } = turn;
    let sessionId = turn.sessionId;
    const q = { directory: dir };

    const done = (async () => {
      if (sessionId) {
        const status = await call('GET', '/session/status', { query: q });
        if (status[sessionId] && status[sessionId].type !== 'idle') {
          throw new Error('opencode is already working on this conversation somewhere else.');
        }
        await call('PATCH', `/session/${sessionId}`, { query: q, body: { permission: rulesFor(settings.mode) } });
      } else {
        sessionId = (await call('POST', '/session', { query: q, body: { permission: rulesFor(settings.mode) } })).id;
        turn.bind(sessionId);
      }

      const roles = new Map(); // messageId -> 'user' | 'assistant'
      const userParts = new Map(); // messageId -> Map(partId -> part)
      const costs = new Map(); // assistant messageId -> cost
      const asks = new Map(); // opencode request id -> AbortController
      let error = null;
      let finish;
      const finished = new Promise((resolve) => (finish = resolve));

      // Shows a prompt here and relays the answer, unless it is answered
      // somewhere else first (the TUI), which aborts it.
      const relay = async (requestId, request, reply) => {
        const ctl = new AbortController();
        asks.set(requestId, ctl);
        const answer = await turn.ask(request, ctl.signal);
        if (ctl.signal.aborted) return;
        asks.delete(requestId);
        await reply(answer).catch((err) => console.error('opencode reply:', err));
      };

      const handle = (ev) => {
        const p = ev.properties || {};
        const own = p.sessionID === sessionId || p.part?.sessionID === sessionId;
        switch (ev.type) {
          case 'message.updated':
            if (!own) break;
            roles.set(p.info.id, p.info.role);
            if (p.info.role === 'assistant' && p.info.cost) costs.set(p.info.id, p.info.cost);
            break;
          case 'message.part.updated': {
            if (!own) break; // subagent internals
            const part = p.part;
            if (roles.get(part.messageID) === 'user') {
              const parts = userParts.get(part.messageID) || new Map();
              userParts.set(part.messageID, parts.set(part.id, part));
              turn.item(userItem(part.messageID, [...parts.values()]));
            } else {
              const item = partItem(part, dir);
              if (item) turn.item(item);
            }
            break;
          }
          case 'message.part.delta':
            if (own && p.field === 'text') turn.delta(p.partID, p.delta);
            break;
          case 'permission.asked':
            relay(p.id, permissionRequest(p), (a) =>
              call('POST', `/permission/${p.id}/reply`, {
                query: q,
                body: a.allow ? { reply: a.always ? 'always' : 'once' } : { reply: 'reject', ...(a.message ? { message: a.message } : {}) },
              }),
            );
            break;
          case 'question.asked':
            relay(p.id, questionRequest(p), (a) =>
              a.allow
                ? call('POST', `/question/${p.id}/reply`, { query: q, body: { answers: a.answers || [] } })
                : call('POST', `/question/${p.id}/reject`, { query: q }),
            );
            break;
          case 'permission.replied':
          case 'question.replied':
          case 'question.rejected':
            asks.get(p.requestID)?.abort();
            asks.delete(p.requestID);
            break;
          case 'session.error':
            if (own) error = errorText(p.error);
            break;
          case 'session.idle':
            if (own) finish();
            break;
          case 'resync':
            call('GET', '/session/status', { query: q })
              .then((s) => (!s[sessionId] || s[sessionId].type === 'idle') && finish())
              .catch(() => {});
            break;
          case 'server.exited':
            error = 'The opencode server stopped.';
            finish();
            break;
        }
      };
      routes.set(sessionId, handle);

      try {
        const parts = turn.images.map((img, i) => ({ type: 'file', mime: img.mediaType, url: dataUrl(img), filename: `image-${i + 1}` }));
        if (turn.text) parts.push({ type: 'text', text: turn.text });
        const body = { parts, agent: agentFor(settings.mode) };
        if (settings.model) {
          const i = settings.model.indexOf('/');
          body.model = { providerID: settings.model.slice(0, i), modelID: settings.model.slice(i + 1) };
        }
        if (settings.effort) body.variant = settings.effort;
        await call('POST', `/session/${sessionId}/prompt_async`, { query: q, body });
        await finished;
      } finally {
        for (const [id, h] of routes) if (h === handle) routes.delete(id);
      }
      if (error === 'Interrupted') {
        turn.item({ id: `${sessionId}:interrupted-${Date.now()}`, kind: 'notice', text: 'Interrupted' });
        error = null;
      }
      return { cost: [...costs.values()].reduce((a, b) => a + b, 0), error };
    })();

    return {
      done,
      async interrupt() {
        if (sessionId) await call('POST', `/session/${sessionId}/abort`, { query: q }).catch(() => {});
      },
      async setMode(mode) {
        if (sessionId) await call('PATCH', `/session/${sessionId}`, { query: q, body: { permission: rulesFor(mode) } }).catch(() => {});
      },
    };
  },
};
