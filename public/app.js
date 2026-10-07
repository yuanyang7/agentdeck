'use strict';

const $ = (id) => document.getElementById(id);

const ui = {
  dir: null,
  agent: null, // agent of the open conversation, or the one a new one will use
  key: null, // live key: 'agent:sessionId', or a temp 'new-…' key while starting
  sessionId: null,
  running: false,
  mode: null, // mode reported by the live conversation, if any
  settings: null, // { model, effort, mode, dirs } the open chat uses, as stored on the server
  draftDirs: [], // extra folders picked for a new chat before its first message
  ask: false, // "Just ask": a new chat whose project is picked from the message (see /api/route)
  pending: [],
  queue: [], // messages waiting for the running turn: [{ id, text, images (count) }]
  tasks: [], // the running turn's background tasks: [{ id, type, description }]
  sessions: [],
  projects: [],
  expandedWorkspace: null,
  shownCount: 0, // chats listed in the expanded workspace; grows by SHOW_MORE_STEP
  tagFilter: null, // tag whose chats the sidebar lists from every workspace, or null
  agents: [], // [{ id, label }] available on the host
  options: new Map(), // agent -> composer options from the server
  items: new Map(), // id -> transcript item (see lib/items.mjs)
  els: new Map(), // id -> rendered element
  imagePaths: new Set(), // absolute image paths the agent's tools touched
};
let pendingAnnouncementTimer = 0;

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
  if (res.status === 401 && data.needApproval) {
    showPairing();
    throw new Error('not approved');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

// ---------- url state ----------

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  // Links from before there were several agents have no `a`; those are Claude.
  // `prompt` comes from tools that hand a task over (e.g. demoreel's dashboard):
  // it fills a new chat's composer and is never sent on its own.
  return { dir: h.get('dir'), agent: h.get('a') || 'claude', s: h.get('s'), prompt: h.get('prompt') };
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

// ---------- device approval ----------

// A browser the host hasn't approved yet shows a code and waits until an
// approved device or the host's terminal approves it, then reloads.
let pairTimer = 0;
const dashed = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;

async function showPairing() {
  if (!$('login').classList.contains('hidden')) return;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  try {
    let s = await api('/api/pair');
    if (s.status === 'none') s = await api('/api/pair', {});
    renderPairing(s);
  } catch (err) {
    pairFailed(err);
  }
}

function renderPairing(s) {
  clearTimeout(pairTimer);
  if (s.status === 'approved') return location.reload();
  const waiting = s.status === 'waiting';
  $('pair-status').textContent = waiting
    ? 'To let this device in, type this code on a device that already uses agentdeck:'
    : s.status === 'denied' ? 'This device was denied.'
    : s.status === 'removed' ? 'This device was removed from agentdeck.'
    : 'The request expired.';
  $('pair-code').textContent = waiting ? dashed(s.code) : '';
  $('pair-code').classList.toggle('hidden', !waiting);
  $('pair-hint').classList.toggle('hidden', !waiting);
  $('pair-again').classList.toggle('hidden', waiting);
  $('pair-password').classList.toggle('hidden', !s.password);
  if (waiting) pairTimer = setTimeout(checkPairing, 3000);
}

function pairFailed(err) {
  $('pair-status').textContent = '';
  $('pair-again').classList.remove('hidden');
  $('login-error').textContent = err.message;
}

async function checkPairing() {
  try {
    renderPairing(await api('/api/pair'));
  } catch {
    pairTimer = setTimeout(checkPairing, 5000); // the host may be restarting
  }
}

$('pair-again').addEventListener('click', async () => {
  $('login-error').textContent = '';
  try {
    renderPairing(await api('/api/pair', {}));
  } catch (err) {
    pairFailed(err);
  }
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('/api/login', { password: $('password').value });
    location.reload();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

// ---------- projects & sessions ----------

let projectLoadSeq = 0;
async function loadProjects() {
  const seq = ++projectLoadSeq;
  const projects = await api('/api/projects');
  if (seq !== projectLoadSeq) return ui.projects;
  ui.projects = projects;
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
  if (ui.dir) setProject(ui.dir);
  renderSessions();
  return projects;
}

function setProject(dir) {
  const changed = dir !== ui.dir;
  ui.dir = dir;
  if (changed) loadProjectBar(); // the project bar follows the workspace
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
  const dir = ui.dir;
  const sessions = await api('/api/sessions?dir=' + encodeURIComponent(dir));
  if (dir !== ui.dir) return;
  ui.sessions = sessions;
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

// Tag editor: `draft` is this chat's tags while the dialog is open. Every
// change is saved at once, so closing the dialog any way keeps it.
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
      saveTags();
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
      saveTags();
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
  if (!t || hasTag(tagEd.draft, t)) return;
  tagEd.draft.push(t);
  renderTagEditor();
  saveTags();
}

// Saves run one after another so a quick add-then-remove lands in order.
let tagSaves = Promise.resolve();
function saveTags() {
  const s = tagEd.session;
  const tags = [...tagEd.draft];
  tagSaves = tagSaves.then(async () => {
    try {
      const r = await api('/api/tags', { agent: s.agent, sessionId: s.id, dir: s.dir, tags });
      s.tags = r.tags;
      renderSessions();
      loadProjects();
    } catch (err) {
      alert('Could not save tags: ' + err.message);
    }
  });
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

$('tag-form').addEventListener('submit', (e) => {
  e.preventDefault();
  addDraftTag(); // whatever is still in the input counts
  $('tag-dialog').close();
});

// A chip for every tag in use, counted across all workspaces. Picking one
// lists that tag's chats from every workspace, newest first.
function renderTags() {
  const box = $('tags');
  box.innerHTML = '';
  const tagged = ui.projects.flatMap((p) => p.tagged || []);
  const counts = new Map();
  for (const s of tagged) for (const t of s.tags) counts.set(t, (counts.get(t) || 0) + 1);
  // A tag removed from its last chat has no chip left to switch it off.
  if (ui.tagFilter && !counts.has(ui.tagFilter)) ui.tagFilter = null;
  box.classList.toggle('hidden', counts.size === 0);
  if (!counts.size) return;
  const title = el('div', 'sidebar-section-title', 'TAGS');
  title.appendChild(el('span', '', 'All workspaces'));
  const chips = el('div', 'tag-filter');
  for (const [t, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    const chip = el('button', 'tag' + (t === ui.tagFilter ? ' on' : ''), `${t} ${n}`);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', t === ui.tagFilter);
    chip.onclick = () => {
      ui.tagFilter = ui.tagFilter === t ? null : t;
      renderSessions();
    };
    chips.appendChild(chip);
  }
  box.append(title, chips);
  if (!ui.tagFilter) return;
  const list = el('ul', 'sessions');
  const matching = tagged.filter((s) => s.tags.includes(ui.tagFilter))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const s of matching) list.appendChild(sessionRow(s, true));
  box.appendChild(list);
}

// The sidebar lists a workspace's RECENT_COUNT newest chats (the server's
// `recent`); each "Show more" reveals SHOW_MORE_STEP more of them.
const RECENT_COUNT = 3;
const SHOW_MORE_STEP = 5;

function expandWorkspace(dir) {
  if (ui.expandedWorkspace !== dir) ui.shownCount = RECENT_COUNT + SHOW_MORE_STEP;
  ui.expandedWorkspace = dir;
}

function renderSessions() {
  const attention = $('attention');
  const workspaces = $('workspaces');
  attention.innerHTML = '';
  workspaces.innerHTML = '';
  const needsAttention = ui.projects.flatMap((p) => p.attention || []).sort((a, b) =>
    (b.pendingCount > 0) - (a.pendingCount > 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
  attention.classList.toggle('hidden', !needsAttention.length);
  if (needsAttention.length) {
    attention.appendChild(el('div', 'sidebar-section-title', 'NEEDS ATTENTION'));
    const list = el('ul', 'sessions');
    for (const s of needsAttention) list.appendChild(sessionRow(s, true));
    attention.appendChild(list);
  }
  renderTags();
  for (const p of ui.projects) {
    const section = el('section', 'workspace-group');
    const head = el('button', 'workspace-heading' + (p.dir === ui.dir ? ' selected' : ''));
    head.type = 'button';
    head.title = p.dir;
    const name = el('span', 'workspace-name', p.name);
    const counts = [];
    const pending = p.attention.filter((s) => s.pendingCount).length;
    const running = p.attention.filter((s) => s.running && !s.pendingCount).length;
    const unread = p.attention.filter((s) => s.unread && !s.pendingCount && !s.running).length;
    if (pending) counts.push(`${pending} decision${pending === 1 ? '' : 's'}`);
    if (running) counts.push(`${running} working`);
    if (unread) counts.push(`${unread} unread`);
    const detail = el('span', 'workspace-detail', counts.join(' · ') || `${p.sessions} conversation${p.sessions === 1 ? '' : 's'}`);
    head.append(name, detail);
    head.onclick = async () => {
      if (ui.dir !== p.dir) {
        setProject(p.dir);
        newConversation();
        await loadSessions();
      }
      if (ui.expandedWorkspace === p.dir) ui.expandedWorkspace = null;
      else expandWorkspace(p.dir);
      renderSessions();
    };
    section.appendChild(head);
    const expanded = ui.expandedWorkspace === p.dir && ui.dir === p.dir;
    const rows = expanded ? ui.sessions.slice(0, ui.shownCount) : [...p.recent];
    const total = expanded ? ui.sessions.length : p.sessions;
    const active = p.dir === ui.dir && ui.sessions.find((s) => s.key === ui.key);
    if (active && !rows.some((s) => s.key === active.key)) rows.push(active);
    const list = el('ul', 'sessions');
    for (const s of rows) list.appendChild(sessionRow(s));
    section.appendChild(list);
    const remaining = total - rows.length;
    const buttons = el('div', 'workspace-more-row');
    if (remaining > 0) {
      const more = el('button', 'workspace-more', remaining > SHOW_MORE_STEP
        ? `Show ${SHOW_MORE_STEP} more · ${remaining} left`
        : `Show ${remaining} more`);
      more.type = 'button';
      more.onclick = async () => {
        if (ui.dir !== p.dir) { setProject(p.dir); newConversation(); await loadSessions(); }
        if (expanded) ui.shownCount += SHOW_MORE_STEP;
        else expandWorkspace(p.dir);
        renderSessions();
      };
      buttons.appendChild(more);
    }
    if (expanded && p.sessions > RECENT_COUNT) {
      const less = el('button', 'workspace-more', 'Show recent only');
      less.type = 'button';
      less.onclick = () => { ui.expandedWorkspace = null; renderSessions(); };
      buttons.appendChild(less);
    }
    if (buttons.childElementCount) section.appendChild(buttons);
    workspaces.appendChild(section);
  }
}

function sessionRow(s, showWorkspace = false) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    if (s.key === ui.key && s.dir === ui.dir) li.classList.add('active');
    const t = document.createElement('div');
    t.className = 's-title';
    if (s.pendingCount) {
      const d = el('span', 'dot decision');
      d.title = 'Needs a decision';
      t.appendChild(d);
    } else if (s.running) {
      const d = el('span', 'dot' + (s.elsewhere ? ' elsewhere' : ''));
      d.title = s.elsewhere ? 'Working in another app' : 'Working';
      t.appendChild(d);
    } else if (s.unread && (s.key !== ui.key || s.dir !== ui.dir)) {
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
    meta.appendChild(document.createTextNode([showWorkspace && ui.projects.find((p) => p.dir === s.dir)?.name,
      s.pendingCount ? 'Needs decision' : s.elsewhere ? 'Working in another app' : s.running ? 'Working' : s.unread ? 'Finished · unread' : s.stopped ? 'Stopped mid-turn' : null,
      timeAgo(s.updatedAt), s.branch].filter(Boolean).join(' · ')));
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
      (async () => {
        if (ui.dir !== s.dir) { setProject(s.dir); await loadSessions(); }
        await openConversation(s.agent, s.id || s.key);
        if (keyboardFocus && !mobileSidebar.matches) document.querySelector('.sessions li.active')?.focus();
      })().catch((err) => alert(err.message));
    };
    li.onkeydown = (e) => {
      if (e.target !== li || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      li.click();
    };
    return li;
}

$('new-chat').addEventListener('click', () => {
  newConversation();
  setSidebarOpen(false);
  $('input').focus();
});

$('just-ask').addEventListener('click', () => {
  newConversation(true);
  setSidebarOpen(false);
  $('input').focus();
});

// Asks the server which project `text` is about and switches the page to
// it. Returns false when the task stays in the composer: no project fits,
// the guess was declined, or the call failed.
async function routeToProject(text) {
  $('status').textContent = 'Picking a project…';
  let r;
  try {
    r = await api('/api/route', { text });
  } catch (err) {
    $('status').textContent = '';
    alert(`Could not pick a project: ${err.message}\nPick a workspace and send it there.`);
    return false;
  }
  $('status').textContent = '';
  if (!ui.ask || ui.key) return false; // the page moved on meanwhile
  if (!r.dir) {
    alert(`Could not tell which project this is about.${r.reason ? ' ' + r.reason : ''}\nPick a workspace and send it there.`);
    return false;
  }
  if (r.confidence === 'low' && !confirm(`Not sure which project this is. Send it to ${r.name}?\n${r.reason}`)) return false;
  const changed = r.dir !== ui.dir;
  setProject(r.dir);
  ui.ask = false;
  $('just-ask').classList.remove('on');
  $('title').textContent = 'New conversation';
  $('subtitle').textContent = r.dir;
  if (changed) await loadSessions();
  upsert({ id: 'route-' + randomId(), kind: 'notice', text: `Sent to ${r.name} (${r.confidence} confidence, ${r.model}): ${r.reason}` });
  return true;
}

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
  forgetMoveOffers();
  $('messages').innerHTML = '';
  ui.items.clear();
  ui.els.clear();
  ui.imagePaths.clear();
  ui.mode = null;
  ui.pending = [];
  ui.queue = [];
  ui.tasks = [];
  clearTimeout(pendingAnnouncementTimer);
  $('announcement').textContent = '';
  renderPending();
  renderQueue();
  renderTasks();
}

// With `ask`, the chat has no workspace yet: the first message is routed to
// the project it is about and sent there (see the composer's submit).
function newConversation(ask = false) {
  ui.key = null;
  ui.sessionId = null;
  ui.running = false;
  ui.draftDirs = [];
  ui.ask = !!ask;
  $('just-ask').classList.toggle('on', ui.ask);
  renderFolders();
  resetView();
  $('messages').innerHTML = '';
  const empty = el('div', 'empty');
  const mark = el('img', 'empty-mark');
  mark.src = '/agentdeck-icon.png';
  mark.alt = '';
  empty.appendChild(mark);
  empty.appendChild(el('h2', '', ui.ask ? 'What needs doing?' : 'What are we building today?'));
  const intro = el('p');
  if (ui.ask) {
    intro.append('Describe the task. A quick model call picks the ');
    intro.appendChild(el('span', 'empty-project', 'project'));
    intro.append(' and the work starts there.');
  } else {
    intro.append('Start a conversation in ');
    intro.appendChild(el('span', 'empty-project', ui.dir?.split('/').pop() || 'this project'));
    intro.append('.');
  }
  empty.appendChild(intro);
  $('messages').appendChild(empty);
  $('title').textContent = ui.ask ? 'Just ask' : 'New conversation';
  $('subtitle').textContent = ui.ask ? 'Project picked from your message' : ui.dir || '';
  selectAgent(localStorage.getItem('cw_agent'));
  setRunning(false);
  renderSessions();
  writeHash();
}

// `id` is a session id, or the temp key of a conversation that is starting.
async function openConversation(agent, id) {
  const dir = ui.dir;
  const temp = id.startsWith('new-');
  ui.key = temp ? id : `${agent}:${id}`;
  ui.sessionId = temp ? null : id;
  ui.settings = null;
  ui.ask = false;
  $('just-ask').classList.remove('on');
  renderFolders();
  const key = ui.key;
  resetView();
  selectAgent(agent);
  writeHash();
  renderSessions();
  const s = ui.sessions.find((x) => x.key === key);
  $('title').textContent = s?.title || 'Conversation';
  $('subtitle').textContent = ui.dir;

  const data = await api(`/api/sessions/${agent}/${encodeURIComponent(id)}?dir=${encodeURIComponent(dir)}`);
  if (ui.key !== key || ui.dir !== dir) return;
  if (s?.unread) {
    s.unread = false; // the GET above marked the chat read on the server
    renderSessions();
  }
  // Chats the server knows nothing about show the agent's defaults.
  ui.settings = data.settings || { model: null, effort: null, mode: null, dirs: [] };
  fillPickers();
  renderFolders();
  updateForkable();
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

// Markdown images, videos and audio that point at files on the host (an absolute
// path, a file:// URL or a path relative to the project) can't load in another
// device's browser, so they're fetched through the server instead. This runs
// before DOMPurify's URL check, which would drop file:// URLs.
function hostFile(src) {
  if (/^(https?:|data:|blob:|\/api\/)/i.test(src)) return src;
  let file = src;
  if (/^file:\/\//i.test(src)) {
    try {
      file = decodeURIComponent(new URL(src).pathname);
    } catch {
      return src;
    }
  } else if (/^[a-z][\w+.-]*:/i.test(src)) {
    return src;
  } else if (!src.startsWith('/')) {
    if (!ui.dir) return src;
    file = ui.dir + '/' + src.replace(/^\.\//, '');
  }
  return '/api/file?path=' + encodeURIComponent(file);
}

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (/^(IMG|VIDEO|AUDIO|SOURCE)$/.test(node.nodeName) && data.attrName === 'src') data.attrValue = hostFile(data.attrValue.trim());
});

// Image, video and audio files a reply mentions by name, e.g.
// `web-1-entry.png`, /tmp/shots/demo.mp4 or out/narration.mp3, get thumbnails
// or players under the paragraph or list item that mentions them. Bare names
// are matched against paths the agent's tools used earlier in the chat; paths
// with a folder are taken relative to the project.
const MEDIA_EXT = '(?:png|jpe?g|gif|webp|svg|avif|bmp|mp4|m4v|mov|webm|mp3|m4a|aac|wav|ogg|oga|opus|flac)';
const ABSOLUTE_IMAGE = new RegExp(`~?/[^\\s"'\`<>()[\\]{}|;,\\\\]*\\.${MEDIA_EXT}\\b`, 'gi');
const MENTIONED_IMAGE = new RegExp(`(?:~/|\\.{0,2}/)?[\\w.@+-]+(?:/[\\w.@+-]+)*\\.${MEDIA_EXT}\\b`, 'gi');
const VIDEO_FILE = /\.(?:mp4|m4v|mov|webm)$/i;
const AUDIO_FILE = /\.(?:mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
const MAX_MENTIONED = 24;

function rememberImagePaths(item) {
  if (item.kind !== 'tool') return;
  for (const m of (item.detail || '').matchAll(ABSOLUTE_IMAGE)) ui.imagePaths.add(m[0]);
}

function resolveMention(name) {
  if (name.startsWith('/') || name.startsWith('~/')) return name;
  const rel = name.replace(/^\.\//, '');
  for (const known of ui.imagePaths) if (known.endsWith('/' + rel)) return known;
  return rel.includes('/') && ui.dir ? ui.dir + '/' + rel : null;
}

function addMentionedImages(root) {
  const seen = new Set([...root.querySelectorAll('img, video, audio')].map((m) => m.getAttribute('src')));
  const byBlock = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode()); ) {
    if (node.parentElement.closest('pre, a')) continue;
    for (const m of node.data.matchAll(MENTIONED_IMAGE)) {
      const file = resolveMention(m[0]);
      const src = file && '/api/file?path=' + encodeURIComponent(file);
      if (!src || seen.has(src) || seen.size >= MAX_MENTIONED) continue;
      seen.add(src);
      const block = node.parentElement.closest('li, p, td, th, h1, h2, h3, h4, h5, h6, blockquote') || root;
      if (!byBlock.has(block)) byBlock.set(block, []);
      byBlock.get(block).push(src);
    }
  }
  for (const [block, images] of byBlock) {
    const row = imageRow(images, { quiet: true });
    row.classList.add('mentioned');
    if (block === root || block.matches('li, td, th, blockquote')) block.appendChild(row);
    else block.after(row);
  }
}

// Shell code blocks in a reply (```bash, ```sh, ```console, …) get a Run
// button. A console block's commands are its `$ ` lines; the rest is output.
const SHELL_BLOCK = /\blanguage-(?:bash|sh|zsh|shell|console|shellsession|terminal)\b/;

function shellCommand(text) {
  const lines = text.replace(/\n$/, '').split('\n');
  const prompted = lines.filter((l) => /^\$ /.test(l));
  return (prompted.length ? prompted.map((l) => l.slice(2)) : lines).join('\n').trim();
}

function addRunButtons(root) {
  for (const code of root.querySelectorAll('pre > code')) {
    if (!SHELL_BLOCK.test(code.className)) continue;
    const command = shellCommand(code.textContent);
    if (!command) continue;
    const pre = code.parentElement;
    const wrap = el('div', 'code-block');
    pre.replaceWith(wrap);
    const b = el('button', 'code-run', 'Run');
    b.type = 'button';
    b.title = 'Run this on the host, in the chat\'s folder';
    b.onclick = () => runSnippet(b, command);
    wrap.append(pre, b);
  }
}

// Asks first, since a reply can say anything, then runs it like a quick
// action and shows what it printed in a card above the composer.
async function runSnippet(button, command) {
  const dir = ui.dir;
  if (!dir) return alert('Pick a workspace first; the command runs in its folder.');
  if (!confirm(`Run this in ${dir}?\n\n${command}`)) return;
  button.disabled = true;
  button.textContent = 'Running…';
  const first = command.split('\n')[0];
  const label = first.length > 48 ? first.slice(0, 47) + '…' : first;
  const card = { id: 'run:' + command, kicker: 'COMMAND', label };
  try {
    const r = await api('/api/run', { command, dir });
    const outcome = r.timedOut ? 'stopped after 60 s' : r.code === 0 ? 'done' : `failed (exit ${r.code})`;
    resultCard({ ...card, title: `${label} · ${outcome} · ${(r.ms / 1000).toFixed(1)} s`,
      output: r.output, failed: r.code !== 0 });
  } catch (err) {
    if (err.message !== 'not approved') resultCard({ ...card, title: `${label} · not run`, output: err.message, failed: true });
  } finally {
    button.disabled = false;
    button.textContent = 'Run';
  }
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

// Opens an image full size in a new tab. Data URLs can't be opened as a
// top-level page, so those are shown through a blob URL instead.
async function openImage(src) {
  if (!src.startsWith('data:')) return window.open(src, '_blank');
  const tab = window.open('', '_blank');
  const blob = await (await fetch(src)).blob();
  if (tab) tab.location.href = URL.createObjectURL(blob);
}

// 'video', 'audio' or 'image' for a src, judged by its file extension (for
// /api/file URLs, the extension of the host path).
function mediaKind(src) {
  if (src.startsWith('data:')) return /^data:(video|audio)\//.exec(src)?.[1] || 'image';
  try {
    const u = new URL(src, location.href);
    const file = u.pathname === '/api/file' ? u.searchParams.get('path') || '' : u.pathname;
    return VIDEO_FILE.test(file) ? 'video' : AUDIO_FILE.test(file) ? 'audio' : 'image';
  } catch {
    return 'image';
  }
}

const MEDIA_LABEL = { video: 'Video', audio: 'Audio', image: 'Image' };

// An inline video or audio player. `onMissing` runs if the file can't be
// loaded.
function playerEl(kind, src, onMissing) {
  const p = el(kind);
  p.src = src;
  p.controls = true;
  p.preload = 'metadata';
  if (kind === 'video') p.playsInline = true;
  p.addEventListener('error', () => onMissing?.(p));
  return p;
}

// Image thumbnails and video and audio players; click an image to open it
// full size. `quiet` drops files that fail to load instead of saying so
// (guessed paths may not exist).
function imageRow(images, { quiet = false } = {}) {
  const row = el('div', 'msg-images');
  const missing = (node, what) => {
    if (!quiet) return node.replaceWith(el('span', 'img-missing', `${what} not available`));
    node.remove();
    if (!row.children.length) row.remove();
  };
  for (const src of images) {
    const kind = mediaKind(src);
    if (kind !== 'image') {
      row.appendChild(playerEl(kind, src, (p) => missing(p, MEDIA_LABEL[kind])));
      continue;
    }
    const img = el('img');
    img.src = src;
    img.alt = '';
    img.addEventListener('click', () => openImage(src));
    img.addEventListener('error', () => missing(img, 'Image'));
    row.appendChild(img);
  }
  return row;
}

// Branches the conversation: the server copies it up to the end of this
// exchange into a new session of the same agent, which then opens. The copy
// is one of the agent's own sessions, so it continues in a terminal too.
async function forkFrom(itemId, button) {
  if (!ui.sessionId || ui.running) return;
  const agent = ui.agent;
  const from = $('title').textContent;
  const users = [...ui.items.values()].filter((i) => i.kind === 'user');
  const last = users[users.length - 1]?.id === itemId;
  button.disabled = true;
  try {
    const forked = await api('/api/fork', { agent, sessionId: ui.sessionId, dir: ui.dir, itemId });
    await loadProjects();
    await loadSessions();
    await openConversation(forked.agent, forked.sessionId);
    // Agents that can't fork at a point copy the whole conversation; say so
    // unless the fork was from the last message anyway.
    const whole = forked.whole && !last ? ` ${agentLabel(agent)} copies a whole conversation, so this one has every message.` : '';
    upsert({ id: 'fork-' + randomId(), kind: 'notice', text: `Forked from ${from}.${whole}` });
    scrollToBottom(true);
  } catch (err) {
    alert(err.message);
  } finally {
    button.disabled = false;
  }
}

// Whether the open chat can be forked right now: it has to be a session the
// agent has stored (not one still starting), the agent has to support it, and
// a running turn's transcript is incomplete. Drives the fork controls' CSS.
async function updateForkable() {
  // Moving has the same conditions, minus the agent's options.
  $('move-chat').classList.toggle('hidden', !(ui.sessionId && !ui.running && ui.agents.find((a) => a.id === ui.agent)?.move));
  const agent = ui.agent;
  const o = agent ? await loadOptions(agent).catch(() => null) : null;
  if (ui.agent !== agent) return;
  $('messages').classList.toggle('can-fork', !!(o?.fork && ui.sessionId && !ui.running));
}

// ---------- moving a chat ----------

// Moving a chat to another workspace: the dialog shows exactly what moves
// where, and only its Move button sends the request, so a chat never moves
// without the user agreeing to it. `suggested` preselects a folder (a
// project the chat just made).
const mover = { chat: null };

function openMoveDialog(suggested) {
  if (!ui.sessionId || ui.running) return;
  mover.chat = { agent: ui.agent, sessionId: ui.sessionId, key: ui.key, dir: ui.dir, title: $('title').textContent };
  const projects = ui.projects.filter((p) => p.dir !== ui.dir);
  const options = [['', 'Pick a workspace…'], ...projects.map((p) => [p.dir, p.inRoot ? p.name : p.dir]), ['__other__', 'Other folder…']];
  if (suggested && !projects.some((p) => p.dir === suggested)) options.splice(1, 0, [suggested, suggested]);
  fillSelect($('move-to'), options, suggested || '');
  $('move-error').textContent = '';
  renderMoveConfirm();
  $('move-dialog').showModal();
  $('move-to').focus();
}

function renderMoveConfirm() {
  const to = $('move-to').value;
  const ready = !!to && to !== '__other__';
  $('move-submit').disabled = !ready;
  $('move-confirm').classList.toggle('hidden', !ready);
  if (!ready) return;
  const c = mover.chat;
  $('move-confirm').replaceChildren(
    'Move ', el('strong', '', c.title), ` (${agentLabel(c.agent)}) from `, el('code', '', c.dir), ' to ', el('code', '', to), '?',
  );
}

$('move-to').addEventListener('change', () => {
  if ($('move-to').value === '__other__') {
    const d = prompt('Absolute path of the folder on the host:', '')?.trim().replace(/(.)\/+$/, '$1');
    if (d && d !== mover.chat.dir) {
      const o = Object.assign(document.createElement('option'), { value: d, textContent: d });
      $('move-to').insertBefore(o, $('move-to').lastChild);
      $('move-to').value = d;
    } else {
      $('move-to').value = '';
    }
  }
  $('move-error').textContent = '';
  renderMoveConfirm();
});

$('move-cancel').addEventListener('click', () => $('move-dialog').close());
$('move-chat').addEventListener('click', () => openMoveDialog());

$('move-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = mover.chat;
  const to = $('move-to').value;
  if (!c || !to || to === '__other__') return;
  $('move-submit').disabled = true;
  mover.moving = c.key; // its chat_moved event is for other pages
  try {
    const r = await api('/api/move', { agent: c.agent, sessionId: c.sessionId, dir: c.dir, to, confirmed: true });
    $('move-dialog').close();
    await followMove(c, r.sessionId, r.dir, 'Moved');
  } catch (err) {
    $('move-error').textContent = err.message;
    $('move-submit').disabled = false;
  } finally {
    mover.moving = null;
  }
});

// The open chat moved, here or on another device: reopen it in its new
// workspace with a line saying so. `sessionId` is its id there, which is a
// new one for Codex.
async function followMove(chat, sessionId, to, verb) {
  dismissMoveOffers(chat.key);
  if (ui.key !== chat.key) return scheduleSidebarRefresh();
  setProject(to);
  await loadProjects();
  await loadSessions();
  await openConversation(chat.agent, sessionId);
  upsert({ id: 'moved-' + randomId(), kind: 'notice', text: `${verb} from ${chat.dir} to ${to}` });
  scrollToBottom(true);
}

// After a turn that made a new project, offer to move the chat there. Each
// offer shows once per chat on this page; Move opens the dialog above.
const moveOffers = new Set();

function offerMove(created) {
  for (const dir of created || []) {
    const id = `move-offer:${ui.key}:${dir}`;
    if (moveOffers.has(id)) continue;
    moveOffers.add(id);
    resultCard({
      id,
      kicker: 'New project',
      label: 'Move suggestion',
      title: `This chat made ${dir.split('/').pop()}`,
      output: dir,
      note: 'Move the chat there so it is listed with that project and continues in its folder?',
      action: { text: 'Move…', onclick: (card) => { card.remove(); openMoveDialog(dir); } },
    });
  }
}

// Leaving the chat takes its offers away; they come back when it is opened
// again, unless they were dismissed.
function forgetMoveOffers() {
  for (const card of [...$('action-results').children]) {
    if (!String(card.actionId).startsWith('move-offer:')) continue;
    moveOffers.delete(card.actionId);
    card.remove();
  }
}

function dismissMoveOffers(key) {
  for (const card of [...$('action-results').children]) if (String(card.actionId).startsWith(`move-offer:${key}:`)) card.remove();
}

// A user bubble: optional image thumbnails and text, with a fork control
// beside it.
function userBubble(id, text, images) {
  const d = el('div', 'msg-user');
  if (images.length) d.appendChild(imageRow(images));
  if (text) d.appendChild(el('div', 'msg-text', text));
  const row = el('div', 'msg-user-row');
  const fork = el('button', 'msg-fork', '⑂');
  fork.type = 'button';
  fork.title = 'Fork: a new conversation copied up to the end of this exchange';
  fork.setAttribute('aria-label', 'Fork the conversation from this message');
  fork.onclick = () => forkFrom(id, fork);
  row.append(fork, d);
  return row;
}

const TOOL_STATE = { running: '…', done: 'done', error: 'error' };

// `streaming`: a reply still being typed, redrawn every frame.
function renderItem(item, streaming) {
  switch (item.kind) {
    case 'user':
      return userBubble(item.id, item.text || '', item.images || []);
    case 'text': {
      const d = el('div', 'msg-assistant');
      d.innerHTML = md(item.text);
      for (const img of d.querySelectorAll('img')) {
        // ![demo](clip.mp4) and ![voice](take.mp3) play inline.
        const kind = mediaKind(img.getAttribute('src') || '');
        if (kind !== 'image') {
          img.replaceWith(playerEl(kind, img.getAttribute('src'), (p) => p.replaceWith(el('span', 'img-missing', `${MEDIA_LABEL[kind]} not available`))));
          continue;
        }
        if (img.closest('a')) continue;
        img.addEventListener('click', () => openImage(img.src));
      }
      if (!streaming) {
        addMentionedImages(d);
        addRunButtons(d);
      }
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
      if (!item.images?.length) return d;
      // Pictures the tool returned stay visible while the card is collapsed.
      const wrap = el('div', 'tool-wrap');
      wrap.append(d, imageRow(item.images));
      return wrap;
    }
    case 'notice':
      return el('div', 'result-line' + (item.error ? ' err' : ''), item.text);
  }
  return el('div', 'hidden');
}

// Adds an item, or merges it into the one with the same id and redraws that
// in place. `replaces` swaps out an earlier item (a streamed draft).
function upsert(patch, streaming) {
  const item = { ...ui.items.get(patch.id), ...patch };
  let old = ui.els.get(item.id);
  if (item.replaces) {
    // The draft may not be drawn yet (its frame is still pending); forgetting
    // it here keeps that frame from drawing it after its replacement.
    const draft = ui.els.get(item.replaces);
    ui.els.delete(item.replaces);
    ui.items.delete(item.replaces);
    dirty.delete(item.replaces);
    if (draft && old) draft.remove();
    else if (draft) old = draft;
  }
  ui.items.set(item.id, item);
  rememberImagePaths(item);
  const node = renderItem(item, streaming);
  if (old) {
    const card = (n) => (n.matches('.tool-wrap') ? n.firstChild : n);
    if (card(old).open) card(node).open = true;
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
    for (const d of dirty) if (ui.items.has(d)) upsert(ui.items.get(d), true);
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
  scheduleSidebarRefresh();
}

function applyStatus(st) {
  const wasRunning = ui.running;
  const previous = new Set(ui.pending.map((p) => p.id));
  const next = st.pending || [];
  const added = next.filter((p) => !previous.has(p.id)).length;
  const removed = ui.pending.filter((p) => !next.some((n) => n.id === p.id)).length;
  if (added || removed) {
    const changes = [];
    if (added) changes.push(`${added} new approval ${added === 1 ? 'request' : 'requests'}.`);
    if (removed) changes.push(`${removed} approval ${removed === 1 ? 'request' : 'requests'} resolved.`);
    announcePending(`${changes.join(' ')} ${next.length ? `${next.length} pending. Use Review to open.` : 'No requests pending.'}`);
  }
  ui.pending = next;
  ui.queue = st.queue || [];
  renderQueue();
  ui.tasks = st.tasks || [];
  renderTasks();
  setRunning(st.running);
  ui.mode = st.mode || null;
  if (st.mode && [...$('mode').options].some((o) => o.value === st.mode)) $('mode').value = st.mode;
  renderPending();
  if (wasRunning && !st.running) markRead();
  if (!st.running && ui.sessionId) offerMove(st.created);
}

function announcePending(message) {
  clearTimeout(pendingAnnouncementTimer);
  $('announcement').textContent = '';
  pendingAnnouncementTimer = setTimeout(() => { $('announcement').textContent = message; }, 50);
}

function setRunning(running) {
  ui.running = running;
  $('stop').classList.toggle('hidden', !running);
  // While a turn runs, sending queues the message for after it.
  $('send').firstChild.textContent = running ? 'Queue ' : 'Send ';
  $('send').title = running ? 'Runs after the current turn finishes' : '';
  $('input').placeholder = ui.ask && !running ? `Describe a task for ${agentLabel(ui.agent)}; the project is picked for you…` : `${running ? 'Queue a message for' : 'Message'} ${agentLabel(ui.agent)}…`;
  $('status').classList.remove('status-error');
  $('status').removeAttribute('role');
  $('status').innerHTML = '';
  if (running && !ui.pending.length) {
    const d = el('span', 'dot');
    $('status').append(d, document.createTextNode('Working…'));
  }
  updateForkable();
}

let sidebarRefreshTimer = 0;
function scheduleSidebarRefresh() {
  clearTimeout(sidebarRefreshTimer);
  sidebarRefreshTimer = setTimeout(async () => {
    try {
      await loadProjects();
      await loadSessions();
    } catch (err) { console.error('Could not refresh sidebar:', err); }
  }, 150);
}

function connectEvents() {
  const es = new EventSource('/api/events');
  // Requests that arrived while the stream was down.
  es.addEventListener('open', () => loadDevices().catch(() => {}));
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'session_bound') {
      soundKeyBound(ev.oldKey, ev.key);
      if (ui.key === ev.oldKey) {
        ui.key = ev.key;
        ui.sessionId = ev.sessionId;
        writeHash();
        updateForkable();
      }
      scheduleSidebarRefresh();
      return;
    }
    if (ev.type === 'settings_changed') {
      if (ev.agent === ui.agent && ev.sessionId === ui.sessionId) {
        const picks = !samePick(ev.settings, ui.settings);
        // Folders also change when a folder prompt is answered.
        const folders = !sameDirs(ev.settings.dirs, ui.settings?.dirs);
        if (picks || folders) ui.settings = ev.settings;
        if (picks) fillPickers().then(() => settingsNotice('Now using', 'changed on another device'));
        if (folders) {
          renderFolders();
          folderNotice();
        }
      }
      return;
    }
    if (ev.type === 'sessions_changed') {
      scheduleSidebarRefresh();
      return;
    }
    if (ev.type === 'chat_moved') {
      const key = `${ev.agent}:${ev.sessionId}`;
      if (mover.moving === key) return;
      if (ui.key === key && ui.dir !== ev.to) {
        followMove({ agent: ev.agent, sessionId: ev.sessionId, key, dir: ev.from }, ev.newSessionId, ev.to, 'Moved on another device').catch((err) => alert(err.message));
      } else dismissMoveOffers(key);
      return;
    }
    if (ev.type === 'devices_changed') {
      loadDevices().catch(() => {});
      return;
    }
    if (ev.type === 'actions_changed') {
      loadActions().catch(() => {});
      return;
    }
    if (ev.type === 'restarting') {
      awaitRestart();
      return;
    }
    if (ev.type === 'status') {
      soundForStatus(ev);
      scheduleSidebarRefresh();
    }
    if (ui.key && ev.key === ui.key) handleTurnEvent(ev);
  };
  es.onerror = () => {
    // Refused rather than dropped, as when this device was removed: api()
    // then shows the approval screen.
    if (es.readyState === EventSource.CLOSED) {
      api('/api/me').catch(() => {});
      return;
    }
    // EventSource reconnects on its own; resync the open conversation when it does.
    es.onopen = () => {
      if (ui.key) openConversation(ui.agent, ui.sessionId || ui.key);
      scheduleSidebarRefresh();
    };
  };
}

// ---------- notification sounds ----------

// A short chime marks a conversation finishing a turn, and a different one an
// approval request arriving. Both play for every conversation on the host, not
// just the open one, so a chat left running in another workspace still calls
// out. The tones are synthesized, so there's no audio file to load, and the
// bell button mutes them on this device only.
const CHIMES = {
  reply: [[659.25, 0], [987.77, 0.1]], // E5 → B5: a soft "that's done"
  ask: [[880, 0], [880, 0.18]], // A5 twice: more insistent, needs an answer
};

let soundOn = localStorage.getItem('cw_sound') !== 'off';
let audio = null;

// Browsers only let audio start from a user gesture, and suspend the context
// again when a phone locks or the tab goes to sleep, so every click and
// keypress wakes it up.
function unlockAudio() {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state !== 'running') audio.resume().catch(() => {});
  } catch { /* no Web Audio: the page just stays silent */ }
}
document.addEventListener('pointerdown', unlockAudio, true);
document.addEventListener('keydown', unlockAudio, true);

function playChime(kind) {
  if (!soundOn || audio?.state !== 'running') return;
  for (const [freq, at] of CHIMES[kind]) {
    const t = audio.currentTime + at;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Without the ramps the tone clicks as it starts and stops.
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.16, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  }
}

// conversation key -> what its last status said, so a sound marks a change
// rather than every status event.
const heard = new Map();

// A new conversation's events move from its temp key to the real one.
function soundKeyBound(oldKey, key) {
  const was = heard.get(oldKey);
  heard.delete(oldKey);
  if (was && !heard.has(key)) heard.set(key, was);
}

function soundForStatus(ev) {
  const pending = (ev.pending || []).length;
  // A key first seen here was already working: it either just started or was
  // running before this browser connected.
  const was = heard.get(ev.key) || { running: true, pending: 0 };
  heard.set(ev.key, { running: !!ev.running, pending });
  if (pending > was.pending) playChime('ask');
  else if (was.running && !ev.running) playChime('reply');
}

function renderSoundButton() {
  const b = $('toggle-sound');
  b.firstChild.textContent = soundOn ? '🔔' : '🔕';
  b.classList.toggle('off', !soundOn);
  b.setAttribute('aria-pressed', String(soundOn));
  b.title = soundOn ? 'Notification sound on' : 'Notification sound off';
  b.setAttribute('aria-label', b.title);
}

$('toggle-sound').addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('cw_sound', soundOn ? 'on' : 'off');
  renderSoundButton();
  if (soundOn) playChime('reply'); // so you hear what you just turned on
});
renderSoundButton();

