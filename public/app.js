const VIEWS = [
  ['overview', 'Overview'],
  ['board', 'Board'],
  ['workers', 'Workers'],
  ['activity', 'Activity'],
  ['stats', 'Statistics'],
  ['control', 'Control'],
  ['grok', 'Grok Bots'],
];

const state = {
  me: undefined,
  view: location.hash.replace('#/', '') || 'overview',
  error: '',
  overview: null,
  tasks: [],
  task: null,
  attempts: [],
  attemptId: null,
  events: [],
  stats: null,
  intents: [],
  audit: [],
  filters: { group: '', q: '', owner: '' },
  grok: { groups: [], roster: [], conversation: null, activity: [], selected: 'group:g-comfy', profile: 'grok-main', agent: '' },
  draft: '',
  form: { title: '', spec: '', project: 'comfyrizz', group: 'Comfyrizz build', fileScope: '', priority: '2', dependencies: '' },
};

const app = document.querySelector('#app');

function el(tag, attrs, kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const kid of [].concat(kids || [])) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 401) {
    state.me = null;
    render();
    throw new Error('sign in required');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `request failed (${response.status})`);
  return data;
}

function fmtTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function chipForState(name) {
  return el('span', { class: `chip state-${name}` }, name.replaceAll('_', ' '));
}

function needsDecision(item) {
  return item?.needsHuman === true && item?.disposition !== 'auto_approved' && item?.autoApproved !== true;
}

function approvalBlock(item) {
  if (!item || typeof item !== 'object') return null;
  if (needsDecision(item)) {
    return el('div', { class: 'note-card human' }, [
      el('div', { class: 'row' }, [el('span', { class: 'chip warn' }, 'Needs a decision'), el('span', { class: 'muted' }, item.type || item.kind || 'approval')]),
      el('p', { text: item.summary || item.title || item.detail || 'Waiting for Kyle' }),
      item.command ? el('code', { text: item.command }) : null,
      el('div', { class: 'row' }, [
        el('button', { class: 'primary', onclick: () => decide(item, true) }, 'Approve'),
        el('button', { class: 'btn', onclick: () => decide(item, false) }, 'Reject'),
      ]),
    ]);
  }
  const auto = item.autoApproved === true || item.disposition === 'auto_approved';
  if (!auto) return null;
  return el('div', { class: 'note-card auto' }, [
    el('div', { class: 'row' }, [el('span', { class: 'chip auto' }, 'Auto-approved'), el('span', { class: 'muted' }, 'Not a human decision')]),
    el('p', { text: item.summary || item.detail || item.title || 'Approved inside the sandbox' }),
  ]);
}

async function decide(card, accepted) {
  state.error = '';
  try {
    await api('/api/v1/grok', {
      method: 'POST',
      body: {
        action: 'controls',
        profile: state.grok.profile || 'grok-main',
        agent: state.grok.agent,
        control: 'approval.localTool',
        args: { entryId: card.entryId, requestId: card.requestId, resolution: accepted ? 'allow-once' : 'deny', confirmed: true },
      },
    });
    state.error = accepted ? 'Approval queued for Orbit.' : 'Rejection queued for Orbit.';
  } catch (error) {
    state.error = error.message;
  }
  render();
}

