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
