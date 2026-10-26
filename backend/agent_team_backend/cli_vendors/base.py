"""Per-vendor CLI knowledge — the one-file-per-vendor contract.

Every piece of code that concerns exactly one CLI vendor (usage reading,
credential file layout, resume-id parsing, session lookup, env vars, log
reader, attribution quirks) lives in that vendor's module in this package.
Shared modules are allowed to contain orchestration only — no per-vendor
branches; multi-vendor wire protocols live in ``_protocols.py``.

Migration model (strangler fig): every capability field below defaults to
``None``, meaning "not migrated yet". Dispatch sites consult the registry
first and fall back to their legacy branch when the field is ``None``, so an
empty spec changes nothing. A vendor's round moves its knowledge here and
deletes the legacy branch; the final cleanup round removes the bridges.

Vendor modules may import only this module, ``_protocols``, the standard
library, and httpx (enforced by ``test_cli_vendors_registry.py``); the single
exception is kilo importing opencode's reader class (inheritance, not logic
sprawl). In particular a vendor module must never import app/ws/vault
modules — those import the registry, and a back-edge would be a cycle.
"""

from __future__ import annotations

import json
import shlex
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable

# Vendor modules may import `base` but not the application, so the platform
# seam is re-exported here: a vendor that needs to find another product's
# state directory asks for the convention rather than spelling out one
# platform's layout (which is how the Cursor reader ended up macOS-only).
from ..osplat import paths as platform_paths  # noqa: F401
from ..osplat import platform_id as _platform_id


def command_text(command: Any) -> str:
    """Actual CLI command string from a terminal.create payload.

    The frontend wraps agent commands as [shell, '-ilc'|'-lc', '<cmd>'] — the
    real command is the LAST element. Plain strings pass through unchanged.
    Shared helper for every vendor's ``resume_id_from_command``.
    """
    if isinstance(command, list):
        return str(command[-1]) if command else ""
    return str(command or "")


def simple_command_args(command: Any) -> list[str]:
    """Parse a literal CLI invocation for destructive resume deduplication.

    Unlike command_text, only unwrap known shell command argv. Complex shell
    overrides remain unclaimed rather than guessing which process they start.
    """
    if isinstance(command, list):
        if len(command) < 3:
            return []
        shell = str(command[0]).replace("\\", "/").rsplit("/", 1)[-1].lower()
        flags = tuple(str(arg) for arg in command[1:-1])
        posix = shell in {"sh", "bash", "zsh", "dash", "ksh", "fish"} and flags in {
            ("-c",), ("-lc",), ("-ilc",),
        }
        windows_flags = tuple(arg.lower() for arg in flags)
        windows = shell in {"cmd", "cmd.exe"} and windows_flags in {
            ("/c",), ("/k",), ("/d", "/s", "/c"), ("/d", "/c"),
        }
        powershell = shell in {"powershell", "powershell.exe", "pwsh", "pwsh.exe"} and windows_flags in {
            ("-command",), ("-nologo", "-noexit", "-command"),
        }
        if not (posix or windows or powershell):
            return []
    text = command_text(command)
    if any(char in text for char in ";&|<>`$%#()\n\r"):
        return []
    try:
        return shlex.split(text)
    except ValueError:
        return []


@dataclass(frozen=True)
class PlatformInstall:
    """How one platform installs a dep, when the default command does not apply.

    A separate record rather than a bare string because the three things that
    vary travel together: `brew install uv` needs Homebrew and runs silently,
    while the same tool on Linux is an official curl installer that needs
    `curl`, and Ollama's Linux installer additionally calls sudo and therefore
    has to be handed to a real terminal. Splitting them into parallel dicts
    would let a command and its requirements drift apart.
    """

    command: str
    requires_binaries: tuple[str, ...] = ()
    needs_terminal: bool = False


