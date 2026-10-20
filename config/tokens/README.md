# Token files

Put one token per file in this directory (or in `/etc/orbit-control-plane/tokens` on the host). The file name is the source id. Mode `0600`. Never commit the files.

| File | Role |
| --- | --- |
| `orbit.token` | Orbit connector. May push every snapshot and pull intents. |
| `viewer.token` | Browser session. Leave this unset when Tailscale Serve identity is the only user login. |
| `worker.token` | A worker that may update any attempt Orbit has already assigned. |
| `worker_<node>.token` | A worker bound to one launcher node, for example `worker_brrrrrrrr.token`. |

Each token is at least 16 characters of random data (`openssl rand -hex 32`). The server never writes these values into SQLite, the UI, or logs.
