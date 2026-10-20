import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, bearer, ORBIT, VIEWER } from './helpers.mjs';

test('intents lease once, expire, and close idempotently', async () => {
  const ctx = await boot({ leaseMs: 80 });
  try {
    const queued = await fetch(`${ctx.base}/api/v1/control/tasks`, {
      method: 'POST', headers: bearer(VIEWER),
      body: JSON.stringify({ title: 'Write the firewall note', spec: 'Tailscale only', project: 'comfyrizz', group: 'Comfyrizz build', priority: 2, fileScope: ['docs/LOCAL_WORKERS.md'], dependencies: [] }),
    });
    assert.equal(queued.status, 202);
    const created = await queued.json();
    assert.equal(created.intent.status, 'queued');
    assert.equal(created.task.column, 'todo');
    assert.equal(created.task.syncState, 'pending');

    const viewerList = await fetch(`${ctx.base}/api/v1/intents`, { headers: bearer(VIEWER) });
    const listed = await viewerList.json();
    assert.equal(listed.intents.find(item => item.id === created.intent.id).status, 'queued');

    const first = await fetch(`${ctx.base}/api/v1/ingest/intents?limit=10`, { headers: bearer(ORBIT) });
    const leased = await first.json();
    assert.equal(leased.intents.length, 1);
    assert.equal(leased.intents[0].status, 'leased');

    const second = await fetch(`${ctx.base}/api/v1/ingest/intents`, { headers: bearer(ORBIT) });
    assert.deepEqual((await second.json()).intents, []);

    await new Promise(resolve => setTimeout(resolve, 120));
    const third = await fetch(`${ctx.base}/api/v1/ingest/intents`, { headers: bearer(ORBIT) });
    const again = await third.json();
    assert.equal(again.intents.length, 1);

    const closed = await fetch(`${ctx.base}/api/v1/ingest/intents/${again.intents[0].id}/result`, {
      method: 'POST', headers: bearer(ORBIT),
      body: JSON.stringify({ outcome: 'applied', detail: 'board entry created', result: { entry: { id: 't_orbit_1' } } }),
    });
    assert.equal(closed.status, 200);
    const done = await closed.json();
    assert.equal(done.status, 'applied');
    const repeat = await fetch(`${ctx.base}/api/v1/ingest/intents/${done.id}/result`, {
      method: 'POST', headers: bearer(ORBIT),
      body: JSON.stringify({ outcome: 'rejected', detail: 'should not stick' }),
    });
    assert.equal((await repeat.json()).status, 'applied');

    const task = await fetch(`${ctx.base}/api/v1/board/tasks/${created.task.id}`, { headers: bearer(VIEWER) });
    const body = await task.json();
    assert.equal(body.task.orbitId, 't_orbit_1');
    assert.equal(body.task.syncState, 'synced');
    const audit = await fetch(`${ctx.base}/api/v1/audit`, { headers: bearer(VIEWER) });
    const rows = await audit.json();
    assert.ok(rows.audit.some(row => row.action === 'task.create.applied'));
  } finally { await ctx.stop(); }
});

test('a worker token cannot pull intents', async () => {
  const ctx = await boot();
  try {
    const response = await fetch(`${ctx.base}/api/v1/ingest/intents`, { headers: bearer('worker-token-test-value-0002') });
    assert.equal(response.status, 403);
  } finally { await ctx.stop(); }
});
