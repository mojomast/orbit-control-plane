#!/usr/bin/env node
// Write a redacted rizzstack observability snapshot (see docs/OBSERVABILITY.md).
//
//   node scripts/obs-snapshot.mjs --out <file> [--github] [--resources]
//        [--attempts-json <file> | --orbit-url <url> --orbit-key-file <file>]
//        [--rates <file>] [--window-hours 24] [--window-days 7]
//
// Read-only. The Orbit key is read from a file and sent only to the loopback Orbit
// URL; it is never written to the snapshot or printed.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir, loadavg, cpus, totalmem, freemem } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildObservability, normalizeOrbitAttempt, sanitizeText } from '../src/observability.mjs';
import { collectGithub, collectResources, diskUsage, enrichFromResultFiles } from '../src/obs-collect.mjs';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'attempts-json': { type: 'string' },
    'orbit-url': { type: 'string', default: 'http://127.0.0.1:4318' },
    'orbit-key-file': { type: 'string', default: path.join(homedir(), '.orbit-runtime', 'collab-board.key') },
    github: { type: 'boolean', default: false },
    resources: { type: 'boolean', default: false },
    rates: { type: 'string' },
    'window-hours': { type: 'string', default: '24' },
    'window-days': { type: 'string', default: '7' },
    'results-dir': { type: 'string', default: path.join(homedir(), '.orbit-runtime', 'local-workers') },
  },
  strict: true,
});

function isLoopback(url) {
  const u = new URL(url);
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}

async function loadAttempts() {
  if (values['attempts-json']) return JSON.parse(await readFile(values['attempts-json'], 'utf8'));
  if (!isLoopback(values['orbit-url'])) throw new Error('orbit-url must be a loopback http URL');
  const key = (await readFile(values['orbit-key-file'], 'utf8')).trim();
  const res = await fetch(values['orbit-url'].replace(/\/$/, '') + '/api/local-workers', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'list' }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`orbit returned ${res.status}`);
  return res.json();
}

const windowHours = Math.max(1, Math.min(168, Number(values['window-hours']) || 24));
const windowDays = Math.max(1, Math.min(31, Number(values['window-days']) || 7));
const listing = await loadAttempts();
const enriched = values['attempts-json']
  ? listing.attempts || []
  : await enrichFromResultFiles(listing.attempts || [], values['results-dir'], { sinceMs: windowHours * 3_600_000 + 3_600_000 });
const github = values.github ? await collectGithub({ days: windowDays }) : null;
const resources = values.resources
  ? collectResources({ loadavg, cpus, totalmem, freemem, disk: () => diskUsage('/') })
  : null;
const rates = values.rates ? JSON.parse(await readFile(values.rates, 'utf8')) : {};

const snapshot = buildObservability({
  attempts: enriched.map(normalizeOrbitAttempt),
  cap: listing.cap ?? null,
  github, resources, rates, windowHours, windowDays,
});
const text = JSON.stringify(snapshot, null, 1) + '\n';
if (values.out) {
  const dest = path.resolve(values.out);
  await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, dest);
  console.log(sanitizeText(`wrote snapshot (${snapshot.bees.active} active, ${snapshot.problems.counts.failedRuns} failed runs, sources: ${snapshot.sources.join(',')})`, 200));
} else {
  process.stdout.write(text);
}