// ---------- permissions ----------

function renderPending() {
  const box = $('pending');
  if (ui.running) setRunning(true);
  const jump = $('approval-jump');
  jump.classList.toggle('hidden', !ui.pending.length);
  if (ui.pending.length) jump.setAttribute('aria-label', `Review ${ui.pending.length} pending approval ${ui.pending.length === 1 ? 'request' : 'requests'}`);
  $('approval-count').textContent = ui.pending.length;
  $('approval-count').classList.toggle('hidden', ui.pending.length === 1);
  jump.querySelector('.approval-text').textContent = ui.pending.length === 1 ? 'Review request' : 'Review requests';
  const existing = new Map([...box.children].map((card) => [card.pendingId, card]));
  const cards = ui.pending.map((p) => {
    const snapshot = JSON.stringify(p);
    const card = existing.get(p.id);
    if (card?.pendingSnapshot === snapshot) return card;
    const replacement = makePendingCard(p);
    replacement.pendingId = p.id;
    replacement.pendingSnapshot = snapshot;
    return replacement;
  });
  const focusedCard = document.activeElement.closest?.('.perm');
  const restoreFocus = focusedCard && !cards.includes(focusedCard);
  for (const card of [...box.children]) if (!cards.includes(card)) card.remove();
  cards.forEach((card, i) => {
    if (box.children[i] !== card) box.insertBefore(card, box.children[i] || null);
  });
  if (restoreFocus) (cards[0] || $('input')).focus();
}

