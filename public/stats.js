'use strict';

// The stats page: usage over time, models, time of day and projects, across
// every agent on this machine. Data comes from /api/stats as hour buckets
// (lib/stats.mjs); all slicing happens here, so the filters never refetch.
// Charts are plain SVG and HTML; values are also in each chart's table view.

(() => {
  const page = $('stats-page');
  const AGENTS = ['claude', 'codex', 'opencode']; // fixed color order
  const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'opencode' };
  const RANGES = [
    { days: 7, label: '7 days' },
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
    { days: 0, label: 'All time' },
  ];

  const st = {
    data: null, // { rows, sessions, at } from the server
    loading: null,
    days: 30,
    agents: new Set(), // empty = all
    modelBy: 'replies', // or 'tout': what the Models bars measure
  };

  const DAY = 86400_000;
  const agentName = (id) => (typeof agentLabel === 'function' && ui.agents.length ? agentLabel(id) : AGENT_NAMES[id] || id);
  const agentColor = (id) => (AGENTS.includes(id) ? `var(--st-${id})` : 'var(--muted)');
  const fmt = (n) => n.toLocaleString();
  const compact = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 10_000 ? (n / 1e3).toFixed(1) + 'K' : fmt(n));
  const monthDay = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  // Claude's model ids end in a release date; the name reads better without it.
  const modelName = (m) => m.replace(/-20\d{6}$/, '');
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // ---------- tooltip ----------

  // One shared tooltip; rows are [label, value, color?]. All content is set
  // with textContent, never markup.
  const tip = $('stats-tip');
  function showTip(ev, title, rows) {
    tip.textContent = '';
    tip.appendChild(el('div', 'tip-title', title));
    for (const [label, value, color] of rows) {
      const r = el('div', 'tip-row');
      if (color) {
        const key = el('span', 'tip-key');
        key.style.background = color;
        r.appendChild(key);
      }
      r.appendChild(el('span', 'tip-value', value));
      r.appendChild(el('span', 'tip-label', label));
      tip.appendChild(r);
    }
    tip.classList.remove('hidden');
    moveTip(ev);
  }
  function moveTip(ev) {
    const pad = 14;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    if (x + w > innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > innerHeight - 8) y = ev.clientY - h - pad;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  const hideTip = () => tip.classList.add('hidden');
  const hover = (node, make) => {
    node.addEventListener('pointerenter', (ev) => showTip(ev, ...make()));
    node.addEventListener('pointermove', moveTip);
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', (ev) => showTip({ clientX: 40, clientY: 80 }, ...make()));
    node.addEventListener('blur', hideTip);
  };

  // ---------- pieces ----------

  function card(title, subtitle) {
    const c = el('section', 'st-card');
    const h = el('div', 'st-card-head');
    h.appendChild(el('h3', null, title));
    if (subtitle) h.appendChild(el('span', 'muted', subtitle));
    c.appendChild(h);
    return c;
  }

  function tableView(headers, rows) {
    const d = el('details', 'st-table');
    d.appendChild(el('summary', null, 'View as table'));
    const t = el('table');
    const tr = el('tr');
    for (const h of headers) tr.appendChild(el('th', null, h));
    t.appendChild(tr);
    for (const row of rows) {
      const r = el('tr');
      row.forEach((v, i) => r.appendChild(el('td', i ? 'num' : null, String(v))));
      t.appendChild(r);
    }
    d.appendChild(t);
    return d;
  }

  const svgEl = (tag, attrs) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  // A clean axis ceiling: 1/2/5 × a power of ten.
  function niceMax(n) {
    if (n <= 4) return Math.max(n, 1);
    const pow = 10 ** Math.floor(Math.log10(n));
    for (const m of [1, 2, 3, 4, 5, 6, 8, 10]) if (m * pow >= n) return m * pow;
    return 10 * pow;
  }

  // ---------- charts ----------

  // Stacked columns over time, one series per agent.
  function activityChart(buckets, agents, bucketDays) {
    const wrap = el('div', 'st-plot');
    const render = () => {
      wrap.textContent = '';
      const width = Math.max(wrap.clientWidth || 600, 320);
      const plotH = 190;
      const padL = 34;
      const padB = 20;
      const svg = svgEl('svg', { width, height: plotH + padB, role: 'img', 'aria-label': 'Activity over time' });
      const totals = buckets.map((b) => agents.reduce((s, a) => s + (b.by[a] || 0), 0));
      const max = niceMax(Math.max(...totals, 1));
      const innerW = width - padL - 6;
      const slot = innerW / buckets.length;
      const barW = Math.min(24, Math.max(2, slot - 2));
      const y = (v) => plotH - (v / max) * (plotH - 14);
      // Hairline gridlines at half and full, labeled in the axis gutter.
      for (const v of [max / 2, max]) {
        svg.appendChild(svgEl('line', { x1: padL, y1: y(v), x2: width - 2, y2: y(v), class: 'st-grid' }));
        const t = svgEl('text', { x: padL - 6, y: y(v) + 3.5, class: 'st-tick', 'text-anchor': 'end' });
        t.textContent = compact(v);
        svg.appendChild(t);
      }
      svg.appendChild(svgEl('line', { x1: padL, y1: plotH, x2: width - 2, y2: plotH, class: 'st-axis' }));
      buckets.forEach((b, i) => {
        const x = padL + i * slot + (slot - barW) / 2;
        const stack = agents.filter((a) => b.by[a]);
        let cum = 0;
        let prevTop = plotH; // the baseline; each segment's bottom sits a 2px surface gap above the one below
        stack.forEach((a, si) => {
          cum += b.by[a];
          const top = y(cum);
          const bottom = prevTop - (si ? 2 : 0);
          const h = Math.max(0.75, bottom - top);
          const yTop = bottom - h;
          const last = si === stack.length - 1;
          if (last && h > 2) {
            // Rounded data end at the top, square at the baseline.
            const r = Math.min(4, barW / 2, h);
            const d = `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z`;
            svg.appendChild(svgEl('path', { d, fill: agentColor(a) }));
          } else {
            svg.appendChild(svgEl('rect', { x, y: yTop, width: barW, height: h, fill: agentColor(a) }));
          }
          prevTop = yTop;
        });
        // The slot, not the thin bar, is the hover target.
        const hit = svgEl('rect', { x: padL + i * slot, y: 0, width: slot, height: plotH, fill: 'transparent', tabindex: '-1' });
        hover(hit, () => [
          bucketDays > 1 ? `Week of ${monthDay(b.t)}` : new Date(b.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
          [
            ...agents.filter((a) => b.by[a]).map((a) => [agentName(a), fmt(b.by[a]), agentColor(a)]),
            totals[i] && agents.length > 1 ? ['total', fmt(totals[i])] : null,
            !totals[i] ? ['prompts', '0'] : null,
          ].filter(Boolean),
        ]);
        svg.appendChild(hit);
      });
      // About six x labels, on bucket starts.
      const step = Math.max(1, Math.ceil(buckets.length / 6));
      buckets.forEach((b, i) => {
        if (i % step !== 0) return;
        const t = svgEl('text', { x: padL + i * slot + slot / 2, y: plotH + 14, class: 'st-tick', 'text-anchor': 'middle' });
        t.textContent = monthDay(b.t);
        svg.appendChild(t);
      });
      wrap.appendChild(svg);
    };
    wrap.render = render;
    return wrap;
  }

  // Weekday × hour heatmap of prompts, one hue stepping darker with volume.
  function punchcard(rows) {
    const grid = new Array(7 * 24).fill(0);
    for (const r of rows) {
      const d = new Date(r.t);
      grid[((d.getDay() + 6) % 7) * 24 + d.getHours()] += r.prompts; // Monday first
    }
    const max = Math.max(...grid, 1);
    const names = [];
    for (let i = 0; i < 7; i++) names.push(new Date(Date.UTC(2024, 0, i + 1)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }));
    const wrap = el('div', 'st-punch');
    for (let d = 0; d < 7; d++) {
      wrap.appendChild(el('span', 'st-punch-label', names[d]));
      for (let h = 0; h < 24; h++) {
        const v = grid[d * 24 + h];
        const cell = el('span', 'st-cell');
        if (v) cell.style.background = `color-mix(in srgb, var(--st-claude) ${Math.round(18 + 82 * Math.sqrt(v / max))}%, var(--card))`;
        hover(cell, () => [`${names[d]} ${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59`, [['prompts', fmt(v)]]]);
        wrap.appendChild(cell);
      }
    }
    wrap.appendChild(el('span', 'st-punch-label', ''));
    for (let h = 0; h < 24; h += 3) {
      const lab = el('span', 'st-punch-hour', `${h}`);
      lab.style.gridColumn = String(h + 2);
      wrap.appendChild(lab);
    }
    const hourTotals = new Array(24).fill(0);
    grid.forEach((v, i) => (hourTotals[i % 24] += v));
    return {
      node: wrap,
      table: tableView(['Hour', 'Prompts'], hourTotals.map((v, h) => [`${String(h).padStart(2, '0')}:00`, fmt(v)])),
    };
  }

  // Horizontal bars; items: { label, value, color?, detail: [[label, value]] }.
  function barList(items, unit) {
    const max = Math.max(...items.map((i) => i.value), 1);
    const wrap = el('div', 'st-bars');
    for (const it of items) {
      const row = el('div', 'st-bar-row');
      row.appendChild(el('span', 'st-bar-name', it.label));
      const track = el('span', 'st-bar-track');
      const fill = el('span', 'st-bar-fill');
      fill.style.width = (100 * it.value) / max + '%';
      if (it.color) fill.style.background = it.color;
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'st-bar-value', compact(it.value)));
      hover(row, () => [it.label, [[unit, fmt(it.value)], ...(it.detail || [])].map(([l, v]) => [l, v, it.color])]);
      wrap.appendChild(row);
    }
    return wrap;
  }

  // ---------- aggregation ----------

  function slice() {
    const { rows, sessions } = st.data;
    const from = st.days ? hourStart(Date.now() - st.days * DAY + DAY) : 0;
    const keep = (x) => x.t >= from && (!st.agents.size || st.agents.has(x.agent));
    return { rows: rows.filter(keep), sessions: sessions.filter(keep), from };
  }
  const hourStart = (t) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();

  function render() {
    const body = $('stats-body');
    body.textContent = '';
    if (!st.data) return;
    const { rows, sessions, from } = slice();
    const agents = AGENTS.filter((a) => st.data.rows.some((r) => r.agent === a) || st.data.sessions.some((s) => s.agent === a));
    renderFilters(agents);
    $('stats-note').textContent = `scanned ${new Date(st.data.at).toLocaleTimeString()}`;

    if (!rows.length && !sessions.length) {
      body.appendChild(el('p', 'muted st-empty', 'No activity in this range.'));
      return;
    }

    const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
    const prompts = sum((r) => r.prompts);
    const activeDays = new Set(rows.filter((r) => r.prompts).map((r) => hourStart(r.t))).size;

    // Stat tiles.
    const tiles = el('div', 'st-tiles');
    for (const [label, value] of [
      ['Conversations', fmt(sessions.length)],
      ['Prompts sent', fmt(prompts)],
      ['Tokens generated', compact(sum((r) => r.tout))],
      ['Active days', fmt(activeDays)],
    ]) {
      const t = el('div', 'st-tile');
      t.appendChild(el('div', 'st-tile-value', value));
      t.appendChild(el('div', 'st-tile-label', label));
      tiles.appendChild(t);
    }
    body.appendChild(tiles);

    // Activity over time: prompts per day (per week past ~5 months).
    const first = rows.length ? Math.min(...rows.map((r) => r.t)) : Date.now();
    const start = hourStart(from || first);
    const spanDays = Math.ceil((Date.now() - start) / DAY);
    const bucketDays = spanDays > 150 ? 7 : 1;
    const buckets = [];
    const cursor = new Date(start);
    while (cursor.getTime() <= Date.now()) {
      buckets.push({ t: cursor.getTime(), by: {} });
      cursor.setDate(cursor.getDate() + bucketDays); // by date, so DST can't skip or double a day
    }
    for (const r of rows) {
      if (!r.prompts) continue;
      const b = buckets[Math.floor(Math.round((hourStart(r.t) - start) / DAY) / bucketDays)];
      if (b) b.by[r.agent] = (b.by[r.agent] || 0) + r.prompts;
    }
    const shown = agents.filter((a) => !st.agents.size || st.agents.has(a));
    const act = card('Activity', `prompts per ${bucketDays > 1 ? 'week' : 'day'}`);
    const chart = activityChart(buckets, shown, bucketDays);
    act.appendChild(chart);
    act.appendChild(tableView(
      ['Date', ...shown.map(agentName)],
      buckets.filter((b) => Object.keys(b.by).length).map((b) => [monthDay(b.t), ...shown.map((a) => fmt(b.by[a] || 0))]),
    ));
    body.appendChild(act);
    chart.render();

    // Time of day.
    const when = card('Time of day', 'prompts by local hour');
    const punch = punchcard(rows);
    when.appendChild(punch.node);
    when.appendChild(punch.table);
    body.appendChild(when);

    // Models and projects, side by side where there's room.
    const pair = el('div', 'st-pair');

    const byModel = new Map();
    for (const r of rows) {
      if (!r.model || !r.replies) continue;
      const m = byModel.get(r.model) || { agent: r.agent, replies: 0, tout: 0 };
      m.replies += r.replies;
      m.tout += r.tout;
      byModel.set(r.model, m);
    }
    const by = st.modelBy;
    const unit = by === 'tout' ? 'tokens out' : 'replies';
    const models = [...byModel.entries()].sort((a, b) => b[1][by] - a[1][by]);
    const topModels = models.slice(0, 8).map(([m, v]) => ({
      label: modelName(m),
      value: v[by],
      color: agentColor(v.agent),
      detail: [by === 'tout' ? ['replies', fmt(v.replies)] : ['tokens out', compact(v.tout)], ['agent', agentName(v.agent)]],
    }));
    if (models.length > 8) {
      topModels.push({
        label: `Other (${models.length - 8})`,
        value: models.slice(8).reduce((s, [, v]) => s + v[by], 0),
        color: 'var(--muted)',
      });
    }
    const mc = card('Models', `${unit} per model`);
    const toggle = el('div', 'st-toggle');
    for (const [key, label] of [['replies', 'Replies'], ['tout', 'Tokens']]) {
      const b = el('button', 'st-chip' + (by === key ? ' on' : ''), label);
      b.onclick = () => {
        st.modelBy = key;
        render();
      };
      toggle.appendChild(b);
    }
    mc.firstChild.appendChild(toggle);
    mc.appendChild(barList(topModels, unit));
    mc.appendChild(tableView(['Model', 'Replies', 'Tokens out', 'Agent'], models.map(([m, v]) => [modelName(m), fmt(v.replies), compact(v.tout), agentName(v.agent)])));
    pair.appendChild(mc);

    const byDir = new Map();
    for (const r of rows) {
      if (!r.prompts) continue;
      const d = byDir.get(r.dir) || { prompts: 0 };
      d.prompts += r.prompts;
      byDir.set(r.dir, d);
    }
    const dirs = [...byDir.entries()].sort((a, b) => b[1].prompts - a[1].prompts);
    const name = (dir) => dir.split('/').filter(Boolean).pop() || dir;
    const topDirs = dirs.slice(0, 8).map(([d, v]) => ({ label: name(d), value: v.prompts, detail: [['folder', d]] }));
    if (dirs.length > 8) topDirs.push({ label: `Other (${dirs.length - 8})`, value: dirs.slice(8).reduce((s, [, v]) => s + v.prompts, 0), color: 'var(--muted)' });
    const pc = card('Projects', 'prompts per project');
    pc.appendChild(barList(topDirs, 'prompts'));
    pc.appendChild(tableView(['Project', 'Prompts'], dirs.map(([d, v]) => [d, fmt(v.prompts)])));
    pair.appendChild(pc);

    body.appendChild(pair);
  }

  // The filter row doubles as the legend: each agent chip wears its color.
  function renderFilters(agents) {
    const box = $('stats-filters');
    box.textContent = '';
    for (const r of RANGES) {
      const b = el('button', 'st-chip' + (st.days === r.days ? ' on' : ''), r.label);
      b.onclick = () => {
        st.days = r.days;
        render();
      };
      box.appendChild(b);
    }
    box.appendChild(el('span', 'st-sep'));
    for (const a of agents) {
      const on = !st.agents.size || st.agents.has(a);
      const b = el('button', 'st-chip st-agent' + (on ? ' on' : ''));
      const dot = el('span', 'st-dot');
      dot.style.background = agentColor(a);
      b.appendChild(dot);
      b.appendChild(document.createTextNode(agentName(a)));
      b.onclick = () => {
        // Toggling from "all" narrows to just that agent; clearing the last
        // chip goes back to all.
        if (!st.agents.size) st.agents = new Set([a]);
        else if (st.agents.has(a)) st.agents.delete(a);
        else st.agents.add(a);
        if (st.agents.size === agents.length) st.agents.clear();
        render();
      };
      box.appendChild(b);
    }
  }

  // ---------- open / load ----------

  async function load(refresh) {
    if (st.loading) return;
    const body = $('stats-body');
    if (!st.data) {
      body.textContent = '';
      body.appendChild(el('p', 'muted st-empty', 'Reading the agents’ transcripts… the first scan can take a minute.'));
    } else if (refresh) {
      body.style.opacity = '.5'; // keep the old render while new data loads
    }
    st.loading = api('/api/stats')
      .then((d) => {
        st.data = d;
        render();
      })
      .catch((err) => {
        body.textContent = '';
        body.appendChild(el('p', 'error st-empty', 'Could not load stats: ' + err.message));
      })
      .finally(() => {
        st.loading = null;
        body.style.opacity = '';
      });
  }

  function open() {
    page.classList.remove('hidden');
    document.body.classList.add('stats-open');
    load(!!st.data);
    if (st.data) render();
  }
  function close() {
    page.classList.add('hidden');
    document.body.classList.remove('stats-open');
    hideTip();
  }

  $('open-stats').addEventListener('click', () => {
    open();
    $('sidebar').classList.remove('open');
    $('sidebar-backdrop').classList.remove('open');
  });
  $('stats-close').addEventListener('click', close);
  $('stats-refresh').addEventListener('click', () => load(true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !page.classList.contains('hidden')) close();
  });
  let resizeTimer = 0;
  addEventListener('resize', () => {
    if (page.classList.contains('hidden') || !st.data) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });
})();
