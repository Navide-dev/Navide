"""Account auto-repair (D7) never touches the quota path.

usage_service.py and quota_failover.py, minus the login-harvest functions
D7 changes or adds, must read line for line as main had them when D7 was
reviewed (blank lines aside: a removed function leaves some behind). The
switch has no say over this code, so it holds whether D7 is on or off.

A deliberate change to the quota path updates the digest here and says so
in review.
"""

from __future__ import annotations

import ast
import hashlib
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1] / "agent_team_backend"

#: The functions D7 changes (sign-in harvest) or adds; nothing else may differ.
D7_LOGIN_FUNCTIONS = frozenset({
    "_dedupe_harvested_login", "_harvest_login_home_locked", "_slot_secret",
    "_live_fingerprint", "_pre_login_secret", "_compare_live_to_slot",
    "_profile_name", "_follow_live_account",
})

#: sha256 of each module's remaining non-blank lines on main (6d2b4fa6).
#: quota_failover was updated deliberately in 0.2.32 for the removal of the
#: portable-credential feature: credential_env_vars reads only
#: AccountSwitchSpec.credential_env_vars (same names, same order).
MAIN_DIGESTS = {
    "usage_service": (
        "bdf088458f80023a085c30a88987e01c13d550a5bfff66f73f8dd9d986188943", D7_LOGIN_FUNCTIONS,
    ),
    "quota_failover": (
        "9999c0f2738adefa473317d3a9122c5d4223acf4658a4a8489b626049f9f17fe", frozenset(),
    ),
}


def quota_path_digest(source: str, skip: frozenset[str]) -> str:
    tree = ast.parse(source)
    lines = source.splitlines()
    cut = [
        ((node.decorator_list[0].lineno if node.decorator_list else node.lineno) - 1, node.end_lineno)
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in skip
    ]
    kept = [
        line for i, line in enumerate(lines)
        if line.strip() and not any(start <= i < end for start, end in cut)
    ]
    return hashlib.sha256("\n".join(kept).encode("utf-8")).hexdigest()


@pytest.mark.parametrize("module", sorted(MAIN_DIGESTS))
def test_the_quota_path_reads_as_main_had_it(module: str) -> None:
    digest, skip = MAIN_DIGESTS[module]
    source = (PACKAGE / f"{module}.py").read_text(encoding="utf-8")

    assert quota_path_digest(source, skip) == digest
