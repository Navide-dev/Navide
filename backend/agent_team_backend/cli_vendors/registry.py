"""The vendor registry: one entry per declared CLI. Nothing is registered here.

Which CLIs exist, and in which order, is the Rust runtime's declarations
(``cli_declarations.json``, read by ``_declared``). What the backend does for
a CLI beyond launching and resuming it (credentials, install detection, its
log reader, ...) lives in ``<key>.py`` beside this file, which exports
``SPEC``; the registry imports that module by the CLI's key. A declared CLI
with no such module is registered from its declaration alone.

So adding a vendor never edits this file. ``test_cli_vendors_registry.py``
cross-checks the set against the install-detection table, the log-reader
package and the frontend agent specs, and ``test_pyinstaller_spec.py`` holds
the packaged app to every module found this way (an import by name is one
PyInstaller cannot see).
"""

from __future__ import annotations

import importlib
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Any

from .. import osplat
from ._declared import declarations, declared
from .base import VendorRuntimeContext, VendorSpec


def _spec(entry: Mapping[str, Any]) -> VendorSpec:
    """The spec of one declared CLI: ``SPEC`` of the module named after its
    key, else the declaration alone."""
    key = entry["key"]
    name = f"{__package__}.{key}"
    try:
        module = importlib.import_module(name)
    except ModuleNotFoundError as err:
        if err.name != name:
            raise  # the module is there; one of its own imports is not
        return VendorSpec(key=key, **declared(key))
    spec = module.SPEC
    if spec.key != key:
        raise ValueError(f"cli_vendors/{key}.py declares {spec.key!r}, not the CLI it is named after")
    return spec


#: Every declared CLI, in the registry order its declaration names.
_ALL: tuple[VendorSpec, ...] = tuple(
    _spec(entry) for entry in sorted(declarations().values(), key=lambda entry: entry["order"]["registry"])
)

VENDORS: dict[str, VendorSpec] = {spec.key: spec for spec in _ALL}


def vendor(key: str) -> VendorSpec | None:
    """The spec for ``key``, or None for unknown/non-vendor keys (terminal)."""
    return VENDORS.get(key)


def account_capability(key: str) -> dict | None:
    """JSON-safe account-switch capability of one vendor, or None for an
    unknown key. ``supported`` is False when the spec declares no
    ``account_switch`` — the fail-closed answer the transaction and the UI
    act on; the other fields are then their empty defaults."""
    spec = VENDORS.get(key)
    if spec is None:
        return None
    switch = spec.account_switch
    if switch is None:
        return {
            "agentKey": key,
            "supported": False,
            "authScope": None,
            "method": None,
            "store": None,
            "evidence": None,
            "verifiedVersion": "",
            "platforms": [],
            "scopes": [],
            "hasExpiry": False,
            "hasIdentity": False,
            "resume": "none" if not spec.supports_session_resume else "native",
            "todo": "no account-switch adapter",
            "loginCommand": spec.login_command_args is not None,
        }
    return {
        "agentKey": key,
        "supported": True,
        "authScope": switch.auth_scope,
        "method": switch.method,
        "store": switch.store,
        "evidence": switch.evidence,
        "verifiedVersion": switch.verified_version,
        "platforms": list(switch.platforms),
        "scopes": list(switch.scopes),
        "hasExpiry": switch.expires_at is not None,
        "hasIdentity": spec.identity_from_secret is not None or key == "claude",
        "resume": switch.resume,
        "todo": switch.todo,
        "loginCommand": spec.login_command_args is not None,
    }


def account_capabilities() -> dict[str, dict]:
    """``account_capability`` for every registered vendor, keyed by agent key
    in registry order — every key is present, unsupported ones included, so a
    consumer never has to guess what an absent entry means."""
    return {key: account_capability(key) for key in VENDORS}


_PROXY_ENV_VARS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy",
)


def risk_runtime_context(env: Mapping[str, str], cwd: str | Path) -> VendorRuntimeContext:
    """Capture only risk declarations' path values and override presence.

    Called with the final child environment, never os.environ. A missing
    runtime home is unknown, not permission to scan the backend's home.
    """
    home_keys = (osplat.paths.home_env_var(), "HOME", "USERPROFILE")
    home_value = next((env[key] for key in home_keys if env.get(key)), "")
    if not home_value:
        raise ValueError("Risk runtime home is unavailable")
    home, working_dir = Path(home_value), Path(cwd)
    if not home.is_absolute() or not working_dir.is_absolute():
        raise ValueError("Risk runtime home and cwd must be absolute")
    path_keys = {"HOME", "USERPROFILE"}
    marker_keys = set(_PROXY_ENV_VARS)
    for spec in VENDORS.values():
        path_keys.update(spec.data_dir_env_vars)
        marker_keys.update(spec.network_override_env_vars)
    safe_env = {key: env[key] for key in path_keys if env.get(key)}
    safe_env.update({key: "1" for key in marker_keys if env.get(key)})
    return VendorRuntimeContext(home=home, env=MappingProxyType(safe_env), cwd=working_dir)


def expected_hosts_for_context(spec: VendorSpec, ctx: VendorRuntimeContext) -> tuple[str, ...]:
    """Use declared defaults only when no captured proxy/provider override exists.

    Configuration loaded internally by the CLI and tool/MCP destinations are
    outside this launch-environment snapshot; a match never proves safety.
    """
    if any(ctx.env.get(key) for key in (*_PROXY_ENV_VARS, *spec.network_override_env_vars)):
        return ()
    return spec.expected_hosts
