import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toColumn } from '../src/columns.mjs';
import { scrub } from '../src/redact.mjs';

export function createConnector(opts) {
  const orbitUrl = String(opts.orbitUrl || 'http://127.0.0.1:4318').replace(/\/$/, '');
  const cpUrl = String(opts.controlPlaneUrl || '').replace(/\/$/, '');
  const runtimeDir = opts.runtimeDir || process.env.ORBIT_RUNTIME_DIR || path.join(os.homedir(), '.orbit-runtime');
  const pollMs = Number(opts.pollMs || process.env.ORBIT_CP_POLL_MS || 4000);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const log = opts.log || ((...parts) => console.log(parts.map(part => typeof part === 'string' ? part : JSON.stringify(part)).join(' ')));
  let ws = null;
  let timer = null;

  const secretValues = () => [opts.boardKey, opts.grokKey, opts.launcherToken, opts.token].filter(value => typeof value === 'string' && value.length >= 8);

  function readKey(file, override) {
    if (override) return override;
    return fs.readFileSync(file, 'utf8').trim();
  }
  const boardKey = () => readKey(path.join(runtimeDir, 'collab-board.key'), opts.boardKey);
  const grokKey = () => readKey(path.join(runtimeDir, 'grokbots-app.key'), opts.grokKey);

  async function orbitPost(pathname, body, key) {
    const response = await fetchImpl(orbitUrl + pathname, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(json.error || `Orbit returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return json;
  }

  async function cp(method, pathname, body) {
    const response = await fetchImpl(cpUrl + pathname, {
      method,
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(json.error || `control plane returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return json;
  }

  async function snapshot() {
    let groups = [];
    try {
      const listed = await orbitPost('/api/grokbots-app', { action: 'groups', op: 'list' }, grokKey());
      groups = Array.isArray(listed.groups) ? listed.groups : [];
    } catch (error) {
      log('group list skipped:', error.message);
    }
    const names = new Map(groups.map(group => [group.id, group.name]));
    const boardGroups = [];
    for (const group of groups) {
      try {
        const board = await orbitPost('/api/collab-board', { op: 'list', group: group.id }, boardKey());
        const tasks = [];
        for (const entry of board.entries || []) {
          const task = {
            id: entry.id,
            title: entry.title,
            status: toColumn(entry.status) || 'todo',
            owner: entry.owner,
            summary: entry.summary || '',
            checkins: entry.checkins || [],
          };
          Object.assign(task, await entryDetail(group.id, entry));
          tasks.push(task);
        }
        boardGroups.push({ id: group.id, name: group.name, tasks });
      } catch (error) {
        log(`board ${group.name || group.id} skipped:`, error.message);
      }
    }
    let attempts = [];
    try {
      const listed = await orbitPost('/api/local-workers', { op: 'list' }, boardKey());
      attempts = (listed.attempts || []).map(attempt => mapAttempt(attempt, names));
    } catch (error) {
      log('local workers skipped:', error.message);
    }
    const launchers = [];
    if (opts.launcherUrl) {
      try { launchers.push(await launcherHealth()); }
      catch (error) { log('launcher health skipped:', error.message); }
    }
    const grok = { groups: { groups } };
    try {
      grok.roster = scrub(await orbitPost('/api/grokbots-app', { action: 'agents' }, grokKey()), secretValues());
    } catch (error) {
      log('agent roster skipped:', error.message);
    }
    return { boardGroups, attempts, launchers, grok: scrub(grok, secretValues()) };
  }

  // Orbit collab-board op "get" (spec, priority, file scope, deps, history). Cached per entry+status so each
  // change costs one call; switched off if this Orbit does not have the op yet.
  const detailCache = new Map();
  let detailSupported = true;
  async function entryDetail(groupId, entry) {
    if (!detailSupported) return {};
    const key = `${entry.id}:${entry.status}:${(entry.checkins || []).length}`;
    if (detailCache.get(entry.id)?.key === key) return detailCache.get(entry.id).value;
    try {
      const got = (await orbitPost('/api/collab-board', { op: 'get', group: groupId, entry: entry.id }, boardKey())).entry || {};
      const value = {
        spec: got.spec || null,
        project: got.project || undefined,
        priority: got.priority ?? undefined,
        fileScope: got.fileScope?.length ? got.fileScope : undefined,
        dependencies: got.dependsOn?.length ? got.dependsOn : undefined,
        history: (got.history || []).map(e => ({ at: e.at, status: e.data?.status, note: e.data?.note || e.type, actor: e.actor })),
      };
      detailCache.set(entry.id, { key, value });
      return value;
    } catch (error) {
      if (error.status === 400) { detailSupported = false; log('collab-board get not available; board detail limited to list fields'); }
      return {};
    }
  }

  async function push(snap) {
    await cp('POST', '/api/v1/ingest/heartbeat', { kind: 'orbit', detail: 'snapshot' });
    if (snap.boardGroups.length) await cp('POST', '/api/v1/ingest/board', { groups: snap.boardGroups });
    if (snap.attempts.length) await cp('POST', '/api/v1/ingest/attempts', { attempts: snap.attempts });
    if (snap.launchers.length) await cp('POST', '/api/v1/ingest/launchers', { nodes: snap.launchers });
    await cp('POST', '/api/v1/ingest/grok', { snapshots: { groups: snap.grok.groups, roster: snap.grok.roster || { groups: [] } } });
  }

  async function tick() {
    const snap = await snapshot();
    await push(snap);
    const pulled = await cp('GET', '/api/v1/ingest/intents?limit=20');
    for (const intent of pulled.intents || []) {
      try { await applyIntent(intent); }
      catch (error) { log('intent failed', intent.id, error.message); }
    }
    return snap;
  }

  async function applyIntent(intent) {
    try {
      const result = await dispatchIntent(intent);
      await cp('POST', `/api/v1/ingest/intents/${intent.id}/result`, {
        outcome: result.deferred ? 'deferred' : 'applied',
        detail: result.detail || '',
        result,
      });
      return result;
    } catch (error) {
      await cp('POST', `/api/v1/ingest/intents/${intent.id}/result`, {
        outcome: 'rejected',
        detail: error.message,
      }).catch(report => log('could not reject intent', intent.id, report.message));
      throw error;
    }
  }

  async function dispatchIntent(intent) {
    const payload = intent.payload || {};
    switch (intent.type) {
      case 'task.create': {
        const group = await resolveGroup(payload);
        const created = await orbitPost('/api/collab-board', {
          op: 'new', group, title: payload.title, spec: composeSpec(payload), status: 'todo', by: 'local-workers',
        }, boardKey());
        return { entry: created.entry, detail: 'board entry created' };
      }
      case 'task.move': {
        const group = await resolveGroup(payload);
        await orbitPost('/api/collab-board', {
          op: 'update', group, entry: payload.orbitId || payload.taskId, status: payload.column,
          note: payload.note || `control plane moved this to ${payload.column}`, by: 'local-workers',
        }, boardKey());
        return { detail: 'board column updated' };
      }
      case 'task.priority': {
        const group = await resolveGroup(payload);
        await orbitPost('/api/collab-board', {
          op: 'update', group, entry: payload.orbitId || payload.taskId,
          note: `priority P${payload.priority} from the control plane`, by: 'local-workers',
        }, boardKey());
        return { deferred: true, detail: 'priority written into the board note; the collab board has no priority field' };
      }
      case 'attempt.cancel':
        await orbitPost('/api/local-workers', { op: 'cancel', attempt_id: payload.attemptId }, boardKey());
        return { detail: 'cancel requested' };
      case 'attempt.retry': {
        const brief = briefFromLedger(payload.attemptId);
        const created = await orbitPost('/api/local-workers', {
          op: 'create', task_id: payload.taskId, board_entry: payload.boardEntry || payload.taskId,
          group: payload.groupId || payload.group, brief, coordinator: 'MR.INDIA',
        }, boardKey());
        return { attempt: created, detail: 'retry created' };
      }
      case 'attempt.review':
        await orbitPost('/api/local-workers', {
          op: 'review', attempt_id: payload.attemptId, accepted: payload.accepted === true, note: payload.note || '', by: 'kyle',
        }, boardKey());
        return { detail: payload.accepted ? 'accepted' : 'changes requested' };
      case 'dispatch.pause':
        writeHook('dispatch.json', { paused: payload.paused === true, at: new Date().toISOString() });
        return { detail: payload.paused === true ? 'dispatch paused (Orbit local-workers pump() reads control-plane/dispatch.json); running attempts continue' : 'dispatch resumed' };
      case 'launcher.concurrency':
        writeHook('concurrency.json', { nodes: { [payload.node]: payload.max }, at: new Date().toISOString() });
        return { detail: `cap ${payload.max} for ${payload.node}: Orbit adapter reads control-plane/concurrency.json and pushes it to the launcher (POST /v1/config, launcher >= 0.1.5)` };
      case 'grok.action': {
        const data = scrub(await orbitPost('/api/grokbots-app', payload.body, grokKey()), secretValues());
        return { data, detail: 'proxied to Grok Bots' };
      }
      default:
        throw Object.assign(new Error(`unsupported intent ${intent.type}`), { status: 400 });
    }
  }

  async function resolveGroup(payload) {
    if (payload.groupId) return payload.groupId;
    const listed = await orbitPost('/api/grokbots-app', { action: 'groups', op: 'list' }, grokKey());
    const name = payload.group || payload.groupName;
    const found = (listed.groups || []).find(group => group.id === name || group.name === name);
    if (!found) throw new Error(`no Grok Bots group named ${name || '(missing)'}`);
    return found.id;
  }

  function briefFromLedger(attemptId) {
    const file = path.join(runtimeDir, 'local-workers', 'ledger.json');
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    const attempt = ledger.attempts?.[attemptId];
    if (!attempt?.brief?.objective) throw new Error('the local-workers ledger has no brief for that attempt');
    return attempt.brief;
  }

  function writeHook(name, value) {
    const dir = path.join(runtimeDir, 'control-plane');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  }

  async function launcherHealth() {
    const headers = {};
    if (opts.launcherToken) headers.authorization = `Bearer ${opts.launcherToken}`;
    const response = await fetchImpl(String(opts.launcherUrl).replace(/\/$/, '') + '/v1/health', { headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`launcher health returned ${response.status}`);
    return {
      node: opts.node || body.node || 'launcher',
      healthy: true,
      version: body.version || null,
      model: body.model || null,
      concurrencyUsed: body.active ?? body.concurrency_used ?? 0,
      concurrencyMax: body.max_concurrent ?? body.concurrency_max ?? 1,
      queued: body.queued ?? 0,
      detail: 'reported by launcher /v1/health',
    };
  }

  async function frameData(data) {
    if (typeof data === 'string') return data;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return data.toString('utf8');
    if (data && typeof data.text === 'function') return data.text();
    return String(data ?? '');
  }

  function connect() {
    const wsUrl = cpUrl.replace(/^http/, 'ws') + '/api/v1/connector';
    ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${opts.token}` } });
    ws.addEventListener('message', async event => {
      let msg;
      try { msg = JSON.parse(await frameData(event.data)); } catch { return; }
      if (msg?.type !== 'rpc' || !msg.id) return;
      try {
        if (msg.body?.action !== 'grokbots') throw new Error('unsupported connector call');
        const data = scrub(await orbitPost('/api/grokbots-app', msg.body.body, grokKey()), secretValues());
        ws.send(JSON.stringify({ type: 'rpc-result', id: msg.id, ok: true, data }));
      } catch (error) {
        try { ws.send(JSON.stringify({ type: 'rpc-result', id: msg.id, ok: false, error: error.message, status: error.status || 502 })); }
        catch { /* socket already gone */ }
      }
    });
    return ws;
  }

  return {
    tick, connect, snapshot, applyIntent,
    start() {
      connect();
      timer = setInterval(() => { tick().catch(error => log('tick failed:', error.message)); }, pollMs);
      timer.unref?.();
      return tick();
    },
    stop() {
      clearInterval(timer);
      try { ws?.close(); } catch { /* already closed */ }
    },
  };
}

function mapAttempt(attempt, names) {
  const groupId = attempt.group || attempt.group_id || null;
  return {
    attemptId: attempt.attempt_id || attempt.attemptId,
    taskId: attempt.task_id || attempt.taskId,
    boardEntry: attempt.board_entry || attempt.boardEntry,
    groupId,
    groupName: names.get(groupId) || attempt.group_name || groupId,
    generation: attempt.generation,
    state: attempt.state,
    detail: attempt.detail,
    node: attempt.node,
    sandbox: attempt.env_id || attempt.sandbox || null,
    runId: attempt.cua_run_id || attempt.run_id || attempt.runId || null,
    sessionId: attempt.opencode_session_id || attempt.session_id || null,
    model: attempt.model,
    provider: attempt.provider,
    coordinator: attempt.coordinator,
    inputManifestSha256: attempt.input_manifest_sha256 || null,
    createdAt: attempt.created_at,
    updatedAt: attempt.updated_at,
    endedAt: attempt.ended_at,
    supersededBy: attempt.superseded_by || null,
    files: attempt.artifact_refs || attempt.files || [],
    review: attempt.review || null,
    tokensIn: attempt.tokens_in,
    tokensOut: attempt.tokens_out,
    costUsd: attempt.cost_usd,
  };
}

function composeSpec(payload) {
  const lines = [payload.spec || ''];
  if (payload.project) lines.push('', `Project: ${payload.project}`);
  if (payload.priority) lines.push(`Priority: P${payload.priority}`);
  if (payload.fileScope?.length) lines.push(`File scope: ${payload.fileScope.join(', ')}`);
  if (payload.dependencies?.length) lines.push(`Depends on: ${payload.dependencies.join(', ')}`);
  return lines.join('\n').trim().slice(0, 2000);
}

function readToken() {
  if (process.env.ORBIT_CP_TOKEN_FILE) return fs.readFileSync(process.env.ORBIT_CP_TOKEN_FILE, 'utf8').trim();
  return process.env.ORBIT_CP_TOKEN || '';
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const token = readToken();
  const controlPlaneUrl = process.env.ORBIT_CP_URL || '';
  if (!token || !controlPlaneUrl) {
    console.error('Set ORBIT_CP_URL and ORBIT_CP_TOKEN_FILE (or ORBIT_CP_TOKEN). The token is not printed.');
    process.exit(1);
  }
  const connector = createConnector({
    token,
    controlPlaneUrl,
    orbitUrl: process.env.ORBIT_URL || 'http://127.0.0.1:4318',
    runtimeDir: process.env.ORBIT_RUNTIME_DIR,
    launcherUrl: process.env.ORBIT_LOCAL_WORKERS_URL,
    launcherToken: process.env.ORBIT_LOCAL_WORKERS_TOKEN_FILE
      ? fs.readFileSync(process.env.ORBIT_LOCAL_WORKERS_TOKEN_FILE, 'utf8').trim()
      : undefined,
    node: process.env.ORBIT_LOCAL_WORKERS_NODE || 'brrrrrrrr',
  });
  connector.start().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
  process.on('SIGINT', () => { connector.stop(); process.exit(0); });
  process.on('SIGTERM', () => { connector.stop(); process.exit(0); });
}
