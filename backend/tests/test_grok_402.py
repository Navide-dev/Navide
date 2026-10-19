"""Issue #402: the official Grok Build CLI (1.0.62) inside Navide panes.

- Folder trust a pane accepted must not stay inside that pane's home shim
  (feature ``grok.folder-trust``): it is merged into ~/.grok/trusted_folders.toml,
  backed up and announced through the convenience gate, and the switch takes
  it back out again.
- ``cli_usage`` must say the CLI version has no billing method instead of
  showing a raw JSON-RPC error.
- A same-named third-party ``grok`` on PATH is named in the pane's startup
  probe line.
- The trust prompt is answerable with cli_answer_prompt.
"""

from __future__ import annotations

import asyncio
import tomllib
from pathlib import Path
from types import SimpleNamespace

import pytest
import tomli_w

from agent_team_backend import app, convenience, convenience_wiring
from agent_team_backend.channels import relay
from agent_team_backend.cli_vendors import grok
from agent_team_backend.db import Database
from agent_team_backend.mcp_server import pane_home

URL = "http://127.0.0.1:4567/plan-mcp?pane=p1&t=tok"
SERVER = "navide"
LABEL = "Navide"
TRUST = "trusted_folders.toml"


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fake home the shims are built under, so no test touches the real one."""
    fake = tmp_path / "home"
    (fake / ".grok").mkdir(parents=True)
    monkeypatch.setattr(pane_home, "real_home", lambda: fake)
    return fake


@pytest.fixture
def gate(tmp_path: Path):
    gate = convenience.ConvenienceGate(Database(tmp_path / "navide.db"), backup_root=tmp_path / "backups")
    convenience_wiring.install(gate)
    yield gate
    convenience_wiring.install(None)


def _shim_trust(pane: str) -> Path:
    root = pane_home.shim_root("grok", pane)
    assert root is not None
    return root / ".grok" / TRUST


def _grok_trusts(path: Path, folder: str, decided_at: int = 1789832073) -> None:
    """What Grok Build writes when the user answers its trust prompt."""
    path.unlink(missing_ok=True)
    path.write_text(
        tomli_w.dumps({"folders": {folder: {"trusted": True, "decided_at": decided_at}}}),
        encoding="utf-8",
    )


def _folders(path: Path) -> dict:
    return tomllib.loads(path.read_text(encoding="utf-8")).get("folders", {})


def _prepare(pane: str) -> None:
    assert pane_home.prepare("grok", pane, URL, SERVER, LABEL) is not None


# ---- folder trust leaves the pane ----


def test_trust_accepted_in_one_pane_reaches_the_real_file_and_the_next_pane(home: Path) -> None:
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), "/work/a")

    _prepare("p2")

    real = home / ".grok" / TRUST
    assert _folders(real) == {"/work/a": {"trusted": True, "decided_at": 1789832073}}
    # The next pane reads the shared file, and so does the one that answered.
    assert _shim_trust("p2").is_symlink() and _shim_trust("p2").resolve() == real.resolve()
    assert _shim_trust("p1").is_symlink() and _shim_trust("p1").resolve() == real.resolve()


def test_the_users_own_rows_are_kept_and_win_over_a_panes(home: Path) -> None:
    real = home / ".grok" / TRUST
    real.write_text(
        tomli_w.dumps({"folders": {"/work/a": {"trusted": False, "decided_at": 1}}}), encoding="utf-8"
    )
    _prepare("p1")
    # A link to the real file now, so a pane writing through it changes it in
    # place; one that replaces the file leaves a copy in the shim instead.
    _shim_trust("p1").unlink()
    _shim_trust("p1").write_text(
        tomli_w.dumps({"folders": {
            "/work/a": {"trusted": True, "decided_at": 2},
            "/work/b": {"trusted": True, "decided_at": 3},
        }}),
        encoding="utf-8",
    )

    _prepare("p2")

    assert _folders(real) == {
        "/work/a": {"trusted": False, "decided_at": 1},
        "/work/b": {"trusted": True, "decided_at": 3},
    }


def test_rows_stranded_by_earlier_versions_are_rescued(home: Path) -> None:
    # A shim built before this fix: Grok wrote its trust file there and the
    # pane was never prepared again.
    stranded = pane_home.panes_root() / "grok" / "old-pane" / ".grok"
    stranded.mkdir(parents=True)
    _grok_trusts(stranded / TRUST, "/work/old")

    _prepare("p1")

    assert "/work/old" in _folders(home / ".grok" / TRUST)
    assert (stranded / TRUST).is_symlink()


def test_nothing_is_created_when_no_pane_ever_trusted_a_folder(home: Path) -> None:
    _prepare("p1")

    assert not (home / ".grok" / TRUST).exists()


# ---- through the convenience gate ----


def test_the_merge_is_backed_up_announced_and_taken_back_by_the_switch(gate, home: Path) -> None:
    real = home / ".grok" / TRUST
    original = tomli_w.dumps({"folders": {"/mine": {"trusted": True, "decided_at": 1}}})
    real.write_text(original, encoding="utf-8")
    _prepare("p1")
    _shim_trust("p1").unlink()
    _grok_trusts(_shim_trust("p1"), "/work/a")

    _prepare("p2")

    assert "/work/a" in _folders(real)
    history = gate.history("grok.folder-trust")
    assert [(e["action"], e["notify"]) for e in history] == [("first", True)]
    assert history[0]["backup"], "the user's file is backed up before Navide writes it"

    convenience_wiring.set_feature("grok.folder-trust", False, port_file="")

    assert real.read_text(encoding="utf-8") == original
    assert gate.state("grok.folder-trust") == ("off", "user")


def test_the_switch_removes_a_file_navide_created(gate, home: Path) -> None:
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), "/work/a")
    _prepare("p2")
    assert (home / ".grok" / TRUST).exists()

    convenience_wiring.set_feature("grok.folder-trust", False, port_file="")

    assert not (home / ".grok" / TRUST).exists()


def test_switched_off_trust_stays_in_the_pane(gate, home: Path) -> None:
    convenience_wiring.set_feature("grok.folder-trust", False, port_file="")
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), "/work/a")

    _prepare("p2")

    assert not (home / ".grok" / TRUST).exists()
    assert not _shim_trust("p1").is_symlink()


def test_the_feature_is_registered_and_switchable() -> None:
    assert convenience.feature("grok.folder-trust").toggleable
    assert convenience.feature("grok.folder-trust").cli == "grok"


# ---- cli_usage on a Grok Build without x.ai/billing ----


def test_a_missing_billing_method_reads_as_unsupported_not_a_raw_rpc_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def no_billing(_binary: str, env: dict | None = None) -> dict:
        raise grok.GrokRpcError(-32601, "Method not found")

    monkeypatch.setattr(grok, "read_grok_credentials", lambda _home, _env=None: {"ok": True})
    monkeypatch.setattr(grok.osplat.paths, "resolve_program", lambda _name, *, path=None: "/bin/grok")
    monkeypatch.setattr(grok, "grok_billing_rpc", no_billing)

    snapshot = asyncio.run(grok.fetch_grok(tmp_path))

    assert snapshot["status"] == "unavailable"
    assert "-32601" not in snapshot["error"] and "Method not found" not in snapshot["error"]
    assert "/usage" in snapshot["error"]


def test_the_billing_rpc_reports_the_error_code(tmp_path: Path) -> None:
    fake = tmp_path / "grok"
    fake.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "for line in sys.stdin:\n"
        "    req = json.loads(line)\n"
        "    if req['method'] == 'initialize':\n"
        "        out = {'jsonrpc': '2.0', 'id': req['id'], 'result': {}}\n"
        "    else:\n"
        "        out = {'jsonrpc': '2.0', 'id': req['id'],\n"
        "               'error': {'code': -32601, 'message': 'Method not found'}}\n"
        "    print(json.dumps(out), flush=True)\n",
        encoding="utf-8",
    )
    fake.chmod(0o755)

    with pytest.raises(grok.GrokRpcError) as caught:
        asyncio.run(grok.grok_billing_rpc(str(fake)))

    assert caught.value.code == -32601


# ---- a third-party `grok` on PATH ----


def _probe_prints(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stdout: str) -> dict:
    binary = tmp_path / "grok"
    binary.write_text("#!/bin/sh\n")
    monkeypatch.setattr(app.osplat.paths, "resolve_program", lambda _name, *, path=None: str(binary))
    monkeypatch.setattr(
        app, "_run_spawn_probe", lambda _command: SimpleNamespace(returncode=0, stdout=stdout, stderr="")
    )
    result = app._probe_agent_cli_for_spawn("grok")
    assert result is not None
    return result


def test_the_startup_probe_names_a_grok_that_is_not_grok_build(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    result = _probe_prints(monkeypatch, tmp_path, "1.1.7\n")

    assert "Grok Build" in result["warning"]
    assert "x.ai/cli/install.sh" in result["warning"]


def test_the_startup_probe_is_quiet_for_grok_build(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    result = _probe_prints(monkeypatch, tmp_path, "grok 1.0.62 (1474f9cbdd91)\n")

    assert "warning" not in result
    assert result["version"] == "1.0.62"


# ---- cli_answer_prompt ----


def test_the_trust_prompt_is_answerable() -> None:
    assert "grok" in relay.ANSWERABLE_AGENTS
