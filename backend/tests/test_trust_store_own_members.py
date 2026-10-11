"""ownMembers stays bounded under token rotation and sign-out/sign-in (C1 review N1b), and a
new member pin respects the KC2R-1 reserve.

The member pins live in the Keychain trust record, whose size is bounded by what one
`security -i` line can carry (cloud_secrets). Before forget_own_member every rotation and
every sign-in added an entry, so with a few paired devices the room KC2R-1 reserves for
deciding about them (blocking above all) ran out within months.
"""

import copy
import json


from agent_team_backend import cloud_secrets, trust_store
from agent_team_backend.server_link import ServerLink

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
