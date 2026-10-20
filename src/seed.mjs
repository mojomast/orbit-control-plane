import { createHash } from 'node:crypto';
import { normalizeGrokPayload } from './approvals.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');

function ago(ms, now) {
  return new Date(now - ms).toISOString();
}

export function seedDemo(store, now = Date.now()) {
  const hour = 60 * 60 * 1000;
  const groups = [
    {
      id: 'g-comfy',
      name: 'Comfyrizz build',
      project: 'comfyrizz',
      tasks: [
        task('t_docs', 'Document Tailscale firewall', 'todo', 2, 'MR.INDIA', 'Write the launcher firewall notes for the tailnet-only port.', ['docs/LOCAL_WORKERS.md'], [], ago(6 * hour, now)),
        task('t_conc', 'Raise launcher concurrency to 2', 'todo', 1, 'kyle', 'Cap stays inside the hard limit of 6. Apply only after the probe is green.', ['pc-launcher/config.json'], ['Pin cua 0.5.0 sandbox image'], ago(5 * hour, now)),
        task('t_health', 'Wire launcher health into the board note', 'doing', 2, 'local-workers', 'Running on brrrrrrrr. Health fields land in the attempt detail.', ['server/local-workers.mjs'], [], ago(4 * hour, now), 'run-8ba3961e is in the sandbox'),
        task('t_disc', 'Reattach after the tailscale blip', 'doing', 2, 'local-workers', 'Attempt stayed disconnected instead of failed. Reconcile must not re-dispatch.', ['server/local-workers.mjs'], [], ago(3 * hour, now), 'launcher unreachable'),
        task('t_unknown', 'Reconcile an unacked dispatch', 'doing', 1, 'local-workers', 'POST was not acknowledged. Leave it outcome_unknown until the launcher answers.', ['server/local-workers.mjs'], [], ago(90 * 60 * 1000, now), 'will reconcile, not re-send'),
        task('t_export', 'LF-exact git archive for patches', 'review', 2, 'hermes', 'Export with autocrlf off so sha256 matches the committed bytes.', ['pc-launcher/export.py'], ['Pin cua 0.5.0 sandbox image'], ago(8 * hour, now), 'patch applied, unittest 4/4'),
        task('t_crlf', 'Explain the CRLF sha256 mismatch', 'blocked', 3, 'grok', 'Windows checkout rewrote line endings. The archive pin is the fix; this note records the failed run.', ['pc-launcher/export.py'], [], ago(26 * hour, now), 'sha256 differed on README.md'),
        task('t_pin', 'Pin cua 0.5.0 sandbox image', 'done', 2, 'hermes', 'Image ghcr.io/trycua/linux pinned to sha256:fd00735c…', ['pc-launcher/launcher.py'], [], ago(30 * hour, now), 'accepted'),
      ],
    },
    {
      id: 'g-docs',
      name: 'Orbit docs',
      project: 'orbitdesktop',
      tasks: [
        task('t_hooks', 'Propose control-plane hooks', 'todo', 3, 'kyle', 'Dispatch pause and concurrency still need an Orbit-side read of the hook files.', ['docs/LOCAL_WORKERS.md'], [], ago(2 * hour, now)),
        task('t_boardkey', 'Confirm collab-board key stays on the box', 'done', 4, 'MR.INDIA', 'The connector reads the key locally and never forwards it.', ['server/collab-board.mjs'], [], ago(20 * hour, now), 'verified'),
      ],
    },
  ];

  for (const group of groups) {
    store.upsertTasks(group.tasks.map(item => ({
      ...item,
      groupId: group.id,
      groupName: group.name,
      project: group.project,
      history: item.history,
      checkins: item.checkins,
    })), { source: 'orbit', actor: 'seed' });
  }

  const attempts = [
    attempt('att_queued', 't_docs', 'queued', 'waiting for a slot', { node: 'brrrrrrrr', created: ago(20 * 60 * 1000, now) }),
    attempt('att_lqueue', 't_conc', 'launcher_queued', 'position 2', { node: 'brrrrrrrr', created: ago(15 * 60 * 1000, now) }),
    attempt('att_running', 't_health', 'running', 'opencode session live', {
      node: 'brrrrrrrr', sandbox: 'orbit-154ccad0934f', runId: 'run-8ba3961e', sessionId: 'oc_sess_health',
      model: 'deepseek-v4.1-flash', tokensIn: 18220, tokensOut: 4104, cost: 0.0042, created: ago(50 * 60 * 1000, now),
      manifest: sha('health-brief'),
      files: [{ path: 'server/local-workers.mjs', sha256: sha('local-workers.mjs'), change: 'modified', in_scope: true }],
    }),
    attempt('att_disc', 't_disc', 'disconnected', 'launcher unreachable (ECONNREFUSED); attempt keeps running on the PC', {
      node: 'brrrrrrrr', sandbox: 'orbit-disc-11', runId: 'run-disc11', model: 'deepseek-v4.1-flash', created: ago(70 * 60 * 1000, now),
    }),
    attempt('att_cancel', 't_unknown', 'cancel_requested', 'waiting for the launcher to confirm', {
      node: 'brrrrrrrr', sandbox: 'orbit-can-4', runId: 'run-can4', model: 'deepseek-v4.1-flash', created: ago(40 * 60 * 1000, now),
    }),
    attempt('att_unknown', 't_unknown', 'outcome_unknown', 'launcher did not confirm; will reconcile, not re-send blindly', {
      node: 'brrrrrrrr', model: 'deepseek-v4.1-flash', created: ago(35 * 60 * 1000, now), generation: 1,
    }),
    attempt('att_notstarted', 't_crlf', 'not_started', 'launcher rejected: project is not authorized', {
      node: 'brrrrrrrr', model: 'deepseek-v4.1-flash', created: ago(25 * hour, now), ended: ago(25 * hour, now), generation: 1,
    }),
    attempt('att_ok', 't_export', 'succeeded', 'patch applied, unittest 4/4', {
      node: 'brrrrrrrr', sandbox: 'orbit-154ccad0934f', runId: 'run-export1', sessionId: 'oc_sess_export',
      model: 'deepseek-v4.1-flash', tokensIn: 24010, tokensOut: 6320, cost: 0.0061,
      created: ago(9 * hour, now), ended: ago(8 * hour, now),
      manifest: sha('export-brief'),
      files: [
        { path: 'pc-launcher/export.py', sha256: sha('export.py'), change: 'modified', in_scope: true },
        { path: 'pc-launcher/tests/test_export_and_scripts.py', sha256: sha('test_export'), change: 'modified', in_scope: true },
      ],
    }),
    attempt('att_fail', 't_crlf', 'failed', 'unittest assertion on README sha256', {
      node: 'brrrrrrrr', sandbox: 'orbit-fail-2', runId: 'run-fail2', model: 'deepseek-v4.1-flash',
      tokensIn: 9000, tokensOut: 1200, cost: 0.0016, created: ago(27 * hour, now), ended: ago(26 * hour, now), generation: 2,
      files: [{ path: 'README.md', sha256: sha('readme-crlf'), change: 'modified', in_scope: false }],
    }),
    attempt('att_cancelled', 't_disc', 'cancelled', 'cancelled, confirmed by the launcher', {
      node: 'studio-mini', runId: 'run-oldc', model: 'deepseek-v4.1-flash', created: ago(12 * hour, now), ended: ago(11 * hour, now), generation: 1,
    }),
    attempt('att_super', 't_export', 'superseded', 'replaced by att_ok', {
      node: 'brrrrrrrr', model: 'deepseek-v4.1-flash', created: ago(10 * hour, now), ended: ago(9 * hour, now),
      generation: 1, supersededBy: 'att_ok',
    }),
  ];
  store.upsertAttempts(attempts, { actor: 'seed' });

  store.addAttemptEvents('att_running', [
    { seq: 1, at: ago(48 * 60 * 1000, now), kind: 'worker:session', text: 'oc_sess_health', data: { session: 'oc_sess_health' } },
    { seq: 2, at: ago(40 * 60 * 1000, now), kind: 'acp.permission', text: 'write pc-launcher/export.py', data: { status: 'pending', source: 'cua', autoApproved: true, command: 'write file' } },
    { seq: 3, at: ago(30 * 60 * 1000, now), kind: 'tool', text: 'applied patch', data: { files: 1 } },
  ], { source: 'seed' });
  store.addAttemptEvents('att_ok', [
    { seq: 1, at: ago(8.5 * hour, now), kind: 'check', text: 'unittest 4/4', data: { passed: 4 } },
    { seq: 2, at: ago(8.2 * hour, now), kind: 'result', text: 'observed files hashed', data: { files: 2 } },
  ], { source: 'seed' });

  store.addEvents([
    { at: ago(10 * 60 * 1000, now), kind: 'launcher.health', level: 'info', message: 'brrrrrrrr healthy, 2 of 4 slots busy', attemptId: null, taskId: null, data: { node: 'brrrrrrrr' } },
    { at: ago(8 * 60 * 1000, now), kind: 'board.sync', level: 'info', message: 'Comfyrizz build: LF-exact archive moved to review', taskId: 't_export' },
    { at: ago(4 * 60 * 1000, now), kind: 'worker.disconnected', level: 'warn', message: 'att_disc lost the tailnet path; not marked failed', attemptId: 'att_disc', taskId: 't_disc' },
  ], 'seed');

  store.upsertLaunchers([
    { node: 'brrrrrrrr', healthy: true, version: '0.1.2', model: 'deepseek-v4.1-flash', concurrencyUsed: 2, concurrencyMax: 4, queued: 2, detail: 'Docker Desktop, runc', updatedAt: ago(30 * 1000, now) },
    { node: 'studio-mini', healthy: false, version: '0.1.2', model: 'deepseek-v4.1-flash', concurrencyUsed: 0, concurrencyMax: 1, queued: 0, detail: 'tailscale timeout', updatedAt: ago(8 * 60 * 1000, now) },
  ]);
  store.heartbeat({ source: 'orbit', kind: 'orbit', detail: 'connector snapshot' });
  store.heartbeat({ source: 'worker_brrrrrrrr', kind: 'worker', node: 'brrrrrrrr', detail: 'attempt att_running' });

  for (let i = 36; i >= 0; i--) {
    const at = ago(i * hour, now);
    const wave = 3 + Math.round(2 * Math.sin(i / 3));
    store.recordSample({
      at,
      queueDepth: wave + (i % 5 === 0 ? 2 : 0),
      inFlight: 2 + (i % 4),
      running: 1 + (i % 3 === 0 ? 1 : 0),
      utilisation: (1 + (i % 3)) / 4,
      tokensIn: 12000 + i * 400,
      tokensOut: 3000 + i * 90,
      costUsd: 0.02 + i * 0.001,
    });
  }

  store.enqueueIntent('task.create', {
    localId: 'cp_demo_pending',
    title: 'Add a queue-depth sparkline to the overview',
    spec: 'Read samples, do not invent a second series.',
    project: 'orbit-control-plane',
    group: 'Orbit docs',
    priority: 3,
    fileScope: ['public/app.js'],
    dependencies: [],
  }, 'kyle');
  const applied = store.enqueueIntent('attempt.review', { attemptId: 'att_pin_old', accepted: true, note: 'image pin matches the doc' }, 'kyle');
  store.finishIntent(applied.id, { outcome: 'applied', detail: 'review recorded on Orbit', actor: 'orbit' });
  const deferred = store.enqueueIntent('launcher.concurrency', { node: 'brrrrrrrr', max: 2 }, 'kyle');
  store.finishIntent(deferred.id, { outcome: 'deferred', detail: 'written to control-plane/concurrency.json; launcher has no set-cap API yet', actor: 'orbit' });
  store.setDesiredConcurrency('brrrrrrrr', 2, 'kyle');

  const grok = normalizeGrokPayload(grokBundle(now));
  store.saveGrok({
    bundle: grok,
    roster: grok.roster,
    groups: grok.groups,
    activity: grok.activity,
    'group:g-comfy': grok.conversations['group:g-comfy'],
    'history:grok-main:11111111-1111-4111-8111-111111111111': grok.conversations['history:grok-main:11111111-1111-4111-8111-111111111111'],
    'activity:grok-main:11111111-1111-4111-8111-111111111111': grok.activity,
  });
  store.audit({ actor: 'seed', action: 'demo.seed', target: 'database', detail: 'demo snapshot loaded' });
}

