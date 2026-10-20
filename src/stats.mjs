import { isTerminalAttempt } from './columns.mjs';

const OK = new Set(['succeeded', 'accepted']);
const BAD = new Set(['failed', 'cancelled', 'not_started', 'rejected']);

function hourKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 13) + ':00:00.000Z';
}

export function buildStats(store) {
  const attempts = store.listAttempts();
  const tasks = store.listTasks();
  const samples = store.listSamples();
  const launchers = store.listLaunchers();
  const models = new Map();
  const throughput = new Map();
  let ok = 0;
  let bad = 0;
  let terminal = 0;
  for (const attempt of attempts) {
    const model = attempt.model || 'unknown';
    const bucket = models.get(model) || { model, attempts: 0, succeeded: 0, failed: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
    bucket.attempts += 1;
    bucket.tokensIn += attempt.tokensIn || 0;
    bucket.tokensOut += attempt.tokensOut || 0;
    bucket.costUsd += attempt.costUsd || 0;
    if (OK.has(attempt.state)) bucket.succeeded += 1;
    if (BAD.has(attempt.state)) bucket.failed += 1;
    models.set(model, bucket);
    if (isTerminalAttempt(attempt.state)) {
      terminal += 1;
      if (OK.has(attempt.state)) ok += 1;
      else if (BAD.has(attempt.state)) bad += 1;
      const key = hourKey(attempt.endedAt || attempt.updatedAt);
      if (key && (OK.has(attempt.state) || BAD.has(attempt.state) || attempt.state === 'cancelled')) {
        const row = throughput.get(key) || { at: key, completed: 0, failed: 0 };
        if (OK.has(attempt.state)) row.completed += 1;
        if (BAD.has(attempt.state)) row.failed += 1;
        throughput.set(key, row);
      }
    }
  }
  const cycles = tasks
    .filter(task => task.column === 'done' && task.createdAt && task.updatedAt)
    .map(task => new Date(task.updatedAt) - new Date(task.createdAt))
    .filter(ms => ms >= 0);
  const avgCycleMs = cycles.length ? Math.round(cycles.reduce((sum, ms) => sum + ms, 0) / cycles.length) : null;
  const used = launchers.reduce((sum, node) => sum + (node.concurrencyUsed || 0), 0);
  const cap = launchers.reduce((sum, node) => sum + (node.concurrencyMax || 0), 0);
  const running = attempts.filter(attempt => attempt.state === 'running' || attempt.state === 'starting' || attempt.state === 'backoff').length;
  const inFlight = attempts.filter(attempt => attempt.inFlight).length;
  const queueDepth = attempts.filter(attempt => attempt.state === 'queued' || attempt.state === 'launcher_queued').length
    + tasks.filter(task => task.column === 'todo').length;
  return {
    models: [...models.values()].map(model => ({ ...model, costUsd: round(model.costUsd) })),
    successRate: terminal ? ok / terminal : null,
    failRate: terminal ? bad / terminal : null,
    succeeded: ok,
    failed: bad,
    terminal,
    avgCycleMs,
    throughput: [...throughput.values()].sort((a, b) => a.at.localeCompare(b.at)),
    samples,
    utilisation: cap ? used / cap : null,
    running,
    inFlight,
    queueDepth,
    launchers,
  };
}

export function snapshotSample(store) {
  const stats = buildStats(store);
  store.recordSample({
    queueDepth: stats.queueDepth,
    inFlight: stats.inFlight,
    running: stats.running,
    utilisation: stats.utilisation,
    tokensIn: stats.models.reduce((sum, model) => sum + model.tokensIn, 0),
    tokensOut: stats.models.reduce((sum, model) => sum + model.tokensOut, 0),
    costUsd: stats.models.reduce((sum, model) => sum + model.costUsd, 0),
  });
  return stats;
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}