function makePendingCard(p) {
  const card = el('div', 'perm');
  card.tabIndex = -1;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', p.title || 'Approval request');
  card.appendChild(el('div', 'perm-kicker', 'ACTION REQUIRED'));
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
    // `choice` gives a yes/no question its own labels, with nothing to tell
    // the agent on "no".
    const allow = el('button', 'primary', p.choice?.allow || 'Allow');
    allow.onclick = () => answer(p, { allow: true });
    row.appendChild(allow);
    if (p.canAlways) {
      const always = el('button', '', 'Allow & don’t ask again');
      always.onclick = () => answer(p, { allow: true, always: true });
      row.appendChild(always);
    }
    const deny = el('button', p.choice ? '' : 'danger', p.choice?.deny || 'Deny');
    deny.onclick = () => {
      if (p.choice) return answer(p, { allow: false });
      const why = prompt(`Tell ${agentLabel(ui.agent)} what to do instead (optional):`) ?? null;
      if (why === null) return;
      answer(p, { allow: false, message: why || undefined });
    };
    row.appendChild(deny);
    card.appendChild(row);
  }
  return card;
}

$('approval-jump').addEventListener('click', () => {
  const box = $('pending');
  const card = box.querySelector('.perm');
  if (!card) return;
  box.scrollTop = 0;
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest' });
});

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