@dataclass(frozen=True)
class Dep:
    """One install-wizard dependency: how to detect a tool and (where safe)
    how to install/update it. Vendor modules declare their own entry via
    ``VendorSpec.install_dep``; ``onboarding_deps`` aggregates them with the
    non-vendor foundation/analyzer entries and drives the wizard."""

    id: str
    label: str
    description: str
    group: str                       # 'foundation' | 'agent_cli' | 'analyzer'
    check_cmd: list[str]             # e.g. ['node', '--version']
    version_regex: str = r"(\d+\.\d+(?:\.\d+)?)"
    # Other executable names the SAME tool ships as (a vendor rename leaves the
    # old name on older installs). Probed in order only when check_cmd[0] is not
    # on PATH, so a machine carrying the legacy binary is not reported missing.
    alt_commands: tuple[str, ...] = ()
    # Output `check_cmd` must produce for a resolved binary to be THIS tool.
    # Needed only when the name is generic enough for another vendor to ship
    # it: `agent` is Cursor's, but xAI's grok installs ~/.grok/bin/agent as a
    # symlink to itself, and `grok 1.0.34 (...)` satisfies any plain version
    # pattern — so Navide detected grok as Cursor and spawned it as Cursor.
    # '' = the name is unambiguous and no probe is run (every other dep).
    identity_regex: str = ""
    # Output `check_cmd` prints only for the vendor's own CLI, where a
    # same-named one from someone else installs to the same path (grok). A
    # mismatch is reported in the pane's startup probe line, never refused —
    # unlike identity_regex it does not decide which binary is used.
    # '' = no such check.
    official_regex: str = ""
    min_version: str = ""            # '' = any version is fine
    install_cmd: str = ""            # shell command (whitelist); '' = no auto-install
    needs_terminal: bool = False     # interactive (sudo / OAuth) → external Terminal
    optional: bool = False
    docs_url: str = ""
    # Binaries install_cmd itself invokes (brew, npm). Checked before running it
    # so a missing bootstrap tool reports "install brew first" instead of a bare
    # exit 127 — on a fresh Mac every brew-based install used to fail this way.
    requires_binaries: tuple[str, ...] = ()
    # Maintenance — the CLI's OWN official commands. Navide never wraps, parses
    # or replaces them; it only surfaces and runs them. '' = the vendor ships no
    # such command, in which case the UI points at docs_url instead of guessing.
    update_cmd: str = ""             # e.g. 'claude update'
    doctor_cmd: str = ""             # e.g. 'claude doctor'
    npm_package: str = ""            # npm package name when installable via npm
    # Where the CLI itself records the outcome of its own auto-update. Navide
    # only reads what the vendor already wrote to disk.
    update_state_file: str = ""      # relative to a config home, e.g. '.last-update-result.json'
    config_home_env: str = ""        # env var overriding the config home, e.g. 'CLAUDE_CONFIG_DIR'
    config_home_default: str = ""    # default config home relative to $HOME, e.g. '.claude'
    autoupdate_env: str = ""         # vendor's own opt-out env var, e.g. 'DISABLE_AUTOUPDATER'
    # Which platforms this dep exists for at all. Empty = every platform.
    # Homebrew is the reason this field exists: offering "install the macOS
    # package manager" on Linux is not a degraded suggestion, it is a wrong
    # one, and the wizard should not list the row at all.
    platforms: tuple[str, ...] = ()
    # Per-platform install, for tools whose command is not the same everywhere.
    # An entry here wins over `install_cmd`; `install_cmd` itself is for the
    # genuinely cross-platform cases (npm, a vendor's own curl installer).
    # A platform with neither gets no install button and the docs link instead,
    # which is honest — better than naming a package manager that is not there.
    install_cmds: dict[str, PlatformInstall] = field(default_factory=dict)

    def applies_to(self, platform: str) -> bool:
        """Whether this dep is worth showing on `platform` at all."""
        return not self.platforms or platform in self.platforms

    def install_for(self, platform: str) -> PlatformInstall:
        """The install this platform should run. `.command` is '' when none."""
        override = self.install_cmds.get(platform)
        if override is not None:
            return override
        return PlatformInstall(
            self.install_cmd, self.requires_binaries, self.needs_terminal
        )


class McpValue(Enum):
    """What a declarative server record cannot know: the server's identity.

    A vendor module may not import the plugin that serves an MCP endpoint, so
    the record below is a template — these stand in for the values the server's
    owner supplies, and ``mcp_entry`` substitutes them."""

    NAME = "name"
    LABEL = "label"
    URL = "url"


@dataclass(frozen=True)
class McpServerConfig:
    """The vocabulary one CLI reads MCP servers in.

    Verbatim shapes: every CLI names the transport differently (``type: http``,
    a bare ``httpUrl``, ``type: remote``) and rejects the others, so this is
    described rather than normalised.
    """

    # Path to the container holding server records inside the document, e.g.
    # ("mcpServers",). Every level but the last is a plain map.
    section: tuple[str, ...]
    # One record's fields in the order the CLI's own config writes them, with
    # McpValue members standing in for the server's identity.
    entry: tuple[tuple[str, Any], ...]
    # Document-level fields the CLI expects beside the section, e.g. opencode's
    # "$schema". Written only where the document does not have them already.
    document: tuple[tuple[str, Any], ...] = ()
    # Non-empty when the container is a LIST of self-identifying records rather
    # than a map keyed by the server name: the field our record is recognised
    # by, so a previous run's entry is replaced instead of duplicated.
    list_key: str = ""


@dataclass(frozen=True)
class McpWiring:
    """How a pane spawn points this CLI at an MCP server.

    Which fields are set selects the surface, and a CLI offers exactly one:
    ``flag`` (a spawn-time command-line flag), ``config_env`` (a variable
    carrying a whole config document), ``project_config`` (a file in the
    workspace) or ``config_file`` (a file in the CLI's own config directory,
    which the caller has to shim per pane). A CLI with no MCP surface at all
    declares no wiring.

    Declarative by necessity, like ``Dep``: the endpoint belongs to a plugin,
    and a vendor module must not import one.
    """

    config: McpServerConfig | None = None

    # --- spawn-time flag ---
    flag: str = ""
    # The flag's value as a format template over {name} and {url}; empty means
    # the JSON config document itself (codex takes a TOML override instead).
    flag_value: str = ""
    # Substring whose presence in a command means "leave it alone" — already
    # wired by us, or wired by the user and not ours to second-guess. Format
    # template over {flag} and {name}.
    already_wired: str = "{flag}"
    # The flag also accepts a path, so a spawn that cannot use a per-spawn
    # document can be handed a config file instead.
    flag_accepts_path: bool = False
    # How the flag names a config file ("" for a bare path, "@" for copilot's
    # `@path`); None when it takes inline JSON only. A pane's document carries
    # its credential, and argv is readable by every account through `ps`, so
    # a CLI that can read a file is handed a 0600 one instead.
    flag_file_prefix: str | None = None
    # A second override naming the environment variable the CLI reads its
    # bearer credential from, as a format template over {name} and {env} —
    # for a CLI whose flag carries a URL rather than a document (codex).
    flag_token_env_value: str = ""

    # --- whole config document in an environment variable ---
    config_env: str = ""

    # --- config file in the workspace, relative to the pane's cwd ---
    project_config: tuple[str, ...] = ()
    # The CLI interpolates an environment variable inside the URL, in this
    # syntax (%s = the variable name). A project file is shared by every pane
    # in the workspace, so only a variable can carry a per-pane URL.
    url_env_template: str = ""

    # --- config file in the CLI's own config directory ---
    config_dir: str = ""               # relative to the real home, e.g. ".grok"
    config_dir_env: str = ""           # variable relocating it; "" = the CLI has none
    config_file: tuple[str, ...] = ()  # relative to config_dir


