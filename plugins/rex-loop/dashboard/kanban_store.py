# kanban_store.py
"""File-per-card kanban storage. Markdown with YAML-ish frontmatter."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VALID_STATUSES = {"inbox", "scoping", "backlog", "active", "done", "discarded"}

_FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n\n?", re.DOTALL)


def _parse_value(v: str) -> Any:
    v = v.strip()
    if v in ("null", "None", ""):
        return None
    if v == "true":
        return True
    if v == "false":
        return False
    if v.isdigit():
        return int(v)
    return v


def _format_value(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def parse_card(path: Path) -> dict:
    """Read a card markdown file; return dict with frontmatter fields + body."""
    text = Path(path).read_text()
    m = _FRONTMATTER.match(text)
    if not m:
        raise ValueError(f"no frontmatter in {path}")
    fm = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        fm[k.strip()] = _parse_value(v)
    fm["body"] = text[m.end():]
    return fm


def dump_card(path: Path, card: dict) -> None:
    """Write a card dict (frontmatter + body) to a file."""
    fields = ["id", "status", "title", "tag", "created_at", "updated_at",
              "mission_name", "spec_path", "needs_review", "scope_attempts"]
    lines = ["---"]
    for f in fields:
        if f in card:
            lines.append(f"{f}: {_format_value(card[f])}")
    lines.append("---")
    lines.append("")
    body = card.get("body", "")
    out = "\n".join(lines) + body if not body.startswith("\n") else "\n".join(lines) + body
    Path(path).write_text(out)


def _now_iso_local() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _slugify(s: str, maxlen: int = 32) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s.lower()).strip("-")
    return s[:maxlen] or "idea"


def _ensure_dirs(kanban_dir: Path) -> None:
    (kanban_dir / "cards").mkdir(parents=True, exist_ok=True)
    (kanban_dir / "scoping").mkdir(parents=True, exist_ok=True)


def _append_event(kanban_dir: Path, event: dict) -> None:
    p = kanban_dir / "events.jsonl"
    with p.open("a") as f:
        f.write(json.dumps(event, sort_keys=True) + "\n")


def _new_id(title: str) -> str:
    return datetime.now().strftime("%Y-%m-%d") + "-" + _slugify(title)


def create_card(*, kanban_dir: Path, title: str, tag: str | None = None,
                body: str = "", actor: str = "ui") -> dict:
    _ensure_dirs(kanban_dir)
    cid = _new_id(title)
    # collision-resolve with -2/-3/...
    p = kanban_dir / "cards" / f"{cid}.md"
    n = 2
    while p.exists():
        p = kanban_dir / "cards" / f"{cid}-{n}.md"
        n += 1
    cid = p.stem
    now = _now_iso_local()
    card = {
        "id": cid, "status": "inbox", "title": title, "tag": tag,
        "created_at": now, "updated_at": now,
        "mission_name": None, "spec_path": None,
        "needs_review": False, "scope_attempts": 0,
        "body": body or f"# {title}\n",
    }
    dump_card(p, card)
    _append_event(kanban_dir, {
        "ts": now, "card_id": cid, "from": None, "to": "inbox", "actor": actor,
    })
    return card


def list_cards(*, kanban_dir: Path) -> list[dict]:
    _ensure_dirs(kanban_dir)
    out = []
    for p in sorted((kanban_dir / "cards").glob("*.md")):
        try:
            out.append(parse_card(p))
        except Exception:
            continue
    out.sort(key=lambda c: c.get("updated_at") or "", reverse=True)
    return out


def get_card(*, kanban_dir: Path, card_id: str) -> dict:
    p = kanban_dir / "cards" / f"{card_id}.md"
    if not p.exists():
        raise FileNotFoundError(card_id)
    return parse_card(p)


def update_status(*, kanban_dir: Path, card_id: str, new_status: str,
                   actor: str = "ui", **fields) -> dict:
    if new_status not in VALID_STATUSES:
        raise ValueError(f"invalid status: {new_status}")
    p = kanban_dir / "cards" / f"{card_id}.md"
    if not p.exists():
        raise FileNotFoundError(card_id)
    card = parse_card(p)
    old = card.get("status")
    card["status"] = new_status
    card["updated_at"] = _now_iso_local()
    for k, v in fields.items():
        card[k] = v
    dump_card(p, card)
    _append_event(kanban_dir, {
        "ts": card["updated_at"], "card_id": card_id,
        "from": old, "to": new_status, "actor": actor,
    })
    return card


def update_card(*, kanban_dir: Path, card_id: str, actor: str = "ui", **fields) -> dict:
    p = kanban_dir / "cards" / f"{card_id}.md"
    if not p.exists():
        raise FileNotFoundError(card_id)
    card = parse_card(p)
    for k, v in fields.items():
        card[k] = v
    card["updated_at"] = _now_iso_local()
    dump_card(p, card)
    _append_event(kanban_dir, {
        "ts": card["updated_at"], "card_id": card_id,
        "from": card.get("status"), "to": card.get("status"),
        "actor": actor, "fields": list(fields.keys()),
    })
    return card


def delete_card(*, kanban_dir: Path, card_id: str, actor: str = "ui") -> None:
    p = kanban_dir / "cards" / f"{card_id}.md"
    if p.exists():
        p.unlink()
    _append_event(kanban_dir, {
        "ts": _now_iso_local(), "card_id": card_id,
        "from": None, "to": "discarded", "actor": actor,
    })
