'use strict';

const $ = (id) => document.getElementById(id);

const ui = {
  dir: null,
  agent: null, // agent of the open conversation, or the one a new one will use
  key: null, // live key: 'agent:sessionId', or a temp 'new-…' key while starting
  sessionId: null,
  running: false,
  mode: null, // mode reported by the live conversation, if any
  model: null, // { model, effort } the open chat uses, as stored on the server
  pending: [],
  sessions: [],
  tagFilter: null, // tag the chat list is filtered to, or null
  agents: [], // [{ id, label }] available on the host
  options: new Map(), // agent -> composer options from the server
  items: new Map(), // id -> transcript item (see lib/items.mjs)
  els: new Map(), // id -> rendered element
};

// crypto.randomUUID needs a secure context, which plain http on the tailnet isn't.
const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

const agentLabel = (id) => ui.agents.find((a) => a.id === id)?.label || id;

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
  // Links from before there were several agents have no `a`; those are Claude.
  return { dir: h.get('dir'), agent: h.get('a') || 'claude', s: h.get('s') };
}
function writeHash() {
  const h = new URLSearchParams();
  if (ui.dir) h.set('dir', ui.dir);
  if (ui.sessionId) {
    h.set('a', ui.agent);
    h.set('s', ui.sessionId);
  }
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

// Tag editor: `draft` is this chat's tags while the dialog is open; Save sends it.
const tagEd = { session: null, draft: [], quick: [] };
const hasTag = (list, t) => list.some((x) => x.toLowerCase() === t.toLowerCase());

function renderTagEditor() {
  const cur = $('tag-current');
  cur.innerHTML = '';
  if (!tagEd.draft.length) cur.appendChild(el('span', 'muted', 'No tags yet'));
  for (const t of tagEd.draft) {
    const chip = el('button', 'tag on', t + ' ×');
    chip.type = 'button';
    chip.onclick = () => {
      tagEd.draft = tagEd.draft.filter((x) => x !== t);
      renderTagEditor();
    };
    cur.appendChild(chip);
  }
  const quick = $('tag-quick');
  quick.innerHTML = '';
  for (const t of tagEd.quick) {
    const wrap = el('span', 'tag-q');
    const chip = el('button', 'tag' + (hasTag(tagEd.draft, t) ? ' on' : ''), t);
    chip.type = 'button';
    chip.onclick = () => {
      if (hasTag(tagEd.draft, t)) tagEd.draft = tagEd.draft.filter((x) => x.toLowerCase() !== t.toLowerCase());
      else tagEd.draft.push(t);
      renderTagEditor();
    };
    const forget = el('button', 'tag-forget', '×');
    forget.type = 'button';
    forget.title = 'Remove from quick tags';
    forget.onclick = async () => {
      tagEd.quick = tagEd.quick.filter((x) => x !== t);
      renderTagEditor();
      api('/api/quicktags', { quick: tagEd.quick }).catch(() => {});
    };
    wrap.append(chip, forget);
    quick.appendChild(wrap);
  }
  if (!tagEd.quick.length) quick.appendChild(el('span', 'muted', 'Tags you use are saved here'));
}

function addDraftTag() {
  const t = $('tag-input').value.trim().replace(/\s+/g, ' ');
  $('tag-input').value = '';
  if (t && !hasTag(tagEd.draft, t)) tagEd.draft.push(t);
  renderTagEditor();
}

async function editTags(s) {
  tagEd.session = s;
  tagEd.draft = [...(s.tags || [])];
  tagEd.quick = [];
  renderTagEditor();
  $('tag-dialog').showModal();
  $('tag-input').focus();
  api('/api/quicktags').then((r) => {
    tagEd.quick = r.quick;
    renderTagEditor();
  }).catch(() => {});
}

$('tag-input').addEventListener('keydown', (e) => {
  // Enter adds the typed tag instead of saving the dialog; comma works too.
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    addDraftTag();
  }
});

$('tag-cancel').addEventListener('click', () => $('tag-dialog').close());

$('tag-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  addDraftTag(); // whatever is still in the input counts
  const s = tagEd.session;
  try {
    const r = await api('/api/tags', { agent: s.agent, sessionId: s.id, dir: ui.dir, tags: tagEd.draft });
    s.tags = r.tags;
    $('tag-dialog').close();
    renderSessions();
  } catch (err) {
    alert('Could not save tags: ' + err.message);
  }
});

