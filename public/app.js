'use strict';

const $ = (id) => document.getElementById(id);

const ui = {
  dir: null,
  key: null, // current conversation: sessionId, or temp key while starting
  sessionId: null,
  running: false,
  pending: [],
  sessions: [],
  toolCards: new Map(), // tool_use_id -> element
  seen: new Set(), // message uuids already rendered
  streamEl: null,
  streamText: '',
};

// ---------- api ----------

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.needPassword) {
    showLogin();
    throw new Error('login required');
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- url state ----------

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { dir: h.get('dir'), s: h.get('s') };
}
function writeHash() {
  const h = new URLSearchParams();
  if (ui.dir) h.set('dir', ui.dir);
  if (ui.sessionId) h.set('s', ui.sessionId);
  history.replaceState(null, '', '#' + h.toString());
}

// ---------- login ----------

function showLogin() {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('password').focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('/api/login', { password: $('password').value });
    $('login').classList.add('hidden');
    start();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

// ---------- projects & sessions ----------

async function loadProjects() {
  const projects = await api('/api/projects');
  const sel = $('project');
  sel.innerHTML = '';
  for (const p of projects) {
    const o = document.createElement('option');
    o.value = p.dir;
    o.textContent = p.sessions ? `${p.name}  (${p.sessions})` : p.name;
    o.title = p.dir;
    sel.appendChild(o);
  }
  const o = document.createElement('option');
  o.value = '__other__';
  o.textContent = 'Other folder…';
  sel.appendChild(o);
  return projects;
}

function setProject(dir) {
  ui.dir = dir;
  $('project').value = dir;
  if ($('project').value !== dir) {
    const o = document.createElement('option');
    o.value = dir;
    o.textContent = dir.split('/').pop();
    o.title = dir;
    $('project').insertBefore(o, $('project').lastChild);
    $('project').value = dir;
  }
}

$('project').addEventListener('change', async () => {
  let dir = $('project').value;
  if (dir === '__other__') {
    dir = prompt('Absolute path of the project folder on the host:', ui.dir || '');
    if (!dir) {
      $('project').value = ui.dir;
      return;
    }
  }
  setProject(dir);
  newConversation();
  await loadSessions();
});

async function loadSessions() {
  if (!ui.dir) return;
  ui.sessions = await api('/api/sessions?dir=' + encodeURIComponent(ui.dir));
  renderSessions();
}

function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString();
}

function renderSessions() {
  const ul = $('sessions');
  ul.innerHTML = '';
  for (const s of ui.sessions) {
    const li = document.createElement('li');
    const id = s.sessionId || s.key;
    if (id === ui.key) li.classList.add('active');
    const t = document.createElement('div');
    t.className = 's-title';
    if (s.running) {
      const d = document.createElement('span');
      d.className = 'dot';
      t.appendChild(d);
    }
    t.appendChild(document.createTextNode(s.customTitle || s.summary || s.firstPrompt || 'Untitled'));
    const meta = document.createElement('div');
    meta.className = 's-meta';
    meta.textContent = [timeAgo(s.lastModified), s.gitBranch].filter(Boolean).join(' · ');
    li.append(t, meta);
    li.onclick = () => {
      openConversation(id);
      $('sidebar').classList.remove('open');
    };
    ul.appendChild(li);
  }
}

$('new-chat').addEventListener('click', () => {
  newConversation();
  $('sidebar').classList.remove('open');
  $('input').focus();
});

$('toggle-sidebar').addEventListener('click', () => $('sidebar').classList.toggle('open'));

// ---------- conversation ----------

function resetView() {
  $('messages').innerHTML = '';
  ui.toolCards.clear();
  ui.seen.clear();
  ui.streamEl = null;
  ui.streamText = '';
  ui.pending = [];
  renderPending();
}

function newConversation() {
  ui.key = null;
  ui.sessionId = null;
  ui.running = false;
  resetView();
  $('messages').innerHTML = '<div class="empty">Start a new conversation in this project.</div>';
  $('title').textContent = 'New conversation';
  $('subtitle').textContent = ui.dir || '';
  setRunning(false);
  renderSessions();
  writeHash();
}

