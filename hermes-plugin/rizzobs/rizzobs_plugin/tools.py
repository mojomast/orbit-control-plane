"""rizz_observability tool: read the snapshot, return an Express card for a2ui_render."""

from __future__ import annotations

import inspect
import json
import time
from typing import Any

from rizzobs_plugin.cards import BUILDERS
from rizzobs_plugin.snapshot import SnapshotError, load_snapshot

TOOL_NAME = "rizz_observability"
VIEWS = tuple(BUILDERS)

SCHEMA: dict[str, Any] = {
    "name": TOOL_NAME,
    "description": (
        "Get a live, read-only rizzstack observability card as A2UI Express: bees in flight, token usage, "
        "failures and blockers, board stats, resources, or an overview. Then call a2ui_render op=present "
        "with the returned surface_id, express and fallback_text unchanged. To refresh, call this again and "
        "a2ui_render op=update with the same surface_id. Never invent numbers; on error report the fix."
    ),
    "parameters": {
        "type": "object",
        "properties": {"view": {"type": "string", "enum": list(VIEWS), "description": "Which card."}},
        "required": ["view"],
        "additionalProperties": False,
    },
}


def _dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _error(code: str, error: str, fix: str) -> str:
    return _dumps({"ok": False, "error": error, "code": code, "fix": fix})


def handle_rizz_observability(args: dict | None, now: float | None = None, **_: Any) -> str:
    """Always returns a json.dumps string."""
    try:
        payload = args if isinstance(args, dict) else {}
        extra = set(payload) - {"view"}
        if extra:
            return _error("invalid_args", "Only `view` is accepted.", "Call again with just view.")
        view = payload.get("view")
        if view not in BUILDERS:
            return _error("invalid_view", "Unknown view.", f"Use one of: {', '.join(VIEWS)}.")
        try:
            snap, age, stale = load_snapshot(time.time() if now is None else now)
        except SnapshotError as exc:
            return _error(exc.code, exc.message, exc.fix)
        express, fallback = BUILDERS[view](snap, age, stale)
        return _dumps({
            "ok": True,
            "view": view,
            "surface_id": f"rizz-obs-{view}",
            "generated_at": snap.get("generatedAt"),
            "age_minutes": round(age, 1),
            "stale": stale,
            "express": "root = " + express,
            "fallback_text": fallback,
            "next": "Call a2ui_render op=present (or op=update if this surface_id exists) with surface_id, express "
                    "and fallback_text exactly as given, then copy its MEDIA: line into your reply.",
        })
    except Exception as exc:  # noqa: BLE001 - fail closed, no traceback to the model
        return _error("internal_error", "The tool failed unexpectedly.", f"Report this: {type(exc).__name__}.")


def register_tools(ctx: Any) -> None:
    kwargs = dict(name=TOOL_NAME, toolset="rizzobs", schema=SCHEMA, handler=handle_rizz_observability,
                  description=SCHEMA["description"], emoji="📊")
    try:
        params = inspect.signature(ctx.register_tool).parameters
        if "output_schema" in params:
            pass  # not used: keep 0.21.7 and 0.23 behaviour identical
    except (TypeError, ValueError):
        pass
    ctx.register_tool(**kwargs)
