"""Re-export shim — goose's reader lives in ``cli_vendors.goose``; lazy like
the other vendor shims."""

from __future__ import annotations

from typing import Any

_EXPORTS = ("GooseLogReader",)

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    if name in _EXPORTS:
        from ..cli_vendors import goose as _vendor

        return getattr(_vendor, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