function shell(title, subtitle, body) {
  const nav = el('nav', { class: 'nav' }, VIEWS.map(([id, label]) => el('button', {
    class: state.view === id ? 'active' : '',
    onclick: () => { state.view = id; location.hash = `/${id}`; load().catch(showError); },
  }, label)));
  return el('div', { class: 'shell' }, [
    el('aside', { class: 'side' }, [
      el('div', { class: 'brand' }, [
        el('img', { class: 'mark', src: '/favicon.svg', alt: '' }),
        el('div', {}, [el('strong', { text: 'ORBIT' }), el('span', { text: 'Control plane' })]),
      ]),
      nav,
      el('div', { class: 'side-foot' }, [
        state.me?.demo ? 'Demo data is local. Live Orbit traffic arrives through the connector.' : 'Tailscale by default. Tokens stay off this screen.',
        el('div', {}, state.me ? `Signed in as ${state.me.name || state.me.actor}` : ''),
      ]),
    ]),
    el('main', { class: 'main' }, [
      el('div', { class: 'top' }, [
        el('div', {}, [el('h1', { text: title }), subtitle ? el('p', { class: 'sub', text: subtitle }) : null]),
        el('div', { class: 'row' }, [
          el('span', { class: 'pill' }, [el('i', { class: `dot ${state.me?.connector ? 'on' : 'off'}` }), state.me?.connector ? 'Connector live' : 'Connector offline']),
          el('span', { class: 'pill' }, [el('i', { class: `dot ${state.me?.paused ? 'warn' : 'on'}` }), state.me?.paused ? 'Dispatch paused' : 'Dispatch running']),
        ]),
      ]),
      state.me?.demo ? el('div', { class: 'banner', text: 'Demo mode. Every panel is seeded. Queueing a change writes an intent Orbit would pick up; nothing here calls a live agent.' }) : null,
      state.error ? el('p', { class: 'error', text: state.error }) : null,
      body,
    ]),
  ]);
}

function showError(error) {
  state.error = error.message || String(error);
  render();
}

function overviewView() {
  const data = state.overview;
  if (!data) return el('p', { class: 'muted', text: 'Loading…' });
  const counts = data.counts || {};
  const kpis = el('section', { class: 'kpis' }, [
    kpi('In flight', data.inFlight?.length ?? 0, 'attempts still open'),
    kpi('Queue depth', data.queueDepth ?? 0, 'queued on the launcher'),
    kpi('Doing', counts.doing ?? 0, `${counts.review || 0} in review`),
    kpi('Open intents', data.openIntents ?? 0, data.paused ? 'dispatch is paused' : 'waiting for Orbit'),
  ]);
  const flight = el('div', { class: 'panel' }, [
    el('h2', { text: 'Who holds what' }),
    table(['Attempt', 'State', 'Holder', 'Task'], (data.inFlight || []).map(item => [
      el('span', { class: 'mono', text: item.attemptId }),
      chipForState(item.state),
      item.holder || item.node || '—',
      item.taskId || '—',
    ])),
  ]);
  const nodes = el('div', { class: 'panel' }, [
    el('h2', { text: 'Launcher health' }),
    ...(data.launchers || []).map(launcherCard),
    el('h2', { text: 'Recent audit' }),
    ...(data.recentAudit || []).slice(0, 6).map(row => el('div', { class: 'muted' }, `${fmtTime(row.at)} · ${row.actor} · ${row.action}`)),
  ]);
  return el('div', {}, [kpis, el('div', { class: 'grid-2' }, [flight, nodes])]);
}

function kpi(label, value, note) {
  return el('article', { class: 'card kpi' }, [el('span', { text: label }), el('b', { text: String(value) }), el('span', { text: note })]);
}

function launcherCard(node) {
  const max = node.concurrencyMax || 1;
  const used = node.concurrencyUsed || 0;
  const width = Math.min(100, Math.round((used / max) * 100));
  return el('article', { class: 'card', style: 'margin-bottom:10px' }, [
    el('div', { class: 'row' }, [
      el('i', { class: `dot ${node.healthy ? 'on' : 'off'}` }),
      el('strong', { text: node.node }),
      el('span', { class: 'chip', text: node.model || 'model unset' }),
    ]),
    el('p', { class: 'muted', text: `${used} / ${max} slots · queued ${node.queued || 0} · ${node.version || 'unknown version'}` }),
    node.desiredMax && node.desiredMax !== node.concurrencyMax ? el('p', { class: 'muted', text: `Desired cap queued: ${node.desiredMax}` }) : null,
    el('div', { class: 'bar' }, el('span', { style: `width:${width}%` })),
    node.detail ? el('p', { class: 'muted', text: node.detail }) : null,
  ]);
}

