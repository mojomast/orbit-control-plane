# Rollback and uninstall

The control plane does not own Orbit's ledger, board, or launcher. Removing it does not stop workers that are already running.

## Stop the dashboard

systemd:

```sh
sudo systemctl disable --now orbit-control-plane
sudo rm /etc/systemd/system/orbit-control-plane.service
sudo systemctl daemon-reload
```

Docker:

```sh
docker compose down
docker volume rm orbit-control-plane_control-plane-data
```

The SQLite file is `ORBIT_CP_DATA/control-plane.sqlite` (and `-wal` / `-shm`). Delete that directory to drop the read model, intents, and audit log. Tokens in `/etc/orbit-control-plane/tokens` are separate; shred them if you are retiring the host.

## Stop the connector

On the Orbit host:

```sh
sudo systemctl disable --now orbit-connector
```

In-flight intents that were leased return to `queued` after `ORBIT_CP_INTENT_LEASE_MS` if the control plane is still up. If you are deleting the control plane too, nothing will apply them.

Hook files the connector may have written:

```sh
rm -rf ~/.orbit-runtime/control-plane
```

Orbit does not read those files until the hooks in [ORBIT_HOOKS.md](ORBIT_HOOKS.md) exist, so deleting them changes nothing Orbit is doing today.

## What this does not undo

- Board entries the connector already created through `/api/collab-board` stay on the Orbit board. Move or delete them from Orbit.
- Cancels and reviews already posted to `/api/local-workers` stay in Orbit's ledger.
- Sandboxes on the PC stay up until `pc-launcher/scripts/stop.ps1` and the cleanup script in Orbit's `docs/LOCAL_WORKERS.md`.
- Grok Bots messages already sent through the proxy are in Orbit's transcripts.

## Code rollback

This repo is only the control plane. Revert its branch. Orbit's branch `integ/live-tree-oct14` is unchanged by this project.
