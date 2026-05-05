"""Tests for rex-loop plugin API."""
import json
from pathlib import Path
import sys

import pytest
from fastapi.testclient import TestClient
from fastapi import FastAPI

PLUGIN_DIR = Path("/home/ubuntu/.hermes/hermes-agent/plugins/rex-loop/dashboard")
sys.path.insert(0, str(PLUGIN_DIR))


@pytest.fixture
def app(monkeypatch, tmp_path):
    missions = tmp_path / "missions"
    missions.mkdir()
    loop_root = tmp_path / "loop"
    loop_root.mkdir()
    (loop_root / "cron.out").write_text("")
    monkeypatch.setenv("REX_LOOP_MISSIONS_ROOT", str(missions))
    monkeypatch.setenv("REX_LOOP_LOOP_ROOT", str(loop_root))
    import importlib
    import plugin_api
    importlib.reload(plugin_api)
    a = FastAPI()
    a.include_router(plugin_api.router)
    return a, missions, loop_root


def _seed_mission(missions: Path, name: str, status: str = "active",
                  plan: str | None = None):
    d = missions / name
    d.mkdir()
    (d / "STATUS").write_text(status)
    (d / "started_at").write_text("2026-04-25T00:00:00Z")
    (d / "max_days").write_text("14")
    (d / "workspace").write_text("/mnt/nvme/test")
    (d / "plan.md").write_text(plan or "# Plan\n\n- [x] Task A: done\n  GATES:\n    build: true\n    test: true\n\n- [ ] Task B: doing\n  GATES:\n    build: true\n    test: true\n")
    return d


def test_missions_endpoint_lists_all_missions(app):
    a, missions, _ = app
    _seed_mission(missions, "alpha")
    _seed_mission(missions, "beta", status="paused")
    client = TestClient(a)
    r = client.get("/missions")
    assert r.status_code == 200
    names = {m["name"] for m in r.json()}
    assert names == {"alpha", "beta"}


def test_missions_returns_progress_counts(app):
    a, missions, _ = app
    _seed_mission(missions, "alpha")
    client = TestClient(a)
    r = client.get("/missions")
    m = next(m for m in r.json() if m["name"] == "alpha")
    assert m["tasks_total"] == 2
    assert m["tasks_done"] == 1
    assert m["tasks_failed"] == 0
    assert m["status"] == "active"
    assert "Task B: doing" in m["current_task"]


def test_missions_handles_failed_tasks(app):
    a, missions, _ = app
    plan = "- [FAIL 2: build broke] Task X\n  GATES:\n    build: true\n    test: true\n"
    _seed_mission(missions, "gamma", plan=plan)
    client = TestClient(a)
    r = client.get("/missions")
    m = next(m for m in r.json() if m["name"] == "gamma")
    assert m["tasks_failed"] == 1


def test_plan_endpoint_returns_plan_text(app):
    a, missions, _ = app
    _seed_mission(missions, "alpha")
    client = TestClient(a)
    r = client.get("/missions/alpha/plan")
    assert r.status_code == 200
    assert "Task A: done" in r.json()["text"]


def test_pause_sets_status(app):
    a, missions, _ = app
    _seed_mission(missions, "alpha")
    client = TestClient(a)
    r = client.post("/missions/alpha/pause")
    assert r.status_code == 200
    assert (missions / "alpha" / "STATUS").read_text().strip() == "paused"


def test_resume_sets_status_active(app):
    a, missions, _ = app
    _seed_mission(missions, "alpha", status="paused")
    client = TestClient(a)
    r = client.post("/missions/alpha/resume")
    assert r.status_code == 200
    assert (missions / "alpha" / "STATUS").read_text().strip() == "active"


def test_pause_unknown_mission_404(app):
    a, _, _ = app
    client = TestClient(a)
    r = client.post("/missions/nope/pause")
    assert r.status_code == 404


def test_cron_stream_returns_recent_lines(app):
    a, _, loop_root = app
    (loop_root / "cron.out").write_text(
        "[2026-04-27T00:00:00+00:00] tick start mission=alpha\n"
        "[2026-04-27T00:01:00+00:00] task marked done\n"
    )
    client = TestClient(a)
    r = client.get("/cron-stream")
    assert r.status_code == 200
    assert len(r.json()["lines"]) == 2


def test_cron_stream_since_filters(app):
    a, _, loop_root = app
    (loop_root / "cron.out").write_text(
        "[2026-04-27T00:00:00+00:00] tick start mission=alpha\n"
        "[2026-04-27T01:00:00+00:00] task marked done\n"
    )
    client = TestClient(a)
    r = client.get("/cron-stream", params={"since": "2026-04-27T00:30:00+00:00"})
    lines = r.json()["lines"]
    assert len(lines) == 1
    assert "task marked done" in lines[0]

