"""Capability + trust-tier policy (metadata/gate layer, NOT a sandbox).

A package's `manifest.permissions` namespaces (or legacy `manifest.requires`)
are its declared capability set. This module turns publish-time facts into two
pieces of trust metadata the Extensions view
can surface to warn users:

- **trust tier** -- `signed-verified` when the registry created its artifact
  signature; otherwise `unsigned` (including pre-migration rows).
- **sensitive capabilities** -- `fs`, `aiCli`, `web`, and `shell` grant
  filesystem, brokered process, browser-session, or shell reach, so they
  warrant higher scrutiny. The
  legacy `terminal` label remains sensitive only for the v1 compatibility path.

This is deliberately simple and declarative. Actually sandboxing/enforcing the
capabilities at runtime is out of scope (that's a runtime executor).
"""

from __future__ import annotations

TRUST_SIGNED = "signed-verified"
TRUST_UNSIGNED = "unsigned"

SENSITIVE_CAPABILITIES: frozenset[str] = frozenset(
    {"fs", "aiCli", "web", "shell", "terminal"}
)


def compute_trust_tier(*, signed: bool) -> str:
    """Trust tier for a version, given whether the registry signed it."""
    return TRUST_SIGNED if signed else TRUST_UNSIGNED


def sensitive_capabilities(requires: list[str]) -> list[str]:
    """Subset of declared capabilities that warrant elevated scrutiny."""
    return [c for c in requires if c in SENSITIVE_CAPABILITIES]
