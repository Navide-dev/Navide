"""Re-export shim — openclaw's reader lives in ``cli_vendors.openclaw``. Lazy
for the same reason as the aider shim (registry-first import chains re-enter
the vendor module mid-initialization otherwise)."""

from __future__ import annotations

from typing import Any

_EXPORTS = ("OpenclawLogReader",)

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    if name in _EXPORTS:
        from ..cli_vendors import openclaw as _vendor

        return getattr(_vendor, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