@dataclass(frozen=True)
class SkillsWiring:
    """How a pane spawn points this CLI at a directory of managed skills.

    A CLI offers exactly one surface: ``flag`` (a repeatable command-line
    flag) or ``config_env`` (a variable carrying a whole config document). A
    CLI with no skills mechanism at all declares no wiring, which is what the
    UI reads to mark it unavailable rather than merely switched off.

    Declarative like ``McpWiring``: the skills library belongs to a plugin,
    and a vendor module must not import one.
    """

    # --- repeatable spawn-time flag ---
    flag: str = ""
    # What one occurrence of the flag takes: the directory holding every skill
    # ("root"), or a single skill's own directory, repeated per skill ("each").
    flag_takes: str = "root"
    # The flag suppresses the CLI's own discovery, so whatever it would have
    # found has to be passed back alongside ours or the user silently loses
    # their own skills.
    replaces_discovery: bool = False
    # Discovery roots to re-add when ``replaces_discovery``: paths under the
    # user's home, then paths under the pane's working directory. Only the
    # ones that exist are passed.
    discovery_home: tuple[tuple[str, ...], ...] = ()
    discovery_project: tuple[tuple[str, ...], ...] = ()

    # --- whole config document in an environment variable ---
    config_env: str = ""
    # Where the list of skill roots lives inside that document.
    config_paths_key: tuple[str, ...] = ()

    # --- a directory the CLI reads out of its own config home ---
    # The variable relocating that home. "HOME" is accepted but is a blunt
    # instrument: the shim mirrors the real home so the pane still sees
    # everything else the user has.
    root_env: str = ""
    # Where the real root sits under the user's home; () means the home itself.
    root_home: tuple[str, ...] = ()
    # The skills directory relative to that root.
    skills_rel: tuple[str, ...] = ()
    # Existing pane homes directly under this user-home-relative directory
    # belong to the vendor's home manager. Reconcile their skills subtree
    # only; importing sibling entries would share otherwise isolated state.
    isolated_panes_home: tuple[str, ...] = ()

    # --- a directory the CLI reads out of the workspace ---
    # Last resort for a CLI with no relocation variable: the path is inside the
    # user's own repository, so only our own entries may ever be written or
    # removed there.
    project_rel: tuple[str, ...] = ()

    # The CLI already discovers ``~/.agents/skills`` on its own. A skill in
    # the shared library reaches it with no delivery at all — and, just as
    # importantly, cannot be withheld from it without touching the user's
    # directory. The UI shows those cells as "automatic", not as a switch.
    reads_shared_root: bool = False

    # Layout the view directory must have for this CLI to find skills below
    # the path we hand it; empty means the skills sit directly in the view.
    view_layout: tuple[str, ...] = ()
    # Substring whose presence in a command means the spawn is already wired.
    already_wired: str = ""


def mcp_entry(
    config: McpServerConfig, *, name: str, label: str, url: str
) -> dict[str, Any]:
    """One server record in ``config``'s vocabulary, placeholders resolved."""
    supplied = {McpValue.NAME: name, McpValue.LABEL: label, McpValue.URL: url}
    return {
        key: (supplied[value] if isinstance(value, McpValue) else value)
        for key, value in config.entry
    }


def mcp_document(
    config: McpServerConfig,
    existing: dict[str, Any],
    *,
    name: str,
    label: str = "",
    url: str,
    drop: Sequence[str] = (),
) -> dict[str, Any]:
    """``existing`` with this server's record merged in.

    Pure data in, data out: the caller owns the file (or the flag value, or the
    variable) and the server's identity. An ``existing`` of ``{}`` builds the
    document from scratch. Anything already in the container that is not ours
    is kept — a user's own servers are never displaced.

    ``drop`` names records this server used to be called, so a rename does not
    leave the old entry behind pointing at the same live endpoint: the CLI
    would load both and every tool would appear twice.
    """
    document = dict(existing)
    for key, value in config.document:
        document.setdefault(key, value)
    node = document
    for step in config.section[:-1]:
        child = node.get(step)
        child = dict(child) if isinstance(child, dict) else {}
        node[step] = child
        node = child
    leaf = config.section[-1]
    record = mcp_entry(config, name=name, label=label, url=url)
    # Only the former names are filtered out; an entry already under the
    # current name is overwritten in place, so a rewrite does not reshuffle
    # the keys of a file the user also edits.
    stale = set(drop)
    if config.list_key:
        items = node.get(leaf)
        ours = record.get(config.list_key)
        kept = [
            item
            for item in (items if isinstance(items, list) else [])
            if isinstance(item, dict)
            and item.get(config.list_key) != ours
            and item.get(config.list_key) not in drop
        ]
        kept.append(record)
        node[leaf] = kept
    else:
        servers = node.get(leaf)
        servers = servers if isinstance(servers, dict) else {}
        node[leaf] = {
            **{key: value for key, value in servers.items() if key not in stale},
            name: record,
        }
    return document


@dataclass(frozen=True)
class ExtensionsSource:
    """One place a CLI keeps the extensions it installed for itself.

    ``reader`` names a reader in ``cli_extensions`` (the per-format part lives
    there, not in the vendor module, the same split as ``McpWiring``). Paths
    are relative to the user's real home. Read-only by construction: a reader
    either parses files or runs ``list_argv``, a listing command declared here.
    """

    #: ``plugins-json`` | ``plugin-dirs`` | ``codex-config`` | ``hooks`` |
    #: ``hooks-dir`` | ``code-files`` | ``npm-list`` | ``qwen-extensions`` |
    #: ``cli-json``.
    reader: str
    relative: tuple[str, ...] = ()
    #: The vendor's own name for what is found here, shown untranslated
    #: ("Claude plugin", "Pi extension"); see docs/en-US/glossary.md.
    type_label: str = ""
    #: A settings document whose ``enabledPlugins`` map says what is on.
    settings: tuple[str, ...] = ()
    #: Where the records sit inside a structured document (``hooks``,
    #: ``plugin``, ``packages``).
    section: tuple[str, ...] = ()
    #: How many directory levels below ``relative`` a plugin directory sits
    #: (``cache/<marketplace>/<name>`` is 2).
    depth: int = 0
    #: A read-only listing command (``cli-json``): the binary name, then args.
    list_argv: tuple[str, ...] = ()
    #: What the CLI itself asks before running what is found here: ``none``,
    #: ``hook-trust``, ``capability-approve`` or ``hot-reload``.
    native_consent: str = "none"
    #: The vendor's name for a plugin that carries a function-hook module
    #: (Claude's "Claude mod"); empty when the CLI has no such thing.
    mod_label: str = ""


