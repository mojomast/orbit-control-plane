# rizzobs

Read-only Hermes plugin: one tool, `rizz_observability(view)`, that turns the redacted snapshot written by
`scripts/obs-snapshot.mjs` into an A2UI Express card for uirizz's `a2ui_render`. No network, no subprocesses,
no credentials, no hooks. See [docs/OBSERVABILITY.md](../../docs/OBSERVABILITY.md).

Tests: `python -m pytest tests` (set `UIRIZZ_SRC=<uirizz checkout>` with `a2ui-agent-sdk` installed to also
compile every card with uirizz's Express compiler and check the 100-component cap).
