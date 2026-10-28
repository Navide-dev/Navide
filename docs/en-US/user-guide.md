# User Guide

English | [繁體中文](../zh-TW/user-guide.md) | [日本語](../ja-JP/user-guide.md) | [Documentation](README.md)

## Product model

Navide is designed for one engineer directing multiple AI agents. The primary interaction is not always editing a file; it is setting an outcome, coordinating sessions, observing progress, handling meaningful exceptions, and accepting verified results.

Daily work moves through three loops:

1. **Genesis** uses a pipeline to turn an idea into a first working prototype.
2. **Evolution** repeatedly develops, tests, fixes, and refines an existing project through one or more agent sessions.
3. **Intervention** lets the engineer inspect or directly change the result through Diff, editor, terminal, diagnostics, Git, and review tools.

The current Pipeline implements the Genesis loop. Manual panes and maintenance mode provide the early Evolution workflow. The editor and review surfaces provide Intervention.

## Runtime mental model

Navide has three levels of work:

1. A **workspace** is the project folder and the boundary for project state, run history, and Git operations.
2. A **pane** is a live terminal session running an agent CLI or a plain shell.
3. A **pipeline** is an ordered set of configurable stages. Each stage contains one or more parallel slots, and each slot chooses an agent and role.

## Workspaces

The welcome screen lists recent workspaces, supports pinning, and marks missing folders. Opening a workspace restores its UI state and eligible sessions. Before switching or closing a workspace, finish or abort active work that must not be interrupted.

Navide stores private, per-user project intelligence under `.agent-team/` inside the workspace. This directory is excluded from Git and must not be treated as shared team state. It can contain task context, session metadata, run history, handoffs, and token information that belong to the individual engineer's local workflow.

Source code and explicitly shared documentation remain the repository's team-visible truth. If information from `.agent-team/` must be shared, turn it into an intentional artifact such as a specification, architecture decision, test report, issue, commit, or pull request.

## Manual agent panes

Use manual spawn for exploration, maintenance, or an Evolution task that does not need a full Genesis pipeline.

- Choose an agent and role.
- Review the launch command before spawning.
- Use a plain Terminal pane when no agent is needed.
- Minimize a pane to keep its PTY alive without occupying the main layout.
- Rebuild or resume only after Navide has detected a reusable session ID.

In Auto, Spotlight, and Fullscreen layouts, the triangle button to the right of refresh (toolbar order: **+ → refresh → ▾/▸**) folds or unfolds the current tab's descendant-card families. It uses the same behavior as the triangle beside a parent's outlined descendant count. If any eligible family is open, it collapses all; when all are closed, it expands all, including nested families previously closed individually. Eligible parents have descendants and are not minimized.

Folding hides descendant cards while keeping their top-level parent cards, descendant counts, and the main terminal visible. Each tab's family state is independent and stays only in the current window's memory. The bulk button is disabled in Grid or when the tab has no eligible parent families.

A parent's descendant count includes every pane it spawned, and each of them can be reached by unfolding the family, even when a descendant is minimized or lives on another tab or in another project. Such a row carries a location hint (**Minimized to sidebar**, **Tab: name**, **Project: name**; long names are cut short with the full text on hover). Unfolding only changes the list. Clicking a descendant's row switches to its project and tab, restores it if minimized, and focuses it, the same way the left agent list does. Cmd/Ctrl-click and Shift-click on such a row only add it to the selection, in the list's order, without switching tabs or restoring anything. The bulk button still acts only on the current tab's parents that are not minimized. When spawned panes are busy, the parent card in Auto and Fullscreen shows a readable summary on its second line (Spotlight thumbnails show only the location hint), such as **1 child pane · Running**, naming the most urgent status among its descendants and how many are in it.

A new empty Codex pane waits for your input without sending an artificial session-discovery message. Its session ID may become available only after the first real user or configured task turn; until then, Rebuild remains unavailable. The same applies to a fresh rebuild or restore. If Codex asks to review the Navide session hook, review it in Codex; YOLO mode does not approve hooks. Existing shared session homes may need that trusted hook to associate the new conversation with its pane.

