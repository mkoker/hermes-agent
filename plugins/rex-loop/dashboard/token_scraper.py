"""Scrape Hermes session JSONs for token usage. Roll up by date and role."""
from __future__ import annotations


def extract_usage(msg: dict) -> tuple[int, int]:
    """Return (input_tokens, output_tokens) from one assistant message.

    Recognizes three shapes:
      - Codex/Claude: {"input_tokens": ..., "output_tokens": ...}
      - OpenAI/llama-server: {"prompt_tokens": ..., "completion_tokens": ...}
      - llama.cpp /completion: {"prompt_eval_count": ..., "eval_count": ...}
    Returns (0, 0) for missing or unrecognized shapes.
    """
    u = msg.get("usage") or {}
    if not isinstance(u, dict):
        return (0, 0)
    if "input_tokens" in u:
        return (int(u.get("input_tokens", 0)), int(u.get("output_tokens", 0)))
    if "prompt_tokens" in u:
        return (int(u.get("prompt_tokens", 0)), int(u.get("completion_tokens", 0)))
    if "prompt_eval_count" in u:
        return (int(u.get("prompt_eval_count", 0)), int(u.get("eval_count", 0)))
    return (0, 0)


KNOWN_ROLES = {"researcher", "planner", "coder", "tester", "synthesizer", "pm"}


def session_role(sess: dict) -> str:
    """Return the role this session ran as.

    Preference order:
      1. metadata.profile if it's a known loop role
      2. model family heuristic ('claude'/'gpt' → codex, 'qwen'/'gemma'/'llama' → local)
      3. 'unknown'
    """
    meta = sess.get("metadata") or {}
    prof = (meta.get("profile") or "").lower()
    if prof in KNOWN_ROLES:
        return prof
    model = (sess.get("model") or "").lower()
    if any(k in model for k in ("claude", "gpt", "o1", "o3")):
        return "codex"
    if any(k in model for k in ("qwen", "gemma", "llama", "mistral", "phi", "kimi", "deepseek")):
        return "local"
    return "unknown"


def sum_session_tokens(sess: dict) -> tuple[int, int]:
    """Sum (input, output) tokens across all assistant messages in the session."""
    total_in = total_out = 0
    for msg in sess.get("messages") or []:
        if msg.get("role") != "assistant":
            continue
        i, o = extract_usage(msg)
        total_in += i
        total_out += o
    return (total_in, total_out)

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path


def _empty_totals() -> dict:
    return {
        "lifetime_total_in": 0,
        "lifetime_total_out": 0,
        "by_day": {},
        "by_role_lifetime": {},
        "scraped_session_ids": [],
        "last_scraped_at": None,
    }


def _empty_role() -> dict:
    return {"in": 0, "out": 0}


def _session_date(sess: dict) -> str:
    """YYYY-MM-DD UTC from session_start ISO field."""
    s = sess.get("session_start") or sess.get("started_at") or ""
    if not s:
        return "unknown"
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return "unknown"


def _prune_old_session_ids(ids: list[str], keep_days: int = 90) -> list[str]:
    """Drop session IDs older than keep_days (best-effort timestamp parse)."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=keep_days)
    kept = []
    for sid in ids:
        # session IDs look like "20260427_174208_cf67aa37" — try date parse
        try:
            ts = datetime.strptime(sid[:8], "%Y%m%d").replace(tzinfo=timezone.utc)
            if ts >= cutoff:
                kept.append(sid)
        except Exception:
            kept.append(sid)
    return kept


def scrape_all(*, sessions_dir: Path, totals_path: Path) -> dict:
    """Incrementally scan sessions_dir, update totals_path, return latest totals."""
    sessions_dir = Path(sessions_dir)
    totals_path = Path(totals_path)
    if totals_path.exists():
        try:
            data = json.loads(totals_path.read_text())
        except json.JSONDecodeError:
            data = _empty_totals()
    else:
        data = _empty_totals()

    seen: set[str] = set(data.get("scraped_session_ids") or [])

    if not sessions_dir.exists():
        data["last_scraped_at"] = datetime.now(timezone.utc).isoformat()
        totals_path.write_text(json.dumps(data, indent=2, sort_keys=True))
        return data

    for p in sorted(sessions_dir.glob("session_*.json")):
        sid = p.stem.replace("session_", "")
        if sid in seen:
            continue
        try:
            sess = json.loads(p.read_text())
        except Exception:
            continue
        ti, to = sum_session_tokens(sess)
        if ti == 0 and to == 0:
            seen.add(sid)
            continue
        role = session_role(sess)
        day = _session_date(sess)

        data["lifetime_total_in"] += ti
        data["lifetime_total_out"] += to

        d = data["by_day"].setdefault(day, {"in": 0, "out": 0, "by_role": {}})
        d["in"] += ti
        d["out"] += to
        r = d["by_role"].setdefault(role, _empty_role())
        r["in"] += ti
        r["out"] += to

        rl = data["by_role_lifetime"].setdefault(role, _empty_role())
        rl["in"] += ti
        rl["out"] += to

        seen.add(sid)

    data["scraped_session_ids"] = _prune_old_session_ids(sorted(seen))
    data["last_scraped_at"] = datetime.now(timezone.utc).isoformat()
    totals_path.write_text(json.dumps(data, indent=2, sort_keys=True))
    return data
