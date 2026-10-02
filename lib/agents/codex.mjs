// Codex, through `codex app-server` (JSON-RPC over stdio), using the Codex
// login on this machine (a ChatGPT plan or an API key). The first time it's
// needed this starts one app-server and routes its notifications and
// requests to running turns by thread id. Conversations are Codex's own
// threads in ~/.codex, so they also open in the Codex app and CLI.

import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { ItemList, toolDetail, toolSummary, clip, dataUrl } from '../items.mjs';

// The Codex app updates its own copy of the CLI, which is often newer than
// one on PATH, so the newest of the candidates wins.
const CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
];

let binary;
function findBinary() {
  if (binary !== undefined) return binary;
  if (process.env.CODEX_BIN) return (binary = process.env.CODEX_BIN);
  const paths = [...CANDIDATES];
  try {
    paths.unshift(execFileSync('which', ['codex'], { encoding: 'utf8' }).trim());
  } catch {}
  const found = paths.filter((p) => p && fs.existsSync(p)).map((p) => {
    try {
      const v = execFileSync(p, ['--version'], { encoding: 'utf8' }).match(/(\d+)\.(\d+)\.(\d+)/);
      return { p, v: v ? v.slice(1).map(Number) : [0, 0, 0] };
    } catch {
      return null;
    }
  }).filter(Boolean);
  found.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return (binary = found[0]?.p || null);
}

// ---------- app-server process ----------

let server = null; // Promise<void> once initialized
let child = null;
let nextId = 1;
const calls = new Map(); // request id -> { resolve, reject }
const routes = new Map(); // threadId -> { notify(method, params), request(method, params) -> Promise<result> }
const loaded = new Set(); // threads this app-server has started or resumed

function write(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

async function rpc(method, params) {
  await ensureServer();
  return send(method, params);
}

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    calls.set(id, { resolve, reject });
    write({ id, method, params });
  });
}

// Requests from Codex nobody here can answer get a refusal that keeps the turn going.
const REFUSALS = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  'item/tool/requestUserInput': { answers: {} },
  'item/permissions/requestApproval': { permissions: {}, scope: 'turn' },
  'mcpServer/elicitation/request': { action: 'decline', content: null, _meta: null },
};

async function onServerRequest(msg) {
  const route = routes.get(msg.params?.threadId);
  try {
    const result = route ? await route.request(msg.method, msg.params, msg.id) : REFUSALS[msg.method];
    if (result === undefined) write({ id: msg.id, error: { code: -32601, message: `${msg.method} is not supported by claude-web` } });
    else write({ id: msg.id, result });
  } catch (err) {
    write({ id: msg.id, error: { code: -32603, message: String(err?.message || err) } });
  }
}

function onLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && msg.method) return onServerRequest(msg);
  if (msg.id !== undefined) {
    const call = calls.get(msg.id);
    calls.delete(msg.id);
    if (msg.error) call?.reject(new Error(`codex: ${msg.error.message}`));
    else call?.resolve(msg.result);
    return;
  }
  routes.get(msg.params?.threadId)?.notify(msg.method, msg.params);
}

function ensureServer() {
  if (server) return server;
  server = new Promise((resolve, reject) => {
    const bin = findBinary();
    if (!bin) return reject(new Error('Codex is not installed'));
    child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    readline.createInterface({ input: child.stdout }).on('line', onLine);
    child.on('error', reject);
    child.on('exit', (code) => {
      reject(new Error(`codex app-server exited (${code})`));
      for (const c of calls.values()) c.reject(new Error('codex app-server exited'));
      calls.clear();
      loaded.clear();
      child = null;
      server = null;
      for (const route of routes.values()) route.notify('server/exited', {});
    });
    send('initialize', { clientInfo: { name: 'claude-web', title: 'claude-web', version: '1.0.0' }, capabilities: null })
      .then(() => {
        write({ method: 'initialized' });
        resolve();
      }, reject);
  });
  server.catch(() => (server = null));
  return server;
}

process.on('exit', () => child?.kill());

// ---------- items ----------

const STATUS = { inProgress: 'running', completed: 'done', failed: 'error', declined: 'error' };

function userInputItem(id, content) {
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n\n');
  return { id, kind: 'user', text, images: content.filter((c) => c.type === 'image').map((c) => c.url) };
}

function tool(id, name, input, dir, extra) {
  return { id, kind: 'tool', name, summary: toolSummary(input, dir), detail: toolDetail(input), ...extra };
}