function task(id, title, column, priority, owner, spec, fileScope, dependencies, created, summary = '') {
  return {
    id,
    title,
    column,
    priority,
    owner,
    holder: owner,
    spec,
    fileScope,
    dependencies,
    summary,
    createdAt: created,
    updatedAt: column === 'done' ? new Date(new Date(created).getTime() + 5 * 60 * 60 * 1000).toISOString() : created,
    history: [
      { at: created, column: 'todo', note: 'opened', actor: owner },
      ...(column !== 'todo' ? [{ at: created, column, note: summary || `moved to ${column}`, actor: 'local-workers' }] : []),
    ],
    checkins: summary ? [{ at: created, note: summary, by: owner }] : [],
  };
}

function attempt(attemptId, taskId, state, detail, extra) {
  return {
    attemptId,
    taskId,
    boardEntry: taskId,
    groupName: 'Comfyrizz build',
    groupId: 'g-comfy',
    generation: extra.generation || (state === 'superseded' ? 1 : 2),
    state,
    detail,
    node: extra.node,
    sandbox: extra.sandbox || null,
    runId: extra.runId || null,
    sessionId: extra.sessionId || null,
    model: extra.model || 'deepseek-v4.1-flash',
    provider: 'opencode-go',
    coordinator: 'MR.INDIA',
    inputManifestSha256: extra.manifest || null,
    tokensIn: extra.tokensIn || 0,
    tokensOut: extra.tokensOut || 0,
    costUsd: extra.cost ?? null,
    createdAt: extra.created,
    updatedAt: extra.ended || extra.created,
    endedAt: extra.ended || null,
    supersededBy: extra.supersededBy || null,
    files: extra.files || [],
    holder: extra.sandbox ? `${extra.node} / ${extra.sandbox}` : extra.node,
  };
}

