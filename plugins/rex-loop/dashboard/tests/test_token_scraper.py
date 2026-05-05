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
