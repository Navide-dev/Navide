"""Keychain writes for Navide Cloud's own secrets, kept apart from CLI accounts.

The pairing trust record, the server token, the workspace salt, the sync key
ring and the portable-credential wrapping key are Navide's own items. They used
to be written through ``CredentialVault._keychain_write`` — the same function
that swaps CLI account credentials — and the trust record outgrew what that
function can store: `security -i` reads 4096-byte lines, runs the first 4095
bytes of a longer command as a complete one (storing a truncated secret, since
``-w`` is the last argument) and only then fails on the rest.

Fixing that inside the shared function would have changed how every CLI account
switch writes. So the CLI path is left exactly as it was, and these items get
this writer instead, with the guards they need:

* a command past the line limit is refused before ``security`` runs, so the
  stored item stays intact;
* a failure never quotes ``security``'s output, which echoes the command and
  with it the secret.

Reads and deletes stay on the vault's app-secret methods, unchanged: neither
goes through ``_keychain_write``, and the naming and per-data-dir isolation
they apply are what this writer has to match.
"""

from __future__ import annotations

import getpass

#: Longest command `security -i` runs intact: it reads 4096-byte lines, and the
#: newline is one of them (measured on Darwin 27.2).
SECURITY_LINE_MAX_BYTES = 4095


class CloudSecretError(RuntimeError):
    """A Navide Cloud secret could not be stored. Never carries the value."""


def _quote(value: str) -> str:
    """Quote a value for the `security -i` interactive command parser."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def write(vault, name: str, secret: str | None) -> None:
    """Store *secret* under *name* in *vault*'s app-secret namespace, or erase
    it when None. Callers pass the vault they read from, so a test that swaps
    one swaps both."""
    # Erasing, and every platform without a Keychain, never reach
    # `_keychain_write`, so the vault's method is used as it is.
    if secret is None or not vault._is_macos:
        vault.write_app_secret(name, secret)
        return
    service = vault.app_secret_service(name)
    # `security -i` parses one command per line: a newline would store
    # everything before it and fail on the rest.
    if "\n" in secret:
        raise CloudSecretError(f"refusing to write a multi-line secret for {service!r}")
    command = " ".join(
        ["add-generic-password", "-U", "-a", _quote(getpass.getuser()),
         "-s", _quote(service), "-w", _quote(secret)]
    )
    size = len(command.encode("utf-8"))
    if size > SECURITY_LINE_MAX_BYTES:
        raise CloudSecretError(
            f"refusing to write {service!r}: the security -i command would be "
            f"{size} bytes, over its {SECURITY_LINE_MAX_BYTES}-byte line limit; "
            "the stored item is unchanged"
        )
    # Interactive mode keeps the secret out of the argv, which any local
    # process can read via the process table.
    rc, _out = vault._security(["-i"], command + "\n")
    if rc != 0:
        # The exit code only: `security` echoes the command it failed on.
        raise CloudSecretError(f"keychain write failed for {service!r} (security exited {rc})")
    # A leftover file from a run on another platform would shadow the Keychain
    # item on the next read — the vault's own write removes it for the same reason.
    vault.app_secret_path(name).unlink(missing_ok=True)
