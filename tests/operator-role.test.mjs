// RED for wave A slice A9 (review Fix now #10): control-plane sessions expire
// server-side, and the control POST routes need an operator role.
// Today a session id stays valid forever on the server (only the cookie has a
// 12 h Max-Age), and any viewer identity can cancel attempts, pause dispatch
// or change concurrency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, bearer, ORBIT, VIEWER, OPERATOR } from './helpers.mjs';
import { createSessions, sessionCookie, SESSION_TTL_MS } from '../src/auth.mjs';
import { classifyToken } from '../src/config.mjs';

const CONTROL = [
  ['/api/v1/control/tasks', { title: 't', spec: 's', project: 'p', group: 'g', priority: 1, fileScope: [], dependencies: [] }],
  ['/api/v1/control/tasks/t1/move', { column: 'review' }],
  ['/api/v1/control/tasks/t1/priority', { priority: 1 }],
  ['/api/v1/control/attempts/att1/cancel', {}],
  ['/api/v1/control/attempts/att1/retry', {}],
  ['/api/v1/control/attempts/att1/review', { accepted: false }],
  ['/api/v1/control/dispatch', { paused: true }],
  ['/api/v1/control/concurrency', { max: 1 }],
];

test('session ttl matches the cookie and is exported', () => {
  assert.equal(SESSION_TTL_MS, 12 * 60 * 60 * 1000);
  assert.match(sessionCookie('x'), new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
});

test('sessions expire server-side', () => {
  let now = 1_000_000;
  const sessions = createSessions({ ttlMs: 1000, now: () => now });
  const id = sessions.create('owner', 'operator');
  assert.equal(sessions.read(id).actor, 'owner');
  assert.equal(sessions.read(id).role, 'operator');
  now += 999;
  assert.ok(sessions.read(id));
  now += 2;
  assert.equal(sessions.read(id), null);
  now -= 500;
  assert.equal(sessions.read(id), null, 'an expired session is deleted, not resurrected');
});

test('default sessions use the 12 h ttl', () => {
  let now = 0;
  const sessions = createSessions({ now: () => now });
  const id = sessions.create('owner', 'viewer');
  now = SESSION_TTL_MS - 1;
  assert.ok(sessions.read(id));
  now = SESSION_TTL_MS + 1;
  assert.equal(sessions.read(id), null);
});

test('an operator token is classified as operator', () => {
  assert.equal(classifyToken('operator', 'x'.repeat(32)).role, 'operator');
});

for (const [path, body] of CONTROL) {
  test(`viewer is refused on ${path}`, async () => {
    const ctx = await boot();
    try {
      const res = await fetch(`${ctx.base}${path}`, { method: 'POST', headers: bearer(VIEWER), body: JSON.stringify(body) });
      assert.equal(res.status, 403);
      assert.match((await res.json()).error, /operator/);
    } finally { await ctx.stop(); }
  });
}

test('orbit bearer is refused on control routes', async () => {
  const ctx = await boot();
  try {
    const res = await fetch(`${ctx.base}/api/v1/control/dispatch`, { method: 'POST', headers: bearer(ORBIT), body: JSON.stringify({ paused: true }) });
    assert.equal(res.status, 403);
  } finally { await ctx.stop(); }
});

test('operator bearer may use control routes', async () => {
  const ctx = await boot();
  try {
    const res = await fetch(`${ctx.base}/api/v1/control/dispatch`, { method: 'POST', headers: bearer(OPERATOR), body: JSON.stringify({ paused: true }) });
    assert.equal(res.status, 202);
  } finally { await ctx.stop(); }
});

test('an operator session keeps the operator role; a viewer session does not gain it', async () => {
  const ctx = await boot();
  try {
    for (const [token, want] of [[OPERATOR, 202], [VIEWER, 403]]) {
      const login = await fetch(`${ctx.base}/api/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const res = await fetch(`${ctx.base}/api/v1/control/dispatch`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }) });
      assert.equal(res.status, want);
    }
  } finally { await ctx.stop(); }
});

test('viewers can still read', async () => {
  const ctx = await boot();
  try {
    const res = await fetch(`${ctx.base}/api/v1/board`, { headers: bearer(VIEWER) });
    assert.equal(res.status, 200);
  } finally { await ctx.stop(); }
});

test('identity-header users are operators only when listed', async () => {
  const ctx = await boot({ trustTailscale: true, tailscaleUsers: ['owner@example.com', 'guest@example.com'], operators: ['owner@example.com'] });
  try {
    for (const [login, want] of [['owner@example.com', 202], ['guest@example.com', 403]]) {
      const res = await fetch(`${ctx.base}/api/v1/control/dispatch`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify({ paused: true }),
      });
      assert.equal(res.status, want, login);
    }
  } finally { await ctx.stop(); }
});
