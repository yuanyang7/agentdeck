// What stage each chat is at (designing, building, testing, shipped or just
// asking), read from what its turns actually did rather than from a model
// call: the agent-neutral items every backend's history() returns
// (./items.mjs). Within a turn:
//
//   ship    a commit, push, PR or deploy after the turn's last code edit
//   build   code edits
//   test    tests, checks or screenshots run, with no edits
//   design  plan mode, or edits only to a plan / design / spec document
//
// A turn with none of these is talk. Talk that reads like planning (design,
// plan, 方案, 可行性, "should we", …) makes the chat a design chat; other talk
// keeps the stage the chat already had. A chat that never did any of these
// is `ask`. The Chat workspace's conversations get no stage.
//
// Reading a whole transcript isn't free, so stages are worked out in the
// background, one chat at a time, and cached by the chat's updatedAt in
// ~/.agentdeck/stages.json. A listing gets whatever is cached (possibly one
// update behind) and onChange fires once fresher stages are in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), '.agentdeck', 'stages.json');
const VERSION = 1;

const EDIT_TOOL = /^(edit|write|multiedit|notebookedit|patch|apply_patch|write_file|write_to_file|replace|replace_file_content|multi_replace_file_content)$/i;
const SHELL_TOOL = /^(bash|shell|run_command|run_shell_command|execute|exec_command)$/i;
const PLAN_TOOL = /^(exitplanmode|enterplanmode|plan)$/i;
// Screenshots and browser drives check that something works.
const CHECK_TOOL = /screenshot|playwright|chrome|browser|preview_|computer/i;
const REVIEW_SKILL = /review|verify|test|qa\b/i;

const PLAN_DOC = /(^|[\/_.-])(plans?|design|specs?|rfc|proposal|adr|roadmap|backlog|todo|notes?)([\/_.-]|$)/i;
const DOC = /\.(md|mdx|markdown|txt|rst)$/i;

