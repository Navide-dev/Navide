"""Validate the draft Plugin v2 contract corpus.

Run with the marketplace registry environment so Draft 2020-12 support matches
the contract checks used during documentation review:

    uv --project marketplace/registry run python docs/plugin-contracts/validate-fixtures.py
"""

from __future__ import annotations

import importlib.util
import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, validators
from jsonschema.exceptions import ValidationError


ROOT = Path(__file__).resolve().parent


def _load_agent_tools_contract() -> Any:
    """The contract's own validator (section 2.5), loaded by path: this script
    runs in the registry environment, which does not install the backend."""
    path = ROOT.parents[1] / "backend" / "agent_team_backend" / "plugins" / "agent_tools_contract.py"
    spec = importlib.util.spec_from_file_location("agent_tools_contract", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_AGENT_TOOLS = _load_agent_tools_contract()


def _validate_pattern(
    _validator: Any,
    pattern: str,
    instance: Any,
    _schema: Any,
) -> Iterator[ValidationError]:
    """Use whole-string matching so Python does not treat final newlines as ends."""
    if isinstance(instance, str) and re.fullmatch(pattern, instance) is None:
        yield ValidationError(f"{instance!r} does not match {pattern!r}")


StrictDraft202012Validator = validators.extend(
    Draft202012Validator,
    {"pattern": _validate_pattern},
)


class DuplicateKeyError(ValueError):
    """Raised before schema validation when a JSON object repeats a key."""


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _load_strict(path: Path) -> Any:
    return json.loads(path.read_text(), object_pairs_hook=_unique_object)


def _load_wire_frame(path: Path) -> Any:
    raw = path.read_bytes().decode("utf-8")
    if raw.endswith("\n"):
        raw = raw[:-1]
        if raw.endswith("\r"):
            raw = raw[:-1]
    if "\n" in raw or "\r" in raw:
        raise ValueError("Backend Wire frame must contain exactly one line")
    return json.loads(raw, object_pairs_hook=_unique_object)


def _validate_manifest_semantics(manifest: Any) -> None:
    """Validate invariants that Draft 2020-12 cannot express by itself.

    The three composition location rules (detailView only on a left view,
    targetSchema only on a detail view, receives only on a window view) live in
    the schema itself; a detailView must additionally resolve to a detail view
    declared by the same package, which needs the whole views array.
    """
    if not isinstance(manifest, dict):
        return
    agent_tool_errors = _AGENT_TOOLS.validate_agent_tools(manifest)
    if agent_tool_errors:
        raise ValueError(f"backend.agentTools: {agent_tool_errors[0]['code']}")
    backend = manifest.get("backend")
    for tool in (backend.get("agentTools") or []) if isinstance(backend, dict) else []:
        # The Host supervisor's method-name rule (isMethodName).
        if not re.fullmatch(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*", str(tool.get("method"))):
            raise ValueError("backend.agentTools method is not a name the Host accepts")
    pack = manifest.get("extensionPack")
    if isinstance(pack, list) and manifest.get("id") in pack:
        raise ValueError("extensionPack must not list the pack itself")
    contributes = manifest.get("contributes")
    if not isinstance(contributes, dict):
        return
    views = contributes.get("views")
    if not isinstance(views, list):
        return
    view_ids = [view.get("id") for view in views if isinstance(view, dict)]
    if len(view_ids) != len(set(view_ids)):
        raise ValueError("contributes.views must contain unique ids")
    by_id = {view["id"]: view for view in views if isinstance(view, dict) and isinstance(view.get("id"), str)}
    for view in views:
        if not isinstance(view, dict):
            continue
        detail_view = view.get("detailView")
        if detail_view is None:
            continue
        referenced = by_id.get(detail_view)
        if referenced is None or referenced.get("location") != "detail":
            raise ValueError(
                f"contributes.views detailView {detail_view!r} must reference a detail view in the same package"
            )


def _catalog_permissions(catalog: dict[str, Any]) -> tuple[set[str], int]:
    system_namespaces: set[str] = set()
    shell_entries = 0
    shell_addresses: set[str] = set()
    allowed_system = {"fs", "ui", "aiCli", "web", "agents", "agentMessages"}
    for item in [*catalog["methods"], *catalog["events"]]:
        if item["visibility"] != "public":
            continue
        permission = item.get("permission")
        if not isinstance(permission, dict):
            raise AssertionError(f"catalog entry has no permission: {item['address']}")
        permission_id = permission.get("id")
        if permission_id == "storage":
            # Host-managed storage is never declared in a manifest. Storage is a
            # public capability whose partition class (plugin|workspace) and key
            # are chosen per request, so the permission carries no fixed scope
            # and does not count as a system namespace or the shell entry.
            if set(permission) != {"id"}:
                raise AssertionError(
                    f"storage catalog permission must be exactly {{\"id\": \"storage\"}}: {item['address']}"
                )
            continue
        scope = permission.get("scope")
        if scope not in {"workspace", "plugin"}:
            raise AssertionError(f"catalog has unsupported scope on {item['address']}")
        if permission_id == "system":
            if set(permission) != {"id", "access", "scope"}:
                raise AssertionError(f"system catalog permission is malformed: {item['address']}")
            access = permission.get("access")
            if access not in allowed_system:
                raise AssertionError(
                    f"catalog has unsupported system namespace on {item['address']}"
                )
            system_namespaces.add(access)
        elif permission_id == "shell":
            # Every public shell entry (shell.run plus the fixed Host operations
            # such as shell.git* / shell.issue*) carries exactly the same coarse
            # permission object; the manifest's shell mode gates the whole family,
            # so no per-address rule is defined here.
            if set(permission) != {"id", "scope"} or scope != "workspace":
                raise AssertionError(f"shell catalog entry is malformed: {item['address']}")
            shell_addresses.add(item["address"])
            shell_entries += 1
        else:
            raise AssertionError(f"catalog has unsupported permission id: {permission_id!r}")
    if "shell.run" not in shell_addresses:
        raise AssertionError(
            f"catalog must publish the shell.run entry the manifest shell mode gates: {sorted(shell_addresses)}"
        )
    return system_namespaces, shell_entries


def main() -> None:
    schema = _load_strict(ROOT / "plugin-manifest-v2.schema.json")
    Draft202012Validator.check_schema(schema)
    validator = StrictDraft202012Validator(schema)

    execution_policy_schema = _load_strict(ROOT / "execution-policy-v1.schema.json")
    Draft202012Validator.check_schema(execution_policy_schema)
    execution_policy_validator = StrictDraft202012Validator(execution_policy_schema)
    execution_policy_fixtures = ROOT / "execution-policy-fixtures"
    for path in sorted((execution_policy_fixtures / "valid").glob("*.json")):
        policy = _load_strict(path)
        errors = list(execution_policy_validator.iter_errors(policy))
        if errors:
            raise AssertionError(
                f"valid Execution Policy fixture rejected: {path}: {errors[0].message}"
            )
        print(f"POLICY  {path.name}")
    for path in sorted((execution_policy_fixtures / "invalid").glob("*.json")):
        policy = _load_strict(path)
        if not list(execution_policy_validator.iter_errors(policy)):
            raise AssertionError(f"invalid Execution Policy fixture accepted: {path}")
        print(f"POLICY-NO {path.name}")
    for path in sorted((execution_policy_fixtures / "invalid-raw").glob("*.json")):
        try:
            _load_strict(path)
        except (DuplicateKeyError, json.JSONDecodeError):
            print(f"POLICY-RAW {path.name}")
        else:
            raise AssertionError(f"invalid raw Execution Policy parsed successfully: {path}")

    for path in sorted((ROOT / "fixtures" / "valid").glob("*.json")):
        manifest = _load_strict(path)
        errors = list(validator.iter_errors(manifest))
        if errors:
            raise AssertionError(f"valid fixture rejected: {path}: {errors[0].message}")
        _validate_manifest_semantics(manifest)
        print(f"VALID   {path.name}")

    for path in sorted((ROOT / "fixtures" / "invalid").glob("*.json")):
        manifest = _load_strict(path)
        errors = list(validator.iter_errors(manifest))
        if not errors:
            try:
                _validate_manifest_semantics(manifest)
            except ValueError:
                pass
            else:
                raise AssertionError(f"invalid fixture accepted: {path}")
        print(f"INVALID {path.name}")

    for path in sorted((ROOT / "fixtures" / "invalid-raw").glob("*.json")):
        try:
            _load_strict(path)
        except (DuplicateKeyError, json.JSONDecodeError):
            print(f"RAW     {path.name}")
        else:
            raise AssertionError(f"invalid raw fixture parsed successfully: {path}")

    catalog = _load_strict(ROOT / "capabilities-v1.json")
    known_errors = set(catalog["errors"])
    addresses: list[str] = []
    for method in catalog["methods"]:
        addresses.append(method["address"])
        if not set(method["errors"]) <= known_errors:
            raise AssertionError(f"unknown error code on {method['address']}")
        Draft202012Validator.check_schema(method["params"])
        Draft202012Validator.check_schema(method["result"])
    for event in catalog["events"]:
        addresses.append(event["address"])
        Draft202012Validator.check_schema(event["payload"])
    if len(addresses) != len(set(addresses)):
        raise AssertionError("capability catalog contains duplicate addresses")

    catalog_system_namespaces, shell_entries = _catalog_permissions(catalog)
    permission_properties = schema["properties"]["permissions"]["properties"]
    schema_system_namespaces = set(permission_properties["system"]["items"]["enum"])
    schema_shell_modes = set(permission_properties["shell"]["enum"])
    if schema_system_namespaces != catalog_system_namespaces:
        raise AssertionError(
            "manifest system namespaces and public capability catalog differ: "
            f"schema-only={sorted(schema_system_namespaces - catalog_system_namespaces)}, "
            f"catalog-only={sorted(catalog_system_namespaces - schema_system_namespaces)}"
        )
    if shell_entries < 1:
        raise AssertionError("expected at least one public shell catalog entry")
    if schema_shell_modes != {"allowlist", "full"}:
        raise AssertionError("manifest shell modes and public capability policy differ")
    if catalog.get("hostShellExecutableAllowlist") != ["git", "gh", "glab"]:
        raise AssertionError("Host shell executable allowlist must contain only git, gh, and glab")
    if "hostShellSubcommands" in catalog or "hostShellArgPatterns" in catalog:
        raise AssertionError("Host shell contract must not define subcommand or argument rules")
    print(
        f"CATALOG {len(catalog_system_namespaces)} system namespaces + "
        f"{shell_entries} shell entries"
    )

    wire_schema = _load_strict(ROOT / "backend-wire-v1.schema.json")
    Draft202012Validator.check_schema(wire_schema)
    wire_validator = StrictDraft202012Validator(wire_schema)
    wire_fixtures = ROOT / "backend-wire-fixtures"
    for path in sorted((wire_fixtures / "valid").glob("*.json")):
        frame = _load_wire_frame(path)
        errors = list(wire_validator.iter_errors(frame))
        if errors:
            raise AssertionError(
                f"valid Backend Wire fixture rejected: {path}: {errors[0].message}"
            )
        print(f"WIRE    {path.name}")
    for path in sorted((wire_fixtures / "invalid").glob("*.json")):
        frame = _load_wire_frame(path)
        if not list(wire_validator.iter_errors(frame)):
            raise AssertionError(f"invalid Backend Wire fixture accepted: {path}")
        print(f"WIRE-NO {path.name}")
    for path in sorted((wire_fixtures / "invalid-raw").glob("*.json")):
        try:
            _load_wire_frame(path)
        except (DuplicateKeyError, json.JSONDecodeError, UnicodeDecodeError, ValueError):
            pass
        else:
            raise AssertionError(f"invalid raw Backend Wire fixture parsed: {path}")
        print(f"WIRE-RAW {path.name}")


if __name__ == "__main__":
    main()
