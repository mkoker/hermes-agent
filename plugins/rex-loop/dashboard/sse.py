"""SSE helpers: file tailing + event formatting.

tail_file_lines() yields (line_id, text) tuples — line_id is the 1-based
line number, used as SSE id for Last-Event-Id resume support.
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Iterator


def format_event(*, event: str | None, data: str,
                 event_id: int | None) -> str:
    """Format an SSE message frame."""
    lines = []
    if event is not None:
        lines.append(f"event: {event}")
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"data: {data}")
    return "\n".join(lines) + "\n\n"


def tail_file_lines(path: Path, *, snapshot_lines: int,
                    since_id: int | None,
                    follow: bool,
                    stop_event: "threading.Event | None" = None) -> Iterator[tuple[int, str]]:
    """Yield (line_id, text). Snapshot first, then optionally follow.

    - If since_id is None: yield up to last `snapshot_lines` lines.
    - If since_id is N: yield lines with id > N (full read).
    - Yields stripped lines (no trailing \\n).
    - When follow=True: blocks via watchfiles until new lines append.
      Pass stop_event to interrupt the follow loop (used for client-disconnect
      cleanup in SSE callers). When stop_event is set, the generator exits
      cleanly on the next file event or rust_timeout (1s).
    - File must exist at call time; created-later files are not detected.
    """
    if not path.exists():
        return

    with path.open("r", errors="replace") as f:
        lines = f.read().splitlines()
    total = len(lines)

    if since_id is not None:
        start = max(0, since_id)
        for i, line in enumerate(lines[start:], start=start + 1):
            yield (i, line)
        last_id = total
    else:
        start = max(0, total - snapshot_lines)
        for i, line in enumerate(lines[start:], start=start + 1):
            yield (i, line)
        last_id = total

    if not follow:
        return

    # Tail mode — use watchfiles
    from watchfiles import watch  # lazy import
    for changes in watch(str(path), stop_event=stop_event,
                         rust_timeout=1000, yield_on_timeout=False):
        # Re-read tail past last_id
        with path.open("r", errors="replace") as f:
            new = f.read().splitlines()
        for i, line in enumerate(new[last_id:], start=last_id + 1):
            yield (i, line)
        last_id = len(new)
