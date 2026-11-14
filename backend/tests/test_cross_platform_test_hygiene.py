"""Ratchets over the test tree itself: a test may not answer a platform
question the module under test asks a seam for.

`test_osplat.py` keeps three ratchets over `agent_team_backend/` — no scattered
`sys.platform` branches, secrets through `osplat.secret_files`, ported modules
POSIX-free. Those protect the product. This file points the same shape at
`backend/tests/`, because the day the Windows job joined the gate it caught
four tests in one afternoon that were correct code plus a POSIX-shaped test:
a `/bin/sh` handed straight to `subprocess`, a PATH split on `":"`, and a
`terminals.os.kill` stub on a module that kills through
`osplat.process_tree.kill`. The common shape is not "forward slashes" — a
blanket ban on POSIX literals would touch 66 test files to catch one bug — it
is a test constructing a platform-dependent value by a different route than
the code under test, so the two disagree on exactly one platform.

The `os.kill` case is the one worth the most: it did not go red on Windows,
it went *green*. The stub was never called (Windows kills through psutil), the
real kill raised an equivalent error, and the test passed while executing
none of what it claimed to test. CI is silent about that kind forever; only a
ratchet or a reader notices.

Each rule is a regex, an allowlist of today's offenders, and two tests: new
offenders fail with the seam to use named in the message, and an allowlist
entry that has become clean fails too — the ratchet only tightens. A third
test per rule pins the regex against a known-bad snippet so a broken pattern
cannot pass by matching nothing (the shape `test_osplat.py` calls
`test_the_seam_itself_still_makes_those_calls`).
"""

from __future__ import annotations

import re
from pathlib import Path

TESTS_ROOT = Path(__file__).resolve().parent


def _feature_test_files() -> list[Path]:
    """Every test module except this file. R1 and R2 apply to all of them —
    a seam's own tests have no better reason to hard-code `/bin/sh` than
    anyone else. R5 exempts a stub by its *target* (a module under `osplat/`),
    not by file name: `test_terminals_exit_orphan_reap.py` stubs
    `_posix.subprocess.run` and is a test of the seam despite its name."""
    return sorted(
        p for p in TESTS_ROOT.rglob("test_*.py") if p.name != Path(__file__).name
    )


#: A module that opts out of Windows up front with `pytest.importorskip` on
#: one of the POSIX-only stdlib modules — the gate `92650ea6` put on the ten
#: real-PTY test modules. Such a file is skipped wholesale where the primitive
#: does not exist, so nothing in it can be an UNGATED POSIX assumption; the
#: rules below leave it alone. A per-test `skipif` is not recognised here (it
#: cannot be attributed to one stub statically) — a test gated that way is
#: allowlisted with the gate as its reason.
_MODULE_GATE_RE = re.compile(r"pytest\.importorskip\(\s*[\"'](?:fcntl|pty|termios)[\"']")


def _is_module_gated(text: str) -> bool:
    return bool(_MODULE_GATE_RE.search(text))


def _offenders(pattern: re.Pattern[str], files: list[Path]) -> set[str]:
    offenders: set[str] = set()
    for p in files:
        text = p.read_text(encoding="utf-8")
        if _is_module_gated(text):
            continue
        if pattern.search(text):
            offenders.add(p.relative_to(TESTS_ROOT).as_posix())
    return offenders


def _stale(pattern: re.Pattern[str], allowlist: set[str]) -> set[str]:
    return {
        name
        for name in allowlist
        if not pattern.search((TESTS_ROOT / name).read_text(encoding="utf-8"))
    }


# ── R1: no absolute POSIX interpreter handed straight to subprocess ─────────

#: A POSIX path as the program of a `subprocess.*` call. Not a ban on
#: `/bin/sh` — a ban on an UNGATED `/bin/sh`: on Windows the file does not
#: exist and the test dies with FileNotFoundError before asserting anything.
#: A test that needs a shell asks `osplat.paths.shell_command(cmd)`; a test
#: that needs an interpreter uses `sys.executable`; a test that is about
#: one platform's binary gates itself with a capability `skipif` and lands
#: in the allowlist with that reason.
_POSIX_PROGRAM_RE = re.compile(
    r"subprocess\.(?:run|Popen|call|check_output|check_call)\(\s*\[?\s*['\"]/(?:bin|usr|etc|opt|sbin)/"
)
#: Offenders today, each with the gate that makes it acceptable. Empty: the
#: one there was (`/bin/sh -c` in the PATH-probe test) now asks the seam.
POSIX_PROGRAM_ALLOWLIST: set[str] = {
    # Runs the POSIX hook line through the /bin/sh the CLI uses; the whole module
    # is skipped on Windows, where unattended panes do not exist yet.
    "test_guard_fail_closed.py",
}


