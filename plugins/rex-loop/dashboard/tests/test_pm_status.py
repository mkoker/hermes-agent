# tests/test_pm_status.py
import sys
from pathlib import Path

PLUGIN_DIR = Path("/home/ubuntu/.hermes/hermes-agent/plugins/rex-loop/dashboard")
sys.path.insert(0, str(PLUGIN_DIR))


def test_status_idle_when_no_log(tmp_path):
    from pm_status import read_status
    s = read_status(log_path=tmp_path / "pm.log", pause_flag=tmp_path / "PAUSE")
    assert s["state"] == "idle"
    assert s["paused"] is False
    assert s["current"] is None


def test_status_paused_when_flag_present(tmp_path):
    from pm_status import read_status
    (tmp_path / "PAUSE").write_text("")
    s = read_status(log_path=tmp_path / "pm.log", pause_flag=tmp_path / "PAUSE")
    assert s["paused"] is True


def test_status_active_with_trace(tmp_path):
    from pm_status import read_status
    log = tmp_path / "pm.log"
    log.write_text(
        "[2026-05-05T11:23:00-04:00] [card-x] [scope-end] previous done\n"
        "[2026-05-05T11:24:00-04:00] [card-y] [scope-start] scoping voice clone\n"
        "[2026-05-05T11:24:15-04:00] [card-y] [progress] reading idea\n"
        "[2026-05-05T11:24:30-04:00] [card-y] [progress] proposing name\n"
    )
    s = read_status(log_path=log, pause_flag=tmp_path / "PAUSE")
    assert s["state"] == "scoping"
    assert s["current"]["card_id"] == "card-y"
    assert len(s["current"]["trace"]) >= 3


def test_today_stats_counts_scope_ends(tmp_path):
    from pm_status import today_stats
    from datetime import datetime
    today = datetime.now().strftime("%Y-%m-%d")
    log = tmp_path / "pm.log"
    log.write_text(
        f"[{today}T08:00:00-04:00] [a] [scope-start] x\n"
        f"[{today}T08:02:30-04:00] [a] [scope-end] success\n"
        f"[{today}T09:00:00-04:00] [b] [scope-start] y\n"
        f"[{today}T09:01:00-04:00] [b] [scope-end] success\n"
        f"[{today}T10:00:00-04:00] [c] [scope-fail] invalid spec\n"
    )
    st = today_stats(log_path=log)
    assert st["scoped"] == 2
    assert st["fails"] == 1
    assert 60 <= st["avg_seconds"] <= 200