function table(headers, rows) {
  return el('table', {}, [
    el('thead', {}, el('tr', {}, headers.map(header => el('th', { text: header })))),
    el('tbody', {}, rows.map(cells => el('tr', {}, cells.map(cell => el('td', {}, cell))))),
  ]);
}

function boardView() {
  const groups = [...new Set(state.tasks.map(task => task.groupName).filter(Boolean))];
  const columns = ['todo', 'doing', 'review', 'blocked', 'done'];
  const filters = el('div', { class: 'filters' }, [
    el('input', { placeholder: 'Search title or spec', value: state.filters.q, oninput: event => { state.filters.q = event.target.value; renderBoardOnly(); } }),
    el('select', { onchange: event => { state.filters.group = event.target.value; render(); } }, [
      el('option', { value: '', text: 'All groups' }),
      ...groups.map(group => el('option', { value: group, text: group, selected: state.filters.group === group ? 'selected' : null })),
    ]),
  ]);
  const visible = state.tasks.filter(task => {
    if (state.filters.group && task.groupName !== state.filters.group) return false;
    if (state.filters.q) {
      const hay = `${task.title} ${task.spec} ${task.summary}`.toLowerCase();
      if (!hay.includes(state.filters.q.toLowerCase())) return false;
    }
    return true;
  });
  const board = el('div', { class: 'board' }, columns.map(column => {
    const col = el('section', { class: 'column', 'data-column': column });
    col.append(el('header', {}, [el('h3', { text: column }), el('span', { class: 'chip', text: String(visible.filter(task => task.column === column).length) })]));
    for (const task of visible.filter(item => item.column === column)) col.append(taskCard(task));
    col.addEventListener('dragover', event => { event.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', event => dropOn(event, column, col));
    return col;
  }));
  return el('div', {}, [filters, board, state.task ? drawer(state.task) : null]);
}

function taskCard(task) {
  const card = el('article', { class: 'task', draggable: 'true' });
  card.append(
    el('div', { class: 'row' }, [
      el('span', { class: 'pri', text: `P${task.priority}` }),
      task.groupName ? el('span', { class: 'chip', text: task.groupName }) : null,
      task.syncState === 'pending' ? el('span', { class: 'chip warn', text: 'queued' }) : null,
    ]),
    el('b', { text: task.title }),
    el('p', { text: task.summary || task.spec.slice(0, 110) }),
    el('div', { class: 'row' }, [el('span', { class: 'muted', text: task.holder || task.owner || 'unassigned' })]),
  );
  card.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', task.id));
  card.addEventListener('click', () => openTask(task.id));
  return card;
}

async function dropOn(event, column, col) {
  event.preventDefault();
  col.classList.remove('drop');
  const id = event.dataTransfer.getData('text/plain');
  if (!id) return;
  try {
    await api(`/api/v1/control/tasks/${encodeURIComponent(id)}/move`, { method: 'POST', body: { column, note: `dragged to ${column}` } });
    await loadBoard();
  } catch (error) { showError(error); }
}

async function openTask(id) {
  const data = await api(`/api/v1/board/tasks/${encodeURIComponent(id)}`);
  state.task = data.task;
  render();
}

function drawer(task) {
  const back = el('div', { class: 'drawer-back', onclick: () => { state.task = null; render(); } });
  const panel = el('aside', { class: 'drawer' }, [
    el('div', { class: 'row' }, [el('span', { class: 'chip', text: task.column }), el('span', { class: 'pri', text: `P${task.priority}` })]),
    el('h2', { text: task.title }),
    el('p', { text: task.spec || 'No spec yet.' }),
    el('p', { class: 'muted', text: `${task.groupName || 'No group'} · ${task.project || 'no project'} · owner ${task.owner || '—'}` }),
    task.fileScope?.length ? el('p', { class: 'mono', text: task.fileScope.join('\n') }) : null,
    task.dependencies?.length ? el('p', { class: 'muted', text: `Depends on ${task.dependencies.join(', ')}` }) : null,
    el('div', { class: 'row' }, ['todo', 'doing', 'review', 'blocked', 'done'].map(column => el('button', {
      class: 'btn',
      onclick: async () => {
        await api(`/api/v1/control/tasks/${encodeURIComponent(task.id)}/move`, { method: 'POST', body: { column } });
        await openTask(task.id);
        await loadBoard();
      },
    }, column))),
    el('h3', { text: 'History' }),
    el('ol', { class: 'timeline' }, (task.history || []).map(item => el('li', {}, [
      el('time', { text: fmtTime(item.at) }),
      el('div', { text: `${item.column || ''} · ${item.actor || ''}` }),
      el('div', { class: 'muted', text: item.note || '' }),
    ]))),
    el('h3', { text: 'Attempts' }),
    ...(task.attempts || []).map(attempt => el('p', {}, [chipForState(attempt.state), ' ', attempt.attemptId])),
  ]);
  back.addEventListener('click', event => { if (event.target === back) { state.task = null; render(); } });
  const wrap = el('div', {});
  wrap.append(back, panel);
  return wrap;
}

function workersView() {
  const selected = state.attempts.find(item => item.attemptId === state.attemptId) || null;
  return el('div', {}, [
    el('div', { class: 'launchers' }, (state.overview?.launchers || []).map(launcherCard)),
    el('div', { class: 'split' }, [
      el('div', { class: 'panel scroll' }, [
        el('h2', { text: 'Attempts' }),
        ...state.attempts.map(attempt => el('article', {
          class: 'task',
          onclick: () => { state.attemptId = attempt.attemptId; loadAttempt().catch(showError); },
        }, [
          el('div', { class: 'row' }, [chipForState(attempt.state), el('span', { class: 'mono', text: attempt.attemptId })]),
          el('p', { text: attempt.detail || attempt.taskId || '' }),
          el('p', { class: 'muted', text: attempt.holder || attempt.node || '' }),
        ])),
      ]),
      el('div', { class: 'panel' }, selected ? attemptDetail(selected) : el('p', { class: 'muted', text: 'Select an attempt.' })),
    ]),
  ]);
}

function attemptDetail(attempt) {
  const full = state.attemptDetail?.attemptId === attempt.attemptId ? state.attemptDetail : attempt;
  return el('div', {}, [
    el('h2', { text: full.attemptId }),
    el('div', { class: 'row' }, [chipForState(full.state), el('span', { class: 'muted', text: full.detail || '' })]),
    el('p', { class: 'mono', text: `node ${full.node || '—'} · sandbox ${full.sandbox || '—'} · run ${full.runId || '—'}` }),
    el('p', { class: 'muted', text: `${full.model || 'model unset'} · in ${full.tokensIn || 0} · out ${full.tokensOut || 0} · cost ${full.costUsd ?? '—'}` }),
    full.inputManifestSha256 ? el('p', { class: 'hash', text: `manifest ${full.inputManifestSha256}` }) : null,
    el('div', { class: 'row' }, [
      full.inFlight ? el('button', { class: 'btn danger', onclick: () => actAttempt(full.attemptId, 'cancel') }, 'Cancel') : null,
      !full.inFlight || full.state === 'cancel_requested' ? el('button', { class: 'btn', onclick: () => actAttempt(full.attemptId, 'retry') }, 'Retry') : null,
      full.state === 'succeeded' ? el('button', { class: 'btn good', onclick: () => actAttempt(full.attemptId, 'review', { accepted: true, note: 'accepted from control plane' }) }, 'Accept review') : null,
      full.state === 'succeeded' ? el('button', { class: 'btn', onclick: () => actAttempt(full.attemptId, 'review', { accepted: false, note: 'changes requested' }) }, 'Reject review') : null,
    ]),
    el('h3', { text: 'Changed files' }),
    ...(full.files || []).map(file => el('p', {}, [
      el('span', { text: `${file.path} · ${file.change || ''} · ${file.in_scope === false ? 'out of scope' : 'in scope'}` }),
      el('span', { class: 'hash', text: file.sha256 || '' }),
    ])),
    el('h3', { text: 'Events' }),
    ...(full.events || []).map(event => el('div', { class: 'tool' }, [
      approvalBlock(event.data || event) || el('span', { text: `${event.kind}: ${event.text}` }),
    ])),
  ]);
}

async function actAttempt(id, action, body = {}) {
  await api(`/api/v1/control/attempts/${encodeURIComponent(id)}/${action}`, { method: 'POST', body });
  state.error = `${action} queued for Orbit.`;
  await load();
}

function activityView() {
  return el('div', { class: 'panel' }, [
    el('h2', { text: 'Live events' }),
    el('div', {}, state.events.map(event => el('div', { class: 'event' }, [
      el('span', { class: 'muted', text: fmtTime(event.at) }),
      el('span', {}, [event.needsHuman ? el('span', { class: 'chip warn', text: 'needs decision' }) : event.disposition === 'auto_approved' ? el('span', { class: 'chip auto', text: 'auto-approved' }) : el('span', { class: 'chip', text: event.kind })]),
      el('span', { text: event.message }),
    ]))),
  ]);
}

function statsView() {
  const stats = state.stats;
  if (!stats) return el('p', { text: 'Loading…' });
  const rate = stats.successRate == null ? '—' : `${Math.round(stats.successRate * 100)}%`;
  const cycle = stats.avgCycleMs == null ? '—' : `${Math.round(stats.avgCycleMs / 3600000)} h`;
  return el('div', {}, [
    el('section', { class: 'kpis' }, [
      kpi('Success', rate, `${stats.succeeded} succeeded / ${stats.terminal} terminal`),
      kpi('Fail', stats.failRate == null ? '—' : `${Math.round(stats.failRate * 100)}%`, `${stats.failed} failed or rejected`),
      kpi('Cycle time', cycle, 'average todo to done'),
      kpi('Utilisation', stats.utilisation == null ? '—' : `${Math.round(stats.utilisation * 100)}%`, `${stats.running} running now`),
    ]),
    el('div', { class: 'charts' }, [
      el('div', { class: 'panel' }, [el('h2', { text: 'Queue depth' }), lineChart(stats.samples, 'queueDepth', '#f0b429')]),
      el('div', { class: 'panel' }, [el('h2', { text: 'Worker utilisation' }), lineChart(stats.samples, 'utilisation', '#3ddecb', true)]),
    ]),
    el('div', { class: 'panel' }, [
      el('h2', { text: 'Tokens and cost by model' }),
      table(['Model', 'Attempts', 'Succeeded', 'Failed', 'Tokens in', 'Tokens out', 'Reported cost'], (stats.models || []).map(model => [
        model.model, String(model.attempts), String(model.succeeded), String(model.failed),
        String(model.tokensIn), String(model.tokensOut), model.costUsd == null ? '—' : `$${model.costUsd}`,
      ])),
    ]),
    el('div', { class: 'panel' }, [el('h2', { text: 'Throughput' }), lineChart(stats.throughput, 'completed', '#8eacff')]),
  ]);
}

function lineChart(rows, key, color, ratio = false) {
  const values = (rows || []).map(row => Number(row[key] || 0));
  if (!values.length) return el('p', { class: 'muted', text: 'No samples yet.' });
  const width = 640;
  const height = 180;
  const pad = 16;
  const max = Math.max(ratio ? 1 : 1, ...values);
  const points = values.map((value, index) => {
    const x = pad + (index / Math.max(1, values.length - 1)) * (width - pad * 2);
    const y = height - pad - (value / max) * (height - pad * 2);
    return `${x},${y}`;
  }).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'chart');
  const grid = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  grid.setAttribute('d', `M${pad} ${height - pad} H${width - pad}`);
  grid.setAttribute('stroke', '#27344d');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '2.4');
  line.setAttribute('points', points);
  svg.append(grid, line);
  return svg;
}

