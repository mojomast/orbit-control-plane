import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { openDatabase } from './db.mjs';
import { authenticateBearer, tailscaleIdentity, createSessions, readCookie, sessionCookie, clearCookie } from './auth.mjs';
import { createLogger, redact } from './redact.mjs';
import { send, readJson, createBroker } from './http-util.mjs';
import { acceptWebSocket } from './ws.mjs';
import { createHub } from './hub.mjs';
import { ingestHeartbeat, ingestBoard, ingestAttempts, ingestEvents, ingestLaunchers, ingestGrok } from './ingest.mjs';
import { queueTask, moveTask, reprioritise, cancelAttempt, retryAttempt, reviewAttempt, setDispatch, setConcurrency } from './control.mjs';
import { buildStats, snapshotSample } from './stats.mjs';
import { handleGrok } from './grok.mjs';
import { seedDemo } from './seed.mjs';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

export function createContext(config) {
  const store = openDatabase(config.dbPath);
  const sessions = createSessions();
  const hub = createHub();
  const broker = createBroker();
  const secrets = () => [...config.tokens.values()].map(entry => entry.token);
  const log = createLogger(secrets);
  if (config.demo && store.taskCount() === 0) seedDemo(store);

  const sampleTimer = setInterval(() => {
    try {
      snapshotSample(store);
      broker.publish('update', { scope: 'stats' });
    } catch (error) { log('sample failed', error.message); }
  }, 60_000);
  sampleTimer.unref?.();

  function viewer(req) {
    if (config.demo) return { id: 'demo', actor: 'demo', role: 'viewer', via: 'demo', name: 'Demo' };
    const tailscale = tailscaleIdentity(req, config);
    if (tailscale) return tailscale;
    const session = sessions.read(readCookie(req, 'ocp'));
    if (session) return { id: session.actor, actor: session.actor, role: 'viewer', via: 'session', name: session.actor };
    const auth = authenticateBearer(req.headers.authorization, config.tokens);
    if (auth && (auth.role === 'viewer' || auth.role === 'orbit')) return { ...auth, actor: auth.id, name: auth.id };
    return null;
  }

  function source(req) {
    const auth = authenticateBearer(req.headers.authorization, config.tokens);
    if (!auth || (auth.role !== 'orbit' && auth.role !== 'worker')) return null;
    return auth;
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/api/v1/health')) {
        return send(res, 200, { ok: true, demo: !!config.demo, connector: hub.connected });
      }
      if (url.pathname === '/api/v1/session') return await sessionRoute(req, res);
      if (url.pathname.startsWith('/api/v1/ingest')) return await ingestRoute(req, res, url);
      if (url.pathname.startsWith('/api/')) return await apiRoute(req, res, url);
      return staticFile(req, res, url);
    } catch (error) {
      if ((error.status || 500) >= 500) log('request failed', error.message);
      if (!res.headersSent) send(res, error.status || 500, { error: redact(error.message || 'failed', secrets()) });
    }
  }

  async function sessionRoute(req, res) {
    if (req.method === 'DELETE') {
      sessions.destroy(readCookie(req, 'ocp'));
      return send(res, 204, null, { 'set-cookie': clearCookie(config.cookieSecure) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const body = await readJson(req, 4_000);
    const token = typeof body.token === 'string' ? body.token : '';
    const auth = authenticateBearer(`Bearer ${token}`, config.tokens);
    if (!auth || (auth.role !== 'viewer' && auth.role !== 'orbit')) return send(res, 401, { error: 'invalid token' });
    const id = sessions.create(auth.id);
    return send(res, 200, { actor: auth.id }, { 'set-cookie': sessionCookie(id, { secure: config.cookieSecure }) });
  }

  async function ingestRoute(req, res, url) {
    const auth = source(req);
    if (!auth) return send(res, 401, { error: 'unauthorized' });
    const body = req.method === 'GET' ? null : await readJson(req, 1_500_000);
    const path = url.pathname;
    let result;
    if (req.method === 'POST' && path === '/api/v1/ingest/heartbeat') result = ingestHeartbeat(store, auth, body);
    else if (req.method === 'POST' && path === '/api/v1/ingest/board') result = ingestBoard(store, auth, body);
    else if (req.method === 'POST' && path === '/api/v1/ingest/attempts') result = ingestAttempts(store, auth, body);
    else if (req.method === 'POST' && path === '/api/v1/ingest/events') result = ingestEvents(store, auth, body, secrets());
    else if (req.method === 'POST' && path === '/api/v1/ingest/launchers') result = ingestLaunchers(store, auth, body);
    else if (req.method === 'POST' && path === '/api/v1/ingest/grok') result = ingestGrok(store, auth, body, secrets());
    else if (req.method === 'GET' && path === '/api/v1/ingest/intents') {
      if (auth.role !== 'orbit') return send(res, 403, { error: 'only the Orbit connector can pull intents' });
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));
      result = { intents: store.leaseIntents(limit, config.leaseMs) };
    } else {
      const match = path.match(/^\/api\/v1\/ingest\/intents\/([A-Za-z0-9_-]+)\/result$/);
      if (req.method === 'POST' && match) {
        if (auth.role !== 'orbit') return send(res, 403, { error: 'only the Orbit connector can close intents' });
        result = store.finishIntent(match[1], { outcome: body.outcome, detail: body.detail, result: body.result, actor: auth.id });
      } else return send(res, 404, { error: 'unknown ingest route' });
    }
    broker.publish('update', { scope: path.split('/').pop() });
    return send(res, 200, result);
  }

  async function apiRoute(req, res, url) {
    const who = viewer(req);
    if (!who) return send(res, 401, { error: 'sign in required' });
    const path = url.pathname;
    if (req.method === 'GET' && path === '/api/v1/me') {
      return send(res, 200, { actor: who.actor || who.id, name: who.name || who.actor || who.id, via: who.via, demo: !!config.demo, connector: hub.connected, paused: store.isPaused() });
    }
    if (req.method === 'GET' && path === '/api/v1/stream') {
      broker.add(res);
      return;
    }
    if (req.method === 'GET' && path === '/api/v1/overview') return send(res, 200, overview());
    if (req.method === 'GET' && path === '/api/v1/board') {
      return send(res, 200, {
        columns: ['todo', 'doing', 'review', 'blocked', 'done'],
        tasks: store.listTasks({
          group: url.searchParams.get('group') || '',
          column: url.searchParams.get('column') || '',
          owner: url.searchParams.get('owner') || '',
          q: url.searchParams.get('q') || '',
        }),
        paused: store.isPaused(),
      });
    }
    const taskMatch = path.match(/^\/api\/v1\/board\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && taskMatch) {
      const task = store.getTask(decodeURIComponent(taskMatch[1]));
      if (!task) return send(res, 404, { error: 'unknown task' });
      return send(res, 200, { task });
    }
    if (req.method === 'GET' && path === '/api/v1/attempts') return send(res, 200, { attempts: store.listAttempts() });
    const attemptMatch = path.match(/^\/api\/v1\/attempts\/([^/]+)$/);
    if (req.method === 'GET' && attemptMatch) {
      const attempt = store.getAttempt(decodeURIComponent(attemptMatch[1]));
      if (!attempt) return send(res, 404, { error: 'unknown attempt' });
      return send(res, 200, { attempt });
    }
    if (req.method === 'GET' && path === '/api/v1/events') {
      const events = store.listEvents(url.searchParams.get('since') || 0, url.searchParams.get('limit') || 200);
      return send(res, 200, { events });
    }
    if (req.method === 'GET' && path === '/api/v1/launchers') return send(res, 200, { launchers: store.listLaunchers() });
    if (req.method === 'GET' && path === '/api/v1/stats') return send(res, 200, buildStats(store));
    if (req.method === 'GET' && path === '/api/v1/audit') return send(res, 200, { audit: store.listAudit(200) });
    if (req.method === 'GET' && path === '/api/v1/intents') return send(res, 200, { intents: store.listIntents(url.searchParams.get('status') || '') });
    if (req.method === 'POST' && path === '/api/v1/grok') {
      const body = await readJson(req, 200_000);
      const result = await handleGrok({ store, hub, body, actor: who.actor || who.id, secrets: secrets(), demo: config.demo });
      return send(res, result.queued ? 202 : 200, result);
    }
    if (req.method === 'POST') {
      const body = await readJson(req, 100_000);
      const actor = who.actor || who.id;
      let result;
      const move = path.match(/^\/api\/v1\/control\/tasks\/([^/]+)\/move$/);
      const prio = path.match(/^\/api\/v1\/control\/tasks\/([^/]+)\/priority$/);
      const cancel = path.match(/^\/api\/v1\/control\/attempts\/([^/]+)\/cancel$/);
      const retry = path.match(/^\/api\/v1\/control\/attempts\/([^/]+)\/retry$/);
      const review = path.match(/^\/api\/v1\/control\/attempts\/([^/]+)\/review$/);
      if (path === '/api/v1/control/tasks') result = queueTask(store, actor, body);
      else if (move) result = moveTask(store, actor, decodeURIComponent(move[1]), body);
      else if (prio) result = reprioritise(store, actor, decodeURIComponent(prio[1]), body);
      else if (cancel) result = cancelAttempt(store, actor, decodeURIComponent(cancel[1]));
      else if (retry) result = retryAttempt(store, actor, decodeURIComponent(retry[1]));
      else if (review) result = reviewAttempt(store, actor, decodeURIComponent(review[1]), body);
      else if (path === '/api/v1/control/dispatch') result = setDispatch(store, actor, body);
      else if (path === '/api/v1/control/concurrency') result = setConcurrency(store, actor, body);
      else return send(res, 404, { error: 'unknown route' });
      broker.publish('update', { scope: 'control' });
      return send(res, 202, result);
    }
    return send(res, 404, { error: 'unknown route' });
  }

  function overview() {
    const attempts = store.listAttempts();
    const intents = store.listIntents();
    return {
      demo: !!config.demo,
      connector: hub.connected,
      paused: store.isPaused(),
      host: config.hostLabel,
      counts: store.counts(),
      heartbeats: store.listHeartbeats(),
      launchers: store.listLaunchers(),
      inFlight: attempts.filter(attempt => attempt.inFlight),
      queueDepth: attempts.filter(attempt => attempt.state === 'queued' || attempt.state === 'launcher_queued').length,
      openIntents: intents.filter(intent => intent.status === 'queued' || intent.status === 'leased').length,
      recentAudit: store.listAudit(8),
    };
  }

  function upgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { socket.destroy(); return; }
    if (url.pathname !== '/api/v1/connector') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const auth = authenticateBearer(req.headers.authorization, config.tokens);
    if (!auth || auth.role !== 'orbit') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const conn = acceptWebSocket(req, socket, head);
    if (!conn) return;
    hub.attach(conn);
    const onClose = () => { hub.detach(conn); broker.publish('connector', { connected: hub.connected }); };
    socket.on('close', onClose);
    socket.on('error', onClose);
    broker.publish('connector', { connected: true });
    store.heartbeat({ source: auth.id, kind: 'orbit', detail: 'connector attached' });
  }

  function close() {
    clearInterval(sampleTimer);
    store.close();
  }

  return { handle, upgrade, store, hub, broker, config, close };
}