async function openConversation(id) {
  ui.key = id;
  ui.sessionId = id.startsWith('new-') ? null : id;
  resetView();
  writeHash();
  renderSessions();
  const s = ui.sessions.find((x) => (x.sessionId || x.key) === id);
  $('title').textContent = s ? (s.customTitle || s.summary || 'Conversation') : 'Conversation';
  $('subtitle').textContent = ui.dir;

  const data = await api(`/api/sessions/${encodeURIComponent(id)}?dir=${encodeURIComponent(ui.dir)}`);
  if (ui.key !== id) return;
  for (const m of data.messages) renderMessage(m);
  if (data.live) {
    for (const ev of data.live.buffer || []) handleTurnEvent(ev, true);
    applyStatus(data.live);
  } else {
    setRunning(false);
  }
  scrollToBottom(true);
}

// ---------- rendering ----------

function md(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { breaks: false, gfm: true }));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function nearBottom() {
  const m = $('messages');
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}
function scrollToBottom(force) {
  const m = $('messages');
  if (force || nearBottom()) m.scrollTop = m.scrollHeight;
}

function append(node) {
  const stick = nearBottom();
  const empty = $('messages').querySelector('.empty');
  if (empty) empty.remove();
  if (ui.streamEl && ui.streamEl.parentNode) {
    $('messages').insertBefore(node, ui.streamEl);
  } else {
    $('messages').appendChild(node);
  }
  if (stick) scrollToBottom(true);
}

function toolArg(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick =
    input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ??
    input.query ?? input.description ?? input.prompt ?? input.skill ?? '';
  let arg = String(pick).split('\n')[0];
  if (ui.dir) arg = arg.split(ui.dir + '/').join('');
  return arg.slice(0, 160);
}

function stringifyResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(content, null, 2);
}

