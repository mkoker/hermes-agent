"""Tests for stream_registry."""
import json
from pathlib import Path

import pytest


@pytest.fixture
def registry(monkeypatch, tmp_path):
    monkeypatch.setenv("REX_STREAMS_ROOT", str(tmp_path))
    import importlib
    import stream_registry
    importlib.reload(stream_registry)
    return stream_registry


def test_register_creates_index_with_one_entry(registry):
    entry = registry.register(
        stream_id="mission:foo:20260505T184501Z",
        kind="mission",
        instance="foo",
        log_path="/tmp/foo.log",
        pid=12345,
        model_hint="codex",
    )
    assert entry["status"] == "running"
    assert entry["started_at"].endswith("Z")
    data = json.loads((Path(registry.REGISTRY_PATH)).read_text())
    assert len(data["streams"]) == 1
    assert data["streams"][0]["id"] == "mission:foo:20260505T184501Z"


def test_register_twice_persists_both_entries(registry):
    registry.register(stream_id="a", kind="mission", instance="m1",
                      log_path="/x", pid=1, model_hint="codex")
    registry.register(stream_id="b", kind="pm", instance="c1",
                      log_path="/y", pid=2, model_hint="gemma")
    data = json.loads(Path(registry.REGISTRY_PATH).read_text())
    ids = [s["id"] for s in data["streams"]]
    assert ids == ["a", "b"]


def test_patch_updates_status_and_ended_at(registry):
    registry.register(stream_id="m:foo:t1", kind="mission", instance="foo",
                      log_path="/tmp/x.log", pid=1, model_hint="codex")
    patched = registry.patch(stream_id="m:foo:t1",
                             status="done", exit_code=0)
    assert patched["status"] == "done"
    assert patched["exit_code"] == 0
    assert patched["ended_at"].endswith("Z")


def test_patch_unknown_id_raises(registry):
    with pytest.raises(KeyError):
        registry.patch(stream_id="nope", status="done", exit_code=0)


def test_list_all_returns_every_entry(registry):
    registry.register(stream_id="a", kind="mission", instance="m1",
                      log_path="/x", pid=1, model_hint="codex")
    registry.register(stream_id="b", kind="pm", instance="card-1",
                      log_path="/y", pid=2, model_hint="gemma")
    assert {s["id"] for s in registry.list_streams()} == {"a", "b"}


def test_list_filter_by_kind(registry):
    registry.register(stream_id="a", kind="mission", instance="m1",
                      log_path="/x", pid=1, model_hint="codex")
    registry.register(stream_id="b", kind="pm", instance="c1",
                      log_path="/y", pid=2, model_hint="gemma")
    out = registry.list_streams(kind="mission")
    assert [s["id"] for s in out] == ["a"]


def test_list_filter_by_status_skips_stale_pid(registry, monkeypatch):
    registry.register(stream_id="a", kind="mission", instance="m1",
                      log_path="/x", pid=999999, model_hint="codex")
    # Force kill -0 to fail by monkeypatching os.kill
    def fake_kill(pid, sig):
        raise ProcessLookupError
    import stream_registry
    monkeypatch.setattr(stream_registry.os, "kill", fake_kill)
    # list with status filter should detect stale pid and patch to killed
    out = registry.list_streams(status="running")
    assert out == []
    # Entry should now show killed
    out_all = registry.list_streams()
    assert out_all[0]["status"] == "killed"



def test_patch_with_no_updates_raises(registry):
    registry.register(stream_id="x", kind="mission", instance="m",
                      log_path="/tmp/x", pid=1, model_hint="codex")
    with pytest.raises(ValueError, match="at least one of"):
        registry.patch(stream_id="x")
