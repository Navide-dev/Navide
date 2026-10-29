# Navide — Historical Master Spec and Milestone Record

> This file preserves historical implementation milestones. It is no longer the single source of truth for current capabilities or future plans. Use the [documentation index](README.md), [architecture](architecture.md), [user guide](user-guide.md), and [product roadmap](roadmap.md). Active implementation work is tracked by `.cursor/plans/*.plan.md`.

**Historical record reviewed**: 2026-07-15

---

## 1 · TL;DR

Historical foundation of Navide's AI-native macOS engineering environment for **13 supported coding CLIs**, driven by configurable pipelines, parallel agent sessions, private project history, and precision engineering surfaces.

```
Tech stack: Electron 33 + Vue 3 + TypeScript + FastAPI + Python 3.12 + xterm.js + Monaco
Status: historical milestones below; current plans and test counts change continuously
```

---

## 2 · Status snapshot

| Layer | Status | Notes |
|---|---|---|
| App shell (Electron + Vue + FastAPI) | ✅ Stable | 3 windows · WS auto-reconnect · backend health badge |
| PTY service | ✅ Stable | stdlib `pty` · 50ms batch · 64KB cap |
| Pipeline engine | ✅ Stable | Stages × slots (parallel agents) · sentinel + idle + analyzer detection |
| Token tracking | ✅ Stable | Real (from CLI JSONL logs) · workspace-scoped · dedup-persistent |
| Roles / Stages / MCP management | ✅ Stable | Settings modal · live reload · external editor windows |
| Local LLM analyzer | ✅ Stable | llama.cpp + Ollama blobs · benchmark · auto-answer |
| Doc injector (Context7) | ✅ Stable | LLM relevance filter |
| Claude Code hooks integration | ✅ Stable | `claude_hooks.py` auto-installs into `~/.claude/settings.json` on backend startup · `/hooks/claude` endpoint live |
| Activity event system | ✅ Stable | `log_readers.ActivityEvent` + `parse_activity` · consumed by History timeline |
| Multi-signal idle detection | ✅ Stable | raw PTY + analyzer + 10-min threshold in App.vue watcher |
| History tab on right panel | ✅ Stable | `history_store.py` + `HistoryPanel.vue` · append-only JSONL timeline · filter / expand / export / auto-scroll (M10) |
| Preview tab on right panel | ✅ Stable | `preview/PreviewPanel.vue` · read-only host reusing `FilePreviewPane` (11 kinds), `DiffPane` (readonly), markdown/mermaid and inline snippet/HTML · fed by Explorer context menu, `ui.preview.show` (MCP / plugins) and `⌥⌘V` |
| Workspace-first entry + mode-aware UI | ✅ Stable | `recent_workspaces.py` + `Welcome.vue` · recent list + pin · pipeline/spawn/completed mode (M11) |
| Manager pattern + pre-spawn team | ✅ Stable | default execution model: pre-spawn all slots (role only) → activate per stage · `isManager` slot + dispatch/ask/stage-done router (M13) |
| Frontend tests | ✅ Stable | Vitest 63 (buffer/stages pure fns + 3 composables w/ mock backend) + Playwright 2 (Electron launch + Welcome→workspace smoke) (M14) |
| Git panel (source control tab) | ✅ Stable | `git_service.py` + `useGit.ts` + `GitPane.vue`; Pipeline/Git top tabs in ControlPane |
| Cross-agent route engine | 📋 Directional | See [Product Roadmap](roadmap.md) |

Legend: ✅ shipped & stable · 🟡 in working tree but not yet released · 📋 planned, detail plan exists · ❌ identified gap, no plan yet

---

## 3 · Completed milestones (chronological)

### M1 · Foundation — `commits 1-5`
**Status**: ✅ Done

- Electron 33 main process spawns Python backend on free port
- WebSocket envelope (id-correlated request/response + broadcast events)
- xterm.js terminal pane + `useBackend` / `useTerminal` composables
- Dynamic grid (1/2/3 columns auto-fit)
- Control sidebar (Workspace, Agent picker, Active panes list)