Select multiple pane headers with Cmd/Ctrl-click or Shift-click, then right-click a selected pane to open the batch menu. Its groups contain Interrupt/Rebuild, Minimize/Restore/Reclaim, notification controls, and Remove. **Restore selected** also opens selected panes that have not yet been opened or were reclaimed. Pane and project overflow menus stay within the window; long menus scroll so their final actions remain reachable.

**Reclaim selected (N)** shows how many selected panes are eligible, releases their CLI processes, and keeps click-to-resume placeholders. It skips protected panes, including running panes, the focused pane, panes awaiting an answer or holding unsent text, and panes without a resumable session. The action stays visible but is disabled when none of the selected panes can be reclaimed. **Mute selected notifications** mutes the entire selection, including a mix of muted and unmuted panes; when every selected pane is muted, **Unmute selected notifications** restores notifications for all of them. These batch actions affect only the selected panes.

Supported built-in agent keys cover 14 coding CLIs: Aider, Antigravity CLI, Claude Code, Codex, Copilot CLI, Cursor CLI, Droid, Grok CLI, Kilo Code, Kimi Code, Muse Code, OpenCode, Pi, Qwen Code. The exact CLI behavior and provider billing remain controlled by each external tool.

For Kimi Code panes, Navide gives the CLI a 100 ms escape-sequence reassembly window so arrow-key navigation remains reliable through the embedded terminal. An existing `PI_TUI_ESC_TIMEOUT` environment value still takes precedence.

### CLI risk observations

An active agent pane can show one yellow or red risk pill. Open its popover to inspect the backend's evidence and observation times; multiple findings share that popover. Disk findings apply to the vendor's active panes, while network findings belong to the observed pane's process tree, including its CLI, MCP servers and tools. Reclaimed placeholders show no risk pill.

- **Yellow network:** a sampled numeric IP and port fall outside a complete, current expected-address snapshot. The count is from the last sample, and “observed since” describes sampled observations, not connection duration. Legitimate tools, proxies and different DNS answers can produce a mismatch.
- **Yellow disk:** after a successful baseline, a file first observed following prior absence qualifies within 24 hours if it exceeds 100 MiB and bounded content inspection does not recognize its format. Files already in the baseline are excluded; timestamps and familiar extensions alone do not establish that a file is new or recognized.
- **Red disk:** a previously flagged path was successfully observed present, then absent, then present again with opaque content in the same 100 MiB size class. This does not identify who removed or recreated it, or establish that its contents are the same.

**Ignore** persists for the displayed vendor/IP across all ports, or vendor/canonical file path, including later severity changes. **Allow this IP** adds only the displayed exact IP for that vendor across all ports; it does not allow an inferred hostname or certify the destination. Both decisions apply across that vendor's panes and survive restart. Disk **Reveal in folder** opens the existing native folder action so you can inspect the file.

Observations use existing resource requests: normally every 30 seconds, or every 2 seconds while the resource panel is open. Disk attempts, including failed attempts, are throttled to once per five minutes per active vendor. Work finishes in the backend and appears in a later response; opening Storage is unnecessary. Descendant discovery and polling can delay network evidence, and short-lived connections or file replacement between samples can be missed.

Default network declarations currently cover Claude Code and Codex; other vendors have no expected-address comparison. Captured proxy or provider-endpoint overrides disable that comparison. Network observation covers established TCP on macOS and Linux; Windows network observation and UDP/QUIC are unsupported. Disk roots are declared per vendor, with Aider unsupported; symlinks beneath a resolved data root are skipped. Roots use the captured pane home and declared environment overrides; later changes inside CLI settings, command arguments or shell startup scripts can fall outside that snapshot. Failed or incomplete collection, unavailable declarations and expired DNS must not be read as a clean result. Historical findings can remain visible as stale evidence. **No pill is not an assurance of safety.**