import json as _json
from fastapi.testclient import TestClient


def test_tokens_today_endpoint(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    monkeypatch.setenv("REX_LOOP_SESSIONS_DIR", str(sessions))
    # write a session in todays UTC date

import json as _json
from fastapi.testclient import TestClient


def test_tokens_today_endpoint(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    monkeypatch.setenv("REX_LOOP_SESSIONS_DIR", str(sessions))
    # write a session in today's UTC date
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (sessions / "session_today.json").write_text(_json.dumps({
        "session_id": "today", "session_start": today, "model": "claude-sonnet-4-6",
        "messages": [{"role": "assistant", "usage": {"input_tokens": 100, "output_tokens": 40}}],
    }))
    import importlib, plugin_api
    importlib.reload(plugin_api)
    a2 = type(a)(); a2.include_router(plugin_api.router)
    client = TestClient(a2)
    r = client.get("/tokens/today")
    assert r.status_code == 200
    body = r.json()
    assert body["in"] == 100
    assert body["out"] == 40


def test_tokens_total_endpoint(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    monkeypatch.setenv("REX_LOOP_SESSIONS_DIR", str(sessions))
    (sessions / "session_a.json").write_text(_json.dumps({
        "session_id": "a", "session_start": "2026-05-01T10:00:00Z", "model": "claude",
        "messages": [{"role": "assistant", "usage": {"input_tokens": 500, "output_tokens": 200}}],
    }))
    import importlib, plugin_api
    importlib.reload(plugin_api)
    a2 = type(a)(); a2.include_router(plugin_api.router)
    client = TestClient(a2)
    r = client.get("/tokens/total")
    assert r.status_code == 200
    body = r.json()
    assert body["in"] == 500
    assert body["out"] == 200


import json as _json
from fastapi.testclient import TestClient


def test_tokens_today_endpoint(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    monkeypatch.setenv("REX_LOOP_SESSIONS_DIR", str(sessions))
    # write a session in today's UTC date
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (sessions / "session_today.json").write_text(_json.dumps({
        "session_id": "today", "session_start": today, "model": "claude-sonnet-4-6",
        "messages": [{"role": "assistant", "usage": {"input_tokens": 100, "output_tokens": 40}}],
    }))
    import importlib, plugin_api
    importlib.reload(plugin_api)
    a2 = type(a)(); a2.include_router(plugin_api.router)
    client = TestClient(a2)
    r = client.get("/tokens/today")
    assert r.status_code == 200
    body = r.json()
    assert body["in"] == 100
    assert body["out"] == 40


def test_tokens_total_endpoint(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    monkeypatch.setenv("REX_LOOP_SESSIONS_DIR", str(sessions))
    (sessions / "session_a.json").write_text(_json.dumps({
        "session_id": "a", "session_start": "2026-05-01T10:00:00Z", "model": "claude",
        "messages": [{"role": "assistant", "usage": {"input_tokens": 500, "output_tokens": 200}}],
    }))
    import importlib, plugin_api
    importlib.reload(plugin_api)
    a2 = type(a)(); a2.include_router(plugin_api.router)
    client = TestClient(a2)
    r = client.get("/tokens/total")
    assert r.status_code == 200
    body = r.json()
    assert body["in"] == 500
    assert body["out"] == 200


def test_tickfile_endpoint_parses_sections(app):
    a, missions, _ = app
    md = missions / "demo"
    md.mkdir()
    (md / "ticks").mkdir()
    (md / "ticks" / "1.md").write_text(
        "# Tick 1 · mission: demo · task: T01\nstarted: 2026-05-04T20:11:54Z\n\n"
        "## Researcher\nresearcher body content here\n\n"
        "## Planner\nplanner body content\n\n"
        "## Coder\ncoder body in progress"
    )
    a2 = type(a)(); a2.include_router(__import__("plugin_api").router)
    client = TestClient(a2)
    r = client.get("/missions/demo/tickfile/1")
    assert r.status_code == 200
    body = r.json()
    assert body["path"].endswith("/1.md")
    assert len(body["sections"]) == 3
    roles = [s["role"] for s in body["sections"]]
    assert roles == ["Researcher", "Planner", "Coder"]
    assert "researcher body content" in body["sections"][0]["body"]


def test_tickfile_endpoint_404_when_missing(app):
    a, _, _ = app
    a2 = type(a)(); a2.include_router(__import__("plugin_api").router)
    client = TestClient(a2)
    r = client.get("/missions/nope/tickfile/99")
    assert r.status_code == 404
