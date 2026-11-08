"""Keep the frozen build's bundled library path out of child processes.

PyInstaller's Linux bootloader prepends its extraction directory
(``sys._MEIPASS``) to ``LD_LIBRARY_PATH`` and saves the value it found in
``LD_LIBRARY_PATH_ORIG``. Every process the backend spawns (panes, their login
shells, probes) would otherwise load the bundled libcrypto/libssl ahead of the
system's, which breaks any system binary built against a newer one (#417:
``systemd-cat … OPENSSL_3.4.0 not found``). PyInstaller's documented fix is to
restore the original value for children, or drop the variable if there was none.

The dynamic loader reads ``LD_LIBRARY_PATH`` once at process start, so changing
it here does not affect the backend's own already-resolved libraries.

Deliberately stdlib-only and import-light: ``run.py`` calls this before the
backend is imported, because ``osplat`` snapshots ``os.environ`` at import and
the credential helper ``exec()``s a CLI straight out of ``__main__``.
"""

from __future__ import annotations

import os
import sys
from collections.abc import MutableMapping


def restore_bundled_library_path(environ: MutableMapping[str, str] = os.environ) -> None:
    """Undo the bootloader's ``LD_LIBRARY_PATH`` in ``environ``.

    Acts only when this is a frozen build and the current value contains the
    extraction directory, i.e. when the bootloader set it. macOS and Windows
    bootloaders never do, so there this is a no-op, as it is in a dev run.
    """
    meipass = getattr(sys, "_MEIPASS", None)
    if not getattr(sys, "frozen", False) or not meipass:
        return
    value = environ.get("LD_LIBRARY_PATH")
    if value is None or meipass not in value.split(os.pathsep):
        return
    original = environ.get("LD_LIBRARY_PATH_ORIG")
    if original is not None:
        environ["LD_LIBRARY_PATH"] = original
    else:
        environ.pop("LD_LIBRARY_PATH", None)


#: How often the extraction directory is touched. macOS purges files under
#: $TMPDIR that have not been accessed for three days; systemd-tmpfiles defaults
#: to ten days for /tmp. Twice a day keeps either from seeing the files as idle.
EXTRACTION_KEEPALIVE_INTERVAL_S = 12 * 60 * 60


def touch_extraction_tree(root: str | os.PathLike[str] | None = None) -> int:
    """Mark every file under ``root`` (default ``sys._MEIPASS``) as used now.

    A onefile build unpacks itself into the OS temp directory and reads most
    of it lazily: package metadata, data files and rarely imported extensions
    stay untouched for days. The temp cleaners then delete them under the
    running process (2026-11-08: every dist-info's METADATA went, and from then
    on each new MCP session failed to initialize). Returns the number of files
    touched; 0 when there is no such directory.
    """
    if root is None:
        root = getattr(sys, "_MEIPASS", None)
    if not root or not os.path.isdir(root):
        return 0
    touched = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            try:
                os.utime(os.path.join(dirpath, name), None)
                touched += 1
            except OSError:
                continue
    return touched


async def keep_extraction_warm(interval_s: float = EXTRACTION_KEEPALIVE_INTERVAL_S) -> None:
    """Touch the extraction directory now and every ``interval_s`` seconds.

    Returns at once in a dev run (nothing is extracted); in a frozen build it
    runs for the life of the backend.
    """
    if not getattr(sys, "frozen", False) or not getattr(sys, "_MEIPASS", None):
        return
    import asyncio

    while True:
        touch_extraction_tree()
        await asyncio.sleep(interval_s)
