// Collectors for the observability snapshot. They talk to `gh` (read-only calls)
// and to node:os. They never use a shell: every call is an argv array.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statfsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function defaultRepos() {
  return ['workflow', 'bundlebees', 'hyvv', 'orbitdesktop', 'orbit-control-plane', 'uirizz'].map(r => `mojomast/${r}`);
}

export function ghExec(timeoutMs = 20_000) {
  return async (args) => {
    const { stdout } = await run('gh', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: process.env.GH_TOKEN, GH_HOST: 'github.com', NO_COLOR: '1' } });
    return stdout;
  };
}

export async function collectGithub({ repos = defaultRepos(), days = 7, now = Date.now(), exec = ghExec() } = {}) {
  for (const repo of repos) if (!REPO.test(repo)) throw new Error(`invalid repo name: ${String(repo).slice(0, 40)}`);
  const since = new Date(now - days * 86_400_000).toISOString();
  const out = [];
  const skipped = [];
  for (const repo of repos) {
    try {
      const prs = JSON.parse(await exec(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '200', '--json', 'state,createdAt,mergedAt']));
      const openPrs = prs.filter(p => p.state === 'OPEN').length;
      const mergedPrs = prs.filter(p => p.mergedAt && Date.parse(p.mergedAt) >= Date.parse(since)).length;
      const shas = (await exec(['api', `repos/${repo}/commits?since=${since}&per_page=100`, '--paginate', '--jq', '.[].sha'])).split('\n').filter(Boolean);
      const runs = JSON.parse(await exec(['run', 'list', '--repo', repo, '--branch', 'main', '--limit', '30', '--json', 'workflowName,conclusion,headBranch,createdAt']));
      const latest = new Map();
      for (const r of runs) {
        if (!r.conclusion) continue; // still running
        const prev = latest.get(r.workflowName);
        if (!prev || Date.parse(r.createdAt) > Date.parse(prev.createdAt)) latest.set(r.workflowName, r);
      }
      const ciRed = [...latest.values()].filter(r => r.conclusion === 'failure').map(r => ({ name: r.workflowName, ref: r.headBranch || 'main' }));
      out.push({ repo, openPrs, mergedPrs, commits: shas.length, ciRed });
    } catch {
      skipped.push(repo.split('/').pop());
    }
  }
  return { repos: out, skipped };
}

export function collectResources(sys = {}) {
  const {
    loadavg, cpus, totalmem, freemem, disk,
  } = sys;
  const cores = cpus().length || 1;
  const load1 = loadavg()[0];
  const total = totalmem();
  const d = disk();
  return {
    cpuPct: Math.min(100, Math.round((load1 / cores) * 100)),
    memPct: total ? Math.round(((total - freemem()) / total) * 100) : null,
    diskPct: d ? Math.round(d.usedPct) : null,
    load1,
    cores,
  };
}

export function diskUsage(path = '/') {
  try {
    const s = statfsSync(path);
    return { usedPct: s.blocks ? ((s.blocks - s.bavail) / s.blocks) * 100 : 0 };
  } catch { return null; }
}

// Orbit's list op omits usage and project; the per-attempt result file has them.
// Only ids shaped like att_<hex/word> are opened, from one directory.
const ATTEMPT_ID = /^att_[A-Za-z0-9]{1,40}$/;
export async function enrichFromResultFiles(attempts, dir, { sinceMs = 0, now = Date.now() } = {}) {
  const out = [];
  for (const a of attempts) {
    const t = Date.parse(a.ended_at || a.updated_at || '');
    if (!ATTEMPT_ID.test(String(a.attempt_id || '')) || (sinceMs && Number.isFinite(t) && t < now - sinceMs)) { out.push(a); continue; }
    try {
      const body = JSON.parse(await readFile(path.join(dir, `${a.attempt_id}.result.json`), 'utf8'));
      out.push({ ...a, result: { source: { project: body?.source?.project }, observed: { usage: body?.observed?.usage } } });
    } catch { out.push(a); }
  }
  return out;
}
