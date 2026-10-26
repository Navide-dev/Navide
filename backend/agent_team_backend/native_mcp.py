"""Read-only reflection of the MCP servers each CLI keeps in its own config.

Users arrive with MCP servers already configured where their CLIs look for
them (``~/.claude.json``, ``~/.codex/config.toml``, ...). Navide's own MCP
settings page used to show only the servers Navide itself connects to as a
client, so a user could not see -- let alone compare -- what their agents
actually load. This module lists those native servers so the page can be a
single entry point for every CLI's MCP.

Like ``native_skills``, it never writes: the module has no write path at all,
by construction. Every call is a fresh scan; nothing is cached on disk. The
CLIs keep owning their own files.

Three rules the scan keeps:

- **Read the user's file, never our own.** Navide delivers its ``/plan-mcp``
  endpoint to a pane through app-owned documents and per-pane shim homes, so
  a real home file never carries it. Any record that does point at
  ``/plan-mcp`` is one of ours and is dropped, not reported as the user's.
- **Secrets stay behind.** Native configs hold API keys in ``env``, in
  ``headers``, inside ``args`` and inside URLs -- both as ``user:pass@`` and
  as a query parameter. Names and hosts cross the boundary so an entry stays
  recognisable; credential-shaped values do not.
- **A broken file is still reported.** A config that will not parse produces
  one invalid record naming the reason, because "nothing here" and "I could
  not read it" are different answers.

Scope is the user-global config of each CLI. Project-scoped MCP (claude's
``.mcp.json``, cursor's ``<workspace>/.cursor/mcp.json``) is deliberately out:
it belongs to a workspace, not to the machine, and the page this feeds is a
user-scope page.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .mcp_settings import REDACTED_SECRET, is_secret_setting_name

log = logging.getLogger("agent_team_backend.native_mcp")

_CONFIG_SIZE_LIMIT = 8_000_000
#: A server name is display-only -- nothing builds a path from it -- so the
#: check rejects what would break the UI (control characters, emptiness,
#: absurd length) and nothing else. An earlier ASCII-only pattern silently
#: dropped names like ``高德地圖``, which made the matrix answer "not
#: configured" about a server that plainly was.
_NAME_BAD_RE = re.compile(r"[\x00-\x1f\x7f]")
_NAME_MAX = 128

#: Credential-shaped names ``is_secret_setting_name`` does not catch because it
#: matches whole tokens: ``APIKEY`` never splits into ``API`` + ``KEY``. Kept
#: local rather than widened in ``mcp_settings`` -- that set also decides what
#: a settings bundle redacts, and this scan must not change that contract.
_EXTRA_SECRET_SUBSTRINGS = (
    "APIKEY",
    "ACCESSKEY",
    "SECRETKEY",
    "PAT",
    "BEARER",
    "SESSION",
    "SIGNATURE",
    "PRIVATE",
)

#: Flags whose *following* argument is the secret, e.g. ``--header`` for
#: mcp-remote, and any ``--api-key``-shaped option.
_SECRET_FLAG_RE = re.compile(
    r"^-{1,2}[A-Za-z0-9-]*(key|token|secret|password|passphrase|auth|header|cookie|credential)s?$",
    re.IGNORECASE,
)
#: The name half of an argument carrying its own secret, e.g. the
#: ``X-Api-Key`` of ``X-Api-Key: abc123``.
_ARG_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
#: Navide's own endpoint. A native file should never hold one; if it does, it
#: is ours and not the user's to be shown.
_OURS_RE = re.compile(r"/plan-mcp\b")
#: Query parameters are named like env vars, so the same secret test applies;
#: this only has to spot that a string *is* a URL worth taking apart.
_URL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")
#: Credentials recognisable by their shape alone, whatever they are named:
#: a ``DATABASE_URL``-style name says nothing, ``ghp_…`` says everything.
_TOKEN_SHAPE_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    r"gh[pousr]_[A-Za-z0-9]{20,}"
    r"|github_pat_[A-Za-z0-9_]{20,}"
    r"|glpat-[A-Za-z0-9_-]{20,}"
    r"|sk-[A-Za-z0-9_-]{20,}"
    r"|[spr]k_(?:live|test)_[A-Za-z0-9]{16,}"
    r"|xox[abposr]-[A-Za-z0-9-]{10,}"
    r"|AKIA[0-9A-Z]{16}"
    r"|AIza[0-9A-Za-z_-]{35}"
    r"|npm_[A-Za-z0-9]{36}"
    r"|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
    r"|[Bb]earer\s+\S{8,}"
    r")"
)


@dataclass(frozen=True)
class NativeMcpSource:
    """One CLI's user-global MCP config file, described well enough to read.

    ``section`` and ``list_key`` mirror the vendor's own ``McpServerConfig``
    where it declares one -- ``test_native_mcp`` asserts they stay equal, so
    the two descriptions cannot drift apart -- and fill the gap for the CLIs
    Navide has no MCP wiring for (codex writes a TOML override rather than a
    document, droid has no wiring at all).
    """

    #: Agent key, as used everywhere else in the backend.
    agent: str
    #: Path to the config file, relative to the user's real home.
    relative: tuple[str, ...]
    #: ``"json"`` (strict), ``"jsonc"`` (comments and trailing commas
    #: tolerated) or ``"toml"``.
    fmt: str
    #: Path to the container of server records inside the document.
    section: tuple[str, ...]
    #: Non-empty when the container is a LIST of self-identifying records
    #: rather than a map keyed by the server name: the field holding the name.
    list_key: str = ""


#: Where each CLI keeps the MCP servers it owns. Verified 2026-08-28 against
#: each installed binary (``--help``/``mcp --help``/strings) or the file the
#: CLI had already written, never against documentation alone. A CLI with two
#: accepted filenames gets one row each; both are read when both exist.
NATIVE_SOURCES: tuple[NativeMcpSource, ...] = (
    NativeMcpSource("claude", (".claude.json",), "json", ("mcpServers",)),
    NativeMcpSource("codex", (".codex", "config.toml"), "toml", ("mcp_servers",)),
    NativeMcpSource("copilot", (".copilot", "mcp-config.json"), "jsonc", ("mcpServers",)),
    NativeMcpSource("qwen", (".qwen", "settings.json"), "jsonc", ("mcpServers",)),
    NativeMcpSource("cursor", (".cursor", "mcp.json"), "jsonc", ("mcpServers",)),
    NativeMcpSource("opencode", (".config", "opencode", "opencode.json"), "jsonc", ("mcp",)),
    NativeMcpSource("opencode", (".config", "opencode", "opencode.jsonc"), "jsonc", ("mcp",)),
    NativeMcpSource("kilo", (".config", "kilo", "kilo.json"), "jsonc", ("mcp",)),
    NativeMcpSource("kilo", (".config", "kilo", "kilo.jsonc"), "jsonc", ("mcp",)),
    NativeMcpSource("kimi", (".kimi-code", "mcp.json"), "jsonc", ("mcpServers",)),
    NativeMcpSource("grok", (".grok", "config.toml"), "toml", ("mcp_servers",)),
    NativeMcpSource(
        "antigravity", (".gemini", "config", "mcp_config.json"), "jsonc", ("mcpServers",)
    ),
    NativeMcpSource("droid", (".factory", "mcp.json"), "jsonc", ("mcpServers",)),
)


def agent_targets() -> list[dict[str, Any]]:
    """Every CLI vendor and what Navide can actually do with its MCP.

    Three states, because "off" and "impossible" must not look alike in the
    UI: ``wired`` (a spawn can carry an MCP endpoint to it), ``planned`` (the
    CLI has MCP -- a native config proves it -- but Navide has no wiring for
    it yet), ``unsupported`` (no MCP mechanism to wire). ``reflects`` says
    whether this scan can read that CLI's own servers, which is a separate
    question from whether Navide can deliver to it. ``blocked`` names why a
    ``wired`` vendor still spawns unwired on *this* machine (a home shim
    without symlink privilege); absent when nothing stands in the way.
    """
    from .cli_vendors.registry import VENDORS
    from .mcp_server import pane_home

    reflected = {source.agent for source in NATIVE_SOURCES}
    agents: list[dict[str, Any]] = []
    for key in sorted(VENDORS):
        spec = VENDORS[key]
        if spec.mcp_wiring is not None:
            state = "wired"
        elif key in reflected:
            state = "planned"
        else:
            state = "unsupported"
        agent: dict[str, Any] = {
            "key": key,
            "label": spec.label,
            "state": state,
            "reflects": key in reflected,
        }
        blocked = pane_home.unavailable_reason(key)
        if blocked is not None:
            agent["blocked"] = blocked
        agents.append(agent)
    return agents


@dataclass(frozen=True)
class NativeMcpServer:
    """One MCP server found in a CLI's own config. Immutable, like the scan."""

    name: str
    #: Agent key whose config this came from.
    agent: str
    #: ``"stdio"``, ``"http"``, ``"sse"`` or ``"unknown"``.
    transport: str
    #: Absolute path of the config file it was read from.
    path: str
    command: str = ""
    args: tuple[str, ...] = ()
    url: str = ""
    #: Names only -- values never leave the backend when they look secret.
    env: tuple[tuple[str, str], ...] = ()
    headers: tuple[tuple[str, str], ...] = ()
    #: What the CLI itself will do with it, as the file says.
    enabled: bool = True
    #: False when the file or the record could not be understood; the record
    #: is still listed so the user sees that something is there.
    valid: bool = True
    error: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "agent": self.agent,
            "transport": self.transport,
            "path": self.path,
            "command": self.command,
            "args": list(self.args),
            "url": self.url,
            "env": dict(self.env),
            "headers": dict(self.headers),
            "enabled": self.enabled,
            "valid": self.valid,
            "error": self.error,
        }