function renderTagFilter() {
  const box = $('tag-filter');
  const counts = new Map();
  for (const s of ui.sessions) for (const t of s.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  // A filter whose tag no longer exists would hide everything with no way back.
  if (ui.tagFilter && !counts.has(ui.tagFilter)) ui.tagFilter = null;
  box.innerHTML = '';
  box.classList.toggle('hidden', counts.size === 0);
  for (const [t, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    const chip = el('button', 'tag' + (t === ui.tagFilter ? ' on' : ''), `${t} ${n}`);
    chip.type = 'button';
    chip.onclick = () => {
      ui.tagFilter = ui.tagFilter === t ? null : t;
      renderSessions();
    };
    box.appendChild(chip);
  }
}

function renderSessions() {
  const ul = $('sessions');
  ul.innerHTML = '';
  renderTagFilter();
  for (const s of ui.sessions) {
    if (ui.tagFilter && !(s.tags || []).includes(ui.tagFilter)) continue;
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    if (s.key === ui.key) li.classList.add('active');
    const t = document.createElement('div');
    t.className = 's-title';
    if (s.running) {
      const d = document.createElement('span');
      d.className = 'dot';
      t.appendChild(d);
    } else if (s.unread && s.key !== ui.key) {
      // A turn finished here that this browser hasn't seen; opening the chat
      // counts as reading it. The open chat itself is never "unread".
      const d = document.createElement('span');
      d.className = 'dot unread';
      d.title = 'Finished — not read yet';
      t.appendChild(d);
      t.classList.add('unread');
    }
    t.appendChild(document.createTextNode(s.title || 'Untitled'));
    const meta = el('div', 's-meta');
    if (ui.agents.length > 1) meta.appendChild(el('span', 'agent-badge', agentLabel(s.agent)));
    meta.appendChild(document.createTextNode([timeAgo(s.updatedAt), s.branch].filter(Boolean).join(' · ')));
    li.append(t, meta);
    if (s.tags?.length) {
      const row = el('div', 's-tags');
      for (const tag of s.tags) row.appendChild(el('span', 'tag', tag));
      li.appendChild(row);
    }
    if (s.id) {
      const b = el('button', 's-tag-btn', '🏷');
      b.type = 'button';
      b.title = 'Edit tags';
      b.onclick = (e) => {
        e.stopPropagation();
        editTags(s);
      };
      li.appendChild(b);
    }
    li.onclick = () => {
      const keyboardFocus = document.activeElement === li;
      setSidebarOpen(false);
      openConversation(s.agent, s.id || s.key);
      if (keyboardFocus && !mobileSidebar.matches) $('sessions').querySelector('li.active')?.focus();
    };
    li.onkeydown = (e) => {
      if (e.target !== li || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      li.click();
    };
    ul.appendChild(li);
  }
}

$('new-chat').addEventListener('click', () => {
  newConversation();
  setSidebarOpen(false);
  $('input').focus();
});

const mobileSidebar = matchMedia('(max-width: 760px)');

function setSidebarOpen(open) {
  open = open && mobileSidebar.matches;
  const hadFocus = $('sidebar').contains(document.activeElement);
  $('sidebar').classList.toggle('open', open);
  $('sidebar-backdrop').classList.toggle('open', open);
  $('toggle-sidebar').setAttribute('aria-expanded', String(open));
  $('toggle-sidebar').setAttribute('aria-label', open ? 'Close conversations' : 'Open conversations');
  $('sidebar').inert = mobileSidebar.matches && !open;
  $('sidebar').setAttribute('aria-hidden', String(mobileSidebar.matches && !open));
  document.querySelector('.main').inert = open;
  if (open) $('close-sidebar').focus();
  else if (hadFocus && mobileSidebar.matches) $('toggle-sidebar').focus();
}

mobileSidebar.addEventListener('change', () => setSidebarOpen(false));
setSidebarOpen(false);

$('toggle-sidebar').addEventListener('click', () => setSidebarOpen(!$('sidebar').classList.contains('open')));
$('close-sidebar').addEventListener('click', () => setSidebarOpen(false));
$('sidebar-backdrop').addEventListener('click', () => setSidebarOpen(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('sidebar').classList.contains('open')) setSidebarOpen(false);
});

// ---------- conversation ----------

function resetView() {
  $('messages').innerHTML = '';
  ui.items.clear();
  ui.els.clear();
  ui.mode = null;
  ui.pending = [];
  renderPending();
}

function newConversation() {
  ui.key = null;
  ui.sessionId = null;
  ui.running = false;
  resetView();
  $('messages').innerHTML = '';
  const empty = el('div', 'empty');
  empty.appendChild(el('div', 'empty-mark', '✳'));
  empty.appendChild(el('h2', '', 'What are we building today?'));
  const intro = el('p');
  intro.append('Start a conversation in ');
  intro.appendChild(el('span', 'empty-project', ui.dir?.split('/').pop() || 'this project'));
  intro.append('.');
  empty.appendChild(intro);
  $('messages').appendChild(empty);
  $('title').textContent = 'New conversation';
  $('subtitle').textContent = ui.dir || '';
  selectAgent(localStorage.getItem('cw_agent'));
  setRunning(false);
  renderSessions();
  writeHash();
}

// `id` is a session id, or the temp key of a conversation that is starting.
async function openConversation(agent, id) {
  const temp = id.startsWith('new-');
  ui.key = temp ? id : `${agent}:${id}`;
  ui.sessionId = temp ? null : id;
  ui.model = null;
  const key = ui.key;
  resetView();
  selectAgent(agent);
  writeHash();
  renderSessions();
  const s = ui.sessions.find((x) => x.key === key);
  $('title').textContent = s?.title || 'Conversation';
  $('subtitle').textContent = ui.dir;

  const data = await api(`/api/sessions/${agent}/${encodeURIComponent(id)}?dir=${encodeURIComponent(ui.dir)}`);
  if (ui.key !== key) return;
  if (s?.unread) {
    s.unread = false; // the GET above marked the chat read on the server
    renderSessions();
  }
  // Chats from before models were stored per chat show the agent's default.
  ui.model = data.model || { model: null, effort: null };
  fillModels();
  for (const item of data.items) upsert(item);
  if (data.live) {
    for (const item of data.live.items) upsert(item);
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
  $('messages').querySelector('.empty')?.remove();
  $('messages').appendChild(node);
  if (stick) scrollToBottom(true);
}

// A user bubble: optional image thumbnails (click to open full size) and text.
function userBubble(text, images) {
  const d = el('div', 'msg-user');
  if (images.length) {
    const row = el('div', 'msg-images');
    for (const src of images) {
      const img = el('img');
      img.src = src;
      img.addEventListener('click', () => window.open(src, '_blank'));
      row.appendChild(img);
    }
    d.appendChild(row);
  }
  if (text) d.appendChild(el('div', 'msg-text', text));
  return d;
}

const TOOL_STATE = { running: '…', done: 'done', error: 'error' };

function renderItem(item) {
  switch (item.kind) {
    case 'user':
      return userBubble(item.text || '', item.images || []);
    case 'text': {
      const d = el('div', 'msg-assistant');
      d.innerHTML = md(item.text);
      return d;
    }
    case 'thinking': {
      const d = el('details', 'tool' + (item.text ? '' : ' hidden'));
      const s = el('summary');
      s.appendChild(el('span', 'thinking', 'Thinking'));
      const body = el('div', 't-body');
      body.appendChild(el('div', 'thinking', item.text || ''));
      d.append(s, body);
      return d;
    }
    case 'tool': {
      const d = el('details', 'tool' + (item.status === 'error' ? ' err' : ''));
      const s = el('summary');
      s.appendChild(el('span', 't-name', item.name || 'Tool'));
      if (item.summary) s.appendChild(el('span', 't-arg', '  ' + item.summary));
      s.appendChild(el('span', 't-state', TOOL_STATE[item.status] || '…'));
      const body = el('div', 't-body');
      if (item.detail) body.appendChild(el('pre', '', item.detail));
      if (item.output) body.appendChild(el('pre', '', item.output));
      d.append(s, body);
      return d;
    }
    case 'notice':
      return el('div', 'result-line' + (item.error ? ' err' : ''), item.text);
  }
  return el('div', 'hidden');
}

// Adds an item, or merges it into the one with the same id and redraws that
// in place. `replaces` swaps out an earlier item (a streamed draft).
function upsert(patch) {
  const item = { ...ui.items.get(patch.id), ...patch };
  let old = ui.els.get(item.id);
  const draft = item.replaces && ui.els.get(item.replaces);
  if (draft) {
    ui.els.delete(item.replaces);
    ui.items.delete(item.replaces);
    if (old) draft.remove();
    else old = draft;
  }
  ui.items.set(item.id, item);
  const node = renderItem(item);
  if (old) {
    if (old.open) node.open = true;
    const stick = nearBottom();
    old.replaceWith(node);
    if (stick) scrollToBottom(true);
  } else {
    append(node);
  }
  ui.els.set(item.id, node);
}

// Streamed text is applied at most once per frame.
const dirty = new Set();
let deltaRaf = 0;
function applyDelta(id, text) {
  const item = ui.items.get(id) || { id, kind: 'text', text: '' };
  item.text = (item.text || '') + text;
  ui.items.set(id, item);
  dirty.add(id);
  deltaRaf ||= requestAnimationFrame(() => {
    deltaRaf = 0;
    for (const d of dirty) if (ui.items.has(d)) upsert(ui.items.get(d));
    dirty.clear();
  });
}

// ---------- live events ----------

function handleTurnEvent(ev) {
  if (ev.type === 'item') upsert(ev.item);
  else if (ev.type === 'delta') applyDelta(ev.id, ev.text);
  else if (ev.type === 'status') applyStatus(ev);
}

// Watching the open conversation's turn finish counts as reading it, so the
// chat doesn't show up as unread on this or any other device.
function markRead() {
  if (!ui.key) return;
  const s = ui.sessions.find((x) => x.key === ui.key);
  if (s?.unread) {
    s.unread = false;
    renderSessions();
  }
  api('/api/read', { key: ui.key, agent: ui.agent, sessionId: ui.sessionId, dir: ui.dir }).catch(() => {});
}

function applyStatus(st) {
  const wasRunning = ui.running;
  ui.pending = st.pending || [];
  setRunning(st.running);
  ui.mode = st.mode || null;
  if (st.mode && [...$('mode').options].some((o) => o.value === st.mode)) $('mode').value = st.mode;
  renderPending();
  if (wasRunning && !st.running) markRead();
}

function setRunning(running) {
  ui.running = running;
  $('stop').classList.toggle('hidden', !running);
  $('send').disabled = running;
  $('status').classList.remove('status-error');
  $('status').removeAttribute('role');
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
      if (ui.key === ev.oldKey) {
        ui.key = ev.key;
        ui.sessionId = ev.sessionId;
        writeHash();
      }
      if (ev.dir === ui.dir) loadSessions();
      return;
    }
    if (ev.type === 'model_changed') {
      if (ev.agent === ui.agent && ev.sessionId === ui.sessionId && !samePick(ev.model, ui.model)) {
        ui.model = ev.model;
        fillModels().then(() => modelNotice('Now using', 'changed on another device'));
      }
      return;
    }
    if (ev.type === 'sessions_changed') {
      if (ev.dir === ui.dir) loadSessions();
      return;
    }
    if (ev.type === 'status' && ev.dir === ui.dir) {
      // Keep running dots in the sidebar fresh for other conversations.
      const s = ui.sessions.find((x) => x.key === ev.key);
      if (s && s.running !== ev.running) {
        s.running = ev.running;
        renderSessions();
      } else if (!s && ev.running) {
        loadSessions();
      }
    }
    if (ui.key && ev.key === ui.key) handleTurnEvent(ev);
  };
  es.onerror = () => {
    // EventSource reconnects on its own; resync the open conversation when it does.
    es.onopen = () => {
      if (ui.key) openConversation(ui.agent, ui.sessionId || ui.key);
      loadSessions();
    };
  };
}

// ---------- permissions ----------

function renderPending() {
  const box = $('pending');
  box.innerHTML = '';
  if (ui.running) setRunning(true);
  for (const p of ui.pending) {
    const card = el('div', 'perm');
    if (p.kind === 'question') {
      renderQuestion(card, p);
    } else {
      card.appendChild(el('h4', '', p.title));
      if (p.reason) card.appendChild(el('div', 'muted', p.reason));
      const pre = el('pre');
      if (p.markdown) {
        pre.className = 'msg-assistant';
        pre.innerHTML = md(p.detail);
      } else {
        pre.textContent = p.detail || '';
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
        const why = prompt(`Tell ${agentLabel(ui.agent)} what to do instead (optional):`) ?? null;
        if (why === null) return;
        answer(p, { allow: false, message: why || undefined });
      };
      row.appendChild(deny);
      card.appendChild(row);
    }
    box.appendChild(card);
  }
}

// Answers go back as one list of chosen labels (or typed text) per question.
function renderQuestion(card, p) {
  if (p.title) card.appendChild(el('div', 'muted', p.title));
  const answers = p.questions.map(() => []);
  p.questions.forEach((q, qi) => {
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
        if (!q.multiple) picked.clear();
        picked.has(o.label) ? picked.delete(o.label) : picked.add(o.label);
        buttons.forEach((bb) => bb.el.classList.toggle('sel', picked.has(bb.label)));
        answers[qi] = [...picked];
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
      answers[qi] = other.value ? [other.value] : [];
    };
    opts.appendChild(other);
    wrap.appendChild(opts);
    card.appendChild(wrap);
  });
  const row = el('div', 'row');
  const ok = el('button', 'primary', 'Submit answers');
  ok.onclick = () => answer(p, { allow: true, answers });
  const skip = el('button', 'danger', 'Skip');
  skip.onclick = () => answer(p, { allow: false, message: 'The user skipped the question.' });
  row.append(ok, skip);
  card.appendChild(row);
}

