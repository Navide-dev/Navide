"""Hermes Agent (``hermes``, Nous Research) — a general AI agent, offered in
the ＋ menu's CLI list like any other vendor.

Read from the official docs on 2026-11-07, not yet run against a real install
(no ``hermes`` binary on the machine this was written on):

* **Launch.** A bare ``hermes`` opens the interactive TUI
  (https://github.com/NousResearch/hermes-agent). ``--yolo`` is a top-level
  flag that skips the dangerous-command approval prompt
  (hermes-agent.nousresearch.com/docs/reference/cli-commands); the frontend
  spec appends it as the YOLO flag.
* **Kickoff.** ``hermes chat -q <text>`` can seed a session, but a pane's role
  text is typed into the composer like every other vendor's, so the kickoff
  verdict cli_open_agent reports is the same one.
* **Windows.** Native PowerShell is an official install path
  (``iex (irm https://hermes-agent.nousresearch.com/install.ps1)``, data under
  ``%LOCALAPPDATA%\\hermes``; docs/getting-started/installation), so the
  vendor is offered on every platform.
* **Keys.** Providers and keys live in Hermes's own home (``~/.hermes/.env``,
  ``config.yaml``; ``$HERMES_HOME`` relocates it). Navide reads none of it: no
  credential fields, no account switching, no usage fetcher.
* **Install.** Both official installers pipe a downloaded script into a shell,
  so the install entry carries no command — the guided install shows the docs
  link and the user runs it themselves.
* **Not wired.** Session resume (``--resume <id>`` exists, but no reader can
  name the id of a session Navide started), model flag (``-m`` belongs to
  ``hermes chat``, not the bare command), MCP, skills, extensions inventory.
"""

from __future__ import annotations

from pathlib import Path

from .base import Dep, ExtensionsSpec, VendorRuntimeContext, VendorSpec
from ..osplat import platform_id as _platform_id


def _home(ctx: VendorRuntimeContext, platform: str | None = None) -> Path:
    """$HERMES_HOME, else %LOCALAPPDATA%\\hermes on Windows, else ~/.hermes."""
    override = ctx.env.get("HERMES_HOME")
    if override:
        return ctx.path(override)
    if (platform or _platform_id) == "win32":
        local = ctx.env.get("LOCALAPPDATA")
        return ctx.path(local) / "hermes" if local else ctx.home / "AppData" / "Local" / "hermes"
    return ctx.home / ".hermes"


SPEC = VendorSpec(
    key="hermes",
    label="Hermes Agent",
    extensions=ExtensionsSpec(
        supported=False,
        note="Hermes skills and plugins (~/.hermes) are not inventoried yet",
    ),
    # Nous Portal, OpenRouter, OpenAI or a custom endpoint; no fixed host.
    expected_hosts=(),
    data_dirs=lambda ctx: (_home(ctx),),
    data_dir_env_vars=("HERMES_HOME", "LOCALAPPDATA"),
    supports_session_resume=False,
    install_dep=Dep("hermes", "Hermes Agent", "Nous Research general AI agent", "agent_cli",
        ["hermes", "--version"], r"(\d+\.\d+\.\d+)",
        # The official installers are `curl | bash` and `iex (irm …)`;
        # Navide does not run them.
        optional=True,
        docs_url="https://hermes-agent.nousresearch.com/docs/getting-started/installation",
        update_cmd="hermes update",
        doctor_cmd="hermes doctor"),
)
