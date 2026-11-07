from __future__ import annotations

import json
from pathlib import Path

import pytest

from registry.manifest import (
    ManifestError,
    manifest_capabilities,
    manifest_referenced_files,
    parse_manifest,
)
from registry.trust import sensitive_capabilities
from registry.versions import latest_version, version_key
from tests.fixtures import contract_manifest, valid_manifest


CONTRACT_FIXTURES = Path(__file__).parents[3] / "docs" / "plugin-contracts" / "fixtures"
VALID_V2_FIXTURES = sorted((CONTRACT_FIXTURES / "valid").glob("*.json"))
INVALID_V2_FIXTURES = sorted((CONTRACT_FIXTURES / "invalid").glob("*.json"))


def _read_fixture(group: str, name: str) -> str:
    return (CONTRACT_FIXTURES / group / name).read_text(encoding="utf-8")


def _read_strict(text: str) -> dict:
    def unique(pairs: list[tuple[str, object]]) -> dict:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON object key: {key}")
            result[key] = value
        return result

    value = json.loads(text, object_pairs_hook=unique)
    assert isinstance(value, dict)
    return value


def test_valid_manifest_parses() -> None:
    m = parse_manifest(valid_manifest())
    assert m.id == "acme.hello"
    assert m.namespace == "acme"
    assert m.extension_name == "hello"
    assert m.categories == ["productivity", "demo"]


def test_minimal_manifest_without_marketplace_fields() -> None:
    data = {
        "id": "acme.hello",
        "name": "Hello",
        "version": "0.1.0",
        "publisher": "acme",
        "engines": {"navide": "^0.1.0"},
    }
    m = parse_manifest(data)
    assert m.displayName is None
    assert m.categories == []
    assert m.icon is None


@pytest.mark.parametrize("field", ["id", "name", "version", "publisher", "engines"])
def test_missing_required_field_rejected(field: str) -> None:
    data = valid_manifest()
    del data[field]
    with pytest.raises(ManifestError, match=field):
        parse_manifest(data)


def test_bad_id_rejected() -> None:
    with pytest.raises(ManifestError, match="id"):
        parse_manifest(valid_manifest(id="NoDot"))


def test_bad_version_rejected() -> None:
    with pytest.raises(ManifestError, match="version"):
        parse_manifest(valid_manifest(version="1.0"))


@pytest.mark.parametrize(
    "version",
    [
        "1.2.3-.",
        "1.2.3-a..b",
        "1.2.3-01",
        "1.2.3-0.01",
        "01.02.03",
    ],
)
def test_manifest_v2_malformed_version_rejected(version: str) -> None:
    manifest = contract_manifest()
    manifest["version"] = version
    with pytest.raises(ManifestError, match="version"):
        parse_manifest(manifest)


def test_manifest_v2_valid_prerelease_accepted() -> None:
    manifest = contract_manifest()
    manifest["version"] = "1.2.3-0.3.7"
    assert parse_manifest(manifest).version == "1.2.3-0.3.7"


def test_manifest_v2_build_metadata_is_accepted() -> None:
    manifest = contract_manifest()
    manifest["version"] = "1.2.3-alpha.1+build.4"
    assert parse_manifest(manifest).version == "1.2.3-alpha.1+build.4"


