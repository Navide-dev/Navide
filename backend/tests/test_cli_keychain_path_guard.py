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
    "CredentialVault._keychain_write": "2bcd837870f13ec86a4401b3044df0f850f79859e227db087bec694ca36b2634",
    "CredentialVault._keychain_delete": "b288dc4e76b41871a5c7fd9166b26dd5908c94279f693a100889c510dc925264",
    "CredentialVault.app_secret_path": "5202557703ddd1f9bebae65a6aeef4964616c976129ec6a21269568704fda799",
    "CredentialVault.app_secret_service": "010a5bb31525a00691deb93dd60d4e33323a87278fb026528b2adaef0e20058e",
    "CredentialVault.read_app_secret": "2d5f0d88e0916f91c627a42d26dc396de35730bf03fe40661e54fdd141976c18",
    "CredentialVault.write_app_secret": "683cc37bd887ecd07b5129d4cfcd61fe43b89c6de2fa3e3d06688e11b974b8fa",
}


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
        if isinstance(node, ast.ClassDef) and node.name == "CredentialVault":
            for member in node.body:
                name = f"CredentialVault.{member.name}" if isinstance(member, ast.FunctionDef) else ""
                if name in PINNED:
                    add(name, member)
    return found


def test_the_cli_credential_keychain_functions_are_unchanged():
    assert _fingerprints() == PINNED


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


def test_device_trust_never_writes_through_the_cli_path(mac_vault_without_cli_writes):
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
