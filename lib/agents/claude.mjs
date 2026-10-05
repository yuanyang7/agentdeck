// Claude Code, through the Claude Agent SDK. Conversations are the regular
// sessions in ~/.claude/projects, so they also open in the terminal and the
// desktop app.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { ItemList, dataUrl, toolItem, toolDetail, clip } from '../items.mjs';

// Temporary per-session folders made by the Claude desktop app.
const HIDDEN_DIR = /\/Library\/Application Support\/Claude\/|^\/private\/tmp\/|^\/tmp\//;

const MODES = [
  { value: 'default', label: 'Ask before actions' },
  { value: 'acceptEdits', label: 'Auto-accept edits' },
  { value: 'plan', label: 'Plan mode' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
];

const EFFORTS = [
  { value: 'low', label: 'Low effort' },
  { value: 'medium', label: 'Medium effort' },
  { value: 'high', label: 'High effort' },
  { value: 'xhigh', label: 'Extra-high effort' },
  { value: 'max', label: 'Max effort' },
];

// Claude Code appends bookkeeping lines (last-prompt, cost-state, mode, …) to
// old transcripts when it reopens them, so a file's mtime says little about
// when the chat last moved. Its last timestamped entry does. Cached by mtime.
const activityCache = new Map();

function projectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

function transcriptFiles() {
  const files = new Map();
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir());
  } catch {}
  for (const d of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(projectsDir(), d));
    } catch {}
    for (const n of names) if (n.endsWith('.jsonl')) files.set(n.slice(0, -6), path.join(projectsDir(), d, n));
  }
  return files;
}

function lastActivity(file, mtime) {
  const hit = activityCache.get(file);
  if (hit?.mtime === mtime) return hit.at;
  let at = null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    for (let len = 64 * 1024; !at; len *= 4) {
      const start = Math.max(0, size - len);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      for (let i = lines.length - 1; i >= 0 && !at; i--) {
        if (!lines[i].includes('"timestamp"')) continue;
        try {
          const t = Date.parse(JSON.parse(lines[i]).timestamp);
          if (t) at = t;
        } catch {}
      }
      if (start === 0) break;
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  activityCache.set(file, { mtime, at });
  return at;
}

const LIMIT_LABELS = {
  five_hour: '5-hour',
  seven_day: '7-day',
  seven_day_opus: '7-day Opus',
  seven_day_sonnet: '7-day Sonnet',
};

// A query with no prompt yet, for asking the CLI about models or usage
// without running a turn.
async function withIdleQuery(fn) {
  const idle = (async function* () {
    await new Promise(() => {});
  })();
  const q = query({ prompt: idle, options: { cwd: os.homedir() } });
  try {
    return await fn(q);
  } finally {
    q.close();
  }
}

// ---------- transcript → items ----------

function imageSrc(b) {
  const s = b.source || {};
  return s.type === 'base64' ? `data:${s.media_type};base64,${s.data}` : s.type === 'url' ? s.url : null;
}

function stripMeta(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : JSON.stringify(c))).join('\n');
  }
  return JSON.stringify(content, null, 2);
}

// One SDK or transcript message → items. Tool results come back inside user
// messages and are merged into the tool call's item by its id.
function messageItems(m, dir) {
  if (m.parent_tool_use_id) return []; // subagent internals
  const msg = m.message || {};
  const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content || [];
  const out = [];

  if (m.type === 'user') {
    // Images and text from one prompt share a bubble.
    const images = content.filter((b) => b.type === 'image').map(imageSrc).filter(Boolean);
    const texts = [];
    for (const b of content) {
      if (b.type === 'tool_result') {
        // Images a tool returned, e.g. Read on a PNG or a screenshot tool.
        const shown = Array.isArray(b.content) ? b.content.filter((c) => c.type === 'image').map(imageSrc).filter(Boolean) : [];
        out.push({ id: b.tool_use_id, kind: 'tool', status: b.is_error ? 'error' : 'done', output: clip(resultText(b.content)), images: shown });
      } else if (b.type === 'text') {
        const t = stripMeta(b.text);
        if (t.startsWith('[Request interrupted')) out.push({ id: m.uuid, kind: 'notice', text: 'Interrupted' });
        else if (t && !/^<(command-|local-command-)/.test(t)) texts.push(t);
      }
    }
    if (texts.length || images.length) out.push({ id: m.uuid, kind: 'user', text: texts.join('\n\n'), images });
    return out;
  }

  if (m.type === 'assistant') {
    content.forEach((b, i) => {
      const id = `${m.uuid}:${i}`;
      if (b.type === 'text' && b.text) out.push({ id, kind: 'text', text: b.text });
      else if (b.type === 'thinking' && b.thinking) out.push({ id, kind: 'thinking', text: b.thinking });
      else if (b.type === 'tool_use') out.push({ ...toolItem(b.id, b.name, b.input, dir), status: 'running' });
    });
  }
  return out;
}