async function answer(p, body) {
  try {
    await api('/api/permission', { key: ui.key, id: p.id, ...body });
  } catch (err) {
    alert(err.message);
  }
}

// ---------- agent & options ----------

function fillSelect(sel, entries, value) {
  sel.innerHTML = '';
  for (const [v, label] of entries) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = value;
  if (sel.value !== value) sel.value = entries[0]?.[0] ?? '';
}

async function loadOptions(agent) {
  if (!ui.options.has(agent)) ui.options.set(agent, api('/api/options?agent=' + encodeURIComponent(agent)));
  try {
    return await ui.options.get(agent);
  } catch (err) {
    ui.options.delete(agent);
    throw err;
  }
}

// Makes the composer offer `agent`'s modes, models and efforts. The agent can
// only be changed for a new conversation.
async function selectAgent(agent) {
  if (!ui.agents.some((a) => a.id === agent)) agent = ui.agents[0]?.id || 'claude';
  ui.agent = agent;
  $('agent').value = agent;
  $('agent').disabled = !!ui.key;
  $('input').placeholder = `Message ${agentLabel(agent)}…`;
  let o;
  try {
    o = await loadOptions(agent);
  } catch (err) {
    if (ui.agent !== agent) return;
    $('status').classList.add('status-error');
    $('status').setAttribute('role', 'alert');
    $('status').textContent = `${agentLabel(agent)} is unavailable: ${err.message}`;
    return;
  }
  if (ui.agent !== agent) return;
  $('status').classList.remove('status-error');
  $('status').removeAttribute('role');
  if (!ui.running) $('status').textContent = '';
  fillSelect($('mode'), o.modes.map((m) => [m.value, m.label]), ui.mode || o.defaultMode);
  fillModels();
  $('attach').classList.toggle('hidden', !o.images);
  $('toggle-usage').classList.toggle('hidden', !o.usage);
  if (!o.usage) $('usage').classList.add('hidden');
  else if (!$('usage').classList.contains('hidden')) loadUsage();
}