@dataclass(frozen=True)
class ExtensionsSpec:
    """Where a CLI keeps its own extensions, for the read-only inventory.

    None on a vendor means the CLI has no extension system to show (aider).
    ``supported=False`` means it has one but where it lives has not been
    verified, so the page says so instead of guessing.
    """

    sources: tuple[ExtensionsSource, ...] = ()
    supported: bool = True
    note: str = ""


@dataclass(frozen=True)
class PushChannel:
    """How an external process hands this CLI a new instruction without typing
    it into the pane's PTY.

    Which fields are set selects the mechanism, and a CLI offers exactly one:
    ``append_path`` (an HTTP server the CLI's own TUI is a client of),
    ``input_file_flag`` (a file the CLI watches for JSONL commands), or
    ``hook_wait`` (a background hook the CLI runs, parked on this backend until
    there is something to say). A CLI with no such surface declares none and
    every message to it is typed into its input box exactly as before.

    Declarative like ``McpWiring``: the transport is shared orchestration
    (``push_delivery``), and a vendor module must not import it.
    """

    #: The push writes the CLI's composer, so the message occupies the input
    #: box exactly as typing it would and the typing hold still has to protect
    #: a half-written line. False = the text never reaches the composer, and
    #: only the CLI-side gates (mid-turn, settling) apply.
    holds_input_box: bool = True

    # --- an HTTP server the CLI's own TUI drives itself ---
    port_flag: str = ""              # spawn flag taking a per-pane free port
    host_flag: str = ""              # spawn flag taking the bind address
    host: str = "127.0.0.1"
    append_path: str = ""            # POST {"text": …} — appends to the composer
    submit_path: str = ""            # POST — submits whatever the composer holds
    clear_path: str = ""             # POST — empties the composer (compensation)
    #: Variable carrying a per-pane basic-auth password. Empty means the CLI's
    #: own TUI cannot authenticate against its own server, so the port has to
    #: be left open on the loopback interface (verified for opencode 1.15.12:
    #: setting the password makes its TUI 401 against itself and exit).
    password_env: str = ""
    #: Basic-auth user that password belongs to; ignored without password_env.
    username: str = ""

    # --- a JSONL file the CLI watches ---
    input_file_flag: str = ""        # spawn flag taking the file path
    input_file_suffix: str = ".jsonl"
    #: One record's shape. The CLI reads whole lines only, so a record is
    #: written with a trailing newline; and the file is append-only for the
    #: life of the pane, because a watcher that sees it shrink re-reads it from
    #: the start and would replay every message in it.
    record_type_key: str = "type"
    record_type: str = ""
    record_text_key: str = "text"

    # --- a hook parked on this backend ---
    #: The channel is armed out of band (by a hook the CLI runs) rather than at
    #: spawn, so a pane has it only while a waiter is actually parked.
    hook_wait: bool = False

    # --- what the channel does to the text ---
    #: Prefix added to the envelope on this channel only. For a channel that
    #: arrives as something other than a user message — claude's rewake shows it
    #: as a system reminder — the message has to say what it is, or the agent
    #: reads it as a note about its own run rather than as work handed to it.
    reminder_prefix: str = ""
    #: Longest text this channel carries, 0 for no limit of its own. Past it the
    #: message is not pushed at all: a channel that truncates would hand the
    #: agent half an instruction, where the PTY carries the whole thing.
    max_chars: int = 0


@dataclass(frozen=True)
class ShutdownSpec:
    """How a kill should treat this CLI on its way out.

    The shared kill path is SIGKILL-first for almost every caller (the
    frontend defaults ``force`` to true), which is correct for a CLI that
    keeps no state outside its transcript. A CLI that runs an exit hook needs
    the other order, and this is where it says so. The defaults spell out the
    current behavior, so a vendor that declares nothing keeps it exactly.
    """

    # Send SIGTERM and wait ``grace_s`` before the existing force logic runs.
    # False = the kill path is untouched for this vendor.
    graceful: bool = False
    # How long the SIGTERM is given. Only read when ``graceful``.
    grace_s: float = 1.0
    # Hold the PTY master open across the grace. Closing it HUPs the child and
    # drops the other end of its stdout, which can cut an exit hook off
    # mid-write; a vendor whose hook touches a file on disk wants this true.
    defer_master_close: bool = False