// Agents' own notes and memory aren't the project's code.
const AGENT_FILE = /(^|\/)\.(claude|codex|agentdeck|gemini)\//;
// Files written from the shell rather than with an edit tool.
const SHELL_EDIT = /\bsed\s+(-[a-zA-Z]*\s+)*-i\b|\bperl\s+-[a-z]*i|\bpatch\s+-p\d|\b(cat|echo|printf)\b[^|;&]*>>?\s*(?!\/(tmp|dev|private\/tmp)\/)[\w.~\/-]+\.\w+|\btee\s+(-a\s+)?(?!\/tmp\/)[\w.~\/-]+\.\w+|\.write_text\(|\bopen\([^)]*['"][wa]['"]|\bwriteFileSync\(/;

const SHIP = /\bgit\s+(-C\s+\S+\s+)?(commit|push|merge)\b|\bgh\s+(pr\s+(create|merge)|release\s+create)\b|\b(npm|pnpm|yarn)\s+publish\b|\b(vercel|netlify|wrangler|fly|firebase)\b[^|;&]*\bdeploy\b|\bvercel\s+--prod\b|\bxcrun\s+altool\b|\bfastlane\b|\bscripts\/(ship|deploy|release)\b/i;
const TEST = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck|e2e|build)\b|\bnode\s+--test\b|\b(pytest|jest|vitest|mocha|playwright|cypress|tsc|eslint|ruff|mypy)\b|\bpython3?\s+-m\s+(pytest|unittest)\b|\b(cargo|go|swift|deno|bun)\s+test\b|\bxcodebuild\b[^|;&]*\btest\b|\bgradlew?\b[^|;&]*\btest\b|\bmake\s+(test|check)\b|\bdetect\.mjs\b|\bscreencapture\b|\bagent-browser\b/i;
const DESIGN_TALK = /\b(design|redesign|plan|planning|architecture|approach|proposal|spec|feasib\w*|brainstorm|ideas?|trade-?offs?|should (we|i)|how (should|would|could|can) (we|i))\b|设计|方案|规划|计划|架构|可行|需求|思路|想法|能不能|怎么做|如何实现/i;

// The shell command a tool item ran, if it ran one.
function commandOf(item) {
  if (typeof item.detail === 'string' && item.detail.startsWith('$ ')) return item.detail.slice(2);
  return SHELL_TOOL.test(item.name || '') ? item.summary || '' : null;
}

// The files an edit touched, as far as its summary tells (Codex lists them
// comma-separated).
const editedFiles = (item) => String(item.summary || '').split(/,\s*/).filter(Boolean);

// One turn's stage, or null for talk, plus a few words on why.
function turnStage(items) {
  let lastShip = -1;
  let lastCodeEdit = -1;
  const code = new Set();
  let planDocs = 0;
  let plan = false;
  let checks = 0;
  items.forEach((item, i) => {
    if (item.kind !== 'tool' || item.status === 'error') return;
    const name = item.name || '';
    if (EDIT_TOOL.test(name)) {
      const files = editedFiles(item);
      if (files.length && files.every((f) => DOC.test(f) && PLAN_DOC.test(f))) planDocs += 1;
      else if (files.length && files.every((f) => AGENT_FILE.test(f))) return;
      else {
        lastCodeEdit = i;
        for (const f of files.length ? files : [`#${i}`]) code.add(f);
      }
      return;
    }
    if (PLAN_TOOL.test(name)) return void (plan = true);
    if (name === 'Skill' && REVIEW_SKILL.test(item.summary || '')) return void (checks += 1);
    if (CHECK_TOOL.test(name)) return void (checks += 1);
    const cmd = commandOf(item);
    if (cmd == null) return;
    if (SHIP.test(cmd)) lastShip = i;
    else if (SHELL_EDIT.test(cmd) && !AGENT_FILE.test(cmd)) {
      lastCodeEdit = i;
      code.add(`#${i}`);
    } else if (TEST.test(cmd)) checks += 1;
  });
  const files = (n) => `${n} file${n === 1 ? '' : 's'}`;
  if (lastShip >= 0 && lastShip > lastCodeEdit) return { stage: 'ship', why: 'Last turn committed, pushed or opened a PR' };
  if (code.size) return { stage: 'build', why: `Last turn edited ${files(code.size)}` };
  if (checks) return { stage: 'test', why: 'Last turn ran tests or checks without editing' };
  if (plan || planDocs) return { stage: 'design', why: plan ? 'Last turn was in plan mode' : 'Last turn wrote a plan or design doc' };
  return null;
}

// The chat's stage from its items: { stage, why }.
export function classify(items) {
  const turns = [];
  for (const item of items) {
    // Background-task reports arrive as user messages but aren't a new ask.
    if (item.kind === 'user' && !(turns.length && /^\s*<(task-notification|system-reminder)/.test(item.text || ''))) turns.push({ text: item.text || '', items: [] });
    else if (turns.length) turns.at(-1).items.push(item);
  }
  let out = null;
  let asked = false;
  for (const t of turns) {
    const s = turnStage(t.items);
    if (s) out = s;
    else if (DESIGN_TALK.test(t.text)) out = { stage: 'design', why: 'Last work was talking through a plan' };
    else if (out) out = { ...out, why: out.why.replace(/^Last turn/, 'Last work') };
    else asked = true;
  }
  if (out) return out;
  return asked ? { stage: 'ask', why: 'Questions and answers; nothing changed yet' } : { stage: null, why: '' };
}

// ---------- cache ----------

let cache = {};
try {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (raw.version === VERSION) cache = raw.chats || {};
} catch {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify({ version: VERSION, chats: cache }));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (err) {
      console.error('saving stages failed:', err.message);
    }
  }, 2000);
  saveTimer.unref?.();
}

const queue = new Map(); // key → { backend, session }
let working = false;
let changed = false;
let onChange = () => {};

export function onStagesChanged(fn) {
  onChange = fn;
}

async function drain() {
  if (working) return;
  working = true;
  try {
    while (queue.size) {
      const [key, { backend, session }] = queue.entries().next().value;
      queue.delete(key);
      if (cache[key]?.at === session.updatedAt) continue;
      try {
        const { stage, why } = classify(await backend.history(session.id, session.dir));
        if (cache[key]?.stage !== stage || cache[key]?.why !== why) changed = true;
        cache[key] = { at: session.updatedAt, stage, why };
      } catch (err) {
        // A transcript that can't be read now is tried again next listing.
        console.error(`stage of ${key} failed:`, err.message);
      }
      // Let requests in between transcripts.
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    working = false;
  }
  if (changed) {
    changed = false;
    save();
    onChange();
  }
}

// The cached { stage, stageWhy } of a listed chat, queueing it to be worked
// out again when it changed since. `session` is a listed chat: what
// listSessions() returned plus `running`.
export function stageOf(backend, session) {
  if (!session.id) return { stage: null, stageWhy: '' };
  const key = `${backend.id}:${session.id}`;
  const hit = cache[key];
  if (hit?.at !== session.updatedAt && !session.running) {
    queue.set(key, { backend, session });
    drain();
  }
  return { stage: hit?.stage || null, stageWhy: hit?.why || '' };
}

