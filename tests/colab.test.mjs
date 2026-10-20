// Google Colab runs panel: ingest, viewer read, SSE event, and the connector's file-to-API forwarding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boot, ORBIT, VIEWER } from './helpers.mjs';
import { createConnector } from '../connector/orbit-connector.mjs';
import { readColabDir, createColabStore } from '../src/colab.mjs';

const gauge = (fields) => JSON.stringify({ runId: 'comfyrizz-demo.run.1', job: 'p1', ts: new Date().toISOString(), ...fields });

test('readColabDir keeps the latest value of each gauge', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ocp-colab-'));
  writeFileSync(path.join(dir, 'comfyrizz-demo.run.1.jsonl'), [
    gauge({ stage: 'sampler', label: 'KSampler #3', n: 3, total: 30 }),
    'not json',
    gauge({ stage: 'sampler', label: 'KSampler #3', n: 27, total: 30, rate: 2.4, eta: 1.2, secret: 'x' }),
    gauge({ stage: 'node', label: 'nodes', n: 4, total: 9 }),
  ].join('\n'));
  const [run] = readColabDir(dir);
  assert.equal(run.runId, 'comfyrizz-demo.run.1');
  assert.equal(run.updates, 3);
  assert.equal(run.active, true);
  assert.deepEqual(run.gauges.map(g => [g.stage, g.n, g.total]), [['sampler', 27, 30], ['node', 4, 9]]);
  assert.equal(run.gauges[0].secret, undefined);
  assert.deepEqual(readColabDir(path.join(dir, 'missing')), []);
});

test('the store bounds and validates what it is sent', () => {
  const store = createColabStore();
  assert.throws(() => store.ingest({}), /runs must be an array/);
  assert.throws(() => store.ingest({ runs: Array.from({ length: 31 }, (_, i) => ({ runId: `r${i}` })) }), /exceeds/);
  store.ingest({ runs: [{ runId: 'a', updatedAt: new Date().toISOString(), active: true, gauges: [{ stage: 'tqdm', label: 'x'.repeat(400), n: 1, total: 2 }] }, { nope: 1 }] });
  const [run] = store.list();
  assert.equal(run.gauges[0].label.length, 120);
});

test('ingest needs a source token; viewers read; SSE gets a colab event, not a full update', async () => {
  const cp = await boot();
  try {
    const body = { runs: [{ runId: 'comfyrizz-demo.render.1', updatedAt: new Date().toISOString(), active: true, updates: 2, gauges: [{ job: 'render', stage: 'frames', label: 'frames render', n: 225, total: 450 }] }] };
    const viewerPost = await fetch(`${cp.base}/api/v1/ingest/colab`, { method: 'POST', headers: { authorization: `Bearer ${VIEWER}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(viewerPost.status, 401);
    const controller = new AbortController();
    const stream = await fetch(`${cp.base}/api/v1/stream`, { headers: { authorization: `Bearer ${VIEWER}` }, signal: controller.signal });
    const reader = stream.body.getReader();
    await reader.read(); // ': connected'
    const posted = await fetch(`${cp.base}/api/v1/ingest/colab`, { method: 'POST', headers: { authorization: `Bearer ${ORBIT}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(posted.status, 200);
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert.match(frame, /^event: colab/);
    controller.abort();
    const read = await (await fetch(`${cp.base}/api/v1/colab`, { headers: { authorization: `Bearer ${VIEWER}` } })).json();
    assert.equal(read.runs[0].runId, 'comfyrizz-demo.render.1');
    assert.equal(read.runs[0].gauges[0].n, 225);
    assert.equal((await fetch(`${cp.base}/api/v1/colab`)).status, 401);
  } finally {
    await cp.stop();
  }
});

test('the connector forwards changed Google Colab gauge files and skips unchanged ones', async () => {
  const cp = await boot();
  const dir = mkdtempSync(path.join(tmpdir(), 'ocp-colab-'));
  const file = path.join(dir, 'comfyrizz-demo.run.2.jsonl');
  writeFileSync(file, `${gauge({ stage: 'tqdm', label: 'download', n: 1, total: 4 })}\n`);
  try {
    const connector = createConnector({ token: ORBIT, controlPlaneUrl: cp.base, colabDir: dir, log: () => {} });
    assert.deepEqual(await connector.colabTick(), { sent: true, runs: 1 });
    assert.deepEqual(await connector.colabTick(), { sent: false, runs: 1 });
    await new Promise(r => setTimeout(r, 15));
    appendFileSync(file, `${gauge({ stage: 'tqdm', label: 'download', n: 4, total: 4 })}\n`);
    assert.equal((await connector.colabTick()).sent, true);
    const read = await (await fetch(`${cp.base}/api/v1/colab`, { headers: { authorization: `Bearer ${VIEWER}` } })).json();
    assert.equal(read.runs[0].gauges[0].n, 4);
    assert.equal(read.runs[0].signature, undefined);
  } finally {
    await cp.stop();
  }
});

test('the panel is wired and says Google Colab in full', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /\['colab', 'Google Colab'\]/);
  assert.match(source, /addEventListener\('colab'/);
  assert.equal(/(?<!Google )\bColab\b/.test(source), false);
});
