"""The ``plan_*`` MCP tools — the ``navide.plans`` plugin's contribution.

These are the only tools in Navide's MCP server that are not core: plans are a
feature domain, and this plugin owns it. They are installed onto the core
server through ``PluginContext.register_mcp_tools`` rather than served from a
second endpoint, so an agent sees one tool list, not two.

The caller identity comes from :mod:`agent_team_backend.mcp_server.toolkit` —
the public half of that contract. Nothing here reaches into the server
module's privates.
"""

from __future__ import annotations

import asyncio
import re
import secrets
from datetime import datetime, timezone
from html import escape as html_escape
from pathlib import Path
from typing import Any

from agent_team_backend.fs_service import FsError, _resolve_safe, write_file
from agent_team_backend.mcp_server.toolkit import (
    Caller,
    caller_workspace,
    resolve_caller,
    workspace_mismatch_warning,
)
from agent_team_backend.plan_index import resolve_plan_root
from agent_team_backend.plugins.builtin.navide_plans.plan_meta import (
    PLAN_STAGES,
    TODO_OWNERS,
    TODO_STATUSES,
    parse_plan_meta,
    write_plan_meta,
)
from agent_team_backend.plan_provisioning import TEMPLATE_FILENAME, ensure_plan_assets
from mcp.server.fastmcp import Context

PLANS_REL_DIR = ".agent-team/plans"
_LEGACY_SAFE_BEFORE_DISPATCH = "legacy-safe-before-dispatch"
_READ_ONLY_PLAN_METHODS = frozenset({"plans.list", "plans.read"})
_MUTATING_PLAN_METHODS = frozenset({
    "plans.create",
    "plans.update_stage",
    "plans.update_todo",
    "plans.add_note",
    "plans.add_todo",
})
# Failures that mean no Host session can serve the call. They stay failures
# (no local fallback without the Host's disposition); the hint tells the
# agent what the user has to do. Codes are passed through unchanged.
_NO_HOST_SESSION_HINTS = {
    "host_unavailable": (
        " - the Navide app is not running or has no Host session;"
        " open Navide and retry."
    ),
    "BACKEND_UNAVAILABLE": (
        " - the Plans backend in the Navide app is not ready;"
        " open Navide (or reopen its Plans view) and retry."
    ),
}


#: The agent-tools contract's PLUGIN_TOOL_UNAVAILABLE / plugin-disabled refusal,
#: worded like the Host's.
PLANS_DISABLED_MESSAGE = (
    "PLUGIN_TOOL_UNAVAILABLE (plugin-disabled): Navide plugin Plans is disabled. "
    "Enable it in Settings → Navide Plugins."
)


async def _host_agent_plan_call(
    caller: Caller,
    workspace_path: str,
    name: str,
    arguments: dict[str, Any],
) -> Any:
    """Route through the Host; recover only from its pre-dispatch verdict.

    Read-only operations deliberately use the same Host-minted disposition as
    mutations: a generic availability response cannot prove the current agent
    Execution Policy still permits the filesystem operation.
    """
    from agent_team_backend import app
    from agent_team_backend.mcp_server.server import request_host_agent_workspace_backend

    if app.plans_plugin_disabled():
        # A CLI that cached tools/list still reaches here. The Host refuses the
        # same way; nothing below may serve the call locally instead.
        raise FsError(PLANS_DISABLED_MESSAGE, code="PLUGIN_TOOL_UNAVAILABLE")
    response = await request_host_agent_workspace_backend(
        "navide.plans",
        workspace_path,
        {"reqId": f"mcp:{secrets.token_hex(16)}", "name": name, "args": arguments},
        caller=caller,
    )
    if (
        name in _READ_ONLY_PLAN_METHODS and isinstance(response, dict) and
        response.get("ok") is False and response.get("error_code") == "host_timeout"
    ):
        # One slow Host answer (a stalled event loop, a child still starting)
        # should not fail a read; reads are safe to repeat. Mutations are not.
        response = await request_host_agent_workspace_backend(
            "navide.plans",
            workspace_path,
            {"reqId": f"mcp:{secrets.token_hex(16)}", "name": name, "args": arguments},
            caller=caller,
        )
    if not isinstance(response, dict):
        raise FsError("production Plans Host reply was malformed", code="BACKEND_UNAVAILABLE")
    if response.get("ok") is True:
        if "result" not in response:
            raise FsError("production Plans Host reply was malformed", code="BACKEND_UNAVAILABLE")
        return response["result"]
    if response.get("ok") is not False:
        raise FsError("production Plans Host reply was malformed", code="BACKEND_UNAVAILABLE")

    error = response.get("error")
    error_code = response.get("error_code")
    if isinstance(error, dict):
        error_code = error.get("code") or error_code
        message = error.get("message")
    else:
        message = error
    if (
        name in _READ_ONLY_PLAN_METHODS | _MUTATING_PLAN_METHODS and
        response.get("recoveryDisposition") == _LEGACY_SAFE_BEFORE_DISPATCH
    ):
        if not isinstance(error, dict) or not isinstance(error.get("code"), str):
            raise FsError("production Plans Host reply was malformed", code="BACKEND_UNAVAILABLE")
        # This exact value is a Host capability verdict, never an inference
        # from an error code. It is required for both the read-only recovery
        # path and every mutation path.
        return _NO_HOST_ROUTE
    code = error_code if isinstance(error_code, str) else "BACKEND_UNAVAILABLE"
    raise FsError(
        str(message or "production Plans backend request was denied") + _NO_HOST_SESSION_HINTS.get(code, ""),
        code=code,
    )


