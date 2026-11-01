"""Structural tests for the per-vendor registry.

These are the CI guardrails of the one-file-per-vendor refactor:

* drift — the registry's key set must stay in lockstep with every other
  place a vendor list exists (install detection, log readers, frontend
  specs), so "added a vendor but forgot a spot" fails here instead of
  surfacing at runtime;
* import graph — vendor modules must stay self-contained (no vendor→vendor
  or vendor→app edges), which is what keeps "add a vendor" a one-file PR.
"""

from __future__ import annotations

import ast
import inspect
import re
import sys
from pathlib import Path

from agent_team_backend.cli_vendors import registry
from agent_team_backend.cli_vendors.base import VendorSpec

REPO_ROOT = Path(__file__).resolve().parents[2]
VENDORS_DIR = REPO_ROOT / "backend" / "agent_team_backend" / "cli_vendors"
FRONTEND_AGENTS_DIR = (
    REPO_ROOT / "src" / "renderer" / "src" / "platform" / "plugin-shell" / "agents"
)
CLI_AGENTS_HELP = (
    REPO_ROOT / "src" / "renderer" / "src" / "components" / "CliAgentsHelp.vue"
)

EXPECTED_KEYS = {
    "aider", "antigravity", "claude", "codex", "copilot", "cursor",
    "droid", "goose", "grok", "kilo", "kimi", "mcode", "muse", "opencode", "pi",
    "qwen",
}

# DEPS entries that are infrastructure, not CLI vendors.
NON_VENDOR_DEPS = {"homebrew", "node", "ollama", "pnpm", "python", "uv"}

# Frontend-only pane type, not a CLI vendor.
NON_VENDOR_AGENT_KEYS = {"terminal"}

# Modules a vendor file may import. log_readers.base is the shared reader
# contract (safe direction: it imports no vendor); kilo→opencode is the
# single allowed vendor→vendor edge (reader class inheritance).
# `osplat` is a leaf (it imports nothing vendor-side), so reaching the
# platform seam from a vendor cannot form a cycle.
ALLOWED_LOCAL_IMPORTS = {
    "base", "_protocols", "applog", "log_readers.base", "osplat", "skills_store",
    "usage_common",
}
VENDOR_IMPORT_EXEMPTIONS = {"kilo": {"opencode"}}
# psutil is a leaf (codex reads CODEX_HOME off running processes to keep a
# live pane home out of the startup sweep).
ALLOWED_THIRD_PARTY = {"httpx", "psutil", "yaml"}


def test_registry_matches_expected_vendor_set() -> None:
    assert set(registry.VENDORS) == EXPECTED_KEYS
    for key, spec in registry.VENDORS.items():
        assert isinstance(spec, VendorSpec)
        assert spec.key == key
        assert spec.label


def test_registry_matches_install_detection_deps() -> None:
    from agent_team_backend.onboarding_deps import DEPS

    dep_ids = {dep.id for dep in DEPS}
    assert set(registry.VENDORS) <= dep_ids
    assert dep_ids - set(registry.VENDORS) == NON_VENDOR_DEPS


def test_registry_matches_log_reader_package() -> None:
    reader_modules = {
        path.stem
        for path in (VENDORS_DIR.parent / "log_readers").glob("*.py")
        if not path.stem.startswith("_")
        and path.stem not in {"base", "watcher", "attribution"}
    }
    assert reader_modules == set(registry.VENDORS)


def test_registry_matches_frontend_agent_specs() -> None:
    # Read-only regex over the frontend source: the backend must not import
    # or execute TS, but the two sides must never disagree about who exists.
    # Canonical location since stage 2: one spec file per vendor under
    # src/renderer/src/platform/plugin-shell/agents/ (underscore files are templates, not specs).
    frontend_keys: set[str] = set()
    for path in FRONTEND_AGENTS_DIR.glob("*.ts"):
        if path.stem.startswith("_") or path.stem in {"index", "types"}:
            continue
        source = path.read_text(encoding="utf-8")
        frontend_keys |= set(re.findall(r"agentKey: '([a-z]+)'", source))
    assert frontend_keys - NON_VENDOR_AGENT_KEYS == set(registry.VENDORS)


