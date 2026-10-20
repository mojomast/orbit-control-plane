import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, bearer, ORBIT, WORKER_NODE } from './helpers.mjs';
import { classifyApproval } from '../src/approvals.mjs';

test('auto-approved worker events are not pending human decisions', async () => {
  const ctx = await boot();
  try {
    await fetch(`${ctx.base}/api/v1/ingest/attempts`, {
      method: 'POST', headers: bearer(ORBIT),
      body: JSON.stringify({ attempts: [{ attemptId: 'att_run', state: 'running', node: 'brrrrrrrr', taskId: 't' }] }),
    });
    const posted = await fetch(`${ctx.base}/api/v1/ingest/events`, {
      method: 'POST', headers: bearer(WORKER_NODE),
      body: JSON.stringify({ events: [
        { attemptId: 'att_run', seq: 1, kind: 'acp.permission', text: 'write file', data: { status: 'pending', source: 'cua', command: 'write file' } },
        { attemptId: 'att_run', seq: 2, kind: 'approval.pending', text: 'run npm test', data: { type: 'local-tool-permission', status: 'pending', summary: 'Run npm test', command: 'npm test' } },
      ] }),
    });
    assert.equal(posted.status, 200);
    const detail = await fetch(`${ctx.base}/api/v1/attempts/att_run`, { headers: bearer('viewer-token-test-value-0004') });
    const { attempt } = await detail.json();
    const auto = attempt.events.find(event => event.seq === 1);
    const human = attempt.events.find(event => event.seq === 2);
    assert.equal(auto.needsHuman, false);
    assert.equal(auto.disposition, 'auto_approved');
    assert.equal(auto.data.status, 'auto-approved');
    assert.equal(human.needsHuman, true);
    assert.equal(human.disposition, 'needs_human');
    const feed = await fetch(`${ctx.base}/api/v1/events`, { headers: bearer('viewer-token-test-value-0004') });
    const events = (await feed.json()).events;
    assert.equal(events.some(event => event.disposition === 'auto_approved' && event.needsHuman), false);
  } finally { await ctx.stop(); }
});

test('classifier treats cua ACP permissions as auto even when status says pending', () => {
  const result = classifyApproval({ kind: 'acp.permission', data: { status: 'pending', decidedBy: 'sandbox' } });
  assert.equal(result.needsHuman, false);
  assert.equal(result.disposition, 'auto_approved');
  const human = classifyApproval({ kind: 'approval.pending', data: { type: 'auto-review-approval', status: 'pending' } });
  assert.equal(human.needsHuman, true);
});