### M2 · Pipeline & Multi-agent — `commits 6-11`
**Status**: ✅ Done

- Stages with parallel **slots** (1 stage = N agents); all slots emit sentinel → advance
- Per-run log directory `.agent-team/runs/{run-id}/`
- Workspace + `project.json` per-workspace state
- Configurable SDLC pipeline; included stages cover Requirements / Planning / Design / Build / Security Review / Testing
- `pipeline.{start,resume,abort,complete,stage_spawn}` WS handlers

### M3 · Dynamic registries + Settings — `commits 12-19`
**Status**: ✅ Done

- Roles registry (`roles_store.py`, persisted to `~/Library/Application Support/Agent-Team/roles.json`)
- Stages registry (`stages_store.py`, slots-based schema)
- Stage / Role manager — first as separate windows, later unified in **Settings modal** (4 tabs: Roles / Stages / MCP / Analyzer)
- Live broadcast: any change → `roles.changed` / `stages.changed` events to all open windows

### M4 · Token tracking — `commits 15-18`
**Status**: ✅ Done

- Right collapsible panel `TokenStatsPanel.vue`
- **Two data sources** evolved over time:
  - V1: PTY regex scrape (`vendor_parsers.py`) — deleted
  - V2: direct read of provider-owned logs or databases through `log_readers/`
- **Attribution**: workspace ↔ CLI folder association, persistent (`workspace-associations.json`)
- **Persistence**: per-workspace `.agent-team/tokens.json` + global · event-level dedup (`recorded-event-keys.json`)
- Real numbers from CLI billing logs — same data Anthropic/OpenAI/Google use to bill

### M5 · MCP + Doc injection + Analyzer benchmark — `commits 20-22`
**Status**: ✅ Done

- MCP server lifecycle (`mcp_manager.py` + `mcp_settings.py`) with live start/stop/reload
- Doc Injector (`doc_injector.py`) — Context7 fetch + LLM relevance pass + injection into kickoff
- Analyzer benchmark — test which Ollama model can handle the classify role; persist results

### M6 · Quality gates v1 — `commits 23-25`
**Status**: ✅ Done (partial)

- `Strict mode` toggle (idle/cap timeouts → confirm vs auto-advance)
- GitHub Actions secret-scan workflow
- README security notes
- 114 backend pytest passing

### M7 · Claude Code Hooks
**Status**: ✅ Done · file: `claude_hooks.py`