// ---------- permissions ----------

function permissionRequest(toolName, input, opts) {
  if (toolName === 'AskUserQuestion' && Array.isArray(input?.questions)) {
    return {
      kind: 'question',
      title: 'Claude has a question',
      questions: input.questions.map((q) => ({
        question: q.question,
        header: q.header,
        options: q.options || [],
        multiple: !!q.multiSelect,
      })),
    };
  }
  const plan = toolName === 'ExitPlanMode';
  return {
    kind: 'permission',
    title: opts.title || (plan ? 'Claude is ready to leave plan mode' : `Claude wants to use ${toolName}`),
    reason: opts.decisionReason || null,
    detail: plan ? input.plan : toolDetail(input),
    markdown: plan,
    canAlways: Array.isArray(opts.suggestions) && opts.suggestions.length > 0,
  };
}

function permissionResult(toolName, input, opts, answer) {
  if (!answer.allow) return { behavior: 'deny', message: answer.message || 'The user denied this action.' };
  const result = { behavior: 'allow', updatedInput: input };
  if (toolName === 'AskUserQuestion' && answer.answers) {
    const answers = Object.fromEntries(input.questions.map((q, i) => [q.question, (answer.answers[i] || []).join(', ')]));
    result.updatedInput = { ...input, answers };
  }
  if (answer.always && opts.suggestions?.length) result.updatedPermissions = opts.suggestions;
  return result;
}

// ---------- backend ----------

let optionsCache = null;
let usageCache = { at: 0, data: null };

