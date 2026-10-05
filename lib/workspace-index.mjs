// A short map of the projects on this machine, given to every agent as extra
// instructions so it knows which other repos exist and where to look when a
// chat mentions one. Built from what the sidebar already knows: each folder
// under the project roots, its README's first line, when it was last active
// and the titles of its latest chats from every agent. Chats in subfolders
// (worktrees, packages, games inside a hub repo) count toward the top-level
// project; folders outside the project roots are left out.
//
// Each agent records it when a conversation starts and keeps it: Claude Code
// in its system prompt, Codex as developer instructions and opencode as an
// instruction entry on the session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const enabled = !/^(0|off|false|no)$/i.test(process.env.WORKSPACE_INDEX || '');

const MAX_PROJECTS = 60;
const MAX_CHATS = 3;
const MAX_SUBFOLDERS = 6;

const home = os.homedir();
const tilde = (p) => (p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);
const oneLine = (s, max) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

// The first line of prose in a README: past the title, badges, images and
// HTML, with link targets and emphasis dropped. Falls back to package.json's
// description.
function describe(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {}
  const readme = names.find((n) => /^readme(\.(md|markdown|txt|rst))?$/i.test(n));
  if (readme) {
    let text = '';
    try {
      const fd = fs.openSync(path.join(dir, readme), 'r');
      const buf = Buffer.alloc(8192);
      text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
      fs.closeSync(fd);
    } catch {}
    // READMEs often wrap a paragraph over several lines, so this collects
    // lines up to the end of the first paragraph. Front matter, code, HTML
    // comments and underlined (setext / reStructuredText) titles are skipped.
    let skipping = null; // the line that ends the block being skipped
    const para = [];
    text.split('\n').forEach((raw, i) => {
      if (skipping === false) return;
      const line = raw.trim();
      if (skipping) {
        if (skipping === '```' ? line.startsWith('```') : line.includes(skipping)) skipping = null;
        return;
      }
      if (i === 0 && line === '---') return void (skipping = '---');
      if (line.startsWith('```')) return void (skipping = '```');
      if (line.startsWith('<!--') && !line.includes('-->')) return void (skipping = '-->');
      if (/^([=\-~^*#])\1{2,}$/.test(line) && para.length === 1) return void (para.length = 0); // the title above
      if (!line || /^(#|<|!\[|\[!\[|\||[=\-~^*]{3,}$)/.test(line)) {
        if (para.length) skipping = false;
        return;
      }
      para.push(line.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_]{2}/g, ''));
      if (para.join(' ').length > 160) skipping = false;
    });
    if (para.length) return oneLine(para.join(' '), 160);
  }
  try {
    return oneLine(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).description, 160);
  } catch {
    return '';
  }
}

const day = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// `projects` is what listProjects() in server.mjs returns: one entry per
// folder with chats or under a root, each with `lastModified` and its newest
// chats in `recent`. Returns markdown, or '' when there's nothing to list.
export function buildIndex(projects, roots) {
  const top = new Map(); // top-level project dir -> { dir, at, chats, subfolders }
  for (const p of projects) {
    // The innermost root, when one is inside another.
    const root = roots.filter((r) => p.dir.startsWith(r.endsWith(path.sep) ? r : r + path.sep)).sort((a, b) => b.length - a.length)[0];
    if (!root) continue;
    const [name, ...rest] = path.relative(root, p.dir).split(path.sep);
    const dir = path.join(root, name);
    const t = top.get(dir) || { dir, at: 0, chats: [], subfolders: [] };
    t.at = Math.max(t.at, p.lastModified || 0);
    t.chats.push(...p.recent.filter((c) => c.id));
    // Worktrees and other dot-folders are copies of the project, not parts of it.
    if (rest.length && p.sessions && !rest.some((s) => s.startsWith('.'))) t.subfolders.push({ rel: rest.join('/'), at: p.lastModified });
    top.set(dir, t);
  }
  const list = [...top.values()]
    .filter((t) => fs.existsSync(t.dir))
    .sort((a, b) => b.at - a.at || a.dir.localeCompare(b.dir))
    .slice(0, MAX_PROJECTS);
  if (!list.length) return '';

  const lines = [
    '# Workspace index',
    '',
    `The projects on this machine (folders under ${roots.map(tilde).join(', ')}), most recently active first, as listed by agentdeck, the app running this chat. Recent chats include ones with other coding agents (Claude Code, Codex, opencode). When the user refers to another project, use this to find it and read its files there; reading outside this chat's folder may ask the user for permission. The list was made when this chat started, so it may be out of date.`,
    '',
  ];
  for (const t of list) {
    const about = describe(t.dir);
    lines.push(`- ${path.basename(t.dir)}: ${tilde(t.dir)}${t.at ? `, last active ${day(t.at)}` : ', no chats'}`);
    if (about) lines.push(`  ${about}`);
    const titles = [...new Set(t.chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((c) => oneLine(c.title, 80)))];
    if (titles.length) lines.push(`  Recent chats: ${titles.slice(0, MAX_CHATS).map((s) => `"${s}"`).join('; ')}`);
    const subs = t.subfolders.sort((a, b) => b.at - a.at).slice(0, MAX_SUBFOLDERS).map((s) => s.rel);
    if (subs.length) lines.push(`  Subfolders with chats: ${subs.join(', ')}`);
  }
  return lines.join('\n') + '\n';
}

// The index, or null when turned off or nothing could be listed.
export async function workspaceIndex(listProjects, roots) {
  if (!enabled) return null;
  return buildIndex(await listProjects(), roots) || null;
}
