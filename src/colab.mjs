// Google Colab runs: live progress gauges (tqdm bars, ComfyUI sampler/node progress, render frames)
// reported by Comfyrizz's Google Colab backend. The backend writes one JSONL file per run on the
// Orbit host (~/.comfyrizz/colab-progress); the connector folds those into snapshots and posts them
// to POST /api/v1/ingest/colab. Kept in memory: the connector resends the recent window every poll.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_RUNS = 30;
const MAX_GAUGES = 64;
const text = (value, max = 120) => (value == null ? null : String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max));
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function cleanGauge(gauge) {
  return {
    job: text(gauge?.job, 160) || 'run',
    stage: text(gauge?.stage, 40) || 'tqdm',
    label: text(gauge?.label) || '',
    n: num(gauge?.n),
    total: num(gauge?.total),
    rate: num(gauge?.rate),
    eta: num(gauge?.eta),
    ts: text(gauge?.ts, 40),
    state: text(gauge?.state, 20),
    current: text(gauge?.current),
  };
}

export function cleanRun(run) {
  const runId = text(run?.runId, 160);
  if (!runId) return null;
  return {
    runId,
    updatedAt: text(run.updatedAt, 40) || new Date().toISOString(),
    active: Boolean(run.active),
    updates: num(run.updates) ?? 0,
    gauges: (Array.isArray(run.gauges) ? run.gauges : []).slice(-MAX_GAUGES).map(cleanGauge),
  };
}

export function createColabStore({ now = Date.now, activeMs = 120_000 } = {}) {
  const runs = new Map();
  return {
    ingest(body) {
      const list = Array.isArray(body?.runs) ? body.runs : null;
      if (!list) throw Object.assign(new Error('runs must be an array'), { status: 400 });
      if (list.length > MAX_RUNS) throw Object.assign(new Error(`runs exceeds ${MAX_RUNS} items`), { status: 413 });
      let stored = 0;
      for (const raw of list) {
        const run = cleanRun(raw);
        if (!run) continue;
        runs.set(run.runId, { ...run, receivedAt: now() });
        stored += 1;
      }
      const keep = [...runs.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, MAX_RUNS);
      runs.clear();
      for (const run of keep) runs.set(run.runId, run);
      return { ok: true, runs: stored };
    },
    list() {
      return [...runs.values()]
        .map(run => ({ ...run, active: run.active && now() - Date.parse(run.updatedAt) <= activeMs }))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
  };
}

const STAGES = ['phase', 'job', 'tqdm', 'sampler', 'sampler-log', 'node', 'frames', 'render'];

/** Connector side: fold the per-run JSONL files into the latest value of every gauge. */
export function readColabDir(dir = defaultColabDir(), { now = Date.now(), maxAgeMs = 12 * 3600_000, activeMs = 120_000, limit = 20 } = {}) {
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    return { name, file, mtime: stat.mtimeMs, size: stat.size };
  }).filter(entry => now - entry.mtime <= maxAgeMs).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  return files.map(entry => {
    const gauges = new Map();
    let updates = 0;
    for (const line of fs.readFileSync(entry.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      updates += 1;
      const key = `${record.job}|${record.stage}|${record.label}`;
      const previous = gauges.get(key);
      const merged = { ...(previous || {}), ...record };
      if (record.n == null && previous?.n != null && !record.state) merged.n = previous.n;
      gauges.set(key, merged);
    }
    return {
      runId: entry.name.replace(/\.jsonl$/, ''),
      updatedAt: new Date(entry.mtime).toISOString(),
      active: now - entry.mtime <= activeMs,
      updates,
      signature: `${entry.mtime}:${entry.size}`,
      gauges: [...gauges.values()].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage)).map(cleanGauge),
    };
  });
}

export function defaultColabDir(env = process.env) {
  return env.ORBIT_CP_COLAB_PROGRESS_DIR || env.COMFYRIZZ_COLAB_PROGRESS_DIR || path.join(os.homedir(), '.comfyrizz', 'colab-progress');
}
