// The extra folders a chat may work in besides its own. They are picked in
// the composer, or added when a message names another project and the user
// allows it (see offerFolders in lib/hub.mjs), and kept with the chat's other
// settings (lib/chat-settings.mjs). Each agent gets them in its own way:
// Claude Code as additional directories, Codex as writable roots of its
// sandbox and opencode as external-directory permissions.

import fs from 'node:fs';
import path from 'node:path';

export const MAX_FOLDERS = 10;

const isDir = (d) => {
  try {
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
};

const inside = (dir, parent) => dir === parent || dir.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// The folders directly under the project roots, as { name, dir }.
export function rootFolders(roots) {
  const out = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) out.push({ name: e.name, dir: path.join(root, e.name) });
    }
  }
  return out;
}

// A request's folder list, resolved, without repeats or the chat's own
// folder `own`: { dirs }, or { error } to show the user.
export function checkFolders(list, own) {
  if (list == null) return { dirs: [] };
  if (!Array.isArray(list) || list.length > MAX_FOLDERS || !list.every((d) => typeof d === 'string' && d.length <= 4096 && path.isAbsolute(d))) {
    return { error: `A chat can have at most ${MAX_FOLDERS} extra folders, each an absolute path.` };
  }
  const dirs = [...new Set(list.map((d) => path.resolve(d)))].filter((d) => d !== own);
  const missing = dirs.find((d) => !isDir(d));
  if (missing) return { error: `Folder not found: ${missing}. Remove it from this chat's folders.` };
  return { dirs };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The folders in `folders` that `text` names, by folder name or path, and
// that the chat can't work in yet: not inside its own folder `own` or one of
// its extra folders `dirs`. A name counts only as a whole word, so
// "mini-games" doesn't match inside "mini-games-hub", and very short names
// are ignored.
export function mentionedFolders(text, folders, own, dirs) {
  return folders
    .filter(
      (f) =>
        f.name.length >= 3 &&
        !inside(f.dir, own) &&
        !dirs.some((d) => inside(f.dir, d)) &&
        new RegExp(`(?<![\\w-])${escape(f.name)}(?![\\w-])`, 'i').test(text),
    )
    .map((f) => f.dir)
    .slice(0, Math.max(0, MAX_FOLDERS - dirs.length));
}