# The supported-CLI sentence of each README: (file, the sentence's count and
# list, the list separator). The names are display names, which no code maps
# to vendor keys, so the guard checks the count and the list's length.
_README_VENDOR_LINES = (
    ("README.md", r"run any of (\d+) supported coding CLIs — (.+?) — or a plain terminal", ", "),
    ("README.zh-TW.md", r"執行 (\d+) 種支援的 coding CLI（(.+?)）", "、"),
    ("README.ja-JP.md", r"対応する (\d+) 種類のコーディング CLI（(.+?)）", "、"),
)


def test_readmes_list_every_registered_vendor() -> None:
    for name, pattern, separator in _README_VENDOR_LINES:
        match = re.search(pattern, (REPO_ROOT / name).read_text(encoding="utf-8"))
        assert match, f"{name}: the supported-CLI sentence is gone or reworded"
        listed = match.group(2).split(separator)
        assert int(match.group(1)) == len(listed) == len(registry.VENDORS), (
            f"{name} says {match.group(1)} and lists {len(listed)} CLIs; "
            f"the registry has {len(registry.VENDORS)}"
        )


# --- turn-end inference cross-check ----------------------------------------
#
# Why this test lives on the backend side: the fact being checked is a
# property of the reader implementation (does parse_activity synthesize the
# turn boundary from a quiet timer?), and only pytest can resolve that fact
# honestly — it imports the reader classes, so an inherited parse_activity
# (kilo reuses opencode's) is attributed to the module that really defines
# it instead of to the empty subclass file. Reading the frontend flag from
# here is just a regex over four `.ts` files, which this module already does
# for the vendor key set. The mirror-image test in vitest would have to fake
# Python inheritance by hand.
#
# Known fragility: the backend fact is derived from a NAME, so renaming the
# constant makes every silence-inferring vendor look like a record-reading
# one. The failure message says so; keep the pattern below in sync with the
# readers.
_IDLE_CONST_RE = re.compile(r"_TURN_IDLE_[A-Z_]+")
_FRONTEND_FLAG_RE = re.compile(
    r"^[ \t]*turnEndInferredFromSilence:\s*true", re.MULTILINE
)


def _reader_sources() -> dict[str, str]:
    """vendor key -> the vendor module that really defines its parse_activity.

    Resolved through the class, not the filename, so an inherited reader is
    attributed to the module holding the code (kilo reuses opencode's
    parse_activity, and kilo.py itself contains no turn logic at all).
    """
    sources: dict[str, str] = {}
    for key, spec in registry.VENDORS.items():
        # Reader-less vendors have no parse_activity to attribute. This runs
        # only while the caller is already building a failure message, so an
        # assert here would replace that message with its own.
        if spec.make_log_reader is None:
            continue
        parse_activity = type(spec.make_log_reader()).parse_activity
        sources[key] = parse_activity.__module__.rsplit(".", 1)[-1]
    return sources


def _backend_infers_turn_end_from_silence() -> set[str]:
    """Vendors whose reader closes a turn on a quiet timer, from the source.

    The signal is a module-level `_TURN_IDLE_*` constant referenced inside
    the `parse_activity` the vendor's reader actually resolves to.
    """
    inferring: set[str] = set()
    for key, spec in registry.VENDORS.items():
        # A vendor may ship no reader at all (docs/adding-a-cli-vendor.md
        # allows an empty log_readers placeholder); it cannot infer a turn end
        # from silence when it reads nothing.
        if spec.make_log_reader is None:
            continue
        parse_activity = type(spec.make_log_reader()).parse_activity
        module = sys.modules[parse_activity.__module__]
        declared = {n for n in vars(module) if _IDLE_CONST_RE.fullmatch(n)}
        used = set(_IDLE_CONST_RE.findall(inspect.getsource(parse_activity)))
        if declared & used:
            inferring.add(key)
    return inferring


def _frontend_infers_turn_end_from_silence() -> set[str]:
    """Vendors whose frontend spec sets `turnEndInferredFromSilence: true`."""
    flagged: set[str] = set()
    for path in FRONTEND_AGENTS_DIR.glob("*.ts"):
        if path.stem.startswith("_") or path.stem in {"index", "types"}:
            continue
        source = path.read_text(encoding="utf-8")
        if not _FRONTEND_FLAG_RE.search(source):
            continue
        keys = set(re.findall(r"agentKey: '([a-z]+)'", source))
        assert len(keys) == 1, f"{path.name} declares agentKeys {sorted(keys)}"
        flagged |= keys
    return flagged


