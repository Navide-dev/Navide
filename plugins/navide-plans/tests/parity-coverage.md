# Plans v1 / packaged v2 parity coverage

## Scope of this document — read this first

The packaged plugin (`plugins/navide-plans`) re-implements what v1 rendered from
`src/renderer/src/PlanWindowApp.vue` plus the surfaces that window composed
(`editor/PlansPane.vue`, `editor/PlanReviewToolbar.vue`,
`editor/PlanDocPreview.vue`, `editor/PlanMarkdownBody.vue`, and the shared
`AiCliDock`). Parity therefore means all of those, not the toolbar alone.

**Until 2026-09 this document scoped its oracle to the review toolbar and the
document preview only.** Everything else the window did — the list surface, and
the window-level behaviour that sits outside both — was never compared against
v1, and regressions in exactly those areas shipped under a fully green suite:
the "awaiting you" row marker, the plan-ref drag payload, three context-menu
entries, the sidebar hide/show control, Host keybinding participation, the
last-opened plan pointer, and an AI CLI panel whose open-state was declared but
never set. The narrow scope is what let them through. The surface inventory
below is now the scope; a row that says "not compared" is a real gap, not a
formality.

### Surface inventory

| v1 surface | v2 owner | Compared against v1? | Evidence |
| --- | --- | --- | --- |
| Review toolbar (`editor/PlanReviewToolbar.vue`) | `src/retained/PlanReviewToolbar.vue` | Yes — all 80 oracle cases | `src/retained/PlanReviewToolbar.test.ts`, mapping table below |
| Document preview (`editor/PlanDocPreview.vue`) | `PlansApp.vue` iframe + `src/planSecurity.ts` | Partly — 9 covered / 2 partial / 2 uncovered of 13 | `src/PlansApp.test.ts`, preview mapping table below |
| Markdown document body (`editor/PlanMarkdownBody.vue`) | `src/retained/PlanMarkdownBody.vue`, `src/retained/markdownRender.ts` | Yes, at the behaviour level (not case-for-case against a v1 oracle file) | `src/PlansAppMarkdown.test.ts` |
| Plan list rows and row actions (`editor/PlansPane.vue`) | `PlansApp.vue` sidebar | Yes for the restored capabilities; the rest of the pane is not case-mapped | `src/PlansAppListSurface.test.ts` |
| Window-level behaviour (`PlanWindowApp.vue` itself) | `PlansApp.vue` + `src/plansKeybindings.ts` + `src/planCliContext.ts` | Yes for keybindings/commands, last-opened and the CLI panel; **not** for UI zoom (see below) | `src/PlansAppWindowSurface.test.ts` |
| Notifications / toasts (`components/NotificationHost.vue`) | `src/retained/NotificationHost.vue` | Not compared — carried over rather than re-implemented | — |
| Plan-root resolution (`plugins/plans/resolvePlanRoot`) | packaged backend (`backend/plans_backend.py`) | Not compared at this layer | Host/backend tests, not this suite |

### Window-level parity detail

