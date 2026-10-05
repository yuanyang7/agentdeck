// Live conversations and the browsers watching them.
//
// One server process owns every running turn, so any browser that connects
// sees the same live conversation. A conversation runs one turn at a time;
// messages sent while a turn runs wait in its queue and start, in order, as
// soon as the previous turn finishes. None of this depends on
// which agent runs the turn: backends only see the `turn` object built in
// `run()` below.

import crypto from 'node:crypto';
import { ItemList } from './items.mjs';
import { markUnread } from './reads.mjs';
import { setSettings, cleanSettings } from './chat-settings.mjs';

export class BusyError extends Error {}

const convKey = (agent, sessionId) => `${agent}:${sessionId}`;
const MAX_QUEUE = 20;

export class Hub {
  // `instructions`, if given, returns extra instructions for the agent (the
  // workspace index), or null; see lib/workspace-index.mjs.
  constructor({ instructions } = {}) {
    this.instructions = instructions;
    // key -> conversation. key is `agent:sessionId` once the session id is
    // known; a brand-new conversation uses a temp key until the agent reports it.
    this.live = new Map();
    // temp key -> conversation, so a message queued under a new chat's temp
    // key still finds it after the agent reported the session id.
    this.renamed = new Map();
    this.clients = new Set(); // SSE responses
  }

  broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) res.write(data);
  }

  get(key) {
    return this.live.get(key) || this.renamed.get(key);
  }

  find(agent, sessionId) {
    return this.live.get(convKey(agent, sessionId));
  }

  // Conversations whose agent hasn't reported a session id yet.
  starting(dir) {
    return [...this.live.values()].filter((c) => !c.sessionId && c.running && c.dir === dir);
  }

  emit(conv, event) {
    this.broadcast({ key: conv.key, agent: conv.agent, sessionId: conv.sessionId, ...event });
  }

  status(conv) {
    return {
      type: 'status',
      running: conv.running,
      mode: conv.mode,
      dir: conv.dir,
      pending: [...conv.pending.values()].map((p) => p.request),
      queue: conv.queue.map((m) => ({ id: m.id, text: m.text, images: m.images.length })),
    };
  }

  // What a browser opening this conversation needs on top of the history.
  snapshot(conv) {
    return { ...this.status(conv), items: conv.running ? conv.items.values() : [] };
  }

  // Starts a turn, or queues the message if one is running, and returns the
  // conversation's key without waiting. A new conversation brings its own
  // temp key (`new-…`), so the browser that started it can follow events sent
  // before this call returns, and queue more messages under that key while
  // the first turn runs.
  start(backend, { sessionId, key: newKey, dir, text, images, settings }) {
    let conv = sessionId ? this.find(backend.id, sessionId) : newKey ? this.get(newKey) : null;
    if (conv && conv.agent !== backend.id) conv = null;
    if (!conv && !sessionId && (!newKey || this.get(newKey))) newKey = `new-${crypto.randomUUID()}`;
    if (!conv) {
      const key = sessionId ? convKey(backend.id, sessionId) : newKey;
      conv = { key, agent: backend.id, sessionId: sessionId || null, dir, running: false, mode: settings.mode, items: new ItemList(), pending: new Map(), queue: [], handle: null };
      this.live.set(key, conv);
    }
    const message = { id: crypto.randomUUID(), text, images, settings };
    if (conv.running) {
      if (conv.queue.length >= MAX_QUEUE) throw new BusyError(`At most ${MAX_QUEUE} messages can wait in the queue.`);
      conv.queue.push(message);
      this.emit(conv, this.status(conv));
      return conv.key;
    }
    conv.dir = dir;
    this.run(conv, backend, message);
    return conv.key;
  }

  // Takes a message out of the queue before it starts; returns it, or null.
  unqueue(key, id) {
    const conv = this.get(key);
    const i = conv ? conv.queue.findIndex((m) => m.id === id) : -1;
    if (i < 0) return null;
    const [message] = conv.queue.splice(i, 1);
    this.emit(conv, this.status(conv));
    return message;
  }

  // Moves a queued message to the front and stops the running turn, so it
  // starts right away; the rest of the queue follows it. Returns false if
  // the message already started or was removed.
  async sendNow(key, id) {
    const conv = this.get(key);
    const i = conv ? conv.queue.findIndex((m) => m.id === id) : -1;
    if (i < 0) return false;
    conv.queue.unshift(...conv.queue.splice(i, 1));
    this.emit(conv, this.status(conv));
    await this.stop(conv);
    return true;
  }

  // Runs a turn, then each queued message in order. The conversation stays
  // `running` in between, so watchers see one stretch of work.
  async run(conv, backend, message) {
    conv.running = true;
    try {
      for (let next = message; next; next = conv.queue.shift()) await this.runTurn(conv, backend, next);
    } catch (err) {
      console.error('turn failed:', err);
      conv.queue.length = 0;
    }
    conv.running = false;
    // The work is done: flag the chat as unread for browsers that weren't
    // watching. Any browser that was watching clears the flag again when it
    // receives this status (see the /api/read handler in server.mjs).
    if (conv.sessionId) markUnread(conv.agent, conv.sessionId);
    this.emit(conv, this.status(conv));
    this.broadcast({ type: 'sessions_changed', dir: conv.dir });
  }

  async runTurn(conv, backend, { text, images, settings }) {
    const turnId = crypto.randomUUID();
    const started = Date.now();
    conv.running = true;
    conv.mode = settings.mode;
    conv.settings = cleanSettings(settings);
    this.rememberSettings(conv);
    conv.items = new ItemList();
    this.emit(conv, this.status(conv));
    // Built for a new conversation's first turn and kept for the rest, so
    // the agent's system prompt (and its prompt cache) stays the same.
    // Agents record it when the conversation is created, so continuing an
    // existing one gets none. Stop pressed meanwhile cancels the turn.
    conv.cancelled = false;
    if (this.instructions && !conv.sessionId && conv.instructions === undefined) {
      conv.instructions = await this.instructions().catch((err) => {
        console.error('instructions failed:', err);
        return null;
      });
    }

    const turn = {
      sessionId: conv.sessionId,
      dir: conv.dir,
      text,
      images,
      settings,
      instructions: conv.instructions || null,
      bind: (sessionId) => this.bind(conv, sessionId),
      item: (patch) => this.emit(conv, { type: 'item', item: conv.items.put(patch) }),
      delta: (id, chunk) => {
        conv.items.delta(id, chunk);
        this.emit(conv, { type: 'delta', id, text: chunk });
      },
      ask: (request, signal) => this.ask(conv, request, signal),
    };

    let result = {};
    try {
      if (conv.cancelled) throw new Error('Interrupted');
      conv.handle = backend.startTurn(turn);
      result = (await conv.handle.done) || {};
    } catch (err) {
      result = { error: String(err?.message || err) };
    } finally {
      for (const p of conv.pending.values()) p.resolve({ allow: false, message: 'Turn ended.' });
      conv.pending.clear();
      const parts = [];
      if (result.error) parts.push(result.error);
      parts.push(((result.duration ?? Date.now() - started) / 1000).toFixed(1) + 's');
      if (result.cost) parts.push('$' + result.cost.toFixed(3));
      turn.item({ id: `result-${turnId}`, kind: 'notice', text: parts.join(' · '), error: !!result.error });
      conv.handle = null;
    }
  }

  bind(conv, sessionId) {
    if (conv.sessionId === sessionId) return;
    const oldKey = conv.key;
    this.live.delete(oldKey);
    if (oldKey.startsWith('new-')) this.renamed.set(oldKey, conv);
    conv.sessionId = sessionId;
    conv.key = convKey(conv.agent, sessionId);
    this.live.set(conv.key, conv);
    this.broadcast({ type: 'session_bound', oldKey, key: conv.key, agent: conv.agent, sessionId, dir: conv.dir });
    this.rememberSettings(conv);
  }

  // Records the model, effort and mode of the chat's latest turn, so other
  // devices continue it the same way. New chats are recorded once bound.
  rememberSettings(conv) {
    if (conv.sessionId && conv.settings) this.settingsChanged(conv.agent, conv.sessionId, conv.settings);
  }

  settingsChanged(agent, sessionId, settings) {
    if (setSettings(agent, sessionId, settings)) {
      this.broadcast({ type: 'settings_changed', agent, sessionId, settings: cleanSettings(settings) });
    }
  }

  // Shows a permission prompt or question on every device and resolves with
  // the first answer: { allow, always?, message?, answers? }. `request` is
  //   { kind: 'permission', title, reason?, detail, markdown?, canAlways? }
  //   { kind: 'question', title, questions: [{ question, header, options: [{ label, description }], multiple }] }
  // and `answers` holds the chosen labels (or typed text) per question.
  ask(conv, request, signal) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      conv.pending.set(id, { request: { ...request, id }, resolve });
      signal?.addEventListener('abort', () => {
        if (conv.pending.delete(id)) {
          resolve({ allow: false, message: 'Aborted.' });
          this.emit(conv, this.status(conv));
        }
      });
      this.emit(conv, this.status(conv));
    });
  }

  answer(key, id, answer) {
    const conv = this.get(key);
    const pending = conv?.pending.get(id);
    if (!pending) return false;
    conv.pending.delete(id);
    pending.resolve(answer);
    this.emit(conv, this.status(conv));
    return true;
  }

  // Stops the running turn and drops the queue, so nothing else starts.
  // Returns the dropped messages, so the browser can put them back in its
  // composer.
  async interrupt(key) {
    const conv = this.get(key);
    if (!conv?.running) return [];
    const dropped = conv.queue.splice(0);
    if (dropped.length) this.emit(conv, this.status(conv));
    await this.stop(conv);
    return dropped;
  }

  // Stops the running turn, or keeps it from starting if it is still being
  // set up (see runTurn).
  async stop(conv) {
    if (conv.handle) await conv.handle.interrupt();
    else conv.cancelled = true;
  }

  async setMode(key, mode) {
    const conv = this.get(key);
    if (!conv) return;
    conv.mode = mode;
    if (conv.settings) {
      conv.settings = { ...conv.settings, mode };
      this.rememberSettings(conv);
    }
    if (conv.running) await conv.handle?.setMode?.(mode);
    this.emit(conv, this.status(conv));
  }
}