function controlView() {
  const form = state.form;
  return el('div', { class: 'grid-2' }, [
    el('form', { class: 'panel stack', onsubmit: submitTask }, [
      el('h2', { text: 'Queue a task' }),
      el('input', { required: 'true', placeholder: 'Title', value: form.title, oninput: event => { form.title = event.target.value; } }),
      el('textarea', { class: 'wide', placeholder: 'Spec', oninput: event => { form.spec = event.target.value; } }, form.spec),
      el('div', { class: 'form-grid' }, [
        labeled('Project', el('input', { value: form.project, oninput: event => { form.project = event.target.value; } })),
        labeled('Group', el('input', { value: form.group, oninput: event => { form.group = event.target.value; } })),
        labeled('Priority', el('select', { onchange: event => { form.priority = event.target.value; } }, [1, 2, 3, 4, 5].map(n => el('option', { value: String(n), text: `P${n}`, selected: form.priority === String(n) ? '' : null })))),
        labeled('Depends on', el('input', { placeholder: 'titles, comma separated', value: form.dependencies, oninput: event => { form.dependencies = event.target.value; } })),
      ]),
      el('textarea', { placeholder: 'File scope, one path per line', oninput: event => { form.fileScope = event.target.value; } }, form.fileScope),
      el('div', { class: 'row' }, [
        el('button', { class: 'primary', type: 'submit' }, 'Queue task'),
        el('button', { class: 'btn', type: 'button', onclick: () => dispatch(true) }, 'Pause dispatch'),
        el('button', { class: 'btn', type: 'button', onclick: () => dispatch(false) }, 'Resume dispatch'),
      ]),
      el('div', { class: 'row' }, [
        el('input', { id: 'cap-node', value: 'brrrrrrrr' }),
        el('input', { id: 'cap-max', type: 'number', min: '1', max: '6', value: '2' }),
        el('button', { class: 'btn', type: 'button', onclick: setCap }, 'Queue concurrency cap'),
      ]),
    ]),
    el('div', {}, [
      el('div', { class: 'panel' }, [
        el('h2', { text: 'Intent queue' }),
        table(['When', 'Type', 'Status', 'Detail'], state.intents.slice(0, 12).map(intent => [
          fmtTime(intent.createdAt), intent.type, el('span', { class: 'chip', text: intent.status }), intent.result?.detail || intent.payload?.title || intent.payload?.attemptId || '',
        ])),
      ]),
      el('div', { class: 'panel' }, [
        el('h2', { text: 'Audit log' }),
        ...(state.audit || []).slice(0, 10).map(row => el('p', { class: 'muted', text: `${fmtTime(row.at)} ${row.actor} ${row.action} ${row.detail || ''}` })),
      ]),
    ]),
  ]);
}