@dataclass(frozen=True)
class AccountSwitchSpec:
    """How the credential vault swaps this vendor's account, and what the
    switch transaction has to do to the CLI afterwards.

    ``None`` on the spec means "no adapter": the vendor is not offered for
    account switching at all (fail closed). Every value here is metadata the
    backend transaction and the UI read; the file/Keychain mechanics stay in
    the vault, driven by the credential fields on ``VendorSpec`` plus the
    ``extract``/``merge`` pair below for compound stores.
    """

    # Credential-pool id. Two vendors declaring the same string share one
    # switch lock and one impact set. Per-provider stores append the scope at
    # runtime — see ``auth_scope_for`` — so the declared value is the prefix.
    auth_scope: str
    # "hot": a running CLI re-reads the credential per request, so a swap
    # needs no restart. "restart": affected panes must be stopped, swapped
    # and resumed. "manual": the vault can park/restore the credential but the
    # CLI must be relaunched by the user into a new conversation (no resume).
    method: str
    # "file": one whole file is swapped. "compound-file": one provider entry
    # inside a shared document (needs ``extract``/``merge``). "keychain": a
    # macOS generic-password item (``keychain_items``), with ``live_file`` as
    # the non-macOS fallback. "pointer": a config value selecting among logins
    # the CLI already holds (mechanically a compound-file). "env": the
    # credential only ever reaches the CLI through the spawn environment.
    store: str
    # How the layout was established: "live" (a real A -> B -> A round-trip on
    # an installed CLI, recorded against ``verified_version``), "source" (read
    # from the vendor's shipped code or its installed package), "docs"
    # (official documentation only). Anything but "live" has not been
    # exercised on a real account; it is shown as such, and the manual
    # acceptance in the plan is what upgrades it.
    evidence: str
    # The CLI version the evidence came from, as its --version prints it.
    verified_version: str = ""
    # Platforms the adapter is expected to work on: a subset of
    # ("darwin", "linux", "win32"). A platform outside this tuple is
    # unsupported for switching, with the reason in ``todo``.
    platforms: tuple[str, ...] = ("darwin", "linux", "win32")
    # compound-file / pointer only: provider entries a profile may bind to.
    # () = the document is swapped whole. A profile's ``scope`` must be one
    # of these; the vault never accepts an arbitrary client string.
    scopes: tuple[str, ...] = ()
    # compound-file / pointer only: (document text | None, scope) -> the
    # portion belonging to that scope as text, or None when absent.
    extract: Callable[[str | None, str], str | None] | None = None
    # compound-file / pointer only: (document text | None, scope, portion |
    # None) -> the new document text with only that scope's entry replaced
    # (None removes it). Every other provider's value survives; the document
    # is re-serialised, so formatting is the vendor's canonical one, not the
    # original bytes.
    merge: Callable[[str | None, str, str | None], str | None] | None = None
    # compound-file only: (live path, new document text, scope) -> extra
    # (path, text | None) pairs the vault writes right after the live
    # document (None unlinks). For a CLI whose credential is paired with a
    # sidecar the credential alone does not satisfy — mcode's per-namespace
    # ``auth-state.json`` must carry the credential's ``generation`` — the
    # sidecar is DERIVED here from the document just written, never parked.
    companion_writes: Callable[[Path, str | None, str], tuple[tuple[Path, str | None], ...]] | None = None
    # (slot secret text | None) -> epoch seconds the credential expires at,
    # None when the vendor gives no expiry. A validity hint for candidate
    # ranking — never proof the credential works.
    expires_at: Callable[[str | None], float | None] | None = None
    # macOS Keychain items holding the live secret, as (service, account)
    # pairs, in the order they are stored inside the slot payload. Only read
    # when ``store == "keychain"``.
    keychain_items: tuple[tuple[str, str], ...] = ()
    # Environment variables the CLI ranks ABOVE the credential the vault
    # switches (an API key in the pane's environment). When one is present
    # in a pane's launch environment a swap of the file changes nothing for
    # that pane, so ``switch_preflight`` reports it as shadowed instead of
    # letting the transaction swap and wait for a timeout. Names only.
    shadowing_env: tuple[str, ...] = ()
    # Same, but only for panes of ONE provider scope, as (scope, names)
    # pairs: another provider's key in the environment must not block this
    # provider's switch.
    shadowing_env_by_scope: tuple[tuple[str, tuple[str, ...]], ...] = ()
    # Variables the CLI is known (from its source) to accept a credential
    # from, whose precedence over the stored login could NOT be established.
    # Present in a pane's environment, ``switch_preflight`` answers
    # "credential-source-unknown": the swap may or may not reach that pane,
    # and the transaction must not claim either. An empty tuple here means
    # nothing is known — not that nothing overrides.
    uncertain_env: tuple[str, ...] = ()
    uncertain_env_by_scope: tuple[tuple[str, tuple[str, ...]], ...] = ()
    # Every variable through which the CLI takes a credential that outranks
    # the file / Keychain the vault swaps, in precedence order. A pane whose
    # launch environment carries one records ``env-override`` provenance, and
    # the CredentialLaunch helper is told to watch them. Names only.
    credential_env_vars: tuple[str, ...] = ()
    # After a restart, can the conversation continue? "native": the CLI
    # resumes by id. "lossy": a best-effort restore (aider's chat history).
    # "none": the CLI starts a new conversation and the user must be told.
    resume: str = "native"
    # What is still missing for this vendor, in one sentence. "" = complete.
    todo: str = ""


def provider_map_extract(
    document: str | None, scope: str, *, path: tuple[str, ...] = ()
) -> str | None:
    """``extract`` for the common provider-map store: a JSON object keyed by
    provider id (OpenCode's ``auth.json`` and its relatives), optionally
    nested under ``path``. Returns the ``scope`` entry as JSON text, or None
    when the document has no such entry. A malformed document reads as
    empty — that is the vault's fail-closed answer, never a raise."""
    if document is None:
        return None
    try:
        data = json.loads(document)
    except ValueError:
        return None
    for key in path:
        data = data.get(key) if isinstance(data, dict) else None
    entry = data.get(scope) if isinstance(data, dict) else None
    if not isinstance(entry, dict) or not entry:
        return None
    return json.dumps(entry, separators=(",", ":"), sort_keys=True)


