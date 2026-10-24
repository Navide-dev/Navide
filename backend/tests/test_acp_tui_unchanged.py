"""ACP is additive: every existing function it hooks into is main's, word for word.

ACP panes are opt-in (2026-10-23, user: "原本的模式要全部保留，程式碼不要被影響").
Each existing function that ACP needs to reach gets ONE added line ("if this is
an ACP pane, hand it to the ACP module") and nothing else. This test proves it:
for each entry in ``data/acp_unchanged_main.json`` it takes the function's
current source, removes exactly the hook lines listed for it, and requires the
rest to equal main's source of that function byte for byte. Any other edit to
those functions, however small, fails here.

The fixture holds main's text of each function at the commit the ACP work
branched from. When main itself changes one of these functions, regenerate:

    uv --project backend run --no-sync python backend/tests/test_acp_tui_unchanged.py <main commit>

which re-reads each listed function from ``git show <commit>:<file>`` and keeps
the hook lists.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / "data" / "acp_unchanged_main.json"


def _function_source(source: str, qualname: str) -> str:
    """The source lines of ``qualname`` (``func`` or ``Class.method``), decorators included."""
    tree = ast.parse(source)
    parts = qualname.split(".")
    scope: list[ast.stmt] = tree.body
    node: ast.AST | None = None
    for part in parts:
        node = next(
            (
                n for n in scope
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == part
            ),
            None,
        )
        if node is None:
            raise LookupError(qualname)
        scope = node.body  # type: ignore[attr-defined]
    assert isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
    start = min([node.lineno, *(d.lineno for d in node.decorator_list)])
    lines = source.split("\n")
    return "\n".join(lines[start - 1:node.end_lineno])


def _without_hooks(text: str, hooks: list[str]) -> str:
    """``text`` without each hook (one or more whole lines), each required exactly once."""
    out = f"\n{text}\n"
    for hook in hooks:
        needle = f"\n{hook}\n"
        at = out.find(needle)
        assert at >= 0 and out.find(needle, at + 1) < 0, f"hook must appear exactly once: {hook!r}"
        out = out[:at] + out[at + len(needle) - 1:]
    return out[1:-1]


def _entries() -> list[dict]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("entry", _entries(), ids=lambda e: f"{e['file']}::{e['function']}")
def test_an_existing_function_is_mains_plus_only_its_acp_hook(entry: dict) -> None:
    current = _function_source((REPO / entry["file"]).read_text(encoding="utf-8"), entry["function"])
    assert _without_hooks(current, entry["hooks"]) == entry["main"]


#: The requests acp_ws registers (its module doc lists the same six).
ACP_MESSAGE_TYPES = frozenset({
    "acp.create", "acp.prompt", "acp.cancel", "acp.permission_answer", "acp.kill", "acp.list",
})


def test_acp_launches_is_empty_until_p5() -> None:
    # No CLI can be started over ACP until its ACP mode is verified (P5). Opening
    # one up is a deliberate change: edit this test with it.
    from agent_team_backend.acp_vendors import ACP_LAUNCHES

    assert ACP_LAUNCHES == {}


def test_acp_registers_only_acp_message_types() -> None:
    from agent_team_backend import app, ws_handlers  # noqa: F401 — app imports acp_ws

    by_acp = {mt for mt, fn in ws_handlers._REGISTRY.items() if fn.__module__ == "agent_team_backend.acp_ws"}
    assert by_acp == ACP_MESSAGE_TYPES
    # Nothing else answers an acp.* request, and acp_ws answers nothing else.
    assert {mt for mt in ws_handlers._REGISTRY if mt.startswith("acp.")} == ACP_MESSAGE_TYPES


async def test_acp_hooks_never_start_the_service_without_an_acp_pane(monkeypatch: pytest.MonkeyPatch) -> None:
    # Every hook main's code now calls answers "not mine" with no ACP agent
    # ever started: no service is created, nothing goes to a thread.
    from types import SimpleNamespace

    from agent_team_backend import acp_mcp, acp_ws, app  # noqa: F401 — sweep_ownerless imports app

    monkeypatch.setattr(acp_ws, "_SERVICE", None)
    monkeypatch.setattr(acp_ws, "_OWNERS", {})

    def no_thread(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("an ACP hook went to a thread with no ACP agent")

    monkeypatch.setattr(acp_ws.asyncio, "to_thread", no_thread)

    def never(*_args: object) -> dict:
        raise AssertionError("the ACP wait answered for a pane that is not ACP")

    sweep = {"panes": [{"terminal_session_id": "t1", "pane_id": "tui", "bytes": 10, "cpu_seconds": 1.0}], "total_bytes": 10}
    assert await acp_ws.with_resource_rows(sweep) is sweep
    assert await acp_ws.sweep_ownerless() == []
    await acp_ws.shutdown()
    acp_ws.drop_owner(object())  # type: ignore[arg-type]
    assert acp_mcp.transcript_path("tui") == ""
    assert acp_mcp.status_fields("tui") == {}
    assert await acp_mcp.interrupt(SimpleNamespace(pane_id="tui")) is None
    assert await acp_mcp.wait_idle("tui", 1.0, never, never, never) is None
    assert acp_ws._SERVICE is None


#: main's dump of its core tools (also pinned by test_share_mcp_tools.py).
MCP_BASELINE = Path(__file__).parent / "data" / "mcp_core_tools_main.json"


@pytest.mark.parametrize(
    "name", ["cli_read_log", "cli_get_status", "cli_wait_idle", "cli_interrupt", "cli_open_agent", "cli_send"],
)
def test_the_tools_acp_reaches_are_mains_word_for_word(name: str) -> None:
    # Description and input schema: no ACP paragraph, no display argument,
    # until an ACP entry point ships (P5, see acp_mcp's TODO).
    from agent_team_backend.mcp_server import server as mcp

    [main] = [t for t in json.loads(MCP_BASELINE.read_text(encoding="utf-8")) if t["name"] == name]
    [tool] = [t for t in mcp.server._tool_manager.list_tools() if t.name == name]  # noqa: SLF001
    current = {"name": tool.name, "description": tool.description, "parameters": tool.parameters}
    assert json.loads(json.dumps(current, sort_keys=True)) == main


def _regenerate(commit: str) -> None:
    entries = _entries()
    for entry in entries:
        main_file = subprocess.run(
            ["git", "-C", str(REPO), "show", f"{commit}:{entry['file']}"],
            check=True, capture_output=True, text=True,
        ).stdout
        entry["main"] = _function_source(main_file, entry["function"])
    FIXTURE.write_text(json.dumps(entries, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    _regenerate(sys.argv[1])