def test_turn_end_inference_flag_matches_reader_implementation() -> None:
    """`turnEndInferredFromSilence` must describe what the reader does.

    The flag is not documentation: `isTurnInFlight` uses it to open a
    20-second silence escape hatch, so a vendor flagged by mistake has its
    panes declared idle mid-tool-call and gets a message injected into a
    running turn; a vendor missing the flag stalls forever on inter-CLI
    messages. Commit 3b6f1d02 drifted exactly this way — cursor's reader
    started reporting real turn ends from store.db while the frontend flag
    stayed `true` — and nothing failed.
    """
    backend = _backend_infers_turn_end_from_silence()
    frontend = _frontend_infers_turn_end_from_silence()
    if backend == frontend:
        return

    sources = _reader_sources()
    hint = (
        "If a reader was renamed away from the `_TURN_IDLE_*` convention, "
        "this test's detection rule (_IDLE_CONST_RE in "
        "backend/tests/test_cli_vendors_registry.py) is what needs updating, "
        "not the vendors."
    )
    problems = []
    for key in sorted(backend - frontend):
        problems.append(
            f"  {key}: backend cli_vendors/{sources[key]}.py infers the turn "
            f"end from a _TURN_IDLE_* quiet timer, but "
            f"src/renderer/src/platform/plugin-shell/agents/{key}.ts does not set "
            f"`turnEndInferredFromSilence: true`. FIX THE FRONTEND: add the "
            f"flag — without it, messaging waits for a turn end that only a "
            f"timer will ever produce."
        )
    for key in sorted(frontend - backend):
        problems.append(
            f"  {key}: src/renderer/src/platform/plugin-shell/agents/{key}.ts sets "
            f"`turnEndInferredFromSilence: true`, but the reader in "
            f"cli_vendors/{sources[key]}.py reports a real turn-end record "
            f"(no _TURN_IDLE_* timer in the parse_activity it resolves to). "
            f"FIX THE FRONTEND: remove the flag — leaving it on makes "
            f"isTurnInFlight() call a busy pane idle after TURN_SILENCE_MS "
            f"and inject into a running turn."
        )
    raise AssertionError(
        "turn-end inference drifted between the reader implementation and the "
        "frontend agent spec:\n" + "\n".join(problems) + f"\n\n{hint}"
    )


def test_mcp_wiring_declares_exactly_one_surface() -> None:
    """A spawn dispatches on which surface field is set, so a spec with two
    would silently take the first branch and a spec with none would no-op —
    both of which look like "this CLI has no MCP" at runtime."""
    for key, spec in registry.VENDORS.items():
        wiring = spec.mcp_wiring
        if wiring is None:
            continue  # the CLI has no MCP surface at all
        surfaces = [
            name
            for name in ("flag", "config_env", "project_config", "config_file")
            if getattr(wiring, name)
        ]
        assert len(surfaces) == 1, (
            f"{key} declares MCP surfaces {surfaces} — exactly one is dispatched"
        )
        # Every surface but codex's TOML override carries a config document.
        if not wiring.flag_value:
            assert wiring.config is not None, f"{key} has no config vocabulary"
        # A project file is shared by every pane, so its URL can only be a
        # reference to a variable the spawn env carries.
        assert bool(wiring.url_env_template) == bool(wiring.project_config)


def test_push_channel_declares_exactly_one_mechanism() -> None:
    """Push delivery dispatches on which mechanism field is set, so a spec with
    two would silently take the first branch and a spec with none would leave
    the pane registered with a channel that can never carry anything."""
    for key, spec in registry.VENDORS.items():
        channel = spec.push_channel
        if channel is None:
            continue  # the CLI has no way in but its PTY
        mechanisms = [
            name
            for name in ("append_path", "input_file_flag", "hook_wait")
            if getattr(channel, name)
        ]
        assert len(mechanisms) == 1, (
            f"{key} declares push mechanisms {mechanisms} — exactly one is dispatched"
        )
        if channel.append_path:
            # A composer that can be appended to has to be submittable, and a
            # failed submit has to be undoable or the fallback types it twice.
            assert channel.submit_path and channel.clear_path, key
            assert channel.port_flag, f"{key} serves HTTP but pins no port"
            # A password nothing authenticates with locks the CLI out of its own
            # server (opencode), so the two travel together or not at all.
            assert bool(channel.password_env) == bool(channel.username), key
        if channel.input_file_flag:
            assert channel.record_type, f"{key} writes records with no type"


