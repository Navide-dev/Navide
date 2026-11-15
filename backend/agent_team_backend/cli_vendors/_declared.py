"""How each CLI is launched and resumed: read from the Rust runtime's declarations.

``native/navide-cli-runtime/src/vendors/<key>.rs`` declares a CLI once.
``cli_declarations.json`` (beside the package) is that declaration's launch
and resume part, printed by ``navide-cli-runtime declarations launch`` and
checked in (the crate's ``tests/checked_in.rs`` fails when it is not what the
source prints), so the backend needs no binary to read it. It is also the
list of CLIs there are and their order (``registry.py``). A vendor module
spreads ``declared(key)`` into its ``VendorSpec`` instead of keeping its own
copy of:

* the display label;
* whether a spawn may name a model or an effort, and the effort vocabulary;
* the environment defaults a spawn adds and the home variables it strips;
* the interrupt byte;
* whether a session can be resumed by id, and how a saved command names the
  session it resumes (``resume_id``).

The frontend's agent specs read the same output for the arguments themselves
(``src/renderer/src/platform/plugin-shell/agents/_declared.ts``, from the same
output generated beside it as a typed constant).
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from .base import command_text, simple_command_args

FILE = Path(__file__).resolve().parent.parent / "cli_declarations.json"


@lru_cache(maxsize=1)
def declarations() -> dict[str, dict[str, Any]]:
    """Every declared CLI by key."""
    return {entry["key"]: entry for entry in json.loads(FILE.read_text(encoding="utf-8"))}


def _shaped(value: str, shape: Any) -> str | None:
    """The id a value names when it has the declared shape, else None."""
    if shape == "Any":
        return value or None
    if shape == "NoDash":
        return value if value and not value.startswith("-") else None
    if shape == "Uuid":
        groups = value.split("-")
        hexdigits = "0123456789abcdefABCDEF"
        ok = [len(g) for g in groups] == [8, 4, 4, 4, 12] and all(c in hexdigits for g in groups for c in g)
        return value.lower() if ok else None
    prefix = shape["Prefix"]
    return value if value.startswith(prefix) and value.strip() == value else None


def _scan(parse: dict[str, Any], tokens: list[str], literal: bool) -> str:
    if not tokens or tokens[0] not in parse["programs"]:
        return ""
    start = 1
    if parse["subcommand"]:
        if len(tokens) < 2 or tokens[1] not in parse["subcommand"]:
            return ""
        if parse["id_after_subcommand"]:
            return (_shaped(tokens[2], parse["value"]) if len(tokens) > 2 else None) or ""
        start = 2
    flags = parse["flags"]
    found: list[str] = []
    for i in range(start, len(tokens)):
        token = tokens[i]
        if literal and token == "--":
            break
        # (True, None): this occurrence names a session, in the wrong shape.
        named, value = False, None
        if token in flags and i + 1 < len(tokens):
            named, value = True, _shaped(tokens[i + 1], parse["value"])
        elif parse["joined"] is not None:
            for flag in flags:
                if flag.startswith("--") and token.startswith(flag + "="):
                    named, value = True, _shaped(token[len(flag) + 1:], parse["joined"])
                    break
        if not named:
            continue
        if literal:
            return value or ""
        if value is not None:
            found.append(value)
            if parse["pick"] == "First":
                break
    if not found:
        return ""
    return found[0] if parse["pick"] == "First" else found[-1]


def resume_id(key: str, command: Any) -> str:
    """The session id a saved launch command of CLI ``key`` resumes, "" when
    it names none (or the CLI cannot resume by id).

    ``Whitespace`` declarations read the command's last element (a shell
    wrapper's script) split on whitespace; ``Literal`` ones only a literal
    invocation (known shell wrappers unwrapped, no shell metacharacters,
    shell-quoted split), and stop at ``--``.
    """
    parse = declarations()[key]["resume"]["parse"]
    if parse is None:
        return ""
    if parse["tokens"] == "Whitespace":
        return _scan(parse, command_text(command).split(), literal=False)
    return _scan(parse, simple_command_args(command), literal=True)


def declared(key: str) -> dict[str, Any]:
    """The ``VendorSpec`` fields the declaration of ``key`` decides."""
    entry = declarations()[key]
    launch, resume = entry["launch"], entry["resume"]
    parser: Callable[[Any], str] | None = None
    if resume["parse"] is not None:
        def parser(command: Any) -> str:
            return resume_id(key, command)
    interrupt = bytes(entry["interrupt"])
    return {
        "label": entry["label"],
        "supports_model": launch["model"] is not None,
        "supports_effort": launch["effort"] is not None,
        "known_efforts": tuple(launch["efforts"]),
        "spawn_env_defaults": tuple((name, value) for name, value in launch["env_defaults"]),
        "home_env_vars": tuple(launch["env_strip"]),
        # The registry's convention: None is the default (^C, which the
        # terminal layer supplies); a key is named only when it is another.
        "interrupt_key": interrupt if interrupt != b"\x03" else None,
        "supports_session_resume": resume["args"] is not None,
        "resume_id_from_command": parser,
    }
