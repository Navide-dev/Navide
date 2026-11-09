"""openclaw (OpenClaw) vendor spec.

OpenClaw is a general agent: it owns its runtime (the optional Gateway)
and its model keys. These lock down what Navide deliberately leaves to it.
"""

from __future__ import annotations

from agent_team_backend.cli_vendors import registry

SPEC = registry.VENDORS["openclaw"]


def test_identity() -> None:
    assert SPEC.key == "openclaw"
    assert SPEC.label == "OpenClaw"


def test_install_entry_runs_no_installer() -> None:
    """The official installer is `curl | bash`; Navide only links the docs."""
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.group == "agent_cli"
    assert dep.check_cmd == ["openclaw", "--version"]
    assert dep.install_cmd == ""
    assert dep.install_cmds == {}
    assert dep.docs_url == "https://docs.openclaw.ai/install"


def test_navide_holds_no_key_and_starts_no_service() -> None:
    assert SPEC.live_file is None
    assert SPEC.account_switch is None
    assert SPEC.fetch_usage is None
    assert SPEC.login_command_args is None
    assert SPEC.install_hooks is None


def test_no_resume_model_or_reader() -> None:
    assert SPEC.supports_session_resume is False
    assert SPEC.make_log_reader is None
    assert SPEC.supports_model is False
    assert SPEC.supports_effort is False