def test_push_channel_matches_the_frontend_agent_spec() -> None:
    """The two sides declare different halves of one channel: the backend owns
    the transport, the frontend owns which delivery gates still apply. A vendor
    wired on one side only is a channel that is either never used or used
    without its gates."""
    backend = {
        key: (
            "tui-http"
            if spec.push_channel.append_path
            else "input-file"
            if spec.push_channel.input_file_flag
            else "rewake"
        )
        for key, spec in registry.VENDORS.items()
        if spec.push_channel is not None
    }
    frontend: dict[str, str] = {}
    holds: dict[str, bool] = {}
    for path in FRONTEND_AGENTS_DIR.glob("*.ts"):
        if path.stem.startswith("_") or path.stem in {"index", "types"}:
            continue
        source = path.read_text(encoding="utf-8")
        match = re.search(
            r"pushChannel:\s*\{\s*kind:\s*'([a-z-]+)'"
            r"(?:\s*,\s*holdsInputBox:\s*(true|false))?",
            source,
        )
        if match is None:
            continue
        keys = set(re.findall(r"agentKey: '([a-z]+)'", source))
        assert len(keys) == 1, f"{path.name} declares agentKeys {sorted(keys)}"
        key = keys.pop()
        frontend[key] = match.group(1)
        holds[key] = match.group(2) == "true"

    assert backend == frontend, (
        "push channels drifted between cli_vendors/<key>.py and "
        f"src/renderer/src/platform/plugin-shell/agents/<key>.ts: backend={backend} frontend={frontend}"
    )
    for key, spec in registry.VENDORS.items():
        if spec.push_channel is None:
            continue
        assert holds[key] == spec.push_channel.holds_input_box, (
            f"{key}: holdsInputBox disagrees with holds_input_box — the typing "
            f"hold would be applied to a channel that does not need it, or "
            f"skipped for one that does"
        )


def test_help_panel_sign_in_column_matches_login_command_args() -> None:
    """Settings ▸ Help prints, per vendor, the command the Accounts pane's
    sign-in button runs. That table is a hand-maintained mirror, so it can
    quietly start telling users to expect a flow the button never triggers —
    which is precisely what this column exists to prevent. `binary + signIn`
    must therefore reproduce what `_login_spawn_command` actually builds from
    `login_command_args`; an empty `signIn` means the vendor declares none and
    the button launches the CLI unchanged."""
    source = CLI_AGENTS_HELP.read_text(encoding="utf-8")
    rows = re.findall(
        r"\{ name: '[^']+', bin: '([^']+)',[^\n]*?signIn: '([^']*)' \}", source
    )
    assert len(rows) == len(registry.VENDORS), (
        f"{CLI_AGENTS_HELP.name} lists {len(rows)} vendors, the registry has "
        f"{len(registry.VENDORS)} — a vendor was added or removed on one side only"
    )

    # The table is keyed by binary, the registry by vendor key; the frontend
    # agent specs are the only place the two are tied together.
    bin_to_key: dict[str, str] = {}
    for path in FRONTEND_AGENTS_DIR.glob("*.ts"):
        if path.stem.startswith("_") or path.stem in {"index", "types", "terminal"}:
            continue
        spec_source = path.read_text(encoding="utf-8")
        key = re.search(r"agentKey: '([a-z]+)'", spec_source)
        command = re.search(r"defaultCommand: '([^']+)'", spec_source)
        assert key and command, f"{path.name} declares no agentKey/defaultCommand"
        bin_to_key[command.group(1)] = key.group(1)

    help_panel = {}
    for binary, sign_in in rows:
        assert binary in bin_to_key, (
            f"{CLI_AGENTS_HELP.name} lists binary {binary!r}, which no agent "
            f"spec declares as its defaultCommand"
        )
        help_panel[bin_to_key[binary]] = sign_in
    backend = {
        key: (spec.login_command_args or "")
        for key, spec in registry.VENDORS.items()
    }

    assert help_panel == backend, (
        "the sign-in column drifted from login_command_args — Settings ▸ Help "
        "would name a sign-in command the button does not run: "
        f"help={help_panel} backend={backend}"
    )


