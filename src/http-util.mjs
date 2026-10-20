import { redact } from './redact.mjs';

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function send(res, status, body, headers = {}) {
  if (body == null) {
    res.writeHead(status, { ...SECURITY, 'cache-control': 'no-store', ...headers });
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    ...SECURITY,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': payload.length,
    ...headers,
  });
  res.end(payload);
}

export async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch {
    const error = new Error('invalid JSON');
    error.status = 400;
    throw error;
  }
}

export function fail(res, error, secrets) {
  const status = error.status || 500;
  send(res, status, { error: redact(error.message || 'failed', secrets) });
}

export function createBroker() {
  const clients = new Set();
  return {
    add(res) {
      res.writeHead(200, {
        ...SECURITY,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* closed */ }
      }, 20_000);
      ping.unref?.();
      res.on('close', () => { clearInterval(ping); clients.delete(res); });
    },
    publish(type, data) {
      const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) {
        try { res.write(frame); } catch { /* closed */ }
      }
    },
  };
}
