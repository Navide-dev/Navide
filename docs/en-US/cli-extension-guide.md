# CLI Integration Records

Integration records for Navide's built-in CLI agents: the research behind
each one and the traps found while wiring it.

**To add a new CLI, follow [Adding a CLI vendor](../adding-a-cli-vendor.md)**
rather than this file. That guide tracks the current architecture and the
checks CI enforces; the records in Part 2 here predate it and name files that
have since moved.

Current built-in agent keys are `claude`, `codex`, `antigravity`, `grok`,
`kimi`, `opencode`, `qwen`, `kilo`, `pi`, `copilot`, `cursor`, `aider`,
`muse`, `droid`, and `mcode`. One key identifies a vendor on both sides — `agentKey`
in the frontend, `agent_key` in the backend.

The [vendor matrix roster](cli-vendor-matrix.md#roster) lists the current UI
labels. Publisher suffixes are Navide presentation choices; they do not alter
vendor keys, commands, install routes, or compatibility. Display labels are
kept aligned across frontend and backend specs, installation entries, retained
Plans specs, and Help. Historical research below retains its original product
names and does not prescribe current menu labels.

---

## Part 1 — Where the code lives

Since the one-file-per-vendor refactor (July 2026) an integration is two
vendor files plus one registration line on each side. No shared module
carries per-vendor branches, and CI rejects a vendor module that imports
another vendor or any app module.

| Layer | File |
|-------|------|
| Backend spec — credentials, usage, resume, session paths, spawn env, log reader, install entry | `backend/agent_team_backend/cli_vendors/<key>.py` |
| Backend registration | `backend/agent_team_backend/cli_vendors/registry.py` |
| Frontend spec — label, command, resume syntax, capability flags | `src/renderer/src/platform/plugin-shell/agents/<key>.ts` |
| Frontend registration + display order | `src/renderer/src/platform/plugin-shell/agents/index.ts` |

Everything the old layer-by-layer checklist enumerated now derives from those
four:

- `AgentKey` is re-exported from `agents/index.ts`; `data/stages.ts` holds no
  hand-written union to drift.
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

Account switching (added 2026-09-21) is declared the same way: an
`AccountSwitchSpec` on the vendor spec names the credential pool, the switch
method (`hot` / `restart` / `manual`), the store layout with its provider
scopes, the evidence the layout rests on (`live` / `source` / `docs` plus the
version it was read from), and the environment variables that shadow the
stored credential; `quota_exhausted_patterns` is the only CLI text the backend
accepts as an exhaustion signal, and `login_home_env` decides whether a
sign-in pane is isolated or runs against the live store. Step 9 of the vendor
guide lists the contract. As of this writing all fifteen vendors carry
`evidence="source"` — no real-account round-trip has been recorded; MiniMax
Code's adapter (region-scoped compound file plus a companion `auth-state`
write, no session resume) is the newest.

---

## Part 2 — Integration records

Written against the pre-refactor layout: paths such as `lib/agentSpecs.ts`,
`log_readers/<cli>.py` and the `ws_handlers.py` agent whitelist no longer
exist as described, and the per-layer instructions are superseded by Part 1.
What remains valid — and is recorded nowhere else — is the per-vendor
research: install routes, resume syntax, session storage formats, token
accounting, and the trap each CLI hides.

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
