"""Load the redacted snapshot file. One JSON file, plugin data dir only."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = "rizzstack.observability/chat-card/1"
# Read-only compatibility: snapshots written before the rename. Producers emit SCHEMA only.
LEGACY_SCHEMAS = frozenset({"rizzstack.observability/1"})
MAX_BYTES = 256 * 1024
STALE_AFTER_MIN = 15

_test_dir: Path | None = None


class SnapshotError(Exception):
    def __init__(self, code: str, message: str, fix: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.fix = fix


def set_data_dir(path: Path | None) -> None:
    """Tests inject a temporary directory."""
    global _test_dir
    _test_dir = path


def data_dir() -> Path:
    if _test_dir is not None:
        return _test_dir
    try:
        from plugins.plugin_storage import plugin_data_dir  # type: ignore

        return Path(plugin_data_dir("rizzobs"))
    except Exception:
        pass
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        return Path(get_hermes_home()) / "plugin-data" / "rizzobs"
    except Exception:
        return Path.home() / ".hermes" / "plugin-data" / "rizzobs"


def snapshot_path() -> Path:
    return data_dir() / "snapshot.json"


def _no_snapshot() -> SnapshotError:
    return SnapshotError(
        "no_snapshot",
        "No observability snapshot has been written yet.",
        "Ask the owner to run `node scripts/obs-snapshot.mjs --out <plugin-data>/snapshot.json` "
        "from orbit-control-plane (or its timer). Do not build the card from guesses.",
    )


def _bad(message: str, code: str = "bad_snapshot") -> SnapshotError:
    return SnapshotError(code, message, "Re-run obs-snapshot to regenerate the file. Do not edit it by hand.")


def load_snapshot(now: float) -> tuple[dict[str, Any], float, bool]:
    """Return (snapshot, age_minutes, stale). Fails closed on anything odd."""
    path = snapshot_path()
    try:
        if path.is_symlink():
            raise _bad("The snapshot path is a symlink.")
        if not path.is_file():
            raise _no_snapshot()
        size = path.stat().st_size
        if size > MAX_BYTES:
            raise _bad("The snapshot file is too large.", "snapshot_too_large")
        data = json.loads(path.read_text(encoding="utf-8"))
    except SnapshotError:
        raise
    except (OSError, ValueError):
        raise _bad("The snapshot file could not be read as JSON.")
    if not isinstance(data, dict) or data.get("schema") not in ({SCHEMA} | LEGACY_SCHEMAS):
        raise _bad("The snapshot has an unknown schema.")
    try:
        generated = datetime.fromisoformat(str(data.get("generatedAt", "")).replace("Z", "+00:00"))
        if generated.tzinfo is None:
            generated = generated.replace(tzinfo=timezone.utc)
        age = max(0.0, (now - generated.timestamp()) / 60.0)
    except ValueError:
        raise _bad("The snapshot has no valid generatedAt time.")
    return data, age, age > STALE_AFTER_MIN
