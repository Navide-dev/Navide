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
import json
import sys
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


def _grok_trusts(path: Path, folder: str, decided_at: object = 1789832073) -> None:
    """What Grok Build does when the user answers its trust prompt: it reads
    the file it was given, adds the folder and writes the file back whole."""
    folders = _folders(path) if path.exists() else {}
    folders[folder] = {"trusted": True, "decided_at": decided_at}
    path.unlink(missing_ok=True)
    path.write_text(tomli_w.dumps({"folders": folders}), encoding="utf-8")


def _folders(path: Path) -> dict:
    return tomllib.loads(path.read_text(encoding="utf-8")).get("folders", {})


#: Every test pane's working directory unless a test says otherwise: a real
#: folder, since a folder that does not exist is never shared.
WS = ""


@pytest.fixture(autouse=True)
def workspace(tmp_path: Path) -> Path:
    global WS
    ws = tmp_path.resolve() / "work"
    for name in ("a", "b", "dt", "old", "../work-other", "../etc", "../elsewhere"):
        (ws / name).mkdir(parents=True, exist_ok=True)
    WS = str(ws)
    return ws


def _prepare(pane: str, workspace: str | None = None) -> None:
    assert pane_home.prepare("grok", pane, URL, SERVER, LABEL, workspace=WS if workspace is None else workspace) is not None


#: A file the user wrote by hand: comments, their own key order and spacing.
USERS_OWN = """# Folders I trust Grok Build in — keep this note.
[folders."/mine"]
trusted = true   # set by hand
decided_at = 1

# a second one
[folders."/also-mine"]
decided_at = 2
trusted = false
"""


def _off() -> None:
    convenience_wiring.set_feature("grok.folder-trust", False, port_file="")


# ---- folder trust leaves the pane, the user's own file stays theirs ----


def test_a_merge_keeps_the_users_comments_order_and_layout(gate, home: Path) -> None:
    real = home / ".grok" / TRUST
    real.write_text(USERS_OWN, encoding="utf-8")
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")

    _prepare("p2")

    text = real.read_text(encoding="utf-8")
    assert text.startswith(USERS_OWN), "the user's own bytes come first, unchanged"
    assert _folders(real)[f"{WS}/a"] == {"trusted": True, "decided_at": 1789832073}
    assert _folders(real)["/mine"] == {"trusted": True, "decided_at": 1}


def test_the_switch_restores_the_users_file_byte_for_byte(gate, home: Path) -> None:
    real = home / ".grok" / TRUST
    real.write_text(USERS_OWN, encoding="utf-8")
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")
    _prepare("p2")
    _grok_trusts(_shim_trust("p2"), f"{WS}/b")
    _prepare("p3")
    assert f"{WS}/b" in _folders(real)

    _off()

    assert real.read_text(encoding="utf-8") == USERS_OWN
    assert gate.state("grok.folder-trust") == ("off", "user")


def test_a_key_the_user_put_inside_navides_table_keeps_that_table(gate, home: Path) -> None:
    real = home / ".grok" / TRUST
    real.write_text(USERS_OWN, encoding="utf-8")
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")
    _prepare("p2")
    # Typed under Navide's table: cutting that table out would leave the key
    # under the user's own last table and change what it says.
    real.write_text(real.read_text(encoding="utf-8") + 'note = "mine"\n', encoding="utf-8")
    edited = real.read_text(encoding="utf-8")

    with pytest.raises(convenience.CleanupIncomplete):
        _off()

    assert real.read_text(encoding="utf-8") == edited
    assert _folders(real)["/also-mine"] == {"decided_at": 2, "trusted": False}
    failed = [e for e in gate.history("grok.folder-trust") if e["action"] == "cleanup-failed"]
    assert failed and f"{WS}/a" in failed[-1]["detail"]
    assert gate.state("grok.folder-trust")[0] != "off", "what could not be taken back still works"
    assert f"{WS}/a" in pane_home.grok_trust_ledger_rows(), "kept for a later takeback"