// ---------- queued messages ----------

// Messages sent while the agent works. They are kept on the server, so every
// device sees the same queue; each runs as its own turn once the one before
// it finishes.
function renderQueue() {
  const box = $('queue');
  box.innerHTML = '';
  if (!ui.queue.length) return;
  box.appendChild(el('div', 'queue-head', `QUEUED · ${ui.queue.length}`));
  for (const m of ui.queue) {
    const row = el('div', 'queued');
    row.appendChild(el('div', 'queued-text', m.text || '(image)'));
    if (m.images) row.appendChild(el('span', 'queued-images', `+${m.images} image${m.images === 1 ? '' : 's'}`));
    const now = el('button', '', 'Send now');
    now.type = 'button';
    now.title = 'Stop the current turn and run this message next';
    now.onclick = () => api('/api/send-now', { key: ui.key, id: m.id }).catch((err) => alert(err.message));
    const edit = el('button', '', 'Edit');
    edit.type = 'button';
    edit.title = 'Take it out of the queue and back into the message box';
    edit.onclick = () => unqueue(m, true);
    const remove = el('button', '', '×');
    remove.type = 'button';
    remove.title = 'Remove from the queue';
    remove.setAttribute('aria-label', 'Remove from the queue');
    remove.onclick = () => unqueue(m, false);
    row.append(now, edit, remove);
    box.appendChild(row);
  }
}

