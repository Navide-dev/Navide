"""Durable secret files on POSIX: fsynced, owner-only, never through a link.

Not `_posix_secrets`: that writer is shared with CLI account slots and is left
exactly as it was, and it writes once without fsync, so a power cut could leave
an empty file behind. Windows has no equivalent here and keeps DPAPI through
`secret_files` (see `osplat.durable_secret_files`).
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


class PosixDurableSecretFiles:
    """`DurableSecretFiles` through mode bits, fsync and `O_NOFOLLOW`."""

    def read(self, path: Path) -> bytes:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            chunks = []
            while chunk := os.read(fd, 65536):
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            os.close(fd)

    def write(self, path: Path, data: bytes) -> None:
        directory = path.parent
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=f".{path.name}.", suffix=".tmp")
        try:
            try:
                view = memoryview(data)
                while view:
                    view = view[os.write(fd, view):]
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


durable_secret_files = PosixDurableSecretFiles()