def test_manifest_v2_composition_fields_are_strict_and_referenced() -> None:
    manifest = contract_manifest()
    manifest["contributes"]["views"] = [
        {
            "id": "left",
            "kind": "custom",
            "location": "left",
            "title": "Left",
            "entry": "frontend/left/index.html",
            "detailView": "detail",
        },
        {
            "id": "detail",
            "kind": "custom",
            "location": "detail",
            "title": "Detail",
            "entry": "frontend/detail/index.html",
            "targetSchema": "schemas/item.json",
        },
        {
            "id": "window",
            "kind": "custom",
            "location": "window",
            "title": "Window",
            "entry": "frontend/window/index.html",
            "receives": {
                "protocolVersion": 1,
                "locations": ["left", "detail"],
                "editorTargets": {"protocolVersion": 1},
                "closeGuard": {"protocolVersion": 1},
            },
        },
    ]
    parsed = parse_manifest(manifest)
    assert parsed.contributes is not None
    assert parsed.contributes.views[0].detailView == "detail"
    assert parsed.contributes.views[1].targetSchema == "schemas/item.json"
    assert parsed.contributes.views[2].receives is not None
    assert parsed.contributes.views[2].receives.editorTargets is not None
    assert parsed.contributes.views[2].receives.closeGuard is not None
    assert "schemas/item.json" in manifest_referenced_files(parsed)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda manifest: manifest["contributes"]["views"][0].update(detailView="detail"),
        lambda manifest: manifest["contributes"]["views"][0].update(targetSchema="schemas/item.json"),
        lambda manifest: manifest["contributes"]["views"][0].update(
            receives={"protocolVersion": 1, "locations": ["left"]}
        ),
        lambda manifest: manifest["contributes"]["views"][0].update(
            location="window", receives={"protocolVersion": 1, "locations": ["left"], "extra": True}
        ),
        lambda manifest: manifest["contributes"]["views"][0].update(
            location="window",
            receives={
                "protocolVersion": 1,
                "locations": ["left"],
                "closeGuard": {"protocolVersion": 2},
            },
        ),
        lambda manifest: manifest["contributes"]["views"][0].update(
            location="window",
            receives={
                "protocolVersion": 1,
                "locations": ["left"],
                "closeGuard": {"protocolVersion": 1, "onPrepare": True},
            },
        ),
        lambda manifest: manifest["contributes"]["views"][0].update(
            location="window", receives={"protocolVersion": 1, "closeGuard": {"protocolVersion": 1}}
        ),
    ],
)
def test_manifest_v2_composition_fields_reject_invalid_placement_or_shape(mutate) -> None:
    manifest = contract_manifest()
    mutate(manifest)
    with pytest.raises(ManifestError):
        parse_manifest(manifest)


def test_latest_version_orders_valid_prerelease() -> None:
    assert latest_version(["1.2.3-alpha.1", "1.2.3"]) == "1.2.3"


@pytest.mark.parametrize(
    ("versions", "expected"),
    [
        (["1.0.0-foo", "1.0.0"], "1.0.0"),
        (["1.0.0-1", "1.0.0-foo"], "1.0.0-foo"),
        (["1.0.0-alpha", "1.0.0-alpha.1"], "1.0.0-alpha.1"),
        (["1.2.3-x.7.z.91", "1.2.3-x.7.z.92"], "1.2.3-x.7.z.92"),
        (["1.2.3-0.3.7", "1.2.3-0.3.8"], "1.2.3-0.3.8"),
    ],
)
def test_latest_version_uses_semver_precedence(
    versions: list[str], expected: str
) -> None:
    assert latest_version(versions) == expected


def test_version_precedence_ignores_build_metadata() -> None:
    assert version_key("1.2.3+build.1") == version_key("1.2.3+build.2")
    assert latest_version(["1.2.3-alpha+build.1", "1.2.3"]) == "1.2.3"
    assert latest_version(["1.2.3-alpha.beta+build.1", "1.2.3-alpha.beta+build.2"]) == (
        "1.2.3-alpha.beta+build.1"
    )


def test_latest_version_keeps_legacy_numeric_versions_orderable() -> None:
    assert version_key("01.02.03") == version_key("1.2.3")
    assert latest_version(["01.02.03", "1.2.4"]) == "1.2.4"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("name", "x" * 81),
        ("name", "line\nname"),
        ("name", "<name>"),
        ("title", "x" * 81),
        ("title", "line\ntitle"),
        ("title", "<title>"),
    ],
)
def test_manifest_v2_display_text_limits_rejected(field: str, value: str) -> None:
    manifest = contract_manifest()
    if field == "name":
        manifest[field] = value
    else:
        manifest["contributes"]["views"][0][field] = value
    with pytest.raises(ManifestError, match=field):
        parse_manifest(manifest)


