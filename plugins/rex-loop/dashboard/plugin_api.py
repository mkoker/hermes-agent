"""rex-loop dashboard plugin — backend API.

Mounted at /api/plugins/rex-loop/ by the dashboard plugin system.
Reads files in ~/.hermes/missions/ and ~/.hermes/loop/cron.out — no DB.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

MISSIONS_ROOT = Path(os.environ.get("REX_LOOP_MISSIONS_ROOT",
                                    "/home/ubuntu/.hermes/missions"))
LOOP_ROOT = Path(os.environ.get("REX_LOOP_LOOP_ROOT",
                                "/home/ubuntu/.hermes/loop"))
CRON_OUT = LOOP_ROOT / "cron.out"
RUNNER_SH = LOOP_ROOT / "runner.sh"

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(LOOP_ROOT))
import stream_registry
try:
    from plan_parser import _TASK_LINE
except Exception:
    _TASK_LINE = re.compile(
        r"^- \[(?P<marker>x| |FAIL (?P<n>\d+): (?P<reason>[^\]]*))\] (?P<title>.+)$"
    )

router = APIRouter()


def _read(path: Path, default: str = "") -> str:
    try:
        return path.read_text().strip()
    except FileNotFoundError:
        return default


def _parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _count_tasks(plan_text: str):
    """Count only tasks that have a GATES block (real runnable tasks).

    Skips checklist [ ] items without GATES, mirrors plan_parser.next_pending_task.
    """
    total = done = failed = 0
    current = ""
    lines = plan_text.splitlines()
    i = 0
    while i < len(lines):
        m = _TASK_LINE.match(lines[i])
        if not m:
            i += 1
            continue
        # Walk forward; does this task have a GATES: block?
        has_gates = False
        j = i + 1
        while j < len(lines):
            stripped = lines[j].strip()
            if not stripped:
                break
            if _TASK_LINE.match(lines[j]):
                break
            if stripped == "GATES:":
                has_gates = True
                break
            j += 1
        if not has_gates:
            i += 1
            continue
        total += 1
        marker = m.group("marker")
        if marker == "x":
            done += 1
        elif marker.startswith("FAIL"):
            failed += 1
        if marker == " " and not current:
            # Truncate ugly multi-line FAIL pollution
            line = lines[i]
            if len(line) > 200:
                line = line[:200] + " ..."
            current = line
        i += 1
    return total, done, failed, current


def _last_tick_ts(mdir: Path):
    logs = mdir / "logs"
    if not logs.exists():
        return None
    files = sorted(logs.glob("*.tick.log"))
    return files[-1].stem.replace(".tick", "") if files else None


@router.get("/missions")
async def list_missions():
    if not MISSIONS_ROOT.exists():
        return []
    out = []
    now = datetime.now(timezone.utc)
    for mdir in sorted(MISSIONS_ROOT.iterdir()):
        if not mdir.is_dir():
            continue
        plan_text = _read(mdir / "plan.md")
        total, done, failed, current = _count_tasks(plan_text)
        status = _read(mdir / "STATUS", "missing")
        started_raw = _read(mdir / "started_at")
        max_days = int(_read(mdir / "max_days", "14") or 14)
        days_remaining = None
        if started_raw:
            try:
                started = _parse_iso(started_raw)
                days_remaining = max(0, max_days - (now - started).days)
            except Exception:
                pass
        last_tick = _last_tick_ts(mdir)
        out.append({
            "name": mdir.name,
            "status": status,
            "started_at": started_raw,
            "max_days": max_days,
            "days_remaining": days_remaining,
            "tasks_total": total,
            "tasks_done": done,
            "tasks_failed": failed,
            "current_task": current,
            "workspace": _read(mdir / "workspace"),
            "last_tick_ts": last_tick,
        })
    out.sort(key=lambda m: (m["status"] != "active", m["name"]))
    return out


@router.get("/missions/{name}/plan")
async def get_plan(name: str):
    p = MISSIONS_ROOT / name / "plan.md"
    if not p.exists():
        raise HTTPException(404, "mission not found")
    return {"text": p.read_text()}


_TICK_LINE = re.compile(r"^\[(?P<ts>[^\]]+)\] (?P<rest>.+)$")


def _parse_tick_log(mission: str, path: Path):
    rec = {"id": path.stem.replace(".tick", ""), "mission": mission,
           "ts_start": None, "ts_end": None,
           "picked_line": None, "task_first_line": None,
           "dispatch_rc": None, "gate_rc": None,
           "marked": None, "auto_push": None}
    for line in path.read_text().splitlines():
        m = _TICK_LINE.match(line)
        if not m:
            continue
        ts, rest = m.group("ts"), m.group("rest")
        if "tick start" in rest and rec["ts_start"] is None:
            rec["ts_start"] = ts
        elif "tick end" in rest:
            rec["ts_end"] = ts
        elif rest.startswith("picked line="):
            try:
                rec["picked_line"] = int(rest.split("=", 1)[1])
            except Exception:
                pass
        elif rest.startswith("block: "):
            rec["task_first_line"] = rest[len("block: "):]
        elif rest.startswith("dispatch exit="):
            try:
                rec["dispatch_rc"] = int(rest.split("=", 1)[1])
            except Exception:
                pass
        elif rest.startswith("gate exit="):
            try:
                rec["gate_rc"] = int(rest.split("=", 1)[1])
            except Exception:
                pass
        elif rest.startswith("task marked "):
            rec["marked"] = rest[len("task marked "):].split()[0]
        elif rest.startswith("auto-push: "):
            rec["auto_push"] = rest[len("auto-push: "):]
    return rec


@router.get("/missions/{name}/ticks")
async def get_ticks(name: str, limit: int = Query(20, ge=1, le=200)):
    logs = MISSIONS_ROOT / name / "logs"
    if not logs.exists():
        return []
    files = sorted(logs.glob("*.tick.log"), reverse=True)[:limit]
    return [_parse_tick_log(name, f) for f in files]


@router.get("/cron-stream")
async def cron_stream(since: str | None = None, tail: int = Query(200, ge=1, le=2000)):
    if not CRON_OUT.exists():
        return {"lines": []}
    raw = CRON_OUT.read_text().splitlines()
    # Filter out non-tick-event garbage (Python tracebacks dumped from gate failures, etc).
    # Keep only lines starting with "[YYYY-MM-DDT" or specific known prefixes.
    lines = []
    for line in raw:
        if _TICK_LINE.match(line):
            lines.append(line)
        elif line.startswith("sent id=") or line.startswith("go=") or line.startswith("[Hook"):
            lines.append(line)
        # else: drop tracebacks, indented continuation lines, etc.
    if since:
        try:
            cutoff = _parse_iso(since)
            kept = []
            for line in lines:
                m = _TICK_LINE.match(line)
                if not m:
                    continue
                try:
                    ts = _parse_iso(m.group("ts"))
                except Exception:
                    continue
                if ts > cutoff:
                    kept.append(line)
            return {"lines": kept[-tail:]}
        except Exception:
            pass
    return {"lines": lines[-tail:]}


@router.post("/missions/{name}/fire")
async def fire(name: str):
    if not (MISSIONS_ROOT / name).exists():
        raise HTTPException(404, "mission not found")
    if not RUNNER_SH.exists():
        raise HTTPException(503, "runner.sh not present")
    subprocess.Popen(
        ["setsid", "nohup", str(RUNNER_SH), name],
        stdout=open(CRON_OUT, "ab"),
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"status": "fired", "mission": name}


@router.post("/missions/{name}/pause")
async def pause(name: str):
    p = MISSIONS_ROOT / name / "STATUS"
    if not p.parent.exists():
        raise HTTPException(404, "mission not found")
    p.write_text("paused")
    return {"status": "paused", "mission": name}


@router.post("/missions/{name}/resume")
async def resume(name: str):
    p = MISSIONS_ROOT / name / "STATUS"
    if not p.parent.exists():
        raise HTTPException(404, "mission not found")
    p.write_text("active")
    return {"status": "active", "mission": name}


@router.post("/global-pause")
async def global_pause():
    (LOOP_ROOT / "PAUSE").write_text("via dashboard")
    return {"global_pause": True}


@router.delete("/global-pause")
async def global_resume():
    p = LOOP_ROOT / "PAUSE"
    if p.exists():
        p.unlink()
    return {"global_pause": False}


# ============================================================================
# Tokens endpoints (Subsystem A)
# ============================================================================
import json as _json_mod
import os as _os
SESSIONS_DIR = Path(_os.environ.get("REX_LOOP_SESSIONS_DIR", "/home/ubuntu/.hermes/sessions"))
TOTALS_PATH = LOOP_ROOT / "token-totals.json"

import token_scraper


def _ensure_scraped() -> dict:
    """Lazy-scrape if data is older than 60s. Returns latest totals dict."""
    needs = True
    if TOTALS_PATH.exists():
        try:
            data = _json_mod.loads(TOTALS_PATH.read_text())
            last = data.get("last_scraped_at")
            if last:
                last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
                if (datetime.now(timezone.utc) - last_dt).total_seconds() < 60:
                    needs = False
                    return data
        except Exception:
            pass
    return token_scraper.scrape_all(sessions_dir=SESSIONS_DIR, totals_path=TOTALS_PATH)


@router.get("/tokens/today")
async def tokens_today():
    data = _ensure_scraped()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    d = (data.get("by_day") or {}).get(today) or {"in": 0, "out": 0, "by_role": {}}
    return {"in": d["in"], "out": d["out"], "by_role": d.get("by_role", {})}


@router.get("/tokens/total")
async def tokens_total():
    data = _ensure_scraped()
    days = len(data.get("by_day") or {})
    avg_in = (data["lifetime_total_in"] // days) if days else 0
    avg_out = (data["lifetime_total_out"] // days) if days else 0
    return {
        "in": data["lifetime_total_in"], "out": data["lifetime_total_out"],
        "days_running": days, "avg_per_day": {"in": avg_in, "out": avg_out},
    }


@router.get("/tokens/by-role")
async def tokens_by_role():
    data = _ensure_scraped()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    today_by_role = (data.get("by_day") or {}).get(today, {}).get("by_role", {})
    lifetime_by_role = data.get("by_role_lifetime") or {}
    out = {}
    roles = set(today_by_role) | set(lifetime_by_role)
    for r in sorted(roles):
        out[r] = {
            "today": today_by_role.get(r, {"in": 0, "out": 0}),
            "lifetime": lifetime_by_role.get(r, {"in": 0, "out": 0}),
        }
    return out


@router.get("/tokens/by-hour")
async def tokens_by_hour(window: int = 24):
    return token_scraper.by_hour(sessions_dir=SESSIONS_DIR, window_hours=max(1, min(168, window)))


_SECT_RE = re.compile(r"^## (\w[\w \(\)]*)$", re.MULTILINE)


@router.get("/missions/{name}/tickfile/{tick_id}")
async def tickfile(name: str, tick_id: str):
    p = MISSIONS_ROOT / name / "ticks" / f"{tick_id}.md"
    if not p.exists():
        raise HTTPException(404, "tick file not found")
    text = p.read_text()
    sections = []
    matches = list(_SECT_RE.finditer(text))
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections.append({
            "role": m.group(1),
            "body": text[start:end].strip(),
            "started_at": None,
            "ended_at": None,
        })
    return {
        "path": str(p),
        "mtime": p.stat().st_mtime,
        "size": p.stat().st_size,
        "sections": sections,
    }


# ============================================================================
# Kanban endpoints (Subsystem C)
# ============================================================================
KANBAN_ROOT = Path(_os.environ.get("REX_LOOP_KANBAN_ROOT", "/home/ubuntu/.hermes/kanban"))

import kanban_store
from pydantic import BaseModel


class CardCreate(BaseModel):
    title: str
    tag: str | None = None
    body: str | None = None


class CardPatch(BaseModel):
    title: str | None = None
    tag: str | None = None
    status: str | None = None
    needs_review: bool | None = None


@router.get("/kanban/cards")
async def kanban_list_cards():
    return kanban_store.list_cards(kanban_dir=KANBAN_ROOT)


@router.post("/kanban/cards")
async def kanban_create_card(payload: CardCreate):
    if not payload.title.strip():
        raise HTTPException(400, "title required")
    return kanban_store.create_card(
        kanban_dir=KANBAN_ROOT, title=payload.title.strip(),
        tag=payload.tag, body=payload.body or "",
    )


@router.patch("/kanban/cards/{card_id}")
async def kanban_patch_card(card_id: str, payload: CardPatch):
    fields = payload.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(400, "no fields to patch")
    try:
        if "status" in fields:
            new_status = fields.pop("status")
            return kanban_store.update_status(
                kanban_dir=KANBAN_ROOT, card_id=card_id,
                new_status=new_status, actor="ui", **fields,
            )
        return kanban_store.update_card(
            kanban_dir=KANBAN_ROOT, card_id=card_id, actor="ui", **fields,
        )
    except FileNotFoundError:
        raise HTTPException(404, "card not found")
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/kanban/cards/{card_id}")
async def kanban_delete_card(card_id: str):
    kanban_store.delete_card(kanban_dir=KANBAN_ROOT, card_id=card_id, actor="ui")
    return {"deleted": card_id}


# ============================================================================
# PM endpoints (Subsystem D)
# ============================================================================
import pm_status


@router.get("/pm/status")
async def pm_status_endpoint():
    log = KANBAN_ROOT / "pm.log"
    pause = KANBAN_ROOT / "PM_PAUSE"
    auto = KANBAN_ROOT / "AUTO_FLOW"
    s = pm_status.read_status(log_path=log, pause_flag=pause)
    s["today"] = pm_status.today_stats(log_path=log)
    s["auto_flow"] = auto.exists()
    return s


@router.post("/pm/pause")
async def pm_pause():
    KANBAN_ROOT.mkdir(parents=True, exist_ok=True)
    (KANBAN_ROOT / "PM_PAUSE").write_text("via dashboard")
    return {"paused": True}


@router.post("/pm/resume")
async def pm_resume():
    p = KANBAN_ROOT / "PM_PAUSE"
    if p.exists():
        p.unlink()
    return {"paused": False}


@router.post("/pm/auto-flow")
async def pm_auto_flow_on():
    KANBAN_ROOT.mkdir(parents=True, exist_ok=True)
    (KANBAN_ROOT / "AUTO_FLOW").write_text("on")
    return {"auto_flow": True}


@router.delete("/pm/auto-flow")
async def pm_auto_flow_off():
    p = KANBAN_ROOT / "AUTO_FLOW"
    if p.exists():
        p.unlink()
    return {"auto_flow": False}


# ============================================================================
# Kanban promote endpoint (Subsystem D-Integration placeholder)
# ============================================================================
PROMOTE_SCRIPT = Path(_os.environ.get(
    "REX_LOOP_PROMOTE_SCRIPT", "/home/ubuntu/.hermes/loop/promote_card.sh"
))


@router.post("/kanban/cards/{card_id}/promote")
async def kanban_promote(card_id: str):
    try:
        card = kanban_store.get_card(kanban_dir=KANBAN_ROOT, card_id=card_id)
    except FileNotFoundError:
        raise HTTPException(404, "card not found")
    if card["status"] != "backlog":
        raise HTTPException(400, f"card status is {card['status']}, must be 'backlog'")
    if not PROMOTE_SCRIPT.exists():
        raise HTTPException(503, "promote script not installed")
    rc = subprocess.run([str(PROMOTE_SCRIPT), card_id], capture_output=True, text=True, timeout=30)
    if rc.returncode != 0:
        raise HTTPException(500, f"promote failed: {rc.stderr.strip()[:200]}")
    return {"promoted": card_id, "stdout": rc.stdout.strip()}


# ============================================================================
# STREAMS
# ============================================================================

@router.get("/streams")
async def streams_list(status: str | None = Query(None),
                       kind: str | None = Query(None)):
    return stream_registry.list_streams(status=status, kind=kind)


from fastapi.responses import StreamingResponse
from fastapi import Header
import sse


@router.get("/streams/{stream_id}/events")
async def streams_events(stream_id: str,
                         snapshot: int = Query(200, ge=1, le=2000),
                         follow: bool = Query(True),
                         last_event_id: str | None = Header(None,
                                                            alias="Last-Event-Id")):
    entries = stream_registry.list_streams()
    entry = next((s for s in entries if s["id"] == stream_id), None)
    if entry is None:
        raise HTTPException(404, "stream not found")
    log_path = Path(entry["log_path"])

    since_id = None
    if last_event_id and last_event_id.isdigit():
        since_id = int(last_event_id)

    def gen():
        # Snapshot or replay
        if since_id is None:
            # Initial snapshot batch as a single event
            snap_lines = list(sse.tail_file_lines(
                log_path, snapshot_lines=snapshot,
                since_id=None, follow=False))
            if snap_lines:
                payload = _json_mod.dumps({
                    "lines": [{"id": i, "text": t} for i, t in snap_lines],
                })
                yield sse.format_event(event="snapshot", data=payload,
                                       event_id=snap_lines[-1][0])
            start_after = snap_lines[-1][0] if snap_lines else None
        else:
            start_after = since_id

        # Status check before opening tail loop — completed streams short-circuit
        if entry["status"] != "running":
            # Replay any new lines past start_after, then emit status, close.
            if start_after is not None:
                for i, t in sse.tail_file_lines(log_path,
                                                snapshot_lines=0,
                                                since_id=start_after,
                                                follow=False):
                    yield sse.format_event(event="line",
                                           data=_json_mod.dumps({"id": i, "text": t}),
                                           event_id=i)
            yield sse.format_event(
                event="status",
                data=_json_mod.dumps({"status": entry["status"],
                                      "exit_code": entry.get("exit_code")}),
                event_id=None)
            return

        # Honor follow=false for running streams — caller wants a snapshot only.
        if not follow:
            return

        # Live tail. Heartbeat every 25s by yielding from a wrapper.
        import time as _time
        last_heartbeat = _time.time()
        for i, t in sse.tail_file_lines(log_path,
                                         snapshot_lines=0,
                                         since_id=start_after,
                                         follow=True):
            if i == 0:  # heartbeat sentinel from idle tick
                if _time.time() - last_heartbeat > 25:
                    yield ": keepalive\n\n"
                    last_heartbeat = _time.time()
            else:
                yield sse.format_event(event="line",
                                       data=_json_mod.dumps({"id": i, "text": t}),
                                       event_id=i)
                last_heartbeat = _time.time()  # any line resets heartbeat clock
            # Re-check status to see if stream has ended (every iteration is fine —
            # idle ticks happen at 1s, so this is at most 1Hz registry reads on quiet
            # streams)
            latest = stream_registry.list_streams()
            latest_entry = next((s for s in latest if s["id"] == stream_id),
                                None)
            if latest_entry and latest_entry["status"] != "running":
                yield sse.format_event(
                    event="status",
                    data=_json_mod.dumps({"status": latest_entry["status"],
                                          "exit_code": latest_entry.get("exit_code")}),
                    event_id=None)
                return

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ============================================================================
# Manual-fire endpoints (§6)
# ============================================================================
PM_RUNNER = Path(os.environ.get("REX_PM_RUNNER",
                                "/home/ubuntu/.hermes/loop/pm_runner.sh"))
AI_BRIEF_RUNNER = Path(os.environ.get(
    "REX_AI_BRIEF_RUNNER",
    "/home/ubuntu/.hermes/missions/ai-brief/run-brief.sh"))
GLOBAL_PAUSE_FILE = LOOP_ROOT / "PAUSE"


def _fire_runner(*, kind: str, runner_path: Path,
                 log_dir: Path, instance: str = "manual",
                 model_hint: str = "unknown") -> dict:
    if GLOBAL_PAUSE_FILE.exists():
        raise HTTPException(409, "global_pause_active")
    if not runner_path.exists():
        raise HTTPException(503, f"{kind} runner missing at {runner_path}")
    # Idempotency: if a run of this kind is already in flight, return its id.
    existing = stream_registry.list_streams(status="running", kind=kind)
    if existing:
        e = existing[0]
        return {"stream_id": e["id"], "status": "already_running",
                "pid": e.get("pid")}
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    stream_id = f"{kind}:{instance}:{ts}"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{instance}_{ts}.stream.log"
    log_path.touch()

    env = {**os.environ,
           "REX_STREAM_ID": stream_id,
           "REX_STREAM_LOG_PATH": str(log_path)}
    log_fh = open(log_path, "a")
    try:
        proc = subprocess.Popen(
            ["/bin/bash", str(runner_path)],
            stdout=log_fh, stderr=subprocess.STDOUT,
            env=env, start_new_session=True)
    finally:
        log_fh.close()  # subprocess holds its own fd; close our copy (fd-leak fix)
    stream_registry.register(stream_id=stream_id, kind=kind,
                             instance=instance, log_path=str(log_path),
                             pid=proc.pid, model_hint=model_hint)
    return {"stream_id": stream_id, "status": "started", "pid": proc.pid}


@router.post("/pm/fire")
async def pm_fire():
    return _fire_runner(
        kind="pm", runner_path=PM_RUNNER,
        log_dir=Path(os.environ.get("REX_KANBAN_ROOT",
                                    "/home/ubuntu/.hermes/kanban")) / "streams",
        model_hint="gemma")


@router.post("/ai-brief/fire")
async def ai_brief_fire():
    return _fire_runner(
        kind="ai-brief", runner_path=AI_BRIEF_RUNNER,
        log_dir=AI_BRIEF_RUNNER.parent / "streams",
        model_hint="mixed")


# ============================================================================
# Telegram session endpoints (§5.5)
# ============================================================================
SESSIONS_ROOT = Path(_os.environ.get("REX_SESSIONS_ROOT",
                                     "/home/ubuntu/.hermes/sessions"))


@router.get("/telegram/recent")
async def telegram_recent(limit: int = Query(20, ge=1, le=200)):
    if not SESSIONS_ROOT.exists():
        return []
    files = sorted(SESSIONS_ROOT.glob("*.jsonl"),
                   key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    out = []
    for f in files:
        out.append({
            "id": f.stem,
            "path": str(f),
            "size": f.stat().st_size,
            "modified_at": datetime.fromtimestamp(
                f.stat().st_mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
    return out


@router.get("/telegram/{session_id}/turns")
async def telegram_turns(session_id: str,
                         since: str | None = Query(None)):
    f = SESSIONS_ROOT / f"{session_id}.jsonl"
    # Reject path-traversal attempts — must resolve inside SESSIONS_ROOT.
    if not f.resolve().is_relative_to(SESSIONS_ROOT.resolve()):
        raise HTTPException(400, "invalid session id")
    if not f.exists():
        raise HTTPException(404, "session not found")
    out = []
    for line in f.read_text().splitlines():
        if not line.strip():
            continue
        try:
            o = _json_mod.loads(line)
        except _json_mod.JSONDecodeError:
            continue
        if o.get("role") in ("session_meta",):
            continue
        if since and o.get("timestamp", "") <= since:
            continue
        out.append(o)
    return out
