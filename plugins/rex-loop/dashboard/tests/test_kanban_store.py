import sys
from pathlib import Path

PLUGIN_DIR = Path("/home/ubuntu/.hermes/hermes-agent/plugins/rex-loop/dashboard")
sys.path.insert(0, str(PLUGIN_DIR))


def test_parse_card_frontmatter(tmp_path):
    from kanban_store import parse_card
    p = tmp_path / "card.md"
    p.write_text(
        "---\n"
        "id: 2026-05-05-foo\n"
        "status: inbox\n"
        "title: Foo bar\n"
        "tag: ai-brief\n"
        "created_at: 2026-05-05T11:00:00-04:00\n"
        "updated_at: 2026-05-05T11:00:00-04:00\n"
        "scope_attempts: 0\n"
        "needs_review: false\n"
        "---\n\n"
        "# Foo bar\n\nlonger description\n"
    )
    c = parse_card(p)
    assert c["id"] == "2026-05-05-foo"
    assert c["status"] == "inbox"
    assert c["tag"] == "ai-brief"
    assert c["body"] == "# Foo bar\n\nlonger description\n"


def test_dump_card_round_trip(tmp_path):
    from kanban_store import parse_card, dump_card
    p = tmp_path / "card.md"
    card = {
        "id": "x", "status": "inbox", "title": "T", "tag": None,
        "created_at": "2026-05-05T11:00:00-04:00",
        "updated_at": "2026-05-05T11:00:00-04:00",
        "mission_name": None, "spec_path": None,
        "needs_review": False, "scope_attempts": 0,
        "body": "body text\n",
    }
    dump_card(p, card)
    out = parse_card(p)
    assert out["id"] == "x"
    assert out["status"] == "inbox"
    assert out["body"] == "body text\n"
