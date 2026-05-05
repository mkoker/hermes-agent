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

sys.path.insert(0, str(LOOP_ROOT))
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
