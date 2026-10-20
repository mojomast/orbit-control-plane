import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { boot, bearer, ORBIT, VIEWER } from './helpers.mjs';
import { createConnector } from '../connector/orbit-connector.mjs';

const BOARD_KEY = 'board-key-test-value-aaaa';
const GROK_KEY = 'grok-key-test-value-bbbbbb';

test('connector pushes a fake Orbit and applies intents', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'orbit-rt-'));
  fs.mkdirSync(path.join(runtime, 'local-workers'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'collab-board.key'), BOARD_KEY + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(runtime, 'grokbots-app.key'), GROK_KEY + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(runtime, 'local-workers', 'ledger.json'), JSON.stringify({
    version: 1,
    attempts: { att1: { brief: { objective: 'retry the archive export', project: 'comfyrizz' } } },
  }));
  const seen = { cancel: 0, review: 0, created: 0, history: 0, keys: [] };
  const orbit = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    seen.keys.push(token);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/grokbots-app') {
      if (token !== GROK_KEY) return send(401, { error: 'unauthorized' });
      if (body.action === 'groups' && body.op === 'list') return send(200, { groups: [{ id: 'g-comfy', name: 'Comfyrizz build', members: [] }] });
      if (body.action === 'agents') return send(200, { groups: [{ profile: 'grok-main', provider: 'grok', label: 'Grok Bot', agents: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Orbit collab' }] }] });
      if (body.action === 'history') { seen.history += 1; return send(200, { messages: [{ id: 'm1', role: 'assistant', content: 'pong from fake orbit' }], tools: [], cards: [] }); }
      return send(200, { ok: true });
    }
    if (req.url === '/api/collab-board') {
      if (token !== BOARD_KEY) return send(401, { error: 'unauthorized' });
      if (body.op === 'list') return send(200, { group: body.group, board: 'p1', entries: [{ id: 't1', title: 'Ship the archive', status: 'working', owner: 'hermes', summary: 'in the sandbox', checkins: [{ by: 'hermes', note: 'started', at: '2026-10-20T12:00:00.000Z' }] }] });
      if (body.op === 'new') { seen.created += 1; return send(200, { entry: { id: 't_new', title: body.title, status: 'submitted' } }); }
      return send(200, { ok: true, op: body.op });
    }
    if (req.url === '/api/local-workers') {
      if (token !== BOARD_KEY) return send(401, { error: 'unauthorized' });
      if (body.op === 'list') return send(200, { attempts: [{ attempt_id: 'att1', task_id: 't1', board_entry: 't1', group: 'g-comfy', state: 'running', node: 'brrrrrrrr', env_id: 'orbit-box', cua_run_id: 'run-1', model: 'deepseek-v4.1-flash', generation: 2, detail: 'live', history: [] }] });
      if (body.op === 'cancel') { seen.cancel += 1; return send(202, { state: 'cancel_requested' }); }
      if (body.op === 'review') { seen.review += 1; return send(200, { state: body.accepted ? 'accepted' : 'rejected' }); }
      if (body.op === 'create') return send(201, { attempt_id: 'att_retry', state: 'queued' });
      return send(400, { error: 'bad op' });
    }
    send(404, { error: 'nope' });
  });
  await new Promise(resolve => orbit.listen(0, '127.0.0.1', resolve));
  const orbitPort = orbit.address().port;
  const ctx = await boot();
  const logs = [];
  const connector = createConnector({
    token: ORBIT,
    controlPlaneUrl: ctx.base,
    orbitUrl: `http://127.0.0.1:${orbitPort}`,
    runtimeDir: runtime,
    boardKey: BOARD_KEY,
    grokKey: GROK_KEY,
    log: (...parts) => logs.push(parts.join(' ')),
    pollMs: 60_000,
  });
  try {
    const socket = connector.connect();
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });
    await connector.tick();
    const board = await (await fetch(`${ctx.base}/api/v1/board`, { headers: bearer(VIEWER) })).json();
    const task = board.tasks.find(item => item.id === 't1' || item.orbitId === 't1');
    assert.ok(task, 'board task arrived');
    assert.equal(task.column, 'doing');
    assert.equal(task.groupName, 'Comfyrizz build');
    const attempts = await (await fetch(`${ctx.base}/api/v1/attempts`, { headers: bearer(VIEWER) })).json();
    assert.equal(attempts.attempts[0].state, 'running');
    assert.equal(attempts.attempts[0].sandbox, 'orbit-box');
    assert.equal(attempts.attempts[0].runId, 'run-1');

    const cancel = await fetch(`${ctx.base}/api/v1/control/attempts/att1/cancel`, { method: 'POST', headers: bearer(VIEWER), body: '{}' });
    assert.equal(cancel.status, 202);
    const pause = await fetch(`${ctx.base}/api/v1/control/dispatch`, { method: 'POST', headers: bearer(VIEWER), body: JSON.stringify({ paused: true }) });
    assert.equal(pause.status, 202);
    await connector.tick();
    assert.equal(seen.cancel, 1);
    const dispatch = JSON.parse(fs.readFileSync(path.join(runtime, 'control-plane', 'dispatch.json'), 'utf8'));
    assert.equal(dispatch.paused, true);
    const intents = await (await fetch(`${ctx.base}/api/v1/intents`, { headers: bearer(VIEWER) })).json();
    assert.ok(intents.intents.some(item => item.type === 'attempt.cancel' && item.status === 'applied'));
    assert.ok(intents.intents.some(item => item.type === 'dispatch.pause' && item.status === 'deferred'));

    const grok = await fetch(`${ctx.base}/api/v1/grok`, {
      method: 'POST', headers: bearer(VIEWER),
      body: JSON.stringify({ action: 'history', profile: 'grok-main', agent: '11111111-1111-4111-8111-111111111111' }),
    });
    const proxied = await grok.json();
    assert.equal(proxied.connector, true);
    assert.equal(proxied.data.messages[0].content, 'pong from fake orbit');
    assert.equal(seen.history, 1);
    const blob = logs.join('\n');
    assert.equal(blob.includes(ORBIT), false);
    assert.equal(blob.includes(BOARD_KEY), false);
    assert.equal(blob.includes(GROK_KEY), false);
    assert.ok(seen.keys.includes(BOARD_KEY));
  } finally {
    connector.stop();
    await ctx.stop();
    await new Promise(resolve => orbit.close(resolve));
    await rm(runtime, { recursive: true, force: true });
  }
});
