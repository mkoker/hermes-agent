"""Scrape Hermes session JSONs for token usage. Roll up by date and role."""
from __future__ import annotations


def extract_usage(msg: dict) -> tuple[int, int]:
    """Return (input_tokens, output_tokens) from one assistant message."""
    u = msg.get("usage") or {}
    if not isinstance(u, dict):
        return (0, 0)
    if "input_tokens" in u:
        return (int(u.get("input_tokens", 0)), int(u.get("output_tokens", 0)))
    return (0, 0)
