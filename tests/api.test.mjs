import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, bearer, ORBIT, VIEWER } from './helpers.mjs';

const ATTEMPT_STATES = ['queued', 'launcher_queued', 'running', 'disconnected', 'cancel_requested', 'outcome_unknown', 'not_started', 'succeeded', 'failed', 'cancelled', 'superseded'];

test('demo mode fills every panel', async () => {
  const ctx = await boot({ demo: true, tokens: new Map() });
  try {
    const health = await fetch(`${ctx.base}/healthz`);
    assert.equal((await health.json()).demo, true);
    const board = await fetch(`${ctx.base}/api/v1/board`);
    const tasks = (await board.json()).tasks;
    for (const column of ['todo', 'doing', 'review', 'blocked', 'done']) {
      assert.ok(tasks.some(task => task.column === column), column);
    }
    assert.ok(tasks.some(task => task.groupName === 'Comfyrizz build'));
    const attempts = (await (await fetch(`${ctx.base}/api/v1/attempts`)).json()).attempts;
    for (const state of ATTEMPT_STATES) assert.ok(attempts.some(attempt => attempt.state === state), state);
    const running = attempts.find(attempt => attempt.attemptId === 'att_ok');
    const detail = await (await fetch(`${ctx.base}/api/v1/attempts/${running.attemptId}`)).json();
    assert.ok(detail.attempt.files.some(file => /^[a-f0-9]{64}$/.test(file.sha256)));
    const stats = await (await fetch(`${ctx.base}/api/v1/stats`)).json();
    assert.ok(stats.samples.length > 10);
    assert.ok(stats.models.some(model => model.model === 'deepseek-v4.1-flash'));
    assert.ok(stats.throughput.length > 0);
    const grok = await (await fetch(`${ctx.base}/api/v1/grok`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'groups', op: 'state', group: 'g-comfy' }) })).json();
    const cards = grok.data.cards;
    assert.ok(cards.some(card => card.needsHuman === true));
    assert.ok(cards.some(card => card.disposition === 'auto_approved' && card.needsHuman === false));
    const overview = await (await fetch(`${ctx.base}/api/v1/overview`)).json();
    assert.ok(overview.inFlight.length > 0);
    assert.ok(overview.launchers.some(node => node.node === 'brrrrrrrr'));
    const page = await fetch(`${ctx.base}/`);
    assert.match(await page.text(), /Orbit Control Plane/);
  } finally { await ctx.stop(); }
});

test('board ingest round trip and move intent', async () => {
  const ctx = await boot();
  try {
    const ingest = await fetch(`${ctx.base}/api/v1/ingest/board`, {
      method: 'POST', headers: bearer(ORBIT),
      body: JSON.stringify({ groups: [{ id: 'g1', name: 'Comfyrizz build', tasks: [{ id: 't1', title: 'Pin the image', status: 'working', owner: 'hermes', summary: 'running' }] }] }),
    });
    assert.equal(ingest.status, 200);
    const board = await (await fetch(`${ctx.base}/api/v1/board`, { headers: bearer(VIEWER) })).json();
    assert.equal(board.tasks[0].column, 'doing');
    const moved = await fetch(`${ctx.base}/api/v1/control/tasks/t1/move`, {
      method: 'POST', headers: bearer(VIEWER), body: JSON.stringify({ column: 'review', note: 'ready' }),
    });
    assert.equal(moved.status, 202);
    const after = await (await fetch(`${ctx.base}/api/v1/board/tasks/t1`, { headers: bearer(VIEWER) })).json();
    assert.equal(after.task.column, 'review');
    assert.ok(after.task.history.length >= 2);
  } finally { await ctx.stop(); }
});

test('sse receives an update after ingest', async () => {
  const ctx = await boot();
  let req;
  let timer;
  try {
    const hit = new Promise((resolve, reject) => {
      req = http.get(`${ctx.base}/api/v1/stream`, { headers: bearer(VIEWER) }, res => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', chunk => {
          buf += chunk;
          if (buf.includes('heartbeat')) {
            clearTimeout(timer);
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
      timer = setTimeout(() => { req.destroy(); reject(new Error('sse timed out')); }, 3000);
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    await fetch(`${ctx.base}/api/v1/ingest/heartbeat`, {
      method: 'POST', headers: bearer(ORBIT), body: JSON.stringify({ kind: 'orbit', detail: 'up' }),
    });
    const payload = await hit;
    assert.match(payload, /event: update/);
  } finally { clearTimeout(timer); req?.destroy(); await ctx.stop(); }
});
