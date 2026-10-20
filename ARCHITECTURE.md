# Architecture

Orbit Control Plane is one Node 22 process. It serves the dashboard, stores a read model in SQLite, accepts pushes from Orbit and from workers, and holds an intent queue Orbit's connector applies.

```
Kyle (browser, Tailscale)
        │  cookie or Tailscale-User-Login
        ▼
Orbit Control Plane  :8787
        ▲  bearer (orbit / worker_<node>)
        │  SSE to the browser, WebSocket from the connector
        │
Orbit host sidecar (connector/orbit-connector.mjs)
        │  127.0.0.1:4318  collab-board.key, grokbots-app.key
        ▼
Orbit  /api/collab-board  /api/local-workers  /api/grokbots-app
        │
        └── Tailscale ── PC launcher (OpenCode in a Cua sandbox)
```

## Modules

| File | Role |
| --- | --- |
| `src/server.mjs` | HTTP routes, static files, process entry |
| `src/db.mjs` | SQLite schema and the read model |
| `src/auth.mjs` | Bearer compare, Tailscale identity, session cookie |
| `src/ingest.mjs` | Snapshot and event intake, including worker scope checks |
| `src/control.mjs` | Validates Kyle's actions and enqueues intents |
| `src/intents` via `db.mjs` | Lease, expire, and idempotent close |
| `src/approvals.mjs` | Splits auto-approved sandbox events from human decisions |
| `src/grok.mjs` | Proxies Grok Bots calls over the connector socket, with a cache |
| `src/hub.mjs` / `src/ws.mjs` | One Orbit WebSocket for live proxy calls |
| `src/stats.mjs` | Rates, cycle time, per-model tokens, samples |
| `connector/orbit-connector.mjs` | Sidecar. Not imported by Orbit. |

The UI is `public/` with no build step. Charts are inline SVG.

## Read model

Board columns are `todo`, `doing`, `review`, `blocked`, `done`. Ingest accepts Orbit's internal words (`submitted`, `working`, `completed`, `input-required`) and stores the column name. Collab board `list` only returns id, title, status, owner, summary, and the last check-ins, so spec, priority, file scope, and dependencies are kept for tasks created here and are not overwritten by an empty snapshot field.

Attempt states follow `server/local-workers.mjs`: `queued`, `launcher_queued`, `running`, `disconnected`, `cancel_requested`, `outcome_unknown`, `not_started`, `succeeded`, `failed`, `cancelled`, `superseded`, plus the adapter's `accepted` and `rejected`. A worker token may update an attempt Orbit already stored, and only if the token's node matches `attempts.node`. Workers do not create attempts, move the board, or submit reviews.

## Intents

Control actions do not call Orbit. They write a row in `intents` and, where it helps the UI, an optimistic local change marked `pending`. The connector `GET /api/v1/ingest/intents` leases a batch. A second pull skips unexpired leases. Expired leases return to `queued`. `POST .../result` with `applied`, `rejected`, or `deferred` is idempotent.

`deferred` means the connector wrote the desired state under `~/.orbit-runtime/control-plane/` and Orbit has no API that applies it yet. See [docs/ORBIT_HOOKS.md](docs/ORBIT_HOOKS.md).

## Grok Bots

The dashboard does not run agents. A send, a history read, or an approval posts to `/api/v1/grok`. If the connector socket is up, the server forwards the body to Orbit's `POST /api/grokbots-app` and returns the redacted JSON. If it is down, reads come from the last snapshot and writes become `grok.action` intents. Approval cards with a Cua or ACP auto-approve signal are labeled auto-approved and are not given decision buttons.

## Live updates

The browser uses `GET /api/v1/stream` (SSE). The connector uses a WebSocket because chat needs a round trip, not just a push.

## What stays on the Orbit host

The collab-board key, the Grok Bots app key, the launcher token, and provider keys never leave the Orbit host. The connector scrubs its own secrets before a payload is pushed. The control plane scrubs its own tokens again on the way into SQLite and logs.