// An open chat keeps the model and effort stored for it on the server, so
// every device continues it the same way. A new chat starts with the ones
// last picked for a new chat in this browser.
function picked() {
  if (ui.key) return ui.model || { model: null, effort: null };
  return { model: localStorage.getItem('cw_model:' + ui.agent), effort: localStorage.getItem('cw_effort:' + ui.agent) };
}

const samePick = (a, b) => (a?.model || null) === (b?.model || null) && (a?.effort || null) === (b?.effort || null);

async function fillModels() {
  const agent = ui.agent;
  const o = await loadOptions(agent);
  if (ui.agent !== agent) return;
  fillSelect(
    $('model'),
    [['', o.defaultModel ? `Default (${o.defaultModel})` : 'Default model'], ...o.models.map((m) => [m.value, m.label])],
    picked().model || '',
  );
  await fillEfforts();
}

// Some agents have efforts per model, so this follows the model picker.
async function fillEfforts() {
  const agent = ui.agent;
  const o = await loadOptions(agent);
  if (ui.agent !== agent) return;
  const model = o.models.find((m) => m.value === $('model').value) || o.models.find((m) => m.label === o.defaultModel);
  const efforts = model?.efforts ? model.efforts.map((v) => [v, `${v[0].toUpperCase()}${v.slice(1)} effort`]) : o.efforts.map((e) => [e.value, e.label]);
  fillSelect(
    $('effort'),
    [['', o.defaultEffort ? `Default (${o.defaultEffort})` : 'Default effort'], ...efforts],
    picked().effort || '',
  );
  $('effort').classList.toggle('hidden', !efforts.length);
}

