// What chats remember across conversations: one file of notes, shared by
// every agent, kept in the Chat folder as MEMORY.md (lib/chat-mode.mjs).
// Every new chat gets it in its instructions. An agent adds to it by ending
// a reply with a fenced block whose language is `remember`, one note per
// line (see notesIn); the hub saves those when the turn ends and shows them
// as "Remembered". The page edits the file directly through /api/memory.

import fs from 'node:fs';
import path from 'node:path';
import { CHAT_DIR } from './chat-mode.mjs';

export const MEMORY_FILE = path.join(CHAT_DIR, 'MEMORY.md');
export const MAX_MEMORY = 16_000; // characters; the file goes into every chat's prompt
const MAX_NOTE = 400;

export function read() {
  try {
    return fs.readFileSync(MEMORY_FILE, 'utf8');
  } catch {
    return '';
  }
}

export function write(text) {
  if (typeof text !== 'string') throw new Error('Memory must be text.');
  if (text.length > MAX_MEMORY) throw new Error(`Memory can hold ${MAX_MEMORY.toLocaleString()} characters.`);
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  const tmp = MEMORY_FILE + '.tmp';
  fs.writeFileSync(tmp, text.trim() ? text.replace(/\s+$/, '') + '\n' : '');
  fs.renameSync(tmp, MEMORY_FILE);
}

// The notes in `remember` blocks of a reply, one per non-empty line.
export function notesIn(text) {
  const notes = [];
  for (const m of String(text || '').matchAll(/^[ \t]*```remember[ \t]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)) {
    for (const line of m[1].split('\n')) {
      const note = line.replace(/^\s*[-*•]\s+/, '').trim();
      if (note) notes.push(note.slice(0, MAX_NOTE));
    }
  }
  return notes;
}

// Appends the notes not already in the file. Returns the ones added.
export function remember(notes) {
  const have = new Set(read().split('\n').map((l) => l.replace(/^\s*[-*•]\s+/, '').trim()).filter(Boolean));
  const added = [];
  for (const n of notes) {
    if (have.has(n)) continue;
    have.add(n);
    added.push(n);
  }
  if (!added.length) return [];
  const text = read();
  const next = (text.trim() ? text.replace(/\s+$/, '') + '\n' : '') + added.map((n) => `- ${n}`).join('\n') + '\n';
  if (next.length > MAX_MEMORY) throw new Error('Memory is full; edit it in Chat to make room.');
  write(next);
  return added;
}
