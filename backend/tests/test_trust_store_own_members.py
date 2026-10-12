"""ownMembers stays bounded under token rotation and sign-out/sign-in (C1 review N1b), and a
new member pin respects the KC2R-1 reserve.

The member pins live in the Keychain trust record, whose size is bounded by what one
`security -i` line can carry (cloud_secrets). Before forget_own_member every rotation and
every sign-in added an entry, so with a few paired devices the room KC2R-1 reserves for
deciding about them (blocking above all) ran out within months.
"""

import copy
import json

import pytest

from agent_team_backend import cloud_secrets, trust_store
from agent_team_backend.server_link import ServerLink

from .test_server_link_pin_bounds import KEYCHAIN_ONLY, store_mode  # noqa: F401 - store_mode is a fixture
from .test_trust_store_capacity import KEY, _device, keychain  # noqa: F401 - keychain is a fixture

URL = "wss://server.navide.dev/ws"
MEMBER = "m-0123456789ab"  # the server's newId("m"): m- and 12 hex


def _own_members() -> dict:
    with trust_store._lock:
        return dict(trust_store._load_locked()["ownMembers"])


def _core_len() -> int:
    with trust_store._lock:
        core = json.dumps(trust_store._core_of(trust_store._load_locked()), ensure_ascii=False, separators=(",", ":"))
    return len(cloud_secrets._command(trust_store._vault(), trust_store.SECRET_NAME, core).encode())


def _another_pairing_fits() -> bool:
    with trust_store._lock:
        state = copy.deepcopy(trust_store._load_locked())
        state["pins"][_device(0xFFFFFFFFFF)] = {"signKey": KEY, "encKey": "b" * 64,
                                                "memberId": "m-ffffffffffff", "at": 1760000000, "approved": True}
        return trust_store._fits_with_reserve_locked(state)


async def test_rotations_and_sign_ins_keep_the_member_pins_bounded(keychain):  # noqa: F811
    trust_store.load()
    trust_store.adopt_own_member(URL, "tok-signin", MEMBER)
    for n in range(3):
        trust_store.pin_paired_device(_device(n), sign_key=KEY, enc_key="b" * 64, member_id=f"m-{n:012x}")
    baseline = _core_len()

    current = "tok-signin"
    for r in range(200):                      # rotations, as ServerLink does them
        new = f"nvd_rotated-{r:04d}"
        trust_store.adopt_own_member(URL, new, MEMBER)          # pinned before the confirm
        await ServerLink._forget_retired_pin(URL, current, new)  # after the confirm
        current = new
    for m in range(20):                       # sign out, sign in again
        trust_store.forget_own_member(URL, current)
        current = f"tok-signin-{m:02d}"
        trust_store.adopt_own_member(URL, current, MEMBER)

    owners = _own_members()
    assert len(owners) == 1 and list(owners.values()) == [MEMBER]
    assert trust_store.member_for_credential(URL, current) == MEMBER
    assert _core_len() == baseline
    with trust_store._lock:
        assert trust_store._fits_with_reserve_locked(trust_store._load_locked())
    assert _another_pairing_fits()
    assert keychain.longest <= cloud_secrets.SECURITY_LINE_MAX_BYTES


@KEYCHAIN_ONLY  # fills the record: a sealed file has no 4095-byte line to fill
def test_a_new_member_pin_that_would_eat_the_reserve_is_refused(keychain):  # noqa: F811
    """KC2R-1 for ownMembers: when the record has no room left for a new pin and the
    reserve, the pin is refused as full and nothing is kept; an existing pin still answers."""
    trust_store.load()
    trust_store.adopt_own_member(URL, "tok-signin", MEMBER)
    vault = trust_store._vault()
    diagnosis = (f"vault macos={vault._is_macos} service={vault.app_secret_service(trust_store.SECRET_NAME)!r} "
                 f"limit={cloud_secrets.SECURITY_LINE_MAX_BYTES}")
    for n in range(trust_store.MAX_DEVICES):
        try:
            trust_store.pin_paired_device(_device(n), sign_key=KEY, enc_key="b" * 64, member_id=f"m-{n:012x}")
        except trust_store.TrustStoreFull:
            break
    assert n < trust_store.MAX_DEVICES - 1, f"the record never filled ({diagnosis} bytes={_core_len()})"
    # A device pin is larger than a member pin, so a few member pins may still fit; keep
    # pinning new tokens (as unforgotten rotations would) until one is refused.
    refused = None
    for k in range(200):
        before = _own_members()
        try:
            trust_store.adopt_own_member(URL, f"nvd_rotated-{k:03d}", MEMBER)
        except trust_store.TrustStoreFull:
            refused = f"nvd_rotated-{k:03d}"
            break
    assert refused is not None, f"a member pin was never refused ({diagnosis} bytes={_core_len()})"
    assert _own_members() == before                       # nothing kept from the refused pin
    assert trust_store.member_for_credential(URL, refused) == ""
    with trust_store._lock:
        assert trust_store._fits_with_reserve_locked(trust_store._load_locked())   # the reserve survived
    assert trust_store.adopt_own_member(URL, "tok-signin", MEMBER) == MEMBER        # an existing pin answers