def test_vendor_modules_import_only_allowed_modules() -> None:
    for path in sorted(VENDORS_DIR.glob("*.py")):
        if path.stem.startswith("_") or path.stem in {"base", "registry"}:
            continue
        allowed_local = (
            ALLOWED_LOCAL_IMPORTS | VENDOR_IMPORT_EXEMPTIONS.get(path.stem, set())
        )
        tree = ast.parse(path.read_text(encoding="utf-8"))
        # Module-level imports only: an import inside a function is a lazy
        # runtime backreference (the pre-existing pattern of the migrated
        # claude machines) and cannot create an import cycle.
        for node in tree.body:
            if isinstance(node, ast.ImportFrom):
                if node.level:  # relative: from .base / ..log_readers.base
                    module = node.module or ""
                    if module == "":  # from . import _protocols, base, ...
                        for alias in node.names:
                            assert alias.name in allowed_local, (
                                f"{path.name} imports .{alias.name} — vendor "
                                f"modules may only import "
                                f"{sorted(allowed_local)} locally"
                            )
                        continue
                    assert module in allowed_local, (
                        f"{path.name} imports .{node.module} — vendor modules "
                        f"may only import {sorted(allowed_local)} locally"
                    )
                else:
                    root = (node.module or "").split(".")[0]
                    _assert_absolute_import_allowed(path.name, root)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    _assert_absolute_import_allowed(
                        path.name, alias.name.split(".")[0]
                    )


def _assert_absolute_import_allowed(filename: str, root: str) -> None:
    import sys

    stdlib = root in sys.stdlib_module_names
    assert stdlib or root in ALLOWED_THIRD_PARTY, (
        f"{filename} imports {root!r} — vendor modules are limited to the "
        f"standard library and {sorted(ALLOWED_THIRD_PARTY)}; app modules "
        "must depend on vendors, never the reverse"
    )


# Function-level local imports in vendor modules that reach outside
# ALLOWED_LOCAL_IMPORTS: the reviewed, pre-existing vendor→app backrefs.
# Keyed by (vendor stem, module, imported name), so one entry covers every
# call site importing that name; the ratchet only lets this set shrink.
# Existing debt, tracked in plan 61b423 n16.
LAZY_BACKREFS: dict[tuple[str, str, str], str] = {
    ("claude", "ws_handlers", "_running_regular_terminals"): (
        "running-pane check before a token refresh probe; debt: see plan "
        "61b423 n16 B/C (vendor reaches into the ws layer)"
    ),
    ("claude", "ai_chat_cli_engine", "resolve_cli_binary"): (
        "binary lookup for the usage/refresh probes; lazy to avoid the cycle "
        "ai_chat_cli_engine → onboarding_deps → cli_vendors.registry"
    ),
    ("claude", "ai_chat_cli_engine", "_terminate_proc_tree"): (
        "kills a timed-out probe; same cycle as resolve_cli_binary; debt: "
        "private name, see plan 61b423 n16 B/C"
    ),
    ("claude", "claude_hooks", "install_hooks"): (
        "spec.install_hooks delegates to the app-side hook installer; "
        "vendor→app edge kept lazy"
    ),
    ("codex", "convenience_wiring", "note"): (
        "records per-pane CODEX_HOME dirs in the convenience ledger; "
        "vendor→app edge kept lazy"
    ),
    ("codex", "convenience_wiring", "gate"): (
        "convenience gate for shared-login promotion; vendor→app edge kept lazy"
    ),
    ("codex", "credential_vault", "_link_target"): (
        "symlink target normalisation; lazy because credential_vault imports "
        "the vendor registry; debt: private name, see plan 61b423 n16 B/C"
    ),
    ("codex", "loopback_connect_proxy", "loopback_connect_proxy"): (
        "Android-only spawn env (proxy URL and CA bundle); lazy so desktop "
        "spawns never start the proxy; vendor→app edge kept lazy"
    ),
    ("copilot", "copilot_hooks", "install_hooks"): (
        "spec.install_hooks delegates to the app-side hook installer; "
        "vendor→app edge kept lazy"
    ),
    ("qwen", "qwen_hooks", "install_hooks"): (
        "spec.install_hooks delegates to the app-side hook installer; "
        "vendor→app edge kept lazy"
    ),
}


