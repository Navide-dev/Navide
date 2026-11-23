"""Asset storage abstraction.

`StorageBackend` is the seam a real CDN/S3 backend drops in behind. The only
implementation in this slice is a local-filesystem store.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import BinaryIO, Protocol, runtime_checkable


@runtime_checkable
class StorageBackend(Protocol):
    """Content store keyed by opaque string keys."""

    def put(self, key: str, data: bytes) -> None: ...

    def put_stream(self, key: str, stream: BinaryIO) -> None:
        """Store the whole of a seekable binary stream, read in chunks."""
        ...

    def get(self, key: str) -> bytes: ...

    def open_stream(self, key: str) -> BinaryIO:
        """Open a binary read stream for streaming responses."""
        ...

    def exists(self, key: str) -> bool: ...

    def delete(self, key: str) -> None: ...


class StorageError(RuntimeError):
    """Raised on a storage backend failure (e.g. missing key)."""


class LocalStorageBackend:
    """Stores objects as files under a root directory."""

    def __init__(self, root: Path | str) -> None:
        self._root = Path(root)
        self._root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        # Keys are registry-controlled (namespace/name/version/...), but guard
        # against traversal anyway.
        path = (self._root / key).resolve()
        root = self._root.resolve()
        if root != path and root not in path.parents:
            raise StorageError(f"key escapes storage root: {key!r}")
        return path

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def put_stream(self, key: str, stream: BinaryIO) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        stream.seek(0)
        with path.open("wb") as out:
            shutil.copyfileobj(stream, out)

    def get(self, key: str) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise StorageError(f"no such object: {key!r}")
        return path.read_bytes()

    def open_stream(self, key: str) -> BinaryIO:
        path = self._path(key)
        if not path.is_file():
            raise StorageError(f"no such object: {key!r}")
        return path.open("rb")

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def delete(self, key: str) -> None:
        path = self._path(key)
        if path.is_file():
            path.unlink()