| v1 behaviour | v1 site | v2 state |
| --- | --- | --- |
| `useKeybindings()` + `setContext('planWindow', true)` | `PlanWindowApp.vue:310, 318` | Restored — `src/plansKeybindings.ts`, proved by `Plans window — Host keybinding participation` |
| `workbench.action.quickOpen` (⌘P), declining while focus is in the CLI panel | `PlanWindowApp.vue:322-327` | Restored |
| `workbench.action.closeWindow` (⌘⇧W) | `PlanWindowApp.vue:331` | Restored |
| `workbench.action.reloadWindow` (⇧⌘R) | `PlanWindowApp.vue:334` | Restored |
| `workbench.action.closeModal` (ESC / ⌘W) with the priority walk down to closing the window | `PlanWindowApp.vue:348-374` | Restored; the walk additionally declines while an application dialog is open, which v1 did not |
| `workbench.action.zoomUiIn` / `Out` / `Reset` | `PlanWindowApp.vue:340-342` via `lib/uiScale` | **Not restored, and not restorable from a packaged plugin today.** `lib/uiScale` applies the scale through `window.agentTeam.setUiScale` → `ipcMain.handle('window:setUiScale')`, which explicitly refuses any sender that is a plugin frame or WebContentsView (`src/main/index.ts`, "plugin content … can never resize the host's chrome"), and the plugin preload (`src/preload/plugin-preload.ts`) exposes no such bridge. `docs/plugin-contracts/capabilities-v1.json` has no zoom or interface-scale method. Restoring it needs a new public capability (e.g. `ui.setInterfaceScale`) in the contracts package plus a Host handler; a plugin-local CSS zoom was rejected because it would compose with the Host's own `setZoomFactor` and create a second, diverging source of truth for a setting the Host documents as app-wide. Zoom **changes made elsewhere** do still reach this window — main pushes the factor to plugin WebContents (`src/main/ui-zoom-store.ts`). What is lost is only initiating a zoom change from the Plans window. |
| `lastOpenedStorageKey` — reopen the last document when launched without one | `PlanWindowApp.vue:42, 162, 185` | Restored on the plugin's workspace-scoped `storage.get/set` as `plans.last-opened`; a pointer at a deleted or renamed plan is checked against the listed plans and silently skipped |
| `AiCliDock` with `buildPlanCliContext` auto-injection | `PlanWindowApp.vue:31-32, 388-417, 605-612` | Restored — `SafeAiCliPanel` (its own collapsed rail is the control) with a package-local `src/planCliContext.ts`; the Host-private `@navide/plugin-shell` builder cannot be imported, so the payload text is restated and must be kept in step |
| Per-workspace CLI pane id (`aiTerminalPaneId`) | `PlanWindowApp.vue:388` | Not applicable — the `aiCli.*` capability owns session identity; the plugin does not name a pane |

### What these tests are and are not

These are component tests with injected transport and note-operation ports. Their fake server applies the real private PlanStore to inert content; they do **not** prove Host routing or the packaged executable. The production PlansApp suite mounts the real toolbar, preview and notification presentation, with observable controls and SDK-shaped responses. The separate packaged roundtrip suite must prove the selected built artifact and actual backend. A passing component row must not be described as manual UI or packaged end-to-end verification.

The product oracle for the toolbar is `src/renderer/src/editor/__tests__/PlanReviewToolbar.test.ts`. All 80 executable v1 cases are retained under the same exact names in `plugins/navide-plans/src/retained/PlanReviewToolbar.test.ts`. The table below covers every oracle case, including lifecycle, snapshots, execution, narrow-width demotion, concurrency, keyboard handling and markdown metadata. No v1 toolbar case is missing at the component layer.

## Complete toolbar case mapping

