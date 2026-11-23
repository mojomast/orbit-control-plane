import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectGithub, collectResources, defaultRepos, enrichFromResultFiles } from '../src/obs-collect.mjs';
import { buildObservability } from '../src/observability.mjs';

const NOW = Date.parse('2026-11-23T20:00:00.000Z');
const days = (d) => new Date(NOW - d * 86_400_000).toISOString();

function fakeExec(table) {
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(' ');
    const hit = table[Object.keys(table).find(k => key.startsWith(k))];
    if (hit instanceof Error) throw hit;
    return hit ?? '[]';
  };
  exec.calls = calls;
  return exec;
}

test('defaultRepos lists the six rizzstack repos', () => {
  assert.deepEqual(defaultRepos().sort(), [
    'mojomast/bundlebees', 'mojomast/hyvv', 'mojomast/orbit-control-plane',
    'mojomast/orbitdesktop', 'mojomast/uirizz', 'mojomast/workflow',
  ]);
});

test('collectGithub counts PRs, commits and red CI on the default branch', async () => {
  const exec = fakeExec({
    'pr list': JSON.stringify([
      { state: 'OPEN', createdAt: days(1), mergedAt: null },
      { state: 'MERGED', createdAt: days(3), mergedAt: days(2) },
      { state: 'MERGED', createdAt: days(30), mergedAt: days(29) },
      { state: 'CLOSED', createdAt: days(2), mergedAt: null },
    ]),
    'api repos/mojomast/workflow/commits': 'a\nb\nc\n',
    'run list': JSON.stringify([
      { workflowName: 'ci', conclusion: 'failure', headBranch: 'main', createdAt: days(0.1) },
      { workflowName: 'ci', conclusion: 'success', headBranch: 'main', createdAt: days(1) },
      { workflowName: 'slop-lint', conclusion: 'success', headBranch: 'main', createdAt: days(0.2) },
      { workflowName: 'slop-lint', conclusion: 'failure', headBranch: 'main', createdAt: days(2) },
    ]),
  });
  const out = await collectGithub({ repos: ['mojomast/workflow'], days: 7, now: NOW, exec });
  assert.equal(out.repos.length, 1);
  assert.deepEqual({ ...out.repos[0], ciRed: undefined }, { repo: 'mojomast/workflow', openPrs: 1, mergedPrs: 1, commits: 3, ciRed: undefined });
  assert.deepEqual(out.repos[0].ciRed, [{ name: 'ci', ref: 'main' }]);
  assert.deepEqual(out.skipped, []);
});

test('collectGithub never uses a shell and skips a repo that errors', async () => {
  const exec = fakeExec({ 'pr list': new Error('boom: ghp_abcdefghijklmnop0123') });
  const out = await collectGithub({ repos: ['mojomast/hyvv'], days: 7, now: NOW, exec });
  assert.deepEqual(out.repos, []);
  assert.deepEqual(out.skipped, ['hyvv']);
  for (const call of exec.calls) assert.ok(Array.isArray(call));
});

test('collectGithub rejects repo names that are not owner/name', async () => {
  const exec = fakeExec({});
  await assert.rejects(() => collectGithub({ repos: ['x; rm -rf /'], days: 7, now: NOW, exec }), /invalid repo/);
});

test('collectResources reports percentages and no host identity', () => {
  const r = collectResources({
    loadavg: () => [2, 1, 1], cpus: () => new Array(8).fill({}), totalmem: () => 1000, freemem: () => 250,
    disk: () => ({ usedPct: 61.4 }),
  });
  assert.deepEqual(r, { cpuPct: 25, memPct: 75, diskPct: 61, load1: 2, cores: 8 });
  assert.ok(!('hostname' in r));
});

test('snapshot built from collectors carries skipped repos as unavailable board data', () => {
  const snap = buildObservability({ now: NOW, attempts: [], github: { repos: [], skipped: ['hyvv'] } });
  assert.deepEqual(snap.board.skipped, ['hyvv']);
});

test('enrichFromResultFiles fills usage and project from per-attempt result files only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'res-'));
  try {
    await writeFile(path.join(dir, 'att_00aa.result.json'), JSON.stringify({
      source: { project: 'hyvv' },
      observed: { usage: JSON.stringify({ inputTokens: 7, outputTokens: 3, cachedReadTokens: 90 }) },
    }));
    const raw = [
      { attempt_id: 'att_00aa', state: 'succeeded', model: 'go:x' },
      { attempt_id: '../../etc/passwd', state: 'succeeded', model: 'go:x' },
      { attempt_id: 'att_missing', state: 'succeeded', model: 'go:x' },
    ];
    const out = await enrichFromResultFiles(raw, dir);
    assert.equal(out[0].result.source.project, 'hyvv');
    assert.equal(JSON.parse(out[0].result.observed.usage).inputTokens, 7);
    assert.equal(out[1].result, undefined, 'path-like ids are never opened');
    assert.equal(out[2].result, undefined);
    assert.equal(raw[0].result, undefined, 'input is not mutated');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
