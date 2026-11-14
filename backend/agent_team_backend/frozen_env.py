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

import json
import os
import sys
from collections.abc import Mapping, MutableMapping


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


#: Set by the Electron main process when it points the packaged backend's
#: TMPDIR/TMP/TEMP at <data dir>/backend-tmp (src/main/backend.ts): a JSON
#: object of the values those keys had before, a missing key meaning unset.
ORIGINAL_TEMP_ENV_VAR = "AGENT_TEAM_ORIG_TEMP_ENV"
_TEMP_ENV_KEYS = ("TMPDIR", "TMP", "TEMP")


def restore_user_temp_env(
    env: Mapping[str, str], own: Mapping[str, str] | None = None
) -> dict[str, str]:
    """Return a copy of a pane's ``env`` with the user's own temp dir back.

    The backend keeps its data-dir temp (no OS cleaner sweeps it), but panes
    run the user's commands and must see the TMPDIR they would get outside
    Navide: the backend's path has a space in it and differs in case from the
    repo name. A key is restored only while it still holds the backend's own
    value (``own``, default ``os.environ``), so a value a caller chose for the
    pane is kept. Without the marker, e.g. in a dev run, nothing changes.
    """
    own = os.environ if own is None else own
    out = dict(env)
    out.pop(ORIGINAL_TEMP_ENV_VAR, None)
    try:
        original = json.loads(own.get(ORIGINAL_TEMP_ENV_VAR) or "null")
    except ValueError:
        return out
    if not isinstance(original, dict):
        return out
    for key in _TEMP_ENV_KEYS:
        backend_value = own.get(key)
        if backend_value is None or out.get(key) != backend_value:
            continue
        value = original.get(key)
        if isinstance(value, str):
            out[key] = value
        else:
            out.pop(key, None)
    return out


def packaged_bin_dir() -> str:
    """``<resources>/bin`` of a frozen build, where the app's sidecars live.

    electron-builder puts the pane helper and ``navide-stt`` in
    ``<resources>/bin``. A onedir backend runs from its own directory one
    level below, ``bin/agent_team_backend/`` (the executable next to
    ``_internal/``); a single-file backend sits in ``bin`` itself.
    """
    exe_dir = os.path.dirname(os.path.realpath(sys.executable))
    if os.path.isdir(os.path.join(exe_dir, "_internal")):
        return os.path.dirname(exe_dir)
    return exe_dir


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


def is_onefile_build() -> bool:
    """Whether this is a frozen onefile build, i.e. one that unpacked itself.

    Both kinds set ``sys._MEIPASS``. A onedir build's is its own ``_internal``
    directory next to the executable (the installed files); a onefile build's
    is the temporary directory it unpacked into, somewhere else entirely.
    """
    meipass = getattr(sys, "_MEIPASS", None)
    if not getattr(sys, "frozen", False) or not meipass:
        return False
    bundle = os.path.dirname(os.path.realpath(sys.executable))
    root = os.path.realpath(meipass)
    try:
        return os.path.commonpath([bundle, root]) != bundle
    except ValueError:  # Windows: different drives, so not inside the bundle
        return True


async def keep_extraction_warm(interval_s: float = EXTRACTION_KEEPALIVE_INTERVAL_S) -> None:
    """Touch the extraction directory now and every ``interval_s`` seconds.

    Returns at once in a dev run (nothing is extracted) and in a onedir build,
    which runs from its installed files -- touching those would only rewrite
    timestamps inside the signed app, or fail on a read-only AppImage mount.
    In a onefile build it runs for the life of the backend.
    """
    if not is_onefile_build():
        return
    import asyncio

    while True:
        touch_extraction_tree()
        await asyncio.sleep(interval_s)