function stripMeta(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function renderMessage(m) {
  if (m.uuid) {
    if (ui.seen.has(m.uuid)) return;
    ui.seen.add(m.uuid);
  }
  if (m.parent_tool_use_id) return; // subagent internals
  const msg = m.message || {};
  const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content || [];

  if (m.type === 'user') {
    for (const b of content) {
      if (b.type === 'tool_result') {
        attachToolResult(b);
      } else if (b.type === 'text') {
        const t = stripMeta(b.text);
        if (!t || /^<(command-|local-command-)/.test(t) || t.startsWith('[Request interrupted')) {
          if (t.startsWith('[Request interrupted')) append(el('div', 'result-line', 'Interrupted'));
          continue;
        }
        append(el('div', 'msg-user', t));
      } else if (b.type === 'image') {
        append(el('div', 'msg-user muted', '[image]'));
      }
    }
    return;
  }

  if (m.type === 'assistant') {
    for (const b of content) {
      if (b.type === 'text') {
        clearStream();
        const d = el('div', 'msg-assistant');
        d.innerHTML = md(b.text);
        append(d);
      } else if (b.type === 'thinking' && b.thinking) {
        const d = el('details', 'tool');
        const s = el('summary');
        s.appendChild(el('span', 'thinking', 'Thinking'));
        d.appendChild(s);
        const body = el('div', 't-body');
        body.appendChild(el('div', 'thinking', b.thinking));
        d.appendChild(body);
        append(d);
      } else if (b.type === 'tool_use') {
        clearStream();
        renderToolUse(b);
      }
    }
  }
}

function renderToolUse(b) {
  const d = el('details', 'tool');
  const s = el('summary');
  s.appendChild(el('span', 't-name', b.name));
  const arg = toolArg(b.name, b.input);
  if (arg) s.appendChild(el('span', 't-arg', '  ' + arg));
  const st = el('span', 't-state', '…');
  s.appendChild(st);
  d.appendChild(s);
  const body = el('div', 't-body');
  let shown = b.input;
  if (b.name === 'Edit' && b.input) {
    shown = `${b.input.file_path}\n--- old\n${b.input.old_string}\n+++ new\n${b.input.new_string}`;
  } else if (b.name === 'Write' && b.input) {
    shown = `${b.input.file_path}\n\n${b.input.content}`;
  } else if (b.name === 'Bash' && b.input) {
    shown = '$ ' + b.input.command;
  }
  body.appendChild(el('pre', '', typeof shown === 'string' ? shown : JSON.stringify(shown, null, 2)));
  d.appendChild(body);
  ui.toolCards.set(b.id, d);
  append(d);
}

function attachToolResult(b) {
  const card = ui.toolCards.get(b.tool_use_id);
  const text = stringifyResult(b.content);
  if (!card) return;
  const st = card.querySelector('.t-state');
  if (st) st.textContent = b.is_error ? 'error' : 'done';
  if (b.is_error) card.classList.add('err');
  const body = card.querySelector('.t-body');
  const pre = el('pre', '', text.length > 20000 ? text.slice(0, 20000) + '\n… (truncated)' : text);
  body.appendChild(pre);
}

function clearStream() {
  if (ui.streamEl) ui.streamEl.remove();
  ui.streamEl = null;
  ui.streamText = '';
}

let streamRaf = 0;
function addDelta(text) {
  ui.streamText += text;
  if (!ui.streamEl) {
    ui.streamEl = el('div', 'msg-assistant');
    const empty = $('messages').querySelector('.empty');
    if (empty) empty.remove();
    $('messages').appendChild(ui.streamEl);
  }
  if (!streamRaf) {
    streamRaf = requestAnimationFrame(() => {
      streamRaf = 0;
      if (!ui.streamEl) return;
      const stick = nearBottom();
      ui.streamEl.innerHTML = md(ui.streamText);
      if (stick) scrollToBottom(true);
    });
  }
}

// ---------- live events ----------

function isMine(ev) {
  return ui.key && (ev.key === ui.key || (ev.sessionId && ev.sessionId === ui.sessionId));
}

function handleTurnEvent(ev, replay) {
  switch (ev.type) {
    case 'user_text': {
      // On replay the transcript may already contain this prompt.
      const users = $('messages').querySelectorAll('.msg-user');
      const last = users[users.length - 1];
      if (replay && last && last.textContent === ev.text) break;
      append(el('div', 'msg-user', ev.text));
      break;
    }
    case 'delta':
      addDelta(ev.text);
      break;
    case 'message':
      renderMessage(ev.message);
      break;
    case 'result': {
      clearStream();
      const parts = [];
      if (ev.error) parts.push(ev.error);
      if (ev.duration) parts.push((ev.duration / 1000).toFixed(1) + 's');
      if (ev.cost) parts.push('$' + ev.cost.toFixed(3));
      append(el('div', 'result-line' + (ev.error ? ' err' : ''), parts.join(' · ')));
      break;
    }
    case 'error':
      clearStream();
      append(el('div', 'result-line err', 'Error: ' + ev.error));
      break;
    case 'status':
      if (!replay) applyStatus(ev);
      break;
  }
}

function applyStatus(st) {
  setRunning(st.running);
  if (st.mode) $('mode').value = st.mode;
  ui.pending = st.pending || [];
  renderPending();
}

function setRunning(running) {
  ui.running = running;
  $('stop').classList.toggle('hidden', !running);
  $('send').disabled = running;
  $('status').innerHTML = '';
  if (running) {
    const d = el('span', 'dot');
    $('status').append(d, document.createTextNode(ui.pending.length ? 'Needs approval' : 'Working…'));
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'session_bound') {
      if (ui.key === ev.key) {
        ui.key = ev.sessionId;
        ui.sessionId = ev.sessionId;
        writeHash();
      }
      if (ev.dir === ui.dir) loadSessions();
      return;
    }
    if (ev.type === 'sessions_changed') {
      if (ev.dir === ui.dir) loadSessions();
      return;
    }
    if (ev.type === 'status' && ev.dir === ui.dir) {
      // Keep running dots in the sidebar fresh for other conversations.
      const s = ui.sessions.find((x) => (x.sessionId || x.key) === (ev.sessionId || ev.key));
      if (s && s.running !== ev.running) {
        s.running = ev.running;
        renderSessions();
      } else if (!s && ev.running) {
        loadSessions();
      }
    }
    if (isMine(ev)) handleTurnEvent(ev, false);
  };
  es.onerror = () => {
    // EventSource reconnects on its own; resync the open conversation when it does.
    es.onopen = () => {
      if (ui.key) openConversation(ui.key);
      loadSessions();
    };
  };
}

// ---------- permissions ----------

