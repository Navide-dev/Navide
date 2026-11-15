"""Kiro CLI (``kiro-cli``, AWS) — the successor of Amazon Q Developer CLI.

Read from the official docs on 2026-11-12 (kiro.dev/docs/cli, /docs/hooks,
/docs/hooks/types, /docs/mcp/configuration, /docs/reference/settings,
/docs/reference/cli-commands), not yet run against a real install (no
``kiro-cli`` binary on the machine this was written on). The minimum
integration: launch, install detection, the navide MCP server and a turn-end
hook.

* **Launch.** ``kiro-cli chat`` opens the interactive chat; ``--v3`` pins the
  V3 agent harness, the one the hooks below are written for (a headless run
  without a saved harness falls back to V2, so the flag is spelled out). ``kiro``
  on its own opens the IDE, not the CLI.
* **Permissions.** ``--trust-all-tools`` trusts every tool (it also approves
  hook confirmations); interactive V3 shows a confirmation warning first.
* **MCP.** No flag or variable carries a config document, but ``KIRO_HOME``
  relocates the whole global directory (settings, sign-ins, sessions, agents),
  so each pane gets its own ``KIRO_HOME`` (mcp_server/pane_home.py, like
  kimi's): everything is linked to the user's ``~/.kiro`` except
  ``settings/mcp.json`` (a ``mcpServers`` map; a remote server is a bare
  ``url``) and ``hooks/navide.json``.
* **Turn end.** A V3 ``Stop`` hook in the pane's ``hooks/`` posts to
  ``/hooks/kiro`` (kiro_hooks.py). There is no log reader, so the hook names its
  pane by the spawn token (``hook_pane_token``); without the hook the pane
  falls back to PTY quiet time like any reader-less vendor.
* **Sign-in.** ``kiro-cli login`` (GitHub, Google, AWS Builder ID, IAM
  Identity Center); where the credential is stored is undocumented. Navide
  holds none of it: no credential fields, no account switching, no usage.
* **Install.** The official installer is ``curl -fsSL https://cli.kiro.dev/install
  | bash`` (also a Homebrew cask, .deb, AppImage), so the entry carries no
  command and links the docs. ``kiro-cli update`` updates; the diagnostic
  command is ``kiro-cli diagnostic`` (there is no ``doctor``).
* **Not wired.** Session resume (``--resume-id <ID>`` exists, but nothing can
  name the id of a session Navide started: sessions sit in an undocumented
  SQLite file under the home), model and effort flags (documented, not checked
  against an invalid value), Guard, usage, extensions inventory.
"""

from __future__ import annotations

from ._declared import declared
from .base import PROJECT_SCOPE, USER_SCOPE, MemorySource
from .base import (
    Dep,
    ExtensionsSpec,
    McpServerConfig,
    McpValue,
    McpWiring,
    VendorRuntimeContext,
    VendorSpec,
)


def _home(ctx: VendorRuntimeContext):
    """``KIRO_HOME`` (an absolute path) or ``~/.kiro``."""
    return ctx.path(ctx.env.get("KIRO_HOME") or ctx.home / ".kiro")


def _install_hooks(port_file: str):
    # Lazy: a vendor module may not import app modules at load time.
    from ..kiro_hooks import install_hooks

    return install_hooks(port_file)


# Instruction files: steering files, global under the home and per workspace,
# plus AGENTS.md at the workspace root (kiro.dev/docs/steering, read
# 2026-11-12 -- docs only, no binary installed).
_MEMORY_SOURCES = (
    MemorySource("kiro", USER_SCOPE, (".kiro", "steering"), glob="*.md"),
    MemorySource("kiro", PROJECT_SCOPE, ("AGENTS.md",), canonical=True),
    MemorySource("kiro", PROJECT_SCOPE, (".kiro", "steering"), glob="*.md"),
)

SPEC = VendorSpec(
    memory_sources=_MEMORY_SOURCES,
    cli_unverified_reason="wired from the docs (read 2026-11-12); no binary installed, so no version was checked",
    key="kiro",
    extensions=ExtensionsSpec(
        supported=False,
        note="Kiro hooks, custom agents, powers and skills (~/.kiro) are not inventoried yet",
    ),
    data_dirs=lambda ctx: (_home(ctx),),
    data_dir_env_vars=("KIRO_HOME",),
    # No resume by id, and the home variable a spawn strips: the launch declaration.
    **declared("kiro"),
    mcp_wiring=McpWiring(
        config=McpServerConfig(
            section=("mcpServers",),
            entry=(("url", McpValue.URL),),
        ),
        config_dir=".kiro",
        config_dir_env="KIRO_HOME",
        config_file=("settings", "mcp.json"),
    ),
    install_hooks=_install_hooks,
    hook_pane_token=True,
    install_dep=Dep("kiro", "Kiro CLI (AWS)", "AWS Kiro terminal coding agent", "agent_cli",
        ["kiro-cli", "--version"], r"(\d+\.\d+\.\d+)",
        # The official installer is `curl | bash`; Navide does not run it.
        optional=True,
        docs_url="https://kiro.dev/docs/cli/",
        update_cmd="kiro-cli update",
        doctor_cmd="kiro-cli diagnostic"),
)