def provider_map_merge(
    document: str | None, scope: str, portion: str | None, *, path: tuple[str, ...] = ()
) -> str:
    """``merge`` for the provider-map store: replace (or, with ``portion`` None,
    remove) exactly the ``scope`` entry and carry every other key's value
    through unchanged. The result is re-serialised the way the CLIs write the
    file themselves (``JSON.stringify(_, null, 2)``: two-space indent), so
    key order and whitespace are canonical rather than the original bytes;
    strict JSON only — a document that does not parse as a JSON object is
    refused rather than overwritten, because it is the user's file."""
    if document is None or not document.strip():
        data: Any = {}
    else:
        data = json.loads(document)
    if not isinstance(data, dict):
        raise ValueError("credential document is not a JSON object")
    target = data
    for key in path:
        nested = target.get(key)
        if nested is None:
            nested = target[key] = {}
        elif not isinstance(nested, dict):
            raise ValueError(f"credential document key {key!r} is not an object")
        target = nested
    if portion is None:
        target.pop(scope, None)
    else:
        entry = json.loads(portion)
        if not isinstance(entry, dict):
            raise ValueError("credential portion is not a JSON object")
        target[scope] = entry
    return json.dumps(data, indent=2)


def dotenv_extract(document: str | None, names: Sequence[str]) -> str | None:
    """``extract`` for a ``KEY=VALUE`` file: the first of ``names`` present
    with a non-empty value, as the JSON text ``{"<NAME>": "<value>"}`` so a
    restore puts it back under the same variable. Comments, blank lines and
    ``export`` prefixes are read the way python-dotenv reads them."""
    if document is None:
        return None
    values: dict[str, str] = {}
    for line in document.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        values[key] = value.strip().strip("'\"")
    for name in names:
        value = values.get(name)
        if isinstance(value, str) and value.strip():
            return json.dumps({name: value.strip()}, separators=(",", ":"))
    return None


def dotenv_merge(document: str | None, names: Sequence[str], portion: str | None) -> str:
    """``merge`` for a ``KEY=VALUE`` file: drop every line assigning one of
    ``names``, keep every other line verbatim, and append the portion's
    single ``NAME=value`` line (nothing when ``portion`` is None)."""
    entry = json.loads(portion) if portion is not None else None
    if entry is not None and (
        not isinstance(entry, dict) or len(entry) != 1
        or next(iter(entry)) not in names
        or not isinstance(next(iter(entry.values())), str)
    ):
        raise ValueError(f"credential portion must map exactly one of {list(names)}")
    kept: list[str] = []
    for line in (document or "").splitlines():
        stripped = line.strip()
        key = stripped.partition("=")[0].strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        if "=" in stripped and not stripped.startswith("#") and key in names:
            continue
        kept.append(line)
    if entry:
        (name, value), = entry.items()
        kept.append(f"{name}={value}")
    return "\n".join(kept) + ("\n" if kept else "")


def keychain_payload_items(secret: str | None) -> dict[str, str]:
    """The items inside a slot secret of a ``store == "keychain"`` vendor:
    ``{"<service>|<account>": <item value>}`` as the vault parks them. Empty
    for None, a non-keychain payload or malformed text — never raises, so an
    ``identity_from_secret`` built on it reads garbage as signed out."""
    if secret is None:
        return {}
    try:
        data = json.loads(secret)
    except ValueError:
        return {}
    items = data.get("keychain") if isinstance(data, dict) else None
    if not isinstance(items, dict):
        return {}
    return {k: v for k, v in items.items() if isinstance(k, str) and isinstance(v, str) and v}


def provider_entry_identity(secret: str | None) -> dict:
    """``identity_from_secret`` for a scoped slot of a provider-map store: the
    secret is one entry (``provider_map_extract``). Signed in when it holds a
    usable credential — an ``api``/``api_key`` entry with a key, or an
    ``oauth`` entry with an access or refresh token. No email: these entries
    carry none (an OpenAI entry has an ``accountId``, which is not a person),
    so the accounts UI names the row by the profile name."""
    data = None
    if secret is not None:
        try:
            data = json.loads(secret)
        except ValueError:
            data = None
    if not isinstance(data, dict):
        return {"email": None, "signedIn": False}
    kind = data.get("type")
    if kind in ("api", "api_key"):
        signed_in = isinstance(data.get("key"), str) and bool(data["key"])
    elif kind == "oauth":
        signed_in = any(
            isinstance(data.get(field), str) and data[field]
            for field in ("access", "refresh")
        )
    else:
        signed_in = False
    return {"email": None, "signedIn": signed_in}


def switch_preflight(
    spec: "VendorSpec",
    *,
    env_names: Iterable[str] = (),
    scope: str | None = None,
    platform: str | None = None,
) -> dict:
    """Can the vault's switch reach the credential this pane actually uses?

    Pure and secret-free: ``env_names`` are the NAMES present in the pane's
    launch environment (never values). Returns ``{"ok", "reason",
    "authScope", "method", "shadowedBy"}``; ``reason`` is None when ok, else
    one of "unsupported", "unknown-scope", "platform-unsupported",
    "shadowed-by-env" (a variable the CLI ranks above the stored login) or
    "credential-source-unknown" (a variable the CLI takes a credential from,
    precedence unestablished). Only the variables of the pane's own provider
    scope count for a per-provider store. The transaction calls this before
    touching anything so such a pane is reported rather than swapped and
    left to time out."""
    platform = platform or _platform_id
    switch = spec.account_switch
    if switch is None:
        return {"ok": False, "reason": "unsupported", "authScope": None,
                "method": None, "shadowedBy": []}
    auth_scope = auth_scope_for(spec, scope)
    if auth_scope is None:
        return {"ok": False, "reason": "unknown-scope", "authScope": None,
                "method": switch.method, "shadowedBy": []}
    if platform not in switch.platforms:
        return {"ok": False, "reason": "platform-unsupported", "authScope": auth_scope,
                "method": switch.method, "shadowedBy": []}
    present = set(env_names)
    effective_scope = scope
    if switch.scopes and scope is None and len(switch.scopes) == 1:
        effective_scope = switch.scopes[0]

    def _for_scope(pairs: tuple[tuple[str, tuple[str, ...]], ...]) -> list[str]:
        return [name for s, names in pairs if s == effective_scope for name in names]

    shadowed = [
        name for name in (*switch.shadowing_env, *_for_scope(switch.shadowing_env_by_scope))
        if name in present
    ]
    if shadowed:
        return {"ok": False, "reason": "shadowed-by-env", "authScope": auth_scope,
                "method": switch.method, "shadowedBy": shadowed}
    uncertain = [
        name for name in (*switch.uncertain_env, *_for_scope(switch.uncertain_env_by_scope))
        if name in present
    ]
    if uncertain:
        return {"ok": False, "reason": "credential-source-unknown", "authScope": auth_scope,
                "method": switch.method, "shadowedBy": uncertain}
    return {"ok": True, "reason": None, "authScope": auth_scope,
            "method": switch.method, "shadowedBy": []}


