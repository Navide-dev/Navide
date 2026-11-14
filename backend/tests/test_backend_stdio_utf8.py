"""The backend's stdout and stderr stay writable for a non-ASCII profile path.

On an English Windows install the pipes Electron reads are cp1252, which cannot
encode C:\\Users\\測試員; printing the log path there killed the backend at start.
"""

from __future__ import annotations

import io
import sys

import pytest

from agent_team_backend import __main__ as backend_main

PATH = r"C:\Users\測試員\AppData\Roaming\Agent-Team\logs\backend.log"


def _cp1252_pipe() -> tuple[io.BytesIO, io.TextIOWrapper]:
    raw = io.BytesIO()
    return raw, io.TextIOWrapper(raw, encoding="cp1252", write_through=True)


def test_a_cp1252_pipe_cannot_print_the_path_unaided() -> None:
    _, pipe = _cp1252_pipe()
    with pytest.raises(UnicodeEncodeError):
        print(f"AGENT_TEAM_BACKEND_LOG path={PATH}", file=pipe, flush=True)


def test_stdout_and_stderr_print_the_path_as_utf8(monkeypatch: pytest.MonkeyPatch) -> None:
    out_raw, out = _cp1252_pipe()
    err_raw, err = _cp1252_pipe()
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "stderr", err)

    backend_main._utf8_stdio()
    print(f"AGENT_TEAM_BACKEND_LOG path={PATH}", flush=True)
    print(PATH, file=sys.stderr, flush=True)

    assert f"AGENT_TEAM_BACKEND_LOG path={PATH}" in out_raw.getvalue().decode("utf-8")
    assert PATH in err_raw.getvalue().decode("utf-8")
