"""The pane log must show output as soon as it is mirrored, not when a newline
happens to come by.

cli_read_log reads the log FILE, so anything still sitting in the writer's
buffer is invisible to it. The log is opened line-buffered, and
_clean_for_log drops every chunk's trailing line break; ConPTY positions its
lines with cursor moves rather than CRLF. On Windows a terminal pane's echo,
its command output and its next prompt therefore never contained a newline,
stayed buffered, and cli_read_log showed a cli_send as typed but never run
(0.2.46 rc2 VM, bug 7).
"""

from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend.terminals import TerminalService


async def _emit(_event):  # EventSink stub — never called on this path
    return None


@pytest.mark.asyncio
async def test_mirrored_output_without_a_newline_reaches_the_log_file(tmp_path: Path):
    svc = TerminalService(_emit)
    path = tmp_path / "terminal.log"
    # Opened exactly as TerminalService.create opens a pane's output log.
    log_fp = open(path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115
    session = SimpleNamespace(id="t-flush", pane_id="p1", closed=False, output_log_fp=log_fp)
    try:
        # What ConPTY sends for PowerShell's echo, the command's output and
        # the next prompt: cursor positioning, no CR or LF anywhere.
        svc._mirror_to_log(session, b"\x1b[4;27Hecho nvt72ca9102")
        svc._mirror_to_log(session, b"\x1b[5;1Hnvt72ca9102\x1b[7;1HPS C:\\wn> ")
        on_disk = path.read_text(encoding="utf-8")
        assert on_disk.count("nvt72ca9102") == 2
        assert "PS C:\\wn>" in on_disk
    finally:
        log_fp.close()


@pytest.mark.asyncio
async def test_a_single_line_chunk_is_not_held_back_by_its_dropped_line_break(tmp_path: Path):
    # The POSIX shape of the same hole: "line\r\n" cleans to "line", so a
    # one-line chunk waited for the next multi-line one.
    svc = TerminalService(_emit)
    path = tmp_path / "terminal.log"
    log_fp = open(path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115
    session = SimpleNamespace(id="t-line", pane_id="p1", closed=False, output_log_fp=log_fp)
    try:
        svc._mirror_to_log(session, b"echo nvp1234\r\n")
        assert "echo nvp1234" in path.read_text(encoding="utf-8")
    finally:
        log_fp.close()
