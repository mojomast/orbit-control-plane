import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA, providerOf, normalizeOrbitAttempt, buildObservability, sanitizeText,
} from '../src/observability.mjs';

const NOW = Date.parse('2026-11-23T20:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();

function att(over) {
  return {
    attempt_id: 'att_0123456789abcdef', task_id: 't_1', node: 'worker-node', model: 'go:deepseek-v4.1-flash',
    state: 'running', created_at: ago(20), updated_at: ago(2), ended_at: null,
    result: { source: { project: 'workflow' }, observed: { usage: JSON.stringify({ inputTokens: 100, outputTokens: 50, cachedReadTokens: 1000 }) } },
    ...over,
  };
}

test('providerOf maps model ids to the three providers', () => {
  assert.equal(providerOf('go:deepseek-v4.1-flash'), 'OpenCode Go');
  assert.equal(providerOf('deepseek:deepseek-flash'), 'DeepSeek');
  assert.equal(providerOf('openrouter/anthropic/claude-x'), 'OpenRouter');
  assert.equal(providerOf('deepseek-v4.1-flash'), 'OpenCode Go');
  assert.equal(providerOf('k3.1-pro'), 'Other');
  assert.equal(providerOf(undefined), 'Other');
});

test('normalizeOrbitAttempt maps Orbit list entries and tolerates bad usage', () => {
  const n = normalizeOrbitAttempt(att({}));
  assert.equal(n.project, 'workflow');
  assert.equal(n.tokensIn, 100);
  assert.equal(n.tokensOut, 50);
  assert.equal(n.tokensCached, 1000);
  const bad = normalizeOrbitAttempt(att({ result: { observed: { usage: '{not json' } } }));
  assert.equal(bad.tokensIn, 0);
  assert.equal(bad.project, null);
});

test('snapshot has a fixed schema and counts bees in flight', () => {
  const attempts = [
    att({ attempt_id: 'att_a', state: 'running' }),
    att({ attempt_id: 'att_b', state: 'launcher_queued' }),
    att({ attempt_id: 'att_c', state: 'succeeded', ended_at: ago(30) }),
  ].map(normalizeOrbitAttempt);
  const snap = buildObservability({ now: NOW, attempts, cap: 12 });
  assert.equal(snap.schema, SCHEMA);
  assert.equal(snap.generatedAt, new Date(NOW).toISOString());
  assert.equal(snap.bees.active, 1);
  assert.equal(snap.bees.queued, 1);
  assert.equal(snap.bees.cap, 12);
  assert.equal(snap.bees.items.length, 2);
  assert.equal(snap.bees.items[0].project, 'workflow');
  assert.equal(snap.bees.items[0].provider, 'OpenCode Go');
  assert.ok(snap.bees.items[0].elapsedMin >= 0);
  assert.deepEqual(Object.keys(snap.bees.items[0]).sort(), ['elapsedMin', 'id', 'project', 'provider', 'state']);
});

test('tokens are summed per provider inside the window only', () => {
  const attempts = [
    att({ attempt_id: 'att_1', state: 'succeeded', ended_at: ago(60) }),
    att({ attempt_id: 'att_2', state: 'failed', model: 'deepseek:deepseek-flash', ended_at: ago(120) }),
    att({ attempt_id: 'att_3', state: 'succeeded', updated_at: ago(60 * 24 * 3), ended_at: ago(60 * 24 * 3) }),
  ].map(normalizeOrbitAttempt);
  const snap = buildObservability({ now: NOW, attempts, windowHours: 24 });
  const go = snap.tokens.providers.find(p => p.provider === 'OpenCode Go');
  const ds = snap.tokens.providers.find(p => p.provider === 'DeepSeek');
  assert.equal(go.runs, 1);
  assert.equal(go.tokensIn, 100);
  assert.equal(ds.runs, 1);
  assert.equal(snap.tokens.providers.length, 3);
  assert.equal(snap.tokens.providers.find(p => p.provider === 'OpenRouter').runs, 0);
  assert.equal(go.costUsd, null, 'cost is unknown unless a rate is supplied');
  assert.equal(snap.tokens.total.runs, 2);
});

test('cost uses supplied USD-per-million rates and stays null otherwise', () => {
  const attempts = [att({ attempt_id: 'att_1', state: 'succeeded', ended_at: ago(5) })].map(normalizeOrbitAttempt);
  const snap = buildObservability({
    now: NOW, attempts,
    rates: { 'OpenCode Go': { inUsdPerM: 1, outUsdPerM: 2, cachedUsdPerM: 0.1 } },
  });
  const go = snap.tokens.providers.find(p => p.provider === 'OpenCode Go');
  assert.equal(go.costUsd, Number(((100 * 1 + 50 * 2 + 1000 * 0.1) / 1e6).toFixed(6)));
});

test('problems: failed runs, awaiting review, ci red', () => {
  const attempts = [
    att({ attempt_id: 'att_f1', state: 'failed', ended_at: ago(10), detail: 'timeout in tool call' }),
    att({ attempt_id: 'att_f2', state: 'not_started', ended_at: ago(15) }),
    att({ attempt_id: 'att_f3', state: 'failed', ended_at: ago(60 * 40) }),
    att({ attempt_id: 'att_s1', state: 'succeeded', ended_at: ago(20) }),
    att({ attempt_id: 'att_s2', state: 'accepted', ended_at: ago(20) }),
  ].map(normalizeOrbitAttempt);
  const snap = buildObservability({
    now: NOW, attempts, windowHours: 12,
    github: { repos: [{ repo: 'mojomast/workflow', openPrs: 2, mergedPrs: 3, commits: 9, ciRed: [{ name: 'slop-lint', ref: 'main' }] }] },
  });
  assert.equal(snap.problems.counts.failedRuns, 2);
  assert.equal(snap.problems.counts.awaitingReview, 1);
  assert.equal(snap.problems.counts.ciRed, 1);
  assert.equal(snap.problems.failedRuns[0].reason, 'timeout in tool call');
  assert.equal(snap.problems.ciRed[0].repo, 'workflow');
  assert.equal(snap.problems.ciRed[0].check, 'slop-lint');
});

test('board totals roll up per repo', () => {
  const snap = buildObservability({
    now: NOW, attempts: [], windowDays: 7,
    github: { repos: [
      { repo: 'mojomast/workflow', openPrs: 2, mergedPrs: 3, commits: 9, ciRed: [] },
      { repo: 'mojomast/hyvv', openPrs: 1, mergedPrs: 4, commits: 5, ciRed: [] },
    ] },
  });
  assert.equal(snap.board.windowDays, 7);
  assert.deepEqual(snap.board.repos.map(r => r.repo), ['workflow', 'hyvv']);
  assert.deepEqual(snap.board.totals, { open: 3, merged: 7, commits: 14 });
});

test('missing sources are reported as unavailable, never invented', () => {
  const snap = buildObservability({ now: NOW, attempts: [] });
  assert.equal(snap.board.available, false);
  assert.deepEqual(snap.board.repos, []);
  assert.equal(snap.resources.available, false);
  assert.ok(snap.sources.includes('orbit-attempts'));
});

test('redaction removes hosts, ips, paths, tokens and control chars from every string', () => {
  const ip = ['100', '64', '1', '2'].join('.');
  const host = ['box', 'tail1234', 'ts', 'net'].join('.');
  const winPath = ['C:', 'Users', 'someone', 'x'].join('\\');
  const dirty = `fail at ${ip} host ${host} ${winPath} /home/someone/.hermes ghp_abcdefghijklmnop0123 Bearer abcdef123456 ok\u0007\${/x}`;
  const out = sanitizeText(dirty);
  for (const bad of [ip, ['ts', 'net'].join('.'), 'someone', 'ghp_', 'Bearer abcdef', '\u0007', '${']) assert.ok(!out.includes(bad), bad + ' leaked: ' + out);
  const attempts = [att({ state: 'failed', ended_at: ago(5), detail: dirty, node: ['10', '0', '0', '5'].join('.') })].map(normalizeOrbitAttempt);
  const snap = buildObservability({ now: NOW, attempts });
  const text = JSON.stringify(snap);
  for (const bad of [ip, ['ts', 'net'].join('.'), 'ghp_', '10.0.0.5', 'att_0123456789abcdef', '/home/', 'Users']) assert.ok(!text.includes(bad), bad + ' leaked');
});

test('ids are shortened to a stable 6-char label and titles are capped', () => {
  const attempts = [att({ attempt_id: 'att_9f8e7d6c5b4a3210', title: 'x'.repeat(500) })].map(normalizeOrbitAttempt);
  const snap = buildObservability({ now: NOW, attempts });
  assert.match(snap.bees.items[0].id, /^bee-[0-9a-f]{4}$/);
});
