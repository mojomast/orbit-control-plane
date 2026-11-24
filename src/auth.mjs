import { timingSafeEqual, randomBytes } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function remoteAddress(req) {
  return req.socket?.remoteAddress || '';
}

export function isLoopback(address) {
  return LOOPBACK.has(address) || address === '::ffff:127.0.0.1';
}

export function bearerToken(header) {
  const value = String(header || '');
  const match = value.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : '';
}

export function authenticateBearer(header, tokens) {
  const raw = bearerToken(header);
  if (!raw) return null;
  const got = Buffer.from(raw);
  for (const entry of tokens.values()) {
    const expected = Buffer.from(entry.token);
    if (expected.length === got.length && timingSafeEqual(got, expected)) {
      return { id: entry.id, role: entry.role, node: entry.node || null, via: 'bearer' };
    }
  }
  return null;
}

export function tailscaleIdentity(req, config) {
  if (!config.trustTailscale) return null;
  if (!isLoopback(req.socket?.remoteAddress || '')) return null;
  const login = String(req.headers['tailscale-user-login'] || '').trim();
  if (!login || login.length > 200 || /[\r\n]/.test(login)) return null;
  if (config.tailscaleUsers.length && !config.tailscaleUsers.includes(login)) return null;
  const name = String(req.headers['tailscale-user-name'] || login).replace(/[\r\n]/g, ' ').slice(0, 200);
  const role = Array.isArray(config.operators) && config.operators.includes(login) ? 'operator' : 'viewer';
  return { id: login, actor: login, name, role, via: 'tailscale' };
}

export function createSessions({ ttlMs = SESSION_TTL_MS, now = Date.now } = {}) {
  const sessions = new Map();
  return {
    create(actor, role = 'viewer') {
      const id = randomBytes(24).toString('base64url');
      sessions.set(id, { actor, role, expiresAt: now() + ttlMs });
      return id;
    },
    read(id) {
      if (!id) return null;
      const session = sessions.get(id);
      if (!session) return null;
      if (session.expiresAt <= now()) {
        sessions.delete(id);
        return null;
      }
      return session;
    },
    destroy(id) { sessions.delete(id); },
  };
}

export function readCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function sessionCookie(id, { secure = false, maxAge = SESSION_TTL_MS / 1000 } = {}) {
  const bits = [
    `ocp=${encodeURIComponent(id)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie(secure = false) {
  return sessionCookie('', { secure, maxAge: 0 });
}
