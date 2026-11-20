"""The packaged backend of a first-party plugin, as the App build staged it.

navide.plans and navide.browser are built in their own repositories
(Navide-dev/navide-<name>); their own suites test their backend sources. The
Host's contract tests run the executable the installer ships instead: the
version src/main/plugins/officialPluginVersions.ts pins, which
scripts/stage-official-plugin-artifacts.mjs takes from the official Registry
for this host's target (`bun run build` runs it).

Without a staged copy these tests skip, so a plain backend run needs no build.
NAVIDE_TEST_STAGED_PLUGINS=1 makes a missing copy a failure: CI's
build-artifacts job and the release gate set it, after the build staged one.
"""
from __future__ import annotations

import os
import platform
import re
import sys
from pathlib import Path

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
REQUIRED = os.environ.get("NAVIDE_TEST_STAGED_PLUGINS") == "1"


def _host_target() -> str:
    system = {"darwin": "darwin", "win32": "win32"}.get(sys.platform, "linux")
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    return f"{system}-{arch}"


def pinned_version(plugin_id: str) -> str:
    source = (REPOSITORY_ROOT / "src" / "main" / "plugins" / "officialPluginVersions.ts").read_text(encoding="utf-8")
    match = re.search(rf"'{re.escape(plugin_id)}': '([^']+)'", source)
    assert match, f"{plugin_id} has no pinned version in officialPluginVersions.ts"
    return match.group(1)


def staged_package(plugin_id: str) -> Path:
    return (
        REPOSITORY_ROOT / "dist-plugins" / "official-artifacts" / "factory-resources"
        / plugin_id / pinned_version(plugin_id) / _host_target() / "package"
    )


def staged_backend_command(plugin_id: str, executable: str) -> list[str]:
    """The staged backend executable to spawn, or skip (fail when required)."""
    name = f"{executable}.exe" if sys.platform == "win32" else executable
    entry = staged_package(plugin_id) / "backend" / name
    if entry.is_file():
        return [str(entry)]
    reason = (
        f"{plugin_id} is built in its own repository; this Host contract test runs its staged "
        f"backend {entry}, which `bun run build` stages"
    )
    if REQUIRED:
        pytest.fail(f"NAVIDE_TEST_STAGED_PLUGINS=1 but there is no staged backend: {reason}")
    pytest.skip(reason)