$('agent').addEventListener('change', () => {
  localStorage.setItem('cw_agent', $('agent').value);
  selectAgent($('agent').value);
});

// A change applies from the next message. In an open chat it is stored for
// the chat, and other devices showing it follow along; otherwise it is
// remembered in this browser for new chats.
async function pickChanged(before = ui.model) {
  const next = { model: $('model').value || null, effort: $('effort').value || null };
  if (!ui.key) {
    localStorage.setItem('cw_model:' + ui.agent, next.model || '');
    localStorage.setItem('cw_effort:' + ui.agent, next.effort || '');
    return;
  }
  if (samePick(next, before)) return;
  ui.model = next;
  modelNotice('Switched to', 'from the next message');
  if (ui.sessionId) {
    api('/api/model', { agent: ui.agent, sessionId: ui.sessionId, ...next }).catch((err) => alert(err.message));
  }
}

// A line in the transcript so a model switch is never silent.
function modelNotice(prefix, suffix) {
  let text = $('model').selectedOptions[0]?.textContent || 'Default model';
  if (!$('effort').classList.contains('hidden')) text += ' · ' + ($('effort').selectedOptions[0]?.textContent || 'Default effort');
  upsert({ id: 'model-' + randomId(), kind: 'notice', text: `${prefix} ${text} (${suffix})` });
}