These observations help you inspect local activity; they do not prove exfiltration or unlawful intent. Navide does not automatically block a connection, pause a CLI or delete a file. See [Privacy and Data Flows](privacy.md#cli-risk-observation-data) for local reads, retained metadata and DNS requests.

## Pipelines

The included pipeline covers requirements, planning, design, implementation, security review, and testing. Stages, slots, roles, kickoff prompts, questions, and completion sentinels are edited in the **Pipeline Manager** (Window ▸ Pipeline Manager, or the ⚙ **Manage Pipelines** button in the sidebar's Pipeline tab). Its **Swimlane** and **Canvas** views edit the same pipeline as a graph of steps; **Executions** shows the runs and their controls. A new run still starts from the sidebar: type the task and choose Run.

- **Approval gate.** Add one from the palette to pause the run between two steps; its **What to check** text tells the reviewer what to look at. While the run waits, the editor shows a banner with **Review**, and the gate offers **Approve and Continue** or **Send Back**, with an optional note for the agents. The sidebar's Next does not move past a gate.
- **Reject loop.** In the Canvas view, drag from a step's bottom handle to a step upstream. **Send Back** then re-runs the work from that step, with your note in front of its kickoff. A loop runs at most the number shown on its **↺ max** pill (2 by default, up to 10); after that, sending back again ends the run as failed.
- **Freeze Output (pin).** In the Inspector, a frozen step is skipped on later runs and its last output is reused.
- **Rerun from Here (restart from).** In the Inspector of a step, once the pipeline has a run that is not running, this starts a new run at that step and keeps the output of the steps before it — cheaper than **Start Over**, which re-runs everything.

A third built-in, **提案落地流程** (proposal landing, id `evolve-landing`), is the path an approved self-evolution proposal takes once you or a commander pane dispatches it: an implementation step, a read-only review step, a CI check step that reports the workflow run's jobs and neither reruns nor merges, and an approval gate only you pass. It is a template: nothing starts it, it is never made the active pipeline, and it has no merge, publish, plugin-load, skill-delivery or schedule step. Navide adds it once to an existing pipeline list; if you delete it, it is not added back. **Reset** restores its stages and its gate. Like the other built-ins, its name is fixed in the seed rather than translated.

A stage can run multiple slots in parallel. Navide advances based on configured completion signals and agent state. Always review generated changes and test results; automated completion indicates workflow progress, not correctness.

## Manager and worker coordination

One slot can act as the global manager. The manager receives cross-stage context, delegates work to workers, handles worker questions, and signals stage completion through Navide's routing protocol.

Use a manager when a task benefits from decomposition or parallel ownership. For small tasks, a single-agent stage is usually cheaper and easier to inspect.

## Automation modes

- **YOLO** passes CLI-specific flags that bypass approval or trust prompts where supported. Some CLIs may already execute tools without a confirmation gate.
- **Full Auto** lets the analyzer answer agent questions from available task context.
- **Strict** asks for confirmation at selected timeout or progression boundaries.
- **Continuous** keeps the pipeline moving according to its configured automation behavior.
- **Local Analyzer** enables local intent classification and related automation.

Start conservatively. YOLO and Full Auto can cause agents to modify files or execute commands without another user confirmation.

## Management by exception

Navide's long-term operating philosophy is to let agents continue through reversible, observable work and return attention to the engineer only when human judgment adds value. Current automation modes are early controls, not a complete policy engine.

Intervene when:

- Requirements have materially different valid interpretations
- Architecture or product choices have lasting consequences
- Sessions conflict over ownership, files, or technical direction
- Tests and stated acceptance criteria disagree
- Credentials, payments, deployment, publication, destructive operations, or external systems are involved
- The result requires subjective product or quality judgment

Routine exploration, reversible edits, local tests, diagnostics, and repairs should eventually proceed without approval noise while remaining visible and interruptible.

## History and token tracking

History is an append-only timeline for pipeline, stage, pane, question, analyzer, handoff, and warning events. Run history is stored under `.agent-team/runs/` and can be filtered or exported.

Token Stats parses compatible local CLI logs and attributes usage to workspaces, panes, stages, and runs. It is an observability feature, not a provider invoice. Provider-side usage and billing remain authoritative.

### Token Monitor

Open **Window → Token Monitor** for a separate window showing local Claude turn history over 14, 30, or 90 days. Reopening the command focuses the existing monitor. The existing **Turn Stats** modal remains available for inspecting one pane. Model filters, per-turn trends, and per-turn averages and medians summarize the selected local records.

Transcript records have **unknown account attribution**: a shared local Claude history cannot establish which signed-in account produced a turn. Other devices, web conversations, and subagent logs are outside this view. Missing history is not zero usage; partial scan coverage and errors are shown. Large histories are bounded, and refresh can reuse a scan for 60 seconds.

Quota history records successful observations for the active Claude account slot through the existing usage polling service. It starts accumulating when those observations are available; it cannot reconstruct earlier quota windows. Disabled polling and an empty history are displayed explicitly. Opening the monitor does not make extra provider requests. Observed tokens and quota percentages do not establish an official token allowance, throttling, effort level, or separate thinking-token usage.

### Account quota in Turn Stats

Open **Window → Turn Stats**, or use the TOKENS panel entry. **Pane usage**
shows one session; **Account quota** shows activity attributed locally to an
account across panes and models. Saved and historical accounts remain available
without an open pane, including removed profiles and a separate Unknown bucket.
Opening history and **Refresh history** read local records only. A provider
retry follows the existing polling policy; disabled polling stays disabled.

The current provider value belongs to the selected account and window. Its
cached, stale, failed, or disabled state and observation time are separate from
the history-read time. **All accounts** shows aggregate local activity and no
single-account current percentage. Model-window quota percentages and all-model
local tokens describe different populations.

Cycles default to the last 30 days, with 90-day and custom UTC-date ranges.
Membership uses reset time in the half-open range, including ongoing cycles
when the range reaches the present. Tables and charts show at most 50 records
per page; summaries and eligible/excluded average counts cover the entire range.
Select a cycle with its button or chart to inspect source evidence, full local
and UTC timestamps, breakdown, changed readings, and last reconciliation.
The local-token-per-percentage-point ratio is total divided by a nonzero
observed peak, not a provider allowance or price estimate.

Only ended cycles with trusted limit evidence and usable local detail enter
the completed-cycle average. A CLI limit can coexist with an earlier provider
peak below 100%; legacy timestamps remain inspectable and unverified. Missing
or partial detail appears as a gap, while an observed zero remains zero. Local
totals use five-minute slices without boundary prorating. Late data can
reconcile retained ended cycles; saved finalized totals survive slice expiry.

Month and Year retain **UTC calendar** buckets. A date range selects whole
intersecting buckets, whose expanded boundaries are displayed. Tokens use event
time; cycle counts use their start time, or reset when the start is unknown.
Window filters affect cycle statistics only, and overlapping quota windows are
never added together as account consumption. Account shares refer to the same
period's observed local activity and stay unavailable when coverage is incomplete.

**Export selected range** exports all selected records in one consistent
response, up to 10,000 rows; narrow the range if it exceeds that limit. CSV
includes identity, evidence, coverage, eligibility, UTC timestamps and time-zone
metadata. Partial/unavailable numeric token cells are empty, correcting the old
missing-as-zero export; a known zero is `0`. Manual keyboard, theme, language,
and real-reset acceptance remain separate from automated fixture checks.

## Git and review

Navide includes a factory installation of the official Git package. Its active package version supplies both the embedded left view and the dedicated Git window. Bundled Git cannot be removed; disable it in Extensions instead (see below). A verified Marketplace version takes precedence when present. The view supports repository discovery, working-tree inspection, staging, commits, branches, remotes, issues, and related workflows; multi-repository workspaces can switch between discovered repositories. Discovery scans run without blocking the backend and return partial results after a bounded scan period on slow filesystems. Repository operations stay local to Navide's Host/backend boundary, and GitHub/GitLab issue detection uses the configured `gh` or `glab` CLI when available. If the selected v2 package cannot load, mount, or report ready, Navide labels and uses the retained legacy Git renderer for that process. Security, trust, or permission denials do not trigger fallback.

Review changes before committing, especially after automated or parallel runs. Navide does not make an agent-generated change safe merely because it appears in the Git panel.

## Editor and AI terminal

The editor uses Monaco and provides file editing, diagnostics, plan rendering, diffs, conflicts, and AI-assisted workflows. The right-side AI panel embeds a real coding-agent CLI terminal (the same agents as the main window) and injects editor context when it starts.

These tools are the Intervention surface of the wider engineering environment. Navide's goal is eventually to provide the complete professional workflow without requiring a traditional IDE as the user's primary environment.

## Skills through Navide MCP

An authorized agent can use the same library as **Settings → Skills**:

1. Call `skills_list`, then pass a returned ID to `skills_inspect` for instructions, files, ownership, provenance and the current `delivery_revision`.
2. Call `skills_prepare_install` with `owner/repo`, an HTTPS `github.com/owner/repo` URL, or an absolute local skill folder (`~` is expanded). For GitHub, pass `ref` and `subdir` separately; `subdir: "."` selects the repository root. Multiple candidates return `selection_required` and `candidates` without an installable preview ID. Choose a path and prepare again. Private repositories, arbitrary URLs and GitHub tree URLs are unsupported.
3. Review the full instructions, file inventory, script warnings, source and digest. Call `skills_install` with the preview ID, exact digest and explicit targets. This only files a request: the user approves or rejects it in the Navide window, which also grants the first shared-root write, and `skills_install_status` reports the outcome. An agent cannot approve on the user's behalf. Installation rejects any same-name managed, user-owned or native skill. It exclusively creates the destination and publishes `SKILL.md` after attachments and metadata, so discovery does not see an incomplete package; this is not an atomic directory rename.
4. For later delivery changes, call `skills_set_delivery` with the skill ID and latest `delivery_revision`. Stale revisions fail without replacing another client's decision. A change that only removes CLIs or turns the skill off applies at once; one that reaches another CLI or turns the skill on waits for your approval in the Navide window, like an install. This workflow adds skills; it does not update or refetch an existing installation.

Prepared bytes belong to the authenticated caller and expire after 15 minutes or backend restart. Installation uses those bytes without rereading the local source or fetching GitHub again. A permission retry can reuse an unexpired preview. While its retry receipt remains available, replay returns the original result without writing again. There are at most eight active preparations plus a separate cache of at most eight lightweight completed retry receipts. Successful installation releases package bytes and the active slot. Receipts expire at the original preview deadline; when the cache fills, the oldest successful installation receipt is evicted first. Retry after expiry or eviction returns missing/expired without reinstalling. GitHub downloads are capped at 64 MiB compressed, 128 MiB expanded and 4,096 entries; a selected skill is limited to 512 files, 8 MiB per file and 32 MiB total, and prepared previews share a 64 MiB memory budget. Repository housekeeping — `.gitignore`, `.gitkeep` and `.DS_Store` files, and everything under `.git/` and `.github/` — is left out of the installation and listed under `excluded` in the preview; it does not count toward the limits. Any other dotfile, the `.navide` marker included, rejects the source. Unsafe paths, links, special files, reserved metadata and invalid manifests are rejected rather than omitted.

For shared skills, `targets: null` selects all wired vendors and `targets: []` stops Navide's extra delivery. For native skills, targets opt other CLIs in; an empty list or `null` clears those extra routes. CLIs that read the shared root themselves may discover a skill regardless of Navide's targets or enabled switch. These settings are not an isolation boundary.

`materialized_in_current_session: null` and `loaded_in_current_session: null` mean current-session materialization and loading are unknown. The compatibility field `delivered_to_me` also describes configuration. Start a new CLI session after changing delivery and verify loading there; an installation or routing response is not evidence that a running CLI loaded new content.

A local provenance receipt records the source, prepared digest and timestamps, survives edits, toggles and restart, and is available through inspection. Its digest describes the installed snapshot, not any subsequent local edits. The management marker and provenance are excluded from existing export and Skills sync; provenance is not preserved across devices. With Skills sync enabled, eligible content and delivery decisions can still propagate through the existing sync flow. Sync carries a skill's files only while its encrypted record fits the 512 KiB sync record limit (in practice at most 64 files, 256 KiB per file and 512 KiB total before encoding); a larger installed skill stays on this device, its enabled and delivery settings still sync, and the Skills page marks it as too large to sync. Matching package limits do not prove that synchronization completed.

Open Skills views refresh after successful backend mutations and reconnects, preserving unsaved content and its original revision so stale saves still conflict. Direct edits by other filesystem tools require manual refresh. Preparation and installation never run bundled scripts or plugin hooks; later skill use remains subject to the CLI's tools and authorization.

## Settings and portability

**Settings → Language** is a separate page after Appearance in the sidebar. Choose Traditional Chinese, English, or Japanese; this user-level preference applies to every workspace. On first launch, a Japanese system language selects Japanese when no language preference has been saved. Language changes also reach the onboarding screen, native Navide menu labels, and standalone Plans and Token Monitor windows. Operating-system menu roles and externally supplied content may retain their own language.

Settings cover roles, pipelines, MCP servers, analyzer behavior, AI providers, appearance, keyboard shortcuts, and the separate **Execution Policy** tab. When Navide stops an MCP server (on quit, on a reload, or when the server fails to start), it also ends every process that server started that is still running, including a program the server opened for you, such as a browser it launched. That tab shows the read-only Host default, lets you create or edit one global `full`, `allowlist`, or `denylist` user policy, and keeps first-level system namespaces separate from top-level shell executable names. Full mode requires an explicit high-risk confirmation. For an open workspace it also shows the untrusted repository recommendation and lets you explicitly choose the Host default, user policy, or an accepted repository policy. Corrupt global policy state has a separately confirmed rebuild that preserves workspace source selections; an unsafe or unavailable policy directory instead requires manual remediation. The Extensions view shows a package's Manifest Permissions and exact package-version Grant separately from the selected agent Execution Policy. A Navide plugin installed from the Navide Marketplace can be **Disabled** there: Navide stops it and no longer loads its views or backend, including after a restart, while its files, Grant and stored data are kept. The row shows a Disabled badge and an **Enable** button, which restores it under the same Grant. Updating, rolling back and removing still work while it is disabled, and an update keeps it disabled. The bundled Plans, Git and Mini-IDE packages cannot be removed, but each can be **Disabled** on its Bundled row. A disabled built-in shows no tab, window or legacy recovery view, and agents cannot reach it: with Plans disabled the `plan_*` MCP tools leave the tool list and a call answers `PLUGIN_TOOL_UNAVAILABLE`, no plan assets are provisioned into workspaces and phone feedback on shared plans is refused; with Mini-IDE disabled, opens that only the Mini-IDE can serve are shown disabled while opens to an external default editor keep working. Its Grant and stored data are kept and **Enable** turns everything back on. An agent CLI that read its tool list while Plans was disabled sees the `plan_*` tools again once it reconnects or restarts; Navide cannot push the change to it. Phone feedback refused while Plans is disabled is not kept for later. The switches are saved with a backup copy: a damaged file is rebuilt from the backup (Extensions says so), and if both are unreadable Plans, Git and Mini-IDE stay disabled until you choose **Reset switches**. A Git or Mini-IDE that an earlier version removed comes back Disabled, and its row says that the earlier removal deleted its stored data. **Install from .vsix file…** installs a Navide plugin package file you pick yourself. Navide has not reviewed such a package and it is not signed, so its author cannot be confirmed: the dialog says so, shows the publisher as self-declared and the package as not scanned, and asks you to acknowledge the risk before you can consent. A file install never updates automatically. What you approve takes effect at once, without **Restart** or relaunching Navide: a first install is active as soon as you approve it, and an approved update (or an agent's automatic update that discloses exactly what the running version does) switches right away. The dialog says so before you approve: the plugin's open views reload; a view that saves its state through the Navide SDK comes back where it was, and anything else not saved in them is lost. Right before switching, Navide checks again that the new version's views start; if they do not, the running version keeps running. While a switch is under way, the plugin's panels say so instead of going blank. Each switch is recorded in the announcements with **Back to** the previous version. A file update keeps the file version it replaced, and going back to it asks for your consent again. If a switch fails, the previous version keeps running and the update stays staged: for an update you approved, Settings → Navide Plugins shows the reason at once with **Restart** and **Discard**, and the announcements list it with **Apply now** the next time Navide starts; for an agent's automatic update, the announcements show the reason with **Apply now** right away. Replacing an installed Navide plugin of the same id, in either direction, is asked first, and the replacement starts with no permissions, native backend consent, file-change permissions or agent tool approvals from the version it replaced; when the source changes, its stored data (native backend data and view storage) is kept aside rather than handed over, and going back to the Navide Marketplace version offers to take it back (off by default); **Switch back to the Navide Marketplace version** on its row does the reverse. **Developer Mode**, off by default, lets you load a Navide plugin you are developing from a folder: inside Navide it can be turned on only on this page and every change made there is recorded, a banner stays above the list and every launch reminds you while it is on. Another program running as you, an agent CLI included, can also change the settings file (Navide Guard grades an agent's write to it as critical), but Navide keeps a signature of every entry it writes itself: an entry it did not write is not applied. The switch stays off and the folder is not loaded, the banner and the launch reminder say so and the activity log records it, until you turn the switch on again on this page or consent to that folder again. The same happens after upgrading from before 0.2.28 or when the signature file is missing: you turn the switch on once more and consent to each folder again. See plugin-development-v2.md for the limits. A folder is asked about again whenever its declared permissions or backend change, not when you edit its files, its native backend program included. In a packaged build it is also what allows a self-hosted Registry (`AGENT_TEAM_MARKETPLACE_URL`); with it off, a Navide plugin installed from one is not loaded and the page says so.

**Settings → CLI Agents** presents one card per agent. Use search and the All, Enabled, or Needs Attention filters to find an agent, or toggle its enabled state. To reorder agents, choose **All** and clear the search, then drag cards using the grip to the left of each title. Reordering is disabled while a filter or search is active. At least one agent must stay enabled. Choose **Manage** to open that agent’s drawer, with Overview, Launch, Permissions, Push, and Install sections stacked on one scrolling page. Changes use the existing automatic persistence; there is no separate Save step. Close the drawer, or press Escape, to return to the cards before closing Settings.

The Install section manages the installed coding CLIs: version, install method, duplicate installations, the result of the CLI's own last update, and buttons that run that CLI's official update and diagnostic commands in a terminal. Resume on Open can restore one CLI, the first Grid page, or the active tab; the Grid-page choice follows the Grid preset even when the saved layout was not Grid. Navide surfaces and runs vendor commands; it never updates a CLI itself. Exported settings redact API keys and tokens. Review MCP commands and environment variables before enabling third-party servers.

**Accounts** keeps one card per CLI account, signed in through the CLI's own sign-in. Navide 0.2.32 removed the portable credential a card could hold (a pasted value such as the one `claude setup-token` prints): on a device that used it, the update erased the stored values, and new Claude panes use Claude's own sign-in, which may be a different account with its own quota.

**Naming an account.** Every account can carry a name you choose, the built-in Default included: hover its card in Accounts and click the pencil, or use the pencil on a row of the quota badge's account list. That name leads wherever the account is shown — the pane header, the account list, the cards, switch notices and Turn Stats — and the signed-in identity stays beside it; clearing the field returns the card to its generated name (Account 1, Account 2…). For the CLIs whose credentials carry no identity, a name you give is the only way to tell two accounts apart. The name belongs to the account slot, not to the login: if that slot is later signed in with a different email, the name stays as it was.

The pane header's quota badge now names the account its figure was read for, in its own section in front of the percentage: your name for the account, or the part of the signed-in email before `@` when you have not named it. The figure alone takes the warning and out-of-quota colours, the whole badge stays dashed while a reading is in flight, and the full address is in the tooltip. A narrow pane shortens the section to the name's first character. An account with no name, no identity and no second account of that CLI to be told apart from adds nothing to the badge, which then looks exactly as it did before. The figure belongs to the CLI's current account, which for a pane started before an account switch is not necessarily the account that pane is still running on.

**Switching accounts when a CLI runs out of quota.** When the active account of a CLI hits its usage limit, Navide files one incident for it — however many panes or windows saw it — and acts on the account-switch policy: **Off** (nothing happens), **Notify** (the default: an announcement lists the other accounts of that CLI you could switch to, each tagged with the reliability of its reading — fresh headroom, expected reset, an older reading, or unknown — and names why the rest are excluded, such as signed out, still exhausted, or already tried), or **Auto** (Navide makes one attempt with the best candidate). Automatic switches are limited to three per rolling five hours and at least ten minutes apart per CLI credential pool; switches you make yourself do not count. Any failure — no eligible account, a credential that could not be moved, a pane that could not resume, or a new account that turns out to be exhausted too — ends that incident with the reason shown; Navide never tries the next account on its own, never switches back on its own, and never re-sends work a pane may already have done. After the original account's reset time the announcement says it is *expected* to have recovered; switching back is a button you press.

Claude Code switches without restarting anything, because it re-reads its credential on every request. Every other CLI keeps the credential in memory, so its affected panes are asked first: a pane that is mid-turn, waiting on a permission prompt, or has unsent input is never stopped — the switch waits until every affected pane is safely idle, then stops them, moves the credential, and resumes each conversation on its own session. A pane that cannot be resumed stops the switch before anything moves. Aider and MiniMax Code cannot resume a conversation, so a switch asks you to confirm a new one instead. Afterwards, three results are shown separately: whether the account switched, whether each conversation resumed, and whether the new account's quota was verified — the last only from a fresh reading of that account (or a turn it completed); if nothing arrives within two minutes the announcement says *switched, quota unconfirmed*. If the credentials moved but the account record could not be saved, further switches of that CLI are refused until you confirm which account is live; nothing is overwritten in the meantime. Likewise, when the live credential no longer matches the active account's copy, a switch is refused: for a CLI whose credential names its account, Navide tells the two apart by itself (a token refresh is not a different account); for one whose credential carries no identity, it asks you to confirm that the live credential is still the active account's, and that confirmation only applies to the exact state you were shown.

Signing in a new account is isolated for Claude Code, Codex, Grok, Kimi, Pi, Droid, and MiniMax Code: the sign-in pane uses a private home, and the active account and its running panes are untouched. The other CLIs keep a single credential store, so their sign-in temporarily replaces the live credential; Navide snapshots the active account first, parks the new sign-in into its own account card when it completes, and restores the active account — also when the sign-in is abandoned. While such a sign-in is pending, Navide refuses to open other panes of that CLI, and it refuses to start one while other panes of that CLI are running. The account-switch layouts of every CLI were read from the vendor's own code; no CLI has yet been round-tripped between two real accounts inside Navide, and MiniMax Code's support is the newest.

These credentials **never leave this machine**: account credentials and keys stay local, so the **Sync** section (Settings → Sync) has no Credentials & Keys row, and a Credentials & Keys switch an older build left on is treated as off. The Sync section shows the sync key's id — the key that encrypts your synced assets, not a CLI credential — and offers to rotate it if you suspect it leaked: every record is re-sealed and paired devices receive the new key.

`.agent-team/` is not currently a portability mechanism. Any future migration between machines should use an explicit local export/import flow with redaction and retention controls rather than Git synchronization.
