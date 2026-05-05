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