def _lazy_local_imports(
    path: Path, allowed_local: set[str]
) -> list[tuple[tuple[str, str, str], int]]:
    """Non-module-level imports of app modules outside ``allowed_local``, as
    ((stem, module, name), line). Absolute ``agent_team_backend.*`` imports
    count as local; any other absolute import must still pass the
    standard-library/third-party rule."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    module_level = {id(node) for node in tree.body}
    found: list[tuple[tuple[str, str, str], int]] = []
    for node in ast.walk(tree):
        if id(node) in module_level:
            continue
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if not node.level:
                root, _, rest = module.partition(".")
                if root != "agent_team_backend":
                    _assert_absolute_import_allowed(path.name, root)
                    continue
                module = rest.removeprefix("cli_vendors.")
            if module == "":  # from .. import osplat
                pairs = [(alias.name, alias.name) for alias in node.names]
            else:
                pairs = [(module, alias.name) for alias in node.names]
            for target, name in pairs:
                if target not in allowed_local:
                    found.append(((path.stem, module or target, name), node.lineno))
        elif isinstance(node, ast.Import):
            for alias in node.names:
                root, _, rest = alias.name.partition(".")
                if root != "agent_team_backend":
                    _assert_absolute_import_allowed(path.name, root)
                    continue
                target = rest.removeprefix("cli_vendors.")
                if target not in allowed_local:
                    found.append(((path.stem, target, ""), node.lineno))
    return found


def test_vendor_modules_add_no_new_function_level_app_imports() -> None:
    """Ratchet on the lazy backrefs the module-level import check tolerates:
    a new function-level import of an app module fails here, and an entry in
    LAZY_BACKREFS whose import is gone must be deleted."""
    seen: set[tuple[str, str, str]] = set()
    unlisted: list[str] = []
    for path in sorted(VENDORS_DIR.glob("*.py")):
        if path.stem.startswith("_") or path.stem in {"base", "registry"}:
            continue
        allowed_local = (
            ALLOWED_LOCAL_IMPORTS | VENDOR_IMPORT_EXEMPTIONS.get(path.stem, set())
        )
        for key, line in _lazy_local_imports(path, allowed_local):
            seen.add(key)
            if key not in LAZY_BACKREFS:
                unlisted.append(
                    f"{path.name}:{line} lazily imports {key[2]} from {key[1]}"
                )
    assert not unlisted, (
        "new function-level app imports in vendor modules — vendors must stay "
        "self-contained; avoid the import (pass it in, or move the code app-"
        "side), or add a reviewed LAZY_BACKREFS entry with its reason:\n"
        + "\n".join(unlisted)
    )
    stale = sorted(set(LAZY_BACKREFS) - seen)
    assert not stale, (
        f"LAZY_BACKREFS entries no longer imported anywhere — delete them: {stale}"
    )


def test_model_capability_matches_the_frontend_agent_spec() -> None:
    """The frontend spec owns the flags because it builds argv; the backend
    mirrors only whether a vendor accepts them, so the MCP tool can refuse a
    request without waiting out the spawn verdict. A vendor wired on one side
    only either refuses a model it would have accepted, or accepts one that
    then reaches a CLI which ignores it — the silent miss the capability
    exists to prevent."""
    frontend_model: set[str] = set()
    frontend_effort: set[str] = set()
    frontend_efforts: dict[str, tuple[str, ...]] = {}
    for path in FRONTEND_AGENTS_DIR.glob("*.ts"):
        if path.stem.startswith("_") or path.stem in {"index", "types"}:
            continue
        source = path.read_text(encoding="utf-8")
        keys = set(re.findall(r"agentKey: '([a-z]+)'", source))
        assert len(keys) == 1, f"{path.name} declares agentKeys {sorted(keys)}"
        key = keys.pop()
        if re.search(r"^\s+modelArgs:", source, re.M):
            frontend_model.add(key)
        if re.search(r"^\s+effortArgs:", source, re.M):
            frontend_effort.add(key)
        listed = re.search(r"^\s+knownEfforts: \[([^\]]*)\]", source, re.M)
        if listed:
            frontend_efforts[key] = tuple(re.findall(r"'([^']+)'", listed.group(1)))

    backend_model = {k for k, s in registry.VENDORS.items() if s.supports_model}
    backend_effort = {k for k, s in registry.VENDORS.items() if s.supports_effort}
    backend_efforts = {
        k: s.known_efforts for k, s in registry.VENDORS.items() if s.known_efforts
    }

    assert backend_model == frontend_model, (
        "model support drifted between cli_vendors/<key>.py and "
        f"agents/<key>.ts: backend={sorted(backend_model)} "
        f"frontend={sorted(frontend_model)}"
    )
    assert backend_effort == frontend_effort, (
        "effort support drifted between cli_vendors/<key>.py and "
        f"agents/<key>.ts: backend={sorted(backend_effort)} "
        f"frontend={sorted(frontend_effort)}"
    )
    assert backend_efforts == frontend_efforts, (
        "effort vocabularies drifted; the MCP tool would reject a value the "
        f"CLI accepts: backend={backend_efforts} frontend={frontend_efforts}"
    )


def test_session_resume_capability_matches_the_frontend_agent_spec() -> None:
    """Same drift guard as the model one, for the capability cli_open_agent's
    `session_id` is refused on.

    The frontend owns the syntax (`resumeArgs` turns an id into the vendor's
    resume command); the backend mirrors only whether an id can be named at
    all. Drift here is silent in the worst direction: a vendor marked
    resumable on the backend but with no `resumeArgs` accepts a session_id,
    then opens a pane on a FRESH conversation — which reads exactly like a
    successful resume until someone reads the transcript.
    """
    frontend_id_resume: set[str] = set()
    for path in FRONTEND_AGENTS_DIR.glob("*.ts"):
        if path.stem.startswith("_") or path.stem in {"index", "types"}:
            continue
        source = path.read_text(encoding="utf-8")
        keys = set(re.findall(r"agentKey: '([a-z]+)'", source))
        assert len(keys) == 1, f"{path.name} declares agentKeys {sorted(keys)}"
        key = keys.pop()
        # resumeArgs takes an id; resumeWithoutId (aider) restores from a file
        # and has no id to be named.
        if re.search(r"^\s+resumeArgs:", source, re.M):
            frontend_id_resume.add(key)

    backend_id_resume = {
        k for k, s in registry.VENDORS.items() if s.supports_session_resume
    }

    assert backend_id_resume == frontend_id_resume, (
        "session-resume support drifted between cli_vendors/<key>.py "
        "(supports_session_resume) and agents/<key>.ts (resumeArgs): "
        f"backend={sorted(backend_id_resume)} frontend={sorted(frontend_id_resume)}"
    )


def test_vendors_without_session_ids() -> None:
    """Asserted rather than left to review, for two different reasons.

    aider is the vendor whose resume takes a chat-history PATH: it has no
    session id concept at all, so cli_open_agent(session_id=...) has nothing
    to name for it and refuses with `no-session-support`.

    mcode DOES have session ids (`--session <id>` on its interactive command),
    but Navide cannot yet learn the id of a session it started, because mcode
    keeps its history in SQLite and no reader has been written against it. Its
    entry here is a missing reader, not a missing concept, and should go away
    when that reader lands.
    """
    assert registry.VENDORS["aider"].supports_session_resume is False
    assert registry.VENDORS["mcode"].supports_session_resume is False
    others = {
        k for k, s in registry.VENDORS.items() if not s.supports_session_resume
    }
    assert others == {"aider", "mcode"}, (
        f"unexpected vendors without session ids: {sorted(others)}"
    )


def test_resumable_vendors_declare_a_resume_command_parser() -> None:
    # Without a parser the shared spawn path cannot claim an explicit id or
    # reap a still-live PTY resuming that same conversation.
    missing = [
        key for key, spec in registry.VENDORS.items()
        if spec.supports_session_resume and spec.resume_id_from_command is None
    ]
    assert missing == []


def test_droid_is_never_given_an_effort_capability() -> None:
    """droid's interactive command — the one Navide spawns — reads `-r` as
    --resume; only `droid exec` reads it as --reasoning-effort. An effort flag
    here would not set the effort, it would try to resume a session named
    after the level. Asserted rather than left to review."""
    droid = registry.VENDORS["droid"]
    assert droid.supports_effort is False
    assert droid.supports_model is False
    assert droid.known_efforts == ()


def test_effort_vocabulary_requires_effort_support() -> None:
    """known_efforts is only read once supports_effort is true, so a vendor
    carrying the list alone would validate values it then discards."""
    for key, spec in registry.VENDORS.items():
        if spec.known_efforts:
            assert spec.supports_effort, f"{key} lists efforts but takes none"
