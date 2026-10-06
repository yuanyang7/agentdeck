// Codex, through `codex app-server` (JSON-RPC over stdio), using the Codex
// login on this machine (a ChatGPT plan or an API key). The first time it's
// needed this starts one app-server and routes its notifications and
// requests to running turns by thread id. Conversations are Codex's own
// threads in ~/.codex, so they also open in the Codex app and CLI.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { ItemList, toolDetail, toolSummary, clip, dataUrl, fileUrl, imageUrl } from '../items.mjs';
import { slashCommand, cachedByDir } from '../commands.mjs';

// The Codex app updates its own copy of the CLI, which is often newer than
// one on PATH, so the newest of the candidates wins.
const CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
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
    if (result === undefined) write({ id: msg.id, error: { code: -32601, message: `${msg.method} is not supported by agentdeck` } });
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
      child = null;
      server = null;
      for (const route of routes.values()) route.notify('server/exited', {});
    });
    send('initialize', { clientInfo: { name: 'agentdeck', title: 'agentdeck', version: '1.0.0' }, capabilities: null })
      .then(() => {
        write({ method: 'initialized' });
        resolve();
      }, reject);
  });
  server.catch(() => (server = null));
  return server;
}

process.on('exit', () => child?.kill());

// Chats moved to another folder (see move) are forks, which Codex lists only
// once a message is sent in them; until then agentdeck lists them itself.
// Shape: { threadId: folder }.
const UNLISTED_FILE = path.join(os.homedir(), '.agentdeck', 'codex-moved.json');
const unlisted = new Map();
try {
  for (const [id, dir] of Object.entries(JSON.parse(fs.readFileSync(UNLISTED_FILE, 'utf8')))) unlisted.set(id, dir);
} catch {}

function saveUnlisted() {
  fs.mkdirSync(path.dirname(UNLISTED_FILE), { recursive: true });
  fs.writeFileSync(UNLISTED_FILE + '.tmp', JSON.stringify(Object.fromEntries(unlisted), null, 2));
  fs.renameSync(UNLISTED_FILE + '.tmp', UNLISTED_FILE);
}

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
  return content.map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' || c?.type === 'audio' ? `[${c.type}]` : JSON.stringify(c))).join('\n');
}

// Pictures and sound clips an MCP tool returned; the page gives audio a player.
const mcpImages = (item) =>
  (item.result?.content || [])
    .filter((c) => (c?.type === 'image' || c?.type === 'audio') && c.data)
    .map((c) => dataUrl({ mediaType: c.mimeType || (c.type === 'audio' ? 'audio/wav' : 'image/png'), data: c.data }));

// `result` is the generated picture, normally bare base64 PNG.
function generatedImage(item) {
  if (item.result) return item.result.startsWith('data:') ? item.result : dataUrl({ mediaType: 'image/png', data: item.result });
  return item.savedPath ? fileUrl(item.savedPath) : null;
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
        images: mcpImages(item),
      });
    case 'dynamicToolCall':
      return tool(item.id, item.tool, item.arguments, dir, {
        status: item.success === false ? 'error' : STATUS[item.status] || 'running',
        output: clip((item.contentItems || []).map((c) => c.text ?? (c.imageUrl ? '[image]' : JSON.stringify(c))).join('\n')),
        images: (item.contentItems || []).filter((c) => c.imageUrl).map((c) => imageUrl(c.imageUrl)),
      });
    case 'imageView':
      return tool(item.id, 'View image', { path: item.path }, dir, { status: 'done', images: [fileUrl(item.path)] });
    case 'imageGeneration': {
      const image = generatedImage(item);
      return {
        id: item.id,
        kind: 'tool',
        name: 'Generate image',
        summary: (item.revisedPrompt || '').split('\n')[0].slice(0, 160),
        detail: [item.revisedPrompt, item.savedPath].filter(Boolean).join('\n\n'),
        status: item.status === 'failed' ? 'error' : image ? 'done' : 'running',
        images: image ? [image] : [],
      };
    }
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