| # | Exact v1 test name | v2 test | Result / layer |
| --- | --- | --- | --- |
| 1 | shows the stage badge and todo progress from plan-meta | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 2 | renders a stage-colored progressbar, and none when the plan has no todos | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 3 | renders nothing for a file without a valid plan-meta block | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 4 | shows the unresolved note count and note details in the panel | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 5 | resets an open panel + in-flight note edit when relPath changes | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 6 | disables Approve while unresolved notes exist | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 7 | disables Approve once the stage is past review (e.g. in-progress) | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 8 | enables Approve for a draft plan and approves it (no draft→in-review step exists) | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 9 | approves an in-review plan with all notes resolved, writing stage and approvedAt | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 10 | resolves a note and writes the flip through replaceHtmlPlanMeta | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 11 | appends a submitted note with the next incremental id and user author | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 12 | ignores Enter pressed during IME composition | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 13 | submits on Enter when not composing | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 14 | preserves concurrent external edits when resolving a note | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 15 | recomputes the submitted note id against fresh notes | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 16 | aborts approve without writing when the fresh file is no longer approvable | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 17 | writes the freshly-read content byte-identical to .plans/<filename> | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 18 | shows the backend error via toast when the write fails | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 19 | cycles a pending todo to in-progress and syncs the visible markup | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 20 | cycles a done todo back to pending | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 21 | right-click toggles skipped and back to pending | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 22 | abandons an active plan after confirmation, syncing the stage pill | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 23 | does not write when the abandon confirmation is declined | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 24 | reopens a done plan into in-review and clears approvedAt | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 25 | aborts the abandon without writing when the fresh file is already finished | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 26 | re-reads the file on window focus and emits updated when it changed | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 27 | does not emit updated on focus when the file is unchanged | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 28 | silently re-reads on a matching plans.changed broadcast | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 29 | ignores plans.changed broadcasts for other workspaces | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 30 | lists parseable snapshots newest first with preview and diff actions | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 31 | shows the empty state when the history directory does not exist | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 32 | emits preview-snapshot with the snapshot rel path and a stage-bearing label | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 33 | renders an inline diff summary between a snapshot and the current plan | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 34 | shows the no-differences message when the snapshot equals the current plan | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 35 | exposed cycleTodo writes the next status through the normal write path | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 36 | exposed toggleSkipTodo flips a todo to skipped | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 37 | startNoteWithAnchor opens the notes panel and submit writes the anchored note | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 38 | clears the pending anchor via its remove button without writing | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 39 | shows the anchor badge on anchored notes in the panel | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 40 | hides the Execute button unless the stage is approved | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 41 | opens an agent picker listing CLI agents without the plain terminal | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 42 | dispatching appends an execution, moves stage to in-progress, syncs markup, and sends the IPC payload | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 43 | rolls back the execution and reverts to approved on a failed execution result | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 44 | ignores execution results addressed to another plan file | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 45 | rolls back locally right away when the dispatch is not delivered | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 46 | rolls back when no execution result arrives before the timeout | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 47 | requires confirmation when a dispatched execution is already in progress | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 48 | does not write or dispatch when the duplicate confirmation is declined | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 49 | aborts silently without dispatching when the fresh stage is no longer dispatchable | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 50 | carries the read mtime as expected_mtime on plan writes | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 51 | re-reads and retries once when the write hits an mtime conflict | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 52 | surfaces the save-failed toast after a second consecutive conflict | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 53 | share-to-git snapshots write without expected_mtime (overwrite semantics) | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 54 | keeps the moved actions out of the DOM until ⋯ is clicked | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 55 | closes on a backdrop click | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 56 | closeActiveOverlay dismisses the menu before collapsing an open panel | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 57 | keeps Review Notes on the bar only while notes are unresolved | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 58 | does nothing when the first confirmation is declined | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 59 | asks a second time for an approved plan and aborts when that is declined | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 60 | deletes the file and emits deleted with the plan rel path | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 61 | toasts the backend error and emits nothing when the delete fails | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 62 | demotes Todos first, then Execute, then Approve as the bar narrows | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 63 | lists section and phase anchors and emits scroll-to-anchor on pick | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 64 | hides the outline entry when the document has no headings | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 65 | adds a todo with a stable kebab id and pending status | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 66 | edits a todo content inline through writeMeta | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 67 | deletes a todo only after confirmation | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 68 | edits a user note text and preserves its resolved state | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 69 | does not offer edit for ai-authored notes | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 70 | deletes a note after confirmation | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 71 | routes an approve write through the injected store.writeMeta | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 72 | passes a syncBody to the store for a todo add so the visible <li> is synced | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 73 | reports and cancels an unsent note input, then an inline todo edit | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 74 | collapses an open panel (no active edit) before falling through to window close | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 75 | renders the stage badge and progress from .plan.md frontmatter | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 76 | adds a todo into the frontmatter (no HTML body markup to sync) | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 77 | history panel shows only same-format (.plan.md) snapshots, hiding .html ones | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 78 | shows the Archive button and no archived pill for an unarchived plan | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 79 | archives the plan, writing archivedAt (stage untouched) and showing the pill + Unarchive | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |
| 80 | unarchives an archived plan, clearing archivedAt and hiding the pill | Same exact test name in `src/retained/PlanReviewToolbar.test.ts` | Covered: component |

## Production composition regression matrix

The following cases are in `plugins/navide-plans/src/PlansApp.test.ts` and mount production PlansApp. Review Notes, preview, toolbar and NotificationHost are not stubbed. Interaction cases attach to the actual test document so click bubbling and focus are observable.

