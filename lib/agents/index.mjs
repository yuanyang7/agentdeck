// The coding agents this app can drive. Each backend adapts one agent to the
// same shape, so the server and the browser never deal with an agent's own
// message format:
//
//   id, label
//   available()             installed and usable on this machine
//   options()               what the composer offers:
//                             { modes, defaultMode, models, defaultModel,
//                               efforts, defaultEffort, images, usage }
//                           modes/models/efforts are [{ value, label }]; a model
//                           may list its own `efforts` (value strings)
//   listSessions(dir?)      [{ id, dir, title, updatedAt, branch }]; every
//                           project's sessions when dir is omitted
//   history(id, dir)        the conversation as items (see ../items.mjs)
//   startTurn(turn)         runs one turn; returns
//                             { done: Promise<{ cost?, duration?, error? }>,
//                               interrupt(), setMode?(mode) }
//                           and reports through turn.bind / item / delta / ask
//                           (see ../hub.mjs)
//   usage?()                plan limits, for agents that have them:
//                             { plan, limits: [{ label, percent, resetsAt }] }

import claude from './claude.mjs';
import codex from './codex.mjs';
import opencode from './opencode.mjs';

const all = [claude, codex, opencode];

export const backends = new Map(all.map((b) => [b.id, b]));

let availableCache = null;

export async function availableBackends() {
  availableCache ||= Promise.all(all.map(async (b) => ((await b.available().catch(() => false)) ? b : null))).then(
    (list) => list.filter(Boolean),
  );
  return availableCache;
}
