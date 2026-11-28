"""Nothing credential-shaped lands in navide.db or a memory file. Fake
tokens are assembled at run time so no literal sits in the repo."""

from __future__ import annotations

import pytest

from agent_team_backend.commander_store import CommanderInvalid, CommanderStore
from agent_team_backend.db import Database


def fake_tokens() -> list[str]:
    return ["gh" + "p_" + "Ab1" * 12, "sk-" + "ant-" + "api03-" + "Zx9" * 30]


def stored_bytes(tmp_path) -> bytes:
    out = b""
    for path in tmp_path.rglob("*"):
        if path.is_file():
            out += path.read_bytes()
    return out


@pytest.mark.parametrize("token", fake_tokens())
def test_tokens_in_duty_and_memory_do_not_land(tmp_path, token):
    store = CommanderStore(Database(tmp_path / "navide.db"), memory_root=tmp_path / "commanders")
    c = store.create(name="A", duty=f"use {token} for the bot")
    store.update(c.id, {"duty": f"still {token}"})
    store.append_memory(c.id, f"remember {token}")
    store.write_memory(c.id, store.read_memory(c.id) + token)
    assert token not in store.get(c.id).duty
    assert token not in store.read_memory(c.id)
    assert token.encode() not in stored_bytes(tmp_path)


@pytest.mark.parametrize("token", fake_tokens())
def test_account_id_refuses_a_credential(tmp_path, token):
    store = CommanderStore(Database(tmp_path / "navide.db"), memory_root=tmp_path / "commanders")
    with pytest.raises(CommanderInvalid):
        store.create(name="A", account_id=token)
    c = store.create(name="B", account_id="vault-account-7")
    with pytest.raises(CommanderInvalid):
        store.update(c.id, {"account_id": token})
    assert token.encode() not in stored_bytes(tmp_path)