function labeled(text, field) {
  return el('label', { class: 'stack' }, [el('span', { class: 'muted', text }), field]);
}

async function submitTask(event) {
  event.preventDefault();
  const form = state.form;
  await api('/api/v1/control/tasks', {
    method: 'POST',
    body: {
      title: form.title, spec: form.spec, project: form.project, group: form.group,
      priority: Number(form.priority), fileScope: form.fileScope, dependencies: form.dependencies,
    },
  });
  form.title = '';
  form.spec = '';
  state.error = 'Task queued. Orbit applies it on the next connector pull.';
  await load();
}

async function dispatch(paused) {
  await api('/api/v1/control/dispatch', { method: 'POST', body: { paused } });
  await load();
}

async function setCap() {
  const node = document.querySelector('#cap-node').value;
  const max = Number(document.querySelector('#cap-max').value);
  await api('/api/v1/control/concurrency', { method: 'POST', body: { node, max } });
  state.error = 'Concurrency change queued. Orbit does not apply the cap until the launcher hook exists.';
  await load();
}

function grokView() {
  const convo = state.grok.conversation;
  const messages = convo?.room?.messages || convo?.messages || [];
  const tools = convo?.tools || [];
  const cards = convo?.cards || [];
  return el('div', { class: 'grok' }, [
    el('aside', { class: 'panel grok-col' }, [
      el('h2', { text: 'Rooms' }),
      ...state.grok.groups.map(group => el('button', {
        class: `btn ${state.grok.selected === `group:${group.id}` ? 'active' : ''}`,
        onclick: () => selectGroup(group.id),
      }, group.name)),
      el('h2', { text: 'Agents' }),
      ...state.grok.roster.flatMap(group => (group.agents || []).map(agent => el('button', {
        class: 'btn',
        onclick: () => selectAgent(group.profile, agent),
      }, `${agent.name} · ${group.providerLabel || group.provider}`))),
    ]),
    el('section', { class: 'panel grok-col' }, [
      meter(convo?.context),
      el('div', { class: 'scroll' }, [
        ...cards.map(approvalBlock),
        ...messages.map(message => el('article', { class: `msg ${message.speaker || message.role || ''}` }, [
          el('div', { class: 'who', text: message.speaker || message.role || 'message' }),
          el('div', { text: message.text || message.content || '' }),
          ...tools.filter(tool => tool.after && tool.after === message.id).map(toolCard),
        ])),
      ]),
      el('form', { class: 'row', onsubmit: sendGrok }, [
        el('input', { style: 'flex:1', placeholder: 'Message the room via Orbit', value: state.draft, oninput: event => { state.draft = event.target.value; } }),
        el('button', { class: 'primary', type: 'submit' }, 'Send'),
      ]),
    ]),
    el('aside', { class: 'panel grok-col' }, [
      el('h2', { text: 'Activity' }),
      el('div', { class: 'scroll' }, state.grok.activity.map(item => approvalBlock(item) || el('div', { class: 'tool' }, [
        el('strong', { text: item.title || item.type || 'event' }),
        el('div', { text: item.detail || item.status || '' }),
      ]))),
    ]),
  ]);
}

