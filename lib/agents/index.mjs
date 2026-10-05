// The coding agents this app can drive. Each backend adapts one agent to the
// same shape, so the server and the browser never deal with an agent's own
// message format:
//
//   id, label
//   available()             installed and usable on this machine
//   options()               what the composer offers:
//                             { modes, defaultMode, models, defaultModel,
//                               efforts, defaultEffort, images, usage, fork }
//                           modes/models/efforts are [{ value, label }]; a model
//                           may list its own `efforts` (value strings), and
//                           a mode that already allows everything is marked
//                           `unrestricted`
//   listSessions(dir?)      [{ id, dir, title, updatedAt, branch }]; every
//                           project's sessions when dir is omitted
//   history(id, dir)        the conversation as items (see ../items.mjs)
//   startTurn(turn)         runs one turn; returns
//                             { done: Promise<{ cost?, duration?, error? }>,
//                               interrupt(), setMode?(mode) }
//                           and reports through turn.bind / item / delta / ask
//                           (see ../hub.mjs); turn.instructions is extra
//                           text for the agent's instructions (the workspace
//                           index, see ../workspace-index.mjs) or null, and
//                           turn.settings is { mode, model, effort, dirs },
//                           `dirs` being folders the chat may work in
//                           besides turn.dir (see ../folders.mjs)
//   lastSettings?(id, dir)  { model, effort, mode } (picker values, any may
//                           be null) a chat last used, for chats this app
//                           hasn't recorded
//   fork?(id, dir, itemId)  copies the conversation into a new session,
//                           keeping everything through the end of the turn
//                           the user message `itemId` started; returns
//                             { sessionId, whole }
//                           `whole` when the agent could only copy the whole
//                           conversation instead of stopping there
//   usage?()                plan limits, for agents that have them:
//                             { plan, limits: [{ label, percent, resetsAt }] }
//   commands?(dir)          the skills and slash commands a chat in `dir` can
//                           use, for the composer's `/` menu:
//                             [{ name, description, hint, aliases? }]
//                           `hint` describes the arguments. startTurn runs a
//                           message that starts with `/name` as that one
//                           (see ../commands.mjs)

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
