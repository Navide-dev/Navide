from __future__ import annotations

import pytest

from agent_team_backend.channels.base import Location
from agent_team_backend.channels.pairing import (
    CODE_ALPHABET,
    CODE_LENGTH,
    CODE_TTL_S,
    MAX_PENDING,
    SenderGate,
    new_code,
)
from agent_team_backend.channels.store import ChannelStore, PairingRequest
from agent_team_backend.db import Database


@pytest.fixture
def store(tmp_path):
    db = Database(tmp_path / "navide.db")
    yield ChannelStore(db)
    db.close()


class Clock:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


def test_code_alphabet_has_no_lookalikes() -> None:
    for ch in "01IO":
        assert ch not in CODE_ALPHABET
    codes = {new_code() for _ in range(200)}
    assert len(codes) > 190
    assert all(len(c) == CODE_LENGTH and set(c) <= set(CODE_ALPHABET) for c in codes)


def test_migration_is_idempotent(tmp_path) -> None:
    db = Database(tmp_path / "n.db")
    ChannelStore(db)
    ChannelStore(db)
    assert db.schema_version("channels") == 6
    db.close()


def test_pairing_reuse_max_and_expiry(store: ChannelStore) -> None:
    clock = Clock()
    gate = SenderGate(store, now=clock)
    first = gate.request_pairing("telegram", "1", "a", "c1")
    assert first.created and first.request
    again = gate.request_pairing("telegram", "1", "a", "c1")
    assert not again.created and again.request.code == first.request.code
    for i in range(2, MAX_PENDING + 1):
        assert gate.request_pairing("telegram", str(i), "x", "c").created
    full = gate.request_pairing("telegram", "99", "x", "c")
    assert full.full and full.request is None
    # Another platform has its own budget.
    assert gate.request_pairing("discord", "99", "x", "c").created
    clock.t += CODE_TTL_S + 1
    assert gate.request_pairing("telegram", "99", "x", "c").created
    assert [r.sender_id for r in store.list_pairing("telegram")] == ["99"]


def test_approve_adds_allow_and_reject_drops(store: ChannelStore) -> None:
    gate = SenderGate(store)
    code = gate.request_pairing("telegram", "7", "alice", "42").request.code
    assert not gate.is_allowed("telegram", "7")
    # Case / separator tolerant.
    req = gate.approve("telegram", f"{code[:4].lower()}-{code[4:]}")
    assert req and req.sender_id == "7"
    assert gate.is_allowed("telegram", "7") and not gate.is_allowed("discord", "7")
    assert gate.approve("telegram", code) is None
    code2 = gate.request_pairing("telegram", "8", "bob", "43").request.code
    assert gate.reject("telegram", code2) is not None
    assert not gate.is_allowed("telegram", "8") and store.list_pairing(None) == []
    assert store.remove_allow("telegram", "7") and not gate.is_allowed("telegram", "7")


def test_expired_code_cannot_be_approved(store: ChannelStore) -> None:
    clock = Clock()
    gate = SenderGate(store, now=clock)
    code = gate.request_pairing("telegram", "7", "alice", "42").request.code
    clock.t += CODE_TTL_S + 1
    assert gate.approve("telegram", code) is None
    assert not gate.is_allowed("telegram", "7")


def test_bindings_are_one_to_one(store: ChannelStore) -> None:
    loc = Location("telegram", "default", "-100", "50", "api")
    store.bind("p1", loc)
    store.bind("p2", loc)  # takes the location over
    assert [b.pane_id for b in store.bindings()] == ["p2"]
    store.bind("p2", Location("telegram", "default", "-100", "51", "b"))
    assert [(b.pane_id, b.thread_id) for b in store.bindings()] == [("p2", "51")]
    assert store.rename_pane("p2", "p3")
    assert store.unbind("p3").thread_id == "51" and store.bindings() == []


def test_offsets_are_discarded_on_bot_change(store: ChannelStore) -> None:
    store.set_offset("telegram", "default", "111", 5)
    assert store.get_offset("telegram", "default", "111") == 5
    assert store.get_offset("telegram", "default", "222") is None
    store.set_offset("telegram", "default", "222", 9)
    assert store.get_offset("telegram", "default", "111") is None


def test_accounts_kill_switch_and_remove(store: ChannelStore) -> None:
    assert store.global_enabled()
    store.set_global_enabled(False)
    assert not store.global_enabled()
    store.upsert_account("telegram", {"group": "-100"})
    store.add_allow("telegram", "7", "a", 1)
    store.bind("p1", Location("telegram", "default", "1"))
    store.set_account_enabled("telegram", False)
    assert store.accounts() == {("telegram", "default"): {"enabled": False, "config": {"group": "-100"}}}
    store.upsert_account("telegram", {"group": "-200"})  # keeps enabled flag
    assert store.accounts()[("telegram", "default")]["enabled"] is False
    store.remove_platform("telegram")
    assert store.accounts() == {} and store.list_allow(None) == [] and store.bindings() == []


def test_v2_seen_chats_survive_the_bot_migration_and_go_to_the_next_bot(tmp_path) -> None:
    from agent_team_backend.channels import store as store_mod
    db = Database(tmp_path / "n.db")
    db.migrate("channels", 1, store_mod._v1)
    db.migrate("channels", 2, store_mod._v2)
    with db.transaction() as cur:
        cur.execute("INSERT INTO channel_chats (platform, chat_id, title, kind, supports_topics, last_seen)"
                    " VALUES ('telegram', '-200', 'team', 'group', 1, 5)")
    s = ChannelStore(db)
    assert db.schema_version("channels") == 6
    assert s.chats("telegram", "bot-a") == []
    assert s.adopt_chats("telegram", "bot-a") == 1
    assert s.chats("telegram", "bot-a") == [
        {"chat_id": "-200", "title": "team", "kind": "group", "supports_topics": True}]
    assert s.adopt_chats("telegram", "bot-b") == 0  # adopted once, by the bot that ran first
    db.close()