| Behavior | Production test evidence |
| --- | --- |
| Notes panel structure, placement and toggle | `parity: real Notes click opens the v1 panel inside the toolbar immediately above preview` |
| Edit availability, focus and one immutable-target write | `parity: real Edit enables and focuses the input and Save calls the immutable target exactly once` |
| Section Comment focuses even with Notes already open, preserves anchor | `parity: section comment refocuses an already open composer and retains the authenticated anchor` |
| Stage badge, Todos, Approve gating | `parity: toolbar retains v1 stage badge, Todos and disabled Approve controls` |
| Real application dialog cancel, Escape priority and single confirmed Delete | `parity: actual application confirmation Escape cancels only the dialog and Enter deletes once` |
| Delayed confirmation cannot target another plan | `parity: delayed Delete confirmation cannot delete a same-id note after switching plans` |
| Resolved / empty Notes exclusively in overflow | `parity: resolved notes appear only in overflow and toggle the real panel`; same case for `empty` |
| IME and ordinary Enter, pending settles | `parity: IME Enter does not send and ordinary Enter sends once then returns idle` |
| One Escape transition at a time | `parity: Escape peels edit, composer, then the existing panel` |
| Invalid source, null source, stale window/token, unknown anchor, token/nonce alias rejected | Parameterized `parity: rejects section-comment with %s before opening the composer` |
| Outline forwards to actual iframe; scroll report does not reload; iframe edit has Escape priority | `parity: real outline control navigates the current iframe and scroll reports keep its identity` |
| Real History Preview control reaches read-only snapshot and Close returns | `parity: real history Preview opens the retained read-only snapshot and Close returns to the plan` |
| Persistence broadcast preserves todo iframe identity/token, updates status and progress | `parity: a real plans.changed broadcast after todo status persistence does not reload the preview` |
| Failed add/edit restores idle and retains draft | Parameterized `parity: failed %s returns to idle and retains the draft for retry` |
| Delayed add/edit from A cannot replace B drafts/pending state | Parameterized `parity: delayed %s response from A cannot replace B drafts or pending state` |
| Pending document selection rejects old iframe writes; out-of-order reads cannot overwrite current document | Existing `prevents cross-document todo mutation race...`, `prevents out-of-order plans.read results...`, and `prevents a refresh for A from overwriting B...` cases |
| Existing todo no-flash path and anchored CRUD preserve the original iframe | Existing `preserves iframe identity...` and Review Notes identity cases |
| Picker registry order/labels/hints | `src/retained/agentSpecs.test.ts` compares the exact ordered projection of the recorded (v1) keys with the live registry; a CLI declared later is not in the frozen copy and needs no edit there |

## List surface regression matrix

`plugins/navide-plans/src/PlansAppListSurface.test.ts` mounts production PlansApp and covers the row capabilities v1's `PlansPane` offered without opening a document. These were re-added after the migration dropped them; the file is behaviour-mapped, not case-mapped against a v1 oracle file (v1 has no PlansPane test suite to map to).

| Behaviour | Production test evidence |
| --- | --- |
| "Awaiting you" marker on a plan with an unfinished user-owned todo, and its absence otherwise | `marks a plan whose unfinished todo is owned by the user`; `leaves a plan unmarked when no unfinished todo is owned by the user` |
| Dragging a row onto a CLI pane writes the `application/x-plan-ref` payload the terminal drop handler parses | `writes the plan-ref payload the terminal drop handler parses`; `carries a plain document with no overview` |
| Share to Git, Archive / Unarchive, Promote-to-plan context-menu entries and their gating | `shares the right row to the git-tracked .plans/ directory`; `archives an unarchived plan after confirmation`; `unarchives an archived plan without a confirmation prompt`; `promotes a plain document to a plan from its own row`; `offers neither promote nor share on a row that is already a plan` |
| Sidebar hide/show control | `hides the list and offers a control that brings it back` |

## Window surface regression matrix