def native_sources(home: Path | None = None) -> list[tuple[NativeMcpSource, Path]]:
    """``(source, file)`` for every native config, existing or not."""
    base = home or _home()
    return [(source, base.joinpath(*source.relative)) for source in NATIVE_SOURCES]


def scan(home: Path | None = None) -> list[NativeMcpServer]:
    """Every native MCP server on this machine, in source order then name."""
    found: list[NativeMcpServer] = []
    for source, path in native_sources(home):
        found.extend(_read_source(source, path))
    return found


def mask_server_row(row: dict[str, Any]) -> dict[str, Any]:
    """Mask the secret-bearing fields of one managed-server row, the same way
    scan() masks a native one. list_servers() hands rows out unmasked because
    the Settings page edits them; anything that shows a row to an agent must
    pass it through here first."""
    masked = copy.deepcopy(row)
    args = masked.get("args")
    if isinstance(args, list):
        masked["args"] = list(_mask_args(tuple(str(arg) for arg in args)))
    url = masked.get("url")
    if isinstance(url, str):
        masked["url"] = _mask_url(url)
    for field_name in ("env", "headers"):
        if isinstance(masked.get(field_name), dict):
            masked[field_name] = dict(_mask_map(masked[field_name]))
    return masked


def _read_source(source: NativeMcpSource, path: Path) -> list[NativeMcpServer]:
    try:
        if not path.is_file():
            return []
        if path.stat().st_size > _CONFIG_SIZE_LIMIT:
            return [_broken(source, path, "config exceeds 8 MB")]
        # utf-8-sig, not utf-8: a config saved with a BOM is healthy, and
        # reporting it as "invalid JSON" would hide every server in it.
        raw = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as err:
        return [_broken(source, path, str(err))]

    try:
        document = _parse(raw, source.fmt)
    except ValueError as err:
        return [_broken(source, path, str(err))]
    if not isinstance(document, dict):
        return [_broken(source, path, "config is not an object")]

    container = _dig(document, source.section)
    if container is None:
        return []
    records = _records(container, source.list_key)
    if records is None:
        return [_broken(source, path, f"{'.'.join(source.section)} is not a server container")]

    servers = [_read_record(source, path, name, record) for name, record in records]
    return [server for server in servers if not _is_ours(server)]


