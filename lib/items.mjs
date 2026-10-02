// The agent-neutral transcript the browser renders. Each backend turns its
// own message format into a list of items:
//
//   { id, kind: 'user',     text, images: [url] }
//   { id, kind: 'text',     text }              assistant reply (markdown)
//   { id, kind: 'thinking', text }
//   { id, kind: 'tool',     name, summary, detail, status, output }
//                           status: 'running' | 'done' | 'error'
//   { id, kind: 'notice',   text, error }       interruptions, turn results
//
// An item with `replaces: <id>` takes the place of that earlier item (a
// streamed draft becoming the final text). Updates are partial: a later item
// with the same id is merged into the earlier one, so a tool call and its
// result, which arrive separately, end up as one item.

export class ItemList {
  constructor() {
    this.map = new Map();
  }

  // Merges `patch` into the item with the same id and returns the result.
  put(patch) {
    const merged = { ...this.map.get(patch.id), ...patch };
    if (patch.replaces && this.map.has(patch.replaces)) {
      // Keep the draft's position in the list.
      this.map = new Map(
        [...this.map].map(([id, item]) => (id === patch.replaces ? [merged.id, merged] : [id, item])),
      );
    } else {
      this.map.set(merged.id, merged);
    }
    return merged;
  }

  // Appends streamed text, starting a text item if there isn't one yet.
  delta(id, text) {
    const item = this.map.get(id) || this.put({ id, kind: 'text', text: '' });
    item.text = (item.text || '') + text;
  }

  values() {
    return [...this.map.values()];
  }
}

export const dataUrl = (img) => `data:${img.mediaType};base64,${img.data}`;

function pick(input, ...keys) {
  for (const k of keys) if (input[k] != null && input[k] !== '') return input[k];
  return null;
}

function relative(text, dir) {
  return dir ? String(text).split(dir + '/').join('') : String(text);
}

// One line describing a tool call: its command, path, pattern, …
export function toolSummary(input, dir) {
  if (!input || typeof input !== 'object') return '';
  const arg = pick(input, 'command', 'file_path', 'filePath', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill');
  return arg == null ? '' : relative(String(arg).split('\n')[0], dir).slice(0, 160);
}

// The full call, shown when the card is expanded or in a permission prompt.
// Field names differ between agents (file_path vs filePath), so both are read.
export function toolDetail(input) {
  if (!input || typeof input !== 'object') return String(input ?? '');
  const file = pick(input, 'file_path', 'filePath', 'path');
  const oldText = pick(input, 'old_string', 'oldString');
  const newText = pick(input, 'new_string', 'newString');
  if (oldText != null && newText != null) return `${file}\n--- old\n${oldText}\n+++ new\n${newText}`;
  if (input.command != null) return '$ ' + input.command;
  if (file != null && input.content != null) return `${file}\n\n${input.content}`;
  return JSON.stringify(input, null, 2);
}

export function toolItem(id, name, input, dir) {
  return { id, kind: 'tool', name, summary: toolSummary(input, dir), detail: toolDetail(input) };
}

const MAX_OUTPUT = 20000;

export function clip(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text, null, 2) ?? '';
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n… (truncated)' : s;
}
