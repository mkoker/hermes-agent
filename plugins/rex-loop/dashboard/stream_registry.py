"""Append-on-start, patch-on-exit registry for live agent streams.

Single JSON file at ~/.hermes/streams/index.json. Concurrent writes
serialized via flock on ~/.hermes/streams/.lock.
"""
from __future__ import annotations

import fcntl
import json
import os
import warnings
from datetime import datetime, timezone
from pathlib import Path

STREAMS_ROOT = Path(os.environ.get("REX_STREAMS_ROOT",
                                   "/home/ubuntu/.hermes/streams"))
REGISTRY_PATH = STREAMS_ROOT / "index.json"
LOCK_PATH = STREAMS_ROOT / ".lock"


def _now_z() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ensure_root():
    STREAMS_ROOT.mkdir(parents=True, exist_ok=True)
    LOCK_PATH.touch(exist_ok=True)


def _load() -> dict:
    if not REGISTRY_PATH.exists():
        return {"streams": []}
    try:
        return json.loads(REGISTRY_PATH.read_text())
    except json.JSONDecodeError as e:
        warnings.warn(
            f"stream_registry: corrupt index at {REGISTRY_PATH}: {e}; "
            f"returning empty registry. Manual recovery may be needed.",
            RuntimeWarning, stacklevel=2)
        return {"streams": []}


def _save(data: dict) -> None:
    tmp = REGISTRY_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True))
    tmp.replace(REGISTRY_PATH)


def register(*, stream_id: str, kind: str, instance: str,
             log_path: str, pid: int, model_hint: str) -> dict:
    """Add a new running entry. Returns the stored dict."""
    _ensure_root()
    entry = {
        "id": stream_id,
        "kind": kind,
        "instance": instance,
        "log_path": log_path,
        "started_at": _now_z(),
        "ended_at": None,
        "status": "running",
        "exit_code": None,
        "pid": pid,
        "model_hint": model_hint,
    }
    with LOCK_PATH.open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        data = _load()
        data["streams"].append(entry)
        _save(data)
    return entry