$('model').addEventListener('change', async () => {
  const before = ui.model;
  // Keeps the effort if the new model offers it; fillEfforts falls back otherwise.
  if (ui.key) ui.model = { ...ui.model, model: $('model').value || null };
  await fillEfforts();
  pickChanged(before);
});
$('effort').addEventListener('change', () => pickChanged());

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

// ---------- image attachments ----------

const MAX_EDGE = 1568; // larger images are downscaled; the API resizes them anyway
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_ATTACH = 10;
const attachments = []; // { mediaType, data (base64), url }

const dataUrl = (img) => `data:${img.mediaType};base64,${img.data}`;

function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = '';
  box.classList.toggle('hidden', !attachments.length);
  attachments.forEach((a, i) => {
    const wrap = el('div', 'attachment');
    const img = el('img');
    img.src = dataUrl(a);
    const rm = el('button', '', '×');
    rm.type = 'button';
    rm.title = 'Remove';
    rm.addEventListener('click', () => {
      attachments.splice(i, 1);
      renderAttachments();
    });
    wrap.append(img, rm);
    box.appendChild(wrap);
  });
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Keeps small supported images as they are; otherwise redraws through a canvas.
async function prepareImage(file) {
  const supported = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type);
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (supported && file.size <= MAX_BYTES && (!bitmap || Math.max(bitmap.width, bitmap.height) <= MAX_EDGE)) {
    bitmap?.close();
    return { mediaType: file.type, data: (await readAsDataUrl(file)).split(',')[1] };
  }
  if (!bitmap) throw new Error(`Can't read ${file.name || 'that file'} as an image`);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  return { mediaType: 'image/jpeg', data: (await readAsDataUrl(out)).split(',')[1] };
}

async function addFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  for (const f of images) {
    if (attachments.length >= MAX_ATTACH) {
      alert(`At most ${MAX_ATTACH} images per message.`);
      break;
    }
    try {
      attachments.push(await prepareImage(f));
    } catch (err) {
      alert(err.message);
    }
  }
  renderAttachments();
}