// ---------- background tasks ----------

// Shells, monitors and subagents the agent left running while it carries on.
// They live in the agent's process, which exits when the turn ends, so they
// only outlast the reply by a few seconds.
const TASK_TYPES = { local_bash: 'Shell', monitor: 'Monitor', local_agent: 'Agent', remote_agent: 'Agent', local_workflow: 'Workflow' };

function renderTasks() {
  const box = $('tasks');
  box.innerHTML = '';
  if (!ui.tasks.length) return;
  const head = el('div', 'queue-head', `IN THE BACKGROUND · ${ui.tasks.length}`);
  head.title = 'Stopped when this turn ends';
  box.appendChild(head);
  for (const t of ui.tasks) {
    const row = el('div', 'queued task');
    row.appendChild(el('span', 'task-type', TASK_TYPES[t.type] || t.type || 'Task'));
    row.appendChild(el('div', 'queued-text', t.description || t.id));
    const stop = el('button', '', 'Stop');
    stop.type = 'button';
    stop.title = 'Stop this task; the turn goes on';
    stop.onclick = () => {
      stop.disabled = true;
      api('/api/stop-task', { key: ui.key, id: t.id }).catch((err) => {
        stop.disabled = false;
        alert(err.message);
      });
    };
    row.appendChild(stop);
    box.appendChild(row);
  }
}

async function unqueue(m, edit) {
  try {
    const message = await api('/api/unqueue', { key: ui.key, id: m.id });
    if (edit) restoreToComposer([message]);
  } catch (err) {
    alert(err.message);
  }
}

// Puts messages taken out of the queue back into the composer, after
// whatever is already typed there.
function restoreToComposer(messages) {
  const texts = messages.map((m) => m.text).filter(Boolean);
  if (texts.length) input.value = [input.value.trim(), ...texts].filter(Boolean).join('\n\n');
  for (const m of messages) {
    for (const img of m.images || []) if (attachments.length < MAX_ATTACH) attachments.push(img);
  }
  renderAttachments();
  autosize();
  input.focus();
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
  hideCommandMenu();
  $('agent').value = agent;
  $('agent').disabled = !!ui.key;
  $('input').placeholder = ui.ask ? `Describe a task for ${agentLabel(agent)}; the project is picked for you…` : `Message ${agentLabel(agent)}…`;
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
  fillPickers();
  $('toggle-usage').classList.toggle('hidden', !o.usage);
  if (!o.usage) $('usage').classList.add('hidden');
  else if (!$('usage').classList.contains('hidden')) loadUsage();
}

// An open chat keeps the model, effort and mode stored for it on the server,
// so every device continues it the same way. A new chat starts with the ones
// last picked for a new chat in this browser.
function picked() {
  if (ui.key) return ui.settings || { model: null, effort: null, mode: null };
  const get = (k) => localStorage.getItem(`cw_${k}:${ui.agent}`) || null;
  return { model: get('model'), effort: get('effort'), mode: get('mode') };
}

const PICKS = ['model', 'effort', 'mode'];
const samePick = (a, b) => PICKS.every((k) => (a?.[k] || null) === (b?.[k] || null));
const currentPick = () => ({ model: $('model').value || null, effort: $('effort').value || null, mode: $('mode').value || null, dirs: chatDirs() });

async function fillPickers() {
  const agent = ui.agent;
  const o = await loadOptions(agent);
  if (ui.agent !== agent) return;
  // A running turn reports the mode it is actually in.
  fillSelect($('mode'), o.modes.map((m) => [m.value, m.label]), ui.mode || picked().mode || o.defaultMode);
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

// A model or effort change applies from the next message; a mode change also
// to a running turn. In an open chat it is stored for the chat, and other
// devices showing it follow along; otherwise it is remembered in this browser
// for new chats.
async function pickChanged(before = ui.settings) {
  const next = currentPick();
  if (!ui.key) {
    for (const k of PICKS) localStorage.setItem(`cw_${k}:${ui.agent}`, next[k] || '');
    return;
  }
  if (samePick(next, before)) return;
  ui.settings = next;
  settingsNotice('Switched to', next.mode === before?.mode ? 'from the next message' : 'mode applies now');
  if (ui.sessionId) {
    api('/api/settings', { agent: ui.agent, sessionId: ui.sessionId, dir: ui.dir, ...next }).catch((err) => alert(err.message));
  }
}

// A line in the transcript so a switch is never silent.
function settingsNotice(prefix, suffix) {
  const label = (id) => $(id).selectedOptions[0]?.textContent || '';
  const parts = [label('model')];
  if (!$('effort').classList.contains('hidden')) parts.push(label('effort'));
  parts.push(label('mode'));
  upsert({ id: 'settings-' + randomId(), kind: 'notice', text: `${prefix} ${parts.filter(Boolean).join(' · ')} (${suffix})` });
}

// ---------- folders ----------

// Folders the chat may work in besides its own (see lib/folders.mjs). An open
// chat keeps them with its settings on the server; a new chat starts with
// none, plus any picked before its first message. A message naming another
// project also offers to add it, as a prompt on the server's side.
const chatDirs = () => (ui.key ? ui.settings?.dirs : ui.draftDirs) || [];
const folderName = (d) => d.split('/').filter(Boolean).pop() || d;
const sameDirs = (a, b) => (a || []).join('\n') === (b || []).join('\n');

function renderFolders() {
  const dirs = chatDirs();
  const b = $('folders');
  b.textContent = dirs.length ? `📁 ${folderName(dirs[0])}${dirs.length > 1 ? ` +${dirs.length - 1}` : ''}` : '📁 Folders';
  b.classList.toggle('on', dirs.length > 0);
  b.title = dirs.length ? `Also works in:\n${dirs.join('\n')}` : 'Let this chat work in other folders too';
  if ($('folder-dialog').open) renderFolderEditor();
}

function renderFolderEditor() {
  const dirs = chatDirs();
  $('folder-own').textContent = ui.dir ? folderName(ui.dir) : 'its own folder';
  const cur = $('folder-current');
  cur.innerHTML = '';
  if (!dirs.length) cur.appendChild(el('span', 'muted', 'No other folders yet'));
  for (const d of dirs) {
    const row = el('div', 'folder-row');
    const rm = el('button', 'tag-forget', '×');
    rm.type = 'button';
    rm.title = 'Remove';
    rm.setAttribute('aria-label', `Remove ${folderName(d)}`);
    rm.onclick = () => setDirs(dirs.filter((x) => x !== d));
    row.append(el('span', 'folder-name', folderName(d)), el('span', 'muted folder-path', d), rm);
    cur.appendChild(row);
  }
  // The projects under the project roots; any other folder by path.
  const projects = ui.projects.filter((p) => p.inRoot && p.dir !== ui.dir && !dirs.includes(p.dir));
  fillSelect($('folder-add'), [['', 'Add a project…'], ...projects.map((p) => [p.dir, p.name]), ['__other__', 'Other folder…']], '');
}

// A transcript line, so a change is never silent.
function folderNotice(suffix) {
  const dirs = chatDirs();
  const text = dirs.length ? `Also working in ${dirs.map(folderName).join(', ')}` : `Working in ${folderName(ui.dir || '')} only`;
  upsert({ id: 'folders-' + randomId(), kind: 'notice', text: suffix ? `${text} (${suffix})` : text });
}

// Applies from the next message. In an open chat it is saved for the chat
// right away, like the pickers, and put back if the server refuses it.
function setDirs(dirs) {
  if (!ui.key) {
    ui.draftDirs = dirs;
    renderFolders();
    return;
  }
  const before = ui.settings;
  ui.settings = { ...ui.settings, dirs };
  renderFolders();
  folderNotice('from the next message');
  if (!ui.sessionId) return;
  api('/api/settings', { agent: ui.agent, sessionId: ui.sessionId, dir: ui.dir, ...currentPick() }).catch((err) => {
    alert(err.message);
    if (ui.settings?.dirs === dirs) {
      ui.settings = before;
      renderFolders();
    }
  });
}

$('folders').addEventListener('click', () => {
  renderFolderEditor();
  $('folder-dialog').showModal();
});

$('folder-add').addEventListener('change', () => {
  let d = $('folder-add').value;
  if (d === '__other__') d = prompt('Absolute path of the folder on the host:', '')?.trim().replace(/(.)\/+$/, '$1');
  if (d && d !== ui.dir && !chatDirs().includes(d)) setDirs([...chatDirs(), d]);
  else renderFolderEditor();
});

$('folder-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('folder-dialog').close();
});

