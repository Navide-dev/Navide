# CLI Vendor Matrix

A snapshot of every CLI agent Navide ships with, what each one declares it can
do, and where those facts live in the tree.

**Snapshot: 2026-09-20, commit `9a630efe` (v0.2.8) + the mcode addition — 15 vendors.**

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

And the check that keeps both sides equal:

```sh
uv --project backend run pytest backend/tests/test_cli_vendors_registry.py
```
