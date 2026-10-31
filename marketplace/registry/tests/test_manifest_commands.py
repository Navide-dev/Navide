from __future__ import annotations

import copy

import pytest

from registry.manifest import ManifestError, parse_manifest
from tests.fixtures import CONTRACT_FIXTURES, contract_manifest


NO_COMMAND_FIXTURES = sorted(
    path.name for path in (CONTRACT_FIXTURES / "valid").glob("*.json") if path.name != "commands.json"
)


@pytest.mark.parametrize("name", NO_COMMAND_FIXTURES)
def test_manifest_without_commands_dumps_as_it_was_uploaded(name: str) -> None:
    raw = contract_manifest(name)
    if "schemaVersion" not in raw:
        pytest.skip("not a v2 manifest")
    dumped = parse_manifest(raw).model_dump(exclude_none=True)
    assert "commands" not in dumped.get("contributes", {})


def test_commands_are_kept_as_declared() -> None:
    raw = contract_manifest("commands.json")
    dumped = parse_manifest(raw).model_dump(exclude_none=True)
    assert dumped["contributes"]["commands"] == raw["contributes"]["commands"]


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda c: c.__setitem__("id", "other.tool.open"), "must be the package id"),
        (lambda c: c.__setitem__("id", "workbench.action.showCommands"), "must be the package id"),
        (lambda c: c.__setitem__("when", "x"), "when"),
        (lambda c: c.__setitem__("title", "<b>Open</b>"), "title"),
        (lambda c: c.__setitem__("run", {}), "run"),
        (lambda c: c.__setitem__("run", {"shell": "rm -rf /"}), "run"),
        (lambda c: c.__setitem__("run", {"view": "main", "method": "tests.run"}), "run"),
        (lambda c: c.__setitem__("run", {"view": "other"}), "not a declared view"),
        (lambda c: c.__setitem__("run", {"method": "tests.stop"}), "not in backend.methods"),
        (lambda c: c.__setitem__("run", {"view": "main", "target": {"tab": 1}}), "target"),
    ],
)
def test_bad_command_is_refused(change, message: str) -> None:
    raw = copy.deepcopy(contract_manifest("commands.json"))
    change(raw["contributes"]["commands"][0])
    with pytest.raises(ManifestError, match=message):
        parse_manifest(raw)


@pytest.mark.parametrize("head", ["workbench", "ui", "editor", "git", "navide"])
def test_commands_under_a_host_namespace_are_refused(head: str) -> None:
    raw = contract_manifest("commands.json")
    raw["id"] = f"{head}.commands"
    raw["publisher"] = head
    for command in raw["contributes"]["commands"]:
        command["id"] = command["id"].replace("acme", head, 1)
    with pytest.raises(ManifestError, match="own commands"):
        parse_manifest(raw)


def test_a_host_named_publisher_can_still_publish_without_commands() -> None:
    raw = contract_manifest("commands.json")
    raw["id"] = "git.commands"
    raw["publisher"] = "git"
    del raw["contributes"]["commands"]
    assert parse_manifest(raw).id == "git.commands"
