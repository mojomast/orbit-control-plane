export const COLUMNS = ['todo', 'doing', 'review', 'blocked', 'done'];

const FROM_ORBIT = {
  todo: 'todo',
  submitted: 'todo',
  queued: 'todo',
  doing: 'doing',
  working: 'doing',
  'in-progress': 'doing',
  in_progress: 'doing',
  review: 'review',
  blocked: 'blocked',
  'input-required': 'blocked',
  failed: 'blocked',
  canceled: 'blocked',
  cancelled: 'blocked',
  rejected: 'blocked',
  done: 'done',
  completed: 'done',
  accepted: 'done',
};

export function toColumn(status) {
  const key = String(status || '').trim().toLowerCase();
  return FROM_ORBIT[key] || null;
}

export const ATTEMPT_STATES = [
  'queued',
  'launcher_queued',
  'dispatching',
  'starting',
  'running',
  'backoff',
  'disconnected',
  'cancel_requested',
  'outcome_unknown',
  'not_started',
  'succeeded',
  'failed',
  'cancelled',
  'superseded',
  'accepted',
  'rejected',
];

export const TERMINAL_ATTEMPTS = new Set([
  'succeeded', 'failed', 'cancelled', 'superseded', 'not_started', 'accepted', 'rejected',
]);

export function isTerminalAttempt(state) {
  return TERMINAL_ATTEMPTS.has(state);
}
