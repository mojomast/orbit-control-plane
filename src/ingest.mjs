import { normalizeApprovalEvent, normalizeGrokPayload } from './approvals.mjs';
import { scrub } from './redact.mjs';

const MAX_ITEMS = 500;

function list(value, name) {
  if (!Array.isArray(value)) {
    const error = new Error(`${name} must be an array`);
    error.status = 400;
    throw error;
  }
  if (value.length > MAX_ITEMS) {
    const error = new Error(`${name} exceeds ${MAX_ITEMS} items`);
    error.status = 413;
    throw error;
  }
  return value;
}

function requireOrbit(auth) {
  if (auth.role !== 'orbit') {
    const error = new Error('this ingest route is reserved for the Orbit connector');
    error.status = 403;
    throw error;
  }
}

export function ingestHeartbeat(store, auth, body) {
  const node = body.node || auth.node || null;
  if (auth.role === 'worker' && auth.node && node && node !== auth.node) {
    const error = new Error('worker token is bound to another node');
    error.status = 403;
    throw error;
  }
  store.heartbeat({
    source: auth.id,
    kind: body.kind || auth.role,
    node,
    detail: String(body.detail || body.status || '').slice(0, 300),
  });
  return { ok: true };
}

export function ingestBoard(store, auth, body) {
  requireOrbit(auth);
  const groups = list(body.groups || body.tasks && [{ tasks: body.tasks, name: body.group }] || [], 'groups');
  const tasks = [];
  for (const group of groups) {
    const groupTasks = Array.isArray(group.tasks) ? group.tasks : [];
    for (const task of groupTasks) {
      tasks.push({
        ...task,
        groupId: task.groupId || group.id || null,
        groupName: task.groupName || group.name || group.group || null,
        project: task.project || group.project || null,
      });
    }
  }
  const ids = store.upsertTasks(tasks, { source: 'orbit', actor: auth.id });
  return { ok: true, tasks: ids.length };
}

export function ingestAttempts(store, auth, body) {
  if (auth.role !== 'orbit' && auth.role !== 'worker') {
    const error = new Error('attempts are reported by Orbit or the assigned worker');
    error.status = 403;
    throw error;
  }
  const attempts = list(body.attempts || (body.attempt ? [body.attempt] : []), 'attempts').map(attempt => {
    if (auth.role === 'worker') {
      const { review, ...rest } = attempt;
      return rest;
    }
    return attempt;
  });
  const ids = store.upsertAttempts(attempts, {
    actor: auth.id,
    restrictNode: auth.role === 'worker' ? auth.node : undefined,
  });
  return { ok: true, attempts: ids.length };
}

export function ingestEvents(store, auth, body, secrets) {
  if (auth.role !== 'orbit' && auth.role !== 'worker') {
    const error = new Error('events are reported by Orbit or the assigned worker');
    error.status = 403;
    throw error;
  }
  const events = list(body.events || [], 'events').map(event => normalizeApprovalEvent(scrub(event, secrets)));
  const byAttempt = new Map();
  const loose = [];
  for (const event of events) {
    const attemptId = event.attemptId || event.attempt_id;
    if (attemptId && event.seq != null) {
      if (!byAttempt.has(attemptId)) byAttempt.set(attemptId, []);
      byAttempt.get(attemptId).push(event);
    } else if (auth.role === 'worker') {
      const error = new Error('workers report events only against their assigned attempt');
      error.status = 400;
      throw error;
    } else loose.push(event);
  }
  let stored = 0;
  for (const [attemptId, rows] of byAttempt) {
    stored += store.addAttemptEvents(attemptId, rows, {
      restrictNode: auth.role === 'worker' ? auth.node : undefined,
      source: auth.id,
    });
  }
  if (loose.length) store.addEvents(loose, auth.id);
  return { ok: true, stored: stored + loose.length };
}

export function ingestLaunchers(store, auth, body) {
  requireOrbit(auth);
  const nodes = list(body.nodes || [], 'nodes');
  store.upsertLaunchers(nodes);
  return { ok: true, nodes: nodes.length };
}

export function ingestGrok(store, auth, body, secrets) {
  requireOrbit(auth);
  const snapshots = body.snapshots && typeof body.snapshots === 'object' ? body.snapshots : {};
  if (body.key) snapshots[body.key] = body.data;
  const clean = {};
  for (const [key, value] of Object.entries(snapshots)) {
    clean[String(key).slice(0, 200)] = normalizeGrokPayload(scrub(value, secrets));
  }
  store.saveGrok(clean);
  return { ok: true, keys: Object.keys(clean) };
}