export default {
  id: 'claude',
  label: 'Claude Code',

  async available() {
    return true;
  },

  // What "Default model" / "Default effort" resolve to comes from the user's
  // Claude Code settings. Project-level settings overrides aren't considered.
  async options() {
    if (optionsCache) return optionsCache;
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    } catch {}
    const models = await withIdleQuery((q) => q.supportedModels());
    const wanted = settings.model || 'default';
    const hit = models.find((m) => m.value === wanted || m.resolvedModel === wanted) || models.find((m) => m.value === 'default');
    const resolved = hit?.resolvedModel || null;
    const named = models.find((m) => m.resolvedModel === resolved && m.value !== 'default') || hit;
    const perModel = Object.entries(settings.modelSettings || {}).find(([k]) => resolved && resolved.startsWith(k));
    optionsCache = {
      modes: MODES,
      defaultMode: 'default',
      models: models.filter((m) => m.value !== 'default').map((m) => ({ value: m.value, label: m.displayName, resolved: m.resolvedModel })),
      defaultModel: named?.displayName || null,
      efforts: EFFORTS,
      defaultEffort: perModel?.[1]?.effortLevel || settings.effortLevel || null,
      images: true,
      usage: true,
    };
    return optionsCache;
  },

  async listSessions(dir) {
    const sessions = await listSessions(dir ? { dir } : undefined);
    const files = transcriptFiles();
    return sessions
      .filter((s) => (dir ? !s.cwd || s.cwd === dir : s.cwd && !HIDDEN_DIR.test(s.cwd)))
      .map((s) => ({
        id: s.sessionId,
        dir: s.cwd || dir,
        title: s.customTitle || s.summary || s.firstPrompt || 'Untitled',
        updatedAt: (files.has(s.sessionId) && lastActivity(files.get(s.sessionId), s.lastModified)) || s.lastModified,
        branch: s.gitBranch || null,
      }));
  },

  async history(sessionId, dir) {
    const list = new ItemList();
    for (const m of await getSessionMessages(sessionId, { dir })) {
      for (const item of messageItems(m, dir)) list.put(item);
    }
    return list.values();
  },

  // The model the chat's last reply came from and the mode of its last
  // prompt. Effort isn't in transcripts. The SDK's messages leave out the
  // mode, so this reads the transcript file itself.
  async lastSettings(sessionId) {
    const projects = projectsDir();
    const file = fs.readdirSync(projects).map((d) => path.join(projects, d, `${sessionId}.jsonl`)).find((f) => fs.existsSync(f));
    if (!file) return null;
    let used = null;
    let mode = null;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && !(used && mode); i--) {
      if (!lines[i].includes('"permissionMode"') && !lines[i].includes('"model"')) continue;
      try {
        const e = JSON.parse(lines[i]);
        if (!mode && e.type === 'user' && e.permissionMode) mode = e.permissionMode;
        if (!used && e.type === 'assistant' && /^claude-/.test(e.message?.model || '')) used = e.message.model;
      } catch {}
    }
    const { models } = await this.options();
    const model = (used && models.find((m) => m.resolved === used)?.value) || null;
    return model || mode ? { model, effort: null, mode } : null;
  },

  startTurn(turn) {
    const { mode, model, effort } = turn.settings;
    let q = null;

    const done = (async () => {
      // Sent with our own uuid so the transcript entry written for it has the
      // same id as the item shown live, and the two de-duplicate.
      const promptId = crypto.randomUUID();
      turn.item({ id: promptId, kind: 'user', text: turn.text, images: turn.images.map(dataUrl) });
      const content = turn.images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      }));
      if (turn.text) content.push({ type: 'text', text: turn.text });
      const prompt = (async function* () {
        yield { type: 'user', uuid: promptId, message: { role: 'user', content }, parent_tool_use_id: null, session_id: turn.sessionId || '' };
      })();

      const options = {
        cwd: turn.dir,
        permissionMode: mode,
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        canUseTool: async (toolName, input, opts) =>
          permissionResult(toolName, input, opts, await turn.ask(permissionRequest(toolName, input, opts), opts.signal)),
      };
      if (turn.sessionId) options.resume = turn.sessionId;
      if (model) options.model = model;
      if (effort) options.effort = effort;
      if (mode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;

      // Streamed text goes into a draft item that the finished text block replaces.
      let draft = null;
      let drafts = 0;
      let result = {};
      q = query({ prompt, options });
      for await (const msg of q) {
        if (msg.session_id) turn.bind(msg.session_id);
        if (msg.type === 'stream_event') {
          const ev = msg.event;
          if (!msg.parent_tool_use_id && ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            draft ||= `${promptId}:draft-${++drafts}`;
            turn.delta(draft, ev.delta.text);
          }
        } else if (msg.type === 'assistant' || msg.type === 'user') {
          for (const item of messageItems(msg, turn.dir)) {
            if (item.kind === 'text' && draft) {
              item.replaces = draft;
              draft = null;
            }
            turn.item(item);
          }
        } else if (msg.type === 'result') {
          result = {
            cost: msg.total_cost_usd,
            duration: msg.duration_ms,
            error: msg.subtype === 'success' ? null : (msg.errors || []).join('\n') || msg.subtype,
          };
        }
      }
      return result;
    })();

    return {
      done,
      async interrupt() {
        try {
          await q?.interrupt();
        } catch {
          q?.close();
        }
      },
      async setMode(m) {
        await q?.setPermissionMode(m).catch(() => {});
      },
    };
  },

  // Plan limits, as { plan, limits: [{ label, percent, resetsAt }] }. Cached
  // briefly so repeatedly opening the panel doesn't spawn processes.
  async usage() {
    if (usageCache.data && Date.now() - usageCache.at < 30_000) return usageCache.data;
    const u = await withIdleQuery((q) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
    const limits = [];
    const rl = u.rate_limits;
    if (u.rate_limits_available && rl) {
      for (const [k, label] of Object.entries(LIMIT_LABELS)) {
        if (rl[k]?.utilization != null) limits.push({ label, percent: rl[k].utilization, resetsAt: rl[k].resets_at });
      }
      for (const m of rl.model_scoped || []) {
        if (m.utilization != null) limits.push({ label: '7-day ' + m.display_name, percent: m.utilization, resetsAt: m.resets_at });
      }
      const x = rl.extra_usage;
      if (x?.is_enabled && x.utilization != null) limits.push({ label: 'Extra usage', percent: x.utilization, resetsAt: null });
    }
    const data = { plan: u.subscription_type || null, limits };
    usageCache = { at: Date.now(), data };
    return data;
  },
};
