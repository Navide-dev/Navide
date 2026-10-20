"""Strict Pydantic models for the public Manifest v2 contract."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .agent_tools_contract import validate_agent_tools
from .path_policy import canonical_html_path, canonical_package_path
from .versions import _V2_VERSION_RE

_V2_CATEGORY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
PACKAGE_ID_BODY_PATTERN = r"[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+"
PACKAGE_ID_RE = re.compile(rf"^{PACKAGE_ID_BODY_PATTERN}$")
_V2_DISPLAY_TEXT_RE = r"^[^\r\n<>]+$"
# Main's rule, unchanged (the App loads installed packages with it);
# agentTools[].method has the stricter supervisor rule. Pinned by test_backend_name_rule.py.
_V2_BACKEND_NAME_RE = re.compile(r"^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$")
# The App's backend supervisor accepts only these method names (isMethodName,
# src/main/plugins/pluginBackendSupervisor.ts); an agent tool forwarded to any
# other name could never be served, so publish refuses it.
_AGENT_TOOL_METHOD_RE = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*")
V2_SYSTEM_NAMESPACES: frozenset[str] = frozenset({"fs", "ui", "aiCli", "web"})
V2_SHELL_MODES: frozenset[str] = frozenset({"allowlist", "full"})
MAX_EXTENSION_PACK_MEMBERS = 20
# Manifest-level guard for recognizable source/script filenames. Proving that
# archive bytes are the correct target executable belongs to the B8 packager.
_KNOWN_SOURCE_BACKEND_SCRIPT_EXTENSIONS = frozenset(
    {
        ".py",
        ".pyw",
        ".js",
        ".mjs",
        ".cjs",
        ".ts",
        ".tsx",
        ".sh",
        ".bash",
        ".zsh",
        ".fish",
        ".ps1",
        ".cmd",
        ".bat",
    }
)


class ManifestV2Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @model_validator(mode="before")
    @classmethod
    def _reject_explicit_nulls(cls, value: Any) -> Any:
        if isinstance(value, Mapping):
            null_fields = [str(key) for key, item in value.items() if item is None]
            if null_fields:
                raise ValueError(
                    "explicit null is not allowed for field(s): "
                    + ", ".join(null_fields)
                )
        return value


class ManifestV2Engines(ManifestV2Model):
    navide: str = Field(min_length=1)


class ManifestV2Marketplace(ManifestV2Model):
    description: str = Field(min_length=1, max_length=280, pattern=r"^[^\r\n<>]+$")
    license: str = Field(
        min_length=1,
        max_length=100,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9.()+ -]*$",
    )
    repository: str | None = Field(
        default=None, max_length=2048, pattern=r"^https://[^\s]+$"
    )
    homepage: str | None = Field(
        default=None, max_length=2048, pattern=r"^https://[^\s]+$"
    )
    categories: list[str] = Field(default_factory=list, max_length=5)
    icon: str | None = Field(default=None, min_length=1)

    @field_validator("description")
    @classmethod
    def _check_description(cls, value: str) -> str:
        if "\r" in value or "\n" in value or "<" in value or ">" in value:
            raise ValueError("must not contain newlines or angle brackets")
        return value

    @field_validator("categories")
    @classmethod
    def _check_categories(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("must contain unique values")
        bad = [category for category in value if not _V2_CATEGORY_RE.fullmatch(category)]
        if bad:
            raise ValueError(f"contains invalid category slugs {bad}")
        return value

    @field_validator("icon")
    @classmethod
    def _check_icon(cls, value: str | None) -> str | None:
        if value is not None and canonical_package_path(value) is None:
            raise ValueError("must be a safe package-relative path")
        return value


class ManifestV2EditorTargets(ManifestV2Model):
    protocolVersion: Literal[1]


class ManifestV2CloseGuard(ManifestV2Model):
    protocolVersion: Literal[1]


class ManifestV2Receives(ManifestV2Model):
    protocolVersion: Literal[1]
    locations: list[Literal["left", "detail"]] = Field(min_length=1, max_length=2)
    editorTargets: ManifestV2EditorTargets | None = None
    closeGuard: ManifestV2CloseGuard | None = None

    @field_validator("locations")
    @classmethod
    def _check_unique_locations(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("must contain unique values")
        return value


class ManifestV2View(ManifestV2Model):
    id: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    kind: Literal["custom"]
    location: Literal["top", "bottom", "right", "left", "main", "window", "detail"]
    title: str = Field(min_length=1, max_length=80, pattern=_V2_DISPLAY_TEXT_RE)
    icon: str | None = Field(default=None, min_length=1)
    entry: str = Field(min_length=1)
    detailView: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9-]*$")
    targetSchema: str | None = Field(default=None, min_length=1)
    receives: ManifestV2Receives | None = None

    @field_validator("icon")
    @classmethod
    def _check_icon(cls, value: str | None) -> str | None:
        if value is not None and canonical_package_path(value) is None:
            raise ValueError("must be a safe package-relative path")
        return value

    @field_validator("entry")
    @classmethod
    def _check_entry(cls, value: str) -> str:
        if canonical_html_path(value) is None:
            raise ValueError("must be a safe package-relative HTML path")
        return value

    @field_validator("targetSchema")
    @classmethod
    def _check_target_schema(cls, value: str | None) -> str | None:
        if value is not None and (canonical_package_path(value) is None or not value.endswith(".json")):
            raise ValueError("must be a safe package-relative JSON path")
        return value

    @model_validator(mode="after")
    def _check_composition_fields(self) -> ManifestV2View:
        if self.detailView is not None and self.location != "left":
            raise ValueError("detailView is only valid for a left view")
        if self.targetSchema is not None and self.location != "detail":
            raise ValueError("targetSchema is only valid for a detail view")
        if self.receives is not None and self.location != "window":
            raise ValueError("receives is only valid for a window view")
        return self


class ManifestV2Contributes(ManifestV2Model):
    views: list[ManifestV2View] = Field(min_length=1, max_length=16)

    @model_validator(mode="after")
    def _check_unique_view_ids(self) -> ManifestV2Contributes:
        ids = [view.id for view in self.views]
        if len(set(ids)) != len(ids):
            raise ValueError("contributes.views must contain unique ids")
        detail_ids = {view.id for view in self.views if view.location == "detail"}
        for view in self.views:
            if view.detailView is not None and view.detailView not in detail_ids:
                raise ValueError("detailView must reference a detail view in the same package")
        return self


class ManifestV2Backend(ManifestV2Model):
    entry: str = Field(min_length=1)
    protocolVersion: Literal[1]
    activation: Literal["startup"]
    methods: list[str] | None = Field(default=None, min_length=1, max_length=64)
    events: list[str] | None = Field(default=None, min_length=1, max_length=32)
    # Kept as plain JSON: every field rule is validate_agent_tools' (the
    # contract module, checked on the whole manifest in ManifestV2).
    agentTools: list[dict[str, Any]] | None = Field(default=None, min_length=1)

    @field_validator("methods", "events")
    @classmethod
    def _check_names(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return value
        if len(set(value)) != len(value):
            raise ValueError("must not contain duplicate names")
        for name in value:
            if len(name) > 128 or not _V2_BACKEND_NAME_RE.fullmatch(name):
                raise ValueError("contains an invalid name")
        return value

    @field_validator("protocolVersion", mode="before")
    @classmethod
    def _reject_bool_protocol_version(cls, value: Any) -> Any:
        # bool is a subclass of int in Python, but JSON true is not protocol 1.
        if isinstance(value, bool):
            raise ValueError("must be integer 1, not boolean")
        return value

    @field_validator("entry")
    @classmethod
    def _check_entry(cls, value: str) -> str:
        if canonical_package_path(value) is None:
            raise ValueError("must be a safe package-relative path")
        suffix = "." + value.rsplit("/", 1)[-1].rsplit(".", 1)[-1].lower()
        if suffix in _KNOWN_SOURCE_BACKEND_SCRIPT_EXTENSIONS:
            raise ValueError("must reference a packaged executable, not a raw script")
        return value


_SCOPE_PATTERN_RE = re.compile(
    r"(?!/)(?!.*//)(?!.*(?:^|/)\.(?:/|$))(?!.*(?:^|/)\.\.(?:/|$))(?!.*\\)(?!.*/$)"
    r"(?!.*(?:[^/]\*\*|\*\*[^/]))[A-Za-z0-9._*/-]+"
)


class ManifestV2FsScopes(ManifestV2Model):
    """Path patterns a package declares it reads or writes, relative to root."""

    root: Literal["workspace", "repository"] | None = None
    read: list[str] | None = Field(default=None, min_length=1, max_length=16)
    write: list[str] | None = Field(default=None, min_length=1, max_length=16)

    @field_validator("read", "write")
    @classmethod
    def _check_paths(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return value
        if len(set(value)) != len(value):
            raise ValueError("must contain unique paths")
        if any(_SCOPE_PATTERN_RE.fullmatch(path) is None for path in value):
            raise ValueError("must contain safe relative path patterns")
        return value

    @model_validator(mode="after")
    def _check_declared(self) -> ManifestV2FsScopes:
        if self.read is None and self.write is None:
            raise ValueError("must declare read or write")
        return self


class ManifestV2Scopes(ManifestV2Model):
    """Declared resource scopes: a disclosure, never a grant."""

    fs: ManifestV2FsScopes


class ManifestV2Permissions(ManifestV2Model):
    """Coarse Manifest v2 grants; method access remains Host-catalog-owned."""

    system: list[Literal["fs", "ui", "aiCli", "web"]] | None = Field(
        default=None, min_length=1, max_length=4
    )
    shell: Literal["allowlist", "full"] | None = None
    scopes: ManifestV2Scopes | None = None

    @field_validator("system")
    @classmethod
    def _check_unique_system_namespaces(
        cls, value: list[str] | None
    ) -> list[str] | None:
        if value is not None and len(set(value)) != len(value):
            raise ValueError("permissions.system must contain unique namespaces")
        return value


class ManifestV2(ManifestV2Model):
    schemaVersion: Literal[2]
    apiVersion: str = Field(pattern=r"^[~^]?\d+\.\d+\.\d+$")
    id: str = Field(pattern=PACKAGE_ID_RE.pattern)
    name: str = Field(min_length=1, max_length=80, pattern=_V2_DISPLAY_TEXT_RE)
    version: str = Field(pattern=_V2_VERSION_RE.pattern)
    publisher: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$")
    engines: ManifestV2Engines | None = None
    permissions: ManifestV2Permissions
    marketplace: ManifestV2Marketplace
    contributes: ManifestV2Contributes | None = None
    backend: ManifestV2Backend | None = None
    extensionPack: list[str] | None = Field(
        default=None, min_length=1, max_length=MAX_EXTENSION_PACK_MEMBERS
    )
    """Extension Pack member ids. A pack has no runtime surface and no
    permissions of its own; each member is installed and confirmed alone."""

    @field_validator("extensionPack")
    @classmethod
    def _check_extension_pack(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return value
        if len(set(value)) != len(value):
            raise ValueError("must contain unique values")
        bad = [member for member in value if not PACKAGE_ID_RE.fullmatch(member)]
        if bad:
            raise ValueError(f"contains invalid package ids {bad}")
        return value

    @model_validator(mode="before")
    @classmethod
    def _check_agent_tools(cls, value: Any) -> Any:
        # The contract's own rules (docs/en-US/plugin-agent-tools-contract.md
        # section 2.5) on the raw manifest: they need the id and the declared
        # methods, and refuse a package exactly like a schema error.
        if isinstance(value, Mapping):
            errors = validate_agent_tools(dict(value))
            if errors:
                first = errors[0]
                where = "" if first["index"] is None else f"[{first['index']}]"
                field = f".{first['field']}" if first["index"] is not None and first["field"] else ""
                raise ValueError(f"backend.agentTools{where}{field} is invalid: {first['code']}")
            backend = value.get("backend")
            declared = backend.get("agentTools") if isinstance(backend, Mapping) else None
            for index, tool in enumerate(declared if isinstance(declared, list) else []):
                method = tool.get("method") if isinstance(tool, Mapping) else None
                if not isinstance(method, str) or _AGENT_TOOL_METHOD_RE.fullmatch(method) is None:
                    raise ValueError(
                        f"backend.agentTools[{index}].method {method!r} is not a backend method name the "
                        "App accepts (lower-case dotted segments of a-z, 0-9 and _)"
                    )
        return value

    @model_validator(mode="after")
    def _check_runtime_surface(self) -> ManifestV2:
        if self.extensionPack is not None:
            if self.id in self.extensionPack:
                raise ValueError("extensionPack must not list the pack itself")
            if self.contributes is not None or self.backend is not None:
                raise ValueError("an extension pack must not declare contributes or backend")
            if (
                self.permissions.system is not None
                or self.permissions.shell is not None
                or self.permissions.scopes is not None
            ):
                raise ValueError("an extension pack must not request permissions")
        elif self.contributes is None and self.backend is None:
            raise ValueError("manifest must declare contributes or backend")
        if self.publisher != self.namespace:
            raise ValueError("publisher must match id namespace")
        return self

    @property
    def namespace(self) -> str:
        return self.id.split(".", 1)[0]

    @property
    def extension_name(self) -> str:
        return self.id.split(".", 1)[1]
