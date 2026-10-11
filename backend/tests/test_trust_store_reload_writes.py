"""The first record-only save after a load (review R2-5).

Loading forgot what the Keychain item held, so the first ledger flush after
every restart rewrote the item; when that write was refused (a locked
keychain) the journal was never reached and the keys were lost to a restart.
"""

from __future__ import annotations

from agent_team_backend import cloud_secrets, trust_store
from agent_team_backend.credential_vault import CredentialVaultError


def _restart() -> None:
    with trust_store._lock:
        trust_store._state = None
        trust_store._seen_pending.clear()
        trust_store._seen_last_flush = 0.0
        trust_store._forget_written()


def _seeded() -> None:
    trust_store.load()
    trust_store.note_pairing("dev-a", kind="paired", device_name="TKM5")
    _restart()


def test_a_flush_after_a_reload_does_not_rewrite_the_keychain_item(monkeypatch):
    _seeded()
    writes: list[str] = []
    real = cloud_secrets.write
    monkeypatch.setattr(cloud_secrets, "write", lambda *a, **k: (writes.append(a[1]), real(*a, **k)))
    trust_store.load()
    trust_store.note_seen_message("k-1")
    trust_store.flush_seen_messages()
    assert writes == []


def test_a_refused_keychain_write_still_saves_the_journal(monkeypatch):
    _seeded()
    trust_store.load()
    # A change to the vault half, so the save has to write it, and it fails.
    with trust_store._lock:
        trust_store._state["policySeqs"] = {"x": 1}

    def refuse(*_a, **_k):
        raise CredentialVaultError("keychain is locked")

    monkeypatch.setattr(cloud_secrets, "write", refuse)
    trust_store.note_seen_message("k-2")
    trust_store.flush_seen_messages()
    assert "k-2" in trust_store._journal_path().read_text(encoding="utf-8")
