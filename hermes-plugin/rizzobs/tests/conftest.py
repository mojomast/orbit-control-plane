import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from rizzobs_plugin import snapshot as snap_mod  # noqa: E402


def sample(**over):
    base = {
        "schema": "rizzstack.observability/chat-card/1",
        "generatedAt": "2026-11-23T20:00:00.000Z",
        "windowHours": 24,
        "sources": ["orbit-attempts", "github", "box-resources"],
        "bees": {"active": 2, "queued": 1, "cap": 12, "items": [
            {"id": "bee-0a1c", "project": "workflow", "provider": "OpenCode Go", "state": "running", "elapsedMin": 14},
            {"id": "bee-17e2", "project": "uirizz", "provider": "DeepSeek", "state": "running", "elapsedMin": 8},
            {"id": "bee-62af", "project": "hyvv", "provider": "OpenCode Go", "state": "queued", "elapsedMin": 1},
        ]},
        "tokens": {"windowHours": 24, "providers": [
            {"provider": "OpenCode Go", "runs": 23, "tokensIn": 14526, "tokensOut": 7827, "tokensCached": 1452800, "costUsd": None},
            {"provider": "DeepSeek", "runs": 0, "tokensIn": 0, "tokensOut": 0, "tokensCached": 0, "costUsd": None},
            {"provider": "OpenRouter", "runs": 2, "tokensIn": 1200000, "tokensOut": 3000, "tokensCached": 0, "costUsd": 1.25},
        ], "total": {"runs": 25, "tokensIn": 1214526, "tokensOut": 10827, "tokensCached": 1452800, "costUsd": 1.25}},
        "problems": {"windowHours": 24, "counts": {"failedRuns": 2, "ciRed": 1, "awaitingReview": 3},
            "failedRuns": [{"id": "bee-4bfc", "project": "workflow", "state": "failed", "reason": "turn ended: error", "agoMin": 195}],
            "ciRed": [{"repo": "workflow", "check": "slop-lint", "ref": "main"}],
            "awaitingReview": [{"id": "bee-b442", "project": "hyvv", "agoMin": 190}]},
        "board": {"available": True, "windowDays": 7, "skipped": [], "repos": [
            {"repo": "workflow", "open": 2, "merged": 61, "commits": 170},
            {"repo": "uirizz", "open": 0, "merged": 23, "commits": 48}],
            "totals": {"open": 2, "merged": 84, "commits": 218}},
        "resources": {"available": True, "cpuPct": 10, "memPct": 56, "diskPct": 89, "load1": 0.8, "cores": 8},
    }
    base.update(over)
    return base


@pytest.fixture
def data_dir(tmp_path):
    snap_mod.set_data_dir(tmp_path)
    yield tmp_path
    snap_mod.set_data_dir(None)


@pytest.fixture
def write_snapshot(data_dir):
    def _write(obj=None, raw=None):
        (data_dir / "snapshot.json").write_text(raw if raw is not None else json.dumps(obj if obj is not None else sample()))
        return data_dir / "snapshot.json"
    return _write
