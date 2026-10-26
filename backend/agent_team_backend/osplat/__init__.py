"""The one place in the backend that asks which operating system this is.

Every other module imports a capability from here and uses it unconditionally.
That is the rule this package exists to make enforceable: `test_osplat.py`
asserts that no feature module outside `osplat/` branches on `sys.platform`,
so a new platform branch has to be written as an implementation rather than as
an `if` in the middle of a feature.

Selection happens once, at import. The alternative — resolving per call — buys
nothing (the answer cannot change while the process runs) and costs a branch
on paths that sample on a timer.
"""

from __future__ import annotations

import sys

from . import spec

if sys.platform == "darwin":
    from . import _darwin as _impl
elif sys.platform.startswith("linux"):
    from . import _linux as _impl
elif sys.platform == "win32":
    from . import _windows as _impl
else:  # pragma: no cover - BSDs and friends
    # Not "raise": an unknown POSIX is much closer to Linux than to nothing,
    # and every seam degrades to unavailable on its own if the guess is wrong.
    from . import _linux as _impl

#: Which implementation module was selected. Exposed for diagnostics and for
#: the tests that assert the selection, not for callers to branch on.
impl_name: str = _impl.__name__.rsplit(".", 1)[-1]

#: This machine's platform, normalised to the three the code has arms for.
#:
#: For the callers that legitimately need the *identity* rather than a
#: capability. Two shapes qualify: a lookup keyed by platform (the onboarding
#: registry declaring which entries exist where), and a user-facing string that
#: names something platform-specific ("a macOS permission dialog"). Reading
#: `sys.platform` for either would work but puts the branch back in the feature
#: module, which is what the ratchet in `test_osplat.py` exists to stop.
#:
#: What does *not* qualify is a difference in behaviour: two ways of opening a
#: PTY, of storing a secret, of measuring memory. Those want an implementation
#: in `_darwin`/`_linux`/`_windows` behind a Protocol, not an `if` here.
platform_id: str = (
    "darwin" if sys.platform == "darwin"
    else "win32" if sys.platform == "win32"
    else "linux"
)

paths: spec.Paths = _impl.paths
resource_probe: spec.ResourceProbe = _impl.resource_probe
process_tree: spec.ProcessTree = _impl.process_tree
terminal_backend: spec.TerminalBackend = _impl.terminal_backend

__all__ = [
    "impl_name",
    "paths",
    "process_tree",
    "resource_probe",
    "spec",
    "terminal_backend",
]

# ---- appended seams ----------------------------------------------------------

secret_files: spec.SecretFiles = _impl.secret_files

__all__ += ["secret_files"]

durable_secret_files: spec.DurableSecretFiles = _impl.durable_secret_files

__all__ += ["durable_secret_files"]

scheduler: spec.Scheduler = _impl.scheduler

__all__ += ["scheduler"]

scripts: spec.Scripts = _impl.scripts

#: Both shells' renderers, keyed by the name the consumer uses for them.
#:
#: For the one caller that has to write text for a shell this machine is not
#: running: Copilot's hook file declares a `bash` and a `powershell` spelling
#: side by side and chooses at fire time, so the file is correct wherever it
#: is read rather than only where it was written. Everything else wants
#: `scripts`, which is this machine's.
from . import _posix_paths, _windows  # noqa: E402

scripts_by_shell: dict[str, spec.Scripts] = {
    "bash": _posix_paths.scripts,
    "powershell": _windows.scripts,
}

__all__ += ["scripts", "scripts_by_shell"]

from . import cli_network  # noqa: E402

collect_cli_connections = {
    "darwin": cli_network.collect_lsof,
    "linux": cli_network.collect_ss,
    "win32": cli_network.unsupported,
}[platform_id]

resolve_loopback_listeners = {
    "darwin": cli_network.listeners_lsof,
    "linux": cli_network.listeners_ss,
    "win32": cli_network.listeners_unsupported,
}[platform_id]

__all__ += ["collect_cli_connections", "resolve_loopback_listeners"]

from . import folder_birth  # noqa: E402

#: When a folder was created (None where it cannot be known): how the
#: convenience gate tells a CLI config folder made again from the same one.
folder_birth_time = {
    "darwin": folder_birth.from_stat,
    "linux": folder_birth.from_statx,
    "win32": folder_birth.from_stat,
}[platform_id]
__all__ += ["folder_birth_time"]

#: Whether this platform's default volumes treat two spellings differing only
#: in case as one path (APFS/HFS+ and NTFS do, Linux file systems do not). For
#: comparing paths that can no longer be stat'ed; a path that exists is better
#: compared by its (device, inode).
paths_ignore_case: bool = {"darwin": True, "linux": False, "win32": True}[platform_id]
__all__ += ["paths_ignore_case"]
