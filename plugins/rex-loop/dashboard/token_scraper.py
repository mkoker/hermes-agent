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