def auth_scope_for(spec: "VendorSpec", scope: str | None = None) -> str | None:
    """The runtime credential-pool id for ``spec`` and a profile's provider
    ``scope``, canonical so one pool never gets two identities:

    * whole-file vendor: the declared ``auth_scope`` (``scope`` ignored);
    * per-provider vendor with one declared scope: always
      ``"<auth_scope>:<that scope>"`` — a profile that predates the field
      (``scope`` None) and one that names it explicitly are the same pool;
    * per-provider vendor with several scopes: ``"<auth_scope>:<scope>"``
      for a declared scope, and None when the scope is missing or unknown —
      the bare prefix must never pass for a known pool.

    The reserved ``__default__`` slot has no profile of its own: in a switch
    it takes the scope of the scoped profile on the other side, so pass that
    profile's scope for both directions of a default <-> scoped switch.
    None also when the vendor has no account-switch adapter."""
    switch = spec.account_switch
    if switch is None:
        return None
    if not switch.scopes:
        return switch.auth_scope
    if scope is None and len(switch.scopes) == 1:
        scope = switch.scopes[0]
    if scope not in switch.scopes:
        return None
    return f"{switch.auth_scope}:{scope}"


@dataclass(frozen=True)
class VendorRuntimeContext:
    """Nonsecret launch snapshot for risk declarations, after pane isolation.

    ``home`` is the effective child home; ``env`` contains only declared
    path values and presence markers for network overrides. Never put the
    full spawn environment here or reconstruct it from the backend process.
    """

    home: Path
    env: Mapping[str, str] = field(repr=False)
    cwd: Path

    def path(self, value: str | Path) -> Path:
        """Make a runtime path absolute without reading or resolving symlinks."""
        path = Path(value)
        if not self.cwd.is_absolute() or not self.home.is_absolute():
            raise ValueError("Risk runtime home and cwd must be absolute")
        return path if path.is_absolute() else self.cwd / path