_NO_HOST_ROUTE = object()

_READ_RETRIES = 3


async def _read_plan_via_host(caller: Caller, workspace_path: str, rel_path: str) -> Any:
    """Assemble a plan of any size from the Host's paged ``plans.read``.

    A document that fits one page arrives as a single reply. A larger one
    carries ``eof: false`` and ``next_offset``; pages are fetched until the
    end and joined. If the file changes between pages the read restarts, so
    two versions are never spliced together.
    """
    for _ in range(_READ_RETRIES):
        first = await _host_agent_plan_call(caller, workspace_path, "plans.read", {"rel_path": rel_path})
        if first is _NO_HOST_ROUTE or not isinstance(first, dict) or first.get("eof") is not False:
            return first
        parts = [str(first.get("html", ""))]
        next_offset = first.get("next_offset")
        stable = True
        while True:
            if not isinstance(next_offset, int) or isinstance(next_offset, bool):
                raise FsError("plan read returned no next_offset", code="BACKEND_UNAVAILABLE")
            page = await _host_agent_plan_call(
                caller, workspace_path, "plans.read", {"rel_path": rel_path, "offset": next_offset}
            )
            if not isinstance(page, dict) or page is _NO_HOST_ROUTE:
                raise FsError("plan read page was malformed", code="BACKEND_UNAVAILABLE")
            if page.get("mtime") != first.get("mtime"):
                stable = False
                break
            parts.append(str(page.get("html", "")))
            if page.get("eof") is not False:
                break
            following = page.get("next_offset")
            if not isinstance(following, int) or following <= next_offset:
                raise FsError("plan read made no progress", code="BACKEND_UNAVAILABLE")
            next_offset = following
        if stable:
            whole = {k: v for k, v in first.items() if k not in ("size", "offset", "eof", "next_offset")}
            whole["html"] = "".join(parts)
            return whole
    raise FsError(f"plan changed while it was being read: {rel_path}; retry", code="CONFLICT")


# ── sync filesystem layer (runs in a worker thread) ─────────────────────────


def _plans_root(workspace_path: str) -> Path:
    """Resolve the plans dir under the workspace (raises FsError on escape)."""
    return _resolve_safe(workspace_path, PLANS_REL_DIR)


def _plan_rel_path(filename: str) -> str:
    """Workspace-relative path of a plan file — the form every tool returns.

    Agents echo returned paths into the terminal, where Navide's cmd+click
    router only recognizes the full ``.agent-team/plans/…`` form.
    """
    return f"{PLANS_REL_DIR}/{filename}"


def _plan_filename(rel_path: str) -> str:
    """Bare filename from either accepted input form (full path or filename)."""
    cleaned = str(rel_path or "").strip().lstrip("/")
    prefix = f"{PLANS_REL_DIR}/"
    return cleaned[len(prefix) :] if cleaned.startswith(prefix) else cleaned


def _todo_summary(meta: dict[str, Any]) -> dict[str, Any]:
    """Summarize the meta's todos as {total, by_status, awaiting_user} counts.

    `awaiting_user` is the count of unfinished todos nobody but the user can
    do — a manual verification, a decision, a credential only they hold. It is
    surfaced in the listing because otherwise it is invisible: a finished
    write-up whose only remaining item is "verify on a real machine" looks
    exactly like an untouched plan, and the reader has to open every document
    to tell which ones are actually waiting on them.
    """
    counts: dict[str, int] = {}
    total = 0
    awaiting_user = 0
    todos = meta.get("todos")
    if isinstance(todos, list):
        for todo in todos:
            if not isinstance(todo, dict):
                continue
            total += 1
            status = todo.get("status")
            key = status if isinstance(status, str) and status else "unknown"
            counts[key] = counts.get(key, 0) + 1
            if todo.get("owner") == "user" and key not in ("done", "skipped"):
                awaiting_user += 1
    return {"total": total, "by_status": counts, "awaiting_user": awaiting_user}


