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
import json as _json


def test_create_card_writes_file_and_event(tmp_path):
    from kanban_store import create_card, list_cards
    kanban = tmp_path / "kanban"
    card = create_card(kanban_dir=kanban, title="Test idea", tag="infra")
    assert card["status"] == "inbox"
    assert card["title"] == "Test idea"
    assert (kanban / "cards" / f"{card['id']}.md").exists()
    events = (kanban / "events.jsonl").read_text().strip().splitlines()
    assert len(events) == 1
    e = _json.loads(events[0])
    assert e["card_id"] == card["id"]
    assert e["from"] is None and e["to"] == "inbox"

    cards = list_cards(kanban_dir=kanban)
    assert len(cards) == 1
    assert cards[0]["id"] == card["id"]


def test_update_status_transitions(tmp_path):
    from kanban_store import create_card, update_status, list_cards
    kanban = tmp_path / "kanban"
    c = create_card(kanban_dir=kanban, title="X")
    update_status(kanban_dir=kanban, card_id=c["id"], new_status="scoping", actor="pm")
    update_status(kanban_dir=kanban, card_id=c["id"], new_status="backlog", actor="pm")

    cards = list_cards(kanban_dir=kanban)
    assert cards[0]["status"] == "backlog"
    events = [_json.loads(l) for l in (kanban / "events.jsonl").read_text().splitlines()]
    assert len(events) == 3
    assert [e["to"] for e in events] == ["inbox", "scoping", "backlog"]


def test_update_status_rejects_invalid(tmp_path):
    from kanban_store import create_card, update_status
    import pytest
    kanban = tmp_path / "kanban"
    c = create_card(kanban_dir=kanban, title="X")
    with pytest.raises(ValueError):
        update_status(kanban_dir=kanban, card_id=c["id"], new_status="bogus", actor="ui")


def test_delete_card_removes_file_and_logs(tmp_path):
    from kanban_store import create_card, delete_card, list_cards
    kanban = tmp_path / "kanban"
    c = create_card(kanban_dir=kanban, title="X")
    delete_card(kanban_dir=kanban, card_id=c["id"], actor="ui")
    assert list_cards(kanban_dir=kanban) == []
