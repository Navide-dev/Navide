"""Loaded by every Python process a test starts (conftest puts this directory
first on PYTHONPATH): the real `security` is refused there too.

Raises PermissionError, the error a sandboxed exec gives, so a spawned backend
treats the Keychain as unavailable and carries on rather than crashing.
"""

import errno
import os
import subprocess


def _argv0(args) -> str:
    if isinstance(args, (str, bytes, os.PathLike)):
        first = os.fsdecode(args).strip().split(" ", 1)[0]
    else:
        args = list(args)
        first = os.fsdecode(args[0]) if args else ""
    return os.path.basename(first)


class _NoKeychainPopen(subprocess.Popen):
    def __init__(self, args, *rest, **kwargs):
        if _argv0(args) == "security" or _argv0(kwargs.get("executable") or "x") == "security":
            raise PermissionError(errno.EPERM, f"a test's child reached the real Keychain: {args!r}"[:200])
        super().__init__(args, *rest, **kwargs)


subprocess.Popen = _NoKeychainPopen
