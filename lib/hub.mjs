// Live conversations and the browsers watching them.
//
// One server process owns every running turn, so any browser that connects
// sees the same live conversation. A conversation accepts one turn at a time;
// the lock releases itself when the turn finishes. None of this depends on
// which agent runs the turn: backends only see the `turn` object built in
// `run()` below.

import crypto from 'node:crypto';
import { ItemList } from './items.mjs';

export class BusyError extends Error {}

const convKey = (agent, sessionId) => `${agent}:${sessionId}`;

export class Hub {
  constructor() {
    // key -> conversation. key is `agent:sessionId` once the session id is
    // known; a brand-new conversation uses a temp key until the agent reports it.
    this.live = new Map();
    this.clients = new Set(); // SSE responses
  }

  broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) res.write(data);
  }

  get(key) {
    return this.live.get(key);
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
    };
  }

  // What a browser opening this conversation needs on top of the history.
  snapshot(conv) {
    return { ...this.status(conv), items: conv.running ? conv.items.values() : [] };
  }

  // Starts a turn and returns the conversation's key without waiting for it.
  // A new conversation may bring its own temp key (`new-…`), so the browser
  // that started it can follow events sent before this call returns.
  start(backend, { sessionId, key: newKey, dir, text, images, settings }) {
    let conv = sessionId ? this.find(backend.id, sessionId) : null;
    if (conv?.running) throw new BusyError('The agent is still working on this conversation. Wait for it to finish or press Stop.');
    if (!sessionId && (!newKey || this.live.has(newKey))) newKey = `new-${crypto.randomUUID()}`;
    if (!conv) {
      const key = sessionId ? convKey(backend.id, sessionId) : newKey;
      conv = { key, agent: backend.id, sessionId: sessionId || null, dir, running: false, mode: settings.mode, items: new ItemList(), pending: new Map(), handle: null };
      this.live.set(key, conv);
    }
    conv.dir = dir;
    this.run(conv, backend, { text, images, settings });
    return conv.key;
  }

  async run(conv, backend, { text, images, settings }) {
    const turnId = crypto.randomUUID();
    const started = Date.now();
    conv.running = true;
    conv.mode = settings.mode;
    conv.items = new ItemList();
    this.emit(conv, this.status(conv));

    const turn = {
      sessionId: conv.sessionId,
      dir: conv.dir,
      text,
      images,
      settings,
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
      conv.running = false;
      conv.handle = null;
      this.emit(conv, this.status(conv));
      this.broadcast({ type: 'sessions_changed', dir: conv.dir });
    }
  }

  bind(conv, sessionId) {
    if (conv.sessionId === sessionId) return;
    const oldKey = conv.key;
    this.live.delete(oldKey);
    conv.sessionId = sessionId;
    conv.key = convKey(conv.agent, sessionId);
    this.live.set(conv.key, conv);
    this.broadcast({ type: 'session_bound', oldKey, key: conv.key, agent: conv.agent, sessionId, dir: conv.dir });
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
    const conv = this.live.get(key);
    const pending = conv?.pending.get(id);
    if (!pending) return false;
    conv.pending.delete(id);
    pending.resolve(answer);
    this.emit(conv, this.status(conv));
    return true;
  }

  async interrupt(key) {
    const conv = this.live.get(key);
    if (conv?.running && conv.handle) await conv.handle.interrupt();
  }

  async setMode(key, mode) {
    const conv = this.live.get(key);
    if (!conv) return;
    conv.mode = mode;
    if (conv.running) await conv.handle?.setMode?.(mode);
    this.emit(conv, this.status(conv));
  }
}
