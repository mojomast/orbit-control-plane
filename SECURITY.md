# Security

The control plane can queue work that Orbit will run. Treat the host like the Orbit box.

## Network

- Default bind is the Tailscale IPv4 address, or `127.0.0.1` when that address is missing.
- `0.0.0.0` is used only when `ORBIT_CP_DOCKER=1` and neither `ORBIT_CP_BIND` nor a Tailscale address is set. Prefer host networking plus an explicit Tailscale bind.
- Do not publish port 8787 on a public interface. Demo mode (`ORBIT_CP_DEMO=1`) disables viewer login and must stay on loopback.

## Tokens

- Per-source bearers live in files (`ORBIT_CP_TOKEN_DIR`, mode `0600`) or in env vars. They are compared in constant time.
- Tokens are not written to SQLite, audit rows, HTTP bodies, or logs. Log lines pass through a redactor that also strips `Bearer` values and common key prefixes.
- `orbit` may push every snapshot and pull intents. `worker_<node>` may update only attempts whose stored node matches. A worker cannot create an attempt, edit the board, pull intents, or file a review.
- The viewer token is equivalent to a logged-in user. Do not set one if Tailscale Serve is the login you want.
- The connector's copy of the collab-board key, Grok Bots key, and launcher token stays on the Orbit host. Those values are not part of the push body.

## Tailscale Serve

`ORBIT_CP_TRUST_TAILSCALE=1` reads `Tailscale-User-Login` and `Tailscale-User-Name`. The headers are accepted only when the TCP peer is loopback (`127.0.0.1`, `::1`, or `::ffff:127.0.0.1`), which is the path `tailscale serve` uses. A packet that arrives on the Tailscale IP with a forged header is ignored. Optional `ORBIT_CP_TAILSCALE_USERS` is an allowlist.

## Browser

- Session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` when `ORBIT_CP_COOKIE_SECURE=1`.
- Pages send `Content-Security-Policy` with `default-src 'self'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- The UI builds the DOM with text nodes. Task titles and chat text are not parsed as HTML.

## Approvals

Cua auto-approves ACP permissions inside the sandbox. Those events are stored and shown as auto-approved. They do not render as a decision Kyle still owes. A Grok local-tool or auto-review card that is genuinely pending still does.

## Data

SQLite lives in `ORBIT_CP_DATA` (default `./data`, gitignored). It holds board text, attempt metadata, token counts, file paths, and sha256 digests. It does not hold provider keys. Wipe the directory to drop the read model; Orbit's ledger is untouched.

## Limits

JSON bodies are capped (about 1.5 MB on ingest, smaller on control routes). Event and attempt batches are capped at 500 rows. Intent leases expire so a crashed connector does not swallow the queue.
