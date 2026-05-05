"""Tests for rex-loop plugin API."""
import json
import os
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

def test_kanban_create_then_list(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    kanban = tmp_path / "kanban"
    monkeypatch.setenv("REX_LOOP_KANBAN_ROOT", str(kanban))
    import importlib, plugin_api
    importlib.reload(plugin_api)
    a2 = type(a)(); a2.include_router(plugin_api.router)
    client = TestClient(a2)

    r = client.post("/kanban/cards", json={"title": "Idea one", "tag": "infra"})
    assert r.status_code == 200
    cid = r.json()["id"]

    r = client.get("/kanban/cards")
    assert r.status_code == 200
    cards = r.json()
    assert len(cards) == 1
    assert cards[0]["id"] == cid
    assert cards[0]["status"] == "inbox"


def test_kanban_patch_status(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    kanban = tmp_path / "kanban"
    monkeypatch.setenv("REX_LOOP_KANBAN_ROOT", str(kanban))
    import importlib, plugin_api
    importlib.reload(plugin_api)
    a2 = type(a)(); a2.include_router(plugin_api.router)
    client = TestClient(a2)

    r = client.post("/kanban/cards", json={"title": "X"})
    cid = r.json()["id"]

    r = client.patch(f"/kanban/cards/{cid}", json={"status": "backlog"})
    assert r.status_code == 200
    assert r.json()["status"] == "backlog"


def test_kanban_delete(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    kanban = tmp_path / "kanban"
    monkeypatch.setenv("REX_LOOP_KANBAN_ROOT", str(kanban))
    import importlib, plugin_api
    importlib.reload(plugin_api)
    a2 = type(a)(); a2.include_router(plugin_api.router)
    client = TestClient(a2)
    r = client.post("/kanban/cards", json={"title": "Z"})
    cid = r.json()["id"]
    r = client.delete(f"/kanban/cards/{cid}")
    assert r.status_code == 200
    r = client.get("/kanban/cards")
    assert r.json() == []


def test_pm_status_idle(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    kanban = tmp_path / "kanban"; kanban.mkdir()
    monkeypatch.setenv("REX_LOOP_KANBAN_ROOT", str(kanban))
    import importlib, plugin_api
    importlib.reload(plugin_api)
    a2 = type(a)(); a2.include_router(plugin_api.router)
    client = TestClient(a2)
    r = client.get("/pm/status")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "idle"
    assert body["paused"] is False
    assert "today" in body


def test_pm_pause_resume(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    kanban = tmp_path / "kanban"; kanban.mkdir()
    monkeypatch.setenv("REX_LOOP_KANBAN_ROOT", str(kanban))
    import importlib, plugin_api
    importlib.reload(plugin_api)
    a2 = type(a)(); a2.include_router(plugin_api.router)
    client = TestClient(a2)
    r = client.post("/pm/pause"); assert r.status_code == 200
    assert (kanban / "PM_PAUSE").exists()
    r = client.get("/pm/status"); assert r.json()["paused"] is True
    r = client.post("/pm/resume"); assert r.status_code == 200
    assert not (kanban / "PM_PAUSE").exists()


def test_kanban_promote_invokes_script(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    kanban = tmp_path / "kanban"
    monkeypatch.setenv("REX_LOOP_KANBAN_ROOT", str(kanban))
    # fake promote script that just touches a marker file
    fake_script = tmp_path / "promote_card.sh"
    marker = tmp_path / "promoted.marker"
    fake_script.write_text(f'#!/bin/bash\necho "$1" > {marker}\n')
    fake_script.chmod(0o755)
    monkeypatch.setenv("REX_LOOP_PROMOTE_SCRIPT", str(fake_script))
    import importlib, plugin_api
    importlib.reload(plugin_api)
    a2 = type(a)(); a2.include_router(plugin_api.router)
    client = TestClient(a2)

    r = client.post("/kanban/cards", json={"title": "X"})
    cid = r.json()["id"]
    client.patch(f"/kanban/cards/{cid}", json={"status": "backlog"})

    r = client.post(f"/kanban/cards/{cid}/promote")
    assert r.status_code == 200
    assert marker.exists()
    assert marker.read_text().strip() == cid


def test_streams_endpoint_lists_registered_entries(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    streams_root = tmp_path / "streams"
    streams_root.mkdir()
    monkeypatch.setenv("REX_STREAMS_ROOT", str(streams_root))
    import importlib, stream_registry, plugin_api
    importlib.reload(stream_registry)
    importlib.reload(plugin_api)
    a2 = FastAPI()
    a2.include_router(plugin_api.router)
    stream_registry.register(stream_id="s1", kind="mission",
                             instance="foo", log_path="/x",
                             pid=os.getpid(), model_hint="codex")
    with TestClient(a2) as c:
        r = c.get("/streams")
        assert r.status_code == 200
        assert [s["id"] for s in r.json()] == ["s1"]


def test_streams_endpoint_filter_by_kind(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    streams_root = tmp_path / "streams"
    streams_root.mkdir()
    monkeypatch.setenv("REX_STREAMS_ROOT", str(streams_root))
    import importlib, stream_registry, plugin_api
    importlib.reload(stream_registry)
    importlib.reload(plugin_api)
    a2 = FastAPI()
    a2.include_router(plugin_api.router)
    stream_registry.register(stream_id="m1", kind="mission",
                             instance="foo", log_path="/x",
                             pid=os.getpid(), model_hint="codex")
    stream_registry.register(stream_id="p1", kind="pm",
                             instance="card-1", log_path="/y",
                             pid=os.getpid(), model_hint="gemma")
    with TestClient(a2) as c:
        r = c.get("/streams?kind=pm")
        assert r.status_code == 200
        assert [s["id"] for s in r.json()] == ["p1"]


def test_streams_events_snapshot_returns_existing_lines(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    streams_root = tmp_path / "streams"
    streams_root.mkdir()
    log = tmp_path / "x.stream.log"
    log.write_text("hello\nworld\n")
    monkeypatch.setenv("REX_STREAMS_ROOT", str(streams_root))
    import importlib, stream_registry, plugin_api
    importlib.reload(stream_registry)
    importlib.reload(plugin_api)
    a2 = FastAPI()
    a2.include_router(plugin_api.router)
    stream_registry.register(stream_id="s1", kind="mission",
                             instance="foo", log_path=str(log),
                             pid=os.getpid(), model_hint="codex")
    stream_registry.patch(stream_id="s1", status="done", exit_code=0)
    with TestClient(a2) as c:
        r = c.get("/streams/s1/events?follow=false")
        assert r.status_code == 200
        body = r.text
        assert "event: snapshot" in body
        assert "hello" in body
        assert "world" in body
        assert "event: status" in body
        # Ensure the SSE content-type
        assert r.headers["content-type"].startswith("text/event-stream")


def test_streams_events_replay_with_last_event_id(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    streams_root = tmp_path / "streams"; streams_root.mkdir()
    log = tmp_path / "x.stream.log"
    log.write_text("a\nb\nc\nd\ne\n")
    monkeypatch.setenv("REX_STREAMS_ROOT", str(streams_root))
    import importlib, stream_registry, plugin_api
    importlib.reload(stream_registry); importlib.reload(plugin_api)
    a2 = FastAPI(); a2.include_router(plugin_api.router)
    stream_registry.register(stream_id="s1", kind="mission",
                             instance="foo", log_path=str(log),
                             pid=os.getpid(), model_hint="codex")
    stream_registry.patch(stream_id="s1", status="done", exit_code=0)
    with TestClient(a2) as c:
        r = c.get("/streams/s1/events", headers={"Last-Event-Id": "2"})
        assert r.status_code == 200
        body = r.text
        # Snapshot event should NOT be present (replay path)
        assert "event: snapshot" not in body
        # Lines 3, 4, 5 (c, d, e) should be there
        assert '"text": "c"' in body
        assert '"text": "d"' in body
        assert '"text": "e"' in body
        # Lines 1, 2 should NOT (we said since 2)
        assert '"text": "a"' not in body
        assert '"text": "b"' not in body
        # Status closer
        assert "event: status" in body


def test_streams_events_follow_false_short_circuits_running(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    streams_root = tmp_path / "streams"; streams_root.mkdir()
    log = tmp_path / "x.stream.log"
    log.write_text("hi\n")
    monkeypatch.setenv("REX_STREAMS_ROOT", str(streams_root))
    import importlib, stream_registry, plugin_api
    importlib.reload(stream_registry); importlib.reload(plugin_api)
    a2 = FastAPI(); a2.include_router(plugin_api.router)
    stream_registry.register(stream_id="s1", kind="mission",
                             instance="foo", log_path=str(log),
                             pid=os.getpid(), model_hint="codex")
    # Leave status=running — follow=false should still return snapshot then close
    with TestClient(a2) as c:
        r = c.get("/streams/s1/events?follow=false")
        assert r.status_code == 200
        body = r.text
        assert "event: snapshot" in body
        assert "hi" in body
        # No status event for running stream when follow=false (status only
        # fires when stream actually ends)


def test_pm_fire_spawns_runner_and_returns_stream_id(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    pm_runner = loop_root / "pm_runner.sh"
    pm_runner.write_text("#!/bin/bash\nexit 0\n")
    pm_runner.chmod(0o755)
    streams_root = tmp_path / "streams"
    streams_root.mkdir()
    monkeypatch.setenv("REX_STREAMS_ROOT", str(streams_root))
    monkeypatch.setenv("REX_PM_RUNNER", str(pm_runner))
    import importlib, plugin_api, stream_registry
    importlib.reload(stream_registry)
    importlib.reload(plugin_api)
    a2 = FastAPI()
    a2.include_router(plugin_api.router)
    with TestClient(a2) as c:
        r = c.post("/pm/fire")
        assert r.status_code == 200
        body = r.json()
        assert body["stream_id"].startswith("pm:manual:")
        assert body["status"] == "started"


def test_pm_fire_blocks_when_global_pause(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    (loop_root / "PAUSE").write_text("")
    monkeypatch.setenv("REX_PM_RUNNER", str(loop_root / "x.sh"))
    import importlib, plugin_api
    importlib.reload(plugin_api)
    a2 = FastAPI()
    a2.include_router(plugin_api.router)
    with TestClient(a2) as c:
        r = c.post("/pm/fire")
        assert r.status_code == 409
        assert "global_pause" in r.text


def test_ai_brief_fire_spawns_runner(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    brief_root = missions / "ai-brief"; brief_root.mkdir()
    brief_sh = brief_root / "run-brief.sh"
    brief_sh.write_text("#!/bin/bash\nexit 0\n")
    brief_sh.chmod(0o755)
    streams_root = tmp_path / "streams"
    streams_root.mkdir()
    monkeypatch.setenv("REX_STREAMS_ROOT", str(streams_root))
    monkeypatch.setenv("REX_AI_BRIEF_RUNNER", str(brief_sh))
    import importlib, plugin_api, stream_registry
    importlib.reload(stream_registry)
    importlib.reload(plugin_api)
    a2 = FastAPI()
    a2.include_router(plugin_api.router)
    with TestClient(a2) as c:
        r = c.post("/ai-brief/fire")
        assert r.status_code == 200
        assert r.json()["stream_id"].startswith("ai-brief:manual:")


def test_pm_fire_idempotent_when_already_running(app, monkeypatch, tmp_path):
    a, missions, loop_root = app
    pm_runner = loop_root / "pm_runner.sh"
    pm_runner.write_text("#!/bin/bash\nsleep 60\n")  # long-running stub
    pm_runner.chmod(0o755)
    streams_root = tmp_path / "streams"; streams_root.mkdir()
    monkeypatch.setenv("REX_STREAMS_ROOT", str(streams_root))
    monkeypatch.setenv("REX_PM_RUNNER", str(pm_runner))
    monkeypatch.setenv("REX_KANBAN_ROOT", str(tmp_path / "kanban"))
    import importlib, plugin_api, stream_registry
    importlib.reload(stream_registry); importlib.reload(plugin_api)
    a2 = FastAPI(); a2.include_router(plugin_api.router)
    with TestClient(a2) as c:
        r1 = c.post("/pm/fire")
        assert r1.json()["status"] == "started"
        first_id = r1.json()["stream_id"]
        r2 = c.post("/pm/fire")
        assert r2.status_code == 200
        body = r2.json()
        assert body["status"] == "already_running"
        assert body["stream_id"] == first_id
        # Cleanup: kill the lingering sleep process
        import os, signal
        os.kill(r1.json()["pid"], signal.SIGTERM)