def test_a_file_without_a_final_newline_comes_back_exactly(gate, home: Path) -> None:
    real = home / ".grok" / TRUST
    real.write_text(USERS_OWN.rstrip("\n"), encoding="utf-8")
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")
    _prepare("p2")

    _off()

    assert real.read_text(encoding="utf-8") == USERS_OWN.rstrip("\n")


def test_the_users_own_rows_win_over_a_panes(gate, home: Path) -> None:
    real = home / ".grok" / TRUST
    real.write_text(USERS_OWN, encoding="utf-8")
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), "/also-mine")  # the pane said yes, the user had said no
    _grok_trusts(_shim_trust("p1"), f"{WS}/b")

    _prepare("p2")

    assert _folders(real)["/also-mine"] == {"decided_at": 2, "trusted": False}
    assert f"{WS}/b" in _folders(real)


def test_a_pane_never_writes_through_a_link_to_the_users_file(gate, home: Path) -> None:
    real = home / ".grok" / TRUST
    real.write_text(USERS_OWN, encoding="utf-8")

    _prepare("p1")

    shim = _shim_trust("p1")
    assert shim.is_file() and not shim.is_symlink(), "the pane's own copy, not a link"
    assert set(_folders(shim)) == {"/mine", "/also-mine"}, "seeded with the user's decisions"
    _grok_trusts(shim, f"{WS}/a")
    assert real.read_text(encoding="utf-8") == USERS_OWN, "a pane's answer reaches it only through the merge"

    _prepare("p2")

    assert pane_home.grok_trust_ledger_rows().keys() == {f"{WS}/a"}
    assert f"{WS}/a" in _folders(_shim_trust("p2"))


def test_a_link_left_by_an_earlier_build_becomes_the_panes_own_copy(gate, home: Path) -> None:
    real = home / ".grok" / TRUST
    real.write_text(USERS_OWN, encoding="utf-8")
    _prepare("p1")
    shim = _shim_trust("p1")
    shim.unlink()
    shim.symlink_to(real)  # what main's mirror pass made of an existing file

    _prepare("p1")

    assert shim.is_file() and not shim.is_symlink()


def test_the_switch_leaves_every_pane_its_own_file(gate, home: Path) -> None:
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")
    _prepare("p2")
    stale = _shim_trust("p3")
    _prepare("p3")
    stale.unlink()
    stale.symlink_to(home / ".grok" / TRUST)  # a pane not prepared since an earlier build

    _off()

    for pane in ("p1", "p2", "p3"):
        assert not _shim_trust(pane).is_symlink(), pane
    _prepare("p1")
    assert f"{WS}/a" in _folders(_shim_trust("p1")), "the pane that decided keeps its decision"
    assert not (home / ".grok" / TRUST).exists()


def test_rows_stranded_by_earlier_versions_are_rescued(gate, home: Path) -> None:
    # A shim built before this fix: Grok wrote its trust file there and the
    # pane was never prepared again.
    stranded = pane_home.panes_root() / "grok" / "old-pane" / ".grok"
    stranded.mkdir(parents=True)
    _grok_trusts(stranded / TRUST, f"{WS}/old")
    _prepare("old-pane")

    _prepare("p1")

    assert f"{WS}/old" in _folders(home / ".grok" / TRUST)


def test_a_shim_with_no_recorded_workspace_keeps_its_trust(gate, home: Path) -> None:
    # Nothing says which folder that pane was opened in, so nothing it
    # trusted can be shown to be its own.
    stranded = pane_home.panes_root() / "grok" / "old-pane" / ".grok"
    stranded.mkdir(parents=True)
    _grok_trusts(stranded / TRUST, f"{WS}/old")

    _prepare("p1")

    assert not (home / ".grok" / TRUST).exists()
    assert f"{WS}/old" in _folders(stranded / TRUST)