function toolCard(tool) {
  const auto = tool.autoApproved === true || tool.needsHuman === false && /auto/.test(tool.status || '');
  return el('div', { class: 'tool' }, [
    el('strong', { text: tool.name || 'tool' }),
    auto ? el('span', { class: 'chip auto', text: 'Auto-approved' }) : el('span', { class: 'chip', text: tool.status || 'done' }),
    el('div', { text: tool.input || '' }),
    el('div', { class: 'muted', text: tool.output || '' }),
  ]);
}

function meter(context) {
  if (!context?.limit) return null;
  const pct = Math.max(0, Math.min(100, Math.round((context.used / context.limit) * 100)));
  return el('div', {}, [
    el('div', { class: 'meter-label', text: `${context.model || 'context'} · ${context.used.toLocaleString()} / ${context.limit.toLocaleString()} tokens` }),
    el('div', { class: 'bar' }, el('span', { style: `width:${pct}%` })),
  ]);
}

async function selectGroup(id) {
  state.grok.selected = `group:${id}`;
  const response = await api('/api/v1/grok', { method: 'POST', body: { action: 'groups', op: 'state', group: id } });
  state.grok.conversation = response.data;
  render();
}

async function selectAgent(profile, agent) {
  state.grok.profile = profile;
  state.grok.agent = agent.id;
  state.grok.selected = `agent:${agent.id}`;
  const response = await api('/api/v1/grok', { method: 'POST', body: { action: 'history', profile, agent: agent.id } });
  state.grok.conversation = response.data;
  render();
}