def test_manifest_v2_accepts_sixteen_views() -> None:
    manifest = contract_manifest()
    manifest["contributes"]["views"] = [
        {
            "id": f"view-{index}",
            "kind": "custom",
            "location": "main",
            "title": f"View {index}",
            "entry": f"frontend/view-{index}/index.html",
        }
        for index in range(16)
    ]
    assert len(parse_manifest(manifest).contributes.views) == 16


def test_manifest_v2_rejects_seventeen_views() -> None:
    manifest = contract_manifest()
    manifest["contributes"]["views"] = [
        {
            "id": f"view-{index}",
            "kind": "custom",
            "location": "main",
            "title": f"View {index}",
            "entry": f"frontend/view-{index}/index.html",
        }
        for index in range(17)
    ]
    with pytest.raises(ManifestError, match="views"):
        parse_manifest(manifest)


def test_unknown_capability_rejected() -> None:
    with pytest.raises(ManifestError, match="capabilities"):
        parse_manifest(valid_manifest(requires=["fs", "bogus"]))


def test_unsupported_storage_capability_is_not_accepted_as_legacy_requires() -> None:
    with pytest.raises(ManifestError, match="storage"):
        parse_manifest(valid_manifest(requires=["storage"]))


def test_all_client_capabilities_accepted() -> None:
    # Mirrors backend plugins/manifest.py and client pluginVerify.ts.
    all_caps = ["fs", "git", "terminal", "search", "chat", "ui", "issues"]
    m = parse_manifest(valid_manifest(requires=all_caps))
    assert m.requires == all_caps


def test_legacy_registry_metadata_permissions_are_adapted_for_reading_only() -> None:
    legacy_row = contract_manifest()
    legacy_row["permissions"] = {
        "git": ["read"],
        "terminal": ["run"],
        "fs": ["read"],
        "ui": ["openInEditor"],
        "search": ["query"],
        "chat": ["send"],
        "issues": ["read"],
        "plans": ["read"],
    }
    assert manifest_capabilities(legacy_row) == [
        "fs",
        "git",
        "terminal",
        "search",
        "chat",
        "ui",
        "issues",
        "plans",
    ]
    assert sensitive_capabilities(manifest_capabilities(legacy_row)) == ["fs", "terminal"]
    with pytest.raises(ManifestError):
        parse_manifest(legacy_row)


def test_stored_v2_metadata_does_not_read_legacy_keys_with_canonical_system() -> None:
    row = contract_manifest()
    row["permissions"] = {"system": ["ui"], "fs": ["read"], "git": ["read"]}
    assert manifest_capabilities(row) == ["ui"]


def test_v2_metadata_does_not_fall_back_to_legacy_permission_keys() -> None:
    row = {
        "schemaVersion": 2,
        "permissions": {"system": ["ui"]},
        "fs": ["read"],
    }
    assert manifest_capabilities(row) == ["ui"]


def test_bad_activation_event_rejected() -> None:
    with pytest.raises(ManifestError, match="activation"):
        parse_manifest(valid_manifest(activationEvents=["whenever"]))


def test_empty_engines_rejected() -> None:
    with pytest.raises(ManifestError, match="engines"):
        parse_manifest(valid_manifest(engines={}))


@pytest.mark.parametrize(
    "name",
    [path.name for path in VALID_V2_FIXTURES],
)
def test_manifest_v2_valid_fixture_parses(name: str) -> None:
    manifest = parse_manifest(_read_strict(_read_fixture("valid", name)))
    assert manifest.schemaVersion == 2


@pytest.mark.parametrize("path", INVALID_V2_FIXTURES, ids=lambda path: path.name)
def test_manifest_v2_invalid_fixture_rejected(path: Path) -> None:
    with pytest.raises(ManifestError):
        parse_manifest(_read_strict(path.read_text(encoding="utf-8")))