function renderPending() {
  const box = $('pending');
  box.innerHTML = '';
  setRunningLabel();
  for (const p of ui.pending) {
    const card = el('div', 'perm');
    if (p.toolName === 'AskUserQuestion' && Array.isArray(p.input?.questions)) {
      renderQuestion(card, p);
    } else {
      card.appendChild(el('h4', '', p.title || `Claude wants to use ${p.toolName}`));
      if (p.reason) card.appendChild(el('div', 'muted', p.reason));
      let shown = p.input;
      if (p.toolName === 'Bash') shown = '$ ' + p.input.command;
      else if (p.toolName === 'ExitPlanMode') shown = p.input.plan;
      else if (p.toolName === 'Edit') shown = `${p.input.file_path}\n--- old\n${p.input.old_string}\n+++ new\n${p.input.new_string}`;
      else if (p.toolName === 'Write') shown = `${p.input.file_path}\n\n${p.input.content}`;
      const pre = el('pre');
      if (p.toolName === 'ExitPlanMode') {
        pre.className = 'msg-assistant';
        pre.innerHTML = md(shown);
      } else {
        pre.textContent = typeof shown === 'string' ? shown : JSON.stringify(shown, null, 2);
      }
      card.appendChild(pre);
      const row = el('div', 'row');
      const allow = el('button', 'primary', 'Allow');
      allow.onclick = () => answer(p, { allow: true });
      row.appendChild(allow);
      if (p.canAlways) {
        const always = el('button', '', 'Allow & don’t ask again');
        always.onclick = () => answer(p, { allow: true, always: true });
        row.appendChild(always);
      }
      const deny = el('button', 'danger', 'Deny');
      deny.onclick = () => {
        const why = prompt('Tell Claude what to do instead (optional):') ?? null;
        if (why === null) return;
        answer(p, { allow: false, message: why || undefined });
      };
      row.appendChild(deny);
      card.appendChild(row);
    }
    box.appendChild(card);
  }
}

function renderQuestion(card, p) {
  const answers = {};
  for (const q of p.input.questions) {
    const wrap = el('div', 'q');
    wrap.appendChild(el('h4', '', q.question));
    const opts = el('div', 'opts');
    const picked = new Set();
    const buttons = [];
    for (const o of q.options || []) {
      const b = el('button');
      b.type = 'button';
      b.appendChild(document.createTextNode(o.label));
      if (o.description) b.appendChild(el('span', 'desc', o.description));
      b.onclick = () => {
        if (!q.multiSelect) picked.clear();
        picked.has(o.label) ? picked.delete(o.label) : picked.add(o.label);
        buttons.forEach((bb) => bb.el.classList.toggle('sel', picked.has(bb.label)));
        answers[q.question] = [...picked].join(', ');
      };
      buttons.push({ el: b, label: o.label });
      opts.appendChild(b);
    }
    const other = el('input');
    other.placeholder = 'Other…';
    other.style.cssText = 'padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--card)';
    other.oninput = () => {
      picked.clear();
      buttons.forEach((bb) => bb.el.classList.remove('sel'));
      answers[q.question] = other.value;
    };
    opts.appendChild(other);
    wrap.appendChild(opts);
    card.appendChild(wrap);
  }
  const row = el('div', 'row');
  const ok = el('button', 'primary', 'Submit answers');
  ok.onclick = () => answer(p, { allow: true, answers });
  const skip = el('button', 'danger', 'Skip');
  skip.onclick = () => answer(p, { allow: false, message: 'The user skipped the question.' });
  row.append(ok, skip);
  card.appendChild(row);
}

function setRunningLabel() {
  if (ui.running) setRunning(true);
}

async function answer(p, body) {
  try {
    await api('/api/permission', { key: ui.key, id: p.id, ...body });
  } catch (err) {
    alert(err.message);
  }
}

// ---------- composer ----------

const input = $('input');
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || ui.running || !ui.dir) return;
  $('send').disabled = true;
  try {
    const { key } = await api('/api/send', {
      sessionId: ui.sessionId,
      dir: ui.dir,
      text,
      mode: $('mode').value,
    });
    if (!ui.key) {
      ui.key = key;
      $('title').textContent = text.split('\n')[0].slice(0, 80);
      $('messages').innerHTML = '';
      // The server already broadcast user_text before we knew our key; show it.
      append(el('div', 'msg-user', text));
      loadSessions();
    }
    setRunning(true);
    input.value = '';
    autosize();
  } catch (err) {
    alert(err.message);
    $('send').disabled = false;
  }
});

$('stop').addEventListener('click', () => api('/api/interrupt', { key: ui.key }).catch(() => {}));

$('mode').addEventListener('change', () => {
  if (ui.key) api('/api/mode', { key: ui.key, mode: $('mode').value }).catch(() => {});
});

// ---------- boot ----------

async function start() {
  const me = await api('/api/me');
  $('app').classList.remove('hidden');
  $('host').textContent = 'Host: ' + me.host;
  const projects = await loadProjects();
  const h = readHash();
  const dir = h.dir || projects[0]?.dir;
  if (dir) setProject(dir);
  await loadSessions();
  if (h.s) await openConversation(h.s);
  else newConversation();
  connectEvents();
}

start().catch((err) => {
  if (err.message !== 'login required') alert(err.message);
});