function grokBundle(now) {
  const agent = '11111111-1111-4111-8111-111111111111';
  return {
    roster: {
      groups: [
        {
          profile: 'grok-main', provider: 'grok', providerLabel: 'Grok Bot', label: 'Grok Bot', kind: 'gateway',
          agents: [{
            id: agent, name: 'Orbit collab', running: true, awaiting: false, unread: 1,
            preview: 'Checking launcher health on brrrrrrrr.',
            context: { used: 48200, limit: 128000, model: 'grok-4' },
          }],
        },
        {
          profile: 'hermes-main', provider: 'hermes', providerLabel: 'Hermes', label: 'Hermes', kind: 'sessions',
          agents: [{ id: 'hermes-main', name: 'Hermes', sessions: true, running: false, preview: 'Archive export is in review.' }],
        },
      ],
    },
    groups: {
      groups: [{
        id: 'g-comfy', name: 'Comfyrizz build', mode: 'parallel', defaultResponder: 'hermes',
        members: [
          { id: 'hermes', label: 'Hermes', provider: 'hermes' },
          { id: 'grok', label: 'Grok Bot', provider: 'grok' },
          { id: 'mr_india', label: 'MR.INDIA', provider: 'grok' },
        ],
      }],
    },
    conversations: {
      'group:g-comfy': {
        group: { id: 'g-comfy', name: 'Comfyrizz build' },
        room: {
          paused: false,
          activity: 'Hermes is writing the export note',
          messages: [
            { id: 'm1', speaker: 'owner', text: 'Track the LF archive fix on the Comfyrizz board and keep the sandbox as the boundary.', at: now - 30 * 60 * 1000 },
            { id: 'm2', speaker: 'hermes', text: 'Entry t_export is in review. unittest 4/4. I will not treat the Cua file write as something you still need to approve.', at: now - 20 * 60 * 1000 },
            { id: 'm3', speaker: 'grok', text: 'I can run npm test in the group clone if you allow it. That one is actually waiting.', at: now - 8 * 60 * 1000 },
          ],
        },
        tools: [
          { id: 'tool-read', name: 'read_file', status: 'done', input: 'pc-launcher/export.py', output: 'git archive with autocrlf off', after: 'm2', durationMs: 840 },
          { id: 'tool-write', name: 'acp.write', status: 'auto-approved', input: 'pc-launcher/export.py', output: 'Cua auto-approved inside the sandbox', needsHuman: false, autoApproved: true, after: 'm2' },
        ],
        cards: [
          { type: 'permission', kind: 'acp.permission', status: 'pending', source: 'cua', autoApproved: true, summary: 'ACP write pc-launcher/export.py', command: 'write file', decidedBy: 'cua' },
          { type: 'local-tool', kind: 'approval.pending', status: 'pending', summary: 'Run npm test', command: 'npm test', entryId: 'card-npm', requestId: 'req-npm' },
        ],
        context: { used: 48200, limit: 128000, model: 'grok-4' },
      },
      'history:grok-main:11111111-1111-4111-8111-111111111111': {
        messages: [
          { id: 'h1', role: 'user', content: 'What is in flight on brrrrrrrr?', ts: now - 15 * 60 * 1000 },
          { id: 'h2', role: 'assistant', content: 'att_running holds the health probe in sandbox orbit-154ccad0934f. att_disc is disconnected, not failed.', ts: now - 14 * 60 * 1000 },
        ],
        tools: [{ id: 'tool-board', name: 'collab-board', status: 'done', input: 'list', output: '8 entries', after: 'h1', durationMs: 120 }],
        cards: [],
        streaming: null,
        context: { used: 22000, limit: 128000, model: 'grok-4' },
      },
    },
    activity: {
      items: [
        { type: 'tool', title: 'read_file', status: 'done', detail: 'pc-launcher/export.py', ts: now - 20 * 60 * 1000, needsHuman: false },
        { type: 'tool', kind: 'acp.permission', title: 'ACP write', status: 'pending', source: 'cua', autoApproved: true, detail: 'Cua auto-approved the write. Not a human decision.', ts: now - 18 * 60 * 1000 },
        { type: 'needs-input', kind: 'approval.pending', title: 'Approval: run npm test', status: 'pending', detail: 'Group clone wants npm test', ts: now - 8 * 60 * 1000 },
        { type: 'state', title: 'Working', status: 'running', detail: 'Orbit collab is composing', ts: now - 2 * 60 * 1000, needsHuman: false },
      ],
    },
    describe: { provider: 'grok', controls: ['approval.localTool', 'widget.respond'] },
  };
}