def test_manifest_v2_duplicate_key_fixture_rejected_before_validation() -> None:
    with pytest.raises(ValueError, match="duplicate JSON object key: system"):
        _read_strict(_read_fixture("invalid-raw", "duplicate-permission-key.json"))


def test_manifest_v2_bom_fixture_rejected_before_validation() -> None:
    with pytest.raises(json.JSONDecodeError, match="BOM"):
        _read_strict(_read_fixture("invalid-raw", "manifest-utf8-bom.json"))


# -- permissions.network (PR C1) ----------------------------------------------


def test_manifest_v2_network_hosts_are_accepted_as_declared() -> None:
    m = parse_manifest(contract_manifest("network-hosts.json"))
    assert m.permissions.network is not None
    assert m.permissions.network.hosts == ["api.github.com", "*.example.com", "localhost"]


@pytest.mark.parametrize(
    "hosts",
    [
        ["https://api.github.com"],  # a scheme
        ["api.github.com:443"],  # a port
        ["Api.GitHub.com"],  # upper case
        ["*"],  # a bare wildcard
        ["api.github.com", "api.github.com"],  # a duplicate
        [],  # nothing declared
        [f"h{i}.example.com" for i in range(33)],  # over the maximum
    ],
)
def test_manifest_v2_network_hosts_rejected(hosts: list[str]) -> None:
    manifest = contract_manifest("network-hosts.json")
    manifest["permissions"]["network"] = {"hosts": hosts}
    with pytest.raises(ManifestError, match="network"):
        parse_manifest(manifest)


def test_manifest_v2_network_rejects_unknown_keys_and_extension_packs() -> None:
    manifest = contract_manifest("network-hosts.json")
    manifest["permissions"]["network"] = {"hosts": ["api.github.com"], "ports": [443]}
    with pytest.raises(ManifestError, match="network"):
        parse_manifest(manifest)
    pack = contract_manifest("extension-pack.json")
    pack["permissions"] = {"network": {"hosts": ["api.github.com"]}}
    with pytest.raises(ManifestError, match="permissions"):
        parse_manifest(pack)


# -- permissions.shell.executables (PR C2) --------------------------------------


def test_manifest_v2_shell_object_form_is_normalized() -> None:
    m = parse_manifest(contract_manifest("shell-executables.json"))
    assert m.permissions.shell == "allowlist"
    assert m.permissions.shellExecutables == ["npm", "terraform"]
    plain = parse_manifest(contract_manifest("frontend-multi-view.json"))
    assert plain.permissions.shell == "allowlist" and plain.permissions.shellExecutables is None


@pytest.mark.parametrize(
    "shell",
    [
        {"mode": "full", "executables": ["npm"]},
        {"mode": "allowlist", "executables": []},
        {"mode": "allowlist", "executables": ["/usr/bin/npm"]},
        {"mode": "allowlist", "executables": ["NPM"]},
        {"mode": "allowlist", "executables": ["npm", "npm"]},
        {"mode": "allowlist"},
        {"mode": "allowlist", "executables": ["npm"], "extra": 1},
        {"mode": "allowlist", "executables": [f"t{i}" for i in range(33)]},
        {"mode": "allowlist", "executables": ["git"]},
        {"mode": "allowlist", "executables": ["gh.cmd"]},
        {"mode": "allowlist", "executables": ["npm.exe"]},
    ],
)
def test_manifest_v2_shell_object_form_rejected(shell: dict) -> None:
    manifest = contract_manifest("shell-executables.json")
    manifest["permissions"]["shell"] = shell
    with pytest.raises(ManifestError, match="shell"):
        parse_manifest(manifest)


def test_manifest_v2_shell_executables_is_not_a_manifest_field() -> None:
    manifest = contract_manifest("fs-scopes-declared.json")
    manifest["permissions"]["shellExecutables"] = ["npm"]
    with pytest.raises(ManifestError, match="shell"):
        parse_manifest(manifest)
