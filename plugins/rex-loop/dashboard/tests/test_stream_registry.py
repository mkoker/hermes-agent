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
