// Approved acceptance tests: advisory rework bucket in buildStats (Orbit display of rework metrics). Coordinator-written; do not edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStats } from '../src/stats.mjs';

function store(attempts = [], tasks = []) {
  return { listAttempts: () => attempts, listTasks: () => tasks, listSamples: () => [], listLaunchers: () => [] };
}
const A = (id, extra = {}) => ({ id, model: 'm', state: 'succeeded', ...extra });

test('AC-001 buildStats exposes a rework bucket with zero counts and a null rate for an empty store', () => {
  const r = buildStats(store()).rework;
  assert.deepEqual(r, { attempts: 0, retries: 0, maxChain: 0, rate: null });
});

test('AC-002 attempts without retryOf are not retries', () => {
  const r = buildStats(store([A('a'), A('b'), A('c')])).rework;
  assert.equal(r.attempts, 3);
  assert.equal(r.retries, 0);
  assert.equal(r.maxChain, 1);
  assert.equal(r.rate, 0);
});

test('AC-003 retries are counted and the rate is retries over attempts', () => {
  const r = buildStats(store([A('a', { state: 'failed' }), A('b', { retryOf: 'a' }), A('c')])).rework;
  assert.equal(r.attempts, 3);
  assert.equal(r.retries, 1);
  assert.equal(r.rate, 1 / 3);
});

test('AC-004 maxChain is the longest retryOf chain including the first attempt', () => {
  const r = buildStats(store([A('a'), A('b', { retryOf: 'a' }), A('c', { retryOf: 'b' }), A('x'), A('y', { retryOf: 'x' })])).rework;
  assert.equal(r.maxChain, 3);
  assert.equal(r.retries, 3);
});

test('AC-005 cycles, dangling parents and non-string retryOf never throw or loop', () => {
  const cyc = [A('a', { retryOf: 'b' }), A('b', { retryOf: 'a' })];
  const r = buildStats(store(cyc)).rework;
  assert.equal(r.attempts, 2);
  assert.ok(Number.isInteger(r.maxChain) && r.maxChain >= 1 && r.maxChain <= 2);
  const odd = buildStats(store([A('a', { retryOf: 'zzz' }), A('b', { retryOf: 5 }), A('c', { retryOf: { x: 1 } }), A('d', { retryOf: null })])).rework;
  assert.equal(odd.attempts, 4);
  assert.equal(odd.retries, 1);
});

test('AC-006 the bucket is plain numbers only: no attempt text is copied into it', () => {
  const r = buildStats(store([A('a', { retryOf: 'b', detail: 'secret-token-123' }), A('b', { detail: 'secret-token-456' })])).rework;
  assert.ok(!JSON.stringify(r).includes('secret'));
  for (const v of Object.values(r)) assert.ok(v === null || typeof v === 'number');
});

test('AC-007 existing stats fields are unchanged', () => {
  const s = buildStats(store([A('a'), A('b', { state: 'failed' })]));
  assert.equal(s.terminal, 2);
  assert.equal(s.successRate, 0.5);
  assert.ok(Array.isArray(s.models) && Array.isArray(s.throughput));
});
