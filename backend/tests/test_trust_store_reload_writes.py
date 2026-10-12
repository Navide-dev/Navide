"""The first record-only save after a load (review R2-5).

Loading forgot what the Keychain item held, so the first ledger flush after
every restart rewrote the item; when that write was refused (a locked
keychain) the journal was never reached and the keys were lost to a restart.
"""

from __future__ import annotations

from agent_team_backend import cloud_secrets, trust_store
from agent_team_backend.credential_vault import CredentialVaultError



def _journal_text(path) -> str:
    """The journal as text, through the store's reader — DPAPI-wrapped on
    Windows, and sealed with the record key once the record is in its file."""
    from agent_team_backend import trust_file

    blob = trust_store._read_journal_bytes(path)
    if blob.startswith(trust_file.MAGIC):
        blob = trust_file.unseal(trust_store._record_key, blob, trust_file.AAD_JOURNAL)
    return blob.decode("utf-8")

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
    # Through the store's reader: on Windows the journal is DPAPI-wrapped.
    assert "k-2" in _journal_text(trust_store._journal_path())
