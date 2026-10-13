# CLAUDE.md

Agent-Team: Electron (Vue 3 + TypeScript, pnpm) frontend + Python (uv) backend.
This file is a router — read the referenced file BEFORE doing the matching work.

## Route table

| Situation | Read first |
|---|---|
| Dev setup, tests, typecheck, PR and commit rules | `CONTRIBUTING.md` |
| Process boundaries, ownership, persistence and trust boundaries | `docs/en-US/architecture.md` |
| Adding or changing an agent CLI integration | `docs/en-US/cli-extension-guide.md` |
| Building or changing a plugin | `docs/en-US/plugin-development.md` |
| Naming anything plugin-, extension- or marketplace-like in UI text or docs | `docs/en-US/glossary.md` |
| Inter-CLI messaging: the bare-line protocol, handles, delivery rules | `docs/en-US/inter-cli-messaging.md` |
| Editor, diff, or plan surfaces | `docs/en-US/editor-design.md` |
| Keyboard shortcuts and the key resolver | `docs/en-US/keybindings.md` |

Read routed files on demand, not all up front.

An optional machine-local overlay may exist at `.claude/playbook/` (ignored by
Git, so a fresh clone will not have it) and at `~/.claude/playbook/` for
delegation and model-choice guidance. Read them when present; never block on
them — every rule required to work in this repo is in this file or the routed
in-repo docs above.

## Always-on rules (the expensive-to-violate subset)

1. **Tests**: `pnpm test:run`, never `pnpm test` (watch mode hangs). Backend:
   `uv --project backend run pytest backend/tests` (the path argument is
   required — without it pytest misses backend's ini config). Run verification
   commands bare — no pipe to tail/head (it eats the exit code).
2. **Never clear terminal scrollback** — no `term.clear()` in any
   resize/redraw path.
3. **No self-initiated commits** — the user decides when to commit, unless
   they explicitly authorized committing for the task.
4. **No UI automation** (cliclick/screencapture/AppleScript) — the user tests
   UI manually.
5. **Giant files** — any file over ~2K lines: Grep tool to locate → Read with
   offset/limit → batch edits through one subagent. Never whole-file Read,
   never bash/python inline search. The largest are `src/renderer/src/App.vue`
   (~20.7K lines), `backend/agent_team_backend/ws_handlers.py` (~9.4K),
   `src/renderer/src/components/ControlPane.vue` (~6.8K),
   `src/renderer/src/components/SettingsModal.vue` (~5.2K),
   `src/renderer/src/platform/terminal/composables/useTerminal.ts` (~4.7K),
   `src/renderer/src/components/GitPane.vue` (~3.6K, and a second copy at
   `plugins/navide-git/src/components/GitPane.vue`),
   `backend/agent_team_backend/git_service.py` (~3.2K), and
   `src/renderer/src/EditorWindowApp.vue` (~2.9K). Check with `wc -l`
   rather than trusting this list — it drifts. Per-vendor CLI code lives in
   `backend/agent_team_backend/cli_vendors/` (one file per vendor; see
   `docs/adding-a-cli-vendor.md`).

## Workflow (Plan Documents)

Plan mode is **opt-in only** — enter it solely when the user explicitly asks
(e.g. "建立計畫", "plan 模式", invoking `cursor-plan-mode-workflow`).
Never create a plan file proactively, even for complex tasks; without a plan,
state assumptions and implement directly.

When a plan exists or was explicitly requested:

1. Plans are agent-authored HTML in `.agent-team/plans/` per
   `.agent-team/plans/_spec.md` (copy `_template.html` to start). Do not
   publish plans as claude.ai artifacts; the user views them in the app.
2. Updates (todo status, stage, review notes): Edit only the `plan-meta`
   JSON block plus its matching visible markup — never rewrite the file.
3. Approval gate: write code only when the plan's `stage` is `approved` or
   later. The user saying "開始" means: set `stage: approved` + `approvedAt`,
   then start.
4. Legacy `.cursor/plans/*.plan.md` stay readable; never create new ones.
5. **One topic, one plan document.** When a dispatched pane finishes work that
   already has a plan, write the delivery report *into that plan* (a "Delivery"
   section, the todo statuses, a review note) and move its stage to `done`.
   Do not create a separate "delivery report" plan file. Create a new plan
   document only for a topic that has none. Proposal-plus-report pairs doubled
   the library (29 → 305 files in a month).

## Language

**Codebase language: English** — all code, comments, commit messages, variable
names, and in-repo documentation.

## Behavioral core

1. **Think first**: state assumptions; if multiple readings exist, list them —
   don't pick silently; if truly unclear, ask.
2. **Minimum code**: only what was asked; no speculative abstraction,
   flexibility, or impossible-case error handling.
3. **Surgical changes**: every changed line maps to the request; don't
   "improve" adjacent code; clean up only orphans your own change created.
4. **Goal-driven**: turn the task into verifiable acceptance criteria before
   coding ("fix bug" → "write a reproducing test, make it pass"), then loop
   until they verify.
