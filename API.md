# API

Base URL is the control plane. Unless noted, viewer routes accept a session cookie, a viewer bearer token, or (when enabled) a loopback `Tailscale-User-Login`. Ingest routes accept only an `orbit` or `worker` bearer token. Responses are JSON. Errors are `{ "error": "..." }` and do not contain tokens.

`GET /healthz` is unauthenticated: `{ "ok": true, "demo": false, "connector": false }`.

## Viewer

| Method | Path | Body / query | Result |
| --- | --- | --- | --- |
| POST | `/api/v1/session` | `{ "token" }` | Sets cookie `ocp`. |
| DELETE | `/api/v1/session` | | Clears the cookie. |
| GET | `/api/v1/me` | | Actor, demo flag, connector, dispatch pause. |
| GET | `/api/v1/stream` | | SSE. Events: `update`, `connector`. |
| GET | `/api/v1/overview` | | Counts, in-flight attempts, launchers, heartbeats. |
| GET | `/api/v1/board` | `group`, `q`, `owner`, `column` | `{ columns, tasks, paused }`. |
| GET | `/api/v1/board/tasks/:id` | | Task, history, linked attempts. |
| GET | `/api/v1/attempts` | | All attempts. |
| GET | `/api/v1/attempts/:id` | | Attempt, files, events. |
| GET | `/api/v1/events` | `since`, `limit` | Live event feed. |
| GET | `/api/v1/launchers` | | Per-node health and caps. |
| GET | `/api/v1/stats` | | Rates, cycle time, models, samples, throughput. |
| GET | `/api/v1/intents` | `status` | Queue for the UI. Does not lease. |
| GET | `/api/v1/audit` | | Audit log. |
| GET | `/api/v1/colab` | | Google Colab runs: `{ runs: [{ runId, updatedAt, active, updates, gauges: [{ job, stage, label, n, total, rate, eta, ts, state, current }] }] }`. SSE event `colab` on change. |
| POST | `/api/v1/grok` | Grok Bots body | Proxied, cached, or `{ "queued": true, "intentId" }`. |

Grok bodies match Orbit's `POST /api/grokbots-app`: `{ "action": "agents" }`, `{ "action": "groups", "op": "list" }`, `{ "action": "groups", "op": "state", "group" }`, `{ "action": "groups", "op": "post", "group", "text" }`, `{ "action": "history", "profile", "agent" }`, `{ "action": "activity", "profile", "agent" }`, `{ "action": "controls", ... }`.

## Control

All return `202` and an `intent`.

| Path | Body |
| --- | --- |
| `POST /api/v1/control/tasks` | `title`, `spec`, `project`, `group`, `fileScope`, `priority` (1–5), `dependencies` |
| `POST /api/v1/control/tasks/:id/move` | `column` (`todo` `doing` `review` `blocked` `done`), `note` |
| `POST /api/v1/control/tasks/:id/priority` | `priority` |
| `POST /api/v1/control/attempts/:id/cancel` | `{}` |
| `POST /api/v1/control/attempts/:id/retry` | `{}` |
| `POST /api/v1/control/attempts/:id/review` | `accepted` boolean, `note` |
| `POST /api/v1/control/dispatch` | `paused` boolean |
| `POST /api/v1/control/concurrency` | `node`, `max` (1–6) |

File scope entries are relative paths without `..`.

## Ingest

`Authorization: Bearer <source token>`.

| Path | Who | Body |
| --- | --- | --- |
| `POST /api/v1/ingest/heartbeat` | orbit, worker | `{ kind, node, detail }` |
| `POST /api/v1/ingest/board` | orbit | `{ groups: [{ id, name, project, tasks: [...] }] }` |
| `POST /api/v1/ingest/attempts` | orbit creates; worker updates an assigned attempt | `{ attempts: [{ attemptId, state, node, sandbox, runId, model, tokensIn, tokensOut, costUsd, files }] }` |
| `POST /api/v1/ingest/events` | orbit; worker only with `attemptId` and `seq` | `{ events: [{ attemptId, seq, kind, text, data }] }` |
| `POST /api/v1/ingest/launchers` | orbit | `{ nodes: [{ node, healthy, version, model, concurrencyUsed, concurrencyMax, queued }] }` |
| `POST /api/v1/ingest/grok` | orbit | `{ snapshots: { roster, groups, ... } }` |
| `POST /api/v1/ingest/colab` | orbit, worker | `{ runs: [...] }` (≤30), as `GET /api/v1/colab`. The connector reads Comfyrizz's gauge files from `ORBIT_CP_COLAB_PROGRESS_DIR` (default `~/.comfyrizz/colab-progress`) every `ORBIT_CP_COLAB_POLL_MS` (1500) and posts on change. |
| `GET /api/v1/ingest/intents?limit=` | orbit | Leases up to 50 queued intents. |
| `POST /api/v1/ingest/intents/:id/result` | orbit | `{ outcome: "applied"\|"rejected"\|"deferred", detail, result }` |

Task `status` on ingest may be a column or an Orbit collab status (`submitted`, `working`, `review`, `completed`, `input-required`).

Attempt `files[]`: `{ path, sha256, change, in_scope }`.

Worker events whose kind or payload is an ACP/Cua auto-approval are stored with `needsHuman: false` and `disposition: "auto_approved"` even if the sender said `pending`. A `local-tool-permission` or `auto-review-approval` that is actually pending stays `needs_human`.

## Connector WebSocket

`GET /api/v1/connector` with the orbit bearer, upgraded to WebSocket.

Server to connector:

```json
{ "type": "rpc", "id": "…", "body": { "action": "grokbots", "body": { "action": "history", "profile": "…", "agent": "…" } } }
```

Connector to server:

```json
{ "type": "rpc-result", "id": "…", "ok": true, "data": {} }
```

## Intent payloads the connector understands

| Type | Orbit call |
| --- | --- |
| `task.create` | `POST /api/collab-board` `op: new`, posted as `local-workers` |
| `task.move` | `op: update` with the column |
| `task.priority` | note on the entry, then `deferred` (no priority field) |
| `attempt.cancel` | `POST /api/local-workers` `op: cancel` |
| `attempt.retry` | `op: create` using the brief in `local-workers/ledger.json` |
| `attempt.review` | `op: review` |
| `dispatch.pause` | writes `control-plane/dispatch.json`, `deferred` |
| `launcher.concurrency` | writes `control-plane/concurrency.json`, `deferred` |
| `grok.action` | `POST /api/grokbots-app` |