@pytest.mark.parametrize(
    "folder",
    ["/", "WS/../", "HOME", "HOME/", "WS/../elsewhere", "WS-other", "WS/a/../../etc", "relative/path", "~/x", "/nowhere"],
)
def test_only_a_folder_in_the_panes_own_workspace_reaches_the_users_file(
    gate, home: Path, folder: str
) -> None:
    folder = folder.replace("HOME", str(home)).replace("WS", WS)
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), folder)
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")

    _prepare("p2")

    assert set(_folders(home / ".grok" / TRUST)) == {f"{WS}/a"}
    assert folder in _folders(_shim_trust("p1")), "the pane keeps its own answer"
    assert set(pane_home.grok_trust_ledger_rows()) == {f"{WS}/a"}


def test_a_link_into_the_workspace_is_judged_by_where_it_points(gate, home: Path, tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    (workspace / "inside").mkdir(parents=True)
    (workspace / "out").symlink_to(home)
    (workspace / "top").symlink_to("/")
    (workspace / "dangling").symlink_to(tmp_path / "gone")
    (workspace / "sideways").symlink_to(workspace / "inside")  # may be pointed elsewhere later
    (tmp_path / "ws-link").symlink_to(workspace)
    _prepare("p1", str(tmp_path / "ws-link") + "/")
    for name in ("out", "top", "dangling", "sideways"):
        _grok_trusts(_shim_trust("p1"), str(workspace / name))
    _grok_trusts(_shim_trust("p1"), str(workspace / "inside") + "/")
    _grok_trusts(_shim_trust("p1"), str(tmp_path / "ws-link" / "inside"))

    _prepare("p2")

    assert set(_folders(home / ".grok" / TRUST)) == {
        str(workspace / "inside") + "/", str(tmp_path / "ws-link" / "inside")
    }


def test_a_workspace_link_moved_after_the_spawn_shares_nothing_new(gate, home: Path, tmp_path: Path) -> None:
    (tmp_path / "ws" / "inside").mkdir(parents=True)
    (tmp_path / "ws-link").symlink_to(tmp_path / "ws")
    _prepare("p1", str(tmp_path / "ws-link"))
    (tmp_path / "ws-link").unlink()
    (tmp_path / "ws-link").symlink_to(home)
    _grok_trusts(_shim_trust("p1"), str(home))
    _grok_trusts(_shim_trust("p1"), str(tmp_path / "ws-link" / ".grok"))

    _prepare("p2")

    assert not (home / ".grok" / TRUST).exists()


@pytest.mark.parametrize("workspace", ["/", "HOME", "HOME/..", ""])
def test_a_pane_opened_at_the_root_or_home_promotes_nothing(gate, home: Path, workspace: str) -> None:
    (home / "proj").mkdir()
    _prepare("p1", workspace.replace("HOME", str(home)))
    _grok_trusts(_shim_trust("p1"), str(home / "proj"))
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")

    _prepare("p2")

    assert not (home / ".grok" / TRUST).exists()


def test_the_workspace_itself_and_folders_below_it_are_shared(gate, home: Path) -> None:
    (Path(WS) / "a" / "deep").mkdir()
    _prepare("p1")
    for folder in (WS, f"{WS}/", f"{WS}/a/deep", f"{WS}/./b//"):
        _grok_trusts(_shim_trust("p1"), folder)

    _prepare("p2")

    assert set(_folders(home / ".grok" / TRUST)) == {WS, f"{WS}/", f"{WS}/a/deep", f"{WS}/./b//"}


@pytest.mark.skipif(sys.platform not in ("darwin", "win32"), reason="case-insensitive paths")
def test_the_home_folder_in_another_case_is_still_refused(gate, home: Path) -> None:
    _prepare("p1", str(home).upper())
    _grok_trusts(_shim_trust("p1"), str(home).upper())
    _grok_trusts(_shim_trust("p1"), str(home / ".grok").upper())
    _prepare("p2", str(home.parent).swapcase())
    _grok_trusts(_shim_trust("p2"), f"{WS}/a")

    _prepare("p3")

    assert not (home / ".grok" / TRUST).exists()


def test_only_trusted_and_decided_at_reach_the_users_file(gate, home: Path) -> None:
    _prepare("p1")
    shim = _shim_trust("p1")
    shim.write_text(
        tomli_w.dumps({"folders": {
            f"{WS}/a": {"trusted": True, "decided_at": 5, "sandbox": "off"},
            f"{WS}/b": {"sandbox": "off"},
        }}),
        encoding="utf-8",
    )

    _prepare("p2")

    assert _folders(home / ".grok" / TRUST) == {f"{WS}/a": {"trusted": True, "decided_at": 5}}


def test_navides_records_live_in_its_own_folder_and_old_ones_are_read_once(
    gate, home: Path, tmp_path: Path
) -> None:
    old = pane_home.panes_root() / "grok"
    old.mkdir(parents=True)
    block = tomli_w.dumps({"folders": {f"{WS}/a": {"trusted": True}}})
    (old / ".folder-trust-merged.json").write_text(
        json.dumps({"created": True, "rows": {f"{WS}/a": {"chunk": block, "block": block, "pane": "p0"}}}),
        encoding="utf-8",
    )
    (home / ".grok" / TRUST).write_text(block, encoding="utf-8")

    _prepare("p1")

    own = tmp_path / "grok-folder-trust"
    assert f"{WS}/a" in json.loads((own / ".folder-trust-merged.json").read_text(encoding="utf-8"))["rows"]
    assert "p1" in json.loads((own / ".folder-trust-seeds.json").read_text(encoding="utf-8"))
    assert json.loads((own / ".folder-trust-workspaces.json").read_text(encoding="utf-8")) == {
        "p1": {"path": WS, "real": WS}
    }
    assert (old / ".folder-trust-merged.json").exists(), "the old file is left where it was"
    assert not (old / ".folder-trust-seeds.json").exists()
    _off()
    assert not (home / ".grok" / TRUST).exists()
    # A ledger planted beside the shims later is never read again.
    (home / ".grok" / TRUST).write_text(block, encoding="utf-8")
    _prepare("p1")
    assert pane_home.grok_trust_ledger_rows() == {}


def test_each_pane_promotes_only_its_own_workspace(gate, home: Path) -> None:
    _prepare("p1", f"{WS}/a")
    _prepare("p2", f"{WS}/b")
    _grok_trusts(_shim_trust("p1"), f"{WS}/b")
    _grok_trusts(_shim_trust("p2"), f"{WS}/b")

    _prepare("p3")

    assert pane_home.grok_trust_ledger_rows()[f"{WS}/b"]["pane"] == "p2"


def test_a_row_the_user_deletes_is_not_brought_back(gate, home: Path) -> None:
    real = home / ".grok" / TRUST
    real.write_text(USERS_OWN, encoding="utf-8")
    _prepare("p1")  # p1's copy now holds the user's /mine
    real.write_text(USERS_OWN.split("# a second one")[1].lstrip("\n"), encoding="utf-8")

    _prepare("p2")

    assert "/mine" not in _folders(real)


def test_a_datetime_row_is_merged_and_ledgered(gate, home: Path) -> None:
    import datetime

    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), f"{WS}/dt", datetime.datetime(2026, 10, 20, 5, 0, tzinfo=datetime.UTC))

    _prepare("p2")

    assert f"{WS}/dt" in _folders(home / ".grok" / TRUST)
    assert f"{WS}/dt" in pane_home.grok_trust_ledger_rows()
    _off()
    assert not (home / ".grok" / TRUST).exists()


