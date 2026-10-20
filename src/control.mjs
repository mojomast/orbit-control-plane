import { COLUMNS } from './columns.mjs';

const PATH_RE = /^[A-Za-z0-9_./@+-]{1,200}$/;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function text(value, max, field) {
  const out = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (out.length > max) fail(400, `${field} is too long`);
  return out;
}

function priorityOf(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) fail(400, 'priority must be an integer from 1 to 5');
  return n;
}

function paths(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || '').split(/[\n,]/).map(item => item.trim()).filter(Boolean);
  if (list.length > 40) fail(400, 'file scope is limited to 40 paths');
  return list.map(item => {
    const path = text(item, 200, 'file path');
    if (!PATH_RE.test(path) || path.includes('..')) fail(400, 'file scope paths must be relative and simple');
    return path;
  });
}

function deps(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  if (list.length > 20) fail(400, 'too many dependencies');
  return list.map(item => text(item, 160, 'dependency'));
}

export function queueTask(store, actor, body) {
  const title = text(body.title, 120, 'title');
  if (!title) fail(400, 'title is required');
  const spec = text(body.spec, 8000, 'spec');
  const project = text(body.project, 80, 'project');
  const group = text(body.group || body.groupName, 80, 'group');
  const task = store.insertLocalTask({
    title,
    spec,
    project,
    group,
    groupId: text(body.groupId, 80, 'group id') || null,
    priority: body.priority == null ? 3 : priorityOf(body.priority),
    fileScope: paths(body.fileScope ?? body.file_scope),
    dependencies: deps(body.dependencies),
  }, actor);
  const intent = store.enqueueIntent('task.create', {
    localId: task.id,
    title: task.title,
    spec: task.spec,
    project: task.project,
    group: task.groupName,
    groupId: task.groupId,
    priority: task.priority,
    fileScope: task.fileScope,
    dependencies: task.dependencies,
  }, actor);
  return { task: store.getTask(task.id), intent };
}

export function moveTask(store, actor, taskId, body) {
  const column = String(body.column || body.status || '');
  if (!COLUMNS.includes(column)) fail(400, 'column must be todo, doing, review, blocked, or done');
  const note = text(body.note, 500, 'note');
  const task = store.moveTask(taskId, column, actor, note || `move to ${column} queued`);
  const intent = store.enqueueIntent('task.move', {
    taskId: task.id,
    orbitId: task.orbitId,
    group: task.groupName,
    groupId: task.groupId,
    column,
    note,
  }, actor);
  return { task, intent };
}

export function reprioritise(store, actor, taskId, body) {
  const priority = priorityOf(body.priority);
  const task = store.setPriority(taskId, priority, actor);
  const intent = store.enqueueIntent('task.priority', {
    taskId: task.id,
    orbitId: task.orbitId,
    group: task.groupName,
    groupId: task.groupId,
    priority,
  }, actor);
  return { task, intent };
}

export function cancelAttempt(store, actor, attemptId) {
  const attempt = store.getAttempt(attemptId);
  if (!attempt) fail(404, 'unknown attempt');
  if (!attempt.inFlight) fail(409, 'only an in-flight attempt can be cancelled');
  const intent = store.enqueueIntent('attempt.cancel', { attemptId, taskId: attempt.taskId, node: attempt.node }, actor);
  return { attempt, intent };
}

export function retryAttempt(store, actor, attemptId) {
  const attempt = store.getAttempt(attemptId);
  if (!attempt) fail(404, 'unknown attempt');
  if (attempt.inFlight && attempt.state !== 'cancel_requested') fail(409, 'retry is for a finished attempt');
  const intent = store.enqueueIntent('attempt.retry', {
    attemptId,
    taskId: attempt.taskId,
    boardEntry: attempt.boardEntry,
    group: attempt.groupName,
    groupId: attempt.groupId,
    node: attempt.node,
  }, actor);
  return { attempt, intent };
}

export function reviewAttempt(store, actor, attemptId, body) {
  const attempt = store.getAttempt(attemptId);
  if (!attempt) fail(404, 'unknown attempt');
  if (attempt.state !== 'succeeded' && attempt.state !== 'review') fail(409, 'only a succeeded attempt can be reviewed');
  if (typeof body.accepted !== 'boolean') fail(400, 'accepted must be true or false');
  const note = text(body.note, 500, 'note');
  const intent = store.enqueueIntent('attempt.review', {
    attemptId,
    taskId: attempt.taskId,
    accepted: body.accepted,
    note,
  }, actor);
  return { attempt, intent };
}

export function setDispatch(store, actor, body) {
  if (typeof body.paused !== 'boolean') fail(400, 'paused must be true or false');
  store.setPaused(body.paused, actor);
  const intent = store.enqueueIntent('dispatch.pause', { paused: body.paused }, actor);
  return { paused: body.paused, intent };
}

export function setConcurrency(store, actor, body) {
  const node = text(body.node, 64, 'node');
  if (!node) fail(400, 'node is required');
  const max = Number(body.max ?? body.concurrencyMax);
  if (!Number.isInteger(max) || max < 1 || max > 6) fail(400, 'concurrency max must be an integer from 1 to 6');
  store.setDesiredConcurrency(node, max, actor);
  const intent = store.enqueueIntent('launcher.concurrency', { node, max }, actor);
  return { node, max, intent };
}
