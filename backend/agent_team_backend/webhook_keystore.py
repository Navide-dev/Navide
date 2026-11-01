"""The key that wraps GitHub webhook secrets, and the wrapping.

GitHub sends a signature rather than the secret, so Navide has to be able to
read the secret back. Each secret is AES-256-GCM ciphertext in navide.db, with
its trigger's id as associated data, under one 256-bit key kept in the
operating system's own protection:

- macOS: a Keychain item of Navide's, apart from every CLI credential. Written
  through `security -i`, so the key is on stdin and never in anyone's argv.
- Windows: `write_private` (DPAPI). Linux: `write_private`, a 0600 file, which
  is weaker: any process of this user can read it, and `protection()` says so
  for the screen that turns a trigger on.

Nothing here falls back. A key that cannot be read right now is `KeyUnavailable`
and the request gets a 503; a key that is gone, or ciphertext that no longer
opens, is `KeyLost` and the trigger has to be rebuilt. A new secret is never
made up for an old trigger, and nothing is ever stored in the clear.

No message from `security` is kept or re-raised: its output can quote its input.
"""

from __future__ import annotations

import base64
import binascii
import logging
import secrets
import subprocess
from collections.abc import Callable
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import osplat
from .applog import app_data_dir

log = logging.getLogger(__name__)

KEY_BYTES = 32
_NONCE_BYTES = 12
_FILENAME = "webhook-key.bin"
_ACCOUNT = "navide"
_SECURITY = "/usr/bin/security"
_TIMEOUT_S = 30.0
#: errSecItemNotFound, as `security` reports it.
_NOT_FOUND = 44

Runner = Callable[..., subprocess.CompletedProcess]


class KeyUnavailable(RuntimeError):
    """The key exists but cannot be read now (a locked keychain, a dismissed
    dialog). Nothing is wrong with the trigger; the request is refused."""


class KeyLost(RuntimeError):
    """The key is gone or the ciphertext no longer opens, as after moving the
    database to another machine. The trigger has to be rebuilt."""


def protection() -> str:
    """'keychain', 'dpapi', or 'file' where only file permissions stand guard."""
    if osplat.platform_id == "darwin":
        return "keychain"
    return "dpapi" if osplat.platform_id == "win32" else "file"


def _service_name() -> str:
    """Per data directory: a dev build and an installed one keep apart keys."""
    return f"Navide webhook key {app_data_dir().name}"


def _quoted(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


class Keystore:
    def __init__(self, run: Runner = subprocess.run, *, directory: Path | None = None) -> None:
        self._run = run
        self._directory = directory

    def _path(self) -> Path:
        return (self._directory or app_data_dir()) / _FILENAME

    def _keychain_read(self) -> bytes | None:
        try:
            done = self._run(
                [_SECURITY, "find-generic-password", "-a", _ACCOUNT, "-s", _service_name(), "-w"],
                capture_output=True, stdin=subprocess.DEVNULL, timeout=_TIMEOUT_S, check=False,
            )
        except (OSError, subprocess.SubprocessError) as err:
            raise KeyUnavailable(type(err).__name__) from None
        if done.returncode == _NOT_FOUND:
            return None
        if done.returncode != 0:
            raise KeyUnavailable(f"keychain read failed ({done.returncode})")
        return self._decoded(done.stdout.strip())

    @staticmethod
    def _decoded(text: bytes) -> bytes:
        try:
            key = base64.b64decode(text, validate=True)
        except (binascii.Error, ValueError):
            raise KeyLost("the stored key is unreadable") from None
        if len(key) != KEY_BYTES:
            raise KeyLost("the stored key has the wrong length")
        return key

    def _keychain_write(self, key: bytes) -> None:
        line = "add-generic-password -U -a {} -s {} -w {}\n".format(
            _quoted(_ACCOUNT), _quoted(_service_name()), _quoted(base64.b64encode(key).decode()),
        )
        try:
            done = self._run(
                [_SECURITY, "-i"], input=line.encode(), capture_output=True, timeout=_TIMEOUT_S, check=False,
            )
        except (OSError, subprocess.SubprocessError) as err:
            raise KeyUnavailable(type(err).__name__) from None
        if done.returncode != 0:
            raise KeyUnavailable(f"keychain write failed ({done.returncode})")

    def _file_read(self) -> bytes | None:
        try:
            return self._decoded(osplat.secret_files.read_private(self._path()).strip())
        except FileNotFoundError:
            return None
        except OSError as err:
            raise KeyUnavailable(type(err).__name__) from None

    def load(self) -> bytes:
        """The key. KeyLost when there is none: only `ensure` makes one."""
        key = self._keychain_read() if protection() == "keychain" else self._file_read()
        if key is None:
            raise KeyLost("no key on this machine")
        return key

    def ensure(self) -> bytes:
        """The key, made on first use: a new trigger is what asks for one."""
        key = self._keychain_read() if protection() == "keychain" else self._file_read()
        if key is not None:
            return key
        key = secrets.token_bytes(KEY_BYTES)
        if protection() == "keychain":
            self._keychain_write(key)
        else:
            osplat.secret_files.write_private(self._path(), base64.b64encode(key))
        return key


def encrypt(key: bytes, trigger_id: str, secret: str) -> bytes:
    nonce = secrets.token_bytes(_NONCE_BYTES)
    return nonce + AESGCM(key).encrypt(nonce, secret.encode(), trigger_id.encode())


def decrypt(key: bytes, trigger_id: str, blob: bytes) -> str:
    try:
        return AESGCM(key).decrypt(blob[:_NONCE_BYTES], blob[_NONCE_BYTES:], trigger_id.encode()).decode()
    except (InvalidTag, ValueError):
        raise KeyLost("the secret does not open under this key") from None