`plugins/navide-plans/src/PlansAppWindowSurface.test.ts` mounts production PlansApp and covers the behaviour that belonged to the v1 window shell rather than to any panel inside it. Same caveat: behaviour-mapped against the v1 source, not case-mapped against a v1 test file — `PlanWindowApp.vue` has no test suite in v1.

| Behaviour | v1 site | Production test evidence |
| --- | --- | --- |
| The four window commands are registered against the Host rule table | `PlanWindowApp.vue:322-349` | `registers the window commands v1 registered` |
| Firing the registered quick-open command actually opens the palette | `PlanWindowApp.vue:322` | `opens quick open when the registered command fires, however it is bound` |
| Close and reload act on the window | `PlanWindowApp.vue:331, 334` | `closes and reloads the window from the registered commands` |
| A real Escape keystroke resolves through the shipped `planWindow` rule (proves the context is declared and the dispatcher installed, not just that a handler exists) | `PlanWindowApp.vue:318, 348` | `routes a real Escape keystroke through the shared rule table` |
| Escape with nothing left to peel closes the window | `PlanWindowApp.vue:374` | `closes the window once nothing is left to peel` |
| Launching without a `rel_path` reopens the plan this workspace last had open | `PlanWindowApp.vue:185` | `reopens the stored plan when launched without one` |
| Opening a document records the pointer | `PlanWindowApp.vue:162` | `records the plan that was actually opened` |
| A stale pointer (deleted/renamed plan) degrades to an empty window with no error | `PlanWindowApp.vue:185-190` | `opens empty, without an error, when the stored plan no longer exists` |
| An explicit launch target wins over the stored pointer | `PlanWindowApp.vue:181-184` | `prefers the plan the window was launched with over the stored one` |
| The CLI agent panel is reachable at all | `PlanWindowApp.vue:605` | `mounts the panel instead of leaving it behind unreachable state` |
| The open plan is injected as the spawned agent's context | `PlanWindowApp.vue:394-417, 611` | `injects the open plan as the spawned agent context`; `says so plainly when no plan is open` |

Not covered by this file, deliberately: UI zoom (see the window-level parity detail above — it is not implementable from a packaged plugin without a new Host capability), and the actual spawn of a CLI process. The panel's `buildContext` is called directly; that the Host really starts an agent and pastes the payload is an `aiCli.*` capability concern, not a plugin one.

## Remaining verification boundaries

- **Interface zoom in the Plans window: not implemented, not merely untested.** No test asserts ⇧⌘=/⇧⌘-/⇧⌘0 in this window because the packaged plugin cannot apply an app-wide scale; the Host refuses the IPC from plugin frames and the capability catalog has no equivalent. Do not read the green suite as evidence that zoom works here.
- **`PlansPane` beyond the restored row capabilities: not case-mapped.** v1 ships no test file for the plan list, so the list matrix above is written from the v1 source, not from an oracle. Filtering, sorting, grouping, pinning, quick open and rename are exercised by `PlansApp.test.ts` and `PlansAppListSurface.test.ts` but have not been diffed control-by-control against `editor/PlansPane.vue`.
- **Chromium layout and hit testing: manual only.** Happy DOM can prove panel presence, parent placement, enabled controls, event routing and focus, but cannot prove actual pixel spacing, clipping, overlapping elements or pointer hit targets. Manually compare v1/v2 at wide and narrow widths after proving artifact provenance.
- **Physical IME interaction: manual only.** Component tests exercise `isComposing` and ordinary Enter events; a real input method must still be checked in the isolated app.
- **Execution dispatch and OS browser opening: component + Host boundary tests, not a launched agent/browser.** The 80-case oracle suite injects those ports. Do not infer an actual CLI launch, external browser launch or successful agent execution from these results.
- **History, markdown and lifecycle: component coverage is complete relative to the 80-case toolbar oracle; actual packaged coverage is limited to scenarios exercised by the packaged roundtrip suite.** A component case does not establish full visual parity for markdown document rendering.
- **Frontend bytes: build provenance is a prerequisite.** Source tests do not prove that the manually launched app selected the worktree factory bundle. Use the isolated profile procedure and exact selected descriptor/build identity documented with the task verification.

