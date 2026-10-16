"""No log line carries a token-bearing query parameter.

uvicorn logs every WebSocket handshake through ``uvicorn.error`` at INFO, path
and query included: ``"WebSocket /ws?t=<token>" [accepted]``. That is the
backend's ws credential printed to stdout on every launch, even with
access_log=False. The filter rewrites ``t=`` / ``token=`` values to ``***`` in
both the format string and its args, on every logger and handler the backend
configures.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import textwrap

from agent_team_backend import osplat
from agent_team_backend.log_redaction import TokenRedactionFilter

# Concatenated so secret scanners do not read it as a real credential.
SECRET = "fake" + "-ws-" + "tok3n" + "-Zq9" * 6


def _record(msg: str, args: tuple | dict | None = None) -> logging.LogRecord:
    return logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, msg, args, None)


def _filtered(record: logging.LogRecord) -> str:
    assert TokenRedactionFilter().filter(record) is True
    return record.getMessage()


def test_the_ws_token_in_the_message_is_redacted() -> None:
    out = _filtered(_record(f'127.0.0.1:1 - "WebSocket /ws?t={SECRET}" [accepted]'))
    assert SECRET not in out
    assert '"WebSocket /ws?t=***" [accepted]' in out


def test_a_token_param_after_another_param_is_redacted() -> None:
    out = _filtered(_record(f"GET /plan-mcp?pane=p1&token={SECRET}&x=1"))
    assert SECRET not in out
    assert "/plan-mcp?pane=p1&token=***&x=1" in out


def test_uvicorns_args_tuple_form_is_redacted() -> None:
    # uvicorn's own call shape: the path is an arg, not part of msg.
    record = _record('%s - "WebSocket %s" [accepted]', ("127.0.0.1:49997", f"/ws?t={SECRET}"))
    out = _filtered(record)
    assert SECRET not in out
    assert out == '127.0.0.1:49997 - "WebSocket /ws?t=***" [accepted]'


def test_a_mapping_args_form_is_redacted() -> None:
    record = _record("%(path)s", ({"path": f"/plan-mcp?client=host&t={SECRET}"},))
    out = _filtered(record)
    assert SECRET not in out
    assert out == "/plan-mcp?client=host&t=***"


def test_a_token_split_between_msg_and_args_is_redacted() -> None:
    # Redacting msg alone would eat the placeholder and break formatting,
    # whose error report then prints the args — token included.
    record = _record("connect /ws?t=%s&n=%d", (SECRET, 3))
    out = _filtered(record)
    assert SECRET not in out
    assert out == "connect /ws?t=***&n=3"


def test_an_encoded_token_is_redacted_whole() -> None:
    out = _filtered(_record("/ws?t=" + "ab%2B" + "cd%2Fef"))
    assert out == "/ws?t=***"


def test_a_record_without_a_token_is_unchanged() -> None:
    args = ("127.0.0.1:1", "/ws", 403)
    record = _record('%s - "WebSocket %s" %d', args)
    assert _filtered(record) == '127.0.0.1:1 - "WebSocket /ws" 403'
    assert record.args == args
    assert record.msg == '%s - "WebSocket %s" %d'
    # Words that merely end in t= or token= are not query params.
    assert _filtered(_record("format=json limit=3 next_token=abc")) == "format=json limit=3 next_token=abc"


# The real entrypoint, in a child process so its logging config cannot leak
# into this one. uvicorn.Server.run is replaced with a function that emits the
# lines uvicorn and the backend would, through the loggers main() configured,
# and also reports which loggers and handlers carry the filter.
_CHILD = textwrap.dedent(
    """
    import json, logging, sys
    import uvicorn
    from agent_team_backend import __main__ as entry
    from agent_team_backend.log_redaction import TokenRedactionFilter

    SECRET = sys.argv[1]

    def fake_run(self, sockets=None):
        logging.getLogger("uvicorn.error").info(
            '%s - "WebSocket %s" [accepted]', "127.0.0.1:49997", "/ws?t=" + SECRET)
        logging.getLogger("uvicorn.access").info(
            '%s - "%s %s HTTP/%s" %d', "127.0.0.1:1", "GET", "/fs/raw?t=" + SECRET, "1.1", 200)
        logging.getLogger("uvicorn").warning("url /ws?token=" + SECRET)
        logging.getLogger().warning("root %s", "/ws?t=" + SECRET)
        logging.getLogger("agent_team_backend.app").info("app /ws?t=%s", SECRET)
        def has(f): return any(isinstance(x, TokenRedactionFilter) for x in f.filters)
        report = {}
        for name in ("", "uvicorn", "uvicorn.error", "uvicorn.access", "agent_team_backend"):
            lg = logging.getLogger(name)
            report[name or "root"] = {
                "logger": has(lg), "handlers": [has(h) for h in lg.handlers]}
        print("REPORT " + json.dumps(report), flush=True)

    uvicorn.Server.run = fake_run
    sys.argv = ["navide-backend", "--port", "0", "--log-level", "info"]
    sys.exit(entry.main())
    """
)


def _isolated_env(tmp_path) -> dict:
    from agent_team_backend.cli_vendors.registry import VENDORS

    home = tmp_path / "home"
    home.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    for spec in VENDORS.values():
        for name in spec.home_env_vars:
            env.pop(name, None)
    env.pop("AGENT_TEAM_PARENT_PID", None)
    env.update(osplat.paths.isolated_home_env(home))
    env.update({
        "AGENT_TEAM_DATA_DIR": str(tmp_path),
        "APPDATA": str(home / "AppData" / "Roaming"),
        "LOCALAPPDATA": str(home / "AppData" / "Local"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_STATE_HOME": str(home / ".local" / "state"),
        "XDG_CACHE_HOME": str(home / ".cache"),
    })
    return env


def test_the_real_startup_path_never_prints_or_writes_the_token(tmp_path) -> None:
    import json

    proc = subprocess.run(
        [sys.executable, "-c", _CHILD, SECRET],
        env=_isolated_env(tmp_path), stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    output = proc.stdout + proc.stderr
    assert SECRET not in output
    # The lines were emitted, and emitted redacted — not swallowed.
    assert '"WebSocket /ws?t=***" [accepted]' in output
    assert "url /ws?token=***" in output
    assert "root /ws?t=***" in output
    assert "app /ws?t=***" in output

    files = [p for p in tmp_path.rglob("*") if p.is_file() and p.suffix in {".log", ".txt", ""}]
    assert any(p.name.endswith(".log") for p in files), "the backend log file was not written"
    for path in files:
        assert SECRET not in path.read_text(encoding="utf-8", errors="replace"), path

    report = json.loads(next(
        line for line in proc.stdout.splitlines() if line.startswith("REPORT ")
    )[len("REPORT "):])
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        assert report[name]["logger"], name
    # uvicorn.access has no handler: access_log=False empties it.
    for name in ("root", "uvicorn", "agent_team_backend"):
        assert report[name]["handlers"], f"{name} has no handlers"
        assert all(report[name]["handlers"]), name
    assert all(report["uvicorn.access"]["handlers"])
