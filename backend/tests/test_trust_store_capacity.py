"""A trust record the Keychain cannot hold is refused as full, visibly (KC-2).

The vault half — pins, own members, encrypted peers, policy sequences, blocks —
is still one Keychain item, so `security -i`'s 4095-byte line caps it at about
twenty devices. Moving it out is the file-backed design's job; until then a
change that would not fit is refused *before* anything is written, as
TrustStoreFull, and a pairing that hits it tells the person why.
"""

from __future__ import annotations

import shlex
from types import SimpleNamespace

import pytest

from agent_team_backend import app, device_pairing, trust_store
from agent_team_backend.credential_vault import CredentialVault
from tests.keychain_fake import security_g_output

KEY = "A" * 43 + "="


class _Security:
    def __init__(self) -> None:
        self.items: dict[str, str] = {}
        self.longest = 0

    def __call__(self, args, input_text=None):
        if args == ["-i"]:
            self.longest = max(self.longest, len((input_text or "").rstrip("\n").encode()))
        tokens = shlex.split(input_text) if args == ["-i"] else list(args)
        service = tokens[tokens.index("-s") + 1]
        if tokens[0] == "add-generic-password":
            self.items[service] = tokens[tokens.index("-w") + 1]
            return 0, ""
        if tokens[0] == "find-generic-password":
            return (0, security_g_output(self.items[service])) if service in self.items else (44, "")
        if tokens[0] == "delete-generic-password":
            return (0, "") if self.items.pop(service, None) is not None else (44, "")
        return 1, ""


@pytest.fixture
def keychain(tmp_path, monkeypatch):
    sec = _Security()
    monkeypatch.setattr(app, "credential_vault", CredentialVault(
        root=tmp_path / "r", real_home=tmp_path / "h", security_runner=sec, platform="darwin"))
    return sec


def _device(index: int) -> str:
    return f"4a50baf4-5c26-4785-a792-{index:012x}"


def _fill() -> int:
    trust_store.load()
    for index in range(trust_store.MAX_DEVICES):
        try:
            trust_store.pin_paired_device(_device(index), sign_key=KEY, enc_key="b" * 64,
                                          member_id=f"m-{index:032x}")
        except trust_store.TrustStoreFull:
            return index
    raise AssertionError("the Keychain record never filled up")


def test_a_pin_that_would_not_fit_is_refused_as_full_before_writing(keychain):
    refused_at = _fill()

    assert refused_at > 10
    assert keychain.longest <= 4095
    assert trust_store.pin_for(_device(refused_at)) is None
    trust_store._state = None
    trust_store._forget_written()
    assert trust_store.pin_for(_device(refused_at - 1)) is not None


def test_a_full_record_still_takes_notices_and_the_ledger(keychain):
    _fill()
    trust_store.note_remote_command(_device(0), device_name="TKM5", workspace="w", pane_name="p")
    trust_store.note_seen_message("k-1")
    trust_store.flush_seen_messages()
    trust_store._state = None
    trust_store._forget_written()
    assert trust_store.has_seen_message("k-1")


async def test_a_pairing_that_hits_the_limit_tells_the_person(monkeypatch):
    from tests.test_server_link_trust import _trust_link

    trust_store.load()
    monkeypatch.setattr(device_pairing, "complete", lambda _device_id: SimpleNamespace(
        their_key=KEY, their_enc_key="b" * 64, device_name="TKM5"))

    def full(*_args, **_kwargs):
        raise trust_store.TrustStoreFull("the pairing record is full")

    monkeypatch.setattr(trust_store, "pin_paired_device", full)
    link = _trust_link()

    assert await link._finish_pairing("dev-new", member_id="m1") is False
    notice = next(n for n in trust_store.notices() if n["kind"] == trust_store.NOTICE_PAIRING)
    assert notice["pairing"] == "full" and notice["deviceName"] == "TKM5"