## Complete PlanDocPreview oracle mapping

The preview oracle `src/renderer/src/editor/__tests__/PlanDocPreview.test.ts` contains 13 executable cases. Current production-composition coverage is **9 covered, 2 partial, 2 uncovered**. These counts do not count source inspection as a passing test and do not imply that uncovered behavior has been verified in the packaged app.

| # | Exact v1 preview test name | Coverage | v2 evidence or precise gap |
| --- | --- | --- | --- |
| 1 | renders a srcdoc iframe sandboxed to allow-scripts with the runtime injected | Covered | `renders iframe with stripped scripts and strict nonce CSP in srcdoc`; `parity: iframe runtime starts with the retained unresolved anchor counts` |
| 2 | reloads the document and replaces iframe element when the refresh prop bumps | Covered via injected refresh event | `parity: same-plan external body reload clears iframe editing before Escape reaches the toolbar` asserts the old iframe is replaced after a substantive backend document update; the plugin has no public refresh prop. |
| 3 | shows the error state with the backend reason and resolved path | Covered | `parity: failed document read replaces the old iframe with the retained reason and resolved path` verifies the error panel, backend reason, exact workspace/document path and recovery after selecting a readable plan. |
| 4 | does not read while the backend is still starting, then loads on connect | Uncovered | The packaged Host owns activation and SDK calls, so v1 backend.status is not exposed. No focused component test currently holds activation pending and asserts zero premature document reads followed by successful activation. |
| 5 | retries a failed load when the backend reconnects | Uncovered | No focused packaged test disconnects/reconnects a failed backend and proves automatic preview recovery. Successful initial activation and a user-triggered Refresh are different scenarios. |
| 6 | ignores window messages whose source is not the preview frame | Covered | `safely handles todo-clicked only from the preview frame with known todo ID`; parameterized rejected section-comment sources. |
| 7 | rejects window messages with stale token or legacy token field | Covered | Parameterized rejected section-comment stale-token/token-alias cases and the existing todo token rejection case. |
| 8 | scrollToAnchor posts a scroll-to message into the frame | Covered | `parity: real outline control navigates the current iframe and scroll reports keep its identity` clicks the real menu and asserts scroll-to delivery. |
| 9 | passes the inline edit/delete labels into the injected runtime | Partial | `ports section Edit and Delete controls into the trusted iframe runtime` checks retained runtime injection. The exact four localized INIT label values are not asserted together as in the oracle. |
| 10 | cancelEdit posts a cancel-edit message into the frame; isEditing starts false | Covered | `parity: real outline control navigates the current iframe and scroll reports keep its identity` activates iframe editing, then asserts Escape sends cancel-edit while Notes remains open. |
| 11 | clears editing state when an external reload (loadDoc) runs | Covered | `parity: same-plan external body reload clears iframe editing before Escape reaches the toolbar` verifies the user-visible Escape result after generation replacement. |
| 12 | emits validated section-edit/section-delete and tracks editing state from the frame | Covered | Trusted anchored section edit/delete composition tests assert CAS writes and application confirmation; the outline/iframe-edit test asserts editing-state Escape priority. |
| 13 | enforces window source and document token across iframe remount (4 combinations) | Partial | Wrong source and stale token are independently covered, and plan switching rejects the old generation. The exact four old/new window/token combinations following the same-plan remount are not yet one production-composition test. |

## Additional review-loop regressions

- `parity: iframe todo %s with alt=%s persists v1 status %s without reloading` covers the retained pending → in-progress → done → pending cycle and alt/right-click skipped ↔ pending behavior.
- `parity: real toolbar Todo cycle updates its status without reloading the preview` covers toolbar-initiated status updates, in addition to iframe and external-broadcast no-flash paths.
- `parity: committed %s clears its draft even when the followup metadata read fails` proves that successful add/edit commits cannot leave a duplicate-submission draft solely because the subsequent refresh failed.
- Initial unresolved anchor counts are injected when preparing the preview. Notes-panel refresh does not regenerate its token or add a new iframe message contract. Badges take the counts of that prepared document generation; these tests do not claim a separate live badge-update protocol.
