"""An unreadable journal is never overwritten as if it were empty (review KC-3).

`_read_journal` used to treat "no file", "could not read it" and "read it but it
is garbage" alike, as empty — and the next save then replaced a journal that was
only momentarily locked (a Windows sharing violation, an antivirus scan) with an
empty one, losing the notices and the delivered-message ledger for good.
"""

from __future__ import annotations

import errno

import pytest

from agent_team_backend import trust_store


def _restart() -> None:
    with trust_store._lock:
        trust_store._state = None
        trust_store._locked_reason = ""
        trust_store._seen_pending.clear()
        trust_store._seen_last_flush = 0.0
        trust_store._forget_written()
        trust_store._journal_blocked = False
        trust_store._journal_problem = ""


def _seed() -> None:
    trust_store.load()
    for index in range(3):
        trust_store.note_remote_command(f"d{index}", device_name="n", workspace="w", pane_name="p")
    trust_store.note_seen_message("kept")
    trust_store.flush_seen_messages()
    _restart()


@pytest.fixture
def first_read_fails(monkeypatch):
    real = trust_store._read_journal_bytes
    calls = {"n": 0}

    def flaky(path):
        calls["n"] += 1
        if calls["n"] == 1:
            raise PermissionError(errno.EACCES, "sharing violation")
        return real(path)

    monkeypatch.setattr(trust_store, "_read_journal_bytes", flaky)


def test_a_journal_that_could_not_be_read_is_not_overwritten(first_read_fails):
    _seed()
    trust_store.load()
    assert "could not be read" in trust_store.journal_problem()
    trust_store.note_remote_command("d9", device_name="n", workspace="w", pane_name="p")

    _restart()
    assert len(trust_store.notices()) == 4
    assert trust_store.has_seen_message("kept")
    assert trust_store.journal_problem() == ""


def test_a_journal_that_stays_unreadable_is_left_alone(monkeypatch):
    _seed()
    before = trust_store._journal_path().read_bytes()

    def refuse(_path):
        raise PermissionError(errno.EACCES, "denied")

    monkeypatch.setattr(trust_store, "_read_journal_bytes", refuse)
    trust_store.load()
    trust_store.note_remote_command("d9", device_name="n", workspace="w", pane_name="p")
    trust_store.note_seen_message("new")
    trust_store.flush_seen_messages()

    assert trust_store._journal_path().read_bytes() == before
    assert trust_store.has_seen_message("new")
    assert trust_store.locked_reason() == ""


def test_a_damaged_journal_is_set_aside_not_erased():
    _seed()
    trust_store._journal_path().write_text("{not json", encoding="utf-8")
    trust_store.load()

    kept = list(trust_store._journal_path().parent.glob(trust_store.JOURNAL_FILENAME + ".damaged-*"))
    assert [path.read_text(encoding="utf-8") for path in kept] == ["{not json"]
    assert "set aside" in trust_store.journal_problem()
    assert trust_store.locked_reason() == ""


def test_no_journal_yet_is_not_a_problem():
    trust_store.load()
    assert trust_store.journal_problem() == ""


def test_the_account_view_is_told_about_the_journal(first_read_fails):
    from tests.test_server_link_trust import _trust_link

    _seed()
    trust_store.load()
    assert _trust_link().network_snapshot()["trustJournalProblem"]