async function sendGrok(event) {
  event.preventDefault();
  const text = state.draft.trim();
  if (!text) return;
  const group = state.grok.selected.startsWith('group:') ? state.grok.selected.slice(6) : 'g-comfy';
  await api('/api/v1/grok', { method: 'POST', body: { action: 'groups', op: 'post', group, text } });
  state.draft = '';
  state.error = 'Message queued through the Orbit connector.';
  await selectGroup(group);
}

function renderBoardOnly() {
  if (state.view === 'board') render();
}

function render() {
  if (state.me === undefined) {
    app.replaceChildren(el('p', { class: 'main muted', text: 'Loading…' }));
    return;
  }
  if (state.me === null) {
    app.replaceChildren(loginView());
    return;
  }
  const view = {
    overview: ['Overview', 'Fleet, holders, and launcher slots', overviewView()],
    board: ['Board', 'Collab columns. Drag a card to queue a move.', boardView()],
    workers: ['Workers', 'Local OpenCode attempts and launcher caps', workersView()],
    activity: ['Activity', 'Events pushed by Orbit and by workers', activityView()],
    stats: ['Statistics', 'Throughput, cycle time, tokens, utilisation', statsView()],
    control: ['Control', 'Intents Orbit will pull and apply', controlView()],
    grok: ['Grok Bots', 'Proxied to the Orbit host. Agents are not reimplemented here.', grokView()],
  }[state.view] || ['Overview', '', overviewView()];
  app.replaceChildren(shell(view[0], view[1], view[2]));
}

