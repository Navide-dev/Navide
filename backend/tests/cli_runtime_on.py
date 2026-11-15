"""``pytest -p tests.cli_runtime_on``: run a suite with the Rust CLI runtime switch on.

Every registered vendor's reader class has its three record calls routed the
way ``cli_runtime.wrap`` routes a production reader, and the switch is turned
on, so the readers tests build directly (``CodexLogReader()``) answer through
the ``navide-cli-runtime`` process too. Vendors the runtime does not observe,
and any call it cannot answer, stay on Python exactly as in production.

A routed call that ends on Python would pass every test while proving nothing
about the runtime, so the run counts each call's outcome per CLI, prints the
counts at the end, and fails when one fell back on a fault (a process that
died or stalled, an error answer) or declined a store that is not listed in
``EXPECTED_UNSUPPORTED``.

The few tests that meter the Python reader's own file reads are skipped, with
the reason shown (``PYTHON_READ_METERS``).

The runtime is built from the checkout's source first
(``tests/cli_runtime_build.py``); a run that cannot build it is an error, not
a skip.
"""

from __future__ import annotations

from typing import Any

import pytest

#: Tests that meter the Python reader's own file reads (a counting
#: ``Path.open``). With the switch on, that code does not run, so the meter has
#: nothing to measure; the reads they pin are tested on the Rust side
#: (``observe/file.rs``: ``a_stale_resume_point_reads_from_the_head``).
PYTHON_READ_METERS = (
    "test_claude_activity_resume.py::test_append_reads_only_the_new_bytes",
    "test_claude_activity_resume.py::test_truncated_file_is_read_from_the_head",
    "test_claude_activity_resume.py::test_changed_mark_is_read_from_the_head",
)

#: The stores the runtime declines by declaration (``Error::Unsupported``),
#: so that main's reader reads them and logs what it logs. A CLI that is not
#: listed here must never decline.
EXPECTED_UNSUPPORTED = {
    "copilot": "a 1.0.75 events.jsonl (it reconciles against the store), or a store that cannot be read: "
               "main's reader reads the one and warns about the other",
    "hermes": "a state.db without the declared columns: main's reader reports the schema",
    "kilo": "a database with a query that fails, busy or gone: main's reader makes the read and records why",
    "openclaw": "a transcript_events table without the declared columns: main's reader reports the schema",
    "opencode": "a database with a query that fails, busy or gone: main's reader makes the read and records why",
}


def _route(cls: type) -> None:
    from agent_team_backend import cli_runtime

    for name, route in cli_runtime.ROUTES:
        original = cls.__dict__.get(name) or getattr(cls, name)

        def routed(self: Any, *args: Any, _original=original, _route=route, **kwargs: Any) -> Any:
            return _route(self, lambda *a, **k: _original(self, *a, **k), *args, **kwargs)

        setattr(cls, name, routed)


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    for item in items:
        if item.nodeid.endswith(PYTHON_READ_METERS):
            item.add_marker(pytest.mark.skip(reason="meters Python's file reads, which the Rust path replaces"))


@pytest.hookimpl(trylast=True)
def pytest_configure(config: pytest.Config) -> None:
    from agent_team_backend import cli_runtime
    from agent_team_backend.cli_vendors.registry import VENDORS
    from tests import cli_runtime_build

    try:
        cli_runtime_build.binary()
    except (pytest.skip.Exception, pytest.fail.Exception) as stopped:
        # A suite run with the switch on and nothing to switch to proves nothing.
        raise pytest.UsageError(f"cli_runtime_on needs navide-cli-runtime built from source: {stopped}") from None
    seen: set[type] = set()
    for spec in VENDORS.values():
        if spec.make_log_reader is None:
            continue
        cls = type(spec.make_log_reader())
        if cls not in seen:
            seen.add(cls)
            _route(cls)
    cli_runtime.reset_counts()
    cli_runtime.apply(True)


def unexpected(calls: dict[str, dict[str, int]]) -> list[str]:
    """Why the counted calls are not all the runtime's own answers."""
    problems = []
    for vendor, counts in sorted(calls.items()):
        if counts["fallback"]:
            problems.append(f"{vendor}: {counts['fallback']} call(s) fell back to Python on a fault")
        if counts["unsupported"] and vendor not in EXPECTED_UNSUPPORTED:
            problems.append(f"{vendor}: {counts['unsupported']} call(s) declined a store, which no declaration expects")
    return problems


def pytest_terminal_summary(terminalreporter: Any, exitstatus: int, config: pytest.Config) -> None:
    from agent_team_backend import cli_runtime

    calls = cli_runtime.status()["calls"]
    terminalreporter.section("Rust CLI runtime: who answered the routed reader calls")
    if not calls:
        terminalreporter.write_line("no routed call reached an observed CLI")
    for vendor, counts in calls.items():
        note = f"  ({EXPECTED_UNSUPPORTED[vendor]})" if counts["unsupported"] and vendor in EXPECTED_UNSUPPORTED else ""
        terminalreporter.write_line(
            f"{vendor:12} rust={counts['rust']:<6} unsupported={counts['unsupported']:<4} "
            f"unreadable={counts['unreadable']:<4} python={counts['python']:<4} deferred={counts['deferred']:<4} "
            f"fallback={counts['fallback']}{note}"
        )
    for problem in unexpected(calls):
        terminalreporter.write_line(f"UNEXPECTED {problem}", red=True)


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    from agent_team_backend import cli_runtime

    if unexpected(cli_runtime.status()["calls"]) and session.exitstatus == pytest.ExitCode.OK:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
