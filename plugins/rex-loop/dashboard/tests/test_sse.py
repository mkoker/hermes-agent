"""Tests for sse.tail_file()."""
import asyncio
import threading
import time
from pathlib import Path

import pytest

from sse import tail_file_lines, format_event


def test_format_event_data_only():
    out = format_event(event=None, data="hello", event_id=None)
    assert out == "data: hello\n\n"


def test_format_event_with_event_and_id():
    out = format_event(event="line", data='{"ts":"x"}', event_id=42)
    assert out == 'event: line\nid: 42\ndata: {"ts":"x"}\n\n'


def test_tail_file_lines_snapshots_existing(tmp_path):
    f = tmp_path / "x.log"
    f.write_text("line1\nline2\nline3\n")
    out = list(tail_file_lines(f, snapshot_lines=10, since_id=None,
                                follow=False))
    assert out == [(1, "line1"), (2, "line2"), (3, "line3")]


def test_tail_file_lines_since_id_skips_seen(tmp_path):
    f = tmp_path / "x.log"
    f.write_text("a\nb\nc\nd\n")
    out = list(tail_file_lines(f, snapshot_lines=10, since_id=2,
                                follow=False))
    assert out == [(3, "c"), (4, "d")]


def test_tail_file_lines_snapshot_caps_at_n(tmp_path):
    f = tmp_path / "x.log"
    f.write_text("\n".join(f"l{i}" for i in range(100)) + "\n")
    out = list(tail_file_lines(f, snapshot_lines=5, since_id=None,
                                follow=False))
    assert len(out) == 5
    assert out[0] == (96, "l95")
    assert out[-1] == (100, "l99")