$('attach').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  await addFiles($('file').files);
  $('file').value = '';
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.some((f) => f.type.startsWith('image/'))) {
    e.preventDefault();
    addFiles(files);
  }
});
$('composer').addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.types || [])].includes('Files')) {
    e.preventDefault();
    $('composer').classList.add('drag');
  }
});
$('composer').addEventListener('dragleave', () => $('composer').classList.remove('drag'));
$('composer').addEventListener('drop', (e) => {
  $('composer').classList.remove('drag');
  if (e.dataTransfer?.files?.length) {
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  }
});
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if ((!text && !attachments.length) || ui.running || !ui.dir) return;
  $('send').disabled = true;
  const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  const isNew = !ui.key;
  if (isNew) {
    // Our own temp key, so events sent before the reply already reach us.
    ui.key = 'new-' + randomId();
    ui.model = { model: $('model').value || null, effort: $('effort').value || null };
    $('agent').disabled = true;
    $('title').textContent = text.split('\n')[0].slice(0, 80) || '(image)';
  }
  try {
    await api('/api/send', {
      agent: ui.agent,
      sessionId: ui.sessionId,
      key: isNew ? ui.key : undefined,
      dir: ui.dir,
      text,
      images,
      mode: $('mode').value,
      model: $('model').value || undefined,
      effort: $('effort').value || undefined,
    });
    if (isNew) loadSessions();
    setRunning(true);
    input.value = '';
    attachments.length = 0;
    renderAttachments();
    autosize();
  } catch (err) {
    if (isNew) {
      ui.key = null;
      $('agent').disabled = false;
    }
    alert(err.message);
    $('send').disabled = false;
  }
});

$('stop').addEventListener('click', () => api('/api/interrupt', { key: ui.key }).catch(() => {}));

$('mode').addEventListener('change', () => {
  if (ui.key) api('/api/mode', { key: ui.key, mode: $('mode').value }).catch(() => {});
});

// ---------- usage ----------

function usageRow(label, pct, resetsAt) {
  const row = el('div', 'u-row');
  row.appendChild(el('span', 'u-label', label));
  const bar = el('div', 'u-bar');
  const fill = el('div', 'u-fill');
  const v = Math.max(0, Math.min(100, pct ?? 0));
  fill.style.width = v + '%';
  if (v >= 90) fill.classList.add('hot');
  bar.appendChild(fill);
  row.appendChild(bar);
  const reset = resetsAt ? ' · resets ' + new Date(resetsAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  row.appendChild(el('span', 'u-pct', Math.round(v) + '%' + reset));
  return row;
}

async function loadUsage() {
  const box = $('usage');
  box.textContent = 'Loading usage…';
  try {
    const u = await api('/api/usage?agent=' + encodeURIComponent(ui.agent));
    box.innerHTML = '';
    box.appendChild(el('div', 'u-head', `${agentLabel(ui.agent)} · ${u.plan ? 'Plan: ' + u.plan : 'API key / no plan limits'}`));
    for (const l of u.limits) box.appendChild(usageRow(l.label, l.percent, l.resetsAt));
    if (!u.limits.length) box.appendChild(el('div', 'muted', 'Plan rate limits are not available for this login.'));
  } catch (err) {
    box.textContent = 'Could not load usage: ' + err.message;
  }
}

$('toggle-usage').addEventListener('click', () => {
  const box = $('usage');
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) loadUsage();
});

// ---------- boot ----------

async function start() {
  const me = await api('/api/me');
  $('app').classList.remove('hidden');
  $('host').textContent = 'Host: ' + me.host;
  ui.agents = await api('/api/agents');
  const sel = $('agent');
  sel.innerHTML = '';
  for (const a of ui.agents) sel.appendChild(Object.assign(document.createElement('option'), { value: a.id, textContent: a.label }));
  sel.classList.toggle('hidden', ui.agents.length < 2);
  const projects = await loadProjects();
  const h = readHash();
  const dir = h.dir || projects[0]?.dir;
  if (dir) setProject(dir);
  await loadSessions();
  if (h.s) await openConversation(h.agent, h.s);
  else newConversation();
  connectEvents();
}

start().catch((err) => {
  if (err.message !== 'login required') alert(err.message);
});
