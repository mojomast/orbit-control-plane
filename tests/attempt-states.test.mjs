// RED: the control plane serves rizzstack.attempt/1 states with the client
// lifecycle preserved and an unknown state reported explicitly.
//
// This file is the approved specification; the implementer must not edit it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, bearer, ORBIT, OPERATOR, VIEWER } from './helpers.mjs';

const CONTRACT_STATES = new Set(['queued', 'provisioning', 'running', 'backoff', 'succeeded', 'failed', 'cancelled', 'unknown']);

async function ingest(ctx, attempts) {
  const response = await fetch(`${ctx.base}/api/v1/ingest/attempts`, {
    method: 'POST', headers: bearer(ORBIT), body: JSON.stringify({ attempts }),
  });
  assert.equal(response.status, 200);
}

test('known states map through the table and an unknown state is reported as unknown', async () => {
  const ctx = await boot();
  try {
    await ingest(ctx, [
      { attemptId: 'att_known', state: 'running', taskId: 't1', node: 'node-a' },
      { attemptId: 'att_done', state: 'succeeded', taskId: 't1', node: 'node-a' },
      { attemptId: 'att_odd', state: 'mystery', taskId: 't2', node: 'node-a' },
    ]);
    const list = await (await fetch(`${ctx.base}/api/v1/attempts`, { headers: bearer(VIEWER) })).json();
    const byId = Object.fromEntries(list.attempts.map((attempt) => [attempt.attemptId, attempt]));

    assert.equal(byId.att_known.state, 'running');
    assert.equal(byId.att_done.state, 'succeeded');
    assert.equal(byId.att_odd.state, 'unknown');
    assert.equal(byId.att_odd.remote_state, 'mystery');
    assert.equal(byId.att_odd.client_state, 'mystery');
    for (const attempt of Object.values(byId)) {
      assert.ok(CONTRACT_STATES.has(attempt.state), `state ${attempt.state} is in rizzstack.attempt/1`);
      assert.ok(attempt.client_state, 'the client lifecycle state is preserved');
    }

    const detail = await (await fetch(`${ctx.base}/api/v1/attempts/att_odd`, { headers: bearer(VIEWER) })).json();
    assert.equal(detail.attempt.state, 'unknown');
    assert.equal(detail.attempt.remote_state, 'mystery');
    assert.equal(detail.attempt.client_state, 'mystery');
    assert.equal(detail.attempt.inFlight, true, 'the client lifecycle decides in-flight');
  } finally {
    await ctx.stop();
  }
});

test('the review and retry guards keep their meaning', async () => {
  const ctx = await boot();
  try {
    await ingest(ctx, [
      { attemptId: 'att_succeeded', state: 'succeeded', taskId: 't1', node: 'node-a' },
      { attemptId: 'att_inflight', state: 'running', taskId: 't2', node: 'node-a' },
    ]);
    const reviewOk = await fetch(`${ctx.base}/api/v1/control/attempts/att_succeeded/review`, {
      method: 'POST', headers: bearer(OPERATOR), body: JSON.stringify({ accepted: true, note: 'ok' }),
    });
    assert.equal(reviewOk.status, 202);

    const reviewInflight = await fetch(`${ctx.base}/api/v1/control/attempts/att_inflight/review`, {
      method: 'POST', headers: bearer(OPERATOR), body: JSON.stringify({ accepted: true }),
    });
    assert.equal(reviewInflight.status, 409);

    const retryInflight = await fetch(`${ctx.base}/api/v1/control/attempts/att_inflight/retry`, {
      method: 'POST', headers: bearer(OPERATOR), body: JSON.stringify({}),
    });
    assert.equal(retryInflight.status, 409);

    const retryFinished = await fetch(`${ctx.base}/api/v1/control/attempts/att_succeeded/retry`, {
      method: 'POST', headers: bearer(OPERATOR), body: JSON.stringify({}),
    });
    assert.equal(retryFinished.status, 202);
  } finally {
    await ctx.stop();
  }
});
