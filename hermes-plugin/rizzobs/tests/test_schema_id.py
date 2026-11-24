"""Chat-card snapshot id: rizzstack.observability/chat-card/1, legacy id still read."""

import json
import time

import pytest

from rizzobs_plugin import snapshot as snap_mod

NEW = "rizzstack.observability/chat-card/1"
LEGACY = "rizzstack.observability/1"


def _write(tmp_path, schema):
    doc = {"schema": schema, "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    (tmp_path / "snapshot.json").write_text(json.dumps(doc), encoding="utf-8")


@pytest.fixture
def data_dir(tmp_path):
    snap_mod.set_data_dir(tmp_path)
    yield tmp_path
    snap_mod.set_data_dir(None)


def test_current_id_is_chat_card():
    assert snap_mod.SCHEMA == NEW
    assert LEGACY in snap_mod.LEGACY_SCHEMAS
    assert NEW not in snap_mod.LEGACY_SCHEMAS


def test_reads_current_id(data_dir):
    _write(data_dir, NEW)
    data, _, _ = snap_mod.load_snapshot(time.time())
    assert data["schema"] == NEW


def test_still_reads_legacy_id_during_transition(data_dir):
    _write(data_dir, LEGACY)
    data, _, _ = snap_mod.load_snapshot(time.time())
    assert data["schema"] == LEGACY


@pytest.mark.parametrize("schema", ["rizzstack.observability/snapshot/1", "rizzstack.observability/2", "other/9"])
def test_other_ids_are_still_refused(data_dir, schema):
    _write(data_dir, schema)
    with pytest.raises(snap_mod.SnapshotError):
        snap_mod.load_snapshot(time.time())
