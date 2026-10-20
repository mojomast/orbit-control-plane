# Orbit hooks

The connector uses APIs that already exist on `127.0.0.1:4318`. Nothing in this repo patches Orbit. These are the gaps.

## Already works with no Orbit change

| Control-plane action | How the connector applies it |
| --- | --- |
| Board snapshot | `POST /api/collab-board` `{ op: "list", group }` with `collab-board.key`. Group ids come from `POST /api/grokbots-app` `{ action: "groups", op: "list" }` with `grokbots-app.key` and no `Origin` header (Orbit allows a missing Origin on that route). |
| Create task | `op: "new"`, `by: "local-workers"` (a `SYSTEM_POSTERS` id). Spec text includes project, priority, file scope, and dependencies because the board entry has a single spec string. |
| Move column | `op: "update"` with `todo` / `doing` / `review` / `done` / `blocked`. |
| Attempt list | `POST /api/local-workers` `{ op: "list" }`. Requires Orbit to be started with `ORBIT_LOCAL_WORKERS=1`. That env flag is operational, not a code change. |
| Cancel, review | `op: "cancel"`, `op: "review"`. |
| Retry | `op: "create"` with the brief read from `~/.orbit-runtime/local-workers/ledger.json`. The list API strips `brief`. |
| Grok Bots chat | WebSocket RPC to `POST /api/grokbots-app`. Agents keep running inside Orbit. |

Column words on the wire from `collab-board list` are Orbit's internal statuses (`submitted`, `working`, `review`, `completed`, `input-required`). The connector maps them before the push.

## Proposed hooks

### 1. Dispatch pause

`local-workers.mjs` `pump()` always dispatches while a slot is free. The connector writes:

```json
// ~/.orbit-runtime/control-plane/dispatch.json
{ "paused": true, "at": "2026-10-20T17:00:00.000Z" }
```

Proposed change: at the top of `pump()`, if that file says `paused: true`, return without calling `dispatch`. Cancel and review must still run. The intent stays `deferred` until Orbit reads the file.

### 2. Concurrency cap

Both the adapter (`ORBIT_LOCAL_WORKERS_MAX`, clamped 1..6) and the PC launcher (`max_concurrent` in `%USERPROFILE%\.orbit-launcher\config.json`) have caps, and neither has a set API. The connector writes:

```json
// ~/.orbit-runtime/control-plane/concurrency.json
{ "nodes": { "brrrrrrrr": 2 } }
```

Proposed change: the adapter reloads `maxConcurrent` from this file on each tick, and the launcher gains `POST /v1/config` `{ "max_concurrent": N }` authenticated with the existing launcher bearer. Until both exist, the control plane shows the desired cap and the intent stays `deferred`.

### 3. Richer board entries

`collab-board` `list` returns `id`, `title`, `status`, `owner`, `summary`, and three check-ins. It does not return spec, priority, file scope, dependencies, or full history.

Proposed `op: "get"` (same loopback key) returning the task record plus `events` from the collab project. The control plane already keeps those fields for tasks it created.

### 4. Priority

There is no priority column. The connector appends `priority P2 from the control plane` as a note and marks the intent deferred. A real field would let a later scheduler sort `queued` attempts.

## Install the sidecar

Copy `connector/orbit-connector.mjs` and this repo's `src/columns.mjs` plus `src/redact.mjs` onto the Orbit host (the connector imports those two). Point `ORBIT_CP_URL` at the control plane over Tailscale and `ORBIT_CP_TOKEN_FILE` at the orbit token. See `deploy/orbit-connector.service`.

Do not put the control-plane process on the Orbit box unless that box is the one Kyle opens. The design assumes the dashboard is the remote host and Orbit stays on loopback.