def _records(container: Any, list_key: str) -> list[tuple[str, Any]] | None:
    """``(name, record)`` pairs out of a map- or list-shaped container."""
    if list_key:
        if not isinstance(container, list):
            return None
        pairs: list[tuple[str, Any]] = []
        for item in container:
            if not isinstance(item, dict):
                continue
            name = item.get(list_key)
            if isinstance(name, str) and name:
                pairs.append((name, item))
        return pairs
    if not isinstance(container, dict):
        return None
    return [(name, record) for name, record in container.items() if isinstance(name, str)]


def _read_record(
    source: NativeMcpSource, path: Path, name: str, record: Any
) -> NativeMcpServer:
    base = {
        # Control characters would corrupt the rendered row, so the name shown
        # is always a sanitised one, invalid or not.
        "name": _NAME_BAD_RE.sub("", name)[:_NAME_MAX],
        "agent": source.agent,
        "path": str(path),
    }
    if _NAME_BAD_RE.search(name) or not name.strip():
        return NativeMcpServer(
            **base, transport="unknown", valid=False, error="unreadable server name"
        )
    if not isinstance(record, dict):
        return NativeMcpServer(**base, transport="unknown", valid=False, error="not an object")

    url = _mask_url(_first_string(record, ("url", "httpUrl", "serverUrl", "endpoint")))
    command = _first_string(record, ("command",))
    declared = _first_string(record, ("type", "transport")).lower()

    if declared in {"sse"}:
        transport = "sse"
    elif declared in {"http", "streamable-http", "streamablehttp", "remote"} or url:
        transport = "http"
    elif declared in {"stdio", "local"} or command:
        transport = "stdio"
    else:
        transport = "unknown"

    return NativeMcpServer(
        **base,
        transport=transport,
        command=command,
        args=_mask_args(_string_list(record.get("args"))),
        url=url,
        env=_mask_map(record.get("env")),
        headers=_mask_map(record.get("headers")),
        enabled=_enabled(record),
    )


