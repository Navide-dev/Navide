"""The Rust runtime's declarations are the one source for launch and resume.

``cli_declarations.json`` (in the backend package) is what
``navide-cli-runtime declarations launch`` prints; the vendor registry is
built from it, and the frontend's agent specs from the same output as a typed
constant (``agents/_cli_declarations.ts``).

``cli_declarations_main.json`` (beside this file) is what main's own registry
held and answered before it read the declarations: each CLI's launch and
resume fields, and the session id each of main's ``resume_id_from_command``
functions found in every command of ``_corpus``. It was recorded from those
functions and is not regenerated: the declarations must keep giving the same
values and the same ids.

One entry follows upstream main's later change instead of the recording: claude's
``spawn_env_defaults`` holds ``MCP_TIMEOUT=120000``, which upstream main added to
claude's ``VendorSpec`` after this recording was made (the 2026-11-12 MCP connect
budget). Launch facts now come from the declaration, so that change was carried
into ``vendors/claude.rs`` and this entry was edited by hand to match. Any further
upstream change to a declared CLI's launch or resume fact is carried the same way.

The recording covers the CLIs main had. A CLI declared after it is not in the
recording and needs no edit to it: the recorded tests iterate over the
recorded keys only (and require those to still be declared), and the tests
over every declared key need no recording.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.cli_vendors import _declared as cli_declarations
from agent_team_backend.cli_vendors import registry
from tests import cli_runtime_build

MAIN = Path(__file__).with_name("cli_declarations_main.json")
#: Every declared CLI.
KEYS = sorted(cli_declarations.declarations())
#: The CLIs the recording of main holds: a subset of KEYS.
RECORDED = sorted(json.loads(MAIN.read_text(encoding="utf-8"))["launch"])

_UUID = "0198f6a2-71aa-4d02-9c11-2233445566aa"
_VALUES = ("abc123", _UUID, _UUID.upper(), "-x", "--yolo", "agent:main:navide-1", "navide-abc", "navide-abc #2",
           "my title", "", "a=b", "at-pane:1", "'quoted id'", '"agent:main:x y"', "$ID", "id;rm", "(x)")
_FLAGS = ("--resume", "-r", "--session", "-s", "-S", "--session-id", "--continue", "-c", "--conversation",
          "--thread")
_SUBS = ("resume", "session", "s", "chat", "tui")


def _corpus(key: str) -> list[Any]:
    """Every shape a saved launch command takes, for one CLI: its programs and
    another, every resume flag any CLI has, in the spaced and ``=`` forms,
    repeated, after ``--``, behind subcommands, shell-wrapped, and not a
    command at all. Deterministic: the recorded ids are indexed by position."""
    declared = cli_declarations.declarations()[key]
    parse = declared["resume"]["parse"]
    programs = [*(parse["programs"] if parse else [declared["launch"]["program"]]), "other-cli"]
    plain: list[str] = []
    for prog in programs:
        for value in _VALUES:
            for flag in _FLAGS:
                plain += [
                    f"{prog} {flag} {value}",
                    f"{prog} {flag}={value}",
                    f"{prog} --yolo {flag} {value} --model m",
                    f"{prog} {flag} first {flag} {value}",
                    f"{prog} {flag}=first {flag}={value}",
                    f"{prog} -- {flag} {value}",
                    f"{prog} {flag} {value} -- tail",
                    f"{prog} chat {flag} {value}",
                    f"{prog} tui --local {flag} {value}",
                ]
            for sub in _SUBS:
                plain += [
                    f"{prog} {sub} {value}",
                    f"{prog} {sub} -r --session-id {value}",
                    f"{prog} {sub} --session-id={value} -r",
                    f"{prog} {sub} --continue {value}",
                    f"{prog} {sub} --session={value}",
                ]
        plain += [prog, f"{prog} ", f"  {prog}   --resume   spaced  ", f"FOO=1 {prog} --resume abc", f"{prog}\t-r\tabc"]
    wrapped: list[Any] = []
    for command in plain[::5]:
        wrapped += [
            ["/bin/zsh", "-ilc", command],
            ["bash", "-c", command],
            ["cmd.exe", "/d", "/s", "/c", command],
            ["pwsh", "-NoLogo", "-NoExit", "-Command", command],
            ["python", "-c", command],
            [command],
        ]
    odd: list[Any] = [None, 42, "", [], ["zsh", "-ilc"], [programs[0], "--resume", "abc"]]
    return [*plain, *wrapped, *odd]


def _main() -> dict[str, Any]:
    return json.loads(MAIN.read_text(encoding="utf-8"))


def _launch_fields(key: str) -> dict[str, Any]:
    """The declaration's registry fields, JSON-shaped like the recording."""
    fields = cli_declarations.declared(key)
    return {
        "supports_model": fields["supports_model"],
        "supports_effort": fields["supports_effort"],
        "known_efforts": list(fields["known_efforts"]),
        "spawn_env_defaults": [list(pair) for pair in fields["spawn_env_defaults"]],
        "home_env_vars": list(fields["home_env_vars"]),
        "interrupt_key": list(fields["interrupt_key"] or b"\x03"),
        "supports_session_resume": fields["supports_session_resume"],
        "names_a_session": fields["resume_id_from_command"] is not None,
    }


def test_every_registered_cli_is_declared_once() -> None:
    assert KEYS == sorted(registry.VENDORS)


def test_the_recording_of_main_is_of_declared_clis() -> None:
    """A recorded CLI that is no longer declared would silently stop being
    compared; a declared CLI the recording lacks is a newer one."""
    assert set(RECORDED) <= set(KEYS)
    assert sorted(_main()["resume_ids"]) == RECORDED


