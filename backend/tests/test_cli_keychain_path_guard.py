"""The CLI account Keychain path stays as it was, and Navide Cloud stays off it.

User ruling, 2026-10-11: the device-trust fix must not share a write path with
CLI account credentials. `CredentialVault._keychain_write` swaps live and slot
credentials for every Keychain vendor, so a change made there for Navide's own
items changes every account switch. Navide Cloud's items go through
`cloud_secrets.write` instead.

The fingerprints are of the source text as it stood at v0.2.19. A failure here
means a CLI credential function changed: that is a decision for the user, not a
side effect of fixing something else — update a fingerprint only with that.
"""

from __future__ import annotations

import ast
import hashlib
import inspect
import json
from pathlib import Path

import pytest

from agent_team_backend import app, cloud_secrets, credential_vault, server_link, trust_store
from agent_team_backend.credential_vault import CredentialVault
from tests.keychain_fake import security_g_output

PINNED = {
    "_default_security_runner": "28c60fd8aab62edd78a2b1ca4bcf46e4b083290791b27eaa6cc9f356a097b9b3",
    "_kc_quote": "623b7e1cc205f16d2b33f83d5e298eb9fd035037a238f23910da9e1d5654b829",
    "_parse_security_password": "233f3ecb3ac3cc88ce6e3df0ec9d3100d2378be18902262dcf6698b64705cdd4",
    "CredentialVault._keychain_read": "009a4d99d530d15850cc86f00cdb97891b93e70eec06b0cc8052179909ef6d37",
    # Re-pinned 2026-10-16: oversized writes fall back to a hex argv write
    # (Claude Code credentials with MCP logins exceed the security -i line).
    "CredentialVault._keychain_write": "fcf29ef287e652fa4eaef9a0bdc89ffe9cc636a6ad5709f7372ccb722da59fb8",
    "CredentialVault._keychain_delete": "b288dc4e76b41871a5c7fd9166b26dd5908c94279f693a100889c510dc925264",
    "CredentialVault.app_secret_path": "5202557703ddd1f9bebae65a6aeef4964616c976129ec6a21269568704fda799",
    "CredentialVault.app_secret_service": "010a5bb31525a00691deb93dd60d4e33323a87278fb026528b2adaef0e20058e",
    "CredentialVault.read_app_secret": "2d5f0d88e0916f91c627a42d26dc396de35730bf03fe40661e54fdd141976c18",
    "CredentialVault.write_app_secret": "683cc37bd887ecd07b5129d4cfcd61fe43b89c6de2fa3e3d06688e11b974b8fa",
    # Review KC-7: the names the items are stored under, and the live/slot
    # read-write methods built on the functions above.
    "CLAUDE_LIVE_KEYCHAIN_SERVICE": "33cbe407a0a3ca48a9a5419ddf09d4c9825fc0d38e48afcdd6fffb2fec04b4b1",
    "_SLOT_SERVICE_PREFIX": "f17760e730ccb92d59cadc15b6467dc80b490aaf3b6f17cf6afd43b5fa8f7198",
    "_APP_SECRET_SERVICE_PREFIX": "759ef56f3eaa9d04a93c62784656a5ba7249e8cd76a6e6bd56e16626b0e3b3c5",
    "CredentialVault._slot_service": "844846b282ca8d61e43c414203ae45664d0c2adb289b293f96aed1db3e18ff85",
    "CredentialVault._read_vendor_keychain": "845903f7aeab553e042a1e084d4c7858d5a5dc0c706c002f0d3f9b913b16de15",
    "CredentialVault._write_vendor_keychain": "cd1794eca85a85ea59bf4be52956101868bea1dfeea544c29beca6ee1801ed3f",
    "CredentialVault.read_live": "8796ab7fcdb80bb5c3a3df80c50c5e79da71b083f74e38d868a30ac4faf602b5",
    "CredentialVault.write_live": "99c2d40e831a559a12df8fbdbaac8093250e1ad8388b496915bdd36e59e53a10",
    "CredentialVault._app_secret_suffix": "d8c96ee22d696df809fc0a930702a9ff25ebf475623206ffcc0e44b3bf2be6c8",
    "CredentialVault.read_slot": "6f77b5285aaa76bbaca78b88684aa28bba5eb3017c1f55a0792f41052780c658",
    "CredentialVault.write_slot": "af404431b2e9cbb22a7e944947627b9b0a9eb502d4e43c6638f11aed4d2693d4",
}

#: The owner-only file writer slots use off macOS (and on macOS for files), as
#: shipped at v0.2.19. The Cloud journal has its own writer for this reason.
POSIX_SECRETS_SHA256 = "97dd4fbf3016b3394b5c5f48e323c90a4d17ca59718741f034f04b025f6eb798"


def _fingerprints() -> dict[str, str]:
    # Read from the file, not from live objects: the test suite monkeypatches
    # `_default_security_runner`, and the guard is about the shipped source.
    path = Path(inspect.getsourcefile(credential_vault))
    source = path.read_text(encoding="utf-8")
    found: dict[str, str] = {}

    def add(name: str, node: ast.AST) -> None:
        found[name] = hashlib.sha256(ast.get_source_segment(source, node).encode()).hexdigest()

    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name in PINNED:
            add(node.name, node)
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in PINNED:
                    add(target.id, node)
        if isinstance(node, ast.ClassDef) and node.name == "CredentialVault":
            for member in node.body:
                name = f"CredentialVault.{member.name}" if isinstance(member, ast.FunctionDef) else ""
                if name in PINNED:
                    add(name, member)
    return found


