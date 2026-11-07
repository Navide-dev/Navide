"""OpenClaw (``openclaw``) — a general personal AI assistant, offered in the
＋ menu's "Standalone agents" block rather than among the coding CLIs.

Read from the official docs on 2026-11-07, not yet run against a real install
(no ``openclaw`` binary on the machine this was written on):

* **Launch.** A bare ``openclaw`` opens its terminal UI and picks the mode
  itself: it attaches to a running Gateway (the long-lived background process
  that owns schedules, memory and chat channels) or, without one, runs the
  agent locally (``openclaw tui`` / ``openclaw tui --local`` /
  ``openclaw chat`` are the explicit forms, https://docs.openclaw.ai/web/tui).
  Navide never starts the Gateway — ``openclaw gateway install/start`` is the
  user's decision, and a pane must not leave a service running behind it.
* **Kickoff.** ``--message <text>`` exists on the TUI, but a pane's role text
  is typed into the composer like every other vendor's, so the kickoff
  verdict cli_open_agent reports is the same one; ``--message`` is documented
  as not resent when the selected history is unavailable.
* **Keys.** Model providers and keys live in OpenClaw's own config
  (``~/.openclaw/openclaw.json``). Navide reads none of it: no credential
  fields, no account switching, no usage fetcher.
* **Install.** The official installer is a ``curl | bash`` script, so the
  install entry carries no command — the guided install shows the docs link
  and the user runs it themselves.
* **Not wired.** Session resume (no reader: sessions are keyed
  ``agent:<id>:<key>`` inside the Gateway, path undocumented), model/effort
  flags, permission bypass, MCP (``openclaw mcp set`` configures the Gateway,
  not a pane), skills, extensions inventory.
"""

from __future__ import annotations

from .base import Dep, ExtensionsSpec, VendorSpec

SPEC = VendorSpec(
    key="openclaw",
    label="OpenClaw",
    category="standalone",
    extensions=ExtensionsSpec(
        supported=False,
        note="OpenClaw plugins and skills (~/.openclaw) are not inventoried yet",
    ),
    # Any provider the user configures; no fixed host to declare.
    expected_hosts=(),
    # OPENCLAW_STATE_DIR moves the state dir (config, credentials, sessions;
    # docs.openclaw.ai/concepts/agent-workspace), else ~/.openclaw.
    data_dirs=lambda ctx: (ctx.path(ctx.env.get("OPENCLAW_STATE_DIR") or ctx.home / ".openclaw"),),
    data_dir_env_vars=("OPENCLAW_STATE_DIR",),
    # No reader can name a session Navide started (see the docstring).
    supports_session_resume=False,
    install_dep=Dep("openclaw", "OpenClaw", "OpenClaw personal AI assistant", "agent_cli",
        ["openclaw", "--version"], r"(\d+\.\d+\.\d+)",
        # The official installer is `curl | bash`; Navide does not run it.
        optional=True, docs_url="https://docs.openclaw.ai/install"),
)
