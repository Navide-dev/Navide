"""Pure Host-side grant and runtime-binding checks for Manifest v2.

This module deliberately does not import a plugin module, spawn a process, or
read identity from a plugin request. It is the Issue 03 conformance/test seam,
not a second production authorization authority; a production bridge must
reuse Host-owned state and the same contract. The legacy in-process PluginHost
remains a separate compatibility path.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

SYSTEM_NAMESPACES = frozenset({"fs", "ui", "aiCli", "web"})
SHELL_MODES = frozenset({"allowlist", "full"})
FORBIDDEN_PLUGIN_FIELDS = frozenset(
    {
        "pluginId",
        "plugin_id",
        "packageVersion",
        "package_version",
        "workspaceId",
        "workspace_id",
        "instanceId",
        "instance_id",
        "audience",
        "audienceId",
        "audience_id",
        "sessionOwner",
        "session_owner",
        "permissions",
        "grant",
        "executable",
        "argv",
        "cwd",
        "env",
        "pty",
        "transport",
    }
)


@dataclass(frozen=True)
class AuthenticatedRuntimeBinding:
    plugin_id: str
    package_version: str
    workspace_id: str | None
    instance_id: str | None
    audience: str | None


@dataclass(frozen=True)
class HostCapabilityGrant:
    package_version: str
    system: tuple[str, ...]
    shell: str | None = None
    high_risk_shell_confirmed: bool = False


@dataclass(frozen=True)
class HostCapabilityContext:
    publisher_eligible: bool
    user_grant: HostCapabilityGrant | None
    runtime_binding: AuthenticatedRuntimeBinding | None


@dataclass(frozen=True)
class HostAuthorizationDecision:
    allowed: bool
    code: str | None = None
    context: HostCapabilityContext | None = None


def _contains_forbidden_plugin_field(value: Any) -> bool:
    if isinstance(value, Mapping):
        return any(
            key in FORBIDDEN_PLUGIN_FIELDS or _contains_forbidden_plugin_field(item)
            for key, item in value.items()
        )
    if isinstance(value, list | tuple):
        return any(_contains_forbidden_plugin_field(item) for item in value)
    return False


def inject_host_context(
    *,
    publisher_eligible: bool,
    user_grant: HostCapabilityGrant | None,
    runtime_binding: AuthenticatedRuntimeBinding | None,
) -> HostCapabilityContext:
    """Create the immutable context used by the Host broker.

    All values come from Host-authenticated state. A Plugin has no call path to
    this constructor and no request field is merged into the returned context.
    """

    return HostCapabilityContext(
        publisher_eligible=publisher_eligible,
        user_grant=user_grant,
        runtime_binding=runtime_binding,
    )


def authorize_host_request(
    context: HostCapabilityContext,
    *,
    plugin_id: str,
    package_version: str,
    namespace: str,
    scope: str,
    declared_system: tuple[str, ...] = (),
    declared_shell: str | None = None,
    payload: Mapping[str, Any] | None = None,
) -> HostAuthorizationDecision:
    """Authorize one request using Host state and a validated declaration."""

    if payload is not None and _contains_forbidden_plugin_field(payload):
        return HostAuthorizationDecision(False, "CAPABILITY_DENIED")
    if namespace not in SYSTEM_NAMESPACES and namespace != "shell":
        return HostAuthorizationDecision(False, "METHOD_NOT_FOUND")
    if any(item not in SYSTEM_NAMESPACES for item in declared_system):
        return HostAuthorizationDecision(False, "CAPABILITY_DENIED")
    if declared_shell is not None and declared_shell not in SHELL_MODES:
        return HostAuthorizationDecision(False, "CAPABILITY_DENIED")

    binding = context.runtime_binding
    if binding is None or binding.plugin_id != plugin_id:
        return HostAuthorizationDecision(False, "CAPABILITY_DENIED")
    if binding.package_version != package_version:
        return HostAuthorizationDecision(False, "CAPABILITY_DENIED")
    if scope == "workspace" and not binding.workspace_id:
        return HostAuthorizationDecision(False, "WORKSPACE_SCOPE_VIOLATION")
    if scope not in {"workspace", "plugin"}:
        return HostAuthorizationDecision(False, "METHOD_NOT_FOUND")
    if namespace in {"fs", "aiCli", "shell"} and scope != "workspace":
        return HostAuthorizationDecision(False, "METHOD_NOT_FOUND")
    if namespace == "aiCli" and (not binding.instance_id or not binding.audience):
        return HostAuthorizationDecision(False, "CAPABILITY_DENIED")

    grant = context.user_grant
    if grant is None or grant.package_version != package_version:
        return HostAuthorizationDecision(False, "CAPABILITY_DENIED")
    if any(item not in SYSTEM_NAMESPACES for item in grant.system):
        return HostAuthorizationDecision(False, "CAPABILITY_DENIED")
    if grant.shell is not None and grant.shell not in SHELL_MODES:
        return HostAuthorizationDecision(False, "CAPABILITY_DENIED")
    if namespace == "shell":
        if declared_shell is None or grant.shell != declared_shell:
            return HostAuthorizationDecision(False, "CAPABILITY_DENIED")
        if declared_shell == "full" and not grant.high_risk_shell_confirmed:
            return HostAuthorizationDecision(False, "CAPABILITY_DENIED")
    else:
        if namespace not in SYSTEM_NAMESPACES:
            return HostAuthorizationDecision(False, "METHOD_NOT_FOUND")
        if namespace not in declared_system or namespace not in grant.system:
            return HostAuthorizationDecision(False, "CAPABILITY_DENIED")
        if namespace == "aiCli" and not context.publisher_eligible:
            return HostAuthorizationDecision(False, "CAPABILITY_DENIED")

    return HostAuthorizationDecision(True, context=context)
