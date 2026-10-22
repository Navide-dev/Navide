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
    lines = text.split("\n")
    for hook in hooks:
        assert lines.count(hook) == 1, f"hook line must appear exactly once: {hook!r}"
        lines.remove(hook)
    return "\n".join(lines)


def _entries() -> list[dict]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("entry", _entries(), ids=lambda e: f"{e['file']}::{e['function']}")
def test_an_existing_function_is_mains_plus_only_its_acp_hook(entry: dict) -> None:
    current = _function_source((REPO / entry["file"]).read_text(encoding="utf-8"), entry["function"])
    assert _without_hooks(current, entry["hooks"]) == entry["main"]


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
