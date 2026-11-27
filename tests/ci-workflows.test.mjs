// Contract for orbit-control-plane's GitHub Actions (rizzstack follow-ups item 23;
// shared rules in rizzstack/codemap/ci-gates.md). CI must run `npm test` on Node 22,
// the rizzobs plugin tests, a full-history gitleaks scan and a blocking
// slop-lint ratchet, with SHA-pinned actions, read-only tokens and no persisted
// credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';

const DIR = resolve(new URL('../.github/workflows', import.meta.url).pathname);
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const read = (name) => {
  const file = resolve(DIR, name);
  assert.ok(existsSync(file), `missing .github/workflows/${name}`);
  return readFileSync(file, 'utf8');
};
const all = () => (existsSync(DIR) ? readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)) : []);

test('CI runs npm test on Node 22 for pull requests and pushes to main', () => {
  const t = read('ci.yml');
  assert.ok(t.includes('pull_request:'));
  assert.match(t, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.ok(!t.includes('pull_request_target'));
  assert.match(t, /node-version:\s*['"]22['"]/);
  assert.match(t, /run:\s*npm test\s*$/m);
  const engines = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).engines.node;
  assert.match(engines, /^>=22\./, 'package.json engines and the CI Node major must agree');
});

test('CI runs the rizzobs Hermes plugin tests', () => {
  assert.match(read('ci.yml'), /python3? -m pytest -q hermes-plugin\/rizzobs/);
});

test('CI scans full history with a checksum-verified gitleaks', () => {
  const t = read('ci.yml');
  assert.match(t, /^    name:\s*gitleaks\s*$/m);
  assert.match(t, /fetch-depth:\s*0/);
  assert.match(t, /echo "[0-9a-f]{64}  gitleaks\.tgz" \| sha256sum -c -/);
  assert.match(t, /gitleaks detect --source \. --redact/);
});

test('slop-lint blocks new findings against a committed baseline', () => {
  const t = read('slop-lint.yml');
  assert.match(t, /^  slop-lint:\s*\n    name:\s*slop-lint\s*$/m);
  assert.match(t, /node scripts\/slop-lint\.mjs check src connector scripts public --baseline slop-baseline\.json --pass-on-unpruned/);
  // Blocking ratchet: findings above the baseline fail the job.
  assert.doesNotMatch(t, /--report-only/);
  assert.doesNotMatch(t, /continue-on-error/);
  assert.ok(t.includes('GITHUB_STEP_SUMMARY'));
  assert.ok(existsSync(resolve(ROOT, 'slop-baseline.json')), 'slop-baseline.json missing');
  const owners = readFileSync(resolve(ROOT, '.github/CODEOWNERS'), 'utf8');
  assert.match(owners, /^\/slop-baseline\.json\s+@mojomast\s*$/m);
});

test('every workflow pins actions by SHA, drops the token and stays read-only', () => {
  const files = all();
  assert.ok(files.length >= 2, 'expected ci.yml and slop-lint.yml');
  for (const name of files) {
    const t = read(name);
    for (const [, ref] of t.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      assert.match(ref, /@[0-9a-f]{40}$/, `${name}: ${ref}`);
    }
    const checkouts = (t.match(/uses:\s*actions\/checkout@/g) || []).length;
    const dropped = (t.match(/persist-credentials:\s*false/g) || []).length;
    assert.equal(dropped, checkouts, `${name}: every checkout needs persist-credentials: false`);
    const perms = t.match(/^permissions:\s*\n((?:[ \t]+.*\n)+)/m);
    assert.ok(perms && perms[1].includes('contents: read'), `${name}: read-only permissions`);
    const writes = (t.match(/^\s+[a-z-]+:\s*write\s*$/gm) || []).map((line) => line.trim());
    if (name === 'review-rerun.yml') {
      // This job needs actions: write to call actions/runs/<id>/rerun-failed-jobs.
      assert.deepEqual(writes, ['actions: write'], `${name}: only actions: write`);
    } else {
      assert.deepEqual(writes, [], `${name}: no write permissions`);
    }
    assert.ok(!t.includes('secrets.'), `${name}: no secrets`);
  }
});
