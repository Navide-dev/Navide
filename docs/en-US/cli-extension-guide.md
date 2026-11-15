# CLI Integration Records

Integration records for Navide's built-in CLI agents: the research behind
each one and the traps found while wiring it.

**To add a new CLI, follow [Adding a CLI vendor](../adding-a-cli-vendor.md)**
rather than this file. That guide tracks the current architecture and the
checks CI enforces; the records in Part 2 here predate it and name files that
have since moved.

Current built-in agent keys are `claude`, `codex`, `antigravity`, `grok`,
`kimi`, `opencode`, `qwen`, `kilo`, `pi`, `copilot`, `cursor`, `aider`,
`muse`, `droid`, `mcode`, `goose`, `devin`, `kiro`, `openclaw`, and `hermes`. One key identifies a vendor on both sides — `agentKey`
in the frontend, `agent_key` in the backend.

The [vendor matrix roster](cli-vendor-matrix.md#roster) lists the current UI
labels. Publisher suffixes are Navide presentation choices; they do not alter
vendor keys, commands, install routes, or compatibility. Display labels are
kept aligned across frontend and backend specs, installation entries, retained
Plans specs, and Help. Historical research below retains its original product
names and does not prescribe current menu labels.

---

## Part 1 — Where the code lives

An integration is the CLI's declaration plus, where the app does more for it
than launch and resume it, one vendor file on each side. Nothing registers
them: both registries are built from the declarations and find the vendor
files by the CLI's key. No shared module carries per-vendor branches, and CI
rejects a vendor module that imports another vendor or any app module.

| Layer | File |
|-------|------|
| Declaration — the key, label, kind and place in the lists; how the CLI is launched and resumed; (optionally) how its records are read | `native/navide-cli-runtime/src/vendors/<key>.rs` |
| The declarations as the app reads them (generated, never edited) | `backend/agent_team_backend/cli_declarations.json`, `src/renderer/src/platform/plugin-shell/agents/_cli_declarations.ts` |
| Backend spec — credentials, usage, session paths, log reader, install entry | `backend/agent_team_backend/cli_vendors/<key>.py` |
| Frontend spec — capability flags and what the declaration cannot say | `src/renderer/src/platform/plugin-shell/agents/<key>.ts` |

`cli_vendors/registry.py` imports the module named after each declared key,
in the order the declarations give (`order.registry`); `agents/index.ts`
finds every spec file with `import.meta.glob` and lists them by
`order.menu`. A declared CLI with no vendor file on a side is registered
there from its declaration alone: it can be launched and resumed, and has no
other capability.

Everything the old layer-by-layer checklist enumerated now derives from
those:

- `AgentKey` is the declared keys (`agents/index.ts`, from
  `_cli_declarations.ts`); `data/stages.ts` holds no hand-written union to
  drift.
- The install wizard's `DEPS` aggregates each spec's `install_dep`
  (`onboarding_deps.py`), and a vendor absent from `_AGENT_CLI_ORDER` simply
  appends in registry order.
- Log readers are collected from the registry at startup (`app.py`), one per
  spec that defines `make_log_reader`.
- Session marking, resume syntax, paste protocol and login recovery are spec
  fields, not conditionals in `App.vue` or `resume-command.ts`.

A capability left unset means "unsupported for this vendor": the app degrades
around it instead of falling back to another vendor's behaviour. Filling a
field in from a guess is worse than leaving it empty — it hands the resume
preflight, the credential vault or the log watcher paths that do not exist.

`docs/adding-a-cli-vendor.md` carries the full step list, the structural
tests that act as the checklist, and the import rules.

### The declaration: launch and resume, declared once

How a CLI is launched and resumed is written in one place, the vendor's file
in the Rust crate `native/navide-cli-runtime`, and neither spec retypes it:

- the program and its base arguments, the permission-bypass arguments, the
  model and effort argument templates and the effort names the CLI accepts;
- the environment a spawn adds (`env_defaults`) and the home relocators it
  strips (`env_strip`);
- the resume arguments, and how the session id is read back out of a saved
  launch command;
- the interrupt byte, the display label and the kind (CLI or Agent);
- where the CLI sits in the app's two lists (`order.menu`: the spawn menus
  and settings; `order.registry`: the backend's vendor registry). The numbers
  leave gaps: a new CLI takes a free one and no other file changes.

`navide-cli-runtime declarations launch` prints that part of every
declaration as JSON. The output is checked in twice:
`backend/agent_team_backend/cli_declarations.json` for the vendor registry,
and `src/renderer/src/platform/plugin-shell/agents/_cli_declarations.ts` for
the agent specs: the same JSON as a typed constant, so the agent keys are a
literal union at compile time, and inside plugin-shell because it imports
nothing from outside itself. Both are generated; never edit them.

#### Exactly which files a new CLI needs

To exist in the app (it appears in the menus, launches, and resumes if its
declaration says how):

1. `native/navide-cli-runtime/src/vendors/<key>.rs`: a `pub static CLI: Cli`
   and, for a CLI whose records are not declared, `crate::unobserved!(CLI);`.
   The crate's `build.rs` lists the directory, so no shared Rust file is
   edited. `native/navide-cli-runtime/tests/extensibility.rs` is a complete
   CLI declared in one file, and `DESIGN.md` beside the crate explains the
   vocabulary.
2. The two generated copies, rewritten by one command in
   `native/navide-cli-runtime` and committed:
   `NAVIDE_DECLARATIONS_WRITE=1 cargo test --test checked_in`. Run without the
   variable (plain `cargo test`), that test fails when either copy is not
   what the source prints. It needs no built binary.

No shared file is edited for that: not `registry.py`, not `agents/index.ts`,
and none of the recording tests (`cli_declarations_main.json`,
`MAIN_REGISTRY_ORDER`, `MAIN_ORDER`/`MAIN`): they hold the CLIs main had to the
values main had, compare only those keys, and leave a later CLI out. A
declared CLI with no vendor file on a side is registered there from its
declaration alone, and the structural tests check only the files that exist
(a backend test and a frontend test declare a fake CLI to show it).

What the repository's tests still ask of **every** registered CLI, with or
without vendor files, was found by declaring a throwaway CLI (launch only, no
vendor file) and running both suites; it was not committed:

3. Its regression inventory entry, `tests/fixtures/cli-regression/catalog.json`
   with a fixture `<key>.json` beside it, and its row in
   `tests/cli/vendorContracts.test.ts` (the inventory tests fail until both
   name the CLI).
4. The lists that still name a CLI by hand. The earlier hand-kept lists
   (`EXPECTED_VENDORS`, `CLI_NAMES`, `MEMORY_SOURCES`, the exemption sets, the
   plans plugin's frozen copy, `NO_LOG_READER`, `TURN_START_SIGNAL`, the ＋
   menu's cap) now derive from the declaration or the vendor's own spec, or are
   recorded subsets (that includes the `SNAPSHOT` in
   `test_install_deps_snapshot.py`). A second throwaway CLI, a copy of goose
   with its adapter files, still needed: the README vendor count and list, and
   the `CliAgentsHelp.vue` row. They are listed in
   [Adding a CLI vendor](../adding-a-cli-vendor.md#other-hand-kept-lists), with
   the one list a second binary name goes into by hand (the alias set beside
   `CLI_NAMES`). So one declaration plus its tests is true of registration and
   of the recording tests; the prose a person writes is what is left.

For everything beyond launch and resume, add the vendor file of the side
that needs it; each is found by its name:

5. `backend/agent_team_backend/cli_vendors/<key>.py`, exporting `SPEC`
   (credentials, usage, install detection, the log reader, hooks). Spread
   `**declared("<key>")` (`cli_vendors/_declared.py`): it supplies
   `supports_model`, `supports_effort`, `known_efforts`,
   `spawn_env_defaults`, `home_env_vars`, `interrupt_key`,
   `supports_session_resume` and `resume_id_from_command`; do not set these
   by hand. The packaged backend needs no entry for it: the PyInstaller spec
   collects every module of the package (`collect_submodules`, because the
   registry imports it by name and the graph walk cannot see that), and
   `test_pyinstaller_spec.py` runs that collection.
6. `src/renderer/src/platform/plugin-shell/agents/<key>.ts`, exporting `SPEC`
   (capability flags, prompt patterns, quota semantics). Spread
   `...declared('<key>')` (`agents/_declared.ts`): it supplies `label`,
   `defaultCommand`, `skipPermissionFlag`, `modelArgs`, `effortArgs`,
   `knownEfforts`, `resumeArgs`, `resumeCommandPattern` and `kind`. The
   declared `resumeCommandPattern` recognizes the resume command Navide itself
   builds; set your own after the spread only to recognize more (a short-flag
   alias, the `=` and the spaced form both, arguments in between).

The repository's tests then ask for more before a vendor counts as
integrated (a log reader module, an install entry, the hand-kept test lists):
[Adding a CLI vendor](../adding-a-cli-vendor.md) has that list. Those are the
tests' requirements for a fully supported CLI, not registration.

`backend/tests/test_cli_declarations.py` holds a recording of every value
main's hand-written specs had, and of the session id each of main's parsers
read out of some 4,800 commands, so a declaration cannot drift from what the
specs used to say without a test saying so. The frontend's
`agents/__tests__/declared.test.ts` does the same for the agent specs.

### Records: the Rust runtime behind a switch (experimental)

The same file may also declare how the CLI's records are read (`Observe`:
token usage, activity events, per-turn usage). That part is used only when
the `rustCliRuntime` setting is on. There is no toggle for it in the Settings
window yet: the switch is the `rustCliRuntime` key of the UI settings
document. Off, which is the default, every log reader runs its own Python
code and no process is started. On, three reader calls
(`parse_incremental`, `parse_activity`, `turns_for_session`) of each CLI whose
records are declared go to one `navide-cli-runtime serve` process, and
anything that process cannot answer falls back to the Python reader for that
call (`backend/agent_team_backend/cli_runtime.py`). The `diagnostics` of
`/health` report, per CLI, how many calls the runtime answered and how many
fell back (`cli_runtime.calls`).

A new CLI does not need an `Observe` declaration: `unobserved!` keeps its
Python log reader for everything. Declaring one is worth it once the reader
exists and has tests, because the declaration is checked against it:

1. Add a scenario built from the vendor test's own record builders to
   `backend/tests/test_cli_runtime_parity.py`, and record it from the Python
   reader: `NAVIDE_PARITY_WRITE=1 uv --project backend run pytest
   backend/tests/test_cli_runtime_parity.py -k test_python_readers_match_the_parity_fixtures`.
   Fixtures are recorded only from Python, never from the runtime.
2. Write the `Observe` declaration until `cargo test` replays the fixture
   with the same results. The parity test also fails for a declared rule that
   no fixture record reaches.
3. Run the vendor's tests with the switch on:
   `uv --project backend run pytest -p tests.cli_runtime_on backend/tests/vendors/test_<key>.py`.
   The run prints who answered each routed call and fails on a fallback.

The Python log reader stays: it is what the switch-off default runs, what
answers a call the runtime declines, and what every other reader method
(session discovery, marker binding, resume preflight) still goes through.

Account switching (added 2026-09-21) is declared the same way: an
`AccountSwitchSpec` on the vendor spec names the credential pool, the switch
method (`hot` / `restart` / `manual`), the store layout with its provider
scopes, the evidence the layout rests on (`live` / `source` / `docs` plus the
version it was read from), and the environment variables that shadow the
stored credential; `quota_exhausted_patterns` is the only CLI text the backend
accepts as an exhaustion signal, and `login_home_env` decides whether a
sign-in pane is isolated or runs against the live store. Step 9 of the vendor
guide lists the contract. As of this writing all fifteen vendors that declare
one carry `evidence="source"` — no real-account round-trip has been recorded; MiniMax
Code's adapter (region-scoped compound file plus a companion `auth-state`
write, no session resume) is the newest.

### Rust CLI runtime (experimental)

For someone who runs Navide, not someone who adds a CLI. The runtime is off
unless you turn it on, and off is exactly main's behaviour: nothing starts and
every reader is Python.

- **Turn it on.** Send `ui.settings.set` with `{"updates": {"rustCliRuntime": true}}`.
  There is no Settings toggle yet. The backend applies the setting at startup
  and at every change, without a restart.
- **Where the binary comes from.** In a packaged app (macOS and Linux)
  `<resources>/bin/navide-cli-runtime`, which the build stages from
  `build/cli-runtime` (`pnpm build:cli-runtime`). From a source checkout,
  `native/navide-cli-runtime/target/release/navide-cli-runtime`
  (`cargo build --release --manifest-path native/navide-cli-runtime/Cargo.toml`).
  `NAVIDE_CLI_RUNTIME_BIN` names another file and replaces both; a name that is
  not a file means no binary, and no other is tried. Windows packages carry
  none, and the runtime observes nothing there.
- **No binary, or the wrong one.** The backend logs it once and every reader
  stays on Python. A binary that says it is another version than the backend,
  or was built from other CLI declarations than the backend's
  `cli_declarations.json`, counts as no binary.
- **What it is doing.** `GET /health` → `diagnostics.cli_runtime`:
  `state` (`off`, `idle`, `starting`, `running`, `waiting-to-restart`,
  `stopped-after-failures`), `binary` (found and usable), `failures`,
  `runtime` (the version and declarations fingerprint the process reported, and
  `unusable`, the reason it is not used), and `calls` per CLI: `rust`
  (answered by the runtime), `unsupported` and `unreadable` (the Python reader
  decided, as on main), `python` (a record only Python's JSON reader accepts,
  such as a lone surrogate escape or `NaN`: the Python reader read that call),
  `deferred` (a reader making its own reads, or the process starting), and
  `fallback`. `fallback` is the number to watch: it counts stalled or dead
  processes and answers the backend could not use, and a value that keeps
  growing is a defect to report.
- **Roll back.** Set `rustCliRuntime` to `false` (or remove it): the process is
  ended at once and the next read is Python. After five process failures in a
  row the runtime stays off by itself until the setting is switched off and
  on again; the log says so once, with the last lines the process wrote to
  stderr.

### Two kinds of vendors: CLI and Agent

Since 0.2.39 a vendor is one of two kinds:

- **CLI** — a tool that writes code for the user inside a repository and is
  done when its session ends: Claude Code, Codex, Devin CLI, Goose and the
  rest. Navide runs it in a pane, reads its transcript where it can, resumes
  it, and switches its accounts.
- **Agent** — a long-lived, independent agent with its own identity, memory,
  schedules and chat channels, which keeps running whether or not a pane is
  open. Navide is a console onto it, not its runtime.

How to decide: if the vendor's own state (who it is, what it remembers, what
it is scheduled to do, which channels it answers) lives outside the session
and outlives it, it is an Agent. If a session is the unit of work and the
repository is where the work lands, it is a CLI. A vendor that merely
*can* run unattended (`--yolo`, a headless mode) is still a CLI.