def _enabled(record: dict[str, Any]) -> bool:
    """What the CLI itself will do with this record.

    Two conventions in the wild: ``enabled: false`` (codex, opencode, grok) and
    the Roo/Cline-descended ``disabled: true`` (kilo). Reading only one of them
    would paint a switched-off server as live.
    """
    enabled = record.get("enabled")
    if isinstance(enabled, bool):
        return enabled
    disabled = record.get("disabled")
    if isinstance(disabled, bool):
        return not disabled
    return True


def _broken(source: NativeMcpSource, path: Path, error: str) -> NativeMcpServer:
    return NativeMcpServer(
        name=path.name,
        agent=source.agent,
        transport="unknown",
        path=str(path),
        valid=False,
        error=error,
    )


def _is_ours(server: NativeMcpServer) -> bool:
    return bool(_OURS_RE.search(server.url))


def _dig(document: dict[str, Any], section: tuple[str, ...]) -> Any:
    node: Any = document
    for key in section:
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node


def _first_string(record: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _string_list(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str))


def _looks_secret(name: str) -> bool:
    """Whether a name suggests its value is a credential.

    ``mcp_settings.is_secret_setting_name`` matches whole tokens, so it misses
    the unseparated spellings people actually type (``APIKEY``, ``GITHUB_PAT``).
    Widening it there would change what a settings bundle exports; widening it
    here only makes this read-only scan hide more.
    """
    if is_secret_setting_name(name):
        return True
    squashed = re.sub(r"[^A-Za-z0-9]+", "", name).upper()
    return any(token in squashed for token in _EXTRA_SECRET_SUBSTRINGS)


def _mask_map(value: Any) -> tuple[tuple[str, str], ...]:
    """Key names kept, secret-looking values replaced by the sentinel.

    A non-string value is rendered rather than dropped: ``PORT: 8080`` shown as
    an empty value reads as "not set", which is a different — and wrong —
    answer from the one the file gives.
    """
    if not isinstance(value, dict):
        return ()
    masked: list[tuple[str, str]] = []
    for key, raw in value.items():
        if not isinstance(key, str):
            continue
        if isinstance(raw, str):
            text = raw
        elif raw is None:
            text = ""
        else:
            text = json.dumps(raw, ensure_ascii=False)
        masked.append((key, REDACTED_SECRET if text and _looks_secret(key) else _mask_value(text)))
    return tuple(masked)


def _mask_value(text: str, placeholder: str = REDACTED_SECRET) -> str:
    """``text`` judged by what it holds rather than what it is called: a
    token-shaped value becomes the sentinel, and any URL in it loses its
    userinfo and secret query parameters (``postgres://u:p@h`` under a
    harmless-looking ``DATABASE_URL``)."""
    if _TOKEN_SHAPE_RE.search(text):
        return placeholder
    return mask_urls_in_text(text, placeholder)


def _mask_url(url: str, placeholder: str = REDACTED_SECRET) -> str:
    """``url`` with credentials in it replaced by *placeholder* (the sentinel;
    sync passes ``""``).

    Two places a URL carries one: the userinfo before ``@`` and a query
    parameter named like a secret. Everything else is kept — the host and path
    are what make the entry recognisable.
    """
    if not url or not _URL_RE.match(url):
        return url
    try:
        parts = urlsplit(url)
        username = parts.username
        password = parts.password
        hostname = parts.hostname or ""
        port = parts.port
    except ValueError:
        return placeholder
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    secret_query = any(value and _looks_secret(key) for key, value in pairs)
    if not (username or password or secret_query):
        # Nothing to mask: kept as written rather than re-assembled.
        return url
    netloc = parts.netloc
    if username or password:
        host = hostname
        if port:
            host = f"{host}:{port}"
        netloc = f"{placeholder}@{host}"
    query = parts.query
    if secret_query:
        query = urlencode(
            [
                (key, placeholder if value and _looks_secret(key) else value)
                for key, value in pairs
            ],
            # Keep the sentinel readable; percent-encoded it reads as data.
            safe="*",
        )
    return urlunsplit((parts.scheme, netloc, parts.path, query, parts.fragment))


