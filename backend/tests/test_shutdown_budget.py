"""The backend's quit path must fit inside the window main gives it.

main SIGTERMs the backend and tree-kills it with SIGKILL after a fixed timer
(stopBackendProcess in src/main/backend.ts). On SIGTERM uvicorn first waits on
in-flight requests — every idle Claude pane parks a rewake long-poll, so that
wait is always used in full — and only then runs the lifespan teardown, whose
PTY sweep waits out the largest vendor-declared SIGTERM grace. If the two
together outlast main's timer, the sweep is cut off mid-grace: the vendor's
graceful shutdown (the reason it declared a grace) and the registry/database
flushes after it never finish.
"""

from __future__ import annotations

import re
from pathlib import Path

from agent_team_backend import __main__ as backend_main
from agent_team_backend.cli_vendors.registry import VENDORS

# ps snapshot, SIGKILL reaps, breakaway sweep and lifecycle drain after the grace.
_SWEEP_HEADROOM_S = 1.0

_BACKEND_TS = Path(__file__).resolve().parents[2] / "src" / "main" / "backend.ts"


def _main_sigkill_timer_s() -> float:
    source = _BACKEND_TS.read_text(encoding="utf-8")
    body = source[source.index("export function stopBackendProcess"):]
    match = re.search(r"killProcessTree\(proc\.pid, 'SIGKILL'\)\s*resolve\(\)\s*\}, ([\d_]+)\)", body)
    assert match, "stopBackendProcess's SIGKILL timer not found in src/main/backend.ts"
    return int(match.group(1).replace("_", "")) / 1000


def test_shutdown_sweep_fits_inside_mains_sigkill_timer() -> None:
    largest_grace = max(
        (spec.shutdown.grace_s for spec in VENDORS.values()
         if spec.shutdown is not None and spec.shutdown.graceful),
        default=0.0,
    )
    needed = backend_main._GRACEFUL_SHUTDOWN_S + largest_grace + _SWEEP_HEADROOM_S
    assert needed <= _main_sigkill_timer_s(), (
        f"uvicorn graceful {backend_main._GRACEFUL_SHUTDOWN_S}s + vendor grace "
        f"{largest_grace}s + sweep {_SWEEP_HEADROOM_S}s = {needed}s exceeds "
        f"main's {_main_sigkill_timer_s()}s SIGKILL timer"
    )