def _list_plans_sync(workspace_path: str) -> list[dict[str, Any]]:
    root = _plans_root(workspace_path)
    if not root.is_dir():
        return []
    entries: list[dict[str, Any]] = []
    for path in sorted(root.glob("*.html")):
        # `_`-prefixed files are provisioned assets (_template.html), not plans.
        if path.name.startswith("_") or not path.is_file():
            continue
        try:
            html = path.read_text(encoding="utf-8", errors="replace")
            stat = path.stat()
        except OSError as error:
            # Never drop a plan document from the list: an unreadable one is
            # listed with the reason so the user can see it exists.
            entries.append(
                {
                    "rel_path": _plan_rel_path(path.name),
                    "name": path.name,
                    "stage": None,
                    "overview": "",
                    "todos": {"total": 0, "by_status": {}, "awaiting_user": 0},
                    "mtime": None,
                    "kind": "unreadable",
                    "reason": f"could not be read ({error.strerror or type(error).__name__})",
                }
            )
            continue
        meta = parse_plan_meta(html)
        if meta is None:
            # No usable plan-meta island: still a document the user owns, so
            # it is listed (kind "document") rather than hidden.
            entries.append(
                {
                    "rel_path": _plan_rel_path(path.name),
                    "name": path.name,
                    "stage": None,
                    "overview": "",
                    "todos": {"total": 0, "by_status": {}, "awaiting_user": 0},
                    "mtime": stat.st_mtime,
                    "kind": "document",
                    "reason": "missing or invalid plan-meta",
                    "size": stat.st_size,
                }
            )
            continue
        entries.append(
            {
                "rel_path": _plan_rel_path(path.name),
                "name": meta.get("name"),
                "stage": meta.get("stage"),
                "overview": meta.get("overview"),
                "todos": _todo_summary(meta),
                "mtime": stat.st_mtime,
            }
        )
    return entries


def _plan_target(workspace_path: str, rel_path: str) -> Path:
    """Resolve ``rel_path`` inside the plans dir; FsError when it escapes."""
    root = _plans_root(workspace_path)
    target = _resolve_safe(workspace_path, _plan_rel_path(_plan_filename(rel_path)))
    if target == root or not target.is_relative_to(root):
        raise FsError("path escapes the plans directory")
    return target


def _read_plan_sync(workspace_path: str, rel_path: str) -> dict[str, Any]:
    target = _plan_target(workspace_path, rel_path)
    if not target.is_file():
        raise FsError(f"plan not found: {rel_path}")
    html = target.read_text(encoding="utf-8", errors="replace")
    return {
        "rel_path": _plan_rel_path(_plan_filename(rel_path)),
        "meta": parse_plan_meta(html),
        "html": html,
    }


def _require_plan_sync(workspace_path: str, rel_path: str) -> None:
    """Assert the plan exists inside the plans subtree (same guard as reads)."""
    target = _plan_target(workspace_path, rel_path)
    if not target.is_file():
        raise FsError(f"plan not found: {rel_path}")


# ── write layer ─────────────────────────────────────────────────────────────

_TEMPLATE_TODO_LI_RE = re.compile(
    r"<li data-status=\"pending\" data-todo-id=\"phase-a\">[\s\S]*?</li>"
)
_PLACEHOLDER_RE = re.compile(r"\{\{[^{}]*\}\}")
_TODO_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]*")
_NOTE_ID_RE = re.compile(r"n(\d+)")
_AUTO_TODO_ID_RE = re.compile(r"t(\d+)")
_TODO_ROW_RE = re.compile(
    r"<li\b[^>]*\bdata-todo-id=[\"']([^\"']*)[\"'][^>]*>[\s\S]*?</li>", re.IGNORECASE
)
_EMPTY_TODO_LIST_RE = re.compile(
    r"(<ul\b[^>]*\bclass=[\"'][^\"']*\btodos\b[^\"']*[\"'][^>]*>)((?:\s|<!--[\s\S]*?-->)*)(</ul>)",
    re.IGNORECASE,
)
_TODO_MARKUP_WARNING = (
    "the todo was added to plan-meta, but its visible row was not inserted: "
    "no todo list (or no row for `after`) was found in the document"
)


def _load_plan_for_write(workspace_path: str, rel_path: str) -> tuple[str, dict[str, Any], float]:
    """Read a plan for a mutate-and-save cycle: (html, meta, mtime).

    mtime is taken BEFORE the read so a write racing in between fails the
    ``expected_mtime`` check in :func:`_save_plan` instead of going unnoticed.
    """
    target = _plan_target(workspace_path, rel_path)
    if not target.is_file():
        raise FsError(f"plan not found: {rel_path}")
    mtime = target.stat().st_mtime
    html = target.read_text(encoding="utf-8")
    meta = parse_plan_meta(html)
    if meta is None:
        raise FsError(f"not a plan document (missing/invalid plan-meta): {rel_path}")
    return html, meta, mtime


