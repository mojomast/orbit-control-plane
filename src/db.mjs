import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { COLUMNS, toColumn, isTerminalAttempt } from './columns.mjs';
import { normalizeApprovalEvent } from './approvals.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_tasks (
  id TEXT PRIMARY KEY,
  orbit_id TEXT,
  group_id TEXT,
  group_name TEXT,
  project TEXT,
  title TEXT NOT NULL,
  spec TEXT,
  column_name TEXT NOT NULL,
  priority INTEGER DEFAULT 3,
  owner TEXT,
  holder TEXT,
  file_scope TEXT,
  dependencies TEXT,
  summary TEXT,
  source TEXT,
  sync_state TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS task_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  at TEXT NOT NULL,
  column_name TEXT,
  note TEXT,
  actor TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT,
  board_entry TEXT,
  group_id TEXT,
  group_name TEXT,
  generation INTEGER DEFAULT 1,
  state TEXT NOT NULL,
  detail TEXT,
  node TEXT,
  sandbox TEXT,
  run_id TEXT,
  session_id TEXT,
  model TEXT,
  provider TEXT,
  coordinator TEXT,
  input_manifest_sha256 TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd REAL,
  created_at TEXT,
  updated_at TEXT,
  ended_at TEXT,
  superseded_by TEXT,
  review_json TEXT,
  files_json TEXT,
  holder TEXT
);
CREATE TABLE IF NOT EXISTS attempt_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT,
  kind TEXT,
  text TEXT,
  data_json TEXT,
  UNIQUE(attempt_id, seq)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  at TEXT,
  kind TEXT,
  level TEXT,
  message TEXT,
  attempt_id TEXT,
  task_id TEXT,
  needs_human INTEGER DEFAULT 0,
  disposition TEXT,
  data_json TEXT
);
CREATE TABLE IF NOT EXISTS launchers (
  node TEXT PRIMARY KEY,
  healthy INTEGER,
  version TEXT,
  model TEXT,
  concurrency_used INTEGER,
  concurrency_max INTEGER,
  queued INTEGER,
  detail TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS heartbeats (
  source TEXT PRIMARY KEY,
  kind TEXT,
  node TEXT,
  at TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  actor TEXT,
  created_at TEXT NOT NULL,
  leased_until TEXT,
  closed_at TEXT,
  result_json TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT,
  action TEXT,
  target TEXT,
  detail TEXT,
  intent_id TEXT
);
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  queue_depth INTEGER,
  in_flight INTEGER,
  running INTEGER,
  utilisation REAL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL
);
CREATE TABLE IF NOT EXISTS grok_snapshots (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_task ON task_history(task_id, id);
CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status, created_at);
`;

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec(SCHEMA);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() { this.db.close(); }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already closed */ }
      throw error;
    }
  }

  meta(key, value) {
    if (value === undefined) return this.db.prepare('SELECT v FROM meta WHERE k = ?').get(key)?.v ?? null;
    this.db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, String(value));
    return value;
  }

  taskCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM board_tasks').get().n;
  }

  upsertTasks(tasks, { source = 'orbit', actor = 'orbit' } = {}) {
    const now = new Date().toISOString();
    const find = this.db.prepare('SELECT * FROM board_tasks WHERE id = ? OR orbit_id = ?');
    const insert = this.db.prepare(`INSERT INTO board_tasks (
      id, orbit_id, group_id, group_name, project, title, spec, column_name, priority, owner, holder,
      file_scope, dependencies, summary, source, sync_state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = this.db.prepare(`UPDATE board_tasks SET
      orbit_id = ?, group_id = ?, group_name = ?, project = COALESCE(?, project), title = ?, spec = COALESCE(?, spec),
      column_name = ?, priority = COALESCE(?, priority), owner = ?, holder = COALESCE(?, holder),
      file_scope = COALESCE(?, file_scope), dependencies = COALESCE(?, dependencies), summary = ?,
      source = ?, sync_state = 'synced', updated_at = ?
      WHERE id = ?`);
    const hist = this.db.prepare('INSERT INTO task_history(task_id, at, column_name, note, actor) VALUES (?, ?, ?, ?, ?)');
    return this.tx(() => {
      const ids = [];
      for (const raw of tasks) {
        const column = toColumn(raw.column || raw.status) || 'todo';
        if (!COLUMNS.includes(column)) continue;
        const orbitId = raw.orbitId || raw.orbit_id || null;
        const existing = find.get(raw.id, raw.id) || (orbitId ? find.get(orbitId, orbitId) : null);
        const fileScope = raw.fileScope || raw.file_scope;
        const dependencies = raw.dependencies;
        const created = raw.createdAt || raw.created_at || existing?.created_at || now;
        const updated = raw.updatedAt || raw.updated_at || now;
        if (!existing) {
          const taskId = raw.id || id('t');
          insert.run(
            taskId, orbitId || raw.id || null, raw.groupId || raw.group_id || null, raw.groupName || raw.group_name || raw.group || null,
            raw.project || null, String(raw.title || 'Untitled').slice(0, 160), raw.spec ?? null, column,
            clampPriority(raw.priority), raw.owner || null, raw.holder || raw.owner || null,
            fileScope ? JSON.stringify(fileScope) : null,
            dependencies ? JSON.stringify(dependencies) : null,
            raw.summary || null, source, 'synced', created, updated,
          );
          hist.run(taskId, updated, column, raw.summary || 'imported', actor);
          if (Array.isArray(raw.history)) {
            for (const item of raw.history) {
              hist.run(taskId, item.at || updated, toColumn(item.column || item.status) || column, item.note || '', item.actor || actor);
            }
          }
          if (Array.isArray(raw.checkins)) {
            for (const item of raw.checkins) hist.run(taskId, item.at || updated, column, item.note || '', item.by || item.actor || actor);
          }
          ids.push(taskId);
        } else {
          const nextSpec = raw.spec == null || raw.spec === '' ? null : raw.spec;
          update.run(
            orbitId || existing.orbit_id, raw.groupId || raw.group_id || existing.group_id,
            raw.groupName || raw.group_name || raw.group || existing.group_name,
            raw.project ?? null, String(raw.title || existing.title).slice(0, 160), nextSpec, column,
            raw.priority == null ? null : clampPriority(raw.priority),
            raw.owner ?? existing.owner, raw.holder ?? null,
            fileScope ? JSON.stringify(fileScope) : null,
            dependencies ? JSON.stringify(dependencies) : null,
            raw.summary ?? existing.summary, source, updated, existing.id,
          );
          if (existing.column_name !== column || (raw.summary && raw.summary !== existing.summary)) {
            hist.run(existing.id, updated, column, raw.summary || `moved to ${column}`, actor);
          }
          if (Array.isArray(raw.checkins)) {
            for (const item of raw.checkins) {
              const note = item.note || '';
              const dup = this.db.prepare('SELECT 1 FROM task_history WHERE task_id = ? AND note = ? AND actor = ?').get(existing.id, note, item.by || item.actor || actor);
              if (!dup && note) hist.run(existing.id, item.at || updated, column, note, item.by || item.actor || actor);
            }
          }
          ids.push(existing.id);
        }
      }
      return ids;
    });
  }

  insertLocalTask(input, actor) {
    const now = new Date().toISOString();
    const taskId = id('cp');
    const column = 'todo';
    this.tx(() => {
      this.db.prepare(`INSERT INTO board_tasks (
        id, orbit_id, group_id, group_name, project, title, spec, column_name, priority, owner, holder,
        file_scope, dependencies, summary, source, sync_state, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'control-plane', 'pending', ?, ?)`).run(
        taskId, input.groupId || null, input.group || null, input.project || null, input.title, input.spec || '',
        column, input.priority, actor, null, JSON.stringify(input.fileScope || []), JSON.stringify(input.dependencies || []),
        'queued for Orbit', now, now,
      );
      this.db.prepare('INSERT INTO task_history(task_id, at, column_name, note, actor) VALUES (?, ?, ?, ?, ?)').run(
        taskId, now, column, 'queued from the control plane', actor,
      );
    });
    return this.getTask(taskId);
  }

  moveTask(taskId, column, actor, note) {
    if (!COLUMNS.includes(column)) {
      const error = new Error('column must be todo, doing, review, blocked, or done');
      error.status = 400;
      throw error;
    }
    const task = this.getTask(taskId);
    if (!task) {
      const error = new Error('unknown task');
      error.status = 404;
      throw error;
    }
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE board_tasks SET column_name = ?, sync_state = 'pending', summary = ?, updated_at = ? WHERE id = ?`).run(
      column, note || task.summary, now, task.id,
    );
    this.db.prepare('INSERT INTO task_history(task_id, at, column_name, note, actor) VALUES (?, ?, ?, ?, ?)').run(
      task.id, now, column, note || `move queued to ${column}`, actor,
    );
    return this.getTask(task.id);
  }

  setPriority(taskId, priority, actor) {
    const task = this.getTask(taskId);
    if (!task) {
      const error = new Error('unknown task');
      error.status = 404;
      throw error;
    }
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE board_tasks SET priority = ?, sync_state = 'pending', updated_at = ? WHERE id = ?`).run(priority, now, task.id);
    this.db.prepare('INSERT INTO task_history(task_id, at, column_name, note, actor) VALUES (?, ?, ?, ?, ?)').run(
      task.id, now, task.column, `priority set to P${priority}`, actor,
    );
    return this.getTask(task.id);
  }

  listTasks(filter = {}) {
    const rows = this.db.prepare('SELECT * FROM board_tasks ORDER BY priority ASC, updated_at DESC').all();
    return rows.map(presentTask).filter(task => {
      if (filter.group && task.groupName !== filter.group && task.groupId !== filter.group) return false;
      if (filter.column && task.column !== filter.column) return false;
      if (filter.owner && task.owner !== filter.owner) return false;
      if (filter.q) {
        const hay = `${task.title} ${task.spec} ${task.summary} ${task.project}`.toLowerCase();
        if (!hay.includes(filter.q.toLowerCase())) return false;
      }
      return true;
    });
  }

  getTask(taskId) {
    const row = this.db.prepare('SELECT * FROM board_tasks WHERE id = ? OR orbit_id = ?').get(taskId, taskId);
    if (!row) return null;
    const task = presentTask(row);
    task.history = this.db.prepare('SELECT at, column_name AS column, note, actor FROM task_history WHERE task_id = ? ORDER BY id').all(row.id);
    task.attempts = this.listAttempts().filter(item => item.taskId === row.id || item.taskId === row.orbit_id || item.boardEntry === row.orbit_id || item.boardEntry === row.id);
    return task;
  }

  markTaskSync(localId, { orbitId, syncState, summary }) {
    const sets = ['sync_state = ?', 'updated_at = ?'];
    const args = [syncState, new Date().toISOString()];
    if (orbitId) { sets.push('orbit_id = ?'); args.push(orbitId); }
    if (summary) { sets.push('summary = ?'); args.push(summary); }
    args.push(localId);
    this.db.prepare(`UPDATE board_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  upsertAttempts(attempts, { actor = 'orbit', restrictNode = undefined } = {}) {
    const now = new Date().toISOString();
    const get = this.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?');
    const insert = this.db.prepare(`INSERT INTO attempts (
      attempt_id, task_id, board_entry, group_id, group_name, generation, state, detail, node, sandbox, run_id,
      session_id, model, provider, coordinator, input_manifest_sha256, tokens_in, tokens_out, cost_usd,
      created_at, updated_at, ended_at, superseded_by, review_json, files_json, holder
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = this.db.prepare(`UPDATE attempts SET
      task_id = COALESCE(?, task_id), board_entry = COALESCE(?, board_entry), group_id = COALESCE(?, group_id),
      group_name = COALESCE(?, group_name), generation = COALESCE(?, generation), state = ?, detail = ?,
      node = ?, sandbox = COALESCE(?, sandbox), run_id = COALESCE(?, run_id), session_id = COALESCE(?, session_id),
      model = COALESCE(?, model), provider = COALESCE(?, provider), coordinator = COALESCE(?, coordinator),
      input_manifest_sha256 = COALESCE(?, input_manifest_sha256), tokens_in = ?, tokens_out = ?, cost_usd = COALESCE(?, cost_usd),
      updated_at = ?, ended_at = ?, superseded_by = COALESCE(?, superseded_by), review_json = COALESCE(?, review_json),
      files_json = COALESCE(?, files_json), holder = ?
      WHERE attempt_id = ?`);
    const touched = [];
    this.tx(() => {
      for (const raw of attempts) {
        const attemptId = String(raw.attemptId || raw.attempt_id || '');
        if (!attemptId) {
          const error = new Error('attempt id is required');
          error.status = 400;
          throw error;
        }
        const existing = get.get(attemptId);
        if (restrictNode !== undefined) {
          if (!existing) {
            const error = new Error(`workers can only update an assigned attempt (${attemptId})`);
            error.status = 409;
            throw error;
          }
          if (restrictNode && existing.node && existing.node !== restrictNode) {
            const error = new Error('attempt is assigned to another node');
            error.status = 403;
            throw error;
          }
          if (raw.node && existing.node && raw.node !== existing.node) {
            const error = new Error('workers cannot move an attempt to another node');
            error.status = 403;
            throw error;
          }
        }
        const state = String(raw.state || existing?.state || 'queued');
        const node = raw.node || existing?.node || null;
        const holder = raw.holder || (node ? `${node}${raw.sandbox || existing?.sandbox ? ' / ' + (raw.sandbox || existing?.sandbox) : ''}` : raw.coordinator || existing?.coordinator || null);
        const files = raw.files || raw.artifact_refs || raw.files_json;
        const review = raw.review;
        const ended = raw.endedAt || raw.ended_at || (isTerminalAttempt(state) ? (existing?.ended_at || now) : null);
        if (!existing) {
          if (restrictNode !== undefined) {
            const error = new Error(`workers can only update an assigned attempt (${attemptId})`);
            error.status = 409;
            throw error;
          }
          insert.run(
            attemptId, raw.taskId || raw.task_id || null, raw.boardEntry || raw.board_entry || raw.taskId || raw.task_id || null,
            raw.groupId || raw.group_id || null, raw.groupName || raw.group_name || raw.group || null,
            Number(raw.generation || 1), state, raw.detail || '', node, raw.sandbox || raw.env_id || null,
            raw.runId || raw.run_id || raw.cua_run_id || null, raw.sessionId || raw.session_id || raw.opencode_session_id || null,
            raw.model || null, raw.provider || null, raw.coordinator || null, raw.inputManifestSha256 || raw.input_manifest_sha256 || null,
            num(raw.tokensIn ?? raw.tokens_in), num(raw.tokensOut ?? raw.tokens_out), raw.costUsd ?? raw.cost_usd ?? null,
            raw.createdAt || raw.created_at || now, raw.updatedAt || raw.updated_at || now, ended,
            raw.supersededBy || raw.superseded_by || null,
            review ? JSON.stringify(review) : null, files ? JSON.stringify(files) : null, holder,
          );
        } else {
          const nextFiles = files ? JSON.stringify(files) : null;
          const nextReview = review ? JSON.stringify(review) : null;
          update.run(
            raw.taskId || raw.task_id || null, raw.boardEntry || raw.board_entry || null,
            raw.groupId || raw.group_id || null, raw.groupName || raw.group_name || raw.group || null,
            raw.generation ?? null, state, raw.detail ?? existing.detail, node,
            raw.sandbox || raw.env_id || null, raw.runId || raw.run_id || raw.cua_run_id || null,
            raw.sessionId || raw.session_id || raw.opencode_session_id || null,
            raw.model || null, raw.provider || null, raw.coordinator || null,
            raw.inputManifestSha256 || raw.input_manifest_sha256 || null,
            raw.tokensIn != null || raw.tokens_in != null ? num(raw.tokensIn ?? raw.tokens_in) : existing.tokens_in,
            raw.tokensOut != null || raw.tokens_out != null ? num(raw.tokensOut ?? raw.tokens_out) : existing.tokens_out,
            raw.costUsd ?? raw.cost_usd ?? null, raw.updatedAt || raw.updated_at || now, ended,
            raw.supersededBy || raw.superseded_by || null, nextReview, nextFiles, holder, attemptId,
          );
        }
        touched.push(attemptId);
      }
    });
    return touched;
  }

  listAttempts() {
    return this.db.prepare('SELECT * FROM attempts ORDER BY updated_at DESC').all().map(presentAttempt);
  }

  getAttempt(attemptId) {
    const row = this.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId);
    if (!row) return null;
    const attempt = presentAttempt(row);
    attempt.events = this.db.prepare('SELECT seq, at, kind, text, data_json FROM attempt_events WHERE attempt_id = ? ORDER BY seq').all(attemptId).map(event => {
      const data = parseJson(event.data_json, null);
      return {
        seq: event.seq,
        at: event.at,
        kind: event.kind,
        text: event.text,
        needsHuman: data?.needsHuman === true,
        disposition: data?.disposition || null,
        data,
      };
    });
    return attempt;
  }

  addAttemptEvents(attemptId, events, { restrictNode = undefined, source = 'worker' } = {}) {
    const attempt = this.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId);
    if (!attempt) {
      const error = new Error(`unknown attempt ${attemptId}`);
      error.status = restrictNode !== undefined ? 409 : 404;
      throw error;
    }
    if (restrictNode && attempt.node && attempt.node !== restrictNode) {
      const error = new Error('attempt is assigned to another node');
      error.status = 403;
      throw error;
    }
    const insert = this.db.prepare('INSERT OR IGNORE INTO attempt_events(attempt_id, seq, at, kind, text, data_json) VALUES (?, ?, ?, ?, ?, ?)');
    const feed = this.db.prepare(`INSERT INTO events(source, at, kind, level, message, attempt_id, task_id, needs_human, disposition, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let stored = 0;
    this.tx(() => {
      for (const event of events.map(normalizeApprovalEvent)) {
        const seq = Number(event.seq);
        if (!Number.isInteger(seq)) continue;
        const info = insert.run(attemptId, seq, event.at || new Date().toISOString(), event.kind || 'log', event.text || event.message || '', event.data ? JSON.stringify(event.data) : null);
        if (info.changes) {
          stored += 1;
          feed.run(source, event.at || new Date().toISOString(), event.kind || 'log', event.level || 'info', event.text || event.message || '', attemptId, attempt.task_id, event.needsHuman ? 1 : 0, event.disposition || null, event.data ? JSON.stringify(event.data) : null);
        }
      }
    });
    return stored;
  }

  addEvents(events, source) {
    const feed = this.db.prepare(`INSERT INTO events(source, at, kind, level, message, attempt_id, task_id, needs_human, disposition, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.tx(() => {
      for (const event of events.map(normalizeApprovalEvent)) {
        feed.run(source, event.at || new Date().toISOString(), event.kind || 'log', event.level || 'info', String(event.message || event.text || '').slice(0, 2000), event.attemptId || event.attempt_id || null, event.taskId || event.task_id || null, event.needsHuman ? 1 : 0, event.disposition || null, event.data ? JSON.stringify(event.data) : null);
      }
    });
  }

  listEvents(since = 0, limit = 200) {
    const rows = this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?').all(Number(since) || 0, Math.min(500, Number(limit) || 200));
    return rows.map(presentEvent);
  }

  upsertLaunchers(nodes) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`INSERT INTO launchers(node, healthy, version, model, concurrency_used, concurrency_max, queued, detail, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node) DO UPDATE SET
        healthy = excluded.healthy, version = excluded.version, model = excluded.model,
        concurrency_used = excluded.concurrency_used, concurrency_max = excluded.concurrency_max,
        queued = excluded.queued, detail = excluded.detail, updated_at = excluded.updated_at`);
    this.tx(() => {
      for (const node of nodes) {
        if (!node?.node) continue;
        stmt.run(String(node.node), node.healthy === false ? 0 : 1, node.version || null, node.model || null, num(node.concurrencyUsed ?? node.concurrency_used ?? node.active), num(node.concurrencyMax ?? node.concurrency_max ?? node.max_concurrent), num(node.queued), node.detail || '', node.updatedAt || now);
      }
    });
  }

  listLaunchers() {
    return this.db.prepare('SELECT * FROM launchers ORDER BY node').all().map(row => ({
      node: row.node,
      healthy: row.healthy === 1,
      version: row.version,
      model: row.model,
      concurrencyUsed: row.concurrency_used,
      concurrencyMax: row.concurrency_max,
      queued: row.queued,
      detail: row.detail,
      updatedAt: row.updated_at,
      desiredMax: numberOrNull(this.meta(`concurrency:${row.node}`)),
    }));
  }

  heartbeat({ source, kind, node, detail }) {
    this.db.prepare(`INSERT INTO heartbeats(source, kind, node, at, detail) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET kind = excluded.kind, node = excluded.node, at = excluded.at, detail = excluded.detail`).run(
      source, kind || 'heartbeat', node || null, new Date().toISOString(), detail || '',
    );
  }

  listHeartbeats() {
    return this.db.prepare('SELECT source, kind, node, at, detail FROM heartbeats ORDER BY at DESC').all();
  }

  enqueueIntent(type, payload, actor) {
    const now = new Date().toISOString();
    const intentId = id('int');
    this.db.prepare('INSERT INTO intents(id, type, payload_json, status, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      intentId, type, JSON.stringify(payload), 'queued', actor, now,
    );
    this.audit({ actor, action: type, target: payload.attemptId || payload.taskId || payload.localId || payload.node || '', detail: 'queued', intentId });
    return this.getIntent(intentId);
  }

  getIntent(intentId) {
    const row = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(intentId);
    return row ? presentIntent(row) : null;
  }

  listIntents(status) {
    const rows = status
      ? this.db.prepare('SELECT * FROM intents WHERE status = ? ORDER BY created_at DESC').all(status)
      : this.db.prepare('SELECT * FROM intents ORDER BY created_at DESC LIMIT 200').all();
    return rows.map(presentIntent);
  }

  leaseIntents(limit, leaseMs, now = Date.now()) {
    const iso = new Date(now).toISOString();
    const until = new Date(now + leaseMs).toISOString();
    return this.tx(() => {
      this.db.prepare(`UPDATE intents SET status = 'queued', leased_until = NULL WHERE status = 'leased' AND leased_until IS NOT NULL AND leased_until < ?`).run(iso);
      const rows = this.db.prepare(`SELECT * FROM intents WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`).all(limit);
      const update = this.db.prepare(`UPDATE intents SET status = 'leased', leased_until = ? WHERE id = ? AND status = 'queued'`);
      const leased = [];
      for (const row of rows) {
        if (update.run(until, row.id).changes === 1) leased.push(presentIntent({ ...row, status: 'leased', leased_until: until }));
      }
      return leased;
    });
  }

  finishIntent(intentId, { outcome, detail, result, actor }) {
    const row = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(intentId);
    if (!row) {
      const error = new Error('unknown intent');
      error.status = 404;
      throw error;
    }
    if (['applied', 'rejected', 'deferred'].includes(row.status)) return presentIntent(row);
    if (!['leased', 'queued'].includes(row.status)) {
      const error = new Error('intent is not open');
      error.status = 409;
      throw error;
    }
    const status = outcome === 'applied' || outcome === 'rejected' || outcome === 'deferred' ? outcome : null;
    if (!status) {
      const error = new Error('outcome must be applied, rejected, or deferred');
      error.status = 400;
      throw error;
    }
    const now = new Date().toISOString();
    this.db.prepare('UPDATE intents SET status = ?, closed_at = ?, result_json = ?, leased_until = NULL WHERE id = ?').run(
      status, now, JSON.stringify({ detail: detail || '', result: result ?? null }), intentId,
    );
    const payload = parseJson(row.payload_json, {});
    if (row.type === 'task.create' && payload.localId) {
      const entryId = result?.entry?.id || result?.entryId || null;
      this.markTaskSync(payload.localId, {
        orbitId: entryId,
        syncState: status === 'applied' ? 'synced' : status,
        summary: status === 'applied' ? 'Orbit accepted the task' : `Orbit ${status}`,
      });
    }
    if ((row.type === 'task.move' || row.type === 'task.priority') && payload.taskId && status === 'applied') {
      this.markTaskSync(payload.taskId, { syncState: 'synced' });
    }
    this.audit({ actor: actor || 'orbit', action: `${row.type}.${status}`, target: payload.attemptId || payload.taskId || payload.localId || '', detail: detail || status, intentId });
    return this.getIntent(intentId);
  }

  audit({ actor, action, target, detail, intentId }) {
    this.db.prepare('INSERT INTO audit(at, actor, action, target, detail, intent_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      new Date().toISOString(), actor || 'system', action, target || '', String(detail || '').slice(0, 500), intentId || null,
    );
  }

  listAudit(limit = 100) {
    return this.db.prepare('SELECT id, at, actor, action, target, detail, intent_id AS intentId FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(500, limit));
  }

  setPaused(paused, actor) {
    this.meta('dispatch_paused', paused ? '1' : '0');
    this.audit({ actor, action: paused ? 'dispatch.pause' : 'dispatch.resume', target: 'dispatch', detail: paused ? 'pause queued' : 'resume queued' });
  }

  isPaused() {
    return this.meta('dispatch_paused') === '1';
  }

  setDesiredConcurrency(node, max, actor) {
    this.meta(`concurrency:${node}`, String(max));
    this.audit({ actor, action: 'launcher.concurrency', target: node, detail: `desired max ${max}` });
  }

  saveGrok(snapshots) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`INSERT INTO grok_snapshots(key, json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`);
    this.tx(() => {
      for (const [key, value] of Object.entries(snapshots)) {
        stmt.run(key, JSON.stringify(value), now);
      }
    });
  }

  readGrok(key) {
    const row = this.db.prepare('SELECT json, updated_at FROM grok_snapshots WHERE key = ?').get(key);
    if (!row) return null;
    return { data: parseJson(row.json, null), updatedAt: row.updated_at };
  }

  recordSample(sample) {
    this.db.prepare(`INSERT INTO samples(at, queue_depth, in_flight, running, utilisation, tokens_in, tokens_out, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sample.at || new Date().toISOString(), num(sample.queueDepth), num(sample.inFlight), num(sample.running),
      sample.utilisation ?? null, num(sample.tokensIn), num(sample.tokensOut), sample.costUsd ?? null,
    );
  }

  listSamples() {
    return this.db.prepare('SELECT at, queue_depth AS queueDepth, in_flight AS inFlight, running, utilisation, tokens_in AS tokensIn, tokens_out AS tokensOut, cost_usd AS costUsd FROM samples ORDER BY at').all();
  }

  counts() {
    const rows = this.db.prepare('SELECT column_name, COUNT(*) AS n FROM board_tasks GROUP BY column_name').all();
    const counts = Object.fromEntries(COLUMNS.map(column => [column, 0]));
    for (const row of rows) counts[row.column_name] = row.n;
    return counts;
  }
}

function clampPriority(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function presentTask(row) {
  return {
    id: row.id,
    orbitId: row.orbit_id,
    groupId: row.group_id,
    groupName: row.group_name,
    project: row.project,
    title: row.title,
    spec: row.spec || '',
    column: row.column_name,
    priority: row.priority,
    owner: row.owner,
    holder: row.holder,
    fileScope: parseJson(row.file_scope, []),
    dependencies: parseJson(row.dependencies, []),
    summary: row.summary || '',
    source: row.source,
    syncState: row.sync_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function presentAttempt(row) {
  return {
    attemptId: row.attempt_id,
    taskId: row.task_id,
    boardEntry: row.board_entry,
    groupId: row.group_id,
    groupName: row.group_name,
    generation: row.generation,
    state: row.state,
    detail: row.detail || '',
    node: row.node,
    sandbox: row.sandbox,
    runId: row.run_id,
    sessionId: row.session_id,
    model: row.model,
    provider: row.provider,
    coordinator: row.coordinator,
    inputManifestSha256: row.input_manifest_sha256,
    tokensIn: row.tokens_in || 0,
    tokensOut: row.tokens_out || 0,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    supersededBy: row.superseded_by,
    review: parseJson(row.review_json, null),
    files: parseJson(row.files_json, []),
    holder: row.holder,
    inFlight: !isTerminalAttempt(row.state),
  };
}

function presentEvent(row) {
  return {
    id: row.id,
    source: row.source,
    at: row.at,
    kind: row.kind,
    level: row.level,
    message: row.message,
    attemptId: row.attempt_id,
    taskId: row.task_id,
    needsHuman: row.needs_human === 1,
    disposition: row.disposition,
    data: parseJson(row.data_json, null),
  };
}

function presentIntent(row) {
  return {
    id: row.id,
    type: row.type,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    actor: row.actor,
    createdAt: row.created_at,
    leasedUntil: row.leased_until,
    closedAt: row.closed_at,
    result: parseJson(row.result_json, null),
  };
}

export { id };
