# Live observability for Hermes chat (design)

Goal: ask Hermes "how is the hive doing?" and get a real, redacted card (bees in
flight, tokens and spend per provider, failures and blockers, board stats,
resources) drawn by uirizz.

## Constraint that shapes the design

uirizz promises no network, no credentials, no `requires_env`, no subprocesses at
runtime, and no hooks beyond its two. So live data cannot be fetched inside
uirizz, and uirizz is left untouched. The data path is split into three small,
independent pieces:

```
Orbit (loopback)  gh (read-only)  box stats
        \              |            /
   scripts/obs-snapshot.mjs   <- collector: has the credentials, no model access
              |   writes redacted JSON (mode 0600), atomic rename
   <hermes plugin-data>/rizzobs/snapshot.json
              |
   rizzobs plugin: tool rizz_observability(view)   <- no network/creds/subprocess/hooks
              |   returns Express + fallback_text
   Hermes model --> uirizz a2ui_render (present / update)  <- unchanged
```

1. **Collector** (`src/observability.mjs`, `src/obs-collect.mjs`, `scripts/obs-snapshot.mjs`).
   Pure builder plus thin collectors. It reads Orbit's `local-workers` list over
   loopback (the Orbit key is read from a file and sent only to a loopback URL),
   per-attempt result files for token usage, `gh` for PRs, commits and red CI on
   `main`, and `node:os` for load, memory and disk. `gh` runs with an argv array,
   never a shell, with a timeout and a minimal environment.
2. **Snapshot** (`rizzstack.observability/chat-card/1`). Counts, short ids (`bee-1a2b`), repo
   and check names, percentages. Every string is passed through `sanitizeText`:
   IPs, hostnames, e-mails, key-shaped strings, paths, control characters and
   `${` are removed; lengths are capped. Orbit node names are dropped, and
   attempt ids are reduced to four hex characters. Unknown fields are never
   copied (the builder allow-lists).
3. **Plugin `rizzobs`** (`hermes-plugin/rizzobs`). One tool, `rizz_observability(view)`.
   It reads only `snapshot.json` from its plugin data directory (refuses
   symlinks, files over 256 KiB and other schemas), coerces every value, and
   emits Express in which text is only ever a JSON-escaped string literal. No
   buttons, images or links, so a card click can never trigger anything.

## Data sources

| Card | Source | Notes |
| --- | --- | --- |
| Bees in flight | Orbit `local-workers` list (`state`, `cap`) | In flight = running, starting, backoff, disconnected, cancel requested. Queue = queued, launcher_queued. |
| Tokens and spend | per-attempt result files (`usage`) | Provider from the model id: `go:` or bare `deepseek-*` is OpenCode Go, `deepseek:` is DeepSeek, `openrouter` is OpenRouter. Cost is `null` (shown `n/a`) unless a rate file is passed with `--rates`; spend is never guessed. |
| Failures and blockers | Orbit attempts + `gh run list` | Failed = failed, not_started, rejected, outcome_unknown. "Awaiting review" = succeeded, not yet accepted. CI red = the latest finished run of a workflow on `main` failed. |
| Board stats | `gh pr list`, `gh api commits` | Six repos: workflow, bundlebees, hyvv, orbitdesktop, orbit-control-plane, uirizz. A repo that errors is listed as skipped. |
| Resources | `node:os`, `statfs` | Percentages only. |

## Freshness

Cards carry the snapshot age. Past 15 minutes the card and the fallback text say
"Stale". A missing or invalid snapshot returns `no_snapshot` / `bad_snapshot`
with a fix, and the skill tells the model to report it rather than invent data.
Refresh = run the collector again (`obs-snapshot` on a timer; example units in
`deploy/`), then the model calls the tool and `a2ui_render op=update` with the
same `surface_id`, so the card updates in place.

## Security notes

- Credentials stay in the collector: the Orbit key file and `gh` auth. The plugin
  and uirizz never see them. The snapshot contains none.
- uirizz invariants are untouched: no new hooks, no network, no gate or media
  change, no `transform_llm_output`.
- Plugin data directory only; the collector writes mode 0600 with an atomic rename.
- Prompt injection: attempt `detail` text and check names come from outside. They
  are sanitized, length-capped, shown only as card text, and the skill says labels
  are data, not instructions.
- The 100-component uirizz cap is respected (worst case is a test); tables use
  weighted `Text` cells in a `Row`, and row counts are capped.

## Install (needs the owner's yes; not done here)

1. Link or copy `hermes-plugin/rizzobs` into `~/.hermes/plugins/rizzobs` and enable it.
2. Install `deploy/obs-snapshot.service` + `.timer` (user units) so the snapshot is
   rewritten every 2 minutes, with `--out` pointing at the plugin data directory.
3. Restart the Hermes dashboard and gateway so the tool loads.

## Screenshots

`docs/observability/*-live-*.png` are real snapshots rendered through the real chain
(`rizz_observability` -> uirizz `a2ui_render` present then update -> the uirizz Desktop card renderer).
`*-busy-*` shots use a clearly marked fixture, because no bee was in flight when they were taken.


## Schema id rename (compatibility note)

The chat-card snapshot was called `rizzstack.observability/1`, which was easy to
confuse with the workflow collector's `rizzstack.observability/snapshot/1` (the
document the Observatory and Hive apps read). It is now
`rizzstack.observability/chat-card/1`. The fields are unchanged.

- The collector writes only the new id.
- The `rizzobs` plugin reads the new id and still accepts the legacy
  `rizzstack.observability/1` so an existing `snapshot.json` keeps working until
  the next collector run rewrites it. Every other id is still refused.
- The legacy read path can be removed once deployed collectors have rewritten
  their snapshots.