def test_the_cli_credential_keychain_functions_are_unchanged():
    assert _fingerprints() == PINNED


def test_the_owner_only_file_writer_is_unchanged():
    from agent_team_backend.osplat import _posix_secrets

    path = Path(inspect.getsourcefile(_posix_secrets))
    assert hashlib.sha256(path.read_bytes()).hexdigest() == POSIX_SECRETS_SHA256


def test_the_item_names_are_the_shipped_ones(tmp_path):
    """Written out, not imported: a test importing the constant follows it when
    it changes, and every stored item would be orphaned with nothing failing."""
    sec = _Security()
    vault = CredentialVault(root=tmp_path / "r", real_home=tmp_path / "h",
                            security_runner=sec, platform="darwin")
    vault.write_slot("claude", "acct1", credential_vault.LiveCredentials(secret="S1"))
    vault.write_app_secret("navide-server-token", "T")
    vault.switch("claude", credential_vault.DEFAULT_SLOT_ID, "acct1")

    assert sec.items["Claude Code-credentials"] == "S1"
    assert "Navide CLI account claude-acct1" in sec.items or "Navide CLI account claude-__default__" in sec.items
    assert any(name.startswith("Navide secret navide-server-token") for name in sec.items)


class _Security:
    """A Keychain fake; the item store a darwin vault reads and writes."""

    def __init__(self) -> None:
        self.items: dict[str, str] = {}

    def __call__(self, args, input_text=None):
        import shlex

        tokens = shlex.split(input_text) if args == ["-i"] else list(args)
        service = tokens[tokens.index("-s") + 1]
        if tokens[0] == "add-generic-password":
            self.items[service] = tokens[tokens.index("-w") + 1]
            return 0, ""
        if tokens[0] == "find-generic-password":
            return (0, security_g_output(self.items[service])) if service in self.items else (44, "")
        if tokens[0] == "delete-generic-password":
            return (0, "") if self.items.pop(service, None) is not None else (44, "")
        return 1, ""


@pytest.fixture
def mac_vault_without_cli_writes(tmp_path, monkeypatch):
    """A darwin vault whose CLI write function explodes if anything calls it."""
    sec = _Security()
    vault = CredentialVault(root=tmp_path / "r", real_home=tmp_path / "h",
                            security_runner=sec, platform="darwin")

    def forbidden(self, *_args, **_kwargs):
        raise AssertionError("Navide Cloud wrote through the CLI account Keychain path")

    monkeypatch.setattr(CredentialVault, "_keychain_write", forbidden)
    monkeypatch.setattr(app, "credential_vault", vault)
    return sec


def test_device_trust_never_writes_through_the_cli_path(mac_vault_without_cli_writes, monkeypatch):
    # The record in its Keychain item, as before the sealed file.
    monkeypatch.setattr(trust_store, "FILE_STORE", False)
    sec = mac_vault_without_cli_writes
    trust_store.load()
    trust_store.pin_device("dev-a", sign_key="k" * 64, member_id="m1")
    trust_store.note_remote_command("dev-a", device_name="TKM5", workspace="IDA", pane_name="IDA指揮")
    trust_store.note_seen_message("k1")
    trust_store.flush_seen_messages()

    stored = sec.items[app.credential_vault.app_secret_service(trust_store.SECRET_NAME)]
    assert json.loads(stored)["pins"]["dev-a"]

    sec.items[app.credential_vault.app_secret_service(trust_store.SECRET_NAME)] = "{"
    trust_store._state = None
    with pytest.raises(trust_store.TrustStoreLocked):
        trust_store.load()
    trust_store.rebuild_locked_store()
    trust_store.load()


def test_the_sealed_record_key_and_its_downgrade_copy_never_write_through_the_cli_path(
    mac_vault_without_cli_writes,
):
    from agent_team_backend import trust_file

    sec = mac_vault_without_cli_writes
    trust_store.load()
    trust_store.pin_device("dev-a", sign_key="k" * 64, member_id="m1")
    assert app.credential_vault.app_secret_service(trust_file.KEY_SECRET) in sec.items
    stored = sec.items[app.credential_vault.app_secret_service(trust_store.SECRET_NAME)]
    assert json.loads(stored)["pins"]["dev-a"]


def test_the_cloud_token_and_salt_never_write_through_the_cli_path(mac_vault_without_cli_writes, monkeypatch):
    sec = mac_vault_without_cli_writes
    server_link.set_access_token("tok-1")
    assert server_link.access_token() == "tok-1"

    # The salt swallows a failed write, so its arrival is what is checked.
    monkeypatch.setattr(server_link, "_workspace_salt_cache", b"")
    server_link._workspace_salt()
    assert app.credential_vault.app_secret_service(server_link.WORKSPACE_SALT_SECRET) in sec.items

    server_link.set_access_token(None)
    assert server_link.access_token() == ""


def test_cloud_secrets_is_its_own_writer():
    """Not a wrapper round the CLI function: no code in the module names it
    (its docstring explains why it exists, which is allowed)."""
    tree = ast.parse(Path(inspect.getsourcefile(cloud_secrets)).read_text(encoding="utf-8"))
    names = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    names |= {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    assert "_keychain_write" not in names
