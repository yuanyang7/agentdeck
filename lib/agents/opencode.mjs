// opencode (v2), through its HTTP API. The first time it's needed this starts a
// private `opencode serve` on localhost (or uses OPENCODE_URL if set), keeps
// one subscription to its event stream and routes events to running turns by
// session id. Conversations are opencode's own sessions, so they also open in
// the opencode TUI.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { ItemList, toolItem, clip, imageUrl } from '../items.mjs';

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
      for (const handle of routes.values()) handle({ type: 'server.exited', data: {} });
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
  const url = new URL(s.url + '/api' + pathname);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { ...s.headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text).message || message;
    } catch {}
    throw new Error(`opencode: ${res.status} ${message}`);
  }
  return text ? JSON.parse(text) : null;
}

// Every page of a cursor-paginated list.
async function all(pathname, query) {
  const out = [];
  let page = await call('GET', pathname, { query: { ...query, limit: 200 } });
  for (;;) {
    out.push(...page.data);
    const next = page.cursor?.next;
    if (!next || page.data.length < 200) return out;
    page = await call('GET', pathname, { query: { limit: 200, type: query.type, cursor: next } });
  }
}

// A location's agents and models load on first use; until then its lists are
// empty, so this asks again for a few seconds.
async function loaded(pathname) {
  for (let i = 0; ; i++) {
    const res = await call('GET', pathname);
    if ((Array.isArray(res.data) ? res.data.length : res.data) || i >= 20) return res.data;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// One long-lived subscription to every location's events, kept while this
// server is the current one. If it drops, it reconnects and lets running
// turns check whether they finished meanwhile.
async function subscribe(s, owner, connected) {
  let first = true;
  while (server === owner) {
    try {
      const res = await fetch(s.url + '/api/event', { headers: s.headers });
      if (!res.ok) throw new Error(`event stream: ${res.status}`);
      if (first) connected();
      else for (const handle of routes.values()) handle({ type: 'resync', data: {} });
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
            dispatch(JSON.parse(data));
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
  const d = ev?.data || {};
  // A subagent's child session reports to the turn that started it.
  if (ev?.type === 'session.created' && d.parentID && routes.has(d.parentID)) {
    routes.set(d.sessionID, routes.get(d.parentID));
  }
  routes.get(d.sessionID || d.form?.sessionID)?.(ev);
}

// ---------- messages → items ----------

// Text and reasoning blocks have no ids of their own; they're numbered per
// kind within their message, the same way live events number them.
const blockId = (messageId, kind, ordinal) => `${messageId}:${kind}:${ordinal}`;
const toolId = (messageId, id) => `${messageId}:${id}`;

const fileUrl = (f) => (f.source?.type === 'uri' ? f.source.uri : `data:${f.mime};base64,${f.data}`);

function userItem(m) {
  const images = (m.files || []).filter((f) => /^image\//.test(f.mime || '')).map(fileUrl);
  return { id: m.id, kind: 'user', text: m.text || '', images };
}

const toolOutput = (content) =>
  clip((content || []).map((c) => (c.type === 'text' ? c.text : `[${c.name || c.mime}]`)).join('\n'));

// Pictures among a tool's attachments, e.g. reading a PNG.
const toolImages = (content) =>
  (content || [])
    .filter((c) => c.type === 'file' && /^image\//.test(c.mime || '') && c.data)
    .map((c) => (/^(data|file):/.test(c.data) ? imageUrl(c.data) : fileUrl(c)));

function toolState(id, name, st, dir) {
  const input = typeof st.input === 'object' ? st.input : undefined;
  const item = { ...toolItem(id, name, input, dir), status: 'running', output: '' };
  const images = toolImages(st.content);
  if (st.status === 'completed') Object.assign(item, { status: 'done', output: toolOutput(st.content), images });
  if (st.status === 'error') Object.assign(item, { status: 'error', output: st.error?.message || toolOutput(st.content), images });
  return item;
}

function assistantItems(m, dir) {
  const items = [];
  const count = { text: 0, reasoning: 0 };
  for (const c of m.content || []) {
    if (c.type === 'tool') {
      items.push(toolState(toolId(m.id, c.id), c.name, c.state || {}, dir));
    } else if (c.type === 'text' || c.type === 'reasoning') {
      const id = blockId(m.id, c.type, count[c.type]++);
      items.push({ id, kind: c.type === 'text' ? 'text' : 'thinking', text: c.text });
    }
  }
  const error = errorText(m.error);
  if (error) items.push({ id: `${m.id}:error`, kind: 'notice', text: error, error: error !== 'Interrupted' });
  return items;
}

function errorText(error) {
  if (!error) return null;
  if (error.type === 'aborted') return 'Interrupted';
  return error.message || error.type || 'Error';
}

// ---------- permissions ----------

// 'ask' runs the build agent but asks before edits and shell commands;
// every other mode is an opencode agent with its configured permissions.
const ASK_RULES = ['edit', 'shell'].map((action) => ({ action, resource: '*', effect: 'ask' }));
const rulesFor = (mode) => (mode === 'ask' ? ASK_RULES : []);
const agentFor = (mode) => (mode === 'ask' ? 'build' : mode);

function permissionRequest(p) {
  const detail = p.metadata?.diff || (p.resources || []).join('\n') || JSON.stringify(p.metadata, null, 2);
  return {
    kind: 'permission',
    title: `opencode wants to use ${p.action}`,
    reason: p.message,
    detail: String(detail),
    canAlways: (p.save || []).length > 0,
  };
}

// opencode asks questions (and any other input it needs) as forms; each
// field becomes one question.
const formFields = (form) => (form.fields || []).filter((f) => !f.hidden && f.type !== 'external');

function questionRequest(form) {
  return {
    kind: 'question',
    title: form.metadata?.kind === 'question' ? 'opencode has a question' : form.title,
    questions: formFields(form).map((f) => ({
      question: f.description || f.title || f.key,
      header: f.title,
      options:
        f.type === 'boolean'
          ? [{ label: 'Yes' }, { label: 'No' }]
          : (f.options || []).map((o) => ({ label: o.label, description: o.description })),
      multiple: f.type === 'multiselect',
    })),
  };
}

// The browser answers with the chosen labels (or typed text) per question.
function formAnswer(form, answers) {
  const answer = {};
  formFields(form).forEach((f, i) => {
    const picked = (answers[i] || []).map((label) => f.options?.find((o) => o.label === label)?.value ?? label);
    if (!picked.length) return;
    if (f.type === 'multiselect') answer[f.key] = picked;
    else if (f.type === 'boolean') answer[f.key] = /^(yes|true|y)$/i.test(picked[0]);
    else if (f.type === 'number' || f.type === 'integer') answer[f.key] = Number(picked[0]);
    else answer[f.key] = picked[0];
  });
  return answer;
}

// ---------- usage ----------

// The OpenCode Go quota endpoint the web console uses. The key is the same one
// opencode itself stores when you /connect an OpenCode Go plan.
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const USAGE_LABELS = { rolling: '5-hour', weekly: 'Weekly', monthly: 'Monthly' };
let usageCache = { at: 0, data: null };

function goKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.local/share/opencode/auth.json'), 'utf8'));
    return auth['opencode-go']?.key || auth.opencode?.key || null;
  } catch {}
  return null;
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
    const [models, def, agents] = await Promise.all([loaded('/model'), loaded('/model/default'), loaded('/agent')]);
    const primary = agents.filter((a) => !a.hidden && a.mode !== 'subagent');
    optionsCache = {
      modes: [{ value: 'ask', label: 'Ask before actions' }, ...primary.map((a) => ({ value: a.id, label: a.name }))],
      defaultMode: 'ask',
      models: models
        .filter((m) => m.enabled && m.capabilities?.tools !== false)
        .map((m) => ({ value: `${m.providerID}/${m.id}`, label: m.name || m.id, efforts: m.variants.map((v) => v.id) })),
      defaultModel: def ? def.name || def.id : null,
      efforts: [],
      defaultEffort: null,
      images: true,
      usage: !!goKey(),
      fork: true,
    };
    return optionsCache;
  },

  // Plan limits, as { plan, limits: [{ label, percent, resetsAt }] }. Cached
  // briefly so repeatedly opening the panel doesn't re-fetch.
  async usage() {
    if (usageCache.data && Date.now() - usageCache.at < 30_000) return usageCache.data;
    const key = goKey();
    if (!key) throw new Error('No OpenCode Go API key found');
    const res = await fetch(USAGE_URL, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`usage: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const usage = (await res.json()).usage || {};
    const limits = [];
    for (const [k, label] of Object.entries(USAGE_LABELS)) {
      const w = usage[k];
      if (w?.percent != null) limits.push({ label, percent: w.percent, resetsAt: w.resetsAt });
    }
    const data = { plan: limits.length ? 'Go' : null, limits };
    usageCache = { at: Date.now(), data };
    return data;
  },

  async listSessions(dir) {
    const sessions = await all('/session', { directory: dir, parentID: 'null', order: 'desc' });
    return sessions
      .filter((s) => !s.parentID && !s.time?.archived)
      .map((s) => ({
        id: s.id,
        dir: dir || s.location?.directory,
        title: s.title || 'Untitled',
        updatedAt: s.time?.updated,
        branch: null,
      }));
  },

  async history(sessionId, dir) {
    const list = new ItemList();
    for (const m of await all(`/session/${sessionId}/message`, { order: 'asc' })) {
      if (m.type === 'user') list.put(userItem(m));
      else if (m.type === 'assistant') for (const item of assistantItems(m, dir)) list.put(item);
    }
    return list.values();
  },

  // The session keeps the model and variant (effort) it last used, and the
  // agent and permission rules its mode set (see agentFor and rulesFor).
  async lastSettings(sessionId) {
    const s = (await call('GET', `/session/${sessionId}`)).data;
    if (!s) return null;
    const m = s.model;
    const asks = ASK_RULES.every((r) => (s.permissions || []).some((p) => p.action === r.action && p.resource === r.resource && p.effect === 'ask'));
    return {
      model: m?.providerID && m.id ? `${m.providerID}/${m.id}` : null,
      effort: m?.variant || null,
      mode: s.agent === 'build' && asks ? 'ask' : s.agent || null,
    };
  },

  // Copies the chat into a new session, keeping everything through the end of
  // the turn the message `itemId` started. opencode's fork point is the first
  // message to leave out, so that's the next user message.
  async fork(sessionId, dir, itemId) {
    const messages = await all(`/session/${sessionId}/message`, { order: 'asc' });
    const start = messages.findIndex((m) => m.id === itemId);
    if (start < 0) throw new Error('That message is no longer in this conversation.');
    const next = messages.find((m, i) => i > start && m.type === 'user');
    const forked = (await call('POST', `/session/${sessionId}/fork`, { body: { before: next?.id } })).data;
    return { sessionId: forked.id, whole: !next };
  },

  startTurn(turn) {
    const { dir, settings } = turn;
    let sessionId = turn.sessionId;

    const done = (async () => {
      let model;
      if (settings.model) {
        const i = settings.model.indexOf('/');
        model = { providerID: settings.model.slice(0, i), id: settings.model.slice(i + 1) };
        if (settings.effort) model.variant = settings.effort;
      }
      if (sessionId) {
        const active = (await call('GET', '/session/active')).data;
        if (active[sessionId]) throw new Error('opencode is already working on this conversation somewhere else.');
        await call('PATCH', `/session/${sessionId}`, { body: { permissions: rulesFor(settings.mode) } });
        await call('POST', `/session/${sessionId}/agent`, { body: { agent: agentFor(settings.mode) } });
        if (model) await call('POST', `/session/${sessionId}/model`, { body: { model } });
      } else {
        const body = { location: { directory: dir }, agent: agentFor(settings.mode), permissions: rulesFor(settings.mode) };
        if (model) body.model = model;
        sessionId = (await call('POST', '/session', { body })).data.id;
        turn.bind(sessionId);
        // The workspace index, as an instruction entry stored with the
        // session. This API is experimental, so a chat without it is fine.
        if (turn.instructions) {
          await call('PUT', `/experimental/session/${sessionId}/instructions/entries/workspace-index`, { body: { value: turn.instructions } }).catch(
            (err) => console.error('opencode instructions:', err.message),
          );
        }
      }

      const tools = new Map(); // item id -> name, for tool events that only carry an id
      const asks = new Map(); // opencode request id -> AbortController
      let cost = 0;
      let error = null;
      let interrupted = false;
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
        const d = ev.data || {};
        const own = d.sessionID === sessionId; // not a subagent's
        const msg = d.assistantMessageID;
        switch (ev.type) {
          case 'session.text.started':
          case 'session.reasoning.started':
          case 'session.text.ended':
          case 'session.reasoning.ended': {
            if (!own) break;
            const kind = ev.type.split('.')[1];
            turn.item({ id: blockId(msg, kind, d.ordinal), kind: kind === 'text' ? 'text' : 'thinking', text: d.text || '' });
            break;
          }
          case 'session.text.delta':
          case 'session.reasoning.delta':
            if (own) turn.delta(blockId(msg, ev.type.split('.')[1], d.ordinal), d.delta);
            break;
          case 'session.tool.input.started':
            if (!own) break;
            tools.set(toolId(msg, d.id), d.name);
            turn.item(toolState(toolId(msg, d.id), d.name, { status: 'streaming' }, dir));
            break;
          case 'session.tool.called':
          case 'session.tool.success':
          case 'session.tool.failed': {
            if (!own) break;
            const id = toolId(msg, d.id);
            const status = { 'session.tool.called': 'running', 'session.tool.success': 'completed' }[ev.type] || 'error';
            // Results don't repeat the input, so keep what the call showed.
            const { summary, detail, ...result } = toolState(id, tools.get(id) || 'tool', { ...d, status }, dir);
            turn.item(d.input ? { ...result, summary, detail } : result);
            break;
          }
          case 'session.step.ended':
            if (own) cost += d.cost || 0;
            break;
          case 'session.step.failed':
            if (!own) break;
            cost += d.cost || 0;
            if (d.error?.type === 'aborted') interrupted = true;
            else error = errorText(d.error);
            break;
          case 'permission.asked':
            relay(d.id, permissionRequest(d), (a) =>
              call('POST', `/session/${d.sessionID}/permission/${d.id}/reply`, {
                body: a.allow ? { decision: a.always ? 'always' : 'once' } : { decision: 'reject', ...(a.message ? { message: a.message } : {}) },
              }),
            );
            break;
          case 'form.created': {
            const form = d.form;
            relay(form.id, questionRequest(form), (a) =>
              a.allow
                ? call('POST', `/session/${form.sessionID}/form/${form.id}/reply`, { body: { answer: formAnswer(form, a.answers || []) } })
                : call('DELETE', `/session/${form.sessionID}/form/${form.id}`),
            );
            break;
          }
          case 'permission.replied':
          case 'permission.rejected':
          case 'form.replied':
          case 'form.cancelled': {
            const id = d.requestID || d.id;
            asks.get(id)?.abort();
            asks.delete(id);
            break;
          }
          case 'session.execution.failed':
            if (!own) break;
            error ||= errorText(d.error) || 'opencode failed.';
            finish();
            break;
          case 'session.execution.interrupted':
            if (own) (interrupted = true), finish();
            break;
          case 'session.execution.succeeded':
            if (own) finish();
            break;
          case 'resync':
            call('GET', '/session/active')
              .then((a) => !a.data[sessionId] && finish())
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
        const files = turn.images.map((img, i) => ({ uri: `data:${img.mediaType};base64,${img.data}`, name: `image-${i + 1}` }));
        const sent = await call('POST', `/session/${sessionId}/prompt`, { body: { text: turn.text || '', files } });
        turn.item({ id: sent.data.id, kind: 'user', text: turn.text || '', images: files.map((f) => f.uri) });
        await finished;
      } finally {
        for (const [id, h] of routes) if (h === handle) routes.delete(id);
      }
      if (interrupted) turn.item({ id: `${sessionId}:interrupted-${Date.now()}`, kind: 'notice', text: 'Interrupted' });
      return { cost, error };
    })();

    return {
      done,
      async interrupt() {
        if (sessionId) await call('POST', `/session/${sessionId}/interrupt`).catch(() => {});
      },
      async setMode(mode) {
        if (!sessionId) return;
        await call('PATCH', `/session/${sessionId}`, { body: { permissions: rulesFor(mode) } }).catch(() => {});
        await call('POST', `/session/${sessionId}/agent`, { body: { agent: agentFor(mode) } }).catch(() => {});
      },
    };
  },
};
