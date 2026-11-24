import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = new URL('../scripts/obs-snapshot.mjs', import.meta.url).pathname;
const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();

test('CLI builds a redacted snapshot file from an attempts fixture', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'obs-'));
  try {
    const fixture = path.join(dir, 'attempts.json');
    await writeFile(fixture, JSON.stringify({ cap: 12, attempts: [
      { attempt_id: 'att_00000000000000a1', state: 'running', model: 'go:deepseek-v4.1-flash', created_at: ago(9), updated_at: ago(1), node: ['100', '64', '0', '9'].join('.'), result: { source: { project: 'uirizz' } } },
      { attempt_id: 'att_00000000000000a2', state: 'failed', model: 'deepseek:deepseek-flash', created_at: ago(40), ended_at: ago(30), detail: `ssh someone@${['box', 'tail1', 'ts', 'net'].join('.')} failed ghp_abcdefghijklmnop0123` },
    ] }));
    const out = path.join(dir, 'snap', 'snapshot.json');
    const { stdout } = await run('node', [CLI, '--attempts-json', fixture, '--out', out, '--resources']);
    assert.match(stdout, /wrote snapshot/);
    const text = await readFile(out, 'utf8');
    const snap = JSON.parse(text);
    assert.equal(snap.schema, 'rizzstack.observability/chat-card/1');
    assert.equal(snap.bees.active, 1);
    assert.equal(snap.problems.counts.failedRuns, 1);
    assert.equal(snap.resources.available, true);
    for (const bad of [['100', '64', '0', '9'].join('.'), ['ts', 'net'].join('.'), 'ghp_', 'someone@']) assert.ok(!text.includes(bad), bad);
    assert.equal((await stat(out)).mode & 0o077, 0, 'owner-only file mode');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI refuses an unknown flag and prints nothing secret', async () => {
  await assert.rejects(() => run('node', [CLI, '--nope']), (e) => /unknown option/i.test(e.stderr));
});