def _save_plan(
    workspace_path: str, rel_path: str, content: str, expected_mtime: float | None = None
) -> None:
    """Persist plan HTML via fs_service.write_file (atomic tmp+replace).

    ``expected_mtime`` is fs_service's optimistic lock: the write is refused
    when the file changed on disk since :func:`_load_plan_for_write` read it.
    """
    result = write_file(
        workspace_path,
        _plan_rel_path(_plan_filename(rel_path)),
        content,
        expected_mtime=expected_mtime,
    )
    if not result.get("ok"):
        if result.get("conflict"):
            raise FsError(
                f"conflict: {rel_path} changed on disk during the update; re-read and retry"
            )
        raise FsError(str(result.get("error") or "write failed"))


def _normalize_todos(
    todos: list[str | dict[str, str]], status: str = "pending"
) -> list[dict[str, str]]:
    """Validate the plan_create todos param into [{id, content, status}].

    `status` is what every todo starts at. A document created straight at
    "done" is a record of work already finished, so its todos are its sections,
    not things anyone is going to tick off later — leaving them pending would
    render as "0/8 done" on a document that is complete.
    """
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, item in enumerate(todos):
        owner = ""
        if isinstance(item, str):
            todo_id, content = "", item
        elif isinstance(item, dict):
            todo_id = str(item.get("id") or "")
            content = str(item.get("content") or "")
            owner = str(item.get("owner") or "")
        else:
            raise FsError("each todo must be a string or a {id?, content, owner?} object")
        if owner and owner not in TODO_OWNERS:
            raise FsError(f"invalid todo owner: {owner!r} (valid: {', '.join(sorted(TODO_OWNERS))})")
        content = content.strip()
        if not content:
            raise FsError(f"todo #{index + 1} has empty content")
        todo_id = todo_id.strip() or f"t{index + 1}"
        if _TODO_ID_RE.fullmatch(todo_id) is None:
            raise FsError(f"invalid todo id {todo_id!r} (use kebab-case: [a-z0-9-])")
        if todo_id in seen:
            raise FsError(f"duplicate todo id: {todo_id}")
        seen.add(todo_id)
        entry = {"id": todo_id, "content": content, "status": status}
        # Omitted rather than written as "agent": the default needs no storage,
        # and an absent key keeps existing documents byte-identical on rewrite.
        if owner == "user":
            entry["owner"] = owner
        normalized.append(entry)
    return normalized


def _todos_markup(todos: list[dict[str, str]]) -> str:
    """Render todo <li> rows in the template's shape (ids pre-validated)."""
    return "\n        ".join(
        f'<li data-status="{todo["status"]}" data-todo-id="{todo["id"]}">\n'
        f'          <span class="st">{todo["status"]}</span>\n'
        f"          <span>{html_escape(todo['content'])}</span>\n"
        f"        </li>"
        for todo in todos
    )


def _create_plan_sync(
    workspace_path: str,
    name: str,
    overview: str,
    todos: list[str | dict[str, str]],
    stage: str = "draft",
) -> dict[str, Any]:
    name = name.strip()
    if not name:
        raise FsError("plan name must be non-empty")
    stage = (stage or "draft").strip() or "draft"
    if stage not in PLAN_STAGES:
        raise FsError(f"invalid stage: {stage!r} (valid: {', '.join(sorted(PLAN_STAGES))})")
    overview = overview.strip()
    normalized = _normalize_todos(todos, "done" if stage == "done" else "pending")
    root = _plans_root(workspace_path)
    template = root / TEMPLATE_FILENAME
    if not template.is_file():
        # Same idempotent helper the workspace-open funnel uses; it fills in
        # missing bundled assets without touching existing files.
        ensure_plan_assets(workspace_path)
    if not template.is_file():
        raise FsError(
            f"plan template missing: {PLANS_REL_DIR}/{TEMPLATE_FILENAME} (provisioning failed)"
        )
    content = template.read_text(encoding="utf-8")

    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60].rstrip("-") or "plan"
    for _ in range(16):
        filename = f"{slug}_{secrets.token_hex(3)}.html"
        if not (root / filename).exists():
            break
    else:
        raise FsError("could not allocate a unique plan filename")

    # Fill the supplied placeholders and sweep the remaining {{…}} scaffolding
    # (Goals/Risks/etc. prose the caller does not supply) in a single pass, with
    # a function replacement. Sweeping afterwards instead would rewrite a
    # caller's own "{{…}}" to TBD, leaving the visible markup disagreeing with
    # plan-meta; re.sub never rescans what a callback returns. The todo rows go
    # in after the sweep for the same reason.
    replacements = {
        "{{PLAN_NAME}}": html_escape(name),
        "{{ONE_SENTENCE_OVERVIEW}}": html_escape(overview),
        "{{PHASE_A_TITLE}}": "Todos",
    }
    content = _PLACEHOLDER_RE.sub(lambda match: replacements.get(match.group(0), "TBD"), content)
    content = _TEMPLATE_TODO_LI_RE.sub(lambda _m: _todos_markup(normalized), content, count=1)
    # Stages past the approval gate imply the gate was passed, and the visible
    # badge is written from the meta, so both have to be set here rather than
    # left for a follow-up plan_update_stage call.
    approved_at = (
        datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if stage in ("approved", "in-progress", "done")
        else None
    )
    meta = {
        "schemaVersion": 1,
        "name": name,
        "overview": overview,
        "stage": stage,
        "approvedAt": approved_at,
        "todos": normalized,
        "reviewNotes": [],
    }
    content = content.replace('<span class="pill draft">draft</span>',
                              f'<span class="pill {stage}">{stage}</span>')
    content = write_plan_meta(content, meta)
    _save_plan(workspace_path, filename, content)
    return {"rel_path": _plan_rel_path(filename), "name": name, "stage": stage}


