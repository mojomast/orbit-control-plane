# Orbit Control Plane

A standalone dashboard for Orbit's orchestration. It shows the collab board, Grok Bots rooms, and local OpenCode workers, and it queues the changes Kyle wants Orbit to apply. Orbit and the workers push state in. The connector on the Orbit host pulls the intent queue and applies it through Orbit's existing loopback APIs.

This repo does not modify Orbit. The connector is a sidecar. Hooks Orbit does not have yet are listed in [docs/ORBIT_HOOKS.md](docs/ORBIT_HOOKS.md).

## Quick start

Node.js 22.13 or newer. No npm install; the server uses the built-in SQLite module.

```sh
mkdir -p config/tokens data
openssl rand -hex 32 > config/tokens/orbit.token
openssl rand -hex 32 > config/tokens/viewer.token
chmod 600 config/tokens/*.token
ORBIT_CP_BIND=127.0.0.1 ORBIT_CP_TOKEN_DIR=./config/tokens npm start
```

Open `http://127.0.0.1:8787` and paste the viewer token once. It is stored in an HttpOnly cookie and is not shown again.

Demo mode seeds every panel and skips the login. Do not use it on a reachable interface.

```sh
npm run demo
```

Tests:

```sh
npm test
```

## Tailscale

By default the process binds the host's Tailscale IPv4 address (`tailscale ip -4`). If Tailscale is not installed it binds `127.0.0.1`. Set `ORBIT_CP_BIND` to override. It does not bind `0.0.0.0` unless `ORBIT_CP_DOCKER=1` and no address was chosen.

Two ways to sign in:

1. Viewer bearer token, exchanged for a cookie at `POST /api/v1/session`.
2. Tailscale Serve identity. Terminate TLS on the tailnet and proxy to loopback:

```sh
# /etc/orbit-control-plane/env
ORBIT_CP_BIND=127.0.0.1
ORBIT_CP_TRUST_TAILSCALE=1
ORBIT_CP_TAILSCALE_USERS=kyle@example.com
ORBIT_CP_COOKIE_SECURE=1
```

```sh
tailscale serve --bg 8787
```

`Tailscale-User-Login` is honored only from a loopback peer, which is how `tailscale serve` connects. A client that hits the Tailscale IP directly cannot spoof that header. Leave `viewer.token` unset if Serve is the only login you want.

Ingest from Orbit and from workers always uses a per-source bearer token, even when Serve is on.

## Connector

Run this on the Orbit host, not on the control-plane host. It reads `~/.orbit-runtime/collab-board.key` and `grokbots-app.key`, talks to `127.0.0.1:4318`, and pushes to the control plane over Tailscale.

```sh
# /etc/orbit-control-plane/connector.env
ORBIT_CP_URL=http://100.x.x.x:8787
ORBIT_CP_TOKEN_FILE=/etc/orbit-control-plane/tokens/orbit.token
ORBIT_URL=http://127.0.0.1:4318
ORBIT_RUNTIME_DIR=/home/kyle/.orbit-runtime
ORBIT_LOCAL_WORKERS=1
```

`ORBIT_LOCAL_WORKERS=1` is Orbit's own switch; the connector only reads `/api/local-workers` when that route is mounted. Optional launcher health:

```sh
ORBIT_LOCAL_WORKERS_URL=http://100.120.158.68:47821
ORBIT_LOCAL_WORKERS_TOKEN_FILE=/home/kyle/.orbit-runtime/local-workers/brrrrrrrr.token
ORBIT_LOCAL_WORKERS_NODE=brrrrrrrr
```

```sh
npm run connector
```

## systemd and Docker

```sh
sudo useradd --system --home /var/lib/orbit-control-plane --shell /usr/sbin/nologin orbitcp
sudo mkdir -p /opt/orbit-control-plane /etc/orbit-control-plane/tokens /var/lib/orbit-control-plane
sudo cp -a src public connector package.json /opt/orbit-control-plane/
sudo cp deploy/env.example /etc/orbit-control-plane/env
sudo cp deploy/orbit-control-plane.service /etc/systemd/system/
sudo systemctl enable --now orbit-control-plane
```

The connector unit is `deploy/orbit-connector.service`. Install it on the Orbit host.

Docker uses host networking so the process can bind the Tailscale address:

```sh
ORBIT_CP_BIND=100.x.x.x docker compose up --build
```

## Config

| Variable | Meaning |
| --- | --- |
| `ORBIT_CP_BIND` | Listen address. Default: Tailscale IPv4, else `127.0.0.1`. |
| `ORBIT_CP_PORT` | Default `8787`. |
| `ORBIT_CP_DATA` | SQLite directory. Default `./data`. |
| `ORBIT_CP_TOKEN_DIR` | Directory of `*.token` files. |
| `ORBIT_CP_TOKEN_ORBIT` / `_WORKER` / `_VIEWER` | Inline tokens. Prefer files. |
| `ORBIT_CP_TOKEN_FILE_*` | A single token file for that source. |
| `ORBIT_CP_TRUST_TAILSCALE` | Honor `Tailscale-User-Login` from loopback. |
| `ORBIT_CP_TAILSCALE_USERS` | Comma-separated allowlist. Empty means any login. |
| `ORBIT_CP_DEMO` | Seed data and skip viewer login. |
| `ORBIT_CP_INTENT_LEASE_MS` | How long a pulled intent stays leased. Default 30s. |

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [API.md](API.md)
- [SECURITY.md](SECURITY.md)
- [docs/ORBIT_HOOKS.md](docs/ORBIT_HOOKS.md)
- [docs/ROLLBACK.md](docs/ROLLBACK.md)
