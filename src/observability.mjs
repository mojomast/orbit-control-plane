// Redacted rizzstack observability snapshot (schema rizzstack.observability/1).
//
// Pure functions only: no network, no filesystem, no credentials. Collectors
// (scripts/obs-snapshot.mjs) gather raw inputs and hand them here. The output
// carries counts, short labels and repo/check names, and nothing else, so a chat
// card built from it cannot leak keys, hosts, IPs or paths.

export const SCHEMA = 'rizzstack.observability/1';

const IN_FLIGHT = new Set(['running', 'starting', 'backoff', 'cancel_requested', 'disconnected']);
const QUEUED = new Set(['queued', 'launcher_queued']);
const FAILED = new Set(['failed', 'not_started', 'rejected', 'outcome_unknown']);
const PROVIDERS = ['OpenCode Go', 'DeepSeek', 'OpenRouter'];

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi;
const EMAIL = /[\w.+-]+@[\w.-]+/g;
const HOSTNAME = /\b[\w-]+(?:\.[\w-]+)*\.(?:ts\.net|local|internal|lan|home\.arpa)\b/gi;
const WIN_PATH = /\b[A-Za-z]:\\[^\s"'`]*/g;
const POSIX_PATH = /(?:^|[\s("'`=])\/(?:home|Users|root|etc|var|opt|tmp|mnt|workspace|run)\/[^\s"'`)]*/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const KEYISH = /\b(?:sk|xai|ghp|gho|ghs|ghu|github_pat|glpat|xox[abpr]|AKIA|AIza|hf|ocg)[-_A-Za-z0-9]{8,}/g;
const ASSIGNED = /((?:api[_-]?key|token|secret|password|passwd|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeText(value, max = 80) {
  let text = String(value ?? '');
  text = text
    .replace(WIN_PATH, '[path]')
    .replace(POSIX_PATH, (m) => m.slice(0, m.length - m.trimStart().length) + '[path]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(KEYISH, '[redacted]')
    .replace(ASSIGNED, '$1[redacted]')
    .replace(EMAIL, '[email]')
    .replace(HOSTNAME, '[host]')
    .replace(IPV4, '[ip]')
    .replace(IPV6, '[ip]')
    .replace(CONTROL, ' ')
    .replace(/\$\{/g, '$ {')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export function providerOf(model) {
  const m = String(model ?? '').toLowerCase();
  if (!m) return 'Other';
  if (m.startsWith('go:') || m.startsWith('opencode-go') || m.startsWith('opencode/')) return 'OpenCode Go';
  if (m.startsWith('deepseek:') || m.startsWith('deepseek/')) return 'DeepSeek';
  if (m.startsWith('openrouter')) return 'OpenRouter';
  // The Go pool serves the bare deepseek ids.
  if (m.startsWith('deepseek-')) return 'OpenCode Go';
  return 'Other';
}

function parseUsage(raw) {
  let u = raw;
  if (typeof u === 'string') {
    try { u = JSON.parse(u); } catch { return {}; }
  }
  return u && typeof u === 'object' ? u : {};
}

const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

// Orbit `local-workers` list entry -> neutral shape.
export function normalizeOrbitAttempt(raw) {
  const observed = raw?.result?.observed || {};
  const usage = parseUsage(observed.usage);
  return {
    id: String(raw?.attempt_id || raw?.attemptId || ''),
    project: raw?.result?.source?.project || raw?.project || null,
    model: raw?.model_used || raw?.model || null,
    state: String(raw?.state || ''),
    detail: raw?.detail || '',
    createdAt: raw?.created_at || raw?.createdAt || null,
    updatedAt: raw?.updated_at || raw?.updatedAt || null,
    endedAt: raw?.ended_at || raw?.endedAt || null,
    tokensIn: n(usage.inputTokens ?? raw?.tokensIn),
    tokensOut: n(usage.outputTokens ?? raw?.tokensOut),
    tokensCached: n(usage.cachedReadTokens),
  };
}

// Control-plane store attempt (camelCase) -> same neutral shape.
export function normalizeStoreAttempt(row) {
  return {
    id: String(row.attemptId || ''), project: row.groupName || null, model: row.model || null,
    state: String(row.state || ''), detail: row.detail || '', createdAt: row.createdAt, updatedAt: row.updatedAt,
    endedAt: row.endedAt, tokensIn: n(row.tokensIn), tokensOut: n(row.tokensOut), tokensCached: 0,
  };
}

const ms = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t; };
const shortId = (id) => 'bee-' + (String(id).replace(/[^0-9a-f]/gi, '').slice(-4).toLowerCase().padStart(4, '0'));
const repoShort = (full) => sanitizeText(String(full || '').split('/').pop(), 40);
const round = (x, d = 6) => Number(Number(x).toFixed(d));

export function buildObservability({
  now = Date.now(), attempts = [], cap = null, github = null, resources = null,
  windowHours = 24, windowDays = 7, rates = {}, extraSources = [],
} = {}) {
  const since = now - windowHours * 3_600_000;
  const endedMs = (a) => ms(a.endedAt) ?? ms(a.updatedAt);

  const flight = attempts.filter(a => IN_FLIGHT.has(a.state));
  const queued = attempts.filter(a => QUEUED.has(a.state));
  const items = [...flight, ...queued].slice(0, 12).map(a => ({
    id: shortId(a.id),
    project: a.project ? sanitizeText(a.project, 24) : null,
    provider: providerOf(a.model),
    state: IN_FLIGHT.has(a.state) ? 'running' : 'queued',
    elapsedMin: Math.max(0, Math.round((now - (ms(a.createdAt) ?? now)) / 60_000)),
  }));

  const inWindow = attempts.filter(a => !IN_FLIGHT.has(a.state) && !QUEUED.has(a.state) && (endedMs(a) ?? 0) >= since);
  const providers = PROVIDERS.map(p => ({ provider: p, runs: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: null }));
  const other = { provider: 'Other', runs: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: null };
  for (const a of inWindow) {
    const row = providers.find(r => r.provider === providerOf(a.model)) || other;
    row.runs += 1; row.tokensIn += a.tokensIn; row.tokensOut += a.tokensOut; row.tokensCached += a.tokensCached;
  }
  if (other.runs) providers.push(other);
  for (const row of providers) {
    const rate = rates[row.provider];
    if (rate && row.runs) {
      row.costUsd = round((row.tokensIn * (rate.inUsdPerM || 0) + row.tokensOut * (rate.outUsdPerM || 0) + row.tokensCached * (rate.cachedUsdPerM || 0)) / 1e6);
    }
  }
  const total = providers.reduce((t, r) => ({
    runs: t.runs + r.runs, tokensIn: t.tokensIn + r.tokensIn, tokensOut: t.tokensOut + r.tokensOut,
    tokensCached: t.tokensCached + r.tokensCached,
  }), { runs: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0 });
  const priced = providers.filter(r => r.costUsd != null);
  total.costUsd = priced.length ? round(priced.reduce((s, r) => s + r.costUsd, 0)) : null;

  const failed = inWindow.filter(a => FAILED.has(a.state)).sort((a, b) => (endedMs(b) ?? 0) - (endedMs(a) ?? 0));
  const awaiting = inWindow.filter(a => a.state === 'succeeded');
  const repos = (github?.repos || []).map(r => ({
    repo: repoShort(r.repo), open: n(r.openPrs), merged: n(r.mergedPrs), commits: n(r.commits),
    _ci: (r.ciRed || []).map(c => ({ repo: repoShort(r.repo), check: sanitizeText(c.name, 40), ref: sanitizeText(c.ref || 'main', 30) })),
  }));
  const ciRed = repos.flatMap(r => r._ci).slice(0, 8);

  const problems = {
    windowHours,
    counts: { failedRuns: failed.length, ciRed: ciRed.length, awaitingReview: awaiting.length },
    failedRuns: failed.slice(0, 6).map(a => ({
      id: shortId(a.id), project: a.project ? sanitizeText(a.project, 24) : null, state: a.state,
      reason: sanitizeText(a.detail || a.state, 60), agoMin: Math.max(0, Math.round((now - (endedMs(a) ?? now)) / 60_000)),
    })),
    ciRed,
    awaitingReview: awaiting.slice(0, 6).map(a => ({
      id: shortId(a.id), project: a.project ? sanitizeText(a.project, 24) : null,
      agoMin: Math.max(0, Math.round((now - (endedMs(a) ?? now)) / 60_000)),
    })),
  };

  const board = github
    ? {
      available: true, windowDays,
      skipped: (github.skipped || []).map(s => sanitizeText(s, 40)),
      repos: repos.map(({ _ci, ...r }) => r),
      totals: repos.reduce((t, r) => ({ open: t.open + r.open, merged: t.merged + r.merged, commits: t.commits + r.commits }), { open: 0, merged: 0, commits: 0 }),
    }
    : { available: false, windowDays, repos: [], totals: { open: 0, merged: 0, commits: 0 } };

  const res = resources
    ? {
      available: true,
      cpuPct: resources.cpuPct == null ? null : Math.round(resources.cpuPct),
      memPct: resources.memPct == null ? null : Math.round(resources.memPct),
      diskPct: resources.diskPct == null ? null : Math.round(resources.diskPct),
      load1: resources.load1 == null ? null : round(resources.load1, 2),
      cores: resources.cores == null ? null : n(resources.cores),
    }
    : { available: false };

  return {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    windowHours,
    sources: ['orbit-attempts', ...(github ? ['github'] : []), ...(resources ? ['box-resources'] : []), ...extraSources],
    bees: { active: flight.length, queued: queued.length, cap: cap == null ? null : n(cap), items },
    tokens: { windowHours, providers, total },
    problems,
    board,
    resources: res,
  };
}
