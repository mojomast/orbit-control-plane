import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TOKEN_MIN = 16;

export function tailscaleIpv4() {
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ip = out.trim().split(/\s+/)[0];
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return ip;
  } catch { /* tailscale is optional */ }
  return null;
}

export function resolveBind(env = process.env) {
  if (env.ORBIT_CP_BIND) return env.ORBIT_CP_BIND;
  const ts = tailscaleIpv4();
  if (ts) return ts;
  if (env.ORBIT_CP_DOCKER === '1') return '0.0.0.0';
  return '127.0.0.1';
}

function readSecretFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    const err = new Error(`cannot read token file ${path.basename(file)}`);
    err.cause = error;
    throw err;
  }
  const token = text.trim();
  if (token.length < TOKEN_MIN) {
    throw new Error(`token file ${path.basename(file)} must contain at least ${TOKEN_MIN} characters`);
  }
  return token;
}

export function classifyToken(id, token) {
  if (id === 'viewer') return { id, role: 'viewer', node: null, token };
  if (id === 'orbit') return { id, role: 'orbit', node: null, token };
  if (id === 'worker') return { id, role: 'worker', node: null, token };
  if (id.startsWith('worker_')) return { id, role: 'worker', node: id.slice('worker_'.length), token };
  return { id, role: 'unknown', node: null, token };
}

export function loadTokens(env = process.env) {
  const byId = new Map();
  const dir = env.ORBIT_CP_TOKEN_DIR;
  if (dir) {
    let names = [];
    try { names = fs.readdirSync(dir); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const name of names) {
      if (name.startsWith('.') || name === 'README.md') continue;
      const file = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      const id = name.replace(/\.token$/, '');
      byId.set(id, classifyToken(id, readSecretFile(file)));
    }
  }
  const named = [
    ['orbit', env.ORBIT_CP_TOKEN_ORBIT, env.ORBIT_CP_TOKEN_FILE_ORBIT],
    ['worker', env.ORBIT_CP_TOKEN_WORKER, env.ORBIT_CP_TOKEN_FILE_WORKER],
    ['viewer', env.ORBIT_CP_TOKEN_VIEWER, env.ORBIT_CP_TOKEN_FILE_VIEWER],
  ];
  for (const [id, inline, file] of named) {
    let token = null;
    if (inline) {
      token = String(inline).trim();
      if (token.length < TOKEN_MIN) throw new Error(`${id} token must contain at least ${TOKEN_MIN} characters`);
    } else if (file) token = readSecretFile(file);
    if (token) byId.set(id, classifyToken(id, token));
  }
  return byId;
}

export function loadConfig(env = process.env, overrides = {}) {
  const demo = env.ORBIT_CP_DEMO === '1' || env.ORBIT_CP_DEMO === 'true';
  const dataDir = overrides.dataDir || env.ORBIT_CP_DATA || path.join(process.cwd(), 'data');
  const trustTailscale = env.ORBIT_CP_TRUST_TAILSCALE === '1' || env.ORBIT_CP_TRUST_TAILSCALE === 'true';
  const tailscaleUsers = String(env.ORBIT_CP_TAILSCALE_USERS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const port = Number(overrides.port ?? env.ORBIT_CP_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ORBIT_CP_PORT must be a TCP port');
  return {
    dataDir,
    dbPath: overrides.dbPath || env.ORBIT_CP_DB || path.join(dataDir, 'control-plane.sqlite'),
    port,
    bind: overrides.bind || resolveBind(env),
    demo: overrides.demo ?? demo,
    trustTailscale: overrides.trustTailscale ?? trustTailscale,
    tailscaleUsers: overrides.tailscaleUsers ?? tailscaleUsers,
    leaseMs: Number(overrides.leaseMs ?? env.ORBIT_CP_INTENT_LEASE_MS ?? 30_000),
    tokens: overrides.tokens || loadTokens(env),
    cookieSecure: env.ORBIT_CP_COOKIE_SECURE === '1',
    hostLabel: os.hostname(),
  };
}