def test_only_codex_of_mains_clis_is_interrupted_by_another_byte() -> None:
    # Only a CLI interrupted by another byte than ^C names its key (codex: Esc).
    assert {key: registry.VENDORS[key].interrupt_key for key in RECORDED if registry.VENDORS[key].interrupt_key} == {
        "codex": b"\x1b"}


@pytest.mark.parametrize("key", RECORDED)
def test_launch_and_resume_fields_are_mains(key: str) -> None:
    assert _launch_fields(key) == _main()["launch"][key]


@pytest.mark.parametrize("key", RECORDED)
def test_the_display_label_is_mains(key: str) -> None:
    """The label each vendor module typed by hand on main, which the declaration
    now supplies (`declared()` returns it; no vendor module spells its own)."""
    assert _main()["labels"][key] == registry.VENDORS[key].label == cli_declarations.declared(key)["label"]


@pytest.mark.parametrize("key", RECORDED)
def test_resume_ids_are_mains(key: str) -> None:
    recorded = _main()["resume_ids"][key]
    corpus = _corpus(key)
    assert len(corpus) == recorded["count"], "the corpus is what was recorded"
    got = {str(n): found for n, command in enumerate(corpus) if (found := cli_declarations.resume_id(key, command))}
    differ = {n: (corpus[int(n)], got.get(n, ""), recorded["ids"].get(n, ""))
              for n in sorted(set(got) | set(recorded["ids"]), key=int) if got.get(n, "") != recorded["ids"].get(n, "")}
    assert not differ, f"{len(differ)} command(s) name another session than on main (command, now, main): " \
                       f"{list(differ.values())[:5]}"


@pytest.mark.parametrize("key", KEYS)
def test_the_registry_holds_what_is_declared(key: str) -> None:
    spec = registry.VENDORS[key]
    declared = cli_declarations.declared(key)
    for name, value in declared.items():
        if name == "resume_id_from_command":
            assert (spec.resume_id_from_command is None) == (value is None)
            continue
        assert getattr(spec, name) == value, name
    for command in _corpus(key)[::37]:
        got = spec.resume_id_from_command(command) if spec.resume_id_from_command else ""
        assert got == cli_declarations.resume_id(key, command), command


#: The same output as a typed constant, inside the frontend module that reads
#: it (plugin-shell imports nothing from outside itself).
FRONTEND_FILE = (Path(__file__).resolve().parents[2] / "src" / "renderer" / "src" / "platform" / "plugin-shell"
                 / "agents" / "_cli_declarations.ts")
_REGENERATE = "run `NAVIDE_DECLARATIONS_WRITE=1 cargo test --test checked_in` in native/navide-cli-runtime"


def test_the_checked_in_declarations_are_current() -> None:
    """What the source prints, run from the source (``cargo run``, no binary
    built earlier), is what the backend reads. The crate's own
    ``tests/checked_in.rs`` holds both copies to the source too, and writes them."""
    printed = cli_runtime_build.cargo("run", "--quiet", "--", "declarations", "launch").stdout
    assert cli_declarations.FILE.read_text(encoding="utf-8") == printed, \
        f"{cli_declarations.FILE.name} is stale: {_REGENERATE}"


def test_backend_and_frontend_read_the_same_declarations() -> None:
    """Needs no build: the frontend's constant is the backend's JSON."""
    _header, marker, body = FRONTEND_FILE.read_text(encoding="utf-8").partition("export default ")
    assert marker, f"{FRONTEND_FILE.name} exports no default"
    assert body == cli_declarations.FILE.read_text(encoding="utf-8").rstrip("\n") + " as const\n", \
        f"{FRONTEND_FILE.name} is not {cli_declarations.FILE.name}: {_REGENERATE}"


def test_the_registry_and_menu_orders_are_declared() -> None:
    """Every CLI has its own place in both lists the app builds."""
    orders = [entry["order"] for entry in cli_declarations.declarations().values()]
    for name in ("menu", "registry"):
        places = [order[name] for order in orders]
        assert len(set(places)) == len(places) == len(KEYS), name


def _runtime_ids(key: str, commands: list[Any]) -> list[str]:
    """What the Rust ``resume_id`` (its own parser over the same declaration)
    reads out of each command."""
    requests = "".join(json.dumps({"id": n, "op": "resume_id", "vendor": key, "command": command}) + "\n"
                       for n, command in enumerate(commands))
    done = subprocess.run([str(cli_runtime_build.binary()), "serve"], input=requests, capture_output=True, text=True,
                          encoding="utf-8", check=True, timeout=120)
    answers = {a["id"]: a for a in map(json.loads, done.stdout.splitlines())}
    assert len(answers) == len(commands)
    for answer in answers.values():
        assert answer["ok"], answer
    return [answers[n]["result"] for n in range(len(commands))]


@pytest.mark.parametrize("key", RECORDED)
def test_the_runtime_names_the_same_sessions_as_main(key: str) -> None:
    """The Rust ``resume_id`` against the ids recorded from main, for a slice
    of the corpus."""
    commands = _corpus(key)[::3]
    recorded = _main()["resume_ids"][key]["ids"]
    assert _runtime_ids(key, commands) == [recorded.get(str(n * 3), "") for n in range(len(commands))]


@pytest.mark.parametrize("key", KEYS)
def test_the_runtime_and_the_backend_name_the_same_sessions(key: str) -> None:
    """The two readers of one declaration agree on every declared CLI, with or
    without a recording of main: a CLI added later is held by this test."""
    commands = _corpus(key)[::3]
    assert _runtime_ids(key, commands) == [cli_declarations.resume_id(key, command) for command in commands]