$('model').addEventListener('change', async () => {
  const before = ui.settings;
  // Keeps the effort if the new model offers it; fillEfforts falls back otherwise.
  if (ui.key) ui.settings = { ...ui.settings, model: $('model').value || null };
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
  if (commandMenuKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

// ---------- skills and commands ----------

// Typing `/` at the start of a message lists the agent's skills and slash
// commands for this folder; picking one puts `/name ` in the box, and the
// agent runs it when the message is sent (see lib/commands.mjs). Lists are
// cached per agent and folder for a minute, like the server's.
const commandLists = new Map(); // 'agent\ndir' -> { at, promise, list, error }
const cmdMenu = { query: null, shown: [], active: 0, dismissed: null };

// A list that failed to load is asked for again after a few seconds.
function loadCommands(agent, dir) {
  const k = agent + '\n' + dir;
  const hit = commandLists.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const entry = { at: Date.now(), list: hit?.list || null, error: null };
  entry.promise = api(`/api/commands?agent=${encodeURIComponent(agent)}&dir=${encodeURIComponent(dir)}`).then(
    (list) => (entry.list = list),
    (err) => {
      entry.at = Date.now() - 55_000;
      entry.error = err.message;
      return (entry.list ||= []);
    },
  );
  commandLists.set(k, entry);
  return entry;
}

// The name being typed after a leading `/`, or null when the caret isn't in
// a message's first word or that word doesn't start with `/`.
function typedCommand() {
  if (input.selectionStart !== input.selectionEnd) return null;
  const m = /^\/([^\s/]*)$/.exec(input.value.slice(0, input.selectionStart));
  return m ? m[1] : null;
}

// Names (and aliases) that start with what's typed come first, then ones
// that contain it, then ones whose description does.
function matchCommands(list, q) {
  const s = q.toLowerCase();
  const names = (c) => [c.name, ...(c.aliases || [])].map((n) => n.toLowerCase());
  const starts = list.filter((c) => names(c).some((n) => n.startsWith(s)));
  const contains = list.filter((c) => !starts.includes(c) && names(c).some((n) => n.includes(s)));
  const described = s.length < 3 ? [] : list.filter((c) => !starts.includes(c) && !contains.includes(c) && c.description.toLowerCase().includes(s));
  return [...starts, ...contains, ...described];
}

async function updateCommandMenu() {
  const q = typedCommand();
  if (q !== cmdMenu.dismissed) cmdMenu.dismissed = null;
  if (q === null || q === cmdMenu.dismissed || !ui.dir || !ui.agent) return hideCommandMenu();
  const agent = ui.agent;
  const dir = ui.dir;
  const entry = loadCommands(agent, dir);
  if (!entry.list) {
    cmdMenu.query = null;
    showCommandMenu();
    $('command-menu').replaceChildren(el('div', 'cmd-empty', 'Loading skills…'));
    await entry.promise;
    if (ui.agent === agent && ui.dir === dir) updateCommandMenu();
    return;
  }
  if (q === cmdMenu.query && !$('command-menu').classList.contains('hidden')) return;
  cmdMenu.query = q;
  cmdMenu.shown = matchCommands(entry.list, q);
  cmdMenu.active = 0;
  if (cmdMenu.shown.length) {
    showCommandMenu();
    renderCommandMenu();
  } else if (!entry.list.length && !q) {
    showCommandMenu();
    const why = entry.error ? `Could not load skills: ${entry.error}` : `${agentLabel(agent)} has no skills or commands here.`;
    $('command-menu').replaceChildren(el('div', 'cmd-empty', why));
  } else {
    hideCommandMenu();
  }
}

function showCommandMenu() {
  $('command-menu').classList.remove('hidden');
  input.setAttribute('aria-expanded', 'true');
}

function hideCommandMenu() {
  cmdMenu.query = null;
  cmdMenu.shown = [];
  $('command-menu').classList.add('hidden');
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function renderCommandMenu() {
  const box = $('command-menu');
  box.replaceChildren();
  cmdMenu.shown.forEach((c, i) => {
    const row = el('div', 'cmd' + (i === cmdMenu.active ? ' active' : ''));
    row.id = 'cmd-' + i;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === cmdMenu.active));
    const head = el('div', 'cmd-head');
    head.appendChild(el('span', 'cmd-name', '/' + c.name));
    if (c.hint) head.appendChild(el('span', 'cmd-hint', c.hint));
    row.appendChild(head);
    if (c.description) {
      const desc = el('div', 'cmd-desc', c.description);
      desc.title = c.description;
      row.appendChild(desc);
    }
    // Keeps the caret in the message box.
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => pickCommand(c));
    box.appendChild(row);
  });
  input.setAttribute('aria-activedescendant', 'cmd-' + cmdMenu.active);
  box.children[cmdMenu.active]?.scrollIntoView({ block: 'nearest' });
}

// Replaces the first word with `/name ` and leaves the caret after it, for
// the arguments.
function pickCommand(c) {
  const rest = input.value.slice(input.selectionStart).replace(/^\S*\s*/, '');
  input.value = `/${c.name} ${rest}`;
  const caret = c.name.length + 2;
  input.setSelectionRange(caret, caret);
  hideCommandMenu();
  autosize();
  input.focus();
}

// Arrow keys move through the open menu, Enter or Tab picks, Escape closes it
// until the typed name changes. Returns whether the key was used.
function commandMenuKey(e) {
  if ($('command-menu').classList.contains('hidden') || e.isComposing) return false;
  const n = cmdMenu.shown.length;
  if (e.key === 'Escape') {
    cmdMenu.dismissed = typedCommand();
    hideCommandMenu();
  } else if (!n) {
    return false;
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    cmdMenu.active = (cmdMenu.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderCommandMenu();
  } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
    pickCommand(cmdMenu.shown[cmdMenu.active]);
  } else {
    return false;
  }
  e.preventDefault();
  e.stopPropagation();
  return true;
}

input.addEventListener('input', updateCommandMenu);
input.addEventListener('click', updateCommandMenu);
input.addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateCommandMenu();
});
document.addEventListener('pointerdown', (e) => {
  if (!$('composer').contains(e.target)) hideCommandMenu();
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

// Puts `text` at the cursor, with a space on either side where needed.
function insertAtCursor(text) {
  const { selectionStart: a, selectionEnd: b, value } = input;
  const before = a && !/\s$/.test(value.slice(0, a)) ? ' ' : '';
  const after = /^\s/.test(value.slice(b)) ? '' : ' ';
  input.setRangeText(before + text + after, a, b, 'end');
  input.dispatchEvent(new Event('input'));
}

// Copies a file to the host and puts its path there in the message.
async function uploadFile(file) {
  const placeholder = `[uploading ${file.name}…]`;
  insertAtCursor(placeholder);
  try {
    const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    input.value = input.value.replace(placeholder, data.path);
  } catch (err) {
    input.value = input.value.replace(placeholder + ' ', '').replace(placeholder, '');
    alert(`Couldn't upload ${file.name}: ${err.message}`);
  }
  input.dispatchEvent(new Event('input'));
}

// Images become attachments; any other file, or an image for an agent that
// can't take them, is uploaded and named by path.
async function addFiles(files) {
  files = [...files];
  const images = (await ui.options.get(ui.agent)?.catch(() => null))?.images ? files.filter((f) => f.type.startsWith('image/')) : [];
  await Promise.all(files.filter((f) => !images.includes(f)).map(uploadFile));
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
    // Folders show up as files too, but can't be read.
    const folders = [...e.dataTransfer.items].filter((i) => i.webkitGetAsEntry?.()?.isDirectory).map((i) => i.getAsFile()?.name);
    if (folders.length) alert(`Folders can't be dropped: ${folders.join(', ')}`);
    addFiles([...e.dataTransfer.files].filter((f) => !folders.includes(f.name)));
  }
});
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if ((!text && !attachments.length) || !ui.dir || $('send').disabled) return;
  $('send').disabled = true;
  if (ui.ask && !ui.key) {
    // "Just ask": the project comes from the message. Images alone say
    // nothing about it, so a message needs text.
    let routed = false;
    if (text) routed = await routeToProject(text).catch(() => false);
    else alert('Describe the task in words so a project can be picked.');
    if (!routed) {
      $('send').disabled = false;
      return;
    }
  }
  const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  const isNew = !ui.key;
  const dirs = chatDirs();
  if (isNew) {
    // Our own temp key, so events sent before the reply already reach us.
    ui.key = 'new-' + randomId();
    ui.settings = { ...currentPick(), dirs };
    $('agent').disabled = true;
    $('title').textContent = text.split('\n')[0].slice(0, 80) || '(image)';
  }
  try {
    await api('/api/send', {
      agent: ui.agent,
      sessionId: ui.sessionId,
      // A new chat whose first turn is still starting is found by its temp key.
      key: ui.key.startsWith('new-') ? ui.key : undefined,
      dir: ui.dir,
      text,
      images,
      mode: $('mode').value,
      model: $('model').value || undefined,
      effort: $('effort').value || undefined,
      dirs,
    });
    if (isNew) loadSessions();
    setRunning(true);
    input.value = '';
    hideCommandMenu();
    attachments.length = 0;
    renderAttachments();
    autosize();
  } catch (err) {
    if (isNew) {
      ui.key = null;
      $('agent').disabled = false;
    }
    alert(err.message);
  } finally {
    $('send').disabled = false;
  }
});

// Stopping also clears the queue; its messages come back into the composer.
$('stop').addEventListener('click', async () => {
  try {
    const r = await api('/api/interrupt', { key: ui.key });
    if (r.dropped?.length) restoreToComposer(r.dropped);
  } catch {}
});