- Installer auto-merges into `~/.claude/settings.json` on backend startup (`PreToolUse` / `Stop` / `Notification` / `SubagentStop` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure`)
- Hook commands curl to `/hooks/claude` endpoint — most reliable "is agent working?" signal
- Incoming hook payloads feed the ActivityEvent stream
- The `Stop` hook is also a delivery channel: its response may answer `{"decision": "block", "reason": <envelope>}` to hand a queued inter-CLI message to the agent without typing it (`hook_drain.py`; see `inter-cli-messaging.md`)

### M8 · Activity Event system
**Status**: ✅ Done · files: `log_readers/{base,claude,codex,gemini}.py`

- `ActivityEvent` type alongside `TokenUsage`; `agent_active` / `turn_complete` from JSONL
- Consumed by App.vue watcher + History timeline (M10)

### M9 · Multi-signal idle detection
**Status**: ✅ Done · files: `useTerminal.ts` · `App.vue` watcher · `TerminalPane.vue`

- Stage idle threshold 90s → 10 min · raw PTY activity tracked separately (spinners count)
- Idle hit → multi-signal probe (raw + analyzer) before stall
- Pane status differentiates `running` (green) from `idle` (yellow, alive at prompt)

### M10 · Right-panel History timeline — `feat/history-tab`
**Status**: ✅ Done · files: `history_store.py` · `useHistory.ts` · `HistoryPanel.vue`

- Right panel switches between Token stats and **History** tab
- Append-only structured JSONL per run → `.agent-team/runs/{run-id}/history.jsonl`
- Event taxonomy: pipeline / stage / pane / question / analyzer / handoff / warning
- Timeline UI: type+stage filter · search · click-to-expand detail · export `.jsonl`
- **Stick-to-bottom auto-scroll** — follows newest event, pauses when user scrolls up

### M11 · Workspace-first entry + mode-aware UI — `feat/recent-workspaces-store`
**Status**: ✅ Done · files: `recent_workspaces.py` · `useRecentWorkspaces.ts` · `Welcome.vue`

- **Welcome screen** gates the main UI on launch (VS Code "Open Folder" style)
- Recent-workspaces store (`recent-workspaces.json`): list/touch/pin/unpin/remove · pinned-first · max-20 cap · `exists` flag for stale folders · atomic write + corrupt recovery
- WS handlers `workspace.list_recent / touch / pin / unpin` · broadcast `workspace.recent_changed`
- Mode detection from `project.peek` → pipeline / spawn / completed drives ControlPane emphasis
- Switch / close workspace with running-pipeline guard

### M12 · Reliability hardening
**Status**: ✅ Done

- **Injection no-drop** (`terminals.py` + `App.vue injectText`): per-session input buffer + `add_writer` drain handles EAGAIN/partial-write; frontend tail-verifies and resends instead of betting on a fixed delay
- **Analyzer question-intent**: `SYSTEM_PROMPT` tightened so an agent that lists options and goes quiet is read as `question`, not `in_progress` (no more force-poll loop to the 15-min cap)

### M13 · Manager pre-spawn orchestration — `Pipline` / `StageManage`
**Status**: ✅ Done · files: `App.vue` (`preSpawnStage` · `activateStage` · `StageRouter` · `parseDispatchBlocks` · `injectManagerPane`) · `stages.ts` (manager/worker protocols)

- **This is the team-preconfig plan's core, already shipped & live as the default execution model** (the plan frontmatter still said "pending" — stale; this spec wins per §8)
- `onPipelineStart` → `preSpawnStage` spawns only the first stage's slots (role prompt only); `activateStage(N)` injects the kickoff at activation time and warms stage N+1 in the background (`prewarmNextStage`), so at most two stages of CLIs are alive at once; a finished stage's panes are demoted to cold-restore placeholders on handoff (5cf510945)
- Manager pattern: a slot flagged `isManager` runs the Manager protocol; `StageRouter` watches its pane for `---DISPATCH-START---` / `---ASK-START---` / `---STAGE-DONE---` and routes to worker panes
- Cross-stage context handoff via `buildStageContext(forManager)` + `injectManagerPane`
- **Dropped as out-of-scope**: per-workspace `team-config.json` overlay + ControlPane Team-preview/editor (plan phases 1-4). The global Stages registry (`is_manager` slot flag in Settings → Stages) already covers team setup; per-workspace overrides judged unnecessary. Plan retired.

### M14 · Frontend test infrastructure (F6)
**Status**: ✅ Done · files: `vitest.config.ts` · `playwright.config.ts` · `src/renderer/src/**/__tests__/` · `e2e/launch.spec.ts`

- **Vitest 2.x** (Vite-native): 63 tests
  - `lib/buffer.ts` (37) — question/sentinel/option parsing, the pipeline-detection core
  - `data/stages.ts` (12) — manager/worker protocol rendering + frontend⇄backend round-trip
  - composables (14) — `useTokens` / `useHistory` / `useAnalyzer` against a mock `useBackend` (no real WS); run in effect scopes, happy-dom where window/localStorage needed
- **Playwright** Electron E2E: 2 smoke tests — app launch + Welcome entry visible, then native-dialog-stubbed Browse → workspace selected → main UI
- Local scripts only (no CI): `test` / `test:run` / `test:e2e`
- **Not covered** (deliberate): `App.vue` internals incl. `parseDispatchBlocks` (left in App.vue, not extracted); `useTerminal` xterm DOM paths (deferred to E2E)

---

### M15 · Pane Layout Modes + Minimize + Maintenance Mode
**Status**: ✅ Done · plan: `.cursor/plans/maintenance-mode_f9a3c2d1.plan.md`

- **Layout Modes** (`ViewPanel.vue`): 4 manually selected layouts (Grid⊞ / Sidebar◧ / Spotlight◎ / Fullscreen⧉). Grid shows all panes; Sidebar shows the selected pane alongside the Active agents list; Spotlight shows the selected pane with a thumbnail strip; Fullscreen fills the workspace with the selected pane and keeps agents available in a floating panel. The persisted internal value for Sidebar remains `auto` for backward compatibility; it does not imply automatic pane switching.
- **Minimize to Sidebar**: every TerminalPane has `↓` button → hides pane with `v-show` (PTY session stays alive), shows compact "▪ sidebar" card + "↑ 還原" in ControlPane agent list.
- **Maintenance Mode** (`WorkspaceMode = 'maintenance'`): pipeline `completed` → auto-switches to maintenance. New ControlPane section with task textarea + agent/role picker + "▶ 派出去". `onMaintenanceSpawn` spawns pane, waits for role injection, then injects task text as kickoff.

---

## 4 · Currently in-flight (working tree)

This historical section is retired. Use `git status` for the current working tree and `.cursor/plans/*.plan.md` for active plan-driven work.

---

## 5 · Architecture map

```
┌─────────────────────────────────────────────────────────────┐
│ Electron Main (TS · src/main/)                              │
│   spawns Python backend · IPC handlers · 3 BrowserWindow    │
└─────────────────────────────────────────────────────────────┘
              ↓ IPC (preload bridge)
┌─────────────────────────────────────────────────────────────┐
│ Renderer (Vue 3 · src/renderer/)                            │
│ ┌──────────┬──────────────────────┬─────────────────────┐  │
│ │ Control  │   Terminal Grid       │  Token Stats Panel  │  │
│ │ Pane     │   (auto-fit cols)     │  (collapsible)      │  │
│ │          │                       │                     │  │
│ │ pipeline │   TerminalPane×N      │  Tokens │ History   │  │
│ │ manual   │   (xterm.js)          │  (stats │ timeline) │  │
│ │ active   │                       │                     │  │
│ └──────────┴──────────────────────┴─────────────────────┘  │
│ Welcome.vue gates entry · ControlPane mode-aware (M11)       │
│ Composables: useBackend / useTerminal / useTokens / useHistory│
│   useAnalyzer / useRoles / useStages / useRecentWorkspaces   │
│   useTheme · useExplorer · useOnboarding · editor/ (scratch)  │
│ Styles: styles/tokens/ — base (primitives) · semantic (roles)│
│   · themes/*.css (5 built-ins via [data-theme] on <html>)    │
│ App.vue: pipeline state machine · watchers · question queue  │
└─────────────────────────────────────────────────────────────┘
              ↓ WebSocket (34 message types)
┌─────────────────────────────────────────────────────────────┐
│ Python Backend (FastAPI · backend/agent_team_backend/)      │
│                                                              │
│  app.py — dispatcher · 34 WS msgs · 8 HTTP routes           │
│  ├─ terminals.py        PTY · 50ms batch                    │
│  ├─ projects.py         per-workspace state                 │
│  ├─ fs_service.py       Explorer safe file CRUD             │
│  ├─ editor_service.py   editor AI rewrite/complete (LLM)    │
│  ├─ onboarding_deps.py  env detect + gate + CLI maintenance │
│  ├─ tokens_store.py     dedup + persist                     │
│  ├─ roles_store.py      registry                            │
│  ├─ stages_store.py     registry (slots-based)              │
│  ├─ analyzer.py         llama.cpp + benchmark + auto-answer │
│  ├─ doc_injector.py     Context7 + LLM filter               │
│  ├─ mcp_manager.py      MCP server lifecycle                │
│  ├─ claude_hooks.py     hook installer (auto on startup)    │
│  ├─ history_store.py    append-only run timeline (M10)      │
│  ├─ recent_workspaces.py recent + pin store (M11)           │
│  └─ log_readers/        provider log and database readers   │
│       ├─ base.py        LogReader + TokenUsage + ActivityEvent│
│       ├─ claude.py      ~/.claude/projects/                 │
│       ├─ codex.py       ~/.codex/sessions/                  │
│       ├─ gemini.py      ~/.gemini/tmp/                      │
│       ├─ attribution.py workspace ↔ folder mapping          │
│       └─ watcher.py     watchdog + force_rescan             │
└─────────────────────────────────────────────────────────────┘
              ↓ HTTP/Hooks (NEW)
        Claude Code CLI → /hooks/claude
        Local CLI JSONL files (read-only)
        Ollama blob store (read-only, for analyzer)
        Context7 (external HTTP) for doc injection
```

---

## 6 · Future direction

Future work moved to the [Product Roadmap](roadmap.md). In summary, Navide is evolving toward reliable orchestration and observability, capability-based agent adapters, stronger policy and isolation, reproducible run artifacts, dependency-graph workflows, delivery integrations, reusable templates, and cross-platform support.

The roadmap is directional. A roadmap item becomes active implementation work only when it has an approved `.cursor/plans/*.plan.md` artifact.

---

## 7 · Documentation and plans

- [Documentation index](README.md)
- [Architecture](architecture.md)
- [User guide](user-guide.md)
- [Privacy and data flows](privacy.md)
- [Product roadmap](roadmap.md)
- `.cursor/plans/*.plan.md` for active or retained plan-driven implementation artifacts

Historical plan names and implementation notes remain in the milestone and progress-log sections below. Their status should not be used to infer current working-tree state.

---

## 8 · How to maintain this record

- Add stable released behavior to `CHANGELOG.md`.
- Update current user behavior in `user-guide.md` and architecture boundaries in `architecture.md`.
- Update future direction in `roadmap.md` without presenting it as shipped.
- Use `.cursor/plans/*.plan.md` for complex implementation work and maintain todo status there.
- Add an entry here only when a historical milestone is worth preserving.
- Do not record volatile working-tree cleanliness, exact test counts, or active-branch claims as durable project truth.

---

## 9 · Progress log (most recent first)

### 2026-06-05 (later) — sequential feature branches
Three plans completed on cumulative branches (theme-system → file-explorer → ai-native-editor → onboarding-wizard), each verified independently with no regressions.
- **File Explorer** (`feat/file-explorer`) — backend `fs_service.py` (safe path resolution + list_dir/CRUD/read/write) + `fs.*` WS handlers; `useExplorer.ts` lazy tree + git-status overlay; `ExplorerPane.vue` (3rd sidebar tab, leftmost) opening files in Diff; context-menu CRUD via notify.confirm. +19 backend, +6 frontend tests.
- **AI Native Editor** (`feat/ai-native-editor`) — from-scratch editor under `src/renderer/src/editor/`: `TextModel`/`UndoStack`/`jsTokenizer` (pure logic, 44 tests), `EditorView.vue` (DOM virtual scroll, hidden-textarea input + IME, caret/selection, syntax → `--syntax-*`), AI flows (Cmd+K rewrite accept/reject, ghost completion) via `editor.*` → `editor_service.py` (local LLM), `EditorPane.vue` + `?window=editor` standalone window + `fs.write_file` save; entry points in Explorer + GitPane.
- **Onboarding Wizard** (`feat/onboarding-wizard`) — `onboarding_deps.py` dep registry + detection (ok/missing/outdated) + hard-block gate (foundation + ≥1 agent CLI + Ollama&model); `onboarding.*` WS handlers + completion flag (`~/.agent-team/onboarding.json`, `AGENT_TEAM_SKIP_ONBOARDING`); `useOnboarding.ts` + 3-step `OnboardingWizard.vue`; App.vue startup gate; external-Terminal installs via `shell:openTerminal`. +12 backend, +5 frontend tests.

### 2026-06-05
- **Theme System** shipped (`feat/theme-system`, plan `theme-system_35d87146`) — CSS custom-property token architecture replacing 68+ hardcoded colors. Three token layers: `styles/tokens/base.css` (primitives) → `semantic.css` (59 semantic roles + `--syntax-*` group) → `themes/*.css` (5 built-ins: Dark GitHub / Midnight / Forest / Light / High Contrast) applied via `[data-theme]` on `<html>`. `useTheme` composable manages selection + 8-token custom overrides; **localStorage is the source of truth**, workspace JSON `theme`/`theme_custom` are best-effort backup (load order localStorage → backend → `dark-github`). Appearance tab in SettingsModal (theme cards + color pickers w/ 300ms debounced live preview + reset). Default theme migration is pixel-identical (token defaults equal the old hex). 11 renderer files migrated (App.vue + 10 components, GitPane separated from the concurrent notification-system work). +10 useTheme tests, +4 backend theme tests; 173 frontend + 414 backend green; production build + cross-theme token-coverage smoke test pass.

### 2026-05-30 (later)
- **M14 Frontend tests** shipped — Vitest infra + 63 unit tests (buffer/stages pure fns + useTokens/useHistory/useAnalyzer via mock backend) + Playwright 2 Electron E2E (launch + Welcome→workspace). Local scripts only. `App.vue`/`parseDispatchBlocks` deliberately untouched. Plan `frontend-tests_9c4ad7e2` retired. `typecheck:web` still exit 0.

### 2026-05-30
- **M10 History timeline** shipped & merged (`feat/history-tab`) — append-only JSONL per run + HistoryPanel UI + stick-to-bottom auto-scroll
- **M11 Workspace-first entry** shipped & merged (`feat/recent-workspaces-store` → `integrate/recent-workspaces-store` → `workspaces`) — Welcome picker + recent store + mode-aware UI; verified (typecheck + 136 pytest) and user-tested
- **M12 Reliability hardening** — injection no-drop + analyzer question-intent fix
- `main` fast-forwarded to `workspaces` (45a9b37); residual branches `integrate/*` + `feat/recent-workspaces-store` deleted
- Plan files retired per §8: history-tab, workspace-first-entry, reliable-injection (records live in §3 M10–M12)
- **Audit finding**: team-preconfig plan's core (pre-spawn全隊 + Manager 編排) was already shipped & live — recorded as **M13**; its frontmatter "pending" status was stale drift. Optional per-workspace `team-config.json` overlay dropped as out-of-scope; plan retired. `.cursor/plans/` now empty — no active dev goal remains.

### 2026-05-29
- Spec doc created — establishes this as single source of truth
- M9 Multi-signal idle detection landed in working tree (10-min threshold, raw PTY tracking, displayStatus differentiation)
- F1, F2, F3 plans drafted
- Detail plans for completed work deleted per workflow rule (§8)
- Focus-grace window added to useTerminal so pane-click TUI redraws don't flip idle→running

### 2026-05-28
- Strict mode toggle shipped (M6)
- Claude hooks scaffold added (M7 in flight)
- ActivityEvent system added to log_readers (M8 in flight)
- Token panel section ordering: totals first, breakdowns moved to bottom
- ControlPane taskDescription persistence (sessionStorage) — survives HMR

### 2026-05-27 → 2026-05-28
- M4 token tracking fully ramped: vendor_parsers replaced by log_readers · attribution + persistence · 114 pytest passing
- M5 MCP + doc injection + analyzer benchmark shipped
- Stages refactored to slots-based; legacy `defaultAgent/defaultRole/kickoffPrompt` removed

### Earlier
- See `git log --oneline` for the full sequence
