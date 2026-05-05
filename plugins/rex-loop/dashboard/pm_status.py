# pm_status.py
"""Tail-parse ~/.hermes/kanban/pm.log for live PM trace + today stats."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

_LINE = re.compile(
    r"^\[(?P<ts>[^\]]+)\] \[(?P<card>[^\]]+)\] \[(?P<event>[^\]]+)\](?: (?P<msg>.*))?$"
)


def _parse_line(line: str) -> dict | None:
    m = _LINE.match(line.rstrip("\n"))
    if not m:
        return None
    return {
        "ts": m.group("ts"),
        "card_id": m.group("card"),
        "event": m.group("event"),
        "msg": m.group("msg") or "",
    }


def read_status(*, log_path: Path, pause_flag: Path) -> dict:
    paused = Path(pause_flag).exists()
    log_path = Path(log_path)
    if not log_path.exists():
        return {"state": "idle", "paused": paused, "current": None}

    # Find last scope-start; if a later scope-end for the same card is present, idle.
    lines = log_path.read_text().splitlines()
    parsed = [p for p in (_parse_line(l) for l in lines) if p]
    if not parsed:
        return {"state": "idle", "paused": paused, "current": None}

    last_start_idx = None
    for i in range(len(parsed) - 1, -1, -1):
        if parsed[i]["event"] == "scope-start":
            last_start_idx = i
            break
    if last_start_idx is None:
        return {"state": "idle", "paused": paused, "current": None}

    card = parsed[last_start_idx]["card_id"]
    after = parsed[last_start_idx + 1:]
    if any(p["event"] in ("scope-end", "scope-fail") and p["card_id"] == card for p in after):
        return {"state": "idle", "paused": paused, "current": None}

    trace = [parsed[last_start_idx]] + [p for p in after if p["card_id"] == card]
    return {
        "state": "scoping",
        "paused": paused,
        "current": {
            "card_id": card,
            "started_at": parsed[last_start_idx]["ts"],
            "trace": trace,
        },
    }


def today_stats(*, log_path: Path) -> dict:
    log_path = Path(log_path)
    if not log_path.exists():
        return {"scoped": 0, "fails": 0, "avg_seconds": 0}
    today = datetime.now().strftime("%Y-%m-%d")
    starts: dict[str, str] = {}
    durations: list[float] = []
    scoped = fails = 0
    for line in log_path.read_text().splitlines():
        p = _parse_line(line)
        if not p or not p["ts"].startswith(today):
            continue
        if p["event"] == "scope-start":
            starts[p["card_id"]] = p["ts"]
        elif p["event"] == "scope-end":
            scoped += 1
            if p["card_id"] in starts:
                try:
                    s = datetime.fromisoformat(starts[p["card_id"]])
                    e = datetime.fromisoformat(p["ts"])
                    durations.append((e - s).total_seconds())
                except Exception:
                    pass
        elif p["event"] == "scope-fail":
            fails += 1
    avg = int(sum(durations) / len(durations)) if durations else 0
    return {"scoped": scoped, "fails": fails, "avg_seconds": avg}