function staticFile(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\0') || pathname.includes('..')) return send(res, 400, { error: 'bad path' });
  const file = path.resolve(PUBLIC_DIR, '.' + pathname);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 400, { error: 'bad path' });
  let data;
  try { data = fs.readFileSync(file); }
  catch { return send(res, 404, { error: 'not found' }); }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

export function start(overrides = {}, env = process.env) {
  const config = loadConfig(env, overrides);
  const ctx = createContext(config);
  const server = http.createServer((req, res) => {
    Promise.resolve(ctx.handle(req, res)).catch(error => {
      if (!res.headersSent) send(res, 500, { error: 'failed' });
      console.log(redact(error?.message || 'failed', [...config.tokens.values()].map(entry => entry.token)));
    });
  });
  server.on('upgrade', (req, socket, head) => ctx.upgrade(req, socket, head));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bind, () => {
      const address = server.address();
      resolve({
        ...ctx,
        server,
        port: address.port,
        async close() {
          clearInterval(ctx.sampleTimer);
          await new Promise(done => server.close(() => done()));
          try { ctx.close(); } catch { /* already closed */ }
        },
      });
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = loadConfig();
  start({}, process.env).then(app => {
    const log = createLogger(() => [...config.tokens.values()].map(entry => entry.token));
    log(`Orbit Control Plane on http://${config.bind}:${app.port} demo=${!!config.demo} tailscaleTrust=${!!config.trustTailscale}`);
    if (!config.demo && !config.trustTailscale && ![...config.tokens.values()].some(entry => entry.role === 'viewer' || entry.role === 'orbit')) {
      log('no viewer token configured; the UI will refuse sessions until one is set or tailscale serve identity is trusted');
    }
  }).catch(error => {
    console.error(redact(error.message || 'failed to start'));
    process.exit(1);
  });
}