_URL_IN_TEXT_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s'\"<>]+")


def mask_urls_in_text(text: str, placeholder: str = REDACTED_SECRET) -> str:
    """``text`` (an error message, say) with every URL in it masked as
    `_mask_url` masks a configured one: userinfo and secret query parameters."""
    return _URL_IN_TEXT_RE.sub(lambda m: _mask_url(m.group(0), placeholder), text)


def _mask_args(args: tuple[str, ...], placeholder: str = REDACTED_SECRET) -> tuple[str, ...]:
    """``args`` with credential-shaped values replaced by *placeholder* (the
    sentinel; sync passes ``""``).

    Two shapes cover what MCP configs really hold: the value *after* a
    secret-named flag (``--header X-Api-Key: abc``) and a single argument
    carrying its own (``--api-key=abc``). The name is kept either way -- what
    a server authenticates with is worth seeing; the credential is not.
    """
    masked: list[str] = []
    take_next = False
    for arg in args:
        if take_next:
            masked.append(_mask_named_value(arg, placeholder) or placeholder)
            take_next = False
            continue
        # A URL argument is the third place a credential hides (mcp-remote is
        # routinely handed ``https://host/mcp?apikey=…``), and it is not a
        # name/value pair, so it needs the URL rule rather than this one.
        if _URL_RE.match(arg):
            masked.append(_mask_url(arg, placeholder))
            continue
        named = _mask_named_value(arg, placeholder)
        if named:
            masked.append(named)
            continue
        masked.append(_mask_value(arg, placeholder))
        take_next = bool(_SECRET_FLAG_RE.match(arg))
    return tuple(masked)


def _mask_named_value(arg: str, placeholder: str = REDACTED_SECRET) -> str:
    """``"name=***"`` when ``arg`` is a secret-named pair, else ``""``."""
    for separator in ("=", ":"):
        name, found, _ = arg.partition(separator)
        if not found or not name or len(name) > 64:
            continue
        if not _ARG_NAME_RE.fullmatch(name):
            continue
        if _SECRET_FLAG_RE.match(name) or _looks_secret(name):
            return f"{name}{separator}{placeholder}"
    return ""


def _parse(raw: str, fmt: str) -> Any:
    if fmt == "toml":
        try:
            return tomllib.loads(raw)
        except tomllib.TOMLDecodeError as err:
            raise ValueError(f"invalid TOML: {err}") from err
    text = _strip_jsonc(raw) if fmt == "jsonc" else raw
    try:
        return json.loads(text)
    except json.JSONDecodeError as err:
        raise ValueError(f"invalid JSON: {err}") from err


def _strip_jsonc(raw: str) -> str:
    """JSON with ``//`` and ``/* */`` comments and trailing commas removed.

    Several CLIs write ``.jsonc`` (opencode, kilo) or leave a comment banner
    in a ``.json`` file (copilot does), so tolerating both costs one pass and
    saves reporting a healthy config as broken.
    """
    out: list[str] = []
    index = 0
    length = len(raw)
    in_string = False
    while index < length:
        char = raw[index]
        if in_string:
            out.append(char)
            if char == "\\" and index + 1 < length:
                out.append(raw[index + 1])
                index += 2
                continue
            if char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            index += 1
            continue
        if char == "/" and index + 1 < length:
            following = raw[index + 1]
            if following == "/":
                index = raw.find("\n", index)
                if index == -1:
                    break
                continue
            if following == "*":
                end = raw.find("*/", index + 2)
                index = length if end == -1 else end + 2
                continue
        out.append(char)
        index += 1
    return _strip_trailing_commas("".join(out))


def _strip_trailing_commas(text: str) -> str:
    out: list[str] = []
    in_string = False
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if in_string:
            out.append(char)
            if char == "\\" and index + 1 < length:
                out.append(text[index + 1])
                index += 2
                continue
            if char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            index += 1
            continue
        if char == ",":
            ahead = index + 1
            while ahead < length and text[ahead].isspace():
                ahead += 1
            if ahead < length and text[ahead] in "}]":
                index += 1
                continue
        out.append(char)
        index += 1
    return "".join(out)


def _home() -> Path:
    """The user's real home, immune to a shimmed ``$HOME``.

    Launching Navide from inside a pane whose HOME is a per-pane shim would
    otherwise make every native config resolve into that shim.
    """
    try:
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except (ImportError, AttributeError, KeyError, OSError):
        return Path.home()