@dataclass(frozen=True)
class VendorSpec:
    """Everything the shared orchestration knows about one CLI vendor.

    ``key`` and ``label`` are mandatory identity; every other field is a
    capability that is ``None`` until that vendor's migration round fills it.
    Field shapes mirror the legacy structures they replace so rounds are
    mechanical moves, not redesigns.
    """

    key: str
    label: str

    # --- credentials (mirrors credential_vault's four per-agent tables) ---
    # Path parts of the live credential file under the real home,
    # e.g. (".codex", "auth.json").
    live_file: tuple[str, ...] | None = None
    # Resolve a vendor's environment-dependent live credential path from the
    # real home. Unset retains the fixed live_file layout above.
    live_file_resolver: Callable[[Path], Path] | None = None
    # Path-only context reported by this launch after shell startup. The
    # legacy resolver remains for compatibility and upgrade comparison.
    live_file_from_context: Callable[[VendorRuntimeContext], Path] | None = None
    credential_path_env_vars: tuple[str, ...] = ()
    # Filename of the parked copy inside the vendor's slot directory.
    slot_file: str | None = None
    # Path parts of the secret inside an isolated login home; None for
    # vendors whose login home holds no file-readable secret (claude).
    login_home_secret_file: tuple[str, ...] | None = None
    # Path parts of the secret inside a legacy profile home.
    profile_home_secret_file: tuple[str, ...] | None = None

    # Display identity for the accounts UI: (secret) -> {email, signedIn}.
    # None = the vault's legacy per-agent branch (or token-presence default).
    identity_from_secret: Callable[[str | None], dict] | None = None

    # Env var that relocates the CLI's config home for an isolated login
    # pane ({VAR: <login-home>} with no removals). None = the vault's legacy
    # branch (claude adds env removals, grok builds a HOME shim — both stay
    # in the vault by design).
    login_home_env: str | None = None

    # Arguments that turn this CLI's binary into its direct sign-in trigger,
    # e.g. "auth login". A login pane keeps the resolved binary and replaces
    # everything after it with these, so YOLO flags never reach an auth
    # subcommand. Two distinct empty-ish values:
    #   None -> the CLI has no sign-in invocation; leave the command alone.
    #   ""   -> signing in IS the bare binary (grok's TUI prompts on launch),
    #           so the flags are still stripped but nothing is appended.
    login_command_args: str | None = None

    # How the credential vault switches this vendor's account and what the
    # switch transaction must do afterwards. None = no adapter: the vendor is
    # never offered for switching (fail closed), whatever the fields above
    # say. Declared only with evidence — see ``AccountSwitchSpec.evidence``.
    account_switch: AccountSwitchSpec | None = None

    # --- usage quota ---
    # Regex sources (compiled case-insensitively by the switch gate) that
    # identify THIS vendor's own "quota exhausted" text or structured turn
    # detail — never a generic 429 / rate-limit / login / payment message.
    # () = the vendor has no verified text signal, so a text report about it
    # is not evidence. Mirror of the frontend spec's ``quotaExhausted``.
    quota_exhausted_patterns: tuple[str, ...] = ()
    # async (home: Path) -> snapshot dict, same shape usage_service._snapshot
    # produces. None = vendor has no quota interface (aider) or not migrated.
    fetch_usage: Callable[[Path], Any] | None = None
    fetch_usage_from_context: Callable[[VendorRuntimeContext], Any] | None = None

    # --- resume / session ---
    # (command) -> session id the launch command targets, "" when none.
    resume_id_from_command: Callable[[Any], str] | None = None
    # (workspace_path: str, session_id: str) -> the single stable path the
    # resume preflight checks, or None when the vendor has no such path.
    session_path: Callable[[str, str], Path | None] | None = None
    # (workspace_path: str, session_id: str) -> session exists on disk.
    session_exists: Callable[[str, str], bool] | None = None
    # Can a launch NAME the conversation to continue? True for every CLI whose
    # resume takes an id (the frontend spec's `resumeArgs`); False only for one
    # that restores from a file with no id to name — aider, which resumes from
    # a chat-history path instead.
    #
    # Deliberately NOT inferred from `session_exists is None`: a vendor that has
    # not declared its own on-disk check still resumes fine (app._session_exists
    # falls back to a path lookup for it), so reading absence as "cannot resume"
    # would refuse grok and antigravity for a reason that is about this file's
    # migration state rather than about the CLI.
    supports_session_resume: bool = True

    # --- spawn environment ---
    # Vendor-specific defaults added only when neither the request nor the
    # inherited process environment provides the variable.
    spawn_env_defaults: tuple[tuple[str, str], ...] = ()
    # Env var names that relocate this CLI's home/config; the backend strips
    # them from inherited env at startup and from probe spawns.
    home_env_vars: tuple[str, ...] = ()
    # Byte sent to interrupt the CLI in its PTY; None = legacy default (^C).
    interrupt_key: bytes | None = None

    # --- MCP wiring ---
    # How a spawn points this CLI at an MCP server. None covers two different
    # situations, and the distinction matters when someone asks "can this be
    # added?": aider, muse and pi have no MCP surface at all, so there is
    # nothing to point anywhere; droid is simply not wired yet — whether its
    # CLI exposes a way in has not been established either way.
    mcp_wiring: McpWiring | None = None

    # --- skills wiring ---
    # How a spawn points this CLI at the managed skills library. None = the
    # CLI has no skills mechanism (kilo, aider), or Navide has not wired the
    # one it has yet; ``skills_supported`` tells those two apart.
    skills_wiring: SkillsWiring | None = None
    # The CLI has a skills mechanism, verified against the binary or its
    # official docs. False = no such feature exists to wire.
    skills_supported: bool = False

    # --- CLI extensions (read-only inventory) ---
    # Where the CLI keeps the plugins, mods, extensions and hooks it installed
    # for itself. None = no extension system (aider), hidden from the page.
    extensions: ExtensionsSpec | None = None

    # --- model selection (mirrors the frontend AgentSpec) ---
    # Whether a spawn may name the model / reasoning effort for this CLI.
    # The flags themselves live in the frontend spec, which is what builds
    # argv; these exist so the MCP tool can refuse an unsupported request
    # before broadcasting it to a window, rather than waiting out the spawn
    # verdict timeout and then answering with a misleading "no answer from
    # the window that owns your pane".
    supports_model: bool = False
    supports_effort: bool = False
    # Effort values this CLI accepts, mirroring the frontend's knownEfforts.
    # Empty tuple = no closed vocabulary (or no effort support at all).
    known_efforts: tuple[str, ...] = ()

    # --- push delivery ---
    # How an inter-CLI message reaches this CLI without being typed into its
    # input box. None = it has no such surface (or none is wired yet), and
    # every message to it goes through the PTY as before.
    push_channel: PushChannel | None = None

    # --- log reading ---
    # () -> LogReader instance for this vendor. None = reader not migrated
    # (still constructed from log_readers/<key>.py by the legacy list).
    make_log_reader: Callable[[], Any] | None = None

    # --- install wizard (mirrors the legacy onboarding_deps agent_cli table) ---
    # This vendor's install/detect/update entry; onboarding_deps aggregates it.
    install_dep: Dep | None = None
    # The CLI version the integration as a whole (launch, logs, resume) was
    # last checked against, as --version prints it. Set it when that is newer
    # than ``account_switch.verified_version`` (which records only the
    # account-switch evidence), or when the vendor has no account switching.
    # The startup probe discloses a newer installed CLI against this first,
    # then against the account-switch version.
    cli_verified_version: str = ""

    # --- lifecycle hooks ---
    # (backend_port_file: str) -> install result. Set when this CLI can be
    # configured to POST turn/permission events to /hooks/<key>, which is a
    # 100%-reliable signal the PTY cannot provide. Declaring it both installs
    # the hooks at startup and admits the vendor to that endpoint, so a vendor
    # cannot be one without the other. None = no hook mechanism.
    install_hooks: Callable[[str], Any] | None = None

    # --- shutdown ---
    # How a kill treats this CLI. None = the shared kill path runs unchanged,
    # which is what 13 of the 14 vendors want.
    shutdown: ShutdownSpec | None = None

    # --- observational risk signals (backend only) ---
    # Concrete DNS names/IPs for a declared default service profile; no URLs,
    # wildcards or claim of exhaustive CLI/tool traffic. Empty = unsupported.
    # Dispatch through registry.expected_hosts_for_context to honor overrides.
    expected_hosts: tuple[str, ...] = ()
    # Pure resolver for the active pane's absolute data roots. None/empty =
    # unsupported. The observer, not the declaration, owns filesystem access.
    data_dirs: Callable[[VendorRuntimeContext], tuple[Path, ...]] | None = None
    # Only these environment path values may enter the risk context.
    data_dir_env_vars: tuple[str, ...] = ()
    # These values are captured ONLY as presence markers. Any nonempty
    # override disables this vendor's default network profile; it is never
    # interpreted as a trusted endpoint or persisted as a credential URL.
    network_override_env_vars: tuple[str, ...] = ()
