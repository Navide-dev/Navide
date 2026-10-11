"""`security -i` reads its stdin in 4096-byte lines (measured on Darwin 27.2: a
4095-byte command is the longest that round-trips). A longer
`add-generic-password ... -w "<secret>"` line is cut there: the first 4095
bytes run as a complete command — storing a TRUNCATED secret, because `-w` is
the last argument — and the remainder runs as a bogus command, so the call
returns 1 *after* the damage is done. The device trust record outgrew this and
locked cross-device traffic on the next restart (2026-10-11).

The guards live in `cloud_secrets.write`, the writer for Navide Cloud's own
items. The CLI account path (`CredentialVault._keychain_write`) is deliberately
left as it was — see test_cli_keychain_path_guard.py.

Every Keychain here is the fake below: nothing in this file runs `security`.
"""

from __future__ import annotations

import json
import logging
import shlex
from pathlib import Path

import pytest

from agent_team_backend import cloud_secrets
from agent_team_backend.cloud_secrets import CloudSecretError
from agent_team_backend.credential_vault import CredentialVault, CredentialVaultError
from tests.keychain_fake import security_g_output

LINE_LIMIT = 4095  # bytes per `security -i` command line, newline excluded

#: Distinctive enough that finding any piece of it in a message is a leak.
MARKER = "Zq7SecretPart"


class LineLimitedSecurity:
    """Fake `security` that splits interactive input the way the real one does,
    and echoes a failing chunk back the way the real one did in the log."""

    def __init__(self) -> None:
        self.items: dict[str, str] = {}
        self.interactive_lines: list[str] = []

    def _run(self, tokens: list[str]) -> int:
        cmd, service = tokens[0], tokens[tokens.index("-s") + 1]
        if cmd == "add-generic-password":
            self.items[service] = tokens[tokens.index("-w") + 1]
            return 0
        return 1

    def __call__(self, args, input_text=None):
        if args != ["-i"]:
            service = args[args.index("-s") + 1]
            if args[0] == "find-generic-password" and service in self.items:
                return 0, security_g_output(self.items[service])
            if args[0] == "delete-generic-password":
                self.items.pop(service, None)
                return 0, ""
            return 44, ""
        raw = (input_text or "").rstrip("\n").encode()
        self.interactive_lines.append(raw.decode(errors="ignore"))
        chunks = [raw[i:i + LINE_LIMIT] for i in range(0, len(raw), LINE_LIMIT)]
        rc, out = 0, ""
        for chunk in chunks:
            text = chunk.decode(errors="ignore")
            try:
                tokens = shlex.split(text)
            except ValueError:
                # The real parser accepts an unterminated quote at end of line.
                tokens = shlex.split(text + '"')
            try:
                failed = self._run(tokens)
            except (ValueError, IndexError):
                failed = 1
            if failed:
                rc, out = 1, f'{text}": returned 1'
        return rc, out


def _vault(tmp_path: Path) -> tuple[CredentialVault, LineLimitedSecurity]:
    sec = LineLimitedSecurity()
    vault = CredentialVault(root=tmp_path / "r", real_home=tmp_path / "h",
                            security_runner=sec, platform="darwin")
    return vault, sec


def _doc(pad: int) -> str:
    return json.dumps({"v": 1, "note": MARKER, "pad": "y" * pad, "name": "IDA指揮"},
                      ensure_ascii=False, separators=(",", ":"))


def _command_bytes(vault: CredentialVault, name: str, secret: str) -> int:
    import getpass
    q = cloud_secrets._quote
    command = " ".join(["add-generic-password", "-U", "-a", q(getpass.getuser()),
                        "-s", q(vault.app_secret_service(name)), "-w", q(secret)])
    return len(command.encode())


def test_an_oversized_write_is_refused_before_security_runs(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))
    vault, sec = _vault(tmp_path)
    good = _doc(100)
    cloud_secrets.write(vault, "navide-device-trust", good)
    sent = len(sec.interactive_lines)

    with pytest.raises(CloudSecretError):
        cloud_secrets.write(vault, "navide-device-trust", _doc(5000))

    assert len(sec.interactive_lines) == sent, "the oversized command reached security -i"
    assert vault.read_app_secret("navide-device-trust") == good


def test_the_longest_line_security_accepts_still_writes(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))
    vault, _ = _vault(tmp_path)
    secret = "a" * 100
    secret += "a" * (LINE_LIMIT - _command_bytes(vault, "edge", secret))
    assert _command_bytes(vault, "edge", secret) == LINE_LIMIT

    cloud_secrets.write(vault, "edge", secret)
    assert vault.read_app_secret("edge") == secret

    with pytest.raises(CloudSecretError):
        cloud_secrets.write(vault, "edge", secret + "a")
    assert vault.read_app_secret("edge") == secret


def test_a_refused_write_names_no_part_of_the_value(tmp_path, monkeypatch, caplog):
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))
    vault, _ = _vault(tmp_path)
    caplog.set_level(logging.DEBUG)

    with pytest.raises(CloudSecretError) as refused:
        cloud_secrets.write(vault, "navide-device-trust", _doc(5000))

    for text in (str(refused.value), caplog.text):
        assert MARKER not in text and "yyyy" not in text and "IDA" not in text


def test_a_failed_write_does_not_echo_security_output(tmp_path, monkeypatch, caplog):
    """`security` echoes the failing command, secret included — the log line
    that exposed this carried the tail of the trust record."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))

    def echoing(args, input_text=None):
        if args == ["-i"]:
            return 1, f'{input_text.strip()}": returned 1'
        return 44, ""

    vault = CredentialVault(root=tmp_path / "r", real_home=tmp_path / "h",
                            security_runner=echoing, platform="darwin")
    caplog.set_level(logging.DEBUG)

    with pytest.raises(CloudSecretError) as failed:
        cloud_secrets.write(vault, "navide-server-token", f"tok-{MARKER}")

    for text in (str(failed.value), caplog.text):
        assert MARKER not in text


def test_the_bound_is_not_applied_to_cli_account_credentials(tmp_path, monkeypatch):
    """User ruling: the CLI account path is not changed by this fix. Its write
    reaches `security` exactly as it did at v0.2.19, whatever its length."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))
    vault, sec = _vault(tmp_path)
    # It reaches `security` and fails there, as it always did (the fake cuts
    # the line the way the real one does) — no bound refuses it first.
    with pytest.raises(CredentialVaultError):
        vault._keychain_write("Claude Code-credentials", _doc(5000), account="me")
    assert len(sec.interactive_lines) == 1


@pytest.mark.parametrize("write", [
    lambda vault: vault.write_app_secret("must-not-land", "x"),
    lambda vault: cloud_secrets.write(vault, "must-not-land", "x"),
])
def test_tests_cannot_reach_the_real_security_binary(tmp_path, write):
    vault = CredentialVault(root=tmp_path / "r", real_home=tmp_path / "h", platform="darwin")
    with pytest.raises(AssertionError, match="real Keychain"):
        write(vault)