$('mode').addEventListener('change', () => {
  // The live conversation, if any, switches right away.
  if (ui.key) api('/api/mode', { key: ui.key, mode: $('mode').value }).catch(() => {});
  pickChanged();
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

// ---------- quick actions ----------

// One-click buttons in the header. Restart is built in; the rest are shell
// commands from the Settings dialog, run on the host in the open workspace's
// folder. The list lives on the host, so every device shows the same buttons.
let actionState = { actions: [], supervised: false };
let actionRunning = null; // id of the action this device is running
let serverSince = null; // when the server started, to notice it came back

async function loadActions() {
  actionState = await api('/api/actions');
  renderActions();
}

// The header row and, for phones, the panel the ⚡ button opens show the
// same buttons; the stylesheet decides which is visible.
function renderActions() {
  for (const box of [$('actions'), $('actions-panel')]) {
    box.innerHTML = '';
    for (const a of actionState.actions) {
      const b = el('button', 'action-button' + (a.icon ? ' has-icon' : ''));
      b.type = 'button';
      b.title = a.builtin ? 'Restart agentdeck' : a.command + (a.restart ? '\nThen restart agentdeck' : '');
      b.setAttribute('aria-label', a.builtin ? 'Restart agentdeck' : a.label);
      if (a.icon) b.appendChild(el('span', 'action-icon', a.icon));
      b.appendChild(el('span', 'action-label', a.label));
      b.disabled = !!actionRunning;
      b.classList.toggle('running', actionRunning === a.id);
      b.onclick = () => runAction(a);
      box.appendChild(b);
    }
  }
  $('actions-toggle').classList.toggle('hidden', actionState.actions.length < 2);
}

$('actions-toggle').addEventListener('click', () => {
  const open = $('actions-panel').classList.toggle('hidden');
  $('actions-toggle').setAttribute('aria-expanded', String(!open));
});

async function runAction(a, force = false) {
  if (actionRunning) return;
  actionRunning = a.id;
  $('actions-panel').classList.add('hidden');
  $('actions-toggle').setAttribute('aria-expanded', 'false');
  renderActions();
  try {
    const r = await api('/api/actions/run', { id: a.id, dir: ui.dir, force });
    if (a.command) showActionResult(a, r);
    if (r.restarting) awaitRestart();
  } catch (err) {
    actionRunning = null;
    renderActions();
    // A restart would stop running turns: the server refuses once, and asks.
    if (err.status === 409 && err.data?.running) {
      if (confirm(`${err.message} ${a.label} anyway?`)) return runAction(a, true);
      return;
    }
    if (err.message !== 'not approved') alert(err.message);
    return;
  }
  actionRunning = null;
  renderActions();
}

// What a command printed, as a card above the composer on this device only.
// Running the same action again replaces its card.
function showActionResult(a, r) {
  const outcome = r.timedOut ? 'stopped after 60 s' : r.code === 0 ? 'done' : `failed (exit ${r.code})`;
  const note = r.restarting ? 'Restarting agentdeck…' : r.blocked ? `Not restarted: ${r.blocked}` : '';
  resultCard({ id: a.id, kicker: 'QUICK ACTION', label: a.label, title: `${a.label} · ${outcome} · ${(r.ms / 1000).toFixed(1)} s`,
    output: r.output, failed: r.code !== 0, note });
}

// The card itself; the project bar's Restart uses it too. `id` names what
// ran, so a new card for the same thing replaces the old one.
function resultCard({ id, kicker, label, title, output, failed, note, link, action }) {
  const box = $('action-results');
  for (const old of box.children) if (old.actionId === id) old.remove();
  const card = el('div', 'perm action-card' + (failed ? ' failed' : ''));
  card.actionId = id;
  card.tabIndex = -1;
  card.setAttribute('aria-label', `${label} result`);
  card.appendChild(el('div', 'perm-kicker', kicker));
  card.appendChild(el('h4', '', title));
  card.appendChild(el('pre', '', output || '(no output)'));
  if (note) card.appendChild(el('div', 'action-note', note));
  const row = el('div', 'row');
  if (link) {
    const a = el('a', 'action-button hub-button', link.text);
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    row.appendChild(a);
  }
  if (action) {
    const b = el('button', 'primary', action.text);
    b.type = 'button';
    b.onclick = () => action.onclick(card);
    row.appendChild(b);
  }
  const close = el('button', '', 'Dismiss');
  close.type = 'button';
  close.onclick = () => card.remove();
  row.appendChild(close);
  card.appendChild(row);
  box.prepend(card);
  card.focus({ preventScroll: true });
}

// The server is going away: wait for it to come back, then reload so the
// page gets the new code too. The composer's text survives the reload.
let restartTimer = 0;

function awaitRestart() {
  if (restartTimer) return;
  const status = $('status');
  status.classList.remove('status-error');
  status.innerHTML = '';
  status.append(el('span', 'dot'), document.createTextNode('Restarting agentdeck…'));
  const started = Date.now();
  const check = async () => {
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      const me = res.ok ? await res.json() : null;
      // Any answer from a new process (or a refusal, if this device was
      // removed meanwhile) means it's back. The old process answers until it exits.
      if (!res.ok || me.since !== serverSince) {
        if ($('input').value) sessionStorage.setItem('cw_draft', $('input').value);
        return location.reload();
      }
    } catch {}
    if (Date.now() - started > 90_000) {
      restartTimer = 0;
      status.classList.add('status-error');
      status.setAttribute('role', 'alert');
      status.textContent = "agentdeck didn't come back. Start it again on the host.";
      return;
    }
    restartTimer = setTimeout(check, 700);
  };
  restartTimer = setTimeout(check, 1000);
}

// ---------- project bar ----------

// The open workspace's dev server, when Tool Hub (~/code/tool-hub) is running
// and knows the folder: a status dot, Open while it's up, Restart through the
// hub, and a link into the hub. Beside it, when the workspace is in
// feedback-loop (~/code/feedback-loop): its bug queue, linking to the
// feedback dashboard, and Report. Nothing shows when neither applies. Both
// are asked for when the workspace changes and every 30 s while the page is
// visible; the server keeps the hub's answer for 30 s and feedback-loop's
// for 60 s.
const HUB_REFRESH = 30_000;
let hubState = { dir: null, hub: null, tool: null, disabled: false };
let fbState = { dir: null, feedback: null, disabled: false };
let hubRestarting = false;

function loadProjectBar() {
  renderProjectBar(); // drops the last workspace's entries straight away
  loadHub().catch(() => {});
  loadFeedback().catch(() => {});
}

async function loadHub() {
  const dir = ui.dir;
  if (!dir || hubState.disabled) return;
  const r = await api('/api/hub?dir=' + encodeURIComponent(dir));
  if (dir !== ui.dir) return;
  hubState = { dir, hub: r.hub, tool: r.tool || null, disabled: !!r.disabled };
  renderProjectBar();
}

async function loadFeedback() {
  const dir = ui.dir;
  if (!dir || fbState.disabled) return;
  const r = await api('/api/feedback?dir=' + encodeURIComponent(dir));
  if (dir !== ui.dir) return;
  fbState = { dir, feedback: r.feedback || null, disabled: !!r.disabled };
  renderProjectBar();
}

function renderProjectBar() {
  const bar = $('project-bar');
  const tool = hubState.dir === ui.dir ? hubState.tool : null;
  const fb = fbState.dir === ui.dir ? fbState.feedback : null;
  bar.classList.toggle('hidden', !tool && !fb);
  if (!tool && !fb) {
    bar.classList.remove('open');
    $('project-bar-toggle').setAttribute('aria-expanded', 'false');
    return;
  }
  // Without a tool there's no server to show, so no dot: the toggle is a 🐞.
  bar.classList.toggle('fl-only', !tool);
  bar.classList.toggle('running', !!tool?.running);
  const name = tool ? `${tool.emoji ? tool.emoji + ' ' : ''}${tool.name}` : fb.target;
  for (const n of bar.querySelectorAll('.hub-name')) n.textContent = name;
  for (const id of ['hub-open', 'hub-restart', 'hub-link']) $(id).classList.toggle('hidden', !tool);
  if (tool) {
    const state = tool.running ? 'running' : 'stopped';
    bar.querySelector('.project-bar-label').title = `${tool.name}: ${state}`;
    $('project-bar-toggle').setAttribute('aria-label', `${tool.name}: ${state}. Project menu`);
    $('hub-open').classList.toggle('hidden', !tool.running || !tool.url);
    $('hub-open').href = tool.url || '#';
    $('hub-open').title = tool.url ? `Open ${tool.url}` : '';
    $('hub-restart').disabled = hubRestarting;
    $('hub-restart').classList.toggle('running', hubRestarting);
    $('hub-restart').title = tool.self ? 'Restart agentdeck' : `Restart ${tool.name} through Tool Hub`;
    $('hub-link').href = hubState.hub.url;
    $('hub-link').title = 'Open in Tool Hub';
  } else {
    $('project-bar-toggle').setAttribute('aria-label', `${fb.target}: bug reports. Project menu`);
  }
  renderFeedback(fb);
  fitProjectBar();
}

// On a wide screen the bar is laid out in full while the chat's title keeps
// room beside it; a crowded header (a long name, quick actions, Tool Hub and
// feedback-loop together) folds it into the phone's menu. The title takes
// whatever the rest leaves, so its width changing is the cue to look again.
const PHONE = matchMedia('(max-width: 760px)');
const TITLE_ROOM = 160;

function fitProjectBar() {
  const bar = $('project-bar');
  const wasCompact = bar.classList.contains('compact');
  bar.classList.remove('compact');
  if (PHONE.matches || bar.classList.contains('hidden')) return;
  const compact = document.querySelector('.topbar .title').clientWidth < TITLE_ROOM;
  bar.classList.toggle('compact', compact);
  if (wasCompact && !compact) {
    bar.classList.remove('open');
    $('project-bar-toggle').setAttribute('aria-expanded', 'false');
  }
}

new ResizeObserver(() => requestAnimationFrame(fitProjectBar)).observe(document.querySelector('.topbar .title'));

// The queue as its most pressing number (what waits on you, then what's
// moving, then what's queued); the tooltip has the rest. `counts` is null
// until feedback-loop has answered once.
function renderFeedback(fb) {
  $('fl-queue').classList.toggle('hidden', !fb);
  $('fl-report').classList.toggle('hidden', !fb);
  $('project-bar').classList.remove('fl-attention');
  if (!fb) return;
  const c = fb.counts;
  const waiting = c ? c.needsYou + c.needsInfo : 0;
  const parts = c ? [
    waiting && `${waiting} need${waiting === 1 ? 's' : ''} you`,
    c.inProgress && `${c.inProgress} fixing`,
    c.prReady && `${c.prReady} PR${c.prReady === 1 ? '' : 's'}`,
    c.agentReady + c.reproduced && `${c.agentReady + c.reproduced} queued`,
  ].filter(Boolean) : [];
  const q = $('fl-queue');
  q.replaceChildren(`🐞 ${parts[0] || (c ? 'No bugs' : 'Bugs')}`);
  q.classList.toggle('attention', waiting > 0);
  $('project-bar').classList.toggle('fl-attention', waiting > 0);
  if (fb.dashboard) {
    const arrow = el('span', '', '↗');
    arrow.setAttribute('aria-hidden', 'true');
    q.href = fb.dashboard;
    q.append(' ', arrow);
  } else q.removeAttribute('href');
  q.title = [`feedback-loop${fb.repo ? ' · ' + fb.repo : ''}`, parts.join(' · ') || (c ? 'No open bugs' : ''), fb.dashboard && 'Open the dashboard']
    .filter(Boolean).join('\n');
  $('fl-report').title = `File a bug${fb.repo ? ' in ' + fb.repo : ''} through feedback-loop`;
}

$('project-bar-toggle').addEventListener('click', () => {
  const open = $('project-bar').classList.toggle('open');
  $('project-bar-toggle').setAttribute('aria-expanded', String(open));
});
// A pick closes the phone menu.
$('project-bar-menu').addEventListener('click', () => {
  $('project-bar').classList.remove('open');
  $('project-bar-toggle').setAttribute('aria-expanded', 'false');
});

$('hub-restart').addEventListener('click', async () => {
  const { tool, dir } = hubState;
  if (!tool || hubRestarting) return;
  // agentdeck itself restarts the built-in way, which keeps every page in step.
  if (tool.self) {
    const restart = actionState.actions.find((a) => a.builtin);
    if (restart) runAction(restart);
    return;
  }
  if (!confirm(`Restart ${tool.name} through Tool Hub?`)) return;
  hubRestarting = true;
  renderProjectBar();
  try {
    const r = await api('/api/hub/restart', { dir });
    resultCard({ id: 'hub:' + tool.id, kicker: 'PROJECT', label: tool.name, title: `${tool.name} · restart`, output: r.message,
      failed: /crash|missing|not running|not set up|in use/i.test(r.message) });
  } catch (err) {
    if (err.message !== 'not approved') resultCard({ id: 'hub:' + tool.id, kicker: 'PROJECT', label: tool.name, title: `${tool.name} · restart`, output: err.message, failed: true });
  }
  hubRestarting = false;
  renderProjectBar();
  loadHub().catch(() => {});
});

// Report: a bug filed through feedback-loop against the open workspace. The
// form keeps what was typed until it's filed, so Cancel loses nothing.
$('fl-report').addEventListener('click', () => {
  const fb = fbState.dir === ui.dir ? fbState.feedback : null;
  if (!fb) return;
  $('report-repo').textContent = fb.repo || fb.target;
  $('report-sub').textContent = fb.sub ? `, noting the folder ${fb.sub}` : '';
  $('report-error').textContent = '';
  $('report-dialog').showModal();
  $('report-title').focus();
});

$('report-cancel').addEventListener('click', () => $('report-dialog').close());

$('report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dir = ui.dir;
  const fb = fbState.dir === dir ? fbState.feedback : null;
  const ready = $('report-ready').checked;
  $('report-error').textContent = '';
  $('report-submit').disabled = true;
  $('report-submit').textContent = 'Filing…';
  try {
    const r = await api('/api/feedback/report', {
      dir,
      title: $('report-title').value,
      body: $('report-body').value,
      severity: $('report-severity').value,
      ready,
    });
    $('report-dialog').close();
    $('report-form').reset();
    resultCard({ id: `report:${r.number}`, kicker: 'FEEDBACK LOOP', label: `Issue #${r.number}`,
      title: `Filed #${r.number}${fb?.repo ? ' in ' + fb.repo : ''}`,
      output: ready ? 'Cleared for the agent: the loop can pick it up and open a pull request.' : 'Waiting for you to clear it for the agent, from the dashboard or GitHub.',
      link: r.url && { href: r.url, text: 'Open issue' } });
    loadFeedback().catch(() => {});
  } catch (err) {
    if (err.message !== 'not approved') $('report-error').textContent = err.message;
  }
  $('report-submit').disabled = false;
  $('report-submit').textContent = 'File';
});