The kind is declared with the CLI (`kind: Kind::Agent` or `Kind::Cli` in
`native/navide-cli-runtime/src/vendors/<key>.rs`) and reaches the frontend
spec's `kind` field
(`src/renderer/src/platform/plugin-shell/agents/types.ts`) through
`declared('<key>')`: `'agent'` for an Agent, left out for a CLI. Nothing else
needs an edit, and no surface keeps a list of names. The backend spec has no
counterpart.

Where it shows: the ＋ menu on a workspace heading lists its entries in two
blocks, each under a small heading — **CLI** first, then **Agents**. Inside
each block the order and the disabled set of Settings → CLI Agents apply as
before, and a block with no enabled entry is left out with its heading.
Terminal, Manual spawn and the cloud-agents Marketplace hint sit below both
blocks. Every other surface (Manual spawn's dropdown, "Handle Issue As…",
accounts, token stats) lists both kinds together.

Current members: Agent = `openclaw` (OpenClaw) and `hermes` (Hermes Agent);
every other vendor, Devin CLI included, is a CLI.

What 0.2.39 wires for an Agent: launching it in a pane (the TUI attaches to
the agent's own runtime where it has one), the guided install (docs link only —
both official installers pipe a script into a shell), its data directories,
and the YOLO flag where one exists (`hermes chat --yolo`). Since 0.2.40 both
also have session resume (Navide names the session), a turn-end signal and
token counts read from their own SQLite stores (Hermes `state.db`, OpenClaw
`openclaw-agent.sqlite`). Still not wired: a model or effort choice for
either (OpenClaw's TUI has none; Hermes refuses `-m` / `--reasoning` on the
`--continue` launch Navide uses) and a kickoff flag for either
(the role text is typed into the composer like every vendor's). Keys and account switching are left alone on purpose: an Agent's
providers and keys live in its own home (`~/.openclaw`, `~/.hermes`), and
Navide reads none of it, offers no account switching and fetches no usage.
Part 2's OpenClaw and Hermes Agent record has the per-vendor detail.

---

## Part 2 — Integration records

Written against the pre-refactor layout: paths such as `lib/agentSpecs.ts`,
`log_readers/<cli>.py` and the `ws_handlers.py` agent whitelist no longer
exist as described, and the per-layer instructions are superseded by Part 1.
What remains valid — and is recorded nowhere else — is the per-vendor
research: install routes, resume syntax, session storage formats, token
accounting, and the trap each CLI hides.

### ACP panes: Claude Code over `claude-acp` — added 2026-11-10 (experimental)

An ACP pane runs a CLI over the [Agent Client Protocol](https://agentclientprotocol.com)
(JSON-RPC on stdio) instead of in a terminal: Navide draws the conversation,
sends prompts as `session/prompt` and reads the turn end from the protocol's
`stopReason`. It is added beside a CLI's terminal integration, never in place
of it: `cli_vendors/<key>.py` is not touched, and a CLI absent from
`acp_vendors.py` has no ACP pane.

| Question | Claude Code (`claude`) |
|---|---|
| Switch | Settings → CLI Agents → ACP (experimental), ui setting `acpExperimental`, **off by default**. Off, `ACP_LAUNCHES` is empty, the ＋ menu has no ACP row, no adapter is listed for install and `tools/list` is byte-identical to main (`MAIN_TOOLS_LIST_SHA256`). `acp_switch.py` applies it at startup and on every `ui.settings.set` that changes the key. |
| Launch | `claude-agent-acp` from npm `@agentclientprotocol/claude-agent-acp`, the ACP registry's `claude-acp` entry (0.102.0 on 2026-11-10; ACP protocol version 1, schema v1.30.0). The adapter runs Claude Code through the Claude Agent SDK with the user's own login. |
| Install | The adapter is an install-wizard dependency (`claude-acp`, optional) only while the switch is on: `npm install -g @agentclientprotocol/claude-agent-acp@0.102.0`. The ＋ menu opens the guided install while it is missing; `acp.create` refuses with `ACP_ADAPTER_MISSING` (details `dep_id`) if it is still missing. |
| Verified version | `verified_version = "0.102.0"` (`claude-agent-acp --version` prints the bare version). The install pins it; another installed version is not refused. |
| Entry point | The ＋ menu's Agents block, "Claude Code (ACP)", the only caller of `spawnPane({display: 'acp'})` (App.vue `onAcpSpawn`, pinned by `acpEntryPoints.test.ts`). The pane's agent key stays `claude`. |
| Messaging | A pane like any other: `cli_list_targets` lists it, `cli_send` is queued and enveloped by the window and handed over as a prompt (`acp.deliver` → `acp.prompt`), never typed. `cli_get_status`, `cli_wait_idle`, `cli_read_log` and `cli_interrupt` answer from the backend's own session (`acp_mcp.py`); their descriptions gain `acp_mcp.TOOL_NOTES` only while the switch is on (`ACP_ON_TOOLS_LIST_SHA256`). |
| Turn end | `stopReason` → `turn_complete` with the reply text, recorded and broadcast as `agent.activity` like a log reader's (source `""`, so no hook/log pairing applies). |
| Permissions | Every `session/request_permission` is asked in the pane (the main window); Guard is not consulted. Navide launches the adapter bare (no bypass flag, no `_meta` options), so the session's permission mode is the adapter's: an explicit mode, else the resumed transcript's, else the user's `permissions.defaultMode`, and with no `defaultMode` set **`auto`** whenever the mode catalog offers it (0.102.0 `resolveInitialPermissionMode`, "like an interactive Claude Code session"). In `auto` most tool calls never reach `canUseTool`, so the pane shows no request; `skipDangerousModePermissionPrompt` plays no part. To see requests, set `"permissions": {"defaultMode": "default"}` in the account's Claude settings (or `disableAutoMode: "disable"`). Verified on the Linux VM 2026-11-10 (B10 step 6): no `defaultMode`, a Bash `touch` ran with no request. |
| Not wired (0.2.42 or later) | MCP back to Navide (`session/new` sends `mcpServers: []`), Guard on permission requests, roles (none is injected), restore after a restart (no manual-pane record is written), account switching, Agent History tokens. |
| Hooks | Claude Code under the adapter runs the user's own hooks (0.102.0 passes `settingSources: ["user", "project", "local"]`; a PreToolUse hook in `~/.claude/settings.json` fired on the Linux VM, 2026-11-10). Navide's hooks (Guard, turn and permission-hold events) do **not** run: a terminal pane gets them through `--settings <runtime/claude/settings.json>` (`claude_hooks.wire_spawn`), and `acp.create` starts `claude-agent-acp` without it. Planned for 0.2.42 with the MCP connection back (candidate: `_meta.claudeCode.options.extraArgs`). |
| Unverified | Windows (npm `.cmd` shim, non-ASCII user paths) has never run a real adapter. |

### Kiro CLI (`kiro`, AWS) — added 2026-11-12

A coding CLI (the ＋ menu's CLI list), the successor of Amazon Q Developer CLI.
Read from the official docs on 2026-11-12 (kiro.dev/docs/cli,
/docs/reference/cli-commands, /docs/reference/settings, /docs/mcp/configuration,
/docs/hooks, /docs/hooks/types, /docs/hooks/actions, /docs/steering); no binary
was installed, so nothing here is a live recording. The minimum integration:
launch, install detection, navide MCP, a turn-end hook.

| Question | Finding (docs, 2026-11-12) |
|---|---|
| Install | `curl -fsSL https://cli.kiro.dev/install \| bash` (macOS / Linux), a Homebrew cask `kiro-cli`, `.deb`, AppImage. Windows 11 is listed as supported with no install command. The install entry has no command and links kiro.dev/docs/cli. `kiro-cli update` updates; the diagnostic command is `kiro-cli diagnostic` (there is no `doctor`). |
| Version | `kiro-cli --version` / `-V`; output undocumented, the generic `(\d+\.\d+\.\d+)` is used. No verified version (`test_spawn_probe_version_drift` exempts it). |
| Launch | `kiro-cli chat --v3`. `kiro` alone opens the IDE. `--v3` pins the V3 harness, which the hook below is written for (headless runs default to V2). |
| Permissions | YOLO appends `--trust-all-tools` (a `chat` flag); interactive V3 shows a confirmation warning first. |
| MCP | No flag or variable carries a document, but `KIRO_HOME` relocates the whole global directory. Each pane gets its own (`mcp_server/pane_home.py`, kimi's shape): every entry links to the user's `~/.kiro`, except `settings/mcp.json` (the user's servers plus `navide` as a bare `url`) and `hooks/`. |
| Turn end | `hooks/` in the pane's home is a real directory: the user's hook files are links, plus `navide.json`, a V3 hook with trigger `Stop` whose command posts the stdin JSON (`hook_event_name`, `cwd`, `session_id`) to `/hooks/kiro` and always exits 0 (`kiro_hooks.py`). The user's `~/.kiro/hooks` is never written, so a Kiro run outside Navide posts nothing. No reader attributes Kiro sessions, so the hook names its pane by the spawn token (`VendorSpec.hook_pane_token`; `cli_hook` looks it up only for vendors declaring it). Without the hook (for example `chat.agentEngine` set to `v2`) the pane falls back to PTY quiet time. |
| Sign-in | `kiro-cli login` (GitHub, Google, AWS Builder ID, IAM Identity Center); credential location undocumented. No `login_command_args`, no account switching, no usage. |
| Instruction files | `~/.kiro/steering/*.md`, `.kiro/steering/*.md`, and `AGENTS.md` at the workspace root (also read from `~/.kiro/steering/`). |
| Not wired | Reader, resume (`--resume-id <ID>` exists, the session SQLite is undocumented), model / effort flags (documented, not checked against an invalid value), Guard (`PreToolUse` non-zero exit blocks), usage (`/usage`), extensions inventory. Busy/idle detection, bracketed paste and the bare-line reply protocol are unverified. |
| Unverified | Whether `KIRO_HOME` covers `hooks/` (the docs list settings, sign-ins, sessions, agents, MCP, not hooks); whether Kiro rewrites its SQLite or credential files by atomic rename, which would replace a link in the pane's home with a pane-local file. Both are on the live acceptance list in plan `kiro-cli-kiroween_58d93a`. |

### Devin CLI (`devin`, Cognition) — added 2026-11-07

A coding CLI (the ＋ menu's CLI list). Read from the
official docs on 2026-11-07 (docs.devin.ai/cli, /cli/reference/commands,
/cli/essential-commands, /cli/handoff, /cli/extensibility/rules,
/cli/reference/configuration/config-file, /cli/changelog/stable); no binary
was installed, so nothing here is a live recording.

| Question | Finding (docs, 2026-11-07) |
|---|---|
| Install | `curl -fsSL https://cli.devin.ai/install.sh \| bash` (macOS / Linux / WSL), `brew install --cask devin-cli`, or on Windows an x86_64/ARM64 installer or `irm https://static.devin.ai/cli/setup.ps1 \| iex` in PowerShell (not Git Bash or CMD). The install entry has no command, so the guided install shows the docs link. `devin update` / `devin doctor` are the update and diagnostic commands. |
| Version | `devin --version` = `devin version`; the output line is undocumented. Releases are numbered `v3000.12.17`; the generic `(\d+\.\d+\.\d+)` reads `3000.12.17`. No verified version is declared (`test_spawn_probe_version_drift` exempts it). |
| Launch | Bare `devin` opens the TUI. `devin -- <prompt>` preloads a prompt; Navide types the kickoff into the composer like every vendor. |
| Permissions | `--permission-mode normal\|accept-edits\|smart\|dangerous\|autonomous` (`DEVIN_PERMISSION_MODE`); `dangerous` = `yolo` = `bypass`, admin deny/ask rules still apply; `autonomous` needs `--sandbox`. YOLO mode appends `--permission-mode dangerous`. |
| Non-interactive | `-p/--print [PROMPT]`, `--prompt-file`; Navide never spawns it. |
| Resume | `-c/--continue` (latest in cwd), `-r/--resume <id>`; `devin list` lists sessions. The session store's location is undocumented and no reader exists, so `supports_session_resume=False` and no `resumeArgs`. |
| Cloud | `/handoff [task]` moves the session — repo, branch, conversation and **uncommitted changes** — to a cloud Devin VM; from a cloud session it pulls the PR branch back. Devin's own command and account; Navide adds nothing. |
| Sign-in | `devin auth login` / `/login`; credential location undocumented. No `login_command_args`, no account switching, no usage. |
| Instruction files | User: `~/.config/devin/AGENTS.md` (`%APPDATA%\devin\AGENTS.md` on Windows), `~/.devin/global_rules.md`, `~/.devin/rules/*.md`, `~/.claude/CLAUDE.md`. Project: `AGENTS.md`, `AGENTS.local.md`, `AGENT.md`, `CLAUDE.md`, `.windsurfrules`, `.devin/rules/*.md`, `.devin/global_rules.md`, plus `.windsurf/` and `.cursor/rules`. All always-on, loaded together. `native_memory` maps the Devin-specific ones and the standard files; the Windows user path is not covered (rows are home-relative). |
| Config | `~/.config/devin/config.json` (`%APPDATA%\devin\config.json`), project `.devin/config.json` / `config.local.json`. No relocation variable documented, so no `home_env_vars`; `data_dirs` declares that user config directory only (session and credential locations are undocumented). |
| Not wired | Reader, resume, model flag (`--model` documented, not checked against an invalid value), MCP, skills, plugins/hooks inventory, usage, account switching. Busy/idle detection, paste protocol and the bare-line reply protocol are unverified. |

### OpenClaw (`openclaw`) and Hermes Agent (`hermes`) — added 2026-11-07

General assistants that own their runtime and model keys, wired as ordinary
vendors of `kind: 'agent'` (see "Two kinds of vendors" in Part 1): the ＋
menu's Agents block, Manual spawn and "Handle Issue As…".
Read from the official docs on 2026-11-07. The Hermes column was measured on
2026-11-10 against Hermes Agent v0.23.0 on Ubuntu 24.04 arm64 with a local
stub provider, and the OpenClaw column against OpenClaw 2026.11.2 the same
way (plan openclaw-hermes-0-2-40_a50148). The VM re-run the same day (Hermes
v0.23.1, OpenClaw 2026.11.2) captured OpenClaw's session tables and Hermes's
refusal of model flags on `--continue`; see the Log and Not wired rows.

| Question | OpenClaw | Hermes Agent |
|---|---|---|
| Launch | `openclaw tui --local` (since 0.2.40; 0.2.39 ran bare `openclaw`, which attaches to a running Gateway when there is one): the TUI on the local embedded runtime, which left no background process. Navide never starts the Gateway. | `hermes chat` (since 0.2.40; 0.2.39 ran bare `hermes`): the same interactive chat, honouring `display.interface`. The subcommand because `--create-if-missing` exists only there (`hermes chat --help`, v0.23.0). |
| Permissions | No bypass flag. | `chat --yolo`. |
| Kickoff | Typed into the composer like every vendor. `tui --message` sends an initial message (measured) but is not used. | Typed into the composer. `chat -q` seeds the first turn on a TTY (measured) but is not used. |
| Install | `curl \| bash`; the install entry has no command, so the guided install shows the docs link. | `curl \| bash`, or `iex (irm …/install.ps1)` on native Windows (supported; data in `%LOCALAPPDATA%\hermes`). Same: docs link only. |
| Keys | OpenClaw's own config (`~/.openclaw/openclaw.json`). Navide reads none. | `~/.hermes/.env` / `config.yaml` (`$HERMES_HOME`). Navide reads none. |
| Instruction files | Agent workspace `~/.openclaw/workspace/AGENTS.md`, `SOUL.md` — not the TUI's cwd. | Project: `.hermes.md`/`HERMES.md`, `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`; home: `SOUL.md`. |
| Not wired | Model / effort flags (the TUI has none; `agent --model` is non-interactive, `models set` is global), MCP, skills, extensions inventory, usage, account switching, the `agent_end` plugin hook. | Model / effort: `chat` lists `-m` / `--reasoning`, but v0.23.1 refuses both on any `--continue` launch, creation included (exit 2, "creation overrides are unsupported on resume"); `/model` and `/reasoning` switch the session only when typed raw into the PTY, which no launch path does. Also MCP, skills, extensions inventory, usage, account switching, the `on_session_end` shell hook (it needs the user's `config.yaml`). |
| Session | Navide names it: `--session agent:main:navide-<uuid>` on every launch, fresh or resumed (the same key reattaches; measured). | Navide names it: a fresh pane runs `--create-if-missing --continue navide-<uuid>`, a resume `--continue navide-<uuid>` (the latest session in that title's lineage; Hermes titles a continuation `<name> #2`). The CLI's own `local-<64hex>` id is never needed. |
| Log | `<state>/agents/<agentId>/agent/openclaw-agent.sqlite`, table `transcript_events`, read-only through `session_id`, `seq`, `event_json`, `message_role` only. zstd-compressed rows are skipped (Python 3.12). The column holds the UUID `sessionId` and the header event names no key, so the key comes from the same store's `session_windows` (`session_id` → `session_key`, earlier windows included), else `session_nodes` (`current_session_id`); a build without them falls back to the column or header. A session none of them names reaches no pane, is logged once and is looked up again on the next pass. A store missing a column is logged once and gives no signal. | One SQLite store, `<home>/state.db`, read-only. Used columns: `sessions` id/title/parent_session_id/cwd/token counters/last_activity_at, `messages` id/session_id/role/content/tool_calls/timestamp/finish_reason. A store missing any of them is logged once and gives no signal. |
| Turn end | An assistant `message` whose `stopReason` is set and is not `toolUse`. Measured only on the stub. | An assistant row whose `finish_reason` is set and is not `tool_calls`. Measured only on a local OpenAI-compatible stub; real providers with tools or an interrupt are unverified. |
| Tokens | An assistant message's `usage` (input / output / cacheRead / cacheWrite) when the row carries it. | Growth of the per-session counters in `sessions` (no per-call rows); cache folded into input. Whether Hermes's `input_tokens` already contains the cache part is unverified. |
| Background process | None with `--local`. The agent works in `~/.openclaw/workspace`, not the pane's cwd. | The first chat starts `hermes gateway run --idle-exit` (ppid 1); it outlived 12.5 idle minutes. Hermes's own; Navide neither starts nor stops it. |

### Goose (`goose`, AAIF) — added 2026-10-21

Recorded live from goose 1.55.0 (`goose-aarch64-apple-darwin.tar.gz`, sha256
`153425d6…7f2d8107`) in a scratch `HOME` / `GOOSE_PATH_ROOT`, keyring and
telemetry off, against a loopback mock OpenAI endpoint — no account, no
credential, no provider call, no global install. Goose ships no self-updater
that runs on its own; `goose update` is manual.

| Question | Finding (1.55.0) |
|---|---|
| Install | `curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh \| bash`; binary **`goose`**. pressly's database-migration tool is also called `goose` and prints `goose version: v3.x`; Navide's `identity_regex` accepts only the bare ` 1.55.0` shape. |
| Launch | Bare `goose` opens a new session once a provider is configured, else runs `goose configure`. |
| Permissions | No bypass flag. `GOOSE_MODE` (auto — the default — approve, smart_approve, chat) decides; the approve prompt is a cliclack select headed `◆  Goose would like to call the above tool, do you allow?`, which is the `awaitingInput` pattern. |
| Resume | `goose session -r --session-id <id>`; an unknown id exits with "no such session exists". `--session-id` cannot name a NEW session, and `-n <name>` is not unique (a second `-n` with the same name makes a new session), so panes bind through the kickoff marker. |
| Session storage | One SQLite db (WAL, schema v17): `$GOOSE_PATH_ROOT/data/sessions/sessions.db`, else `$XDG_DATA_HOME/goose/sessions/sessions.db` (default `~/.local/share/goose/…` **on macOS too** — not `~/Library/Application Support`), and `%APPDATA%\Block\goose\data\…` on Windows (source only). Session ids are `YYYYMMDD_N` in UTC. |
| Turn end | No record. A model response is one `messages` row (text and toolRequest together, verified by streaming them as separate chunks), and the agent loop stops on a response without a tool request, so an agent-visible text-only assistant row ends the turn. A turn interrupted with Ctrl+C writes no row: the pane is seen to finish only when the next prompt starts. |
| Tokens | `usage_ledger`, one row per model call; `input_tokens` already includes cache read/write (`token_usage.rs`). Sub-agent sessions (`parent_session_id`) are counted but never end the pane's turn or bind its marker. |
| Not wired | MCP (`--with-streamable-http-extension` exists), skills, plugin hooks (`~/.agents/plugins`, PreToolUse could carry Guard), usage/quota, account switching, model flag. |

### MiniMax Code (`mcode`) — added 2026-09-20

The integration supports install detection, interactive launch and `mcode login`.
Session discovery, transcripts, resume, token/quota reporting, account switching,
MCP and skills wiring are not implemented. Model, effort and permission-bypass
flags are omitted because the verified interactive CLI does not accept them.
Navide strips both `MINIMAX_DATA_DIR` and its legacy fallback `MAVIS_DATA_DIR`
from inherited environments and refuses them in launch overrides; it does not
create an isolated MiniMax home per pane.

### CLI reliability corrections — 2026-09-20

These corrections are covered by isolated regression tests; they do not
constitute authenticated, end-to-end acceptance of every vendor:

- Antigravity rechecks unfinished SQLite assistant rows when their status is
  updated in place, so a later completion is not lost behind the row watermark.
- Antigravity `--conversation` and Grok `-r` / `--resume` commands now expose
  their explicit session IDs to the existing duplicate-PTY reaping path.
  Grok title-based resume is still not parsed as a session ID. Both vendors
  retain file-based session existence checks through `session_path`.
  Duplicate detection accepts literal CLI invocations and known shell wrappers;
  it does not infer IDs from compound shell commands, other executables or
  positional text after `--`.
- Grok's first session directory is shared with its per-pane home shim even
  when the real home had no sessions directory before launch.
- Kimi streaming records postpone inferred idle completion. New assistant
  content after an inferred idle boundary can produce its final reply under
  a fresh completion key.
- OpenCode quota credentials and Kilo account switching follow
  `XDG_DATA_HOME`; Kilo's credential watcher uses the same resolved path.
- Pi resume preflight checks the target workspace, matching `--session-id`:
  finding that ID only in another workspace must not permit an empty new
  conversation to look like a successful resume.
- Droid retains assistant text across log polls until its outcome arrives,
  then clears it so later turns cannot reuse the previous reply.
- Resuming a closed pane from Agent History restores its recorded model and
  effort. If the pane record was pruned, durable history supplies those
  choices; older records without them retain the vendor default. An older
  client's omitted fields no longer erase recorded choices.
  When resuming history viewed from another workspace, a pruned pane's saved
  parent is restored only if that parent still exists in the target workspace.
  Missing parents remain roots, and a record explicitly marked as a root stays
  a root.

### Codex session identity — updated 2026-09-21

Codex generates the ID of a new interactive session; Navide does not pass a
Claude-style `--session-id`. Existing conversations use `codex resume <id>`.
Codex 0.155.1 queues `SessionStart` for the first turn and may defer its rollout
until then. The ID can remain unknown while a new pane is idle. Navide sends no
synthetic session-marker prompt on manual launch, fresh rebuild, or fresh
restore, adds no marker to configured role/task prompts, and shows no
marker-specific waiting overlay. A real user or configured task turn can make
the session observable; an ID before the first input is not guaranteed.

Navide accepts a trusted `SessionStart` callback only for its originating
pane launch, using a per-launch token to reject stale or mismatched callbacks.
The session-scoped hook configuration preserves user hooks, leaves global
configuration unchanged, and does not bypass Codex hook review. YOLO does not
approve hooks: the hook must be enabled and trusted under Codex's hook rules.
Newly prepared pane homes keep their sessions and runtime state local; skills
refreshes do not replace them with links to the global Codex home. This allows
validated local rollout discovery without a hook or marker. Existing homes
whose sessions are already shared remain unchanged and need the authenticated,
validated hook callback for marker-free attribution; a shared path or matching
workspace alone is insufficient. Historical markers remain readable.
For an existing conversation, Navide explicitly binds the verified resume
UUID rather than discovering a different session from shared storage.
The hook handles startup and resume events only; clearing a conversation
continues to use the existing log-discovery flow.

Hook review, third-party `SessionEnd` timeout warnings, and MCP startup
failures are separate from session identity. This integration does not approve
unrelated hooks or repair failing MCP servers.

### Antigravity CLI (`agy`) — added 2026-07-05

- Full integration: agentSpecs, resume via `agy --conversation <id>`,
  Stage editor support, TokenStats reader, session detection.
- Hard-won lesson: no way to pin a session id at launch → marker-based binding
  with **three-tier detection** (SQLite polling / websocket) in
  `antigravity.py`. If the marker is never detected the pane sticks on the
  "detecting session" overlay — this remains the known weak spot.

### Gemini CLI — removed 2026-07-05 (obsolete)

- Product discontinued; support fully removed (specs, reader, resume branch).
- Do not re-add. Historical implementation retrievable from git history if a
  similar JSONL-based CLI ever needs a reference.

### Grok CLI (`grok`) — added 2026-07-10

- Full integration: agent specification, onboarding detection, marker-based
  session binding, `grok -s <id>` resume, SQLite usage reader, token display,
  and workspace attribution.
- No Navide YOLO flag is added because the integrated CLI has no general
  tool-execution confirmation gate.
- The integration reads the shared `~/.grok/grok.db` in a WAL-aware manner.

**Superseded 2026-09-14 — the vendor now targets xAI's own grok-build CLI**
(`curl -fsSL https://x.ai/cli/install.sh | bash`, docs.x.ai/build/cli), not the
community CLI the research below describes. Both install to `~/.grok/bin/grok`,
so `which grok` cannot tell them apart; the version string can — xAI's prints
`grok <x.y.z> (<commit>)`, the community one a bare `1.1.7`. What changed for
the integration: sign-in is `grok login` (browser OAuth at auth.x.ai), and MCP
servers live in `~/.grok/config.toml` under `[mcp_servers.<name>]` — a TOML map
keyed by the server's name, where a bare `url` means streamable HTTP — instead
of a `mcp.servers` **list** in `~/.grok/user-settings.json`. Resume is
`grok -r <id>` — `-s`/`--session-id` NAMES a new session and errors on an
existing id, so the `grok -s` below no longer applies. Sessions are one
directory each under `$GROK_HOME/sessions/<url-encoded-cwd>/<uuid7>/`
(`updates.jsonl` transcript, `usage.json`, `summary.json`); the shared
`~/.grok/grok.db` is gone. The transcript carries an explicit `turn_completed`
record with the turn's tokens, so the 8-second-silence turn-end inference the
community CLI needed was removed with it. `grok update` exists and is the
update action. Everything below still describes the community CLI and is kept
as the record of how the integration was built.

The following notes preserve the research that informed the integration.

Source: https://grokcli.io/ → https://github.com/superagent-ai/grok-cli
(open-source coding agent for the Grok API by superagent-ai).

Disambiguation: this is NOT xAI's official "Grok Build" CLI
(`curl https://x.ai/cli/install.sh`, subscription-gated) — both install a
`grok` command, so confirm which one is on the user's PATH before integrating.

| Question | Initial research finding (superseded by the resolved notes below) |
|---|---|
| Install | `curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh \| bash` or `bun add -g grok-dev` → binary **`grok`** |
| Launch | `grok` (interactive TUI), `grok -d <dir>`; headless `grok --prompt "..."` with `--format json` |
| Auth | `GROK_API_KEY` env var / `.env` / `grok -k <key>` / `~/.grok/user-settings.json` `"apiKey"` |
| YOLO flag | **Not documented** — no auto-approve/force flag found in README; sandbox/hooks settings live in `~/.grok/user-settings.json` (open question 1) |
| Resume | `grok --session latest` or `grok -s <session-id>` — flag-based, fits the default `resume-command.ts` shape |
| Pin id at launch | Not documented → assume marker-based binding (layer 3) needed |
| Session storage | Project-level `.grok/` + user-level `~/.grok/` — exact session file path/format not documented (open question 2) |
| Config | Project `.grok/settings.json` (model), user `~/.grok/user-settings.json`; instructions via `AGENTS.md` / `AGENTS.override.md` |
| Model | `grok models` to list; `GROK_MODEL` env or settings; defaults like `grok-4.3` |
| MCP | Supported — user-level `~/.grok/user-settings.json` under `mcp.servers` (a **list**; each entry needs `id`, `label`, `transport`, `url`). The README's project-level `.grok/settings.json` `mcpServers` is not read by v1.1.7. |

Spec entry (verified — no permission flag needed):

```ts
{
  agentKey: 'grok',
  label: 'Grok CLI',
  defaultCommand: 'grok',
  // no skipPermissionFlag: grok-cli has no tool-confirmation gate at all
  hint: 'generalist'
}
```

Open questions — ALL RESOLVED 2026-07-10 by reading the source
(github.com/superagent-ai/grok-cli, v1.1.7):

1. **YOLO/auto-approve**: no tool-execution confirmation gate exists — bash /
   file / edit tools run automatically in TUI and headless modes. The only
   approval flow is for x402 *payments* (`autoApprove` in user-settings is
   payment-only). → omit `skipPermissionFlag`.
2. **Session storage**: single shared SQLite DB `~/.grok/grok.db` (WAL,
   busy_timeout 5s), NOT per-project files. Tables: `workspaces` (id =
   sha1(git root), 16-hex), `sessions` (id = 12-hex uuid slice), `messages`
   (`message_json` = full ModelMessage JSON, seq-ordered), `usage_events`,
   `tool_calls/results`. Written synchronously per turn — live reads work.
3. **Token usage**: `usage_events` rows carry `input_tokens`, `output_tokens`,
   `total_tokens`, `cost_micros`, `model`, `session_id` per turn.
4. **Marker persistence**: user message text is stored verbatim in
   `messages.message_json` → `at-pane:<id>` marker binding works; reader
   queries the messages table (open the DB read-only; WAL-aware).
5. **Session listing**: no `grok sessions` command; `--session latest` =
   most-recently-updated session in the current workspace. Reader can
   enumerate ids straight from the `sessions` table.
6. **Concurrency**: safe for distinct sessions (WAL + transactions); no
   per-pane home isolation needed. Sessions are keyed by workspace hash, so
   the log reader filters by `workspaces.root_path` matching the pane's cwd.

Env vars: `GROK_API_KEY` (auth), `GROK_BASE_URL`, `GROK_MODEL`,
`GROK_MAX_TOKENS`, `GROK_TRUST_WORKSPACE` (skips sandbox trust prompt —
useful for spawn env). Runtime note: built on Bun (`bun:sqlite`); the
official install.sh handles runtime setup.

### OpenCode (`opencode`) — added 2026-07-27

Source: https://opencode.ai/docs/cli/ (sst/opencode). Research verified
against installed v1.15.12.

- Core integration: agent spec, marker-based session binding,
  `opencode --session <id>` resume, SQLite log reader, token stats,
  onboarding registry entry, plan-MCP wiring (via `OPENCODE_CONFIG_CONTENT`).
- Deliberately skipped layers: CLI profiles / credential vault (account
  isolation not yet researched), usage/quota provider (no vendor quota API),
  per-pane home isolation (WAL DB is concurrency-safe).

| Question | Finding (v1.15.12) |
|---|---|
| Install | `curl -fsSL https://opencode.ai/install \| bash`; npm package `opencode-ai`; binary **`opencode`** |
| Launch | `opencode` (interactive TUI), `opencode [project]`; headless `opencode run [message..]` |
| YOLO flag | **None for the TUI** — `--dangerously-skip-permissions` exists only on the `run` subcommand; the default TUI command rejects it (verified empirically). Permissions are config-driven (`OPENCODE_PERMISSION` env / permission config) → omit `skipPermissionFlag`. |
| Resume | `opencode --session <id>` / `-s <id>`; also `-c/--continue` (last session) and `--fork` |
| Pin id at launch | Not supported (`--session` only continues existing sessions) → marker-based binding |
| Session storage | Single shared SQLite DB `~/.local/share/opencode/opencode.db` (WAL). Legacy `storage/` JSON dirs are stale except `session_diff/`. Tables: `session` (id `ses_…`, `directory` = cwd, per-session token totals), `message` (`data` JSON with role/tokens/modelID), `part` (`data` JSON; user text verbatim → `at-pane:` marker works), `project` (worktree path). |
| Token usage | Per assistant message in `message.data.tokens` (input/output/reasoning/cache.read/cache.write) and aggregated on the `session` row |
| Workspace filter | `session.directory` equals the pane cwd directly (no hash lookup needed) |
| Concurrency | WAL + per-directory sessions → safe, no home isolation |
| Update / doctor | `opencode upgrade`; no doctor subcommand |
| Env vars | `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` (both scrubbed from inherited spawn env), `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_PERMISSION` |

### Batch of six — added 2026-07-28

Six CLIs were integrated in one pass (easy → hard), each via a parallel
frontend + backend agent pair with full test-suite gates between rounds.
MiniMax CLI (`mmx`, a media-generation CLI, not a coding agent) and Z.ai
(no first-party CLI; GLM Coding Plan is a model subscription that plugs
into third-party CLIs) were researched and rejected as agent types — if
supported later, they belong as provider/env profiles on existing CLIs.

| Key | Resume | YOLO | Session storage / reader notes |
|---|---|---|---|
| `qwen` (Qwen Code, npm `@qwen-code/qwen-code`) | `qwen --resume <uuid>` | `--yolo` | Near-clone of Claude Code's JSONL: `~/.qwen/projects/<sanitized-cwd>/chats/<uuid>.jsonl` (+`archive/`); root via `QWEN_RUNTIME_DIR`. Assistant records carry `usageMetadata` (input = `promptTokenCount`, which already includes cached; output = candidates + thoughts). Filter user subtypes `mid_turn_user_message`/`cron`/`notification`. NOT the old Gemini format — the removed gemini reader's assumptions are all stale. |
| `kilo` (Kilo Code, npm `@kilocode/cli`) | `kilo --session <ses_…>` | none for the TUI (`--auto` is `kilo run`-only) | OpenCode fork with an identical schema — `KiloLogReader` subclasses `OpencodeLogReader`, pointing at `~/.local/share/kilo/kilo.db`. `message`/`part` are V1 compatibility projections; re-verify on major Kilo upgrades. |
| `pi` (Pi, npm `@earendil-works/pi-coding-agent`) | `pi --session-id <id>` (also pins new ids at launch) | none — Pi has no permission system at all | JSONL at `~/.pi/agent/sessions/--<encoded-cwd>--/<ts>_<id>.jsonl`; header line holds id + cwd. Two traps handled: lazy flush (file only appears after the first assistant reply) and in-place whole-file rewrites (never assume append-only). Tokens per assistant `usage`. |
| `copilot` (Copilot CLI, brew cask `copilot-cli` / npm `@github/copilot`) | `copilot --resume=<uuid>` (unknown id ⇒ starts a new session with that UUID) | `--yolo` | `~/.copilot/session-state/<uuid>/events.jsonl` + `workspace.yaml` (cwd); root via `COPILOT_HOME`. Format captured live from v1.0.75: tokens ONLY on `session.shutdown` `modelMetrics` (input already includes cache, output already includes reasoning) — handled codex-style as cumulative deltas. `assistant.turn_end` is an explicit turn_complete signal. |
| `cursor` (Cursor CLI, closed-source; binary `agent`, older `cursor-agent`) | `cursor-agent --resume=<uuid>` | `--force` (alias `--yolo`) | Hardest reader, entirely defensive: per-session `~/.cursor/chats/<hash>/<uuid>/store.db` with undocumented protobuf `blobs` — marker binding is a raw UTF-8 bytes scan (capped), workspace filter treats md5(cwd) as best-effort only, and **no token data exists locally** (empty stats are expected). Community-reverse-engineered layout, NOT yet validated against a live install; the IDE's `~/.cursor/projects/*/agent-transcripts/*.jsonl` is a different store — do not read it. |
| `aider` (Aider, pip `aider-chat`) | `aider --restore-chat-history` (no session id — lossy, may be LLM-summarized) | `--yes-always` | Only Markdown reader: per-project `<git root>/.aider.chat.history.md`, sections split on `# aider chat started at …` (session id = started-at slug), user lines `#### ` (markers bind against the LAST section only), tokens from `> Tokens: X sent, Y received` lines. Watcher routes via the `LogReader.claims_path()` hook added for this; events are rescan-driven (~30s latency). No Rebuild button and no detecting-session overlay on the frontend — both depend on real session ids. |

### Droid (`droid`, Factory) — added 2026-08-27

Homebrew cask (`brew install --cask droid`), verified against 0.204.0. The
integration is a close structural twin of Claude Code — per-cwd session
directories, hook events of the same names — which is exactly what made it
dangerous: three properties that *look* like Claude's are not, and each one
fails silently rather than loudly.

| Aspect | What holds for droid |
|---|---|
| Resume | `droid --resume <uuid>` (`-r` is the same option). `--session-id` exists only on `droid exec`, so an interactive pane cannot pin an id at launch — hence `needsSessionMarker: true` plus the single-candidate cwd fallback. |
| YOLO | `--auto high`. `--skip-permissions-unsafe` is documented only under `droid exec`; the interactive binary **silently ignores unknown flags** (confirmed with a deliberately bogus one), so a probe that "didn't error" proves nothing — the same trap that shipped a crashing `--auto` for opencode. |
| Session storage | `~/.factory/sessions/<encoded-cwd>/<uuid>.jsonl`, **not** the `projects/` path the docs describe. Also falls back to a flat `sessions/` and `sessions/btw/` for forks — `session_exists` checks all three, or a forked pane is reported missing and replaced. |
| cwd encoding | Replaces **only path separators** (`realpath` → strip trailing seps → strip leading `/` → each `/` run → `-`, then one leading `-`). `encode_claude_cwd` flattens every non-alphanumeric character and therefore **cannot** be reused: it would miss the directory for any path holding a dot, underscore or hyphen. |
| Turn end | A separate `agent_turn_outcome` record (`{turnId, reason, resultKind}`) with 17 `reason` values. There is no `stop_reason` field in the JSONL at all — that name appears in the binary only inside the bundled Anthropic SDK and in OTel attributes. Every outcome emits `turn_complete` whatever the reason: a cancelled turn has still stopped, and withholding the event parks the pane mid-turn forever. |
| Tokens | Absent per message (only an opaque `tokens` integer). The breakdown lives in the sidecar `<uuid>.settings.json` as a **running total**, so the reader differences it and keeps one replace-in-place marker rather than a key per line (GitHub #23). `thinkingTokens` is deliberately not added to output pending a real session. |
| Env | `DROID_PARENT_SESSION_ID` is droid's `CLAUDE_CODE_CHILD_SESSION`: inherited, a spawned pane becomes a child of the parent's session and silently writes no transcript of its own. Stripped via `home_env_vars`, along with `FACTORY_HOME_OVERRIDE` and `FACTORY_RUNTIME_SETTINGS_PATH`. |
| Terminal | Emits `ESC[?2004h` during startup (`bracketedPaste: true`) and never `ESC[?1049h` — it repaints the normal buffer, so `fullScreenTui` stays unset. |

Record shapes came from droid's own zod schemas and read loops inside the
250MB bundle, cross-checked against a real session file. `verifiedTurnText`
stays unset: no authenticated session has exercised the assistant/outcome path
yet.


### Managed credential destinations

Kilo and OpenCode declare `credential_path_env_vars`, `live_file_from_context`
and `fetch_usage_from_context`. Their launch helper reports only the declared
path inputs, effective home/cwd, and credential-override variable names over an
authenticated, single-use loopback connection after shell startup. Credential
values and the rest of the environment are never reported. The owning create
coroutine keeps the vendor lock through binding and the pre-login snapshot,
then releases the CLI with GO. It preserves the original logical command for
resume/history and does not override HOME or XDG_DATA_HOME.

Each vendor has one managed store. Vault reads/writes, credential-file watches
and native usage reads use that destination. Existing SQLite KV storage keeps
only canonical path, home, cwd and declared path inputs; launch tokens and
credential contents are not stored in that record. A saved destination is not
fresh proof for another pane. Account mutations require compatible launch
proof from every running pane of that vendor.

A clean installation can bind its first observed store. Upgrades must agree
with existing live credentials, the active slot and recorded ownership. An
ambiguous upgrade or a different destination leaves normal CLI execution
available but refuses account mutation with a reason. There is no store picker,
automatic replacement, credential migration or independent default per store.

The literal bash/zsh command seam recognizes native vendor executables and
package-declared entrypoints; arbitrary functions/scripts retain their original
shell command and error semantics without account-mutation authority. Native
Windows launches reuse the existing command parser and recognized npm `.cmd`
unwrapping; unknown batch wrappers keep their original launch. The Windows
helper waits for its child within the existing ConPTY job. Source helper tests
and platform substitutes do not certify a packaged build or real Windows
execution. Other ambient-path adapters still require explicit declarations and
same-launch coverage before this contract can be claimed for them.
