"""A second module-level def of the same name silently replaces the first.

#493 review HIGH-1: a helper appended to mcp_server/server.py reused the name
of one 6K lines up, and cli_answer_prompt's disclosure quietly changed. Splice
and append edits to the giant modules make this easy to miss in review.
"""

from __future__ import annotations

import ast
from collections import Counter
from pathlib import Path

import agent_team_backend

_PACKAGE = Path(agent_team_backend.__file__).parent


def _is_overload(node: ast.AST) -> bool:
    decorators = getattr(node, "decorator_list", [])
    return any(
        (isinstance(d, ast.Name) and d.id == "overload") or (isinstance(d, ast.Attribute) and d.attr == "overload")
        for d in decorators
    )


def test_no_module_defines_the_same_top_level_name_twice() -> None:
    duplicates: dict[str, list[str]] = {}
    for path in sorted(_PACKAGE.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        names = Counter(
            node.name
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and not _is_overload(node)
        )
        repeated = sorted(name for name, count in names.items() if count > 1)
        if repeated:
            duplicates[str(path.relative_to(_PACKAGE))] = repeated
    assert not duplicates, duplicates
