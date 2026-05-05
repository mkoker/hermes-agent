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
