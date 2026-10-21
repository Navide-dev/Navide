# CLI Vendor Matrix

A snapshot of every CLI agent Navide ships with, what each one declares it can
do, and where those facts live in the tree.

**Snapshot: 2026-10-20, commit `5c8b00ddc` (v0.2.27) — 15 vendors.** The
previous snapshot (2026-09-20, `9a630efe`, v0.2.8) was re-read field by field;
the roster, the backend and frontend matrices and their totals are unchanged.
New since then: the [support tiers](#support-tiers-l1l5) and the OpenCode 2.x
reader note.

This file is a reading aid, not a source of truth. The tree is. Every number
below was read out of the files named beside it, and the
[Regenerating this file](#regenerating-this-file) section gives the commands
that reproduce each table, so a stale entry is always cheap to catch.

- To **add** a vendor, follow [Adding a CLI vendor](../adding-a-cli-vendor.md).
- For the **research and traps** behind an individual integration, see the
  [CLI integration records](cli-extension-guide.md).

---

## The count

| Side | Count | Source of truth |
|---|---|---|
| Backend vendor modules | 15 | `backend/agent_team_backend/cli_vendors/<key>.py` |
| Backend registry | 15 | `cli_vendors/registry.py` — the `_ALL` tuple, then `VENDORS` |
| Frontend specs | 15 + `terminal` | `src/renderer/src/platform/plugin-shell/agents/index.ts` — the `ORDERED` array |

Runtime registries derive from `VENDORS` or `ORDERED`: install detection
(`onboarding_deps.py`), quota polling
(`usage_service.py`), skills (`skills_store.py`), profiles
(`profiles_store.py`), credential watching (`credential_watcher.py`), log
reader collection (`app.py`), and the `AgentKey` union on the frontend.
The Help table, retained plans-plugin specs and frontend environment deny list
are manually synchronized mirrors; see the [vendor checklist](../adding-a-cli-vendor.md).

`terminal` is a plain shell, not a vendor: it carries an empty
`defaultCommand` and is filtered out of `CLI_AGENT_SPECS`. Files whose name
starts with `_` (`_template`, `_protocols`) are infrastructure and are ignored
by both the registry and the tests.

### How the two sides stay equal

`backend/tests/test_cli_vendors_registry.py` scans the frontend `agents/*.ts`
files for their `agentKey` literals and asserts that, once
`NON_VENDOR_AGENT_KEYS` (`terminal`) is removed, the set matches
`registry.VENDORS` exactly. A vendor registered on one side only fails CI with
a message naming the list that was missed. The same test also rejects a vendor
module that imports another vendor or any app module.

Display order differs on purpose: the backend tuple is alphabetical, and
`ORDERED` is the order the user sees in the UI.

---

## Roster

Ordered as the UI lists them (`agents/index.ts`). Display labels reviewed on
2026-09-21; the capability snapshot above is unchanged. Publisher suffixes are
Navide presentation choices, not part of official product names. Renaming a
label does not upgrade a CLI or establish compatibility with a newer release.

| Key | Label | Command executed | Install route |
|---|---|---|---|
| `claude` | Claude Code (Anthropic) | `claude` | `npm i -g @anthropic-ai/claude-code` |
| `codex` | Codex CLI (OpenAI) | `codex` | `npm i -g @openai/codex` |
| `antigravity` | Antigravity CLI (Google) | **`agy`** | install script (antigravity.google) |
| `grok` | Grok Build (SpaceXAI) | `grok` | install script (x.ai) |
| `kimi` | Kimi Code CLI (Moonshot AI) | `kimi` | install script (code.kimi.com) |
| `opencode` | OpenCode (Anomaly) | `opencode` | install script (opencode.ai) |
| `qwen` | Qwen Code (Alibaba Cloud) | `qwen` | `npm i -g @qwen-code/qwen-code` |
| `kilo` | Kilo Code CLI | `kilo` | `npm i -g @kilocode/cli` |
| `pi` | Pi | `pi` | `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` |
| `copilot` | GitHub Copilot CLI | `copilot` | `brew install --cask copilot-cli` |
| `cursor` | Cursor CLI | **`agent`** (alt: `cursor-agent`) | vendor installer |
| `aider` | Aider | `aider` | install script (aider.chat) |
| `muse` | Muse Code (Meta) | `muse` | install script (dev.meta.ai) |
| `droid` | Droid CLI (Factory) | `droid` | `brew install --cask droid` |
| `mcode` | MiniMax Code | `mcode` | `npm i -g @minimax-ai/code` |

Two keys do not match their binary: `antigravity` runs `agy`, and `cursor` runs
`agent` (`cursor-agent` is an older symlink the installer leaves behind, and is
accepted as an alternate). Assuming key == command is the most common way to
misdiagnose "the CLI is not installed".

---

## Support tiers (L1–L5)

A tier says how much of Navide's pane machinery a vendor's spec declares.
Tiers are cumulative: a vendor sits at the highest level whose test it passes
**and** whose lower levels all pass. Each test is one field (or one list) in
the tree, so a tier is re-derived, never judged:

| Tier | Meaning | Test in the tree |
|---|---|---|
| **L1 Launch** | Detected, installable, opens a pane | backend `install_dep` + frontend `defaultCommand` |
| **L2 Turn-aware** | Navide sees when a turn ends, so a delivered message's turn can be awaited | backend `make_log_reader` (every reader emits `turn_complete`) |
| **L3 Session-bound** | A pane is matched to the CLI session it started | frontend `needsSessionMarker: true` or `pinsSessionIdAtLaunch`; codex instead binds through its SessionStart hook (`codex_session_hooks.py`) |
| **L4 Resumable** | Restore, rebuild and account-switch restarts return to the same conversation | backend `supports_session_resume` not `False` + frontend `resumeArgs` + `supportsRebuild: true` |
| **L5 Guarded** | A hook reports into Navide, and Navide Guard can block a tool call before it runs | vendor is in `guard_hooks.VENDORS` (`guard_hooks.py:66`) |

| Key | Tier | L2 reader | L3 binding | L4 resume | L5 hook | Awaiting-input signal | Version on record |
|---|---|---|---|---|---|---|---|
| `claude` | **L5** | `claude.py:1567` | session id pinned at launch (`claude.ts:43`) | `claude.ts:17-18` | `install_hooks` (`claude.py:1490`) | screen (`claude.ts:106`) + Notification hook | 2.1.278 (`claude.py:1544`) |
| `codex` | **L5** | `codex.py:1905` | SessionStart hook (`codex.ts:18` sets no marker) | `codex.ts:15,20` | per-launch `-c hooks.PreToolUse` (`codex_session_hooks.py`) | screen (`codex.ts:60`) | 0.155.1 (`codex.py:1884`) |
| `copilot` | **L5** | `copilot.py:1539` | marker (`copilot.ts:28`) | `copilot.ts:27,31` | `install_hooks` (`copilot.py:1532`) | `notification` hook (`copilot_hooks.py`) | 1.0.81 (`copilot.py:1507`) |
| `qwen` | **L5** | `qwen.py:979` *(silence)* | marker (`qwen.ts:14`) | `qwen.ts:13,16` | `install_hooks` (`qwen.py:946`) | Notification hook (`qwen_hooks.py`) | 0.22.2 (`qwen.py:966`) |
| `antigravity` | L4 | `antigravity.py:895` | marker (`antigravity.ts:16`) | `antigravity.ts:15,19` | — | screen (`antigravity.ts:45`) | 1.2.7 (`antigravity.py:873`) |
| `grok` | L4 | `grok.py:881` | session id pinned at launch (`grok.ts:59`) | `grok.ts:49,75` | — | trust prompt only (`grok.ts:70`) | 1.0.34 (`grok.py:858`) |
| `kimi` | L4 | `kimi.py:684` *(`turn.ended`, silence fallback)* | marker (`kimi.ts:23`) | `kimi.ts:14,25` | — | — | 0.39.0 (`kimi.py:669`) |
| `opencode` | L4 | `opencode.py:1161` *(1.x and 2.x schemas)* | marker (`opencode.ts:32`) | `opencode.ts:31,34` | — | — | 1.15.12 (`opencode.py:1134`) |
| `kilo` | L4 | `kilo.py:438` | marker (`kilo.ts:33`) | `kilo.ts:32,35` | — | — | 7.4.22 (`kilo.py:404`) |
| `pi` | L4 | `pi.py:915` *(silence)* | marker (`pi.ts:20`) | `pi.ts:19,23` | — | — | 0.84.0 (`pi.py:895`) |
| `cursor` | L4 | `cursor.py:895` | marker (`cursor.ts:21`) | `cursor.ts:20,26` | — | — | 2026.08.25-3e8eec8 (`cursor.py:866`) |
| `muse` | L4 | `muse.py:820` | marker (`muse.ts:55`) | `muse.ts:49,56` | — | — | 1.3.0 (`muse.py:809`) |
| `droid` | L4 | `droid.py:596` | marker (`droid.ts:47`) | `droid.ts:22-23` | — | — | 0.206.0 (`droid.py:575`) |
| `aider` | L3 | `aider.py:694` | marker (`aider.ts:35`) | ❌ `supports_session_resume=False` (`aider.py:666`) | — | screen (`aider.ts:49`) | 0.86.2 (`aider.py:680`) |
| `mcode` | L1 | ❌ no reader (`mcode.py:335-338`) | — | ❌ `supports_session_resume=False` (`mcode.py:339`) | — | — | 0.4.12 (`mcode.py:365`) |
| **Total** | L5 ×4, L4 ×9, L3 ×1, L1 ×1 | 14 | 14 | 13 | 4 | 5 screen, 3 hook | 15 |

Paths are relative to `backend/agent_team_backend/cli_vendors/` (`.py`),
`backend/agent_team_backend/` (`*_hooks.py`) and
`src/renderer/src/platform/plugin-shell/agents/` (`.ts`).

How to read the columns:

- **A tier is declared capability, not a compatibility promise.** It says what
  the spec wires up. It does not say the vendor's current release still
  behaves the way the spec was written against.
- **"Version on record" is not a live test.** It is
  `AccountSwitchSpec.verified_version`, and every one of the 15 adapters
  records `evidence="source"`: the layout was read from the vendor's shipped
  code or package, not exercised in a live A → B → A switch (see the
  `evidence` field comment in `base.py`). No spec in the tree carries a
  live-verified version. A local `--version` newer than this column is
  untested by Navide.
- ***(silence)*** marks the readers that infer a turn's end from a quiet
  window instead of reading an end-of-turn record (frontend
  `turnEndInferredFromSilence: true` in `kimi.ts:22`, `pi.ts:21`,
  `qwen.ts:15`). A long tool call can look like a finished turn there. Kimi
  Code writes a `turn.ended` record (0.39.0 and 2.2.0, recorded live), which
  the reader acts on at once; the quiet window remains its fallback for older
  wire files, which is why the flag stays set.
- **Kimi Code vs the archived kimi-cli.** Both install a `kimi` binary. The
  Python MoonshotAI/kimi-cli (1.x, archived) prints `kimi, version 1.52.0`;
  Kimi Code prints a bare version. Kimi's `official_regex` names the mismatch
  in the pane's startup probe line and points at the Kimi Code installer; the
  launch is not refused.
- **Turn text is validated for two vendors only.** `verifiedTurnText: true`
  is set in `claude.ts:19` and `codex.ts:21`; every other reader's turn text
  is enough for inter-CLI messaging but keeps the loose buffer scan.
- **Awaiting-input** is the signal that the CLI is parked on the user. "screen"
  is a frontend `awaitingInput` pattern; "hook" is a Notification-type hook.
  A dash means Navide cannot tell "waiting for you" from "idle" for that
  vendor. Grok's pattern matches its folder-trust prompt only.
- **OpenCode 2.x.** The reader detects the schema by its tables and reads
  2.x's `session_v2` / `session_message` when they exist (`opencode.py:26-31`,
  `_V2_TABLES` at `opencode.py:160`). The 2.x path was built from the
  upstream source; it has not been run against a real 2.x binary.
- **Account switching is declared for all 15.** Every spec carries an
  `AccountSwitchSpec`, so switching does not separate the tiers.

### ACP

No vendor is driven over the Agent Client Protocol: Navide runs every CLI as
an interactive TUI on a PTY, and none of the tier tests above involves ACP.
Two readers meet ACP artifacts on disk:

- `cursor.py:32` deliberately ignores `~/.cursor/acp-sessions/<id>/store.db`
  (ACP mode).
- `grok.py:7` reads Grok's `updates.jsonl`, which holds ACP `session/update`
  notifications, as the transcript.

---

## Backend capability matrix

Read from each `cli_vendors/<key>.py` `SPEC`. **A field left unset means
"unsupported for this vendor"** — the app degrades around it rather than
falling back to another vendor's behaviour, so an empty cell is a deliberate
statement, not a gap to fill in from a guess.

| Key | `mcp_wiring` | Skills | `fetch_usage` | Session resume | `supports_model` | `supports_effort` | `push_channel` | `install_hooks` |
|---|---|---|---|---|---|---|---|---|
| `claude` | ✅ | ✅ | — *(see note)* | ✅ | ✅ | ✅ | ✅ | ✅ |
| `codex` | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| `antigravity` | ✅ | ✅ | ✅ | ✅ *(path preflight)* | ✅ | ✅ | — | — |
| `grok` | ✅ | ✅ | ✅ | ✅ *(path preflight)* | ✅ | — | — | — |
| `kimi` | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| `opencode` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| `qwen` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| `kilo` | ✅ | ❌ *(explicit `False`)* | ✅ | ✅ | ✅ | — | ✅ | — |
| `pi` | — | ✅ *(`flag="--skill"`)* | ✅ | ✅ | ✅ | ✅ | — | — |
| `copilot` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `cursor` | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| `aider` | — | ❌ *(explicit `False`)* | — | ❌ *(explicit `False`)* | — | — | — | — |
| `muse` | — | ✅ | — | ✅ | ✅ | ✅ | — | — |
| `droid` | — | — | — | ✅ | — | — | — | — |
| `mcode` | — | — | — | ❌ *(explicit `False`)* | — | — | — | — |
| **Total** | **10** | **11** | **10** | **13** | **12** | **5** | **4** | **3** |

Notes on the cells that are easy to misread:

- **`claude` has no `fetch_usage` by design.** `usage_service.py` states it in
  its module docstring: Navide issues no quota request for Claude Code at all,
  and reads the CLI's own `/usage` panel instead (`claude_cli_usage`), so the
  request is made under Claude Code's own identity. The Anthropic
  `api/oauth/usage` endpoint is still called — but for the OAuth grants that
  `opencode` and `pi` keep in their own auth files, where there is no vendor
  CLI to delegate to.
- **Explicit `False` versus unset.** `aider` and `kilo` write
  `skills_supported=False`; `droid` simply omits the field. The effect is the
  same today, but the explicit ones record a verified answer (aider's package
  never mentions "skill" at all), while the omission records nothing.
- **Two vendors declare no session resume, for opposite reasons.** `aider`
  has no session id concept at all — its resume takes a chat-history path — and
  the frontend excludes it from rebuild for the same reason. `mcode` does have
  ids (`--session <id>`), but nothing can yet learn the id of a session Navide
  started, because its SQLite reader is not implemented; that
  entry should disappear when the reader lands.
- **Resume shape varies.** `antigravity` and `grok` parse explicit session IDs
  through `resume_id_from_command`, while existence checks still use
  `session_path` without a custom `session_exists`. Grok title-based resume
  does not produce a parsed session ID.
- **Every vendor declares `install_dep`.** All but `mcode` also ship a log
  reader (`make_log_reader`); `mcode` carries the empty `log_readers/`
  placeholder the contract allows, pending authenticated session fixtures to
  validate a reader for its SQLite message payloads.
- **`portable_credential` is `claude`-only.** No other vendor declares a
  portable credential today.

---

## Frontend spec matrix

Read from each `agents/<key>.ts`. These fields shape the argv Navide builds.

| Key | Permission-bypass flag | Resume syntax | `supportsRebuild` | `supportsRestorePin` |
|---|---|---|---|---|
| `claude` | `--dangerously-skip-permissions` | `--resume <id>` | ✅ | ✅ |
| `codex` | `--dangerously-bypass-approvals-and-sandbox` | `resume <id>` | ✅ | ✅ |
| `antigravity` | `--dangerously-skip-permissions` | `--conversation <id>` | ✅ | — |
| `grok` | — *(deliberate)* | `-r <id>` | ✅ | — |
| `kimi` | `--yolo` | `--session <id>` | ✅ | — |
| `opencode` | — *(TUI has no such flag)* | `--session <id>` | ✅ | — |
| `qwen` | `--yolo` | `--resume <id>` | ✅ | — |
| `kilo` | `--auto` | `--session <id>` | ✅ | — |
| `pi` | — *(no permission system)* | `--session-id <id>` | ✅ | ✅ |
| `copilot` | `--yolo` | `--resume=<id>` | ✅ | — *(deliberate)* |
| `cursor` | `--force` | `--resume=<id>` | ✅ | — |
| `aider` | `--yes-always` | — *(no resume)* | — | — |
| `muse` | `--disable-approval` | `resume <id>` | ✅ | — |
| `droid` | `--auto high` | `--resume <id>` | ✅ | — |
| `mcode` | — *(setting, not a flag)* | — *(needs a reader)* | — | — |

The four vendors with no bypass flag each carry a comment explaining why, so
the blank is not mistaken for an oversight: `grok` has `--always-approve` but
Navide deliberately does not pass it, `opencode`'s TUI has no such flag,
`pi` has no permission system to bypass, and `mcode` controls permission mode
through its settings instead of an interactive launch flag.

---

## Display label alignment

Frontend specs, backend specs and installation entries, retained Plans specs,
and the Help vendor table use the roster labels above. This also resolves the
former backend `Antigravity` / frontend `Antigravity CLI` mismatch. Keep these
display declarations synchronized; vendor identity and runtime routing remain
key-based. Historical and custom pane names are not migrated.

---

## Regenerating this file

Each table has a command that reproduces it. Run them from the repo root.

Vendor modules and registry:

```sh
ls backend/agent_team_backend/cli_vendors/*.py \
  | grep -v '/_' | grep -v '__init__\|base.py\|registry.py'
sed -n '/^_ALL/,/^)/p' backend/agent_team_backend/cli_vendors/registry.py
```

Frontend roster and display order:

```sh
sed -n '/^const ORDERED/,/as const/p' \
  src/renderer/src/platform/plugin-shell/agents/index.ts
```

Backend capability matrix — presence of a field, per vendor:

```sh
cd backend/agent_team_backend/cli_vendors
for f in aider antigravity claude codex copilot cursor droid grok kilo kimi \
         mcode muse opencode pi qwen; do
  printf "%-12s" "$f"
  for cap in mcp_wiring skills_supported fetch_usage supports_model \
             supports_effort push_channel supports_session_resume install_dep; do
    printf " %s:%s" "$cap" "$(grep -c "^\s*$cap=" "$f.py")"
  done
  echo
done
```

A `1` means the field is written, not that it is `True` — check
`skills_supported=` and `supports_session_resume=` for the vendors that set
them explicitly to `False`.

Frontend spec matrix:

```sh
cd src/renderer/src/platform/plugin-shell/agents
grep -H "label:\|defaultCommand:\|skipPermissionFlag:\|supportsRebuild:\|supportsRestorePin:" *.ts
```

Support tiers — the fields each tier test reads, and the version on record:

```sh
cd backend/agent_team_backend/cli_vendors
grep -nE "^\s*(make_log_reader|supports_session_resume|install_hooks)\s*=" *.py
grep -nE "verified_version\s*=|evidence\s*=" *.py
grep -n "^VENDORS" ../guard_hooks.py
cd ../../../src/renderer/src/platform/plugin-shell/agents
grep -nE "^\s+(needsSessionMarker|pinsSessionIdAtLaunch|resumeArgs|supportsRebuild|awaitingInput|turnEndInferredFromSilence|verifiedTurnText)\??:" *.ts
```

And the check that keeps both sides equal:

```sh
uv --project backend run pytest backend/tests/test_cli_vendors_registry.py
```
