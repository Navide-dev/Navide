# Adding a CLI vendor

Navide supports one CLI agent per vendor file. Adding a vendor is a
self-contained PR: its declaration, two new spec files (found by their names;
nothing registers them, and the packaged backend collects them), and the test
lists and docs under [Other hand-kept lists](#other-hand-kept-lists).
You never need to read or modify the shared orchestration code.

## Declaration

How the CLI is launched and resumed (program, flags, environment, resume
syntax, label, kind) and where it sits in the app's lists is declared once,
in `native/navide-cli-runtime/src/vendors/<key>.rs`, and both spec files read
it through `declared(<key>)` instead of retyping it. Write that file first
and regenerate the two checked-in copies of the declarations
(`NAVIDE_DECLARATIONS_WRITE=1 cargo test --test checked_in` in the crate):
["Exactly which files a new CLI needs"](en-US/cli-extension-guide.md#exactly-which-files-a-new-cli-needs)
has the steps. Reading the CLI's records through the Rust runtime is a
separate, optional part of the same file, described in the section after it.

## Backend

1. Copy `backend/agent_team_backend/cli_vendors/_template.py` to
   `cli_vendors/<key>.py` (short lowercase key, e.g. `mycli`) and fill in
   the `SPEC`, spreading `**declared("<key>")` for the launch and resume
   fields. Every capability you leave at its default is treated as
   "unsupported" for your vendor — the app degrades gracefully.
2. Do not register it: `cli_vendors/registry.py` imports the module named
   after each declared key, in the order the declarations give
   (`order.registry`). The packaged app needs no entry either: the PyInstaller
   spec collects every module of the `cli_vendors` package
   (`collect_submodules`, with `on_error="raise"` so a module that fails to
   import fails the build instead of being left out), and
   `test_pyinstaller_spec.py` runs that collection, requires the registry
   module in it, and fails if a module on disk is not in it.
3. If the CLI writes local conversation logs, implement the log reader in
   your vendor file and set `make_log_reader`.
4. If you wrote a reader, add `backend/agent_team_backend/log_readers/<key>.py`
   as a re-export shim (copy any existing one): a spec that sets
   `make_log_reader` must have it. A CLI without a reader needs no file there
   (the empty placeholders of devin, kiro and mcode exist because main had
   them, and a test holds main's CLIs to their files). Listing the class in
   `log_readers/__init__.py` (`_MIGRATED_READERS` and `__all__`) is optional
   and nothing asks for it: it only lets `from agent_team_backend.log_readers
   import <Key>LogReader` resolve, so add it only if code imports the reader
   that way. A CLI listed in `_MIGRATED_READERS` is also checked to be a
   hidden import of the packaged app, which the whole-package collection
   already satisfies. Shipping no reader has one consequence worth knowing up
   front: Navide cannot learn the id of a session it started, so set
   `supports_session_resume=False` (it defaults to **True**) and leave
   `resumeArgs` out of the frontend spec — the two sides are cross-checked.
5. Set `memory_sources` on your `SPEC`, naming the instruction file your CLI
   reads (`AGENTS.md` for most). `native_memory.py` builds its table from the
   registry, so nothing there changes. Every vendor must have sources or be
   listed in `_CONFIGURED`; otherwise `test_native_memory` fails with a vendor
   in state `unknown`.
6. Add `backend/tests/vendors/test_<key>.py` covering what you implemented.
   Register executable cases and provenance-bearing fixtures in
   `tests/fixtures/cli-regression/catalog.json`, and add the frontend command
   contract under `tests/cli/`. The inventory must match both source registries;
   a missing, skipped or uncollected required case fails the regression gate.
   Exercise real Navide readers, attribution and launch wiring. Declare
   unsupported capabilities with negative assertions instead of inventing
   uniform capabilities or skipping the vendor. See
   [CI and CLI regressions](en-US/ci-and-cli-regression.md).
7. No edit to `backend/tests/vendors/test_install_deps_snapshot.py`: its
   `SNAPSHOT` is a recording of the entries that existed, compared by id and
   relative order only. Your own `Dep` is stated in your vendor file and
   covered by `tests/vendors/test_<key>.py`. (The other recording tests need
   no entry either: `test_cli_declarations.py`, `test_cli_vendors_registry.py`
   and `agents/__tests__/declared.test.ts` compare only the CLIs main had, and
   hold the declared ones to each other.)
   Pin your data roots there too: `test_risk_declarations.py` checks only
   that they resolve under the pane home, so the values of `data_dirs` are
   asserted by your own test file or by nobody.
8. Only if your spec sets `login_command_args`: add the key to the expected set
   in `backend/tests/test_login_spawn_command.py`.
9. Account switching is opt-in through `account_switch=AccountSwitchSpec(...)`
   on the spec, plus `slot_file` (the parked copy's file name). A spec without
   the declaration is never offered for switching and never inherits another
   vendor's behaviour. The fields the transaction and the UI read:
   - `auth_scope` — the credential pool. Two vendors declaring the same string
     share one switch lock and one impact set. For a per-provider store the
     declared value is the prefix; the runtime pool is `"<auth_scope>:<scope>"`
     (`cli_vendors.base.auth_scope_for`).
   - `method` — `hot` (the CLI re-reads its credential per request; panes keep
     running), `restart` (affected panes are stopped at a safe point, swapped,
     and resumed), or `manual` (the vault can park and restore, but the user
     must confirm a new conversation). Automatic switching is refused for
     `manual`, and for `restart` when `resume` is not `native`.
   - `store` — `file`, `compound-file` (one provider entry inside a shared
     document; needs `extract` / `merge`, and `scopes` listing every provider
     id a profile may bind to), `keychain` (`keychain_items` as
     `(service, account)` pairs, `live_file` as the non-macOS fallback),
     `pointer`, or `env`.
   - `evidence` — `live` (an A → B → A round-trip on an installed CLI,
     recorded against `verified_version`), `source` (read from the vendor's
     code or package), or `docs`. Anything but `live` is shown as unverified;
     it is never a reason to refuse a switch, and it must not be raised without
     the round-trip. Keep `platforms` to the tuple you actually established;
     `todo` names what is still open.
   - `verified_version` — the CLI version that evidence came from. The
     pane's startup probe says a newer installed CLI "has not been tested"
     against `VendorSpec.cli_verified_version` first (the version the
     integration as a whole — launch, logs, resume — was last checked on) and
     falls back to this one. Set `cli_verified_version` when it is newer than
     the account-switch evidence; a vendor without account switching sets only
     `cli_verified_version`.
   - `shadowing_env` — variable names the CLI ranks above the stored
     credential. A pane launched with one of them present is reported as not
     switchable rather than swapped.
   - Quota evidence: the backend trusts an exhaustion report only from its own
     per-account usage snapshot (`fetch_usage`) or from a text the vendor
     declared in `quota_exhausted_patterns`. A vendor declaring neither can
     only ever notify.
   - Sign-in isolation: set `login_home_env` (and `login_home_secret_file`)
     when the CLI can be pointed at a private home; the sign-in pane then
     runs there and the live credential is untouched. Without it the sign-in
     is *global*: the vault snapshots the live credential before the pane
     spawns, parks what the CLI wrote into the profile's slot afterwards and
     restores the snapshot. Say which one applies in the integration record.
   The structural test `backend/tests/test_account_switch_capabilities.py`
   checks the declaration; `backend/tests/test_quota_failover_api_contract.py`
   and `test_quota_failover_login_contract.py` exercise the switch and sign-in
   flows through the real handlers — add your vendor to their vendor lists
   when you declare `account_switch`.
10. Set `extensions` to say where the CLI keeps the CLI extensions it installs
    for itself (plugins, extensions, hooks; see the [glossary](en-US/glossary.md)),
    for the read-only inventory on Settings → Extensions. Declare an
    `ExtensionsSpec` of `ExtensionsSource` rows, each naming a reader in
    `backend/agent_team_backend/cli_extensions.py`, a path under the user's
    home and the vendor's own type label ("Codex hook"). A CLI with an
    extension system whose location you have not verified declares
    `ExtensionsSpec(supported=False, note=...)` rather than a guess; only a CLI
    with no extension system at all leaves it `None`, which hides it from the
    page, and says why in `extensions_none_reason`.
    `backend/tests/test_cli_extensions.py` fails for a vendor that declares
    neither. A CLI Navide lists without running it in a pane (Gemini
    CLI) is declared in `_UNMANAGED_CLIS` in `cli_extensions.py`; when it
    becomes a vendor, move that declaration onto its spec (the vendor spec
    wins while both exist).

11. A vendor whose hooks post to `/hooks/<key>` but which ships no log reader
    sets `hook_pane_token=True`: no session of it is ever attributed, so the
    spawn puts a per-pane token in the pane's environment
    (`NAVIDE_GUARD_PANE_TOKEN`), the hook command sends it as
    `X-Navide-Pane-Token`, and `cli_hook` names the pane by it. Only vendors
    declaring it are looked up this way (Kiro CLI is the first).

## Frontend

1. Copy `src/renderer/src/platform/plugin-shell/agents/_template.ts` to `agents/<key>.ts` and
   fill in the spec: `...declared('<key>')` for the label, default command,
   flags and resume syntax, then the capability flags — the template lists
   every optional field with pointers to the full docs in `agents/types.ts`.
2. Do not register it: `agents/index.ts` finds every spec file and lists it
   where the declaration says (`order.menu`). Whether the vendor is a CLI or
   an Agent ("Two kinds of vendors" in `docs/en-US/cli-extension-guide.md`)
   is the declaration's `kind`, which `declared()` hands to the spec. It
   picks the ＋ menu block the vendor is listed in.
3. Add a row to `vendors` in `src/renderer/src/components/CliAgentsHelp.vue`
   (Settings ▸ Help). It is a hand-maintained mirror, and
   `test_help_panel_sign_in_column_matches_login_command_args` compares its
   `signIn` column against every spec's `login_command_args`.
4. Update `src/renderer/src/components/__tests__/CliAgentsHelp.test.ts`: the
   table row count (asserted twice, once per locale), the sign-in command
   list, and the list of which cells render a `<code>` element.
5. Do not touch `plugins/navide-plans/src/retained/agentSpecs.ts`: the plans
   plugin keeps a frozen v1 copy of main's CLIs, and its test compares only
   the recorded keys against the live list. A new CLI is not added to v1.
6. Only if your spec declares `home_env_vars`: add each one to
   `SPAWN_ENV_RESERVED_KEYS` in
   `src/renderer/src/platform/plugin-shell/lib/cliLaunchOverride.ts`. This is
   product code, not a test list: a home relocator Navide sets itself must not
   be offered as a user-editable spawn env var, or the page promises an
   override that gets overwritten.
7. Nothing for a spec with no `skipPermissionFlag`: the flagless-vendor list in
   `src/renderer/src/platform/plugin-shell/lib/cliPermission.test.ts` is a
   recorded subset (the six main had), so a new flagless CLI is not added.
8. Run `pnpm vitest run src/renderer/src/platform/plugin-shell/agents` — the structural tests there
   check your spec against the rules the template states (key matches the
   filename, the file is listed, `resumeCommandPattern` matches the
   command Navide builds for you, no `/g` on a matcher). They need no edit
   when you add a vendor; they discover your file on their own.

## Other hand-kept lists

The steps above are not the whole set. A few lists also name every vendor, and
each one fails a test, not a build, when a new key is missing — so they are
easy to find only after a red run.

Most lists that used to name every vendor now derive from the declarations or
the vendor's own spec, or are recorded subsets (a test that holds main's CLIs
to their recorded values and leaves yours alone), so none of them is edited
for a new CLI. Found by declaring a throwaway CLI that was a copy of goose,
adapter files included, and running both suites (it was not committed). The
throwaway still needed these, and nothing else:

- its regression inventory entry and fixture:
  `tests/fixtures/cli-regression/catalog.json` and `<key>.json` beside it, and
  its row in `tests/cli/vendorContracts.test.ts` (the inventory tests fail
  until both name the CLI);
- the vendor count and list in `README.md`, `README.ja-JP.md` and
  `README.zh-TW.md` (`test_readmes_list_every_registered_vendor`), and a row in
  the `vendors` table of `CliAgentsHelp.vue`;
- the roster in `docs/en-US/cli-vendor-matrix.md`, the key list and an
  integration record in `docs/en-US/cli-extension-guide.md` (no test holds
  these; they go stale quietly).

What the CLI states in its own files, so no shared list changes:

- `memory_sources` on its `VendorSpec` (the instruction files Settings →
  Memory scans; `native_memory.py` assembles the table from the registry);
- a verified version (`cli_verified_version`, or the account-switch
  evidence), or `cli_unverified_reason` when it was wired from docs with no
  install to run;
- `data_dirs`, or `data_dirs_none_reason`, for `test_risk_declarations.py`;
- `extensions`, or `extensions_none_reason` (aider), for `test_cli_extensions.py`;
- `observed` in its Rust declaration: `helpCliFacts.ts` (`NO_LOG_READER`) and
  `submitTurnConfirm.ts` (`TURN_START_SIGNAL`) derive from it. It stands for
  three facts that agree today: the runtime declares the CLI's records, a
  Python reader exists (the registry test requires the two to be equal), and
  that reader reports turn starts. A CLI that breaks the equality (a reader
  that cannot report a turn start, or a Python reader shipped before its Rust
  declaration) needs a new declared field first; do not set `observed` to
  paper over it;
- its binary name: `CLI_NAMES` in the regression guard is built from each
  declaration's `launch.program`. A second name the CLI answers to (an alias
  or a legacy binary) is not declared anywhere: add it by hand to the alias
  set beside it in `backend/tests/cli_regression/support/isolation.py`, or
  the guard will not refuse a real run of it.

Still by hand, only when the fact applies: `MCP_WIRED` in `helpCliFacts.ts`
(held to the registry by `test_help_cli_facts_mirror_the_registry`). The ＋
menu in `ControlPane.vue` needs no edit: its scroller cap is a fixed budget.

Write the spec as `export const SPEC = { … } as const satisfies AgentSpec`,
never `SPEC: AgentSpec`: the annotation widens every literal in the spec. The
app-wide `AgentKey` union is the declared keys (`_cli_declarations.ts`, a
typed constant); a compile-time assertion in `agents/__tests__/specs.test.ts`
fails if it ever degrades to `string`.

## Where your vendor shows up in the UI

The declaration and the spec file are all the wiring there is — every surface
below reads the assembled list, so none of them needs an edit. What the list
is, though, passes through one filter that is easy to mistake for a bug:

```
agents/<key>.ts  →  agents/index.ts (found, in `order.menu`)  →  AGENT_SPECS / CLI_AGENT_SPECS
                                                          │
                        App.vue `enabledAgentSpecs` ──────┘
                        (user's Settings → CLI Agents order + disabled list)
                                     │
                                     ├─ ControlPane `manualAgentSpecs` — the ＋
                                     │  menu on a workspace heading, and
                                     │  "Handle Issue As…" (terminal filtered out)
                                     └─ everything else reads the unfiltered list:
                                        CliAccountsPane, TokenStatsPanel,
                                        DebugModal, PipelineManagerModal,
                                        AgentMessagesPanel, useTerminal
```

Three consequences worth knowing before you go looking for a missing entry:

- **The ＋ menu is a user-filtered subset, not the vendor list.**
  `useCliAgentPrefs` keeps a *disabled* list (a blocklist) and a custom
  *order*. A brand-new vendor appears with no action from the user: it is not
  in anyone's blocklist, and `orderedAgentKeys` appends keys it has never seen
  after the ordered ones. It lands at the END of the menu, which is where to
  look first. Both lists are per-workspace (`project.json` ui_state), with the
  global KV as the fallback — so a vendor can be visible in one workspace and
  hidden in another.
- **Not being installed does not hide a vendor.** The menu shows every enabled
  vendor and marks the missing ones with a badge (`missingClis`, refreshed on
  backend connect and on dropdown focus). So "it is in the menu" says nothing
  about whether the binary exists, and "it is missing from the menu" is never
  explained by a missing binary.
- **The renderer is a build artifact.** A newly registered vendor reaches a
  running app only after that app is rebuilt (packaged build) or its dev
  server restarted — and only if the branch it was added on is the one being
  built. Checking the menu of an installed release for a vendor that lives on
  a feature branch will always come up empty.

## Install detection

Set `install_dep=Dep(...)` in your vendor's `SPEC` (see any existing
vendor file) so Navide can detect, install, and update your CLI. The
onboarding wizard aggregates every vendor's entry automatically — no
other file to edit.

## The marketing site (`navide-web`)

The public site lists the supported CLIs, and it counts them by fetching this
very directory through the GitHub API — so a vendor appears there on its own
once the commit is on `main`, with no copy edit and no redeploy. Two things in
`src/vendors.ts` are still hardcoded and will lag:

- `ICONS` — an unlisted vendor falls back to the generic terminal glyph. Add
  `<key>: "/vendor-icons/<key>.svg"`, drop the official asset in
  `public/vendor-icons/` (downscale raster sources to 84 px; the frame renders
  at 38–42 px), and record where it came from in that directory's `README.md`.
- `LABELS` — an unlisted key is title-cased (`droid` → "Droid"), which is often
  right, but `LABELS` also *is* `FALLBACK`, the roster shown when the API call
  fails. Unauthenticated GitHub allows 60 requests/hour per IP, so that path is
  hit routinely, not rarely — a vendor missing from `LABELS` silently
  disappears from the site whenever the limit is reached.

Neither blocks the vendor from working; both make the site quietly wrong.

## Known exemptions

"No shared module carries per-vendor branches" holds for the orchestration
you go through when adding a vendor. Three places are deliberately outside
that rule — you do not need to touch them, but do not be surprised to find
vendor names there:

- **Credential vault** (`credential_vault.py`, `ws_handlers.py`'s hot-swap
  path). Account switching is per-vendor by nature — where a secret lives,
  whether a login home isolates it, how an identity is read out of it. A new
  vendor gets multi-account support by filling in the credential fields of its
  own `SPEC`; the vault's remaining `claude` branches are its own history.
- **`CODEX_HOME` per-pane isolation** (`ws_handlers.py`, `codex_home.py`).
  `CodexHomeManager` is owned by the app and injected into the spawn path, so
  moving it into `cli_vendors/codex.py` would invert the import direction that
  `cli_vendors/base.py` forbids. It stays put until the spawn path grows a
  hook that can express it.
- **Plugins** (`plugins/builtin/**`). Plugin wiring — MCP server injection,
  per-pane shim homes, skills — still branches on `agent_key` inside each
  plugin. Plugins are not part of the vendor contract: a new vendor works
  without touching them, and gains plugin-specific behaviour only if that
  plugin adds it.

Anything else that makes you edit a shared module to add a vendor is a gap in
the contract. Open an issue rather than adding a branch.

## Verify

```sh
uv --project backend run pytest backend/tests/test_cli_vendors_registry.py
uv --project backend run pytest backend/tests
pnpm test:run && pnpm typecheck
```

The registry test is your checklist for the files a CLI of main's kind keeps
(vendor module, log reader module, frontend spec): it fails naming the missing
file for every CLI main had, and holds yours to the declaration. The lists
under [Other hand-kept lists](#other-hand-kept-lists) are what is left to do
by hand. It also rejects forbidden imports (vendor modules may import only `base`,
`_declared`, `_protocols`, the standard library, and httpx — never another vendor
or any app module).

## Boundaries

- Never add `if agent_key == "<yours>"` branches to shared modules — put
  the behavior in your vendor file; if the contract in
  `cli_vendors/base.py` lacks a hook you need, open an issue first.
- Credential-vault behavior (`credential_vault.py`) is security-sensitive
  and not extensible from vendor files beyond the file-layout fields in
  the spec.