class TestNoUngatedPosixProgramInTests:
    def test_only_allowlisted_tests_exec_a_posix_path(self):
        new = _offenders(_POSIX_PROGRAM_RE, _feature_test_files()) - POSIX_PROGRAM_ALLOWLIST
        assert not new, (
            "these tests hand an absolute POSIX path to subprocess, which does not "
            "exist on Windows. This is not a ban on /bin/sh — it is a ban on an "
            "UNGATED /bin/sh. Ask osplat.paths.shell_command(cmd) for a shell, use "
            "sys.executable for an interpreter, or gate the test with a capability "
            f"skipif and allowlist it with that reason: {sorted(new)}"
        )

    def test_the_allowlist_has_no_stale_entries(self):
        stale = _stale(_POSIX_PROGRAM_RE, POSIX_PROGRAM_ALLOWLIST)
        assert not stale, f"already clean, drop from the allowlist: {sorted(stale)}"

    def test_the_pattern_still_matches_the_shape_it_guards(self):
        assert _POSIX_PROGRAM_RE.search('subprocess.run(["/bin/sh", "-c", script])')
        assert _POSIX_PROGRAM_RE.search("subprocess.Popen('/usr/bin/env', ...)")
        # The seam form, and an interpreter by name, are what the rule asks for.
        assert not _POSIX_PROGRAM_RE.search("subprocess.run(osplat.paths.shell_command(s))")
        assert not _POSIX_PROGRAM_RE.search("subprocess.run([sys.executable, '-c', s])")


# ── R2: PATH is split on os.pathsep, never on ":" ───────────────────────────

#: `.split(":")` on something PATH-shaped. Windows separates PATH with `;`,
#: so `"C:\\Users\\x".split(":")` yields `["C", "\\Users\\x"]` and the
#: assertion compares against `"C"`. The operand filter keeps the rule off
#: the `pid:pgid:sid` markers and `key:value` strings that also split on a
#: colon and are not paths.
_COLON_SPLIT_PATH_RE = re.compile(
    r"(?:PATH|[Pp]ath|_dirs|_bins?)\b[^\n]*?\.split\(\s*[\"']:[\"']\s*\)"
)
COLON_SPLIT_PATH_ALLOWLIST: set[str] = set()


class TestPathSplitsOnPathsep:
    def test_only_allowlisted_tests_split_a_path_on_colon(self):
        new = _offenders(_COLON_SPLIT_PATH_RE, _feature_test_files()) - COLON_SPLIT_PATH_ALLOWLIST
        assert not new, (
            "these tests split a PATH on ':' — Windows separates PATH with ';', so "
            "the first entry there is the drive letter. Split on os.pathsep: "
            f"{sorted(new)}"
        )

    def test_the_allowlist_has_no_stale_entries(self):
        stale = _stale(_COLON_SPLIT_PATH_RE, COLON_SPLIT_PATH_ALLOWLIST)
        assert not stale, f"already clean, drop from the allowlist: {sorted(stale)}"

    def test_the_pattern_still_matches_the_shape_it_guards(self):
        assert _COLON_SPLIT_PATH_RE.search('parts = os.environ["PATH"].split(":")')
        assert _COLON_SPLIT_PATH_RE.search("shell_path.split(':')[0]")
        assert _COLON_SPLIT_PATH_RE.search("fallback_dirs.split(':')")
        assert not _COLON_SPLIT_PATH_RE.search('os.environ["PATH"].split(os.pathsep)')
        # Not paths: a `pid:pgid:sid` marker line, a dedup key, an ACL ACE.
        assert not _COLON_SPLIT_PATH_RE.search('marker[0].split(":")')
        assert not _COLON_SPLIT_PATH_RE.search('e.dedup_key.split(":")[-1]')


# ── R5: a feature test stubs the seam, not the primitive under it ───────────