def test_the_ledger_never_misses_a_row_in_the_users_file(
    gate, home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = home / ".grok" / TRUST
    real.write_text(USERS_OWN, encoding="utf-8")
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")
    original = pane_home._write_text

    def fail_on_the_users_file(path: Path, content: str) -> None:
        if path == real:
            raise OSError("disk full")
        original(path, content)

    monkeypatch.setattr(pane_home, "_write_text", fail_on_the_users_file)

    _prepare("p2")

    assert real.read_text(encoding="utf-8") == USERS_OWN
    assert pane_home.grok_trust_ledger_rows() == {}


def test_a_failing_merge_never_blocks_the_spawn(gate, home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(_real_vendor: Path) -> None:
        raise TypeError("unexpected value")

    monkeypatch.setattr(pane_home, "merge_grok_folder_trust", broken)
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")

    _prepare("p2")


def test_nothing_is_written_without_the_gate(home: Path) -> None:
    convenience_wiring.install(None)  # conftest installs one for every test
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")

    _prepare("p2")

    assert not (home / ".grok" / TRUST).exists()


def test_nothing_is_created_when_no_pane_ever_trusted_a_folder(gate, home: Path) -> None:
    _prepare("p1")

    assert not (home / ".grok" / TRUST).exists()


# ---- through the convenience gate ----


def test_the_merge_is_backed_up_announced_and_taken_back_by_the_switch(gate, home: Path) -> None:
    real = home / ".grok" / TRUST
    real.write_text(USERS_OWN, encoding="utf-8")
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")

    _prepare("p2")

    assert f"{WS}/a" in _folders(real)
    history = gate.history("grok.folder-trust")
    assert [(e["action"], e["notify"]) for e in history] == [("first", True)]
    assert history[0]["backup"], "the user's file is backed up before Navide writes it"

    _off()

    assert real.read_text(encoding="utf-8") == USERS_OWN


def test_the_switch_removes_a_file_navide_created(gate, home: Path) -> None:
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")
    _prepare("p2")
    assert (home / ".grok" / TRUST).exists()

    _off()

    assert not (home / ".grok" / TRUST).exists()


def test_switched_off_trust_stays_in_the_pane(gate, home: Path) -> None:
    _off()
    _prepare("p1")
    _grok_trusts(_shim_trust("p1"), f"{WS}/a")

    _prepare("p2")
    _prepare("p1")

    assert not (home / ".grok" / TRUST).exists()
    assert f"{WS}/a" in _folders(_shim_trust("p1"))
    assert f"{WS}/a" not in _folders(_shim_trust("p2")) if _shim_trust("p2").exists() else True


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
    script = tmp_path / "grok.py"
    script.write_text(
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
    # A launcher the platform can start directly: a shebang script on POSIX,
    # a .cmd wrapper on Windows (which cannot run a script file itself).
    if sys.platform == "win32":
        fake = tmp_path / "grok.cmd"
        fake.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    else:
        fake = tmp_path / "grok"
        fake.write_text(f"#!/bin/sh\nexec '{sys.executable}' '{script}' \"$@\"\n", encoding="utf-8")
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
    assert "x.ai/cli/install." in result["warning"]  # install.sh, or install.ps1 on Windows


def test_the_startup_probe_is_quiet_for_grok_build(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    result = _probe_prints(monkeypatch, tmp_path, "grok 1.0.62 (1474f9cbdd91)\n")

    assert "warning" not in result
    assert result["version"] == "1.0.62"


# ---- cli_answer_prompt ----


def test_the_trust_prompt_is_answerable() -> None:
    assert "grok" in relay.ANSWERABLE_AGENTS


def _trust_request() -> relay.RelayRequest:
    return relay.RelayRequest(
        id="", pane_id="p1", kind="permission", options=[], loc=relay.Location("mcp", "", ""),
        prompt="Do you trust the contents of this directory?", agent_key="grok",
    )


def test_trusting_a_folder_is_a_permanent_allow_no_agent_or_chat_may_give() -> None:
    # Grok keeps the folder for good, and grok.folder-trust shares it with
    # every Grok pane: the same rule as "don't ask again" (#442).
    assert relay.refuses_permanent(_trust_request(), "y")
    assert not relay.refuses_permanent(_trust_request(), "n")
    assert [label for label, _ in relay.buttons_for(_trust_request())] == ["拒絕"]

