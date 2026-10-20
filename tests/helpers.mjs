import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../src/server.mjs';

export const ORBIT = 'orbit-token-test-value-0001';
export const WORKER = 'worker-token-test-value-0002';
export const WORKER_NODE = 'worker-node-token-value-0003';
export const VIEWER = 'viewer-token-test-value-0004';

export function tokenMap() {
  return new Map([
    ['orbit', { id: 'orbit', role: 'orbit', node: null, token: ORBIT }],
    ['worker', { id: 'worker', role: 'worker', node: null, token: WORKER }],
    ['worker_brrrrrrrr', { id: 'worker_brrrrrrrr', role: 'worker', node: 'brrrrrrrr', token: WORKER_NODE }],
    ['viewer', { id: 'viewer', role: 'viewer', node: null, token: VIEWER }],
  ]);
}

export async function boot(extra = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ocp-'));
  const app = await start({
    dataDir,
    dbPath: path.join(dataDir, 'control-plane.sqlite'),
    port: 0,
    bind: '127.0.0.1',
    demo: extra.demo ?? false,
    tokens: extra.tokens || tokenMap(),
    trustTailscale: extra.trustTailscale ?? false,
    tailscaleUsers: extra.tailscaleUsers,
    leaseMs: extra.leaseMs ?? 30_000,
  }, {});
  return {
    app,
    dataDir,
    base: `http://127.0.0.1:${app.port}`,
    async stop() {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export function bearer(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}