// The chat's extra folders (lib/folders.mjs) become writable roots next to
// the project; reading is allowed everywhere already.
function sandboxPolicy(sandbox, dirs = []) {
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false };
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  return { type: 'workspaceWrite', writableRoots: dirs, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

function neverRequestsApproval(policy, kind) {
  if (policy === 'never') return true;
  if (!policy?.granular) return false;
  if (kind === 'permissions') return policy.granular.request_permissions === false;
  if (kind === 'command') {
    // Codex uses the command callback for both sandbox escalations and
    // exec-policy rule prompts. Only suppress it when neither category asks.
    return policy.granular.sandbox_approval === false && policy.granular.rules === false;
  }
  return policy.granular.sandbox_approval === false;
}

async function resumeThread(params) {
  try {
    return await rpc('thread/resume', { ...params, excludeTurns: true });
  } catch (err) {
    if (!/excludeTurns/i.test(String(err?.message || err))) throw err;
    return rpc('thread/resume', params);
  }
}

function hasFullAccess(settings) {
  const sandbox = settings?.sandbox || settings?.sandboxPolicy;
  const profile = settings?.activePermissionProfile;
  return settings?.approvalPolicy === 'never'
    && sandbox?.type === 'dangerFullAccess'
    && (!profile || profile.id === ':danger-full-access');
}

function limitLabel(mins) {
  if (!mins) return 'Limit';
  return mins % 1440 === 0 ? `${mins / 1440}-day` : `${Math.round(mins / 60)}-hour`;
}

// The workspace index goes in as developer instructions, after any the user
// configured for the project or globally, since the parameter replaces
// those. Codex records them when a thread starts and ignores them on resume.
async function developerInstructions(extra, cwd) {
  if (!extra) return null;
  const configured = await rpc('config/read', { cwd }).then((r) => r.config?.developer_instructions, () => null);
  return [configured, extra].filter(Boolean).join('\n\n');
}

// ---------- skills ----------

// Codex has skills but no slash commands of its own (those are its TUI's).
const listSkills = cachedByDir(async (dir) => {
  const { data } = await rpc('skills/list', { cwds: [dir] });
  return (data?.[0]?.skills || []).filter((s) => s.enabled);
});

// A message starting with `/name` for one of the folder's skills is sent the
// way Codex's own apps send `$name`: that text, plus the skill as an input
// item, which loads its instructions into the turn.
async function skillInput(text, dir) {
  const asked = slashCommand(text);
  const skill = asked && (await listSkills(dir).catch(() => [])).find((s) => s.name === asked.name);
  if (!skill) return { text, skills: [] };
  return { text: text.replace(/^\s*\//, '$'), skills: [{ type: 'skill', name: skill.name, path: skill.path }] };
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
      modes: Object.entries(MODES).map(([value, m]) => ({ value, label: m.label, ...(m.sandbox === 'danger-full-access' && { unrestricted: true }) })),
      defaultMode: 'untrusted',
      models,
      defaultModel: def?.displayName || config?.model || null,
      efforts: [],
      defaultEffort: config?.model_reasoning_effort || def?.defaultReasoningEffort || null,
      images: true,
      usage: true,
      fork: true,
    };
    return optionsCache;
  },

  async commands(dir) {
    return (await listSkills(dir)).map((s) => ({
      name: s.name,
      description: s.interface?.shortDescription || s.shortDescription || s.description || '',
      hint: '',
    }));
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
    // Moved chats Codex doesn't list yet (see move).
    for (const [id, cwd] of unlisted) {
      if (out.some((t) => t.id === id)) {
        unlisted.delete(id);
        saveUnlisted();
      } else if (!dir || dir === cwd) {
        const t = (await rpc('thread/read', { threadId: id, includeTurns: false }).catch(() => null))?.thread;
        if (t) out.push({ id, dir: cwd, title: t.name || t.preview || 'Untitled', updatedAt: t.updatedAt * 1000, branch: t.gitInfo?.branch || null });
      }
    }
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

  // The model, effort and mode of the thread's last turn. The app-server
  // doesn't report them without resuming the thread, so they're read from the
  // turn_context entries of its rollout file.
  async lastSettings(threadId) {
    const { thread } = await rpc('thread/read', { threadId, includeTurns: false });
    if (!thread?.path) return null;
    const lines = fs.readFileSync(thread.path, 'utf8').split('\n');
    let ctx = null;
    for (let i = lines.length - 1; i >= 0 && !ctx; i--) {
      if (!lines[i].includes('"turn_context"')) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'turn_context') ctx = entry.payload;
      } catch {}
    }
    if (!ctx) return null;
    const model = (await this.options()).models.find((m) => m.value === ctx.model);
    const effort = ctx.effort || ctx.reasoning_effort || null;
    const mode = Object.keys(MODES).find(
      (k) => MODES[k].approvalPolicy === ctx.approval_policy && MODES[k].sandbox === ctx.sandbox_policy?.type,
    );
    return {
      model: model?.value || null,
      effort: model?.efforts.includes(effort) ? effort : null,
      mode: mode || null,
    };
  },

  // Copies the thread into a new one. Codex forks at a whole turn
  // (`lastTurnId`), so the turn the message `itemId` belongs to is the last
  // one kept. Older app-servers take no fork point: then the whole thread is
  // copied, which `whole` reports so the page can say so.
  async fork(threadId, dir, itemId) {
    let lastTurnId = null;
    let found = false;
    let cursor = null;
    do {
      const page = await rpc('thread/items/list', { threadId, cursor, limit: 200, sortDirection: 'asc' });
      for (const entry of page.data) {
        if (entry.item?.id !== itemId) continue;
        found = true;
        lastTurnId = entry.turnId || entry.item.turnId || null;
      }
      cursor = page.nextCursor;
    } while (cursor && !found);
    if (!found) throw new Error('That message is no longer in this conversation.');
    if (lastTurnId) {
      try {
        const r = await rpc('thread/fork', { threadId, lastTurnId });
        return { sessionId: r.thread.id, whole: false };
      } catch {} // no fork point on this app-server; copy it all
    }
    const r = await rpc('thread/fork', { threadId });
    return { sessionId: r.thread.id, whole: true };
  },

  // Codex indexes a thread's rollout file by byte offset, so the file can't
  // be edited to name another folder. Instead the chat is forked with the new
  // folder, which keeps its whole history, and the original is archived (the
  // Codex app can still bring it back). The fork has a new id.
  async move(threadId, from, to) {
    const { thread } = await rpc('thread/read', { threadId, includeTurns: false });
    const r = await rpc('thread/fork', { threadId, cwd: to, excludeTurns: true });
    const id = r.thread.id;
    const title = thread?.name || thread?.preview;
    if (!r.thread.name && title) await rpc('thread/name/set', { threadId: id, name: title.slice(0, 120) }).catch(() => {});
    await rpc('thread/archive', { threadId });
    unlisted.set(id, to);
    saveUnlisted();
    return { sessionId: id };
  },

  startTurn(turn) {
    const { dir, settings } = turn;
    const modeName = MODES[settings.mode] ? settings.mode : 'untrusted';
    const mode = MODES[modeName];
    let threadId = turn.sessionId;
    let effectiveSettings;
    let turnId = null;

    const done = (async () => {
      if (!threadId) {
        const r = await rpc('thread/start', {
          cwd: dir,
          approvalPolicy: mode.approvalPolicy,
          sandbox: mode.sandbox,
          model: settings.model || null,
          developerInstructions: await developerInstructions(turn.instructions, dir),
        });
        threadId = r.thread.id;
        effectiveSettings = r;
        turn.bind(threadId);
      } else {
        // Refresh the app-server's effective policy on every turn. Managed
        // profiles can narrow the requested mode, and loaded threads can
        // change mode between turns.
        effectiveSettings = await resumeThread({ threadId, cwd: dir, approvalPolicy: mode.approvalPolicy, sandbox: mode.sandbox });
      }
      const approvalPolicy = effectiveSettings?.approvalPolicy;
      const fullAccess = modeName === 'full' && hasFullAccess(effectiveSettings);

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
              finish();
              break;
          }
        },

        async request(method, p, requestId) {
          if (method === 'item/commandExecution/requestApproval') {
            if (neverRequestsApproval(approvalPolicy, 'command')) {
              return { decision: fullAccess ? 'accept' : 'decline' };
            }
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
            if (neverRequestsApproval(approvalPolicy, 'sandbox')) {
              return { decision: fullAccess ? 'accept' : 'decline' };
            }
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
            if (neverRequestsApproval(approvalPolicy, 'permissions')) return REFUSALS[method];
            const granted = Object.fromEntries(Object.entries(p.permissions || {}).filter(([, v]) => v != null));
            const a = await ask(requestId, {
              kind: 'permission',
              title: 'Codex wants more permissions',
              reason: p.reason || null,
              detail: JSON.stringify(p.permissions, null, 2),
              canAlways: true,
            });
            if (!a.allow) return REFUSALS[method];
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
        const { text, skills } = await skillInput(turn.text, dir);
        const input = turn.images.map((img) => ({ type: 'image', url: dataUrl(img) }));
        if (text) input.push({ type: 'text', text, text_elements: [] });
        input.push(...skills);
        const r = await rpc('turn/start', {
          threadId,
          input,
          approvalPolicy: mode.approvalPolicy,
          sandboxPolicy: sandboxPolicy(mode.sandbox, settings.dirs),
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
