// Skills and slash commands. Typing `/` in the composer lists the ones the
// chat's agent offers in its folder (each backend's `commands(dir)`, see
// lib/agents/index.mjs), and a message that starts with `/name` runs one.
// Claude Code reads `/name` itself; Codex and opencode take skills and
// commands as separate parts of a turn, so their backends look the name up
// and send it their own way.

// `/name rest of the message` → { name, args }, or null for any other message.
export function slashCommand(text) {
  const m = /^\/([\w.:@-]+)(?:\s+([\s\S]*))?$/.exec((text || '').trim());
  return m ? { name: m[1], args: (m[2] || '').trim() } : null;
}

const FRESH = 60_000;

// Wraps `list(dir)` so each folder's list is fetched at most once a minute.
// Skills added on disk show up after that. A failed fetch is not kept.
export function cachedByDir(list) {
  const cache = new Map(); // dir -> { at, promise }
  return (dir) => {
    const hit = cache.get(dir);
    if (hit && Date.now() - hit.at < FRESH) return hit.promise;
    const promise = list(dir);
    cache.set(dir, { at: Date.now(), promise });
    promise.catch(() => cache.get(dir)?.promise === promise && cache.delete(dir));
    return promise;
  };
}
