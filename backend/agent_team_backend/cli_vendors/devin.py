"""Devin CLI (``devin``, Cognition) — Cognition's terminal coding agent.

Read from the official docs on 2026-11-07, not yet run against a real install
(no ``devin`` binary on the machine this was written on):

* **Launch.** A bare ``devin`` in a project directory opens the interactive
  TUI (https://docs.devin.ai/cli). ``devin -- <prompt>`` preloads a prompt,
  but a pane's role text is typed into the composer like every other
  vendor's, so the kickoff verdict cli_open_agent reports is the same one.
* **Permissions.** ``--permission-mode <MODE>`` (``DEVIN_PERMISSION_MODE``)
  takes ``normal`` (default), ``accept-edits``, ``smart``, ``dangerous``
  (aliases ``yolo``, ``bypass``) and ``autonomous`` (needs ``--sandbox``);
  admin deny/ask rules still apply in Bypass
  (docs.devin.ai/cli/reference/commands, /cli/essential-commands). The
  frontend spec appends ``--permission-mode dangerous`` as the YOLO flag.
* **Version.** ``devin --version`` (same as ``devin version``) prints the
  version and exits; the output shape is undocumented. Releases are numbered
  ``v3000.12.17`` (docs.devin.ai/cli/changelog/stable), which the generic
  three-part regex reads as ``3000.12.17``.
* **Cloud.** ``/handoff [task]`` moves the local session (repo, branch,
  conversation, uncommitted changes) to a cloud Devin session on Cognition's
  VM (docs.devin.ai/cli/handoff). It is Devin's own command, run inside the
  TUI with the user's Devin account; Navide adds nothing to it.
* **Windows.** Official: an x86_64/ARM64 installer or
  ``irm https://static.devin.ai/cli/setup.ps1 | iex`` in PowerShell, then
  PowerShell, Windows Terminal or Git Bash (docs.devin.ai/cli). Offered on
  every platform.
* **Sign-in and keys.** ``devin auth login`` / ``/login`` belong to the CLI;
  where it stores the credential is undocumented. Navide reads none of it: no
  credential fields, no ``login_command_args``, no account switching, no usage
  fetcher.
* **Install.** Both official installers pipe a downloaded script into a
  shell, so the install entry carries no command — the guided install shows
  the docs link and the user runs it themselves (``brew install --cask
  devin-cli`` is the other documented route). ``devin update`` and
  ``devin doctor`` are the CLI's own update and diagnostic commands.
* **Not wired.** Session resume (``-c`` / ``-r <id>`` exist, but no reader can
  name the id of a session Navide started; the session store's location is
  undocumented), model flag (``--model`` is documented but could not be
  checked against an invalid value without an install), MCP, skills,
  extensions inventory.
* **Data root.** The documented user directory is ``~/.config/devin``
  (``config.json``, ``mcp_config.json``, ``AGENTS.md``), ``%APPDATA%\\devin``
  on Windows (docs/cli/reference/configuration/config-file). Where sessions
  and credentials live is undocumented, and no variable is documented to
  relocate the directory, so that one root is all the spec declares.
"""

from __future__ import annotations

from pathlib import Path

from ._declared import declared
from .base import Dep, ExtensionsSpec, VendorRuntimeContext, VendorSpec
from .base import PROJECT_SCOPE, USER_SCOPE, MemorySource
from ..osplat import platform_id as _platform_id


def _config_dir(ctx: VendorRuntimeContext, platform: str | None = None) -> Path:
    """%APPDATA%\\devin on Windows, else ~/.config/devin."""
    if (platform or _platform_id) == "win32":
        appdata = ctx.env.get("APPDATA")
        return ctx.path(appdata) / "devin" if appdata else ctx.home / "AppData" / "Roaming" / "devin"
    return ctx.home / ".config" / "devin"


# Instruction files: every standard file is an always-on rule, user and project
# loaded together; ~/.config/devin/AGENTS.md is %APPDATA%\devin on Windows
# (docs.devin.ai/cli/extensibility/rules, read 2026-11-07 -- docs only).
_MEMORY_SOURCES = (
    MemorySource("devin", USER_SCOPE, (".config", "devin", "AGENTS.md"), canonical=True),
    MemorySource("devin", USER_SCOPE, (".devin", "global_rules.md")),
    MemorySource("devin", USER_SCOPE, (".devin", "rules"), glob="*.md"),
    MemorySource("devin", PROJECT_SCOPE, ("AGENTS.md",), canonical=True),
    MemorySource("devin", PROJECT_SCOPE, ("AGENTS.local.md",)),
    MemorySource("devin", PROJECT_SCOPE, ("AGENT.md",)),
    MemorySource("devin", PROJECT_SCOPE, ("CLAUDE.md",)),
    MemorySource("devin", PROJECT_SCOPE, (".devin", "global_rules.md")),
    MemorySource("devin", PROJECT_SCOPE, (".devin", "rules"), glob="*.md"),
)

SPEC = VendorSpec(
    memory_sources=_MEMORY_SOURCES,
    cli_unverified_reason="wired from the docs (read 2026-11-07); no binary installed, so no version was checked",
    key="devin",
    extensions=ExtensionsSpec(
        supported=False,
        note="Devin plugins, skills and hooks (devin plugins / skills paths) are not inventoried yet",
    ),
    data_dirs=lambda ctx: (_config_dir(ctx),),
    data_dir_env_vars=("APPDATA",),
    # No reader can name a session Navide started (see the docstring), so the
    # launch declaration has no resume.
    **declared("devin"),
    install_dep=Dep("devin", "Devin CLI (Cognition)", "Cognition terminal coding agent", "agent_cli",
        ["devin", "--version"], r"(\d+\.\d+\.\d+)",
        # The official installers are `curl | bash` and `irm … | iex`;
        # Navide does not run them.
        optional=True,
        docs_url="https://docs.devin.ai/cli",
        update_cmd="devin update",
        doctor_cmd="devin doctor"),
)