function mcpOutput(item) {
  if (item.error) return item.error.message;
  const content = item.result?.content || [];
  return content.map((c) => (c?.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
}

function threadItem(item, dir) {
  switch (item.type) {
    case 'userMessage':
      return userInputItem(item.id, item.content || []);
    case 'agentMessage':
      return { id: item.id, kind: 'text', text: item.text };
    case 'plan':
      return { id: item.id, kind: 'text', text: item.text };
    case 'reasoning': {
      const text = (item.summary?.length ? item.summary : item.content || []).join('\n\n');
      return { id: item.id, kind: 'thinking', text };
    }
    case 'commandExecution': {
      const command = item.commandActions?.length === 1 ? item.commandActions[0].command : item.command;
      const failed = item.status === 'completed' && item.exitCode != null && item.exitCode !== 0;
      return tool(item.id, 'Shell', { command }, dir, {
        status: failed ? 'error' : STATUS[item.status] || 'running',
        output: clip(item.aggregatedOutput || (item.status === 'declined' ? 'Declined' : '')),
      });
    }
    case 'fileChange': {
      const changes = item.changes || [];
      return {
        id: item.id,
        kind: 'tool',
        name: 'Edit',
        summary: changes.map((c) => toolSummary({ path: c.path }, dir)).join(', '),
        detail: changes.map((c) => `${c.path}\n${c.diff}`).join('\n\n'),
        status: STATUS[item.status] || 'running',
        output: item.status === 'declined' ? 'Declined' : '',
      };
    }
    case 'mcpToolCall':
      return tool(item.id, `${item.server}.${item.tool}`, item.arguments, dir, {
        status: STATUS[item.status] || 'running',
        output: clip(mcpOutput(item)),
      });
    case 'dynamicToolCall':
      return tool(item.id, item.tool, item.arguments, dir, {
        status: item.success === false ? 'error' : STATUS[item.status] || 'running',
        output: clip((item.contentItems || []).map((c) => c.text ?? JSON.stringify(c)).join('\n')),
      });
    case 'webSearch':
      return tool(item.id, 'WebSearch', { query: item.query }, dir, { status: 'done' });
    case 'collabAgentToolCall':
      return tool(item.id, 'Agent', { prompt: item.prompt || '' }, dir, { status: STATUS[item.status] || 'done' });
    case 'contextCompaction':
      return { id: item.id, kind: 'notice', text: 'Context compacted' };
  }
  return null;
}

// ---------- modes and permissions ----------

// Each mode is an approval policy and a sandbox, like Codex's own presets.
const MODES = {
  untrusted: { label: 'Ask before actions', approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  auto: { label: 'Auto (sandboxed)', approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  'read-only': { label: 'Read only', approvalPolicy: 'on-request', sandbox: 'read-only' },
  full: { label: 'Full access', approvalPolicy: 'never', sandbox: 'danger-full-access' },
};

function sandboxPolicy(sandbox) {
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false };
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

function limitLabel(mins) {
  if (!mins) return 'Limit';
  return mins % 1440 === 0 ? `${mins / 1440}-day` : `${Math.round(mins / 60)}-hour`;
}

// ---------- backend ----------

let optionsCache = null;

export default {
  id: 'codex',
  label: 'Codex',

  async available() {
    return !!findBinary();
  },

  async options() {
    if (optionsCache) return optionsCache;
    const [{ data }, { config }] = await Promise.all([rpc('model/list', {}), rpc('config/read', {})]);
    const models = data.map((m) => ({
      value: m.model,
      label: m.displayName,
      efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    }));
    const configured = config?.model && data.find((m) => m.model === config.model);
    const def = configured || data.find((m) => m.isDefault);
    optionsCache = {
      modes: Object.entries(MODES).map(([value, m]) => ({ value, label: m.label })),
      defaultMode: 'untrusted',
      models,
      defaultModel: def?.displayName || config?.model || null,
      efforts: [],
      defaultEffort: config?.model_reasoning_effort || def?.defaultReasoningEffort || null,
      images: true,
      usage: true,
    };
    return optionsCache;
  },

  async listSessions(dir) {
    const out = [];
    let cursor = null;
    do {
      const page = await rpc('thread/list', {
        cwd: dir || null,
        cursor,
        limit: 100,
        sortKey: 'updated_at',
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
      });
      for (const t of page.data) {
        out.push({
          id: t.id,
          dir: t.cwd,
          title: t.name || t.preview || 'Untitled',
          updatedAt: t.updatedAt * 1000,
          branch: t.gitInfo?.branch || null,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && out.length < 1000);
    return out;
  },

  async history(threadId, dir) {
    const list = new ItemList();
    let cursor = null;
    do {
      const page = await rpc('thread/items/list', { threadId, cursor, limit: 200, sortDirection: 'asc' });
      for (const { item } of page.data) {
        const it = threadItem(item, dir);
        if (it) list.put(it);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return list.values();
  },

  startTurn(turn) {
    const { dir, settings } = turn;
    const mode = MODES[settings.mode] || MODES.untrusted;
    let threadId = turn.sessionId;
    let turnId = null;

    const done = (async () => {
      if (!threadId) {
        const r = await rpc('thread/start', { cwd: dir, approvalPolicy: mode.approvalPolicy, sandbox: mode.sandbox, model: settings.model || null });
        threadId = r.thread.id;
        turn.bind(threadId);
      } else if (!loaded.has(threadId)) {
        await rpc('thread/resume', { threadId, cwd: dir, approvalPolicy: mode.approvalPolicy, sandbox: mode.sandbox });
      }
      loaded.add(threadId);

      const raw = new Map(); // itemId -> latest raw item, for approval prompts
      const asks = new Map(); // request id -> AbortController
      let error = null;
      let ended = null;
      let finish;
      const finished = new Promise((resolve) => (finish = resolve));

      const ask = async (requestId, request) => {
        const ctl = new AbortController();
        asks.set(requestId, ctl);
        const answer = await turn.ask(request, ctl.signal);
        asks.delete(requestId);
        return answer;
      };

      const route = {
        notify(method, p) {
          switch (method) {
            case 'item/started':
            case 'item/completed': {
              raw.set(p.item.id, p.item);
              const item = threadItem(p.item, dir);
              if (item) turn.item(item);
              break;
            }
            case 'item/agentMessage/delta':
            case 'item/plan/delta':
            case 'item/reasoning/summaryTextDelta':
              turn.delta(p.itemId, p.delta);
              break;
            case 'serverRequest/resolved':
              asks.get(p.requestId)?.abort();
              break;
            case 'error':
              if (!p.willRetry) error = p.error?.message || 'Codex error';
              break;
            case 'turn/completed':
              ended = p.turn;
              finish();
              break;
            case 'server/exited':
              error = 'The Codex app-server stopped.';
              loaded.delete(threadId);
              finish();
              break;
          }
        },

        async request(method, p, requestId) {
          if (method === 'item/commandExecution/requestApproval') {
            const command = p.commandActions?.length === 1 ? p.commandActions[0].command : p.command;
            const a = await ask(requestId, {
              kind: 'permission',
              title: 'Codex wants to run a command',
              reason: p.reason || null,
              detail: '$ ' + command,
              canAlways: true,
            });
            return { decision: a.allow ? (a.always ? 'acceptForSession' : 'accept') : 'decline' };
          }
          if (method === 'item/fileChange/requestApproval') {
            const item = raw.get(p.itemId);
            const a = await ask(requestId, {
              kind: 'permission',
              title: 'Codex wants to edit files',
              reason: p.reason || null,
              detail: item ? threadItem(item, dir).detail : p.grantRoot || '',
              canAlways: true,
            });
            return { decision: a.allow ? (a.always ? 'acceptForSession' : 'accept') : 'decline' };
          }
          if (method === 'item/permissions/requestApproval') {
            const a = await ask(requestId, {
              kind: 'permission',
              title: 'Codex wants more permissions',
              reason: p.reason || null,
              detail: JSON.stringify(p.permissions, null, 2),
              canAlways: true,
            });
            if (!a.allow) return REFUSALS[method];
            const granted = Object.fromEntries(Object.entries(p.permissions || {}).filter(([, v]) => v != null));
            return { permissions: granted, scope: a.always ? 'session' : 'turn' };
          }
          if (method === 'item/tool/requestUserInput') {
            const a = await ask(requestId, {
              kind: 'question',
              title: 'Codex has a question',
              questions: p.questions.map((q) => ({ question: q.question, header: q.header, options: q.options || [], multiple: false })),
            });
            if (!a.allow) return REFUSALS[method];
            return { answers: Object.fromEntries(p.questions.map((q, i) => [q.id, { answers: a.answers?.[i] || [] }])) };
          }
          return REFUSALS[method];
        },
      };
      routes.set(threadId, route);

      try {
        const input = turn.images.map((img) => ({ type: 'image', url: dataUrl(img) }));
        if (turn.text) input.push({ type: 'text', text: turn.text, text_elements: [] });
        const r = await rpc('turn/start', {
          threadId,
          input,
          approvalPolicy: mode.approvalPolicy,
          sandboxPolicy: sandboxPolicy(mode.sandbox),
          model: settings.model || null,
          effort: settings.effort || null,
        });
        turnId = r.turn.id;
        await finished;
      } finally {
        routes.delete(threadId);
      }
      if (ended?.status === 'interrupted') turn.item({ id: `${ended.id}:interrupted`, kind: 'notice', text: 'Interrupted' });
      if (ended?.status === 'failed') error = ended.error?.message || error || 'Turn failed';
      return { duration: ended?.durationMs ?? undefined, error: ended?.status === 'interrupted' ? null : error };
    })();

    return {
      done,
      async interrupt() {
        if (threadId && turnId) await rpc('turn/interrupt', { threadId, turnId }).catch(() => {});
      },
    };
  },

  // The ChatGPT plan's Codex limits.
  async usage() {
    const { rateLimits, rateLimitsByLimitId } = await rpc('account/rateLimits/read', {});
    const snapshots = rateLimitsByLimitId ? Object.values(rateLimitsByLimitId) : [rateLimits];
    const limits = [];
    for (const s of snapshots) {
      const prefix = s.limitName ? s.limitName + ' ' : '';
      for (const w of [s.primary, s.secondary]) {
        if (w) limits.push({ label: prefix + limitLabel(w.windowDurationMins), percent: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null });
      }
    }
    return { plan: rateLimits?.planType || null, limits };
  },
};
