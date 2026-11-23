import ast
import os
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from tests.conftest import ROOT, sample
from tests.fake_ctx import FakeCtx
from rizzobs_plugin import snapshot as snap_mod
from rizzobs_plugin.tools import VIEWS, handle_rizz_observability

NOW = datetime(2026, 11, 23, 20, 5, tzinfo=timezone.utc).timestamp()


def call(view="overview", **kw):
    out = handle_rizz_observability({"view": view, **kw}, now=NOW)
    assert isinstance(out, str)
    return json.loads(out)


def test_register_matches_manifest():
    import importlib.util
    spec = importlib.util.spec_from_file_location("rizzobs_root", ROOT / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    ctx = FakeCtx()
    mod.register(ctx)
    text = (ROOT / "plugin.yaml").read_text()
    assert set(ctx.tools) == {"rizz_observability"}
    assert "provides_tools:\n  - rizz_observability" in text
    assert "provides_hooks: []" in text
    assert "requires_env: []" in text
    assert not ctx.hooks
    schema = ctx.tools["rizz_observability"]["schema"]
    assert schema["parameters"]["additionalProperties"] is False
    assert set(schema["parameters"]["properties"]) == {"view"}
    assert len(json.dumps(schema)) < 1600


def test_package_has_no_network_process_or_env_access():
    banned_mods = {"subprocess", "socket", "urllib", "http", "requests", "httpx", "aiohttp", "ssl", "ftplib", "smtplib", "os"}
    banned_calls = {"system", "popen", "getenv", "environ"}
    for path in (ROOT / "rizzobs_plugin").glob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [(node.module or "").split(".")[0]]
            else:
                names = []
            for n in names:
                assert n not in banned_mods, f"{path.name} imports {n}"
            if isinstance(node, ast.Attribute):
                assert node.attr not in banned_calls, f"{path.name} uses {node.attr}"


@pytest.mark.parametrize("view", VIEWS)
def test_every_view_returns_card_and_fallback(view, write_snapshot):
    write_snapshot()
    body = call(view)
    assert body["ok"] is True
    assert body["view"] == view
    assert body["surface_id"] == f"rizz-obs-{view}"
    assert body["express"].startswith("root = Column(")
    assert len(body["express"]) < 7000
    assert len(body["fallback_text"]) > 40
    assert body["stale"] is False
    assert "a2ui_render" in body["next"]


def test_numbers_come_from_the_snapshot(write_snapshot):
    write_snapshot()
    bees = call("bees")
    assert "bee-0a1c" in bees["express"] and "7 / 12" not in bees["express"]
    assert "2 / 12" in bees["fallback_text"]
    tokens = call("tokens")
    assert "14.5K" in tokens["express"] or "14,526" in tokens["express"]
    assert "$1.25" in tokens["fallback_text"]
    assert "n/a" in tokens["express"]  # unknown cost is never invented
    problems = call("problems")
    assert "slop-lint" in problems["express"]
    board = call("board")
    assert "218" in board["fallback_text"]
    res = call("resources")
    assert "89%" in res["fallback_text"]


def test_missing_snapshot_is_a_clear_error(data_dir):
    body = call("bees")
    assert body["ok"] is False and body["code"] == "no_snapshot"
    assert "obs-snapshot" in body["fix"]


def test_stale_snapshot_is_flagged_in_card_and_fallback(write_snapshot):
    write_snapshot(sample(generatedAt="2026-11-23T18:00:00.000Z"))
    body = call("bees")
    assert body["ok"] is True and body["stale"] is True
    assert "stale" in body["fallback_text"].lower()
    assert "Stale" in body["express"]


@pytest.mark.parametrize("raw", ["{nope", "[]", json.dumps({"schema": "other/9"}), "x" * 400_000])
def test_bad_snapshot_fails_closed(raw, write_snapshot):
    write_snapshot(raw=raw)
    body = call("bees")
    assert body["ok"] is False and body["code"] in {"bad_snapshot", "snapshot_too_large"}


def test_symlinked_snapshot_is_refused(data_dir, tmp_path_factory):
    target = tmp_path_factory.mktemp("elsewhere") / "x.json"
    target.write_text(json.dumps(sample()))
    (data_dir / "snapshot.json").symlink_to(target)
    body = call("bees")
    assert body["ok"] is False and body["code"] == "bad_snapshot"


def test_unknown_view_and_extra_args(write_snapshot):
    write_snapshot()
    assert call("nope")["code"] == "invalid_view"
    assert call("bees", path="/etc/passwd")["code"] == "invalid_args"


ALLOWED_CALLS = {"Column", "Row", "Card", "Text", "Divider", "Icon", "Slider"}


def called_names(express):
    tree = ast.parse(express)
    return {n.func.id for n in ast.walk(tree) if isinstance(n, ast.Call)}


def test_hostile_labels_cannot_break_out_of_express(write_snapshot):
    evil = 'x") , Button(Text("pwn"), action=Event("deploy")) #${/secret}\u0007\n'
    s = sample()
    s["bees"]["items"][0]["project"] = evil
    s["problems"]["failedRuns"][0]["reason"] = evil
    s["problems"]["ciRed"][0]["check"] = evil
    s["board"]["repos"][0]["repo"] = evil
    write_snapshot(s)
    for view in VIEWS:
        body = call(view)
        assert body["ok"] is True
        # Express is a Python-call syntax: parse it and prove no extra component appeared.
        assert called_names(body["express"]) <= ALLOWED_CALLS
        assert "${" not in body["express"]
        assert "\u0007" not in body["express"] and "\u0007" not in body["fallback_text"]


def test_hostile_numbers_are_coerced(write_snapshot):
    s = sample()
    s["bees"]["active"] = "<script>"
    s["tokens"]["providers"][0]["tokensIn"] = {"x": 1}
    s["resources"]["cpuPct"] = float("nan")
    write_snapshot(raw=json.dumps(s))
    body = call("overview")
    assert body["ok"] is True
    assert "<script>" not in body["express"]


def test_cards_have_no_actions_or_media(write_snapshot):
    write_snapshot()
    for view in VIEWS:
        ex = call(view)["express"]
        assert "Event(" not in ex and "Button(" not in ex and "Image(" not in ex and "http" not in ex


UIRIZZ_SRC = os.environ.get("UIRIZZ_SRC", "")


@pytest.mark.skipif(not UIRIZZ_SRC, reason="set UIRIZZ_SRC to a uirizz checkout (with a2ui-agent-sdk installed) to compile cards")
def test_cards_compile_with_uirizz_express(write_snapshot):
    import sys
    sys.path.insert(0, UIRIZZ_SRC)
    try:
        from uirizz_plugin.express import compile_express
    except Exception:
        pytest.skip("uirizz express unavailable")
    write_snapshot()
    for view in VIEWS:
        jsonl = compile_express(call(view)["express"])
        assert "createSurface" in jsonl


def worst_case():
    s = sample()
    s["bees"] = {"active": 10, "queued": 2, "cap": 12, "items": [
        {"id": f"bee-{i:04x}", "project": "orbit-control-plane", "provider": "OpenCode Go", "state": "running", "elapsedMin": 99}
        for i in range(12)]}
    s["problems"]["failedRuns"] = [{"id": f"bee-{i:04x}", "project": "workflow", "state": "failed", "reason": "r" * 80, "agoMin": 5} for i in range(6)]
    s["problems"]["ciRed"] = [{"repo": "workflow", "check": "c" * 50, "ref": "main"} for _ in range(8)]
    s["problems"]["awaitingReview"] = [{"id": f"bee-{i:04x}", "project": "hyvv", "agoMin": 5} for i in range(6)]
    s["board"]["repos"] = [{"repo": f"repo{i}", "open": 1, "merged": 2, "commits": 3} for i in range(6)]
    s["board"]["skipped"] = ["a", "b"]
    s["tokens"]["providers"] += [{"provider": "Other", "runs": 1, "tokensIn": 1, "tokensOut": 1, "tokensCached": 1, "costUsd": 1}]
    return s


@pytest.mark.skipif(not UIRIZZ_SRC, reason="set UIRIZZ_SRC to a uirizz checkout")
def test_worst_case_stays_under_uirizz_component_cap(write_snapshot):
    import sys
    sys.path.insert(0, UIRIZZ_SRC)
    from uirizz_plugin.express import compile_express
    write_snapshot(worst_case())
    for view in VIEWS:
        jsonl = compile_express(call(view)["express"])
        n = sum(len(json.loads(line).get("createSurface", {}).get("components", [])) for line in jsonl.splitlines() if line.strip())
        assert n <= 90, f"{view}: {n} components (uirizz cap is 100)"