def test_two_bots_on_one_platform(store: ChannelStore) -> None:
    store.upsert_account("telegram", {"name": "A"})
    store.upsert_account("telegram", {"name": "B"}, account="bot-b1")
    store.set_account_enabled("telegram", False, "bot-b1")
    assert store.accounts() == {("telegram", "default"): {"enabled": True, "config": {"name": "A"}},
                                ("telegram", "bot-b1"): {"enabled": False, "config": {"name": "B"}}}
    store.bind("p1", Location("telegram", "default", "1"))
    store.bind("p2", Location("telegram", "bot-b1", "1"))  # same chat, other bot: its own location
    store.set_offset("telegram", "bot-b1", "222", 4)
    store.add_allow("telegram", "7", "a", 1)
    store.add_allow("telegram", "8", "b", 1, "bot-b1")
    assert store.is_allowed("telegram", "8", "bot-b1") and not store.is_allowed("telegram", "8")
    store.add_pairing(PairingRequest("telegram", "CODEB111", "9", "c", "9", 1, "bot-b1"))
    store.remove_account("telegram", "bot-b1")
    assert list(store.accounts()) == [("telegram", "default")]
    assert [b.pane_id for b in store.bindings()] == ["p1"]
    assert store.get_offset("telegram", "bot-b1", "222") is None
    assert store.is_allowed("telegram", "7") and not store.is_allowed("telegram", "8", "bot-b1")
    assert store.list_pairing("telegram") == []


def test_v5_keeps_every_v4_account_and_binding_as_default(tmp_path) -> None:
    from agent_team_backend.channels import store as store_mod
    db = Database(tmp_path / "n.db")
    for version, fn in ((1, store_mod._v1), (2, store_mod._v2), (3, store_mod._v3), (4, store_mod._v4)):
        db.migrate("channels", version, fn)
    with db.transaction() as cur:
        cur.execute("INSERT INTO channel_accounts VALUES ('telegram', 0, '{\"group\":\"-100\"}', 9)")
        cur.execute("INSERT INTO channel_bindings (pane_id, platform, account, chat_id, thread_id, title,"
                    " created_at, verbosity) VALUES ('p1', 'telegram', 'default', '-100', '5', 't', 9, 'full')")
        cur.execute("INSERT INTO channel_offsets VALUES ('telegram', 'default', '111', 42)")
        cur.execute("INSERT INTO channel_allow VALUES ('telegram', '7', 'alice', 3)")
        cur.execute("INSERT INTO channel_pairing_requests VALUES ('telegram', 'K7Q2M9XA', '42', 'neil', '42', 4)")
    s = ChannelStore(db)
    assert db.schema_version("channels") == 6
    assert s.accounts() == {("telegram", "default"): {"enabled": False, "config": {"group": "-100"}}}
    [b] = s.bindings()
    assert (b.pane_id, b.location().key(), b.verbosity) == ("p1", "telegram:default:-100:5", "full")
    assert s.get_offset("telegram", "default", "111") == 42
    # Existing approvals and pending requests belong to the default bot, and only to it.
    assert s.is_allowed("telegram", "7") and not s.is_allowed("telegram", "7", "bot-b1")
    assert s.list_allow(None) == [{"platform": "telegram", "account": "default", "sender_id": "7",
                                   "sender_name": "alice", "added_at": 3}]
    assert [(r.code, r.account) for r in s.list_pairing("telegram")] == [("K7Q2M9XA", "default")]
    s.upsert_account("telegram", {}, account="bot-b1")  # the new key takes a second bot
    assert len(s.accounts()) == 2
    db.close()


# Telegram ``from`` ids that stand for many people (anonymous admins, channel posts,
# service messages): no one can be approved as one of them.
TELEGRAM_SHARED = ("1087968824", "136817688", "777000")


@pytest.mark.parametrize("sender", TELEGRAM_SHARED)
def test_telegram_shared_sender_ids_are_never_admitted(store: ChannelStore, sender: str) -> None:
    gate = SenderGate(store)
    # A row written before this rule still admits no one.
    store._exec("INSERT INTO channel_allow (platform, account, sender_id, sender_name, added_at)"
                " VALUES ('telegram', 'default', ?, 'x', 1)", (sender,))
    assert not gate.is_allowed("telegram", sender)
    with pytest.raises(ValueError):
        store.add_allow("telegram", sender, "x", 1)
    # No pairing code is handed out, and an old pending one cannot be approved.
    outcome = gate.request_pairing("telegram", sender, "x", "-100")
    assert outcome.request is None and not outcome.created
    store.add_pairing(PairingRequest("telegram", "ABCD2345", sender, "x", "-100", 1, "default"))
    assert gate.approve("telegram", "ABCD2345") is None
    assert store.list_pairing("telegram") == []
    # The ids are Telegram's: on another platform they are ordinary ids.
    store.add_allow("discord", sender, "x", 1)
    assert gate.is_allowed("discord", sender)


def test_an_empty_sender_gets_no_pairing_code(store: ChannelStore) -> None:
    gate = SenderGate(store)
    outcome = gate.request_pairing("telegram", "", "x", "42")
    assert outcome.request is None and store.list_pairing(None) == []
