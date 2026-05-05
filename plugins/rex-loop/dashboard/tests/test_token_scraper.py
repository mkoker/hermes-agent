import sys
from pathlib import Path

PLUGIN_DIR = Path("/home/ubuntu/.hermes/hermes-agent/plugins/rex-loop/dashboard")
sys.path.insert(0, str(PLUGIN_DIR))


def test_extract_usage_codex_shape():
    from token_scraper import extract_usage
    msg = {"role": "assistant", "usage": {"input_tokens": 100, "output_tokens": 50}}
    assert extract_usage(msg) == (100, 50)


def test_extract_usage_no_usage_block():
    from token_scraper import extract_usage
    assert extract_usage({"role": "assistant"}) == (0, 0)
    assert extract_usage({"role": "assistant", "usage": None}) == (0, 0)


def test_extract_usage_openai_shape():
    from token_scraper import extract_usage
    msg = {"role": "assistant", "usage": {"prompt_tokens": 200, "completion_tokens": 80}}
    assert extract_usage(msg) == (200, 80)


def test_extract_usage_llamacpp_completion_shape():
    from token_scraper import extract_usage
    msg = {"role": "assistant", "usage": {"prompt_eval_count": 300, "eval_count": 120}}
    assert extract_usage(msg) == (300, 120)


def test_extract_usage_unknown_shape_returns_zero():
    from token_scraper import extract_usage
    msg = {"role": "assistant", "usage": {"foo": 1, "bar": 2}}
    assert extract_usage(msg) == (0, 0)


def test_session_role_from_metadata(tmp_path):
    from token_scraper import session_role, sum_session_tokens
    sess = {
        "session_id": "abc",
        "model": "claude-sonnet-4-6",
        "metadata": {"profile": "coder"},
        "messages": [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "usage": {"input_tokens": 100, "output_tokens": 50}},
            {"role": "assistant", "usage": {"input_tokens": 200, "output_tokens": 80}},
        ],
    }
    assert session_role(sess) == "coder"
    assert sum_session_tokens(sess) == (300, 130)


def test_session_role_falls_back_to_model_family():
    from token_scraper import session_role
    assert session_role({"model": "claude-sonnet-4-6"}) == "codex"
    assert session_role({"model": "qwen3.6-35b-a3b"}) == "local"
    assert session_role({"model": ""}) == "unknown"


def test_sum_session_tokens_ignores_user_messages():
    from token_scraper import sum_session_tokens
    sess = {"messages": [
        {"role": "user", "usage": {"input_tokens": 999, "output_tokens": 999}},
        {"role": "assistant", "usage": {"input_tokens": 10, "output_tokens": 5}},
    ]}
    assert sum_session_tokens(sess) == (10, 5)

import json


def _make_session(tmp_path, sid, model, messages, started="2026-05-04T12:00:00Z", profile=None):
    """Helper: write a session JSON to tmp_path/sessions/."""
    sd = tmp_path / "sessions"
    sd.mkdir(exist_ok=True)
    sess = {
        "session_id": sid, "model": model, "session_start": started,
        "messages": messages,
    }
    if profile:
        sess["metadata"] = {"profile": profile}
    p = sd / f"session_{sid}.json"
    p.write_text(json.dumps(sess))
    return p


def test_scrape_all_aggregates_by_day_and_role(tmp_path):
    from token_scraper import scrape_all
    _make_session(tmp_path, "a", "claude-sonnet-4-6",
                  [{"role": "assistant", "usage": {"input_tokens": 100, "output_tokens": 50}}],
                  started="2026-05-04T12:00:00Z", profile="coder")
    _make_session(tmp_path, "b", "qwen3.6-35b",
                  [{"role": "assistant", "usage": {"prompt_tokens": 200, "completion_tokens": 80}}],
                  started="2026-05-04T13:00:00Z", profile="researcher")
    _make_session(tmp_path, "c", "claude-sonnet-4-6",
                  [{"role": "assistant", "usage": {"input_tokens": 50, "output_tokens": 25}}],
                  started="2026-05-05T08:00:00Z", profile="coder")

    totals_path = tmp_path / "token-totals.json"
    result = scrape_all(sessions_dir=tmp_path / "sessions", totals_path=totals_path)

    assert result["lifetime_total_in"] == 350
    assert result["lifetime_total_out"] == 155
    assert result["by_day"]["2026-05-04"]["in"] == 300
    assert result["by_day"]["2026-05-04"]["out"] == 130
    assert result["by_day"]["2026-05-04"]["by_role"]["coder"]["in"] == 100
    assert result["by_day"]["2026-05-04"]["by_role"]["researcher"]["in"] == 200
    assert result["by_day"]["2026-05-05"]["in"] == 50
    assert totals_path.exists()


def test_scrape_all_is_incremental(tmp_path):
    from token_scraper import scrape_all
    _make_session(tmp_path, "a", "claude", [{"role": "assistant", "usage": {"input_tokens": 100, "output_tokens": 50}}])
    totals_path = tmp_path / "token-totals.json"
    r1 = scrape_all(sessions_dir=tmp_path / "sessions", totals_path=totals_path)
    assert r1["lifetime_total_in"] == 100
    # Run again — should NOT double-count
    r2 = scrape_all(sessions_dir=tmp_path / "sessions", totals_path=totals_path)
    assert r2["lifetime_total_in"] == 100
    # Add a new session
    _make_session(tmp_path, "b", "claude", [{"role": "assistant", "usage": {"input_tokens": 200, "output_tokens": 100}}])
    r3 = scrape_all(sessions_dir=tmp_path / "sessions", totals_path=totals_path)
    assert r3["lifetime_total_in"] == 300
