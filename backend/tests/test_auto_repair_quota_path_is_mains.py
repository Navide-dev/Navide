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
#: AccountSwitchSpec.credential_env_vars (same names, same order), and
#: pane_auth_scope loses its portable_slot_id parameter and "portable" source.
#: Both modules were updated deliberately in 0.2.36 for API key accounts: the
#: usage poll skips an active codex key, and _login_state holds a key back from
#: failover until the user opts in.
#: Both modules were updated deliberately in 0.2.37 for accounts with no 5-hour
#: window: _quota_verdict accepts a window a successful read proved absent, and
#: _cache_safe_snapshot keeps that field. An account that reports its windows is
#: judged as before (test_quota_verdict_unchanged.py).
#: quota_failover was updated deliberately in 0.2.42 for the auto-continue
#: notice (plan agent-0-2-42_3f728e P3): add_commit_listener and
#: _notify_commit_listeners, called once at the end of _after_commit, hand a
#: copy of the committed switch to failover_notice on its own task. Nothing
#: in detection, ranking, the budget, the swap or the audit row changed.
#: quota_failover was updated deliberately in 0.2.44 for the user's account
#: order (user-approved rule A, 2026-11-16): rank_candidates takes slot_order
#: and sorts eligible accounts by their position in it first; candidates()
#: passes the profiles store's slotOrder. With no order the sort key reduces
#: to the old tier/headroom/fetchedAt/slotId one (test_quota_failover
#: regression tests). Exclusion, detection, the budget and the swap are as
#: before.
#: usage_service was updated deliberately in 0.2.45 for the badge stuck on
#: "reading" (user-authorized 2026-11-20): poll_once resolves the active Claude
#: account again when a switch lands before its reads start (instead of
#: running them and discarding them), publishes the active account's reading
#: as soon as it lands when parked reads are still out, and the reading mark
#: carries refreshPendingSince. Switch decisions, credentials and failover
#: are untouched.
MAIN_DIGESTS = {
    "usage_service": (
        "369f00219e0f4f05dac97a777b1218b9c1cca147c309bd859fc61605ebe3e247", D7_LOGIN_FUNCTIONS,
    ),
    "quota_failover": (
        "534dd11c92157732e4ab3207eed2382d09cf46da5ee945d326f7ff194e3497d9", frozenset(),
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