function startHubPolling() {
  setInterval(() => {
    if (document.visibilityState === 'visible') loadProjectBar();
  }, HUB_REFRESH);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadProjectBar();
  });
}

// Settings dialog: the custom actions are edited as a draft and saved together.
let draftActions = [];

function renderActionEditor() {
  const list = $('action-list');
  list.innerHTML = '';
  const restart = actionState.actions.find((a) => a.builtin);
  if (restart) {
    const fixed = el('div', 'action-row action-fixed');
    fixed.append(el('span', 'action-icon', restart.icon), el('span', '', `${restart.label} — restarts agentdeck (built in)`));
    list.appendChild(fixed);
  }
  const field = (cls, value, placeholder, maxLength, label) => {
    const input = el('input', cls);
    Object.assign(input, { type: 'text', value, placeholder, maxLength, autocomplete: 'off', spellcheck: false });
    input.setAttribute('aria-label', label);
    return input;
  };
  draftActions.forEach((a, i) => {
    const row = el('div', 'action-row');
    const icon = field('action-icon-input', a.icon, '🔧', 8, `Icon of action ${i + 1}`);
    icon.oninput = () => (a.icon = icon.value);
    const label = field('action-label-input', a.label, 'Label', 24, `Label of action ${i + 1}`);
    label.oninput = () => (a.label = label.value);
    const rm = el('button', 'action-remove', '×');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remove action ${a.label || i + 1}`);
    rm.onclick = () => {
      draftActions.splice(i, 1);
      renderActionEditor();
    };
    const command = field('action-command', a.command, 'Shell command, e.g. git pull', 1000, `Command of action ${i + 1}`);
    command.oninput = () => (a.command = command.value);
    const restartLabel = el('label', 'action-restart');
    const restartBox = el('input');
    restartBox.type = 'checkbox';
    restartBox.checked = a.restart;
    restartBox.onchange = () => (a.restart = restartBox.checked);
    restartLabel.append(restartBox, document.createTextNode('Restart agentdeck when it succeeds'));
    row.append(icon, label, rm, command, restartLabel);
    list.appendChild(row);
  });
}

function openSettings() {
  draftActions = actionState.actions.filter((a) => !a.builtin).map((a) => ({ ...a }));
  $('settings-error').textContent = '';
  renderActionEditor();
  $('settings-dialog').showModal();
}

$('open-settings').addEventListener('click', openSettings);

$('action-add').addEventListener('click', () => {
  draftActions.push({ icon: '', label: '', command: '', restart: false });
  renderActionEditor();
  $('action-list').querySelector('.action-row:last-child .action-label-input')?.focus();
});

$('settings-cancel').addEventListener('click', () => $('settings-dialog').close());

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('settings-error').textContent = '';
  try {
    actionState = await api('/api/actions', { actions: draftActions });
    renderActions();
    $('settings-dialog').close();
  } catch (err) {
    if (err.message === 'not approved') return;
    $('settings-error').textContent = err.message;
  }
});

// ---------- devices ----------

// Browsers waiting for approval show up as cards on every approved device,
// and the Devices dialog lists the approved ones.
let deviceState = { devices: [], waiting: [], current: null };
const heardRequests = new Set();

async function loadDevices() {
  deviceState = await api('/api/devices');
  const fresh = deviceState.waiting.filter((r) => !heardRequests.has(r.id));
  for (const r of fresh) heardRequests.add(r.id);
  if (fresh.length) {
    playChime('ask');
    announcePending(`${fresh.length === 1 ? 'A new device is' : `${fresh.length} new devices are`} waiting for approval.`);
  }
  renderDeviceRequests();
  if ($('device-dialog').open) renderDevices();
}

async function deviceAction(path, body) {
  try {
    await api(path, body);
  } catch (err) {
    if (err.message !== 'not approved') alert(err.message);
  }
  loadDevices().catch(() => {});
}

// Cards are kept across refreshes, so a code half typed into one survives
// another device arriving.
function renderDeviceRequests() {
  const box = $('device-requests');
  const existing = new Map([...box.children].map((card) => [card.requestId, card]));
  const cards = deviceState.waiting.map((r) => existing.get(r.id) || makeDeviceCard(r));
  for (const card of [...box.children]) if (!cards.includes(card)) card.remove();
  cards.forEach((card, i) => {
    if (box.children[i] !== card) box.insertBefore(card, box.children[i] || null);
  });
}

// The card doesn't show the code: only the device asking does, so approving
// means reading it off that device. A request nobody is looking at can't be
// approved by tapping through.
function makeDeviceCard(r) {
  const card = el('form', 'perm device-card');
  card.requestId = r.id;
  card.setAttribute('aria-label', 'New device');
  card.appendChild(el('div', 'perm-kicker', 'NEW DEVICE'));
  card.appendChild(el('h4', '', `${r.name}${r.machine ? ' · ' + r.machine : ''} wants to use agentdeck`));
  card.appendChild(el('div', 'muted', 'If you are adding it, type the code it shows:'));
  const row = el('div', 'row');
  const input = el('input', 'device-code');
  Object.assign(input, { type: 'text', placeholder: 'Code', autocomplete: 'off', spellcheck: false, maxLength: 7 });
  input.setAttribute('autocapitalize', 'characters');
  input.setAttribute('aria-label', `Code shown on ${r.name}`);
  const allow = el('button', 'primary', 'Approve');
  allow.type = 'submit';
  const deny = el('button', 'danger', 'Deny');
  deny.type = 'button';
  deny.onclick = () => deviceAction('/api/devices/deny', { id: r.id });
  row.append(input, allow, deny);
  const error = el('div', 'error');
  card.append(row, error);
  card.onsubmit = async (e) => {
    e.preventDefault();
    error.textContent = '';
    try {
      await api('/api/devices/approve', { id: r.id, code: input.value });
      loadDevices().catch(() => {});
    } catch (err) {
      error.textContent = err.message;
      input.select();
    }
  };
  return card;
}

function renderDevices() {
  const list = $('device-list');
  list.innerHTML = '';
  for (const d of deviceState.devices) {
    const me = d.id === deviceState.current;
    const row = el('div', 'device-row');
    const text = el('div', 'device-text');
    text.append(
      el('div', 'device-name', d.name),
      el('div', 'muted device-detail', [d.machine, me ? 'this device' : 'used ' + timeAgo(d.lastSeen)].filter(Boolean).join(' · ')),
    );
    const rm = el('button', 'danger device-remove', 'Remove');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remove ${d.name}${me ? ' (this device)' : ''}`);
    rm.onclick = () => {
      const what = me ? 'this device' : d.name;
      if (confirm(`Remove ${what}? It will have to be approved again to use agentdeck.`)) deviceAction('/api/devices/revoke', { id: d.id });
    };
    row.append(text, rm);
    list.appendChild(row);
  }
}

$('open-devices').addEventListener('click', () => {
  renderDevices();
  $('device-dialog').showModal();
  loadDevices().catch(() => {});
});

$('device-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('device-dialog').close();
});

// ---------- boot ----------

async function start() {
  const me = await api('/api/me');
  serverSince = me.since;
  $('app').classList.remove('hidden');
  loadDevices().catch(() => {}); // a device waiting for approval shouldn't wait for the rest
  loadActions().catch(() => {});
  $('host').textContent = 'Host: ' + me.host;
  // A message being typed when agentdeck restarted comes back.
  const draft = sessionStorage.getItem('cw_draft');
  if (draft) {
    sessionStorage.removeItem('cw_draft');
    if (!$('input').value) {
      $('input').value = draft;
      autosize();
    }
  }
  ui.agents = await api('/api/agents');
  const sel = $('agent');
  sel.innerHTML = '';
  for (const a of ui.agents) sel.appendChild(Object.assign(document.createElement('option'), { value: a.id, textContent: a.label }));
  sel.classList.toggle('hidden', ui.agents.length < 2);
  const projects = await loadProjects();
  const h = readHash();
  const dir = h.dir || projects[0]?.dir;
  if (dir) setProject(dir);
  startHubPolling();
  await loadSessions();
  if (h.s) await openConversation(h.agent, h.s);
  else {
    newConversation(); // rewrites the hash, so the prompt doesn't come back on reload
    if (h.prompt) {
      $('input').value = h.prompt;
      autosize();
      $('input').focus();
    }
  }
  connectEvents();
}

start().catch((err) => {
  if (err.message !== 'not approved') alert(err.message);
});