function loginView() {
  return el('div', { class: 'login' }, el('form', {
    class: 'panel stack',
    onsubmit: async event => {
      event.preventDefault();
      const token = new FormData(event.target).get('token');
      const response = await fetch('/api/v1/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!response.ok) { state.error = 'That token was not accepted.'; render(); return; }
      state.error = '';
      await boot();
    },
  }, [
    el('h1', { text: 'Orbit Control Plane' }),
    el('p', { class: 'muted', text: 'Paste the viewer token. It is kept in an HttpOnly cookie and is not shown again.' }),
    state.error ? el('p', { class: 'error', text: state.error }) : null,
    el('input', { name: 'token', type: 'password', autocomplete: 'current-password', required: 'true', placeholder: 'Viewer token' }),
    el('button', { class: 'primary', type: 'submit' }, 'Enter'),
  ]));
}

async function loadBoard() {
  const data = await api('/api/v1/board');
  state.tasks = data.tasks;
}

async function loadAttempt() {
  if (!state.attemptId) return;
  const data = await api(`/api/v1/attempts/${encodeURIComponent(state.attemptId)}`);
  state.attemptDetail = data.attempt;
  render();
}

async function loadGrok() {
  const [groups, roster, activity] = await Promise.all([
    api('/api/v1/grok', { method: 'POST', body: { action: 'groups', op: 'list' } }),
    api('/api/v1/grok', { method: 'POST', body: { action: 'agents' } }),
    api('/api/v1/grok', { method: 'POST', body: { action: 'activity', profile: 'grok-main', agent: '11111111-1111-4111-8111-111111111111' } }),
  ]);
  state.grok.groups = groups.data?.groups || [];
  state.grok.roster = roster.data?.groups || [];
  state.grok.activity = activity.data?.items || [];
  if (!state.grok.conversation && state.grok.groups[0]) await selectGroup(state.grok.groups[0].id);
}

async function load() {
  state.me = await api('/api/v1/me');
  const [overview, events, stats, intents, audit, attempts] = await Promise.all([
    api('/api/v1/overview'),
    api('/api/v1/events?limit=80'),
    api('/api/v1/stats'),
    api('/api/v1/intents'),
    api('/api/v1/audit'),
    api('/api/v1/attempts'),
  ]);
  state.overview = overview;
  state.events = events.events.slice().reverse();
  state.stats = stats;
  state.intents = intents.intents;
  state.audit = audit.audit;
  state.attempts = attempts.attempts;
  if (!state.attemptId) state.attemptId = state.attempts.find(item => item.state === 'running')?.attemptId || state.attempts[0]?.attemptId;
  await loadBoard();
  if (state.attemptId) {
    const detail = await api(`/api/v1/attempts/${encodeURIComponent(state.attemptId)}`);
    state.attemptDetail = detail.attempt;
  }
  if (state.view === 'grok') await loadGrok();
  render();
}

async function boot() {
  try { await load(); }
  catch (error) {
    if (state.me !== null) showError(error);
  }
}

if (!location.hash) location.hash = '/overview';
window.addEventListener('hashchange', () => {
  state.view = location.hash.replace('#/', '') || 'overview';
  load().catch(showError);
});

const stream = new EventSource('/api/v1/stream');
stream.addEventListener('update', () => { if (state.me) load().catch(() => {}); });
boot();
