import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, bearer, ORBIT, WORKER, WORKER_NODE, VIEWER } from './helpers.mjs';
import { tailscaleIdentity } from '../src/auth.mjs';
import { redact } from '../src/redact.mjs';

test('bearer auth rejects missing and unknown tokens and never echoes them', async () => {
  const ctx = await boot();
  try {
    const secret = 'super-secret-token-value';
    const open = await fetch(`${ctx.base}/api/v1/overview`);
    assert.equal(open.status, 401);
    const bad = await fetch(`${ctx.base}/api/v1/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: secret }),
    });
    const body = await bad.text();
    assert.equal(bad.status, 401);
    assert.equal(body.includes(secret), false);
    assert.equal(body.includes(VIEWER), false);
    const ok = await fetch(`${ctx.base}/api/v1/me`, { headers: bearer(VIEWER) });
    assert.equal(ok.status, 200);
    const me = await ok.json();
    assert.equal(me.actor, 'viewer');
    assert.equal(JSON.stringify(me).includes(VIEWER), false);
  } finally { await ctx.stop(); }
});

test('workers cannot ingest another node or an unassigned attempt', async () => {
  const ctx = await boot();
  try {
    const created = await fetch(`${ctx.base}/api/v1/ingest/attempts`, {
      method: 'POST', headers: bearer(ORBIT),
      body: JSON.stringify({ attempts: [{ attemptId: 'att_box', state: 'running', node: 'studio-mini', taskId: 't1' }] }),
    });
    assert.equal(created.status, 200);
    const foreign = await fetch(`${ctx.base}/api/v1/ingest/attempts`, {
      method: 'POST', headers: bearer(WORKER_NODE),
      body: JSON.stringify({ attempts: [{ attemptId: 'att_box', state: 'failed', node: 'brrrrrrrr' }] }),
    });
    assert.equal(foreign.status, 403);
    const missing = await fetch(`${ctx.base}/api/v1/ingest/events`, {
      method: 'POST', headers: bearer(WORKER),
      body: JSON.stringify({ events: [{ attemptId: 'att_missing', seq: 1, kind: 'log', text: 'nope' }] }),
    });
    assert.equal(missing.status, 409);
    const board = await fetch(`${ctx.base}/api/v1/ingest/board`, {
      method: 'POST', headers: bearer(WORKER),
      body: JSON.stringify({ groups: [{ name: 'x', tasks: [{ id: 't', title: 'no', status: 'todo' }] }] }),
    });
    assert.equal(board.status, 403);
    const own = await fetch(`${ctx.base}/api/v1/ingest/attempts`, {
      method: 'POST', headers: bearer(ORBIT),
      body: JSON.stringify({ attempts: [{ attemptId: 'att_own', state: 'running', node: 'brrrrrrrr', taskId: 't2' }] }),
    });
    assert.equal(own.status, 200);
    const update = await fetch(`${ctx.base}/api/v1/ingest/events`, {
      method: 'POST', headers: bearer(WORKER_NODE),
      body: JSON.stringify({ events: [{ attemptId: 'att_own', seq: 1, kind: 'log', text: 'still mine' }] }),
    });
    assert.equal(update.status, 200);
  } finally { await ctx.stop(); }
});

test('tailscale identity is trusted only from loopback when enabled', async () => {
  const config = { trustTailscale: true, tailscaleUsers: ['kyle@example.com'] };
  assert.equal(tailscaleIdentity({ socket: { remoteAddress: '100.64.1.2' }, headers: { 'tailscale-user-login': 'kyle@example.com' } }, config), null);
  assert.equal(tailscaleIdentity({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'tailscale-user-login': 'other@example.com' } }, config), null);
  assert.equal(tailscaleIdentity({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'tailscale-user-login': 'kyle@example.com' } }, { ...config, trustTailscale: false }), null);
  const allowed = tailscaleIdentity({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'tailscale-user-login': 'kyle@example.com', 'tailscale-user-name': 'Kyle' } }, config);
  assert.equal(allowed.actor, 'kyle@example.com');

  const ctx = await boot({ trustTailscale: true, tailscaleUsers: ['kyle@example.com'] });
  try {
    const response = await fetch(`${ctx.base}/api/v1/me`, { headers: { 'tailscale-user-login': 'kyle@example.com' } });
    assert.equal(response.status, 200);
    const me = await response.json();
    assert.equal(me.via, 'tailscale');
    assert.equal(me.actor, 'kyle@example.com');
  } finally { await ctx.stop(); }
});

test('redact strips bearer tokens from log lines', () => {
  const line = redact('Authorization: Bearer orbit-token-test-value-0001 failed', [ORBIT]);
  assert.equal(line.includes(ORBIT), false);
  assert.match(line, /\[redacted\]/);
});