#: A stub of `os.kill` / `os.killpg` on a module that signals through
#: `osplat.process_tree.kill` / `kill_group`. On POSIX the seam calls
#: `os.kill`, so the stub sees every signal; on Windows the seam calls
#: psutil, the stub is never called, and the test either goes red
#: (`assert [] == [11]`) or — worse — stays green while exercising none of
#: what it claims, because psutil raised an equivalent error for a dead pid.
#: Stub the seam for "which pids get signalled"; stub `os.kill` only in a test
#: that is about the signal itself, gated on the capability, and allowlisted.
#: A stub whose target module lives under `osplat/` is exempt — that is a test
#: of the seam, which has nothing above it to stub.
_OS_KILL_STUB_RE = re.compile(
    r"setattr\(\s*(?P<target>[A-Za-z_][\w.]*)\.os\s*,\s*[\"'](?:kill|killpg)[\"']"
)
#: `test_terminals_breakaway_kill.py::test_kill_breakaway_sigkills_each_pid`
#: is about SIGKILL itself — there is no platform-neutral spelling of "the
#: signal was SIGKILL" — and gates on `hasattr(signal, "SIGKILL")`, a
#: capability check rather than a platform name, so it stays correct on a
#: platform nobody has ported to yet.
OS_KILL_STUB_ALLOWLIST: set[str] = {"test_terminals_breakaway_kill.py"}


#: Stub targets that ARE the seam: a test of `_posix` has nothing above
#: `os.kill` left to stub.
_SEAM_MODULES = ("_posix", "_linux", "_darwin", "_windows", "osplat")


def _os_kill_stub_offenders(files: list[Path], root: Path = TESTS_ROOT) -> set[str]:
    offenders: set[str] = set()
    for p in files:
        text = p.read_text(encoding="utf-8")
        if _is_module_gated(text):
            continue
        for m in _OS_KILL_STUB_RE.finditer(text):
            if m.group("target").startswith(_SEAM_MODULES):
                continue
            offenders.add(p.relative_to(root).as_posix())
    return offenders


class TestFeatureTestsStubTheSeamNotOsKill:
    def test_only_allowlisted_tests_stub_os_kill(self):
        new = _os_kill_stub_offenders(_feature_test_files()) - OS_KILL_STUB_ALLOWLIST
        assert not new, (
            "these tests stub os.kill/os.killpg under a module that signals through "
            "osplat.process_tree — on Windows that seam calls psutil, the stub is never "
            "reached, and the test goes red or (worse) silently tests nothing. Stub "
            "osplat.process_tree.kill / kill_group for 'which pids'; stub os.kill only "
            "in a test about the signal itself, gated with skipif(not hasattr(signal, "
            f"'SIGKILL')) and allowlisted with that reason: {sorted(new)}"
        )

    def test_the_allowlist_has_no_stale_entries(self):
        stale = {
            name for name in OS_KILL_STUB_ALLOWLIST
            if not _os_kill_stub_offenders([TESTS_ROOT / name])
        }
        assert not stale, f"already clean, drop from the allowlist: {sorted(stale)}"

    def test_the_pattern_still_matches_the_shape_it_guards(self):
        assert _OS_KILL_STUB_RE.search('monkeypatch.setattr(terminals.os, "kill", fake)')
        assert _OS_KILL_STUB_RE.search("monkeypatch.setattr(app.os, 'killpg', fake)")
        # Stubbing the seam is the rule's own advice.
        assert not _OS_KILL_STUB_RE.search('monkeypatch.setattr(terminals.osplat.process_tree, "kill", fake)')

    def test_a_module_gated_with_importorskip_is_exempt(self, tmp_path):
        # `test_terminal_create_cancellation.py` stubs `terminals_module.os.killpg`
        # but opens with `pytest.importorskip("fcntl")`: skipped wholesale on
        # Windows, so the stub is never an ungated assumption there.
        gated = tmp_path / "test_gated.py"
        gated.write_text(
            'pytest.importorskip("fcntl")\n'
            'monkeypatch.setattr(\n    terminals_module.os, "killpg", fake\n)\n',
            encoding="utf-8",
        )
        ungated = tmp_path / "test_ungated.py"
        ungated.write_text('monkeypatch.setattr(terminals.os, "killpg", fake)\n', encoding="utf-8")
        assert _os_kill_stub_offenders([gated, ungated], root=tmp_path) == {"test_ungated.py"}

    def test_the_seams_own_tests_are_exempt(self, tmp_path):
        # A test of `_posix` has nothing above `os.kill` to stub.
        seam_test = tmp_path / "test_x.py"
        seam_test.write_text('monkeypatch.setattr(_posix.os, "kill", fake)\n', encoding="utf-8")
        feature_test = tmp_path / "test_y.py"
        feature_test.write_text('monkeypatch.setattr(terminals.os, "kill", fake)\n', encoding="utf-8")
        # Both match the regex; only the feature test is an offender.
        assert _os_kill_stub_offenders([seam_test, feature_test], root=tmp_path) == {"test_y.py"}
