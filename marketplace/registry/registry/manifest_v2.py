"""Strict Pydantic models for the public Manifest v2 contract."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .agent_tools_contract import derive_agent_tool_prefix, validate_agent_tools
from .path_policy import canonical_html_path, canonical_package_path
from .versions import _V2_VERSION_RE

_V2_CATEGORY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
PACKAGE_ID_BODY_PATTERN = r"[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+"
PACKAGE_ID_RE = re.compile(rf"^{PACKAGE_ID_BODY_PATTERN}$")
_V2_DISPLAY_TEXT_RE = r"^[^\r\n<>]+$"
# Main's rule, unchanged (the App loads installed packages with it);
# agentTools[].method has the stricter supervisor rule. Pinned by test_backend_name_rule.py.
_V2_BACKEND_NAME_RE = re.compile(r"^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$")
# Command rules: the App's, word for word (parseCommands, packages/plugin-contracts).
_V2_COMMAND_NAME_RE = re.compile(r"^[a-z][a-zA-Z0-9]*$")
_V2_COMMAND_TARGET_KEY_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*$")
V2_RESERVED_COMMAND_HEADS: frozenset[str] = frozenset({"workbench", "ui", "editor", "git", "navide"})
# The App's backend supervisor accepts only these method names (isMethodName,
# src/main/plugins/pluginBackendSupervisor.ts); an agent tool forwarded to any
# other name could never be served, so publish refuses it.
_AGENT_TOOL_METHOD_RE = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*")
V2_SYSTEM_NAMESPACES: frozenset[str] = frozenset({"fs", "ui", "aiCli", "web", "agents", "agentMessages"})
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


class ManifestV2CommandViewRun(ManifestV2Model):
    view: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    target: dict[str, str] | None = Field(default=None, min_length=1, max_length=16)

    @field_validator("target")
    @classmethod
    def _check_target(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        for key, text in (value or {}).items():
            if _V2_COMMAND_TARGET_KEY_RE.fullmatch(key) is None:
                raise ValueError(f"target key {key!r} is invalid")
            if len(text) > 256:
                raise ValueError(f"target value of {key!r} exceeds 256 characters")
        return value


class ManifestV2CommandMethodRun(ManifestV2Model):
    method: str = Field(min_length=1)


class ManifestV2Command(ManifestV2Model):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=80, pattern=_V2_DISPLAY_TEXT_RE)
    run: ManifestV2CommandViewRun | ManifestV2CommandMethodRun
    suggestedKey: str | None = Field(default=None, min_length=1, max_length=64)


# Text the Host shows on its own surfaces next to its own controls: no line
# breaks, angle brackets, control, zero-width or bidirectional characters.
_SLOT_TEXT_RE = r"^[^\r\n<>\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+$"
_BACKEND_METHOD_NAME_RE = r"^[a-z][a-zA-Z0-9._-]{0,63}$"


class ManifestV2ApiMethod(ManifestV2Model):
    method: str = Field(pattern=_BACKEND_METHOD_NAME_RE)
    description: str = Field(min_length=1, max_length=280)


class ManifestV2PipelineNode(ManifestV2Model):
    id: str = Field(pattern=r"^[a-z][a-z0-9-]{0,39}$")
    title: str = Field(min_length=1, max_length=80, pattern=_SLOT_TEXT_RE)
    description: str | None = Field(default=None, min_length=1, max_length=280)
    method: str = Field(pattern=_BACKEND_METHOD_NAME_RE)
    timeoutMs: int | None = Field(default=None, ge=1000, le=600000)
    n8nTypes: list[str] | None = Field(default=None, min_length=1, max_length=16)

    @field_validator("n8nTypes")
    @classmethod
    def _check_n8n_types(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return value
        if len(set(value)) != len(value):
            raise ValueError("must contain unique n8n node types")
        if any(re.fullmatch(r"[A-Za-z0-9@][A-Za-z0-9@/._-]{0,127}", item) is None for item in value):
            raise ValueError("must contain n8n node types such as n8n-nodes-base.httpRequest")
        return value


class ManifestV2Setting(ManifestV2Model):
    key: str = Field(pattern=r"^[a-z][a-zA-Z0-9]{0,31}(\.[a-z][a-zA-Z0-9]{0,31}){0,3}$")
    title: str = Field(min_length=1, max_length=80, pattern=_SLOT_TEXT_RE)
    description: str | None = Field(default=None, min_length=1, max_length=280)
    type: Literal["boolean", "string", "number", "enum"]
    default: bool | int | float | str
    options: list[str] | None = Field(default=None, min_length=1, max_length=32)
    minimum: float | None = None
    maximum: float | None = None
    maxLength: int | None = Field(default=None, ge=1, le=4096)

    @model_validator(mode="after")
    def _check_type_rules(self) -> ManifestV2Setting:
        only = {"options": "enum", "minimum": "number", "maximum": "number", "maxLength": "string"}
        for field, kind in only.items():
            if getattr(self, field) is not None and self.type != kind:
                raise ValueError(f"settings {field} is only for type {kind}")
        value = self.default
        if self.type == "boolean" and not isinstance(value, bool):
            raise ValueError("a boolean setting's default must be a boolean")
        if self.type == "number":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("a number setting's default must be a number")
            if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
                raise ValueError("a number setting's minimum is above its maximum")
            if (self.minimum is not None and value < self.minimum) or (self.maximum is not None and value > self.maximum):
                raise ValueError("a number setting's default must be within its bounds")
        if self.type == "string" and (not isinstance(value, str) or len(value) > (self.maxLength or 1024)):
            raise ValueError("a string setting's default must be a string within its maxLength")
        if self.type == "enum":
            if not self.options or len(set(self.options)) != len(self.options):
                raise ValueError("an enum setting needs unique options")
            if any(re.fullmatch(_SLOT_TEXT_RE, option) is None or len(option) > 80 for option in self.options):
                raise ValueError("an enum setting's options must be display text of at most 80 characters")
            if not isinstance(value, str) or value not in self.options:
                raise ValueError("an enum setting's default must be one of its options")
        return self


class ManifestV2StatusBarItem(ManifestV2Model):
    command: str = Field(min_length=1)
    text: str = Field(min_length=1, max_length=80, pattern=_SLOT_TEXT_RE)
    tooltip: str | None = Field(default=None, min_length=1, max_length=200, pattern=_SLOT_TEXT_RE)


class ManifestV2PaneAction(ManifestV2Model):
    command: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=80, pattern=_SLOT_TEXT_RE)


class ManifestV2ExplorerMenuItem(ManifestV2Model):
    command: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=80, pattern=_SLOT_TEXT_RE)
    when: Literal["file", "directory", "any"] | None = None


class ManifestV2Contributes(ManifestV2Model):
    views: list[ManifestV2View] = Field(min_length=1, max_length=16)
    commands: list[ManifestV2Command] | None = Field(default=None, min_length=1, max_length=32)
    # View-served agent tools (contract 2.9), kept as plain JSON like
    # backend.agentTools: every field rule is validate_agent_tools'.
    agentTools: list[dict[str, Any]] | None = Field(default=None, min_length=1)
    api: list[ManifestV2ApiMethod] | None = Field(default=None, min_length=1, max_length=32)
    pipelineNodes: list[ManifestV2PipelineNode] | None = Field(default=None, min_length=1, max_length=16)
    settings: list[ManifestV2Setting] | None = Field(default=None, min_length=1, max_length=32)
    statusBar: list[ManifestV2StatusBarItem] | None = Field(default=None, min_length=1, max_length=4)
    paneActions: list[ManifestV2PaneAction] | None = Field(default=None, min_length=1, max_length=8)
    explorerMenu: list[ManifestV2ExplorerMenuItem] | None = Field(default=None, min_length=1, max_length=8)

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


_NETWORK_HOST_RE = re.compile(
    r"^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$"
)


class ManifestV2Network(ManifestV2Model):
    """Hosts the package's views may connect to; enforced by the plugin
    frame's connect-src on the App, disclosed here."""

    hosts: list[str] = Field(min_length=1, max_length=32)

    @field_validator("hosts")
    @classmethod
    def _check_hosts(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("must contain unique hosts")
        if any(len(host) > 253 or _NETWORK_HOST_RE.fullmatch(host) is None for host in value):
            raise ValueError(
                "must contain lowercase DNS hosts such as api.example.com, optionally starting with *., "
                "with no scheme, port or path"
            )
        return value


AGENT_EVENTS = (
    "agents.paneCreated", "agents.paneClosed", "agents.turnEnded", "agents.paneIdle",
    "agents.messageReceived", "agents.planStageChanged", "agents.pipelineNodeChanged", "agents.scheduleFired",
)


class ManifestV2AgentEvents(ManifestV2Model):
    """Host events the package receives, each disclosed on its own (E1)."""

    events: list[
        Literal[
            "agents.paneCreated", "agents.paneClosed", "agents.turnEnded", "agents.paneIdle",
            "agents.messageReceived", "agents.planStageChanged", "agents.pipelineNodeChanged", "agents.scheduleFired",
        ]
    ] = Field(min_length=1, max_length=8)

    @field_validator("events")
    @classmethod
    def _check_unique(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("permissions.agents.events must contain unique events")
        return value


_SHELL_EXECUTABLE_RE = re.compile(r"^[a-z0-9][a-z0-9._+-]{0,63}$")
_SHELL_EXTENSION_RE = re.compile(r"\.(exe|cmd|bat|com|ps1)$")


class ManifestV2Permissions(ManifestV2Model):
    """Coarse Manifest v2 grants; method access remains Host-catalog-owned.

    ``shell`` may be spelled in the manifest as ``{"mode": "allowlist",
    "executables": [...]}`` (C2): the object form is normalized here into
    ``shell="allowlist"`` plus ``shellExecutables``, so every reader of
    ``permissions.shell`` keeps comparing a mode string.
    """

    system: list[Literal["fs", "ui", "aiCli", "web", "agents", "agentMessages"]] | None = Field(
        default=None, min_length=1, max_length=6
    )
    shell: Literal["allowlist", "full"] | None = None
    shellExecutables: list[str] | None = Field(default=None, min_length=1, max_length=32)
    scopes: ManifestV2Scopes | None = None
    network: ManifestV2Network | None = None
    agents: ManifestV2AgentEvents | None = None
    plugins: list[str] | None = Field(default=None, min_length=1, max_length=16)

    @field_validator("plugins")
    @classmethod
    def _check_plugins(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return value
        if len(set(value)) != len(value):
            raise ValueError("permissions.plugins must contain unique plugin ids")
        if any(PACKAGE_ID_RE.fullmatch(item) is None for item in value):
            raise ValueError("permissions.plugins must contain plugin ids such as acme.tools")
        return value

    @model_validator(mode="after")
    def _check_agent_events_need_agents(self) -> ManifestV2Permissions:
        if self.agents is not None and (self.system is None or "agents" not in self.system):
            raise ValueError("permissions.agents declares events without agents in permissions.system")
        return self

    @model_validator(mode="before")
    @classmethod
    def _normalize_shell_object(cls, value: Any) -> Any:
        if not isinstance(value, Mapping):
            return value
        if "shellExecutables" in value:
            raise ValueError("permissions.shellExecutables is not a manifest field; declare permissions.shell as an object")
        shell = value.get("shell")
        if not isinstance(shell, Mapping):
            return value
        if set(shell) != {"mode", "executables"}:
            raise ValueError("permissions.shell as an object takes exactly mode and executables")
        if shell["mode"] != "allowlist":
            raise ValueError('permissions.shell.mode must be "allowlist" when executables are declared')
        executables = shell["executables"]
        if not isinstance(executables, list) or not all(isinstance(name, str) for name in executables):
            raise ValueError("permissions.shell.executables must be a list of names")
        normalized = dict(value)
        normalized["shell"] = "allowlist"
        normalized["shellExecutables"] = executables
        return normalized

    @field_validator("shellExecutables")
    @classmethod
    def _check_shell_executables(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return value
        if len(set(value)) != len(value):
            raise ValueError("permissions.shell.executables must contain unique names")
        if any(_SHELL_EXECUTABLE_RE.fullmatch(name) is None for name in value):
            raise ValueError(
                "permissions.shell.executables must contain lowercase names such as npm, as spelled on PATH, with no path or shell word"
            )
        # A Host-family name is always admitted and has its own policy; a
        # Windows extension would reach that family's binary without it.
        if any(_SHELL_EXTENSION_RE.search(name) for name in value):
            raise ValueError("permissions.shell.executables must be bare names without a .exe/.cmd/.bat/.com/.ps1 extension")
        if any(name in ("git", "gh", "glab") for name in value):
            raise ValueError("permissions.shell.executables must not declare git, gh or glab, which allowlist always admits")
        return value

    @field_validator("system")
    @classmethod
    def _check_unique_system_namespaces(
        cls, value: list[str] | None
    ) -> list[str] | None:
        if value is not None and len(set(value)) != len(value):
            raise ValueError("permissions.system must contain unique namespaces")
        # Message text is disclosed on top of the agent metadata it belongs to.
        if value is not None and "agentMessages" in value and "agents" not in value:
            raise ValueError("permissions.system declares agentMessages without agents")
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
                owner = "contributes" if first.get("list") == "contributes" else "backend"
                where = "" if first["index"] is None else f"[{first['index']}]"
                field = f".{first['field']}" if first["index"] is not None and first["field"] else ""
                detail = ""
                if first["code"] == "AGENT_TOOL_PREFIX_MISMATCH":
                    # Name the prefix that would pass, as `navide-plugin validate` does.
                    name = value[owner]["agentTools"][first["index"]].get("name")
                    prefix = derive_agent_tool_prefix(value.get("id"))
                    detail = (
                        f" ({name!r} must start with '{prefix}_', the prefix Navide derives "
                        f"from id {value.get('id')!r}: its last segment without hyphens)"
                    )
                raise ValueError(f"{owner}.agentTools{where}{field} is invalid: {first['code']}{detail}")
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
                or self.permissions.network is not None
                or self.permissions.agents is not None
                or self.permissions.plugins is not None
            ):
                raise ValueError("an extension pack must not request permissions")
        elif self.contributes is None and self.backend is None:
            raise ValueError("manifest must declare contributes or backend")
        if self.publisher != self.namespace:
            raise ValueError("publisher must match id namespace")
        self._check_commands()
        self._check_contributed_extras()
        return self

    def _check_contributed_extras(self) -> None:
        """api / pipelineNodes name backend methods; view slots name this
        package's own commands; ids and keys are unique."""
        contributes = self.contributes
        if contributes is None:
            return
        methods = set(self.backend.methods or []) if self.backend is not None else set()
        for field in ("api", "pipelineNodes"):
            entries = getattr(contributes, field) or []
            for index, entry in enumerate(entries):
                if entry.method not in methods:
                    raise ValueError(f"contributes.{field}[{index}].method {entry.method!r} is not in backend.methods")
        api = [entry.method for entry in contributes.api or []]
        if len(set(api)) != len(api):
            raise ValueError("contributes.api must list each method once")
        nodes = [entry.id for entry in contributes.pipelineNodes or []]
        if len(set(nodes)) != len(nodes):
            raise ValueError("contributes.pipelineNodes must contain unique ids")
        keys = [entry.key for entry in contributes.settings or []]
        if len(set(keys)) != len(keys):
            raise ValueError("contributes.settings must contain unique keys")
        commands = {command.id for command in contributes.commands or []}
        for field in ("statusBar", "paneActions", "explorerMenu"):
            for index, entry in enumerate(getattr(contributes, field) or []):
                if entry.command not in commands:
                    raise ValueError(f"contributes.{field}[{index}].command {entry.command!r} is not one of contributes.commands")

    def _check_commands(self) -> None:
        contributes = self.contributes
        if contributes is None or contributes.commands is None:
            return
        if self.namespace in V2_RESERVED_COMMAND_HEADS:
            raise ValueError(
                f"contributes.commands cannot be declared under {self.namespace!r}, "
                "which is a namespace of Navide's own commands"
            )
        view_ids = {view.id for view in contributes.views}
        methods = set(self.backend.methods or []) if self.backend is not None else set()
        prefix = f"{self.id}."
        seen: set[str] = set()
        for index, command in enumerate(contributes.commands):
            name = command.id[len(prefix):] if command.id.startswith(prefix) else ""
            if _V2_COMMAND_NAME_RE.fullmatch(name) is None:
                raise ValueError(
                    f"contributes.commands[{index}].id {command.id!r} must be the package id, "
                    "a dot, then a name of letters and digits starting with a lower-case letter"
                )
            if command.id in seen:
                raise ValueError(f"contributes.commands[{index}].id {command.id!r} is declared twice")
            seen.add(command.id)
            run = command.run
            if isinstance(run, ManifestV2CommandViewRun) and run.view not in view_ids:
                raise ValueError(f"contributes.commands[{index}].run.view {run.view!r} is not a declared view")
            if isinstance(run, ManifestV2CommandMethodRun) and run.method not in methods:
                raise ValueError(f"contributes.commands[{index}].run.method {run.method!r} is not in backend.methods")

    @property
    def namespace(self) -> str:
        return self.id.split(".", 1)[0]

    @property
    def extension_name(self) -> str:
        return self.id.split(".", 1)[1]