def _update_stage_sync(workspace_path: str, rel_path: str, stage: str) -> dict[str, Any]:
    if stage not in PLAN_STAGES:
        raise FsError(f"invalid stage: {stage!r} (valid: {', '.join(sorted(PLAN_STAGES))})")
    html, meta, mtime = _load_plan_for_write(workspace_path, rel_path)
    meta["stage"] = stage
    if stage == "approved":
        meta["approvedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _save_plan(workspace_path, rel_path, write_plan_meta(html, meta), expected_mtime=mtime)
    return {"stage": stage, "approvedAt": meta.get("approvedAt")}


def _update_todo_sync(
    workspace_path: str, rel_path: str, todo_id: str, status: str, owner: str = ""
) -> dict[str, Any]:
    if owner and owner not in TODO_OWNERS:
        raise FsError(f"invalid todo owner: {owner!r} (valid: {', '.join(sorted(TODO_OWNERS))})")
    if status not in TODO_STATUSES:
        raise FsError(f"invalid status: {status!r} (valid: {', '.join(sorted(TODO_STATUSES))})")
    html, meta, mtime = _load_plan_for_write(workspace_path, rel_path)
    todos = meta.get("todos")
    todos = todos if isinstance(todos, list) else []
    target = next(
        (t for t in todos if isinstance(t, dict) and t.get("id") == todo_id), None
    )
    if target is None:
        valid = [t["id"] for t in todos if isinstance(t, dict) and isinstance(t.get("id"), str)]
        raise FsError(f"unknown todo id: {todo_id!r} (valid ids: {', '.join(valid) or 'none'})")
    target["status"] = status
    if owner == "user":
        target["owner"] = owner
    elif owner == "agent":
        # Back to the default, which is stored by being absent.
        target.pop("owner", None)
    _save_plan(workspace_path, rel_path, write_plan_meta(html, meta), expected_mtime=mtime)
    return dict(target)


def _add_note_sync(
    workspace_path: str, rel_path: str, text: str, author: str
) -> dict[str, Any]:
    if author not in ("user", "ai"):
        raise FsError(f"invalid author: {author!r} (valid: user, ai)")
    text = text.strip()
    if not text:
        raise FsError("note text must be non-empty")
    html, meta, mtime = _load_plan_for_write(workspace_path, rel_path)
    notes = meta.get("reviewNotes")
    if not isinstance(notes, list):
        notes = []
        meta["reviewNotes"] = notes
    max_num = 0
    for existing in notes:
        if isinstance(existing, dict):
            match = _NOTE_ID_RE.fullmatch(str(existing.get("id") or ""))
            if match:
                max_num = max(max_num, int(match.group(1)))
    note = {"id": f"n{max_num + 1}", "author": author, "text": text, "resolved": False, "reply": ""}
    notes.append(note)
    _save_plan(workspace_path, rel_path, write_plan_meta(html, meta), expected_mtime=mtime)
    return dict(note)


def _add_todo_refusal(
    meta: dict[str, Any], html: str, content: str, todo_id: str, owner: str, status: str, after: str
) -> str | None:
    """Why ``plan_add_todo`` must refuse these arguments, or None when it may proceed.

    Ids already used by a visible row count as taken too, so the new todo can
    never produce a second row with the same id.
    """
    if owner and owner not in TODO_OWNERS:
        return f"invalid todo owner: {owner!r} (valid: {', '.join(sorted(TODO_OWNERS))})"
    if status not in TODO_STATUSES:
        return f"invalid status: {status!r} (valid: {', '.join(sorted(TODO_STATUSES))})"
    if not content.strip():
        return "todo content must be non-empty"
    todos = meta.get("todos")
    valid = [
        t["id"] for t in (todos if isinstance(todos, list) else [])
        if isinstance(t, dict) and isinstance(t.get("id"), str)
    ]
    if todo_id:
        if _TODO_ID_RE.fullmatch(todo_id) is None:
            return f"invalid todo id {todo_id!r} (use kebab-case: [a-z0-9-])"
        if todo_id in valid or todo_id in _TODO_ROW_RE.findall(html):
            return f"duplicate todo id: {todo_id}"
    if after and after not in valid:
        return f"unknown todo id: {after!r} (valid ids: {', '.join(valid) or 'none'})"
    return None


def _insert_todo_markup(html: str, todo: dict[str, str], after: str) -> str | None:
    """Insert the todo's visible row; None when there is nowhere to put it.

    The row goes after ``after``'s row, or after the last todo row. A document
    whose todo list exists but is empty gets it as that list's first row.
    """
    row = _todos_markup([todo])
    rows = list(_TODO_ROW_RE.finditer(html))
    if after:
        anchor = next((m for m in rows if m.group(1) == after), None)
    else:
        anchor = rows[-1] if rows else None
    if anchor is not None:
        line_start = html.rfind("\n", 0, anchor.start()) + 1
        indent = html[line_start : anchor.start()]
        indent = indent if not indent.strip() else ""
        return f"{html[: anchor.end()]}\n{indent}{row}{html[anchor.end() :]}"
    if after or rows:
        return None
    empty = _EMPTY_TODO_LIST_RE.search(html)
    if empty is None:
        return None
    return f"{html[: empty.end(2)]}{row}\n{html[empty.start(3) :]}"


def _add_todo_sync(
    workspace_path: str,
    rel_path: str,
    content: str,
    todo_id: str = "",
    owner: str = "",
    status: str = "pending",
    after: str = "",
) -> dict[str, Any]:
    todo_id, after = todo_id.strip(), after.strip()
    html, meta, mtime = _load_plan_for_write(workspace_path, rel_path)
    refusal = _add_todo_refusal(meta, html, content, todo_id, owner, status, after)
    if refusal:
        raise FsError(refusal)
    todos = meta.get("todos")
    if not isinstance(todos, list):
        todos = []
        meta["todos"] = todos
    if not todo_id:
        taken = [t.get("id") for t in todos if isinstance(t, dict)] + _TODO_ROW_RE.findall(html)
        numbers = [int(m.group(1)) for m in map(_AUTO_TODO_ID_RE.fullmatch, map(str, taken)) if m]
        todo_id = f"t{max(numbers, default=0) + 1}"
    todo = {"id": todo_id, "content": content.strip(), "status": status}
    # Same storage rule as plan_create: the "agent" default is an absent key.
    if owner == "user":
        todo["owner"] = owner
    index = len(todos)
    if after:
        index = next(i + 1 for i, t in enumerate(todos) if isinstance(t, dict) and t.get("id") == after)
    todos.insert(index, todo)
    inserted = _insert_todo_markup(html, todo, after)
    _save_plan(
        workspace_path, rel_path, write_plan_meta(inserted or html, meta), expected_mtime=mtime
    )
    result: dict[str, Any] = dict(todo)
    if inserted is None:
        result["warning"] = _TODO_MARKUP_WARNING
    return result


# ── MCP tools ───────────────────────────────────────────────────────────────


async def plan_list(ctx: Context, workspace_path: str = "") -> list[dict[str, Any]]:
    """List plan documents in the workspace's .agent-team/plans/ directory.

    Skips only provisioned assets (basename starting with "_"); no plan
    document is ever left out, whatever its size or condition. Each entry has:
    rel_path (workspace-relative, e.g. ".agent-team/plans/foo.html" — pass it
    to plan_read), name, stage, overview, todos ({total, by_status} counts),
    mtime (epoch seconds). A document whose plan-meta is missing, broken or
    unreadable is still listed, with "kind" ("document" or "unreadable") and a
    "reason" saying why (and "size" in bytes). Every entry always carries
    rel_path, name, stage, overview, todos, mtime, so nothing is left out.

    workspace_path defaults to your own pane's workspace; pass it only to read
    another project's plans.
    """
    caller = resolve_caller(ctx)
    workspace_path = await caller_workspace(caller, workspace_path)
    routed = await _host_agent_plan_call(caller, workspace_path, "plans.list", {})
    if routed is not _NO_HOST_ROUTE:
        return routed
    return await asyncio.to_thread(_list_plans_sync, workspace_path)


async def plan_read(rel_path: str, ctx: Context, workspace_path: str = "") -> dict[str, Any]:
    """Read one plan document from the workspace's .agent-team/plans/ directory.

    rel_path is the workspace-relative path returned by plan_list (a bare
    filename is also accepted). Returns {rel_path, meta, html}: the parsed
    plan-meta dict (null if the island is missing/invalid) and the raw file
    content.

    workspace_path defaults to your own pane's workspace; pass it only to read
    another project's plan.
    """
    caller = resolve_caller(ctx)
    workspace_path = await caller_workspace(caller, workspace_path)
    routed = await _read_plan_via_host(caller, workspace_path, rel_path)
    if routed is not _NO_HOST_ROUTE:
        return routed
    return await asyncio.to_thread(_read_plan_sync, workspace_path, rel_path)


async def plan_create(
    name: str,
    overview: str,
    todos: list[str | dict[str, str]],
    ctx: Context,
    workspace_path: str = "",
    stage: str = "draft",
) -> dict[str, Any]:
    """Create a new plan document in the workspace's .agent-team/plans/ directory.

    The file is copied from the provisioned _template.html, named
    <kebab-slug>_<6-hex>.html per the plan spec. The Plans backend fails when
    the template is missing; only the degraded fallback provisions it first.
    Each todos
    item is either a plain string (the todo content; id auto-assigned as t1,
    t2, ...) or a {"id": "<kebab-case>", "content": "...", "owner": "user"}
    object. Set `owner: "user"` on anything only the user can do — a manual
    verification, a decision, a credential only they hold. Those are the items
    nobody comes back to tick off, and without the marker a finished document
    waiting on one verification is indistinguishable from an untouched plan.
    name/overview/todos are written to both the plan-meta island and the
    visible markup.

    `stage` is where the document starts, "draft" by default — a plan you are
    about to have approved. Pass "done" for a document that RECORDS work
    already finished (a report, an audit, an inventory): it is not waiting for
    anyone, and its todos are its sections, so they are created "done" too.
    Using "in-review" for a finished report is the common mistake — that stage
    means "blocked until the user approves it", which a report never is.
    Stages at or past the approval gate ("approved", "in-progress", "done")
    also stamp approvedAt, so no follow-up plan_update_stage call is needed.
    Returns {rel_path, name, stage}, plus "warning" when workspace_path does
    not match any pane's workspace — the plan is on disk but Navide's plan
    view will not find it; re-create it under the warned-about workspace.

    workspace_path defaults to your own pane's workspace, which is where the
    user can open the plan — pass it only to create a plan in another project.
    """
    caller = resolve_caller(ctx)
    workspace_path = await caller_workspace(caller, workspace_path)
    routed = await _host_agent_plan_call(
        caller,
        workspace_path,
        "plans.create",
        {"name": name, "overview": overview, "todos": todos, "stage": stage},
    )
    if routed is not _NO_HOST_ROUTE:
        return routed
    result = await asyncio.to_thread(
        _create_plan_sync, workspace_path, name, overview, todos, stage
    )
    warning = await asyncio.to_thread(workspace_mismatch_warning, workspace_path)
    if warning:
        result["warning"] = warning
    return result


async def plan_update_stage(
    rel_path: str, stage: str, ctx: Context, workspace_path: str = ""
) -> dict[str, Any]:
    """Set a plan's lifecycle stage (island + visible stage pill).

    stage must be one of: draft, in-review, approved, in-progress, done,
    abandoned. Setting "approved" also stamps approvedAt with the current UTC
    time (ISO-8601, Z suffix). Fails with a conflict error if the file changed
    on disk during the update. Returns {stage, approvedAt}.

    workspace_path defaults to your own pane's workspace; pass it only to
    update another project's plan.
    """
    caller = resolve_caller(ctx)
    workspace_path = await caller_workspace(caller, workspace_path)
    routed = await _host_agent_plan_call(
        caller,
        workspace_path,
        "plans.update_stage",
        {"rel_path": rel_path, "stage": stage},
    )
    if routed is not _NO_HOST_ROUTE:
        return routed
    return await asyncio.to_thread(_update_stage_sync, workspace_path, rel_path, stage)


async def plan_update_todo(
    rel_path: str,
    todo_id: str,
    status: str,
    ctx: Context,
    workspace_path: str = "",
    owner: str = "",
) -> dict[str, Any]:
    """Set one todo's status (island + the todo's visible row markup).

    status must be one of: pending, in-progress, done, skipped. An unknown
    todo_id fails with an error listing the plan's valid todo ids. Returns the
    updated todo object.

    `owner` reassigns who the todo is waiting on: "user" for something only
    they can do (a manual verification, a decision, a credential only they
    hold), "agent" to put it back to the default. Omit it to leave the owner
    alone. This is what keeps a finished write-up from looking like an
    untouched plan — plan_list counts unfinished user-owned todos as
    `todos.awaiting_user`, so "which documents are waiting on me" becomes a
    question that can be answered without opening every one of them.

    workspace_path defaults to your own pane's workspace; pass it only to
    update another project's plan.
    """
    caller = resolve_caller(ctx)
    workspace_path = await caller_workspace(caller, workspace_path)
    routed = await _host_agent_plan_call(
        caller,
        workspace_path,
        "plans.update_todo",
        {"rel_path": rel_path, "todo_id": todo_id, "status": status, "owner": owner},
    )
    if routed is not _NO_HOST_ROUTE:
        return routed
    return await asyncio.to_thread(
        _update_todo_sync, workspace_path, rel_path, todo_id, status, owner
    )


async def plan_add_note(
    rel_path: str, text: str, ctx: Context, author: str = "ai", workspace_path: str = ""
) -> dict[str, Any]:
    """Append a review note to a plan's plan-meta island.

    author is "ai" (default) or "user". The note gets the next sequential id
    (n1, n2, ...), resolved=false and an empty reply. Per the plan spec's
    update discipline, app-side note writes touch only the plan-meta island —
    visible note markup may lag and is re-synced by the authoring agent on its
    next edit. Returns the created note.

    workspace_path defaults to your own pane's workspace; pass it only to
    annotate another project's plan.
    """
    caller = resolve_caller(ctx)
    workspace_path = await caller_workspace(caller, workspace_path)
    routed = await _host_agent_plan_call(
        caller,
        workspace_path,
        "plans.add_note",
        {"rel_path": rel_path, "text": text, "author": author},
    )
    if routed is not _NO_HOST_ROUTE:
        return routed
    return await asyncio.to_thread(_add_note_sync, workspace_path, rel_path, text, author)


async def plan_add_todo(
    rel_path: str,
    content: str,
    ctx: Context,
    id: str = "",  # noqa: A002 — the parameter name agents see
    owner: str = "",
    status: str = "pending",
    after: str = "",
    workspace_path: str = "",
) -> dict[str, Any]:
    """Add a todo to an existing plan (island + a new visible todo row).

    Use it when a plan needs a step it does not have yet — a follow-up found
    during the work, a proposal the user accepted — so the step is tracked
    like the others instead of living only in a review note.

    `id` is optional kebab-case; omit it to get the next free tN. A duplicate
    or malformed id is refused, and existing ids are never renumbered.
    `owner` is "user" for something only the user can do, "agent" (or
    omitted) for the default. `status` is one of: pending (default),
    in-progress, done, skipped. `after` is the id of the todo to insert after;
    omit it to append at the end. An unknown `after` fails with an error
    listing the plan's valid todo ids. Fails with a conflict error if the file
    changed on disk during the update.

    Returns the created todo object, plus "warning" when the document has no
    todo list to put the visible row in: the todo is then in plan-meta only.

    workspace_path defaults to your own pane's workspace; pass it only to
    update another project's plan.
    """
    caller = resolve_caller(ctx)
    workspace_path = await caller_workspace(caller, workspace_path)
    try:
        routed = await _host_agent_plan_call(
            caller,
            workspace_path,
            "plans.add_todo",
            {
                "rel_path": rel_path,
                "content": content,
                "id": id,
                "owner": owner,
                "status": status,
                "after": after,
            },
        )
    except FsError as error:
        # The Host relays only an error code. Name the reason (and the valid
        # ids) from the plan itself, as the local path does.
        if error.code != "INVALID_ARGUMENT":
            raise
        document = await _read_plan_via_host(caller, workspace_path, rel_path)
        meta = document.get("meta") if isinstance(document, dict) else None
        refusal = isinstance(meta, dict) and _add_todo_refusal(
            meta, str(document.get("html", "")), content, id.strip(), owner, status, after.strip()
        )
        if refusal:
            raise FsError(refusal, code=error.code) from None
        raise
    if routed is not _NO_HOST_ROUTE:
        return routed
    return await asyncio.to_thread(
        _add_todo_sync, workspace_path, rel_path, content, id, owner, status, after
    )



# ── installation onto the core MCP server ───────────────────────────────────

#: Registered in this order; the order is what an agent sees in tools/list.
PLAN_TOOLS = (
    plan_list,
    plan_read,
    plan_create,
    plan_update_stage,
    plan_update_todo,
    plan_add_note,
    plan_add_todo,
)


def install(server: Any) -> None:
    """Add the plan tools to the core MCP server.

    Called by the plugin host after every plugin is activated and before the
    server's session manager is built (see PluginContext.register_mcp_tools) —
    a tool added after that point is missing from the list clients see, with no
    error anywhere.
    """
    from agent_team_backend.mcp_server.server import hide_tools_while_plugin_disabled

    for tool in PLAN_TOOLS:
        server.tool()(tool)
    hide_tools_while_plugin_disabled("navide.plans", [tool.__name__ for tool in PLAN_TOOLS])
