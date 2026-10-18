"""Capability API: the controlled façade a plugin uses to reach core services.

A capability is how the host grants a plugin *scoped* access to a core service.
Each capability class wraps one core service (``fs_service``, ``git_service``,
the terminal service) and exposes a small, deliberate surface -- never the raw
module. The host builds only the capabilities a plugin declares in
``manifest.requires`` (see :func:`build_capabilities`) and injects them into
``PluginContext.capabilities``; a plugin that did not declare ``"git"`` simply
has no git capability to reach for.

Interface-shell status
----------------------
This is the Phase 1 skeleton. Each capability exposes only a few representative
methods -- enough to prove the "authorize + delegate to service" path works end
to end, not the full contract. Method **signatures are provisional**: Phase 2
(the real WS-handler migration) will settle them and route more calls through
here. Every method below is marked accordingly.

Delegation uses a function-level ``from .. import app`` so importing this module
stays cheap and free of import cycles; the core service singletons live on
``app`` (``app.fs_service``, ``app.git_service``, ``app.get_terminals()``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    # Imported inside _validate_workspace_cwd at runtime (kept lazy there);
    # named here only so its return annotation resolves for linters.
    from pathlib import Path


class CapabilityError(Exception):
    """Raised when a capability cannot be built or used."""


class CapabilityNotAvailable(CapabilityError):
    """Raised when a capability method has no backend implementation yet."""


class FsCapability:
    """Scoped filesystem access, delegating to ``app.fs_service``.

    Interface shell: exposes a representative read/write/list subset; Phase 2
    settles signatures and adds the rest.
    """

    def read_file(
        self,
        workspace_path: str,
        rel_path: str,
        encoding_override: str | None = None,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.read_file(workspace_path, rel_path, encoding_override)

    def write_file(
        self,
        workspace_path: str,
        rel_path: str,
        content: str,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.write_file(workspace_path, rel_path, content)

    def list_dir(
        self,
        workspace_path: str,
        rel_path: str = "",
        show_hidden: bool = False,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.list_dir(workspace_path, rel_path, show_hidden)

    def list_files_flat(
        self,
        workspace_path: str,
        query: str = "",
        max_results: int = 200,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.list_files_flat(
            workspace_path, query=query, max_results=max_results
        )

    def glob_files(self, workspace_path: str, pattern: str) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.glob_files(workspace_path, pattern=pattern)

    def create_file(
        self,
        workspace_path: str,
        rel_path: str,
        content: str = "",
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.create_file(workspace_path, rel_path, content)

    def delete(self, workspace_path: str, rel_path: str) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.delete(workspace_path, rel_path)

    def mkdir(self, workspace_path: str, rel_path: str) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.mkdir(workspace_path, rel_path)

    def rename(
        self,
        workspace_path: str,
        src_path: str,
        dst_path: str,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.rename(workspace_path, src_path, dst_path)

    def convert_office(self, workspace_path: str, rel_path: str) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.convert_office(workspace_path, rel_path)

    def list_archive(self, workspace_path: str, rel_path: str) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.list_archive(workspace_path, rel_path)


class GitCapability:
    """Scoped git access, delegating to ``app.git_service``.

    Interface shell: exposes status/log; Phase 2 settles signatures and adds
    the rest. The underlying service functions are async, so these façade
    methods return the awaitable the caller then awaits.
    """

    def status(self, workspace_path: str, include_ignored: bool = False) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.get_status(workspace_path, include_ignored)

    def log(self, workspace_path: str, **kwargs: Any) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.get_log(workspace_path, **kwargs)

    def commit(self, workspace_path: str, message: str, commit_all: bool = False) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.commit(workspace_path, message, commit_all)

    def diff_all(self, workspace_path: str, staged: bool = False) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.diff_all(workspace_path, staged=staged)

    def diff_file(self, workspace_path: str, filepath: str, staged: bool = False) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.diff_file(workspace_path, filepath, staged=staged)

    def diff_branches(self, workspace_path: str, base: str, compare: str) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.diff_branches(workspace_path, base, compare)

    def show_commit(self, workspace_path: str, commit_hash: str) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.show_commit(workspace_path, commit_hash)

    def stash_list(self, workspace_path: str) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.stash_list(workspace_path)

    def apply_patch(
        self,
        workspace_path: str,
        patch: str,
        reverse: bool = False,
        cached: bool = False,
    ) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.apply_patch(
            workspace_path, patch, reverse=reverse, cached=cached
        )


# terminal.run subprocess guard rails: hard wall-clock timeout and output cap
# (mirrors the shell.run WS handler's 30s / 8000-char limits).
_RUN_TIMEOUT_SECONDS = 30
_RUN_OUTPUT_LIMIT = 8000


def _validate_workspace_cwd(ws_path: str | None) -> "Path | None":
    """Resolve and validate a ``terminal.run`` cwd against known workspaces.

    A cwd is required: ``None``/empty used to pass through and run the
    command in the backend's own cwd, past this check (d1). The resolved
    path must be a registered workspace root (per
    ``app.attribution.existing_workspace_roots()``) or a subdirectory of one,
    and an existing directory. Mirrors the shell.run WS handler's validation;
    TODO(Phase 2): share one code path via an extracted ShellService.
    """
    if not ws_path:
        raise CapabilityError("workspace path is required")
    from pathlib import Path

    from .. import app

    resolved = Path(ws_path).resolve()
    known_roots = app.attribution.existing_workspace_roots()
    if not any(
        resolved == root or resolved.is_relative_to(root) for root in known_roots
    ):
        raise CapabilityError("workspace path not registered")
    if not resolved.is_dir():
        raise CapabilityError("invalid workspace path")
    return resolved


class TerminalCapability:
    """Scoped terminal access, delegating to the app terminal service.

    Interface shell: terminal creation is tightly coupled to a PTY and the
    running event loop (``TerminalService.create`` needs a pane id, cwd, PTY
    wiring), so this façade exposes only a query-type method -- ``list`` of live
    session ids (via the service's public ``list_session_ids``) -- to prove the
    delegation path. Phase 2 should add a properly scoped ``create`` façade.
    """

    def list(self) -> list[str]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.get_terminals().list_session_ids()

    async def run(self, command: str, cwd: str | None = None) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        #
        # The ``shell.run`` WS handler has no backing service: it inlines
        # ``asyncio.create_subprocess_exec(*osplat.paths.shell_command(cmd))`` after
        # validating that ``cwd`` is a registered workspace. This façade wraps
        # the same restricted subprocess call with the same cwd validation and
        # timeout. TODO(Phase 2): extract a proper ShellService and route both
        # the shell.run WS handler and this façade through it.
        import asyncio

        from .. import osplat

        resolved_cwd = _validate_workspace_cwd(cwd)
        proc = await asyncio.create_subprocess_exec(
            *osplat.paths.shell_command(command),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(resolved_cwd) if resolved_cwd else None,
        )
        try:
            stdout, _ = await asyncio.wait_for(
                proc.communicate(), timeout=_RUN_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError as err:
            proc.kill()
            await proc.wait()  # reap; leaves no zombie/transport behind
            raise CapabilityError(
                f"terminal.run timed out after {_RUN_TIMEOUT_SECONDS}s"
            ) from err
        return {
            "ok": True,
            "output": stdout.decode("utf-8", errors="replace")[:_RUN_OUTPUT_LIMIT],
            "exit_code": proc.returncode,
        }


class SearchCapability:
    """Scoped workspace search, delegating to ``app.search_service``.

    Interface shell: exposes find/replace-in-files; Phase 2 settles signatures.
    Both underlying service functions are synchronous (they run in a worker
    thread in the WS handler), so these façade methods return their results
    directly.
    """

    def find_in_files(
        self,
        workspace_path: str,
        query: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.search_service.find_in_files(workspace_path, query, **kwargs)

    def replace_in_files(
        self,
        workspace_path: str,
        query: str,
        replacement: str,
        files: list[str],
        **kwargs: Any,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.search_service.replace_in_files(
            workspace_path, query, replacement, files, **kwargs
        )


class ChatCapability:
    """Scoped AI settings / editor-AI access, delegating to core services.

    Interface shell: delegates to a single core singleton per call
    (``ai_chat_settings_store``, ``editor_service``). The AI chat feature
    itself was removed; what remains is the shared AI settings store (used by
    review and git.generate_message) and the Monaco inline-AI editor calls.
    Signatures are provisional throughout.
    """

    # -- delegating: backed by a single core singleton --------------------

    def settings_get(self) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.ai_chat_settings_store.get()

    def settings_set(self, settings: dict[str, Any]) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.ai_chat_settings_store.set(settings)

    def editor_complete(
        self,
        base_url: str,
        model: str,
        prefix: str,
        suffix: str = "",
        language: str = "",
    ) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.editor_service.complete(base_url, model, prefix, suffix, language)

    def editor_rewrite(
        self,
        base_url: str,
        model: str,
        code: str,
        instruction: str,
        language: str = "",
    ) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.editor_service.rewrite(base_url, model, code, instruction, language)


class IssuesCapability:
    """Scoped cloud-issues access, delegating to ``app.issue_service``.

    Interface shell mirroring :class:`GitCapability`: drives the gh/glab cloud
    issue surface GitPane's ``useIssues`` uses. The underlying service functions
    are async, so these façade methods return the awaitable the caller awaits.
    Signatures are provisional -- Phase 2 settles them alongside the WS handlers.
    """

    def provider(self, workspace_path: str) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.issue_service.detect_provider(workspace_path)

    def list(self, workspace_path: str, limit: int = 30) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.issue_service.list_issues(workspace_path, limit)

    def get(self, workspace_path: str, number: int) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.issue_service.get_issue(workspace_path, number)

    def create(self, workspace_path: str, title: str, body: str = "") -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.issue_service.create_issue(workspace_path, title, body)

    def comment(self, workspace_path: str, number: int, body: str) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.issue_service.comment_issue(workspace_path, number, body)

    def set_state(self, workspace_path: str, number: int, state: str) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.issue_service.set_issue_state(workspace_path, number, state)


class UiCapability:
    """Host-side UI capability -- registered for authorization only.

    Every method here is served by the Electron host (main-process broker),
    not the Python backend: ``get_cli_pane_buffer`` reads a renderer terminal
    buffer, ``open_external`` shells out to the OS, and the JSON/file dialogs
    are native. The backend has no counterpart, so this class exists purely so
    that ``manifest.requires`` may legally declare ``"ui"`` and be validated
    against KNOWN_CAPABILITIES. Calling any method backend-side is a
    programming error and raises.
    """

    def _host_side(self, name: str) -> "CapabilityNotAvailable":
        return CapabilityNotAvailable(
            f"capability not available: ui.{name} is host-side, brokered in "
            "the Electron main process; the backend has no implementation"
        )

    def get_cli_pane_buffer(self, *args: Any, **kwargs: Any) -> Any:
        raise self._host_side("get_cli_pane_buffer")

    def open_external(self, *args: Any, **kwargs: Any) -> Any:
        raise self._host_side("open_external")

    def open_json(self, *args: Any, **kwargs: Any) -> Any:
        raise self._host_side("open_json")

    def save_json(self, *args: Any, **kwargs: Any) -> Any:
        raise self._host_side("save_json")

    def get_path_for_file(self, *args: Any, **kwargs: Any) -> Any:
        raise self._host_side("get_path_for_file")


class PlansCapability:
    """Marker capability for the plans namespace.

    The builtin ``navide.plans`` plugin *provides* the plan feature rather
    than consuming a core service, so this capability carries no methods yet;
    it exists so ``requires: ["plans"]`` validates and is granted.
    """


# Maps a capability namespace (as declared in ``manifest.requires``) to its
# capability class. Manifest validation already restricts ``requires`` to
# KNOWN_CAPABILITIES, so this stays in lock-step with that set.
_CAPABILITY_CLASSES: dict[str, type] = {
    "fs": FsCapability,
    "git": GitCapability,
    "terminal": TerminalCapability,
    "search": SearchCapability,
    "chat": ChatCapability,
    "ui": UiCapability,
    "issues": IssuesCapability,
    "plans": PlansCapability,
}


def build_capabilities(requires: list[str]) -> dict[str, Any]:
    """Build the capability objects a plugin is authorized to use.

    Returns ``{name: capability}`` containing only the namespaces listed in
    ``requires`` -- authorization is exactly "what you declared, and nothing
    more". A namespace not in ``requires`` yields no entry, so the plugin has
    no object to reach for.

    ``requires`` is expected to be pre-validated by the manifest layer; an
    unknown name here is defensive-only and raises :class:`CapabilityError`.
    """
    capabilities: dict[str, Any] = {}
    for name in requires:
        cls = _CAPABILITY_CLASSES.get(name)
        if cls is None:
            raise CapabilityError(f"unknown capability {name!r}")
        capabilities[name] = cls()
    return capabilities
