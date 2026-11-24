// "Just ask": a task typed with no project picked. A short, cheap Claude call
// (Sonnet by default) reads the workspace index, the same map of the projects
// every new chat gets, and names the project the task is about. The page then
// opens a new chat there and sends the task as typed. When the task is to
// start something no project covers, the call also suggests a folder name,
// and the page offers to create that project under the first project root.
//
// The call runs with no tools, one turn and no saved session, so it never
// shows up in the sidebar or in `claude --resume`. `ROUTE_MODEL` picks the
// model; `sonnet` is the alias Claude Code resolves to the current Sonnet.

import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildIndex } from './workspace-index.mjs';

export const MODEL = process.env.ROUTE_MODEL || 'sonnet';
const MAX_TEXT = 4000;

const SCHEMA = {
  type: 'object',
  properties: {
    dir: { type: ['string', 'null'], description: 'The path of the project the task is about, exactly as listed, or null when none fits.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string', description: 'One short sentence: why this project.' },
    newProject: { type: ['string', 'null'], description: 'When dir is null and the task is to build or start something no listed project covers: a short lowercase kebab-case folder name for it. Otherwise null.' },
  },
  required: ['dir', 'confidence', 'reason', 'newProject'],
  additionalProperties: false,
};

const SYSTEM = `You route tasks to projects. Below is a list of the projects on this machine, with what each is about and its recent chats. Given a task, answer which project it belongs to.

Rules:
- Answer with the project's path exactly as listed. Never make one up.
- A task names a project when it uses the project's folder name, its name in another spelling or language, or what it plainly does (its description, its recent chats).
- A task about agentdeck itself (this chat page, its sidebar, composer, devices, agents) belongs to the agentdeck project.
- Prefer a top-level project over its subfolders.
- Be honest about confidence: "high" when the task names the project or there is one clear fit; "medium" when it fits one project better than the rest; "low" when you are guessing.
- When the task is not about any listed project, or it asks to create a new project, answer null.
- With a null answer, set newProject when the task is to build, make or start something (an app, a tool, a game, a site, a script, a library) that no listed project covers: a folder name of one to four lowercase words joined by hyphens, in English, naming what it is (e.g. "pomodoro-timer"), not taken by a listed project. Use the name the task gives, if any. For a question, a chat or anything else that isn't new work, newProject is null.
- Do not do the task. Only classify it.`;

const tilde = (p) => {
  const home = os.homedir();
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
};

// `projects` is what listProjects() returns; the index lists the top-level
// ones under the roots and the answer is one of those. Resolves to
// { dir, name, confidence, reason, newProject } with dir null when nothing
// fits, and newProject a suggested folder name (or null) then; throws when
// the call itself fails.
export async function routeTask(text, projects, roots) {
  const index = buildIndex(projects, roots);
  if (!index) throw new Error('No projects to choose from.');
  const task = String(text).slice(0, MAX_TEXT);
  const listed = new Map(projects.filter((p) => roots.includes(path.dirname(p.dir))).map((p) => [p.dir, p]));

  const q = query({
    prompt: `Task:\n\n${task}`,
    options: {
      cwd: os.homedir(),
      model: MODEL,
      systemPrompt: `${SYSTEM}\n\n${index}`,
      tools: [],
      maxTurns: 1,
      persistSession: false,
      settingSources: [],
      permissionMode: 'default',
      outputFormat: { type: 'json_schema', schema: SCHEMA },
    },
  });
  let out = null;
  let error = null;
  try {
    for await (const m of q) {
      if (m.type !== 'result') continue;
      if (m.is_error || m.subtype !== 'success') error = m.errors?.join('; ') || m.result || m.subtype;
      out = m.structured_output;
    }
  } finally {
    q.close();
  }
  if (!out || typeof out !== 'object') throw new Error(error ? `Routing failed: ${error}` : 'Routing gave no answer.');

  // The answer must be a project the page lists; a path in `~` form, or a
  // folder inside a project, still counts for that project.
  let dir = typeof out.dir === 'string' ? tilde(out.dir.trim()) : null;
  if (dir && !listed.has(dir)) {
    const parent = [...listed.keys()].filter((d) => dir.startsWith(d + path.sep)).sort((a, b) => a.length - b.length)[0];
    dir = parent || null;
  }
  const confidence = ['high', 'medium', 'low'].includes(out.confidence) ? out.confidence : 'low';
  const newProject = dir ? null : projectName(out.newProject);
  return { dir, name: dir ? listed.get(dir).name : null, confidence, reason: String(out.reason || '').slice(0, 300), newProject };
}

// A folder name for a new project: letters, digits, dots, dashes and
// underscores, not starting with a dot or a dash. Spaces become dashes. Null
// when nothing usable is left.
export function projectName(name) {
  if (typeof name !== 'string') return null;
  const s = name.trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._-]/gu, '').replace(/^[.-]+/, '').slice(0, 64);
  return s || null;
}
