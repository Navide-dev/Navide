# Changelog

All notable released changes to Navide will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Plugin API (0.2.36): the Host now has a plugin API version. A package on a newer API major is refused at install and, if already installed, stays in Settings with the reason and contributes nothing. `hostApiVersion()` in `@navide/plugin-sdk` reads the version, and every capability catalog entry says which version it arrived in. Nothing changes for current packages.

- Plugin API 1.1 (0.2.36): `fs.queryFiles` finds workspace files with the matching the caller asks for (name or path, substring, subsequence or glob, its own excludes, Git ignores on or off) and returns match positions in path order, so a plugin ranks results itself. A workspace listing is reused between queries and refreshed on disk changes. `fs.listFilesFlat` is deprecated and keeps working, with removal no earlier than 2027-05-01.

### Fixed

- Pipelines (0.2.36): n8n import is honest about nodes with several outputs that are neither IF nor Switch, such as Compare Datasets. A small region folds into one step whose kickoff follows every output that has items, not just one. A region too large to fold marks that node and the Merge after it as needs review, since every output runs in Navide, also one n8n would leave without items. Workflows without such a node convert as before. Four new strings in all 11 interface languages.

## [0.2.35] — 2026-10-31

### Added

- Navide Browser (0.2.35): Spaces now have tabs and run side by side. **Side by Side** shows up to 9 Spaces at once in a grid, each with its name, owner, who is in control, its state and note, a tab strip and its own live page, and pages through more like the pane grid; **One at a Time** shows one Space full size with a list to switch, and Ctrl+Tab / Ctrl+Shift+Tab move to the next or previous Space as they do for panes. The choice is remembered. A tab is one page of the Space: add (＋, in your own Spaces), close (×) and select tabs, and a page a site opens in a new window arrives as a tab next to the one that opened it. A tab out of sight for 10 minutes is closed to save memory and keeps its address, title and last picture; it loads again when you open it. A tab with an open dialog, one waiting for you and an agent's tab that is still working are never closed this way, and an agent's tab only once it is done or idle. Each Space shows an open dialog (type and message) and every file the agent uploaded (file, website and time), with names that look like secrets marked with a warning icon and label. Eight new agent tools: `browser_close`, `browser_tabs`, `browser_evaluate` (runs script in the page), `browser_wait` (URL, selector or text, at most 30 seconds), `browser_dialog`, `browser_upload` (files inside the pane's workspace, disclosed on the Space), `browser_take_over` (asks the user for control back and waits; it never takes control) and `browser_cdp` (a raw escape hatch limited to the Host's allowed DevTools methods); the first eight tools keep their names and inputs. New strings in all 11 interface languages.

- Shortcuts (0.2.35): ⌘⇧X (Ctrl+Shift+X on Windows and Linux) opens Navide Browser; rebindable in Settings → Shortcuts. One new string in all 11 interface languages.

- Navide Browser (0.2.35): Navide Browser now ships with the App on macOS, Windows and Linux and is enabled by default, like Plans, Git and Mini-IDE; it no longer has to be installed from the Navide Marketplace. Its package carries the App's version and its own native backend for each platform. It can be disabled in Settings → Navide Plugins like the other built-ins, which stops its backend and agent tools until it is enabled again; like them it cannot be removed. A copy installed earlier from the Marketplace keeps running and takes precedence over the bundled one, as for Git and Mini-IDE. Its backend gets the first-party treatment only as the bundled package or an Official Registry install, never from a developer folder or a local file. Two strings (the Bundled Browser label and its risk note) return in all 11 interface languages. It is versioned on its own like the other built-in plugins, starting at 1.0.0.

- Plugin web views (0.2.35): a package may attach several of its browser views at once, each at its own rect clamped inside its plugin view, up to 9 (a 3×3 grid), and keep up to 32 live views; past either cap the Host answers `LIMIT_REACHED` on the Bridge port and `RESOURCE_LIMIT` to `web.*`. A page's `window.open` to an allowed URL now opens a new view in the same Space with the opener's owner and pane, created through the same rules as any view and marked with `openerViewId` (at the cap it loads in the opener as before). While the agent's debugger is attached the Host tracks JavaScript dialogs as `dialog` on the view (message cut to 500 characters), cleared on close, navigation and every takeover, and the agent may answer them with `Page.handleJavaScriptDialog`. `DOM.setFileInputFiles` is allowed only for 1 to 16 existing regular files that, with symbolic links resolved, are inside the calling pane's workspace; anything else is `CAPABILITY_DENIED`. The page gets a Host-private copy of each file, and every upload is disclosed as `uploads` on the view and `uploaded` in the result (path relative to the workspace, the page's origin, and a `sensitive` flag with a `warning` for names that look like secrets such as `.env` or `*.pem`); nothing is refused for its name. The http(s) allowlist, denied permissions, cancelled downloads, per-package partitions, the user-in-control rules and pane isolation are unchanged.

- App Lock (0.2.35): Windows 11 unlocks with Windows Hello, through a small helper shipped with the App (`navide-hello.exe`, x64 and arm64) that opens the system dialog in front of the Navide window; the PIN stays the fallback, and a forgotten PIN can be reset after Windows Hello. Windows 10 and Linux unlock with the PIN only, and Settings → App Lock says so instead of naming a system unlock the machine cannot have. While the lock screen is up, the application menu is greyed out except for Hide, Quit, the window controls and the editing keys the PIN box needs (Toggle Developer Tools and its ⌥⌘I / Ctrl+Shift+I included, so DevTools cannot be opened onto the App underneath; DevTools already open is left alone), and keys typed into a window under the lock screen are dropped, so neither a menu click nor a shortcut operates the App behind it. Agents, terminals, chat channels, MCP tools, remote devices and schedules keep running as before. The user guide (en-US, zh-TW, ja-JP) has an App Lock section. Three new strings and seven reworded ones (Touch ID or Windows Hello by platform) in all 11 interface languages.

### Changed

- Plans (0.2.35, Plans 1.1.0): an image embedded in a plan (a `data:` URI of at least 1 KB of base64) is stored once in its history instead of in every version: a version keeps the plan's text and refers to the image by its SHA-256 under `.history/<plan>/blobs/`, and reading it puts the image back so the plan's bytes come out exactly as they were. On this machine's 40 plans a version of the largest (2.2 MB, mostly screenshots) takes 67 KB instead of 1.6 MB once its images are stored. An image is removed only when no remaining version refers to it, and never while a version cannot be read. Plans with no large images, and versions stored earlier (plain or compressed), are kept and read as before; nothing is rewritten.

- Plans (0.2.35, Plans 1.1.0): a version an agent made names the pane it ran in, so the History panel says "Agent · Reviewer" rather than just "Agent", and edits from two panes are never merged into one version. The pane is named by what the user sees on it (its id when it has no name), resolved from the pane's own MCP token; nothing about its account, credentials or profile is sent or kept. Backend Wire gains an optional `initiator.pane` (at most 200 UTF-16 code units, not blank to JavaScript's `trim()`; a name that would not pass is sent as the pane id instead) on agent calls, which the Host sends only to Plans 1.1.0 and later, so an older Plans package gets exactly the Initiator it always did, and a version from a Host that names no pane is recorded as before. One new string in all 11 interface languages.

- Plans (0.2.35, Plans 1.1.0): the History panel lists every version of a plan with who made it (you, an agent, or a change made outside Plans) and why (a save, a stage change, a restore, a conflict, or the side of a conflict you did not keep), newest first, compressed versions included. **Diff** now also shows the lines of text that changed, besides the stage, todo and review-note summary. **Restore** brings back a version's text after you confirm: the plan keeps its current stage, approval, todos and review notes, the restore is itself a new version, and the text it replaced stays in the history; if the plan changed meanwhile, nothing is restored and the panel says so. A plan that is approved, in progress or done shows **Changed since approval** when its text (not its todo progress or stage badge) differs from the version taken when it was approved; clicking it shows what changed. New strings in all 11 interface languages.

- Plans (0.2.35, Plans 1.1.0): a plan now keeps a version every time its content changes, not only when its stage changes. A save from the Plan view is recorded as yours and a change through the `plan_*` tools as an agent's; an agent editing the file directly is recorded too, as made outside Plans. Saves by the same author within 10 minutes count as one version, and a change of stage is always its own. When you resolve a section conflict, the side you did not keep is saved as a version as well, and the dialog says so. Versions stay in the plan's `.agent-team/plans/.history/` folder next to it, with an `index.jsonl` saying who made each one, when and why; a damaged line in it is skipped without hiding the other versions. Everything from the last 30 days is kept; of older versions the newest 50 are kept; stage snapshots are kept forever, and there is no size limit. Only files in that folder are ever removed. Plans' file permissions in Settings → Navide Plugins now show that folder as read and write (it was read only); no other permission changed. One new string in all 11 interface languages.

- Plans (0.2.35, Plans 1.1.0): **Edit document** above an HTML plan in the Plan view makes the whole document editable at once: every prose section, the plan's name and its overview. Changes save by themselves 1.5 seconds after you stop typing, when you click outside the document, or with ⌘S (Ctrl+S on Windows and Linux), and the bar shows when it last saved; **Done editing** or Escape leaves edit mode and saves what you typed, never discarding it. The document is not reloaded while you type, and each save is checked against what you see, so a section an agent changed after the document was shown opens the same keep-mine-or-theirs dialog instead of being overwritten. The name and overview are saved to the plan's metadata and its header together, as plain text. Todo lists, section headings and the stage badge stay as they are; todos and stage still change through the toolbar and the `plan_*` tools. A section no longer has a 20,000-character limit. Edited text is always cleaned to plain formatting (paragraphs, lists, tables, emphasis, code and safe links), so it can never become a script. New strings in all 11 interface languages.

- Navide plugin agent tools (0.2.35): a new switch in Settings → Navide Plugins, **Let agents call tools from first-party Navide plugins**, on by default, turns the tools of Navide's own plugins (Navide Browser) on or off at once. **Let agents call tools from third-party Navide plugins** now covers third-party plugins only, as its label says, and stays off by default. Everything else stays as it was: external MCP clients still need the third-party switch and their own, the first write in each workspace still asks, and every result is still wrapped as external content and marks the calling pane. With no first-party plugin installed, nothing changes. Two new strings in all 11 interface languages.

- Navide plugin versions (0.2.35): the plugins bundled with the App (Git, Mini-IDE, Plans and Navide Browser) now have their own versions, starting at 1.0.0, which change only when the plugin changes, so Settings → Navide Plugins no longer shows the App's version for them. Between a bundled copy and a Marketplace copy the newer version runs, and on a tie the installed copy does, as before; an older installed copy stays on disk unused and is considered again at every start. Opting out of a bundled copy, `NAVIDE_GIT_RECOVERY=legacy` and `NAVIDE_PLANS_RECOVERY=legacy` keep the installed copy. `plugins/official-plugin-fingerprints.json` records what each bundled plugin shipped in the last App release, and `release.sh` stops if a plugin's content changed without a newer version.

- Channels (0.2.35): in Settings → Channels, a connected Telegram bot in Bot Management Mode shows **Create a New Bot** under it, so the flow no longer sits only in the bot's ⋯ menu, where it also stays. Other bots and platforms look as before.

### Fixed

- Channels (0.2.35): a pane bound to a chat whose sender cannot pass the bot's sender check no longer looks connected while every message gets a pairing reply. Binding still works and nobody is approved by it, but the chat gets a warning instead of the plain confirmation, with the pending pairing code if there is one or otherwise how to get one, and Settings → Channels and the pane's chip menu warn too. In a group only a bot with nobody allowed is detected, and on platforms other than Telegram a stranger's DM gets no warning when someone else is allowed on the bot. Two new strings in all 11 interface languages.

- Windows terminals (0.2.35): while a stalled pane has its output paused, the backend keeps at most 5 MB queued for it instead of growing without limit, dropping the oldest output first, as on macOS and Linux. The dropped byte count is logged when output resumes; it is not marked in a pipeline pane's output log.

- Windows hooks (0.2.35): the PowerShell hooks Navide installs for Claude Code, Qwen Code and Copilot CLI read the port file, make the temp path and delete it with .NET calls instead of `Get-Content`, `Join-Path` and `Remove-Item`, so a hook run no longer loads the Microsoft.PowerShell.Management module; on a Windows 11 arm64 machine with Defender on, that load took about 23 seconds per run before the hook reached Navide. Exit codes and output are unchanged. The new text is written at the next backend start through the existing CLI-config tracking: Qwen's `settings.json` change is logged with a backup in Settings, and Claude Code's and Copilot's copies live in Navide's own data.

- Plans (0.2.35, Plans 1.1.0): saving or deleting a section in the Plan view no longer overwrites what an agent wrote to the same section while you were editing it. The save is checked against the document you were looking at: when only other parts of the document changed, your section is saved and their changes are kept, and the view says so; when the same section changed, nothing is written and a dialog shows your version and the one on disk side by side, each with a copy button, until you choose which to keep. The version you did not keep stays on screen, still copyable, until you close the dialog, and Escape does not close it. This applies to HTML and markdown plans. Every Plans write now also checks the file's content hash as well as its modification time, so a change that kept the modification time is caught too. The open document reloads by itself when it changes on disk; while you are editing it, a notice says so and it reloads when you finish. The Plans plugin is now 1.1.0. New strings in all 11 interface languages.

- Shortcuts (0.2.35): on Windows and Linux, Open Plans, the Git window and the Mini IDE have working default keys. They were bound to ⌘ only, which is the Win/Super key off macOS. Open Plans now answers Ctrl+Shift+D and the Git window Ctrl+Shift+G; the Mini IDE answers Ctrl+Shift+M, because Ctrl+Shift+I stays Toggle Developer Tools there. macOS keys are unchanged.

### Security

- Channels (0.2.35): redeeming a link code no longer puts a new sender straight on the allowed list. Someone not yet allowed gets the same pairing request as a stranger's DM, listed as Link code in Settings → Channels, and is linked once you approve it; a sender already allowed links at once. On Telegram a `direct` code sent in a group is refused, because it only travels in a DM link. Telegram's shared ids (`1087968824` GroupAnonymousBot, `136817688` Channel_Bot and `777000`) are never admitted, even from an older allowlist row, and a message sent on behalf of a channel or anonymous admin carries no sender and does not pass. Settings → Channels shows the allowed list even when it is empty, says how and when each sender was added (senders from before this release show "—"), and marks a row holding a shared id with a warning; nothing is deleted for you. The external-content fence around chat text now also catches disguised boundary markers (fullwidth brackets, both Chinese scripts, zero-width, bidi and control characters, and marks or fillers inside a marker). Four new strings in all 11 interface languages.

## [0.2.34] — 2026-10-30 — signed release

### Added

- App Lock (0.2.34): Settings → App Lock puts a lock screen over every Navide window, the editor, Plans and Git included, and unlocks with Touch ID (which falls back to the Mac's password) or a 4-to-12-digit PIN. It is a privacy screen, not access control, and the page says so: agents, terminals, the backend, chat channels, MCP tools and schedules keep running, terminals keep their scrollback, and DevTools is not touched. It locks from File or the app menu with Lock Now (⌘⌥L or Ctrl+Alt+L), after 1 to 60 minutes without keyboard or mouse input anywhere on the machine, when the screen locks, when the machine sleeps, and optionally at start (off by default). The PIN is stored as a scrypt hash with a random salt in `app-lock.json` in Navide's data folder (owner-only, never synced, not in the keychain); five wrong PINs start a one-minute wait that doubles each time, up to 15 minutes. A forgotten PIN is reset after Touch ID, or by deleting that file while Navide is closed. Windows Hello and the Linux notes follow in later releases; until then Windows and Linux unlock with the PIN. New strings in all 11 interface languages.

- Guard and MCP (0.2.34): third-party MCP tools that run commands are graded like the built-in shell. A tool named `mcp__<server>__<tool>` whose `<tool>` is in Guard's table (`PowerShell`, `bash`, `shell`, `run_command`, `execute_command` and the like, matched exactly) has its `command` graded by the same rules, so `rm -rf ~` sent through Windows-MCP's PowerShell tool is critical as it is in Bash. Desktop Commander's `start_process` and `interact_with_process` input are graded as shell commands and its file tools by the path rules; Windows-MCP's FileSystem tool is graded as the read, write or `rm` it amounts to (any spelling of true for `recursive` counts). Two new built-in rules, `mcp-registry-write` and `mcp-process-kill` (high, adjustable in Settings → Security), cover registry changes and process kills, and a mode Guard does not know is marked not statically judgeable (`mcp-unknown-mode`), which raises it to high on a tainted pane. Nothing a caller passes narrows the grading: generic MCP shell tools (`run_command`, `exec_command`, `start_process` and the like) are always graded as both POSIX and PowerShell whatever `shell` they name, a `mode` on a tool that takes none is ignored, and listing a credential location through FileSystem (`list`, `search`, `info`) is high, as `ls ~/.ssh` is. Every other MCP tool is graded as before. Settings → MCP tags a server that can run shell commands or drive the desktop and explains what it can do in its details, without blocking it. Four new strings in all 11 interface languages.

- Pipelines (0.2.34): the n8n importer uses branch, error and retry edges and sub-pipelines. IF becomes `true` / `false` branch edges and Switch one branch per rule (its output name, else its number) with `default` for the fallback output; the step's kickoff carries the condition verbatim and the engine adds the signal instructions with their code, so no kickoff writes a signal format itself, and a Merge in Append or Choose Branch mode is native, while one that combines data (by fields, position, all or SQL) is an agent step that follows its merge rule. A node with an error output, and a workflow that is its own error workflow, get error edges. Retry On Fail becomes the step's retry, at most 5 tries 300000 ms apart, and the report marks any node whose settings were higher. A read of another node (`$('X').item.json`) gets that step's `{{node.<id>.output}}`, and that step is asked for JSON output. Steps best left in n8n carry how to call them through n8n's MCP server. Execute Workflow becomes a sub-pipeline node when Navide has the workflow it calls: paste the workflows together as one JSON array (as `n8n export:workflow --all` writes) and the called ones are imported first, or import the called workflow before; a workflow imported earlier is reused. A call that would loop back, one to a workflow Navide does not have, and Call n8n Workflow Tool (an agent tool, never converted; its kickoff names the pipeline) stay for review, and the report lists every called workflow. The `pipeline_import_n8n` MCP tool takes the list too. One new and one changed string in all 11 interface languages. New guide: Import from n8n (en-US, zh-TW, ja-JP).

- Pipelines (0.2.34): sub-pipelines. A subpipeline step runs another pipeline and waits for it. The run suspends there with its panes kept open, the other pipeline runs in the same workspace, and the run then carries on with that run's last summary and structured output as the step's output. The step's task template may use the parent's task, the previous step's summary and other steps' outputs. A child run inherits its parent's Guard taint. A child that fails fails the step, which can retry or take an error edge. While a parent waits, starting any other run in that workspace is refused by name until the parent is resumed or reset. Aborting pauses both runs, and reset clears both. Calls that loop across pipelines are refused when saved, and calls nest at most three runs deep. The sidebar shows "Parent › Child" with a link back to the parent pipeline, and `pipeline_status` reports the waiting parents. Open panes add up across the levels. Pipelines without subpipeline steps run exactly as before. 15 new strings in all 11 interface languages; the `pipeline_graph`, `pipeline_status` and `pipeline_start` MCP descriptions document it.

- Pipelines (0.2.34): Import from n8n in the Pipeline Manager and the MCP tool `pipeline_import_n8n`. Paste an exported workflow or choose its file, pick the CLI for agent slots and preview the conversion before anything is written: a canvas colored by how each step landed (native, carried out by an agent, pending), the per-node report, every slot's full kickoff and every gate's prompt, the credentials to set up on this machine, where embedded secrets were removed, how many steps need review and which sub-workflows to paste too. None of it blocks Import, which always creates a new pipeline (a taken name gets " (2)") and opens it; the tool defaults to a dry run and refuses to import while a run is in progress. Imported pipelines show "Imported from n8n", and every run of one, from the window or MCP, resumed runs included, marks its panes as external content; that cannot be switched off. The source JSON and the credential list stay on this machine: the settings bundle export leaves them out, and pipelines are in no Cloud sync scope or share bundle. New strings in all 11 interface languages.

- Self-evolution (0.2.34): a retrospective before a reclaim. With **Retrospective at reclaim** on in the panel (off by default, 3 a day by default), a pane another pane opened (`cli_open_agent`) that has run for over 30 minutes is asked, before the idle sweep, its parent (`cli_reclaim_agent` / `ui.pane.reclaim`) or a pipeline hand-off reclaims it, to write three lines with the new `evolve_retro` MCP tool: what it did, where it got stuck, which step it repeated by hand. The reclaim waits for those lines and the pane's turn end at most 90 seconds, then judges the pane again with the usual guards; a pane still busy then is refused as not idle, as before, and never forced. A reclaim you click (context menu, status bar, Settings, Resource Manager) never asks and never waits. Navide keeps only the lines the pane wrote, masked, in the workspace's own database, and the next run's repeated-work records carry them; it reads no pane output or transcript and uses no CLI hook. With the switch off nothing is sent and reclaiming is unchanged. Four new strings in all 11 interface languages.

- Panes (0.2.34): after the backend restarts, **Resume sessions after a backend restart** (Settings → General, the existing switch) now also brings back up to six panes that were working off screen, besides every pane on screen as before. Resumed panes still stop at the prompt; the panes that spawned them are told, and their reports to those panes are kept. The announcements list the restart: which panes came back, whose turns were interrupted, and which stayed ended and why, each with Rebuild. If the backend crashes again within the same automatic-restart budget, nothing is resumed and the announcement says so. A reconnect whose check comes back as an error no longer treats a pane's CLI as gone, so a live CLI is never rebuilt over. With the switch off, nothing changes. Twelve new strings and two changed strings in all 11 interface languages.

- Scheduler (0.2.34): a scheduled job can start a pipeline run (action `pipeline_start`: a workspace, a pipeline by id or by name, and the run's task). It starts the run the way the `pipeline_start` MCP tool does and never opens a window: when no window holds the workspace, the pipeline is unknown or ambiguous, or the window refuses the start, the run is recorded as an error that says why, not a skip. Agents may schedule it too, within their job limits and with their Guard taint carried into the run. The job editor offers the action, and the list tags such jobs Pipeline and names who created them, the user included. The `scheduler_upsert` MCP description documents it.

- Pipelines (0.2.34): a step can retry. Its retry policy (`maxTries` 1–5 tries in all, `waitMs` between them) runs a failed try again on the same pane — a kickoff that never reached the agent, or an agent reporting `---NODE-FAILED---` — before its error edge is taken or the run fails. The Inspector edits the policy and has Retry This Step for a failed step of a stopped run: it resumes the run when the step is the first unfinished one and restarts from it otherwise, and says why when it is disabled. Steps without a policy run exactly as before. Graph op `set_retry` in `pipeline_graph`.

- Pipelines (0.2.34): a run left at running by a closed or crashed app now reads as interrupted. Each window claims its run whenever it connects to the backend, so a run its window still drives through a backend auto-restart stays active; one no window claims answers `pipeline_status` with `state: "interrupted"`, `active: false` and `resumable: true` and no longer blocks definition edits. Its record is untouched, so opening the workspace still offers resume. 25 new strings in all 11 interface languages for these three entries.

- Pipelines (0.2.34): branch and error edges. A `branch` edge out of a step carries `when`, a value the step's agent reports as `---BRANCH: <value>---` (`default` is taken when no other branch matched) or a `{path, equals}` check on the JSON it reports between `---OUTPUT-START---` and `---OUTPUT-END---`. An `error` edge is taken when the step fails: its kickoff never reached the agent, or the agent reported `---NODE-FAILED: <reason>---`; the run then goes on down that edge instead of failing. A step none of whose inputs was taken is skipped, and so is everything only it feeds; a join runs when any of its inputs was taken. A kickoff can read another step's output as `{{node.<id>.output}}` or `{{node.<id>.output.<path>}}`. Signals are read from the agent's own reply, never from its kickoff, and a step's kickoff explains only the signals its edges need. Stages still run layer by layer, so a step whose inputs are settled can wait for unrelated steps of its layer. The canvas labels branch and error links and lets a selected link out of a step change its type and branch value. Pipelines without branch or error edges run exactly as before. 14 new strings in all 11 interface languages; the `pipeline_graph` MCP tool description documents the new edges.

- Self-evolution (0.2.34): an early run when one error bursts. With **Early run** on in the panel (off by default), Navide's watchdog reads this workspace's error-ledger rows at most every 2 minutes and, when one signature (the S4 triage signature) appears 10 times within 30 minutes (both adjustable), starts a run before the daily time, recorded with trigger `burst`; its task names the signature and the count as fenced data. It still runs one at a time and within the daily run limit — when those would refuse it, nothing is started or recorded and the next check tries again — at most 1 early run a day by default, and the same signature starts at most one in 24 hours. Six new strings in all 11 interface languages.

- Self-evolution (0.2.34): effect checks, adoption and cadence. Seven days after a proposal lands, Navide counts its signature in this workspace's error ledger (rows recorded for this workspace only) and in docs/testing/flaky.json over the 7 days before and the 7 days after, and records effective, not-effective, or insufficient (fewer than 3 in all, or a ledger rotated past the window) in the proposal ledger (migration 4 of `evolve`). Signatures follow the F1 triage rule (the code plus the message with numbers, hex ids and paths stripped), now computed by the backend too, and the landing paths tell the run to use it. A not-effective proposal goes into the next run's task for re-evaluation; no code is ever reverted. Adoption per proposal source (failures, tools, corrections) is adopted ÷ resolved; a source whose last 10 resolved proposals were all turned down is lowered to weekly, with the reason shown in the panel, and only the user raises it back (new setting `retro_freq`, daily by default). A weekly source's section goes into a task once every 7 days; weekly error triage leaves out the SIGNALS and TRIAGE sections in between. The first run of each week carries the week's numbers (proposed, adopted, landed, effective, with the sample size when under 3) for the agent to add to the ledger plan. With an empty ledger, nothing landed and nothing lowered, the task text is byte-for-byte unchanged. The panel lists landed proposals with their counts and verdict, and each source's adoption and frequency. Sixteen new strings in all 11 interface languages.

- Navide plugins (0.2.34): switching an installed plugin to another version — an update taking effect, Restart Plugin, Back to — first checks that the version about to run starts: its views must report ready in hidden views before anything of the running version is drained. If they do not, the running version keeps running and an update stays staged. Back to had no such check before. Between two Navide Marketplace versions, the SDK view state (`createPluginViewState`, the `view-state:` keys only) is copied to the version that runs next, so its views come back where they were; nothing is carried for a local file version or across a change of source. While a switch drains and remounts, the plugin's panels say "Switching <plugin> to <version>…" instead of going blank. The consent dialog now says that a view saving its state through the SDK comes back where it was. One new string and one changed string in all 11 interface languages.

- Self-evolution (0.2.34): landing paths for approved proposals. When either retrospective pass is on or the proposal ledger has entries, the run's task tells it to give every proposal plan a Landing path section for its landing (code, plugin, skill / prompt, pipeline / role, schedule, rule-diff): the steps, and where the user says yes. Code lands as a draft pull request that no agent merges; rule and memory changes stay a diff in the plan; nothing is loaded, installed, delivered, scheduled or started before the user approves. The task also says that only the user or a commander dispatches the work, never the run itself. With both passes off and an empty ledger the task text is byte-for-byte unchanged. A third built-in pipeline, 提案落地流程 (`evolve-landing`): implement, read-only review, a CI check that only reports (no rerun, no merge), then a gate only the user passes. It is a template that nothing starts and that is never made active. Existing pipeline lists get it once on upgrade, and a deleted one is not added back, also across a settings import. Reset restores its stages and its gate, while Reset on the default and maintenance pipelines still drops their graph as before.

- Self-evolution (0.2.34): two retrospective passes besides error triage, each a checkbox in the panel with its own 50k-token sub-budget inside the run's budget. Repeated manual work (on by default) gives the run this workspace's message-log rows and scheduled-job runs of the last 7 days as masked group keys and counts (a message's group is its sender, recipient and first 40 characters with numbers, hashes and timestamps removed; 3 or more in the week), so it can propose a plugin, skill, prompt, pipeline, role or schedule. Your corrections (off by default) counts the user's review notes on this workspace's plans and the ledger's rejection reasons (2 or more plans in the week), so it can propose a rule change. Navide gathers these records itself and leaves out every other workspace; the rules no longer need scheduler_list or scheduler_runs, which list every workspace's jobs. Every proposal is labelled kind "<source>:<landing>" with a signature in evolve_report, and the limit stays 3 proposals per run. With both passes off the task text is byte-for-byte unchanged and the rules version stays 3. Five new strings in all 11 interface languages.

- Self-evolution (0.2.34): a proposal ledger. Each proposal a run reports gets a row in the workspace's own database (table `evolve_proposals`, migration 3 of the `evolve` component), and its status follows the proposal plan's stage, with nothing extra for the user to do: draft and in-review read proposed, approved and in-progress as they are, abandoned reads rejected with the user's last review note (masked) as the reason, and done reads landed once a note names a commit the repository has or a PR, in progress otherwise. A plan that is gone, or outside the workspace, reads abandoned. The ledger is brought up to date when a run starts and when the panel opens. The next run's task lists the last 30 days of rejected, approved and in-progress proposals as fenced data, with a rule not to propose a rejected signature or topic again without new evidence; with none of those the task text is byte-for-byte unchanged and the rules version stays 3. The panel's last result shows each proposal's status and a rejection's reason, display only. Seven new strings in all 11 interface languages.

- Panes (0.2.34): a pane whose CLI started before its MCP servers or skills changed now says so. Its title bar shows Settings changed, and clicking it rebuilds the pane (the same resume as ⌘R). Settings → MCP and Settings → Skills list those panes, each with Rebuild, plus Rebuild all idle, which skips panes in the middle of a turn. Navide never rebuilds a pane on its own. The MCP side compares the servers in the CLI's own config file (only the MCP section of `~/.claude.json` and the like: server names, commands, arguments, URLs and env/header key names, never their values), not Navide's Settings → MCP servers, which no CLI reads. The check runs every 30 seconds, on window focus and after a skills change, and only reads files. Settings a CLI reads only at start are tagged New panes only, and the new docs page `docs/en-US/apply-timing.md` lists what takes effect when. Thirteen new strings in all 11 interface languages.

- Pipelines (0.2.34): a backend converter turns an exported n8n workflow into a new pipeline graph, with a conversion report, a credential checklist and the source JSON (`n8n_import.convert_n8n_workflow`). It uses only today's trigger, slot and gate nodes and main edges, and every result passes graph validation. Runs of nodes with no branching, small IF/Switch regions and loop bodies each become one slot; an AI Agent and its model, memory, tool and parser sub-nodes become one slot whose CLI follows the model (Anthropic → Claude, OpenAI → Codex, Gemini → Gemini); Wait and send-and-wait become gates; disabled, No Operation and Sticky Note nodes are left out and listed. Unknown node types, unknown typeVersions and community nodes become agent steps marked for review instead of failing. Schedule, webhook and app triggers, sub-workflows and large branches are imported and marked pending. Authorization headers, API keys and common token shapes are replaced with a placeholder everywhere, the stored source included, and the report says only which field of which node lost one; credential ids are dropped. Every kickoff opens with an external-content notice and the report carries a Guard taint record. Nothing calls it yet: the MCP tool and the import dialog come next.

- MCP (0.2.34): agents choose which account a pane they open runs on. `cli_open_agent` takes `account`. By default (`""` or `"inherit"`) a Claude pane opened by a Claude pane that runs inside an account's own folder opens in that same folder, so it spends its parent's quota; every other caller (a pane on the live login, another CLI, a host or external client) gets exactly the pane it got before. `"active"` opens on the live login as before, and an account id opens a Claude pane fixed to that account's folder. An unknown account, one of another CLI, a CLI without account folders, and an account not yet signed in inside its own folder are refused before anything opens, the last with a pointer to `cli_account_sign_in(mode="folder")`; a parent whose folder has signed out falls back to the live login with a notice. `cli_account_switch` takes `pane_id` to move one Claude pane to another account, the way the account badge's "switch only this pane" does: it asks in the same confirm dialog, which now shows a Pane to move row, and the pane reopens on its conversation in that account's folder while the live login and every other pane stay as they are. Its description now also says what a CLI-wide switch moves. `cli_get_status` reports the account each pane really runs on (`account`: its own folder or the live login, the live account, and its pin), and `cli_accounts_list` lists each pane's account under `panes`. Three new strings in all 11 interface languages. (#728, #729, #731)

### Changed

- Settings (0.2.34): a design pass across the Settings window (#751, #764, #765). Pages share one row layout, one list style (Memory, Git accounts, CLI extensions, MCP, Credentials and Status Badges are one grouped card with dividers), one empty state and one underline tab strip, Navide Cloud's subtabs included. Plugin pages show loading and error states instead of a blank page, and an error follows a language switch. At narrow widths the Security and Shortcuts tables stack, toolbars wrap as one group and Help switches to a chapter picker. No Settings text is smaller than 12px, keyboard focus shows a ring on text fields and searches, and the CLI agent card's lone "!" now reads Needs attention. Copy uses plain words instead of internal ids; the MCP and Analyzer "Applies to" lines say in words where the data is kept, with the path in the open-folder button's tooltip. The Navide Plugins page title shows "Developer Mode on" or "Native code on" in full, while the sidebar rows keep only the ⚠ mark. Check for updates is a regular button. STARTING badges across the app have higher contrast. ja-JP, de-DE and ru-RU copy is corrected in several places. New and reworded strings in all 11 interface languages.

- Languages (0.2.34): the Russian interface translates agent (агент), pane (панель), session (сеанс), skill (навык), workspace (рабочая область) and turn (ход) in 1,186 strings, and the German interface translates Pane (Bereich) and Turn (Runde) in 844 strings, instead of leaving them in English. Feature names such as Turn Stats, Pipeline Manager and Navide Cloud stay in English. In Russian, панель now names both a pane and a panel. (#760)

- Pipelines (0.2.34): errors say why, in the interface language (#766). A refusal from the editor, the sidebar's Run, saving a pipeline or stage, or a graph check names its reason and the step it concerns, and the toast has a Details button for the full message; MCP callers get the same English messages as before, with codes added. A start whose first-stage agents all fail to open is now reported as a refusal instead of failing silently. Send Back asks first when it would end the run, a run-ending Send Back shows a toast, and the sidebar's gate shows the gate's prompt with a field for the reason. About 60 new strings in all 11 interface languages.

- Pipelines (0.2.34): the editor's layout and the ways into it (#768). Set as Default, Export/Import JSON, Import from n8n, Reset and Delete moved behind one ⋯ menu, so the toolbar no longer pushes the pipeline's name or Delete off screen, and the Inspector's footer is one row (Freeze Output · Recover ▾ · Delete). A step's settings have a Leads to section to add, retype or remove its branch and on-error links without hovering the canvas, with help on how branch values match. Retry This Step, Rerun from Here, Resume, Start Over and Reset are in one Recover menu, each with a one-line description and the reason when it is off; with an earlier run selected in Executions, Recover is off and offers Show Latest Run. Abort from the editor or the sidebar asks first (the `pipeline_abort` MCP tool and closing a workspace still do not). A new pipeline opens as soon as it is created, the sidebar's ⚙ is now labelled Manage Pipelines, the sidebar and the manager count steps, and Executions with no run offers Run. New strings in all 11 interface languages.

- Pipelines (0.2.34): one run per workspace is enforced by the backend too, and a run no longer changes the default pipeline (#767). Starting or resuming while a window still drives a run is refused with its reason, from the window, MCP and schedules alike, before any pane opens; a run left at running by a crash still starts over. Resetting a custom pipeline drawn with gates, loops or branches asks first and says those go too (the `stage_define` MCP tool needs `discard_graph`). A scheduled `pipeline_start` job is checked when saved, Run Now refuses when no window holds the workspace, and the job row shows why a run failed in the interface language. Starting a run from the editor, a schedule or MCP, Start Over, resume and sub-pipeline calls no longer switch the active pipeline. Graph operation errors name the operation's index and list what is allowed, and MCP answers carry the window's error codes.

- Pipelines (0.2.34): wording follows the interface language (#771). The built-in pipelines and the default roles' descriptions are shown in the interface language while they keep their original text (a renamed one shows your name; stored rows are not changed), and the sidebar's Next → stage and status words are translated. The Pipeline Manager says where pipelines are kept and how to move them (Export Settings Bundle) instead of printing the database path. In zh-TW and zh-CN the Manage Pipelines button reads 流程管理, like its window, and pane wording follows the glossary in more languages. The n8n report's note on schedule triggers now points to a scheduled `pipeline_start` job. The user guide's Pipelines section and the Import from n8n guide (en-US, zh-TW, ja-JP) describe the app as it now works.

### Fixed

- Pipelines (0.2.34): the editor and sidebar say what their controls do and why they are off. Reset asks first, in the sidebar and in Executions, and lists every pane it will close, the ones the run did not open marked; it is styled as destructive and still closes and clears exactly what it did (the `pipeline_reset` MCP tool still resets without asking). The swimlane labels branch links "If <value> → layer N" and error links "On failure → layer N"; only reject links read "Back to layer". Next in Executions is disabled, with the reason, while a gate waits and on the last stage, and the sidebar's last stage explains how the run ends instead of showing a Finish button that never worked. A sub-pipeline node's Inspector title is translated, its pipeline list leaves out the pipeline being edited (not the running one), its links out can be branch or error links, and the palette's Sub-pipeline is disabled, saying why, when there is no other pipeline. A failed step's reason shows in the Inspector's Output tab and the Executions header. A disabled Run (sidebar and editor) and Import from n8n say which condition holds them back, and the n8n preview's Needs review count matches its banner. 15 new strings in all 11 interface languages; two strings no longer used were removed.

- Pipelines (0.2.34): a step's branch, output and failure signals can no longer be forged by text the agent only shows. They were read from the end of the pane's screen whenever the CLI's turn had not been recorded yet, which for Claude Code and Codex was every step their own turn completed: an echoed kickoff, a file or web page the agent read, or an imported n8n template could print `---BRANCH: …---`, an `---OUTPUT-START---` block or `---NODE-FAILED---` and choose the branch, set the output downstream reads, or fail (and retry) the step. Each kickoff now names a random signal code on its last line, and a signal counts only with it (`---BRANCH:<code>: <value>---`, `---OUTPUT-START:<code>---` … `---OUTPUT-END:<code>---`, `---NODE-FAILED:<code>: <reason>---`); the kickoff writes its formats with the word 代碼 where the code goes, so its own echo is never a signal, and a retry gets a new code. Claude Code and Codex signals are read only from their turn text, never from the screen; for other CLIs only the screen after the kickoff counts. Pipelines without branch or error edges, output contracts or retries are unchanged. The `pipeline_graph` MCP tool description documents the code.

- Pipelines (0.2.34): a Codex slot in a stage that allows questions now shows its own question in the asking dialog, with its options (#733). Codex echoes the whole kickoff in its pane, so the dialog showed the protocol's QUESTION examples, or, when a screen redraw had damaged an example's end marker, a stretch of the kickoff with no options. Claude and Codex questions are now read from the turn text in the CLI's own log, like their stage sentinels; for other CLIs the screen scan skips the protocol's examples and pairs each end marker with the nearest start marker before it.

- MCP (0.2.34): the backend keeps an agent's MCP connection open for 75 seconds between calls instead of 5, so an agent that pauses between calls reuses its connection instead of opening a new one each time; with many panes the old behavior could run short of local ports, seen once as `cli_usage` failing with `EADDRNOTAVAIL`. The `cli_usage` description now says that it only reads cached usage and never contacts a vendor, that each snapshot's `fetchedAt` says when it was read, and that a connection error means the link to the backend failed, not that the quota is unreadable. (#727)

- Pipelines (0.2.34): Import from n8n fixes (#761). A Switch in rules mode (v1/v2) now leads each rule to the output it names; it used to wire rule i to output i and run the wrong branch. A Merge v1 in pass-through or wait mode is a native join, and a loop that polls (an IF back to an earlier node) says it repeats until its exit condition holds, naming a Wait folded into it. Pressing Import again within 10 minutes, or the dialog's own resend after a timeout, opens what the first request made instead of creating "X (2)". A workflow over 5 MB is refused before it is sent instead of dropping the window's connection, and an import of several workflows that fails part way removes what it wrote and names the workflow and its problems. After an import a toast says how many steps need review, those steps carry a ⚠ mark on the canvas, rows to review come first in the report, "(+n)" expands to the merged node names, the called workflows say "Importing creates N pipelines", and the report, warnings and errors read in the interface language. Long IF chains convert much faster (800 nodes: 4.4 s to 0.7 s). New strings in all 11 interface languages.

- Channels (0.2.34): once a Claude question relayed to chat was answered and submitted, the chat no longer gets a second ⏸ prompt that shows only Claude Code's input box with `yes <id> / no <id>` and later turns into ✔ 已在電腦上處理. For Claude and Codex, which ask only through a numbered menu, a screen with no menu is not relayed: the real question's message stays and is marked as handled at the computer when the pane stops waiting, and the next menu is still relayed. Claude's MCP elicitation, which draws no menu and could not be answered from chat, is no longer relayed. Other CLIs are unchanged. (#769)

- Panes (0.2.34): a Claude pane stops reading AWAITING as soon as the question or permission box it was waiting on leaves the screen. After Submit it used to stay AWAITING while Claude thought, until Claude's next real output, so its badge was wrong and inter-CLI messages and MCP dispatch held the pane back. A wait raised by Claude's own notification, and a question still waiting for its answer, are kept as before. (#770)

- Settings (0.2.34): the Navide Plugins pages unfold under Navide Plugins in the sidebar only while that entry is open; they used to stay unfolded with, for example, Navide Marketplace selected. A search hit or a link to one of those pages opens it unfolded, and the folded Navide Plugins row carries its ⚠ marker. (#730)

- Dev web mode (for developers, 0.2.34): the isolated backend reads its scratch home folder instead of the real `~/.claude` and `~/.codex`, and its pane home shims no longer link the developer's real CLI files (#758); the packaged app is unchanged. Two dev web servers on different ports no longer overwrite each other's dev token (#771). `docs/en-US/ui-verification.md` describes checking the main window with dev web screenshots (#732).

- Tests and CI (0.2.34): the reap-window test allows one clock tick on Windows (#744), a failed-helper test ends its helper before the next test starts (#745), and the credential watcher test writes its file atomically so a slow runner no longer sees two changes (#756).

### Security

- Dependencies (0.2.34): vue-i18n 11.4.16 and its @intlify packages, for GHSA-83rm-6c8r-g728. Navide does not turn on the affected option (`escapeParameter`), so it was not exposed; the upgrade clears the dependency audit. (#753)

- Scheduler (0.2.34): for a pane, `scheduler_list` shows another workspace's jobs with their name, schedule, owner and timing only, marked `redacted: true`, without their task text or last error, and `scheduler_runs` refuses another workspace's job (`SCHEDULER_CROSS_WORKSPACE`). A pane still sees its own workspace's jobs in full, and the main window and host or external MCP clients see everything as before. (#757)

## [0.2.33] — 2026-10-29 — signed release

### Added

- Pipelines (0.2.33): a run waiting at a gate now shows it on the sidebar's run card, in the list and the detail view (#719): "Waiting for your approval at <gate>", with Approve and Continue and Send Back, which make the same decision as `ui.pipeline.gate_pass` and `gate_reject`. Next is disabled while a gate waits, with the reason under the buttons and as its tooltip, and a toast says once when a run starts waiting. Two new strings in all 11 interface languages.

- Pipelines (0.2.33): the pipeline editor's toolbar has a task field and ▶ Run Pipeline (#721), shown while no run is going in the workspace and enabled once there is a task, a workspace and at least one step. It starts the run the same way as the sidebar's Run, switching the active pipeline when it differs; the task is cleared on success and kept, with a toast, when the start is refused. Executions offers Reset for a finished run of the pipeline, the same reset as the sidebar's. One new string in all 11 interface languages.

- Channels (0.2.33): chat text is translated into all 11 interface languages (#713). The wake notices, the quick menu with its Prompts, Skills, MCP and share lists, file send and receive notices, Telegram's "/" command menu and the built-in prompts' names and descriptions used to read English in zh-CN, ko-KR, es-ES, fr-FR, de-DE, pt-BR, ru-RU and vi-VN; those eight are machine-translated, like their interface catalogs. An unknown or unset language still reads zh-TW. Busy, bind, rate-limit, usage-limit and relay-confirmation messages (`channels/manager.py`, `mirror.py`, `relay.py`) are still zh-TW only.

### Changed

- Onboarding (0.2.33): the first-run wizard no longer has the Environment step (Homebrew, Node, pnpm, Python, uv) (#709). The packaged app needs none of them, and the step made Open App unreachable on Linux, where Node and Python have no install command. Finishing now needs only one AI CLI. A CLI card's Install says which prerequisites it installs first and installs them in order (Homebrew, then Node, then the CLI on a bare Mac); a prerequisite that fails is reported on that card. Installing Ollama, starting it and choosing a first model move from the wizard to Settings → Analyzer, under the Ollama connection status. In Settings → MCP, a stdio server launched with `npx`, `npm` or `node` is tagged Needs Node.js when Node.js is missing, with an Install Node.js button in its drawer. Anyone who already finished onboarding sees no change. Six new strings in all 11 interface languages.

- Settings → CLI Accounts (0.2.33): the first card, the login you had outside Navide, is titled Original login instead of Default, the account in use is marked Active, and Set as Default reads Switch to This Account (#722). An empty Original login that is not in use collapses to one line, "Original login (outside Navide): not signed in", with only Sign In, and no longer offers a switch: switching to an empty slot restores nothing and cleared the live login without warning. Sign In on it now asks first and says the live login is cleared and stays on its own card. A fresh install, where it is the account in use, keeps the full card. Only values change for existing keys; four new strings in all 11 interface languages.

- Channels (0.2.33): Prompts and Skills are named in chat as on each language's Settings pages, and ja-JP wake text says 起こす, as the interface does, instead of 起動 (#714). Telegram bots that registered the old zh-TW or zh-CN `/prompts` description get the new one.

- Dependencies: anthropic 2.3.0, fastapi 0.162.0, certifi 2026.10.23, websockets 17.3, chardet 7.7.0, cryptography 50.0.2 (Windows on Arm stays on 46.0.3, which has wheels), ruff 0.17.2, electron-updater 6.8.11 and @dagrejs/dagre 3.1.3; CI actions setup-uv 10.3.2, setup-python 7.1.0, pnpm/action-setup 6.1.0 and rust-cache 2.9.3 (#697, #705). Electron stays at 44.9.1.

### Fixed

- Channels (0.2.33): waking an offline pane from chat now opens it onto its conversation (#710). The wake only waited 30 seconds for a window to restore the pane, so when the workspace was open but held no placeholder of it, the wake always ended "喚醒失敗". Now a placeholder is reopened in place, a window that holds the workspace opens a pane onto the same conversation (the resume id is checked on disk first), and a workspace that is not open is opened first. The older records of that conversation are retired, so a later restore cannot bring it back twice. This is one shared path for all eight chat platforms. Two new failure reasons, for a window that refused or did not answer in time.

- Channels (0.2.33): the wake button and the typed-command hint follow Navide's language instead of always reading 喚醒 (#711). On Mattermost, whose client may take a leading "/" for its own commands, a message that is just `wake` also wakes the pane, and the hint names it; `/wake` still works there. Not verified on a real Mattermost server.

- Channels (0.2.33): a permission prompt relayed to chat is no longer re-sent every second (#715). Claude Code prints the time left before it auto-denies an unattended prompt, so the prompt text changed every second: each probe retired the relayed prompt and posted a new one, and an answer never matched, so `yes <id>` could not approve it. The countdown is now left out of the prompt text, which also fixes the window's own check and `cli_answer_prompt`; a different prompt is still relayed and an answer to the old one still refused.

- Channels (0.2.33): a permission prompt that Navide Guard will always refuse from chat now offers only 拒絕 and reads "回覆 no <id>（這個動作需要在電腦前允許）" (#717); it used to offer an 允許 button that could never work. The check that runs when an answer arrives is unchanged and still decides.

- File picker (0.2.33): pasting a location such as `app/Services/OrderService.php:137-158` now finds the file and opens it at the start line, instead of showing "No files found" (#723). A query with a `/` or `\` is matched against the relative path instead of only the file name, exact matches sort first, and the picker strips a `:line`, `:line:column` or `:start-end` suffix before searching. This also changes results for other callers of the same search, such as `@file` autocomplete and the Mini-IDE's ⌘P workspace results. Range selection is not done yet.

- Settings (0.2.33): a setting whose control is wider than its row now moves the control under its text, instead of squeezing the text to one word per line and letting the control overflow the card (#725). This fixes Settings → Language, where the language buttons ran off the card, and the Default editor, CLI quota badge and Antigravity credentials rows on General at narrow widths; rows whose control fits are unchanged. On the Language page, the buttons sit in an aligned grid with the check mark beside the name, the repeated section label is gone, and the row is titled "Display language". One new string in all 11 interface languages, and one that only this page used is removed.

- Tests and CI: the CliAccountsPane "updated" stamp test no longer depends on the time zone (#706), and the pluginActivity test checks its bound deterministically instead of against 200 ms of wall clock (#707).

## [0.2.32] — 2026-10-27 — signed release

### Added

- Navide plugins (0.2.32): reloading a Developer Mode folder no longer leaves you with no version running when the new one is broken. Before the running version is unloaded, each view of the new version is opened hidden and must report that it is ready, the same check an install or update makes; a view that does not, or a folder that fails its checks, keeps the running version, and the card says why. The backend is not started for this check, so two versions of it never run at once. A build can mark its output complete by writing `.navide-build-complete` into the folder last: once the folder has that file, it reloads only when a newer copy is written, so a build that is still writing is never loaded half done; a folder without it reloads on any change, as before. `@navide/plugin-sdk` adds `createPluginViewState`, which keeps a view's state in its Host-managed storage across reloads, updates and Restart Plugin. Installed and Marketplace packages, and Navide with Developer Mode off, behave as before. The Developer Mode hint about reloading during a build now names the marker file, in all 11 interface languages; no new strings.

- Skills (0.2.32): Navide ships a skill that teaches an agent to write Navide plugins: the smallest working plugin, which first-party plugin to copy for a panel, window, tab, file access or an agent tool, the rules that most often fail a package, and the write, check, load and try loop with the `plugins_*` tools. An agent installs it with `skills_prepare_install` and the source `navide:plugin-authoring`; you approve it in the main window like any other skill, and the approval card shows the source as bundled with Navide. It is not installed or delivered unless you approve it. Only skills that ship with Navide resolve under `navide:`; any other name is refused. One new string in all 11 interface languages.

- Navide plugins (0.2.32): a third-party Navide plugin's card in Settings → Navide Plugins lists the AI CLI sessions it keeps running in the background after its window closed (#680): "AI CLI running in the background (N)", with the CLI, the package version and since when, and an End button for each. It is shown only for a plugin that declares `aiCli`, and only while it has such sessions; nothing is ended unless you press End. End uses the same stop as disabling the plugin and also clears the session from terminal storage. A third-party session that exits while no view is open no longer counts as running. The Git, Plans and Mini-IDE plugins are not listed. New strings in all 11 interface languages.

### Changed

- Navide plugins (0.2.32): a third-party Navide plugin installed before 0.2.31 no longer asks before its native backend starts. 0.2.31 counted the install dialog as consent only for installs it made itself, so a plugin installed with 0.2.30 or earlier asked at every start until you allowed it. The first time 0.2.32 starts, it looks once at the installed third-party native backends (the active version of each) and treats each one that has no consent, no install consent and was never revoked as allowed for its installed version, as 0.2.31 does for its own installs; this happens only once per profile. Settings → Navide Plugins says on that plugin's row that it was allowed without asking because it was installed before Navide 0.2.31. Navide still asks when the program or its permissions changed since it was allowed, when you revoked its consent, and for a version no install dialog showed (an agent's update or a rollback). With the switch "Allow third-party Navide plugins to run native backends" off, nothing is allowed this way and each plugin is asked after you turn the switch on. Developer Mode folders keep their own folder consent. The sandbox requirement is unchanged: without a sandbox a native backend does not run. A plugin installed by 0.2.31 through a path that recorded no install consent (an agent's update, a rollback) is also allowed by this one-time step, because nothing on disk tells it from an older install. A "Not now" answer given before 0.2.32 was never saved, so a plugin you declined that way is allowed too; one you revoked in Settings is not. From 0.2.32, the dialog's "Not now" button is renamed "Don't allow" (不允許, 許可しない), and that answer (or closing the dialog) is saved for that exact program and permission set: Navide no longer asks at each start, the backend stays off, and its row in Settings → Navide Plugins says so with an Allow button that runs it and clears the decline. A new version, changed program or permissions, or installing it again asks again. A plugin with a saved decline is never allowed by the one-time step. Two new strings in all 11 interface languages.

- Cloud sync (0.2.32): MCP sync now syncs only which servers are installed: name, transport, command, arguments, URL, on/off, and the names of environment variables and headers. Their values never leave the machine: each record goes up with every env and header value empty, and a record that arrives keeps this machine's own values for the same names. A server that arrives with a name this machine has no value for gets an empty field, and Settings → MCP marks it "Needs setup" and says to fill it in on this machine. Changing only a value no longer syncs and no longer asks for approval on other devices. These records travel separately from the ones older Navide versions sync, which still carry values, so a device that has not been updated is never sent a server with its values emptied. Navide 0.2.32 never changes or deletes those older records. It reads one as a server's definition until a 0.2.32 device has synced that server, and ignores it after that. After that, changes made on an older device no longer reach 0.2.32 devices, and changes made on 0.2.32 do not reach older devices. A server deleted on 0.2.32 stays on older devices. Values already uploaded by older versions stay in their records on the server; they are not deleted. Two new strings in all 11 interface languages.

- Cloud sync (0.2.32): a synced MCP server that changed what it runs no longer gets this machine's secret values. A device that receives a server fills in its own env and header values, and its own credentials in the URL and arguments, only when the record has the same transport and the same command and arguments, or the same URL, as its own server of that name. The arguments and URL are compared with credentials emptied. If the record changed any of them, every such value lands empty, even after you approve the change, and Settings → MCP marks the server "Needs setup", so approving a changed server never hands your token to a different program or address. Before this change, the values were filled in by server name alone. A record with the same endpoint (the usual case, including the first sync after updating) keeps every value as before, and so does a change to only env or header names or the on/off switch. Settings-bundle import already used this rule. No new strings.

- Cloud sync (0.2.32): MCP sync also keeps credentials inside a server's URL and arguments on this machine. Before a record goes up, each one Navide detects (by the same rules Settings → MCP masks with) is emptied where it stands: a `user:password@` part, a secret-named query value such as `?api_key=`, a token-shaped argument such as `ghp_…` or `sk-…`, the value after a flag such as `--token`, and the value of `--api-key=…` or `X-Api-Key: …`. A server where nothing is detected syncs exactly as before. A record that arrives gets this machine's own credential back for the same server name only when it runs the same command and arguments, or the same URL, as this machine's copy (compared with credentials emptied); anything else stays empty, and Settings → MCP marks the server "Needs setup" and says to fill it in on this machine. Sync never changes the local copy. A record an earlier build sent with the credential in it is read the same way, so this machine keeps its own value, and updating alone does not push or conflict. A 0.2.32 pre-release that already sent such a record sends it once more without the credential. Plain empty arguments and empty query values also show "Needs setup", because sync leaves those where a credential was. One new string in all 11 interface languages.

- Settings → Agent Assets → Skills (0.2.32): an agent's `skills_set_delivery` that delivers a skill to a CLI it does not reach yet, or turns a disabled shared skill on, now writes nothing until you approve it in the main window, as with an install (#660). The approval card shows who asked, the skill, the CLIs it reaches now and after the change, and whether it turns the skill on. The tool returns `status: "pending_approval"` and an `approval_id` that `skills_install_status` reports on; approving applies the change against the revision the agent saw, so a change made in between ends `failed` instead of being overwritten. Narrowing (fewer CLIs, `enabled=false`) applies at once as before, now with `status: "applied"`. New strings in all 11 interface languages.

- Settings (0.2.32): Agent Assets pages are named everywhere as in the Settings sidebar (#664): page headings, search, Sync scope labels, help, docs and the glossary (for example Prompts instead of Prompt Skills, Memory instead of CLI Instruction Files, and Credentials & Keys). Messages that sent you to Settings → Extensions for a Navide plugin now say Settings → Navide Plugins; Extensions is the CLI extensions page. The `cli_extensions_list` and `credentials_list` tool descriptions use the new page names; the tool names are unchanged. Values only, in all 11 interface languages; no key is renamed.

- Accounts (0.2.32): on a Claude pane with Follow account switch off, choosing an account in that pane's account menu now moves only this pane (#654). It reopens once in that account's own folder with its conversation resumed; the default account, the live sign-in and every other pane stay as they are. An account not yet signed in in its own folder starts that sign-in instead, and the built-in Default cannot be chosen this way. With Follow on nothing changes. The toggle's hint is reworded in all 11 interface languages.

- Navide plugins (0.2.32): a third-party Navide plugin's AI CLI session in terminal storage is now kept per package version (#678), so a later version of the same plugin no longer resumes a session an earlier version stored. Disabling, removing or revoking a version also clears its stored session, so nothing resumes it afterwards. Sessions stored by 0.2.31 or earlier are not carried over; those PTYs ended when that Navide quit, so a third-party view only loses its saved scrollback once. The Git, Plans and Mini-IDE plugins keep their storage across versions, as before.

### Removed

- Settings → Accounts (0.2.32): the portable-credential feature ("Paste Credential") is removed. Navide no longer stores a pasted CLI credential (such as one from `claude setup-token`) or hands it to new panes in `CLAUDE_CODE_OAUTH_TOKEN`, and the "From cloud" account cards for credentials older versions pulled from Cloud sync are gone. On a device that used the feature, the first start of 0.2.32 erases what it left behind, once: the wrapping key (the app secret `navide-portable-credential-key`: a Keychain item on macOS, a file under `~/.navide/cli-profiles/__secrets__/` on Linux and Windows), the encrypted credentials in `navide.db` (kv `portable_credentials`) and the imported rows of `sync_credential_items`; then the main window says so once. Nothing else in `navide.db` or the Keychain is touched, and a device that never used the feature makes no Keychain call for this. New Claude panes now use Claude's own sign-in, which may be a different account and draws on that account's quota; panes already open keep their credential until they are closed or restarted. Because a new pane now runs on that sign-in, switching the Claude account in Navide reaches it like any other pane. Credentials that older versions uploaded to Navide-Server are not deleted by this release. The `cli_profiles.portable_get`, `portable_set`, `portable_enable` and `portable_clear` messages and the `portable_credentials` and `portable_supported` fields of `cli_profiles.list` and `cli_profiles.changed` are removed. 41 strings are removed from all 11 interface languages and two are added.

### Fixed

- Git and issue commands (0.2.32): when a command Navide runs for the Git panel or the issue views times out, everything it started now ends with it. On macOS and Linux each command runs in its own process group, and the whole group is ended on timeout. A program it started a moment before the timeout used to be missed. It then kept running on its own, held the command's output open, and kept that Git slot busy for 2 more seconds. Commands that finish normally behave as before. Windows is unchanged. Tests and CI: three macOS timing tests no longer fail on a slow runner. A plugin backend cancellation test waits for the backend to report the call instead of sleeping 200 ms, and the 10 MiB loop-slice check also scales its limit with the run's own total.

- Git and issue commands on Windows (0.2.32): the same fix as on macOS and Linux. Each command now starts in a Windows job object, before it can start anything else, and on timeout the job is closed, which ends every program in it, including one started after Navide last looked at the command's process tree. Commands that finish normally behave as before: a program a command leaves running in the background (for example Git's file-system monitor) keeps running. If the job cannot be made, the command still runs and a timeout ends the processes it can see, as before.

- Cloud sync (0.2.32): a synced large skill waiting for approval could stay "waiting for space to download its files for review" for good, although its files had downloaded. A sync round that ran while its review was finishing counted the skill's own downloaded files against the review cache and marked it waiting, and every later round did the same. A round now leaves a review that is still running alone. The review cache limit is unchanged.

- Settings → Agent Assets → Extensions (0.2.32): Gemini CLI is now listed. The page shows the extensions in `~/.gemini/extensions` (name, version, MCP servers and context files they ship, and hooks), whether each is on according to Gemini CLI's `extension-enablement.json` ("State unknown" with the reason when that file cannot be read), and the hooks in `~/.gemini/settings.json`. Gemini CLI loads extensions only from that one folder, so there is no per-workspace list. Navide does not run Gemini CLI in a pane and no convenience feature writes Gemini CLI's files, so it has no "What Navide Changes" entries; the skills and memory files under `~/.gemini` that Antigravity shares stay listed under Antigravity. The `cli_extensions_list` MCP tool returns the same rows under `cli: "gemini"`. Hook events `BeforeTool` (any CLI) are now counted as able to intercept tool calls and `BeforeModel` as able to rewrite prompts. Read-only, like the rest of the page. No new strings.

- Settings → Agent Assets → Extensions (0.2.32): when a CLI's settings file that holds its plugins' on/off switches cannot be read or parsed (Claude's `settings.json`, Qwen's `extension-enablement.json`), its plugins and extensions are no longer shown as enabled. Each one shows "State unknown" and the reason instead; a Qwen enablement file that will not parse no longer hides every Qwen extension. The `cli_extensions_list` MCP tool now reports what it could not read instead of dropping it: a new `unreadable` list ({cli, id, name, kind, type_label, error}, no paths), an `unreadable` count per CLI, and an `enabled_error` field on each item. Existing fields are unchanged. Two new strings in all 11 interface languages.

- Settings → Agent Assets → Memory (0.2.32): an unsaved draft is no longer thrown away without asking. Cancel, ✕, opening another file and closing Settings (✕, Esc or a click outside) now ask before they discard it; a clean editor closes as before. Each save now keeps the version it replaced, one per file, in Navide's own data folder (`memory-backups`), never next to the CLI's file, and the editor shows when that version was kept with a Restore Previous Version button. Restoring writes it back with the same checks as a save, including the changed-on-disk conflict, and keeps the text it replaced as the new previous version, so a restore can be undone the same way. Nothing is kept when a save creates a file, or when the text did not change. Instruction files a settings bundle import writes are kept the same way. Five new strings in all 11 interface languages.

- Settings → Agent Assets → Memory (0.2.32): the page now lists Claude Code's auto-memory for the open workspace — the notes Claude writes about the project by itself as it works: `MEMORY.md`, the index it loads at the start of every session, and one `.md` per topic, in `~/.claude/projects/<project>/memory/`. They appear in a group of their own, "Claude auto-memory", that shows the folder, marks each file "Written by Claude" and says that Claude may rewrite them later. They open, save and restore through the same path as the instruction files: only files that are really in that folder, the changed-on-disk conflict, and the previous version kept in Navide's own folder. Navide never creates a file there. The folder is the one Claude Code itself uses: named after the git repository's main checkout (every worktree and subfolder of a repository shares it), and the same for every Claude account Navide manages, because each account's config folder shares `projects` with `~/.claude`. A folder moved with Claude's `autoMemoryDirectory` setting is not followed. Not synced; `memory_list` for agents lists these files too, read-only. Five new strings in all 11 interface languages.

- Settings → Agent Assets → Memory (0.2.32): a file the editor creates can be uncreated. When Save creates a file that did not exist, Navide records in its own folder that it created that file and the exact text it wrote, and the editor offers "Undo Create (Move to Trash)". If the file still holds exactly that text, it is moved to the system Trash, never deleted; if the Trash is unavailable, the file is left in place and the page says why. If the file changed since (a CLI wrote into it, say), the page shows the difference and moves it only when you click "Move to Trash Anyway". Only files with that record can be moved this way, so a file Navide did not create never offers it. Once a later save changes the file, the record is dropped and Restore Previous Version is the undo, as before. Nine new strings in all 11 interface languages.

- Settings → Agent Assets → Prompts (0.2.32): clearing a prompt's text no longer deletes the prompt, and through Cloud sync on your other machines (#656). The previous text is kept and the page says to use Delete to remove it. Delete now asks first, naming the prompt and saying synced machines remove it too. When a prompt's loop fails to start in a pane, an error notice says so instead of only the console. Three new strings in all 11 interface languages.

- Settings → Agent Assets → MCP (0.2.32): importing a settings bundle puts this machine's MCP secret back only for a server whose name and endpoint (command and arguments, or URL) both match (#659); a same-named server pointing elsewhere used to receive this machine's token. A secret with nothing to restore is left empty instead of dropped, and the import summary lists what to fill in on this machine. Export also masks names such as `*_PAT`, `*APIKEY*`, `*ACCESSKEY*`, `*SECRETKEY*`, `*PRIVATEKEY*` and `BEARER`. Settings → MCP and the `mcp_list` and `cli_extensions_list` tools now mask by value as well as by name: a `user:password@` in a URL, secret query values, and token-shaped values and arguments (`ghp_`, `github_pat_`, `glpat-`, `sk-`, `sk_live_`, `xox…-`, `AKIA…`, `AIza…`, `npm_`, JWTs, `Bearer …`). A server whose tools could not be listed now says why ("Could not list its tools: …") in Settings and in `mcp_list` instead of looking like it has none; MCP errors also show in the catalog and custom views, and adding, editing or removing a server shows a confirmation. Two new strings in all 11 interface languages.

- Skills (0.2.32): when wiring skills into a pane fails, the pane prints it at startup (`navide skills not wired: …`) instead of only logging it, and an `OPENCODE_CONFIG_CONTENT` that is not a JSON object is left unchanged and reported instead of replaced with `{}` (#660).

- Plans (0.2.32): plan documents in the Plans window are no longer squeezed into a narrow column beside a blank strip (#668). The AI CLI side panel's container kept a fixed 360px width (280px below 900px) even when the panel was collapsed to its 42px toggle; it now takes the panel's own width. The panel's width is stored under its own key instead of the Git window's, so the Plans panel starts once from the default agent instead of the one picked in Git. Applies to the built-in Plans plugin.

- Navide plugins (0.2.32): the native backend consent dialog fits on the screen (#652). It listed every agent tool with its whole description and input schema, so for a plugin with many tools it grew taller than the screen and its Allow button could not be reached. It now lists the first 8 tools with their method, read-only or changing claim and timeout, names the rest on one line with how many are declared as changing data, and points to Settings → Navide Plugins for every description and schema, in en-US, zh-TW and ja-JP.

- Navide plugins (0.2.32): Got It on the Developer Mode reminder now closes it in every workspace window until Navide quits (#653); switching workspace used to show it again. Nothing is saved, so the next launch reminds again.

- Navide plugins (0.2.32): the notice for a plugin window that opened without its native backend now words the reason in your language, with the same words as the backend's row in Settings, instead of an English internal reason (#679). It offers to allow the backend and reopen the window only when the backend is off or waiting for consent; for any other reason it names the Settings page that shows why. Two new strings in all 11 interface languages.

- Navide plugins (0.2.32): a failed install approval now gives a next step that fits (#681): an agent's file request asks you to have the agent send it again instead of choosing the file again, and a Marketplace, Testplace or folder install says to try again from the start. A failed rollback is shown in the dialog. A second failure in the same words is announced again to screen readers. A version that is already installed now says "This version number is already installed…". New strings in all 11 interface languages.

- Navide plugins (0.2.32): an update's permission diff now says, under a "Declared scope (informational)" item, that Navide does not enforce a declared scope and that a Navide plugin with file access can still read and change files outside it (#682). One new string in all 11 interface languages.

- Navide plugins (0.2.32): when turning third-party native backends off cannot be saved, the backends still stop at once, and Navide now retries the save after 250 ms, 1 s and 2 s, stopping if the switch is turned on meanwhile (#684). If every attempt fails, Settings → Navide Plugins → Developer and native code shows the real state of the switch (off) and a lasting notice under it saying that they are off for now, that this was not saved and that they will be on again after Navide restarts, with Try Again. The notice is held in memory only. The `plugins:nativeBackends` overviews carry an optional `offUnsaved` field while it holds. Two new strings in all 11 interface languages.

- Navide plugins (0.2.32): a Developer Mode folder's info card now says what asks for consent again (#684): changing the folder's files, its native backend program included, does not; changing its declared permissions or backend does, and the plugin is unloaded until you consent again. This is how it already worked; the plugin development guide and the user guides (en-US, zh-TW, ja-JP) say the same. One new string in all 11 interface languages.

- Navide plugins (0.2.32): when approving an install from a file fails while Navide still holds the prepared copy of that file (for example consent was missing or replacing was not confirmed), the approve button stays enabled and the dialog says the file is still ready, so you can approve it again without choosing it again (#686). When the copy is gone, or an older Host cannot say, the dialog asks for the file again as before. One new string in all 11 interface languages.

- Backend (0.2.32): an automatic restart after the backend crashes no longer writes an empty list of approved plugin backends; it passes the same list as a normal start (#666). Nothing reads that list for a decision today, so there is no visible change.

## [0.2.31] — 2026-10-26 — signed release

### Added

- Navide plugins can read agent data of their own workspace (#634). A new read-only `agents` namespace (medium risk) gives `agents.listPanes`, `agents.lineage`, `agents.listMessages` and `agents.listSessions`: the agent panes, which pane opened which, message delivery records with no message text, and the session list with no conversation content. Message text needs a second, separately disclosed namespace, `agentMessages` (high risk, second confirmation at install), with `agentMessages.read`. It must be declared together with `agents`. Session transcripts, account and quota data, other workspaces and other devices are not exposed. Third-party native backends reach the same data through the `agents` and `agent-message-bodies` Bridge ports. Execution Policy: the built-in default policy now includes `agents` and leaves out `agentMessages`, so an agent gets message text only from a policy that names `agentMessages`. A policy you saved yourself admits neither unless you write it in: an allowlist admits only what it names, and a denylist never admits them by omission, the same as `web`. A `full` policy still admits every namespace. None of the bundled plugins declares either namespace, so they behave as before.

### Changed

- Settings → Navide Plugins is split into four pages, listed in the sidebar under Navide Plugins: Navide plugins (the plugin list with details), Execution Policy, Developer and native code, and Disclosure overview (#636). Links that opened a section of the old single page, and the old Disclosure overview tab, open the page that section is now on. At 720px wide or less the sidebar rows are hidden and the page shows its own tab strip. Because the pages are no longer visible by scrolling, their state shows on the sidebar row and in the tab strip before you open them: Execution Policy shows ⚠ while that page shows a warning (no active policy, a high-risk policy in effect, a corrupt policy or source store, a high-risk or untrusted repository recommendation, a high-risk draft of your policy), and Developer and native code shows On while Developer Mode or any native-backend switch is on. Each marker's accessible name lists its reasons. Each plugin row shows its risk level and ⚠ N without a click, and ⚠ N now also counts a folder's trust warning (unknown, unverified or unsigned loader) and reload errors; a folder an agent loaded is marked in its row. The plugin card lists its risk reasons with the existing disclosure clauses. Execution Policy shows every section at all times, with no collapsed editor. Developer Mode and the three native-backend switches are rows of one card, with the native-code warning directly above the switch it governs. The Disclosure overview is one list of records with aligned columns from 640px wide. The Plans risk note and the native-code warning start with their first sentence in bold. Disclosure text is unchanged. Two new strings in all 11 interface languages.

- Navide plugins: installing a third-party Navide plugin now allows its native backend to run, and the switch for third-party native backends is on for new profiles (#642). The install dialogs (Marketplace install and update, Navide plugin packs, install from a file, and a developer folder) already disclosed the native backend; they now say that confirming allows it to run and that Navide will not ask again unless the program or its permissions change. Confirming records consent for that exact version, so its first start does not ask. Navide still asks before a backend runs when it changed since it was allowed (an update, a rollback or edited files), when its consent was taken away, when the package was installed before 0.2.31, and for a version no install dialog showed, such as an update or a rollback an agent started. The switch "Allow third-party Navide plugins to run native backends" is now on by default. If you never changed native-backend settings in 0.2.30 (for example the switch, or allowing or disabling a native backend), the switch is now on; a value you saved earlier is kept, so a switch you saved as off stays off. There is no notice about this. A native backend still runs only inside an operating-system sandbox with no network of its own (Seatbelt on macOS, bubblewrap on Linux); where Navide has no sandbox, including Windows and Linux without a usable `bwrap`, it does not run. A Navide plugin that also declares git, gh and glab commands (shown as high risk) can still reach network hosts through them, as before: Navide's command broker runs those commands for the backend outside the sandbox. You can turn native backends off in Settings → Navide Plugins → Developer and native code. The install dialog text, the native-backend description and the Help entry are updated in all 11 interface languages; no new strings. Known limitation: on a new profile, if the first save of the switch as off fails, the error is shown and the switch stays off for that run, but it is on again at the next start.

- Navide plugins: a third-party Navide plugin that declares the `aiCli` permission now receives the output and exit of the AI CLI sessions it started, as the documented `aiCli.output` (`{ sessionId, data }`) and `aiCli.exited` (`{ sessionId, exitCode }`) events (#648). Only the Git, Plans and Mini-IDE plugins received them before; other plugins could start sessions but got no output from them. A plugin sees only the sessions its own view started or resumed, never another plugin's, and input, resize, stop and reattach for a session it does not own are refused. When a third-party plugin's view closes, its AI CLI session is now ended after 60 seconds unless a new view of the same package version, with the same contribution and workspace, resumes it; it used to keep running until the plugin was disabled or removed. The exception is a session the plugin asked to keep (`persistView`) and that Navide actually stored in terminal storage: it keeps running after the window closes until a view resumes it, the plugin is disabled or removed, or Navide quits. Asking for `persistView` when the storage write fails does not keep a session. Updating a plugin ends the sessions of the version it replaces. Terminal storage is not keyed by package version, so if such a session is still running, a later version of the same plugin can resume it from there; another plugin never can. The install and update dialogs now describe `aiCli` as starting the AI CLI agents set up in Navide, sending them input and reading everything they print, and add that it can keep an AI CLI running in the background after its window closes, in all 11 interface languages.

- Navide plugins: the Git, Plans and Mini-IDE plugins now declare that they need Navide 0.2.30 or newer, instead of 0.1.0 or newer (#646). This applies to their Registry builds: an app older than 0.2.30 is not offered them as an update, and the Marketplace shows "Requires Navide ≥ 0.2.30" with Install disabled. Copies already installed keep running, and the copies built into Navide are not checked.

- Dependencies: anthropic 2.0.0, fastapi 0.156.4, pywinpty 3.1.0 (Windows), ruff 0.17.1, mermaid 12.2.0, @playwright/test 1.64.1 and electron-builder 26.18.0 (#633). Electron stays at 44.9.1.

- Tests and CI: a channels wake-cap test no longer fails on a run that crosses local midnight (#625), a Windows server-link rotation test waits for the rotation's file writes instead of a fixed 5 seconds (#635), and a Linux test checks that starting a shell command does not get slower as the backend's memory grows (#627, for #622).

### Fixed

- Linux: the backend no longer grows its memory by about 90 MB a minute once a pane is open, with event-loop stalls that grew to 11 seconds in the report and lagging pane input and scrolling (#624, #626, #629; reported by @emissionspectrum-creator in #622, thanks). The Git watcher reacted to inotify's read events, so every file an agent read in the workspace queued events the watcher could not keep up with, and reading the ignore files fed it more of them. It also refreshed the Git panel every couple of seconds with nothing changed. It now reacts only to created, deleted, modified and moved events, resolves each event's path once, and wakes the event loop once per burst of changes instead of once per event. macOS and Windows never reported reads, so they behave as before.

- Navide plugins: a plugin view placed in the `main` location no longer covers the whole stage, including the stage tab bar and the pane grid, and clicks on it no longer fall through to the terminals underneath (#638). Each such view is now a stage tab after the existing tabs, labelled with the view's title. Navide draws a ◇ mark on each such tab, and its tooltip gives the plugin's id, its publisher (or "Self-declared") and its source. Installing a plugin does not switch to it. Picking one of the other tabs, adding a tab with +, opening a pane from the sidebar or switching tabs through MCP brings the pane grid back, and so does the view going away. A view stays loaded while its tab is not shown. Views in the `top`, `right` and `bottom` locations are unchanged. This had been the case since 0.1.93; no bundled plugin uses `main`. One new string in all 11 interface languages.

- Navide plugins: a plugin window now opens even when its native backend is refused or fails to start, and the backend stays unconnected (#641). The window used to fail to open at all, while the same plugin's view in the stage still opened. The plugin's backend calls fail, so the parts of it that need the backend do not work. When you open such a window, a toast names the plugin and the reason and points to Settings → Navide Plugins → Developer and native code, once per window and reason in a session. The reasons include: third-party native backends are turned off, the backend has not been allowed or was declined (since #642, Navide asks only for a package installed before 0.2.31, a version no install dialog showed, a consent that was taken away, or a backend that changed since it was allowed), it changed since it was allowed, the sandbox is not available, the backend is turned off for this plugin, or it failed repeatedly and was stopped. Any other failure reads "the native backend could not start". The reason itself is shown in English. A window restored when its package restarts, and one opened again after a refusal, also open without the backend but show no toast. After you allow the backend in Settings, close the open window and open it again to connect it. This change leaves consent, the global switch's default and the sandbox as they were; #642 changes consent and the default (see Changed). One new string in all 11 interface languages.

- Navide plugins: installing a plugin from a file no longer fails with no visible message (#643). When approving the install fails, the consent dialog stays open and says why, instead of writing the error under the dialog. A file whose version number is already installed with different contents reads "This version number is already installed with different contents. Bump the version and package it again.", and is now refused as soon as the file is picked, before the dialog opens; this also applies to an agent's file install request once you approve it. Any other failure reads "The Navide plugin could not be installed."; the full error still goes to the pane's error line. When a failed attempt has used up the picked file, the dialog says to close it and choose the file again, and its install buttons are disabled, so a second click no longer fails silently. Three new strings in all 11 interface languages.

- Navide plugins: plugin buttons without an icon in the title bar and the sidebar can be told apart (#644). They all showed the same ◇; they now show the first character of the plugin's title, a Latin letter in upper case and an emoji or CJK character whole. ◇ remains only for a title with nothing visible in it. These buttons, and the sidebar Git button when the Git plugin provides it, now carry the same disclosure as the stage tabs in their tooltip and accessible name: the plugin's title, id, publisher (or "Self-declared") and source. Mini-IDE now has its own icon, a </> drawn in the theme colour.

- Navide plugins: an update that only adds a file scope declaration no longer shows the "More permissions" badge (#647). A file scope is declared and never enforced, and the `fs` capability reaches the same files with or without one, so declaring a scope where there was none no longer counts as wider access; updating Plans from its Registry 0.2.9 build now reads "Same permissions". Those items are still listed in the update's permission changes, marked "Declared scope (informational)". Dropping a scope while `fs` stays, a new read or write pattern, or a different root still counts as wider. One new string in all 11 interface languages.

- Navide plugins: when a Registry plugin cannot be checked because this computer's clock is off, the message now says the clock appears to be behind or ahead, and to correct it and try again (#631). That also applies when the refusal comes with a prefix such as `installed plugin quarantined:`, which used to be shown untranslated. An installed Registry plugin stopped at start or at a trust refresh because of the clock now shows a banner with the direction on the Navide plugins page of Settings → Navide Plugins; Navide checks again within 15 minutes and at start. The trust check itself is unchanged. New strings in all 11 interface languages.

- Git: generating a commit message with the Anthropic provider no longer fails every time with an error from the API; Navide no longer sends `temperature`, which current Claude models reject (#632). The Ollama request is unchanged.

- ACP (still not reachable in 0.2.31): ending an agent whose containment failed no longer ends a process by its pid after the agent has exited (#628).

## [0.2.30] — 2026-10-25 — signed release

### Added

- ACP (Agent Client Protocol) groundwork, not reachable in 0.2.30 (#592, which carries #584, #586 and #589): a client that talks to an agent over stdio, a session per pane, an ACP pane, and backend handling of its turns (activity, resource usage, a transcript log, the MCP tools and message delivery). No entry point creates an ACP pane, so nothing changes for users. Terminal panes, and the MCP tools for every pane that is not an ACP pane, behave as before.

### Changed

- Settings → Navide Plugins is reworked (#618). The page opens on a summary of the execution policy in effect, with its source and Mode, and Edit Policy opens the editor. A repository recommendation is shown in the summary as Untrusted, with its mode. While something needs attention the editor opens by itself and cannot be collapsed. That includes both high-risk warnings: a high-risk policy you are setting, and a valid high-risk repository recommendation. Bundled and installed plugins share one list, with the selected plugin's details beside it. An installed plugin's row shows Disabled together with its risk level (Medium and above). It also shows an icon when the plugin did not come from the Navide Marketplace (Testplace or pre-release, a local file, a developer folder). Any row with warnings shows ⚠ N, N being the number of warnings its details carry. Hover a marker, an icon or a cut-off name to read it in full; the warnings themselves are in the details once you select the plugin. In the Disclosure overview, each plugin's risk level, source and any "Found by the scan but not declared" flag stay in view, and the full Disclosure opens below them, unshortened. Two new strings in all 11 interface languages.

### Fixed

- Pipelines: a Manager-mode stage no longer stalls silently on a Manager that skips or misorders its markers (#539). A Manager reply that ends before the stage's router has started (it waits for every slot's kickoff) is held and routed once it starts, where its DISPATCH used to be dropped. A Manager whose reply to its kickoff ends without `---MANAGER-READY---` is reminded once to print it. If it then sits idle for 180 seconds while workers' messages are held for it, it is told that no `---MANAGER-READY---` was seen and that this is a timeout fallback, and the held messages follow. The run log records the fallback. A Manager that ends several turns of its own work without READY is not taken as ready. A DISPATCH that names no slot, or that could not be typed into its worker, is now reported to the Manager with the slots it can dispatch to, and a failed one is logged as `dispatch to <slot> not delivered`. Stages whose Manager prints its markers as instructed run as before.

- Pipelines: a slot whose role prompt never reached its agent no longer gets its kickoff anyway and runs on as `running` without its role (#448). A role that failed while its pane was pre-spawned is typed once more when the stage starts. If the role still does not land, or a role typed at spawn time does not, the slot takes no kickoff and the run fails the way a failed kickoff does: the node shows `role prompt never reached the agent`, an error toast says which stage and slot, and the panes stay open so the run can be resumed. Slots whose role lands run as before.

- Settings → Navide Plugins scrolls again (#613). Since 0.2.27 its scroll container had lost its scroll rule and was laid out as a row, so the page could not be scrolled and its three blocks (execution policy, plugin list, Disclosure overview) were squeezed into three columns.

- MCP: a local (stdio) server that exits, or whose connection fails, partway through starting is reported with the real reason in Settings → MCP (#614, #616, #617). It used to be reported as a cancelled start, or with the wrong exit code. The reason is now the server's exit code, or the connection error when the server is still running (for example output that is not UTF-8). A cancel from outside the start, such as shutting down, still goes through as a cancel, as before.

- Projects: a closed pane no longer comes back on the next workspace restore (#603). A write made at the same moment by a background thread could put back the pane's old record. Changing the layout mode, theme or language no longer overwrites another change saved at the same moment, such as a pane closing, a live-stamp clear or a rename (#612). Each project-store method that reads, changes and saves the project now holds its save lock from the read to the save.

- MCP: Navide's own MCP endpoint (`/plan-mcp`), which the CLI panes use for the Plan and `cli_*` tools, no longer answers every call with a bare HTTP 500 ("Task group is not initialized") after its session manager stops while a request is still finishing (#606). It now starts a fresh session manager on the next call.

### Security

- Dependencies: undici 6.29.1 and 7.30.1, which `node-gyp` and Electron's downloader use while building, for GHSA-xjj6-f33q-929c; happy-dom 21.0.4, the test DOM, for GHSA-834v-8h66-3h79; setuptools 84.1.0, which PyInstaller uses to bundle the backend, for GHSA-xmj3-9gf7-h52w. Build and test tooling only; nothing the app runs changes.

- Dependencies: Electron 44.9.1 (Node 24.22.0, Chromium 152.0.7977.167; was 44.7.0 with Node 24.21.0) for GHSA-jr5w-w6x2-84p9, which stops trusting the compromised eMudhra intermediate certificates.

## [0.2.29] — 2026-10-23 — signed release

### Added

- Interface language: Vietnamese (Tiếng Việt), marked Beta. It covers the whole interface, the help pages, and the Plans and Browser plugins. It leaves out pronouns where it can and uses verb-first buttons. Every string is stored precomposed (NFC) with old-style tone placement. Agent, AI, pane, workspace, Plan, CLI and Git terms stay in English. It was translated by AI panes and reviewed by a separate AI pane, not yet by a native speaker. With it, all eleven interface languages Navide recognizes have a catalog.

- Interface language: Russian (Русский), marked Beta. It covers the whole interface, the help pages, and the Plans and Browser plugins. It uses lowercase вы, « » quotes and Russian's three plural forms. Agent, AI, pane, skill, CLI and Git terms stay in English. It was translated by AI panes and reviewed by a separate AI pane, not yet by a native speaker.

- Interface language: Brazilian Portuguese (Português, Brasil), marked Beta. It covers the whole interface, the help pages, and the Plans and Browser plugins. It leaves out você wherever it can and uses sentence case. Agent, AI, pane, workspace, branch, CLI and Git terms stay in English. It was translated by AI panes and reviewed by a separate AI pane, not yet by a native speaker.

- Interface language: French (Français), marked Beta. It covers the whole interface, the help pages, and the Plans and Browser plugins. It uses vous, « » quotes and the no-break spaces French typography requires, and says IA for AI. Agent, pane, CLI and Git terms stay in English. It was translated by AI panes and reviewed by a separate AI pane, not yet by a native speaker.

- Interface language: Spanish (Español, España), marked Beta. It covers the whole interface, the help pages, and the Plans and Browser plugins. It uses tú and impersonal error messages. Agent, AI, pane, CLI and Git terms stay in English. It was translated by AI panes and reviewed by a separate AI pane, not yet by a native speaker.

- Interface language: German (Deutsch), marked Beta. It covers the whole interface, the help pages, and the Plans and Browser plugins. It uses the formal Sie. Agent, AI, pane, CLI and Git terms stay in English. It was translated by AI panes and reviewed by a separate AI pane, not yet by a native speaker. Pick it in Settings → Appearance, or at the first start.

- Release: every release now publishes its What's New announcements as `whats-new.json` on the download mirror (`dl.navide.dev/releases/<tag>/whats-new.json` and `releases/latest/whats-new.json`), exported from the same entries the app shows, for the website's announcements page. The format is in `docs/en-US/release-announcements.md`.

### Changed

- MCP: `cli_get_status`, `cli_wait_idle` and `cli_send_and_wait` no longer give a Claude turn end that came from the Stop hook another turn's text. `cli_wait_idle` and `cli_send_and_wait` then wait up to 10 seconds more (`HOOK_TURN_TEXT_WAIT_S`, within `timeout_s`) for the conversation log's turn end and return its text. If it is still not read, they return with `text_pending: true` and no `last_activity.text`; before, such a turn end could carry the previous turn's text. Other CLIs, and turn ends the log reported itself, return at once as before. The backend log notes how far apart the hook and the log reported a turn's end (time and pane only).

- Diagnostics: console warnings and errors from Navide's own pages now go to `renderer-console.log` in the logs folder, on this machine only. It rotates like `main.log` but separately (4 MB plus one 4 MB older file), so it cannot push `main.log` out. Messages are recorded whole, one line each, except that a single entry over 4 MB is truncated, as in `main.log`. A message repeated back to back is written once and then counted. Only the main frame of a `file:` page, a plugin frame or the dev server is recorded, so the warnings and errors of a third-party plugin's frame are recorded in full too. Never recorded: subframes (plan HTML, file previews), the hidden window that prints a chat attachment to PDF, web pages, `about:blank`, `data:`, `blob:`, error pages, and console info, log or debug lines. `main.log` now also records any renderer that goes away in a window that did not log it already, and a GPU or other child process that dies.

- English UI: Title Case for the buttons, filter chips, preset buttons and undo labels #565 missed: Skip Tour, the What's New buttons (Got It, Take the Tour, Replay the Tour, Not Now), the layout preset Bottom Panel, the CLI Agents filter Needs Attention, the Marketplace category Version Control, Restart for New Version in the status bar, and the pipeline editor's Undo/Redo labels (Undo Edit Prompt, …).

### Fixed

- MCP: a local (stdio) server no longer fails after a fixed 15 seconds while `npx`/`uvx` downloads its package the first time (context7 on a cold start). Navide waits while the server's process is running, up to a 300-second safety cap, and fails at once, with the exit code, if the process exits. Settings → MCP shows the server as starting, notes after 15 seconds that a first run may be downloading, says why a start failed, and shows the last lines the server printed (kept in `logs/mcp-<name>.log`, latest start only). Servers now start in parallel, so one slow server does not hold up the others. Remote (`http`/`sse`) servers keep the 15-second handshake.

- Channels: a busy computer no longer makes a chat see "（pane 回合結束，沒有文字輸出）", or the previous turn's reply, for a Claude turn whose text Navide had not read yet. Claude's Stop hook reports a turn end before the conversation log is read; the chat now waits for the log's text. After 10 seconds the status reads "✅ 回合已結束，正在讀取回覆…". After 120 seconds the chat is told the reply will follow, and it does, prefixed "（補送）", under the message that asked, for up to 30 minutes. Text that arrives after the next message went in still answers the message it belongs to. A turn that really wrote no text is reported once the log moves on to the next prompt, or when the 120-second grace runs out with nothing more from it. CLIs without a Stop hook are answered as before.

- Windows: the Git view no longer stays on "capability call 'git.status' timed out". Every git the backend started inherited the backend's own stdin, the pipe the app keeps open on Windows for its `shutdown` line, and hung at launch. Git now starts with an empty stdin; a git run that does time out ends its whole process tree and gives its slot back within two seconds, so one hung run can no longer block every later one.

- Extensions: a computer clock up to 5 minutes behind the Registry's no longer refuses every Registry install and update. The Registry signs its trust data per request, so the slightest lag read as invalid. A larger gap is reported as trust data that is not valid yet, and trust data past its expiry as expired, instead of both as "expired". The same 5 minutes apply to a version published or approved just before you install it. Both messages ask you to check the computer's date and time. Signature checks are unchanged.

- MCP: `cli_reclaim_agent` and `cli_close_agent` no longer refuse every pane as your own. Since 0.2.28 the window was told the target pane was the one asking, so every reclaim came back `reason: "self"` and every close `self-close`, whoever called them. The request still goes to the window holding the target, and now names the real caller. Self-evolution had the same fault: after an automatic run its pane was never reclaimed and old cards were never closed.

- Windows: the first launch after a fresh install waits up to 120 seconds for the backend (was 45), as on Linux. Unpacking the backend while Microsoft Defender scans the new files can take longer than 45 seconds, which ended a backend that was still starting with "backend failed to start". The startup screen now also stays up for the whole wait instead of closing after 52 seconds. A timeout set in Settings is unchanged.

- Backend: with many CLI panes open, the resource panel's risk check no longer freezes the backend for seconds at a time. It walked every recorded connection and disk signal once per pane, on the event loop, and that history only grows. It now walks it once, in a worker thread. Results are unchanged.

- Backend: a change in one workspace no longer throws away the cached Git branch and status of every other workspace's panes. While agents kept editing, every refresh re-ran Git for all of them. Looking up the last fetch time also no longer holds up the backend while it lists a repository's worktrees.

- Codex panes: a sub-agent finishing no longer ends its parent pane's turn. Its reply is not taken as the pane's, and its task is not used to name the pane. Before, a waiting `cli_wait_idle` or `cli_send_and_wait` returned while the parent was still working. A sub-agent's tokens still count toward the pane, now under the sub-agent's own session instead of its parent's. The per-account turn count is unchanged and still includes sub-agent turns.

- A disabled built-in Navide plugin's tooltip and dialog now send you to Settings → Navide Plugins, where it can be enabled; they pointed to Settings → Extensions, the page for CLI extensions.

- Settings: a long sidebar label wraps onto a second line instead of being cut off (Spanish "Complementos de Navide", Japanese "Navide マーケットプレイス").

- Backend: fewer Git processes while agents work. The network view's pane branches are answered from the last reading and refreshed in the background, no more than once per 30 seconds per repository. The Git pane's history, branch, stash, remote, tag and worktree reads are shared when several Git panes reload together after one change. Each status read now runs two Git commands instead of three.

- Windows: programs the backend starts without input of their own (onboarding's version checks such as `pnpm --version`, CLI and tool probes) no longer hang at launch. They inherited the pipe the app keeps open for the backend's `shutdown` line; their standard input is now NUL, and the `shutdown` line still stops the backend. macOS and Linux are unchanged.

- Open workspaces (Welcome badges, `ui_snapshot` `openWorkspaces`) list each folder once. A folder that is both a window's own workspace and one it adopted was listed twice. Paths are compared resolved, without a trailing slash, and case-insensitively on Windows; `~` is not expanded. (#448)

- CLI panes: the startup probe's "newer than the last version Navide verified" line now covers Goose (verified on 1.55.0; it has no account switching, so it never had a version to compare against), and Kimi Code compares against 2.2.0, the version its launch and logs were checked on, rather than the 0.39.0 of its account-switch evidence, so Kimi 2.x is no longer called untested. Disclosure only, as before. (#502 follow-up)

### Security

- Dependencies: DOMPurify 3.4.17, which Mermaid diagrams and the Monaco editor use to sanitize HTML, for published advisories GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr and GHSA-c6gr-qvv4-5v3f.

## [0.2.28] — 2026-10-21 — signed release

### Added

- MCP: `window_list` lists every Navide window on this computer with the projects it holds, the one on screen and its panes; `window_focus` brings one to the front, optionally switching it to a project it already holds. The focused window shows which pane did it, and every window action is recorded with the calling pane in `agent-window-actions.jsonl` in Navide's logs folder. `cli_list_targets` and `cli_whoami` now name each pane's window (`window_id`). (#535)
- MCP: `window_close` closes another Navide window and `workspace_close` takes a project out of the window holding it. Only a CLI pane can call them, never on its own window or project. Neither ends a CLI unless you agree: closed projects keep their CLIs running and come back attached when you open them again (the window the agent runs in shows what it closed, with Undo). `workspace_close` with `keep_panes: false` ends the project's CLIs only after you agree in a dialog that names the agent's pane, every time. While a project is closed, its panes cannot be messaged and their reports are not read. (#541)
- MCP: `window_move_pane` moves a pane into a window of its own (or from one back to its project's window), or moves its whole project with every pane to another window. A single pane never moves into another project's window. No CLI ends; both windows say which pane did it, and the answer carries an undo. `cli_open_agent` gains `window: "existing"`, which opens the child in the window already holding the project or, with `window_id`, in a window you name. (#548)
- Testplace: a withdrawn test build now reaches testers who are offline or signed out of Navide Cloud. The Registry lists the withdrawn build's SHA-256 (only the digest) as `testplace-withdrawn` in the root-signed local-install document, and the App checks each installed Registry build against it at start and at every trust refresh: Extensions labels it "Test build withdrawn" and you are asked once whether to keep using, disable or remove it. Nothing is disabled for you. The 15-minute check for testers signed in to Navide Cloud stays as the faster way to learn of it. (#551)
- MCP: `cli_open_agent` with `workspace_path` now opens the child in that other project when a CLI pane calls it, still parented on the caller and reporting back to it. `window: "current"` takes the project into the caller's window, `"new"` (the default) opens it in its own window, in the background. The child's row says which pane opened it, and every cross-project spawn is recorded in `agent-window-actions.jsonl`. (#546)
- Registry (self-hosted): an admin can unfreeze a frozen namespace from **Frozen namespaces** (`/admin/namespaces`) or `POST /api/admin/namespaces/{namespace}/unfreeze`, with a reason. It goes back only to the account that owned it, once that account is an approved developer again and has room under the per-account namespace limit. Old publish tokens and keys stay revoked. Versions stay yanked unless the admin ticks **Restore versions**, which undoes only what that freeze did. (#550)
- CLI panes: when a CLI's `--version` is newer than the version Navide last verified it at, the pane's `[startup probe]` lines add one saying so ("it should work, but this version has not been tested"). It only discloses: the pane starts as before. (#502)
- Navide plugins: Settings → Navide Plugins says who had each developer folder loaded (you, or an agent's request you approved in the main window) and when and how it last loaded. The loader is signed with the Developer Mode key; one that does not verify (written outside Navide, or recorded before signing) reads as unknown. The Developer Mode settings file keeps its 0.2.27 format (#536, #552).
- Navide plugins: a Navide plugin loaded from a folder is labelled "Local folder". Its badge, in the plugin list and in the view's title strip, opens an info card with the folder path, the time and trigger of the last load, who loaded it, and a content fingerprint taken after each load. The fingerprint is only disclosed: Navide never compares it or refuses a load over it (#538).
- Navide plugins: a loaded developer folder reloads by itself when its files change (on by default for each folder). A change to its declared permissions or backend is never applied automatically: the folder is unloaded and waits for your consent in the main window (#543).
- Navide plugins: the source badge of a Navide plugin installed from a .vsix file opens its SHA-256 and install time, and an unsigned file's note is on a line of its own (#527).
- CLI panes: Goose (AAIF) is the 16th supported CLI, at support tier L4: install detection, launch, session binding, turn end, reply text and tokens, and resume (#524).
- Channels: a pane's multi-select and free-text questions can be answered from the bound chat (`1,3` picks boxes, `<n> <text>` fills the free-text row); a question box's final review step is relayed too. Single-select questions keep their buttons (#540).
- Channels: on Telegram a multi-select question carries one button per box; a tap ticks (✓) or unticks it in place, and 送出 sends the ticked boxes through the same checks as a typed `1,3` (which still works). Permanent-allow and free-text rows get no button, a press counts only from the bound chat user in the prompt's own chat, and the ticks end with the request.
- UI languages: Korean (ko-KR) and Simplified Chinese (zh-CN) are available as Beta UI languages. The language pickers show them with a Beta label, and a string not yet translated falls back to English (#553, #554, #558, #559).

### Changed

- Plugins: `window_` is now a reserved agent tool prefix, like `ui_` and `workspace_`, for Navide's own window tools. A Navide plugin whose id ends in `.window` can no longer provide agent tools; no published plugin is affected. (#535)
- Testplace: intended behaviour change from 0.2.27. A Testplace build that its developer or Navide withdraws is no longer disabled automatically, also for testers signed in to Navide Cloud. Their 15-minute check still learns of it first, and now labels it "Test build withdrawn" and asks once (one notice per build, however Navide learned of it) whether to keep using, disable or remove it. An expired build that was withdrawn still cannot be kept. Security takedowns and the other block reasons are unchanged. (#551)
- Registry (self-hosted): intended behaviour change. A local Registry (the `self-hosted-dev` profile) now refuses a native backend package the Navide Marketplace refuses, with the same rules, also for a publisher created with the admin token: `backend.methods` must be declared, `shell: "full"` is refused, and `engines.navide` must require a Navide that runs third-party backends (and, for shell access, has the shell broker). What a local Registry cannot check, the admin allowlist and a verified publisher domain, is listed in the new `notices` of the publish response. The official profile is unchanged. (#510)
- Plugin SDK: `navide-plugin dev-backend` keeps its data beside the package directory (`dist/.navide-dev/package/data` for `dist/package`) instead of inside it, and `validate` refuses a `.navide-dev` entry; a clean backend exit prints `• backend exited` instead of a red cross. Manifest refusals name the refused value and what would pass, and a file listed in `artifact-files.json` but missing says so. (#520)
- Navide plugins: what you approve takes effect at once, without **Restart** or relaunching Navide: a first install is active as soon as you approve it, and an approved update (or an agent's automatic update that discloses exactly what the running version does) switches right away. The dialog says so before you approve: the plugin's open views reload and lose anything not saved in them. Each switch is recorded in the announcements with **Back to** the previous version. A file update keeps the file version it replaced, and going back to it asks for your consent again. If a switch fails, the previous version keeps running and the update stays staged (#511, #516, #517, #518).
- UI language: intended behaviour change. When your system language is not one Navide supports, the interface now uses English (it used to be Traditional Chinese). A language you picked in Settings is not affected. A Simplified Chinese system locale (zh-Hans, zh-CN, zh-SG, bare zh) now detects to Simplified Chinese instead of Traditional Chinese (#519, #554).
- UI text: zh-TW and ja-JP terms follow the glossary (for example 打開 → 開啟, 保存 → 儲存, フォルダ → フォルダー, デフォルト → 既定), and en-US text uses real singular and plural forms instead of "(s)" (#555, #556).

### Fixed

- Pipelines: `{{prev.summary}}` is the upstream slot's own last reply instead of a scrape of its terminal, which carried spinners, status and "Tip:" lines, and blocks repeated by redraws. A CLI that reports no reply text still hands over the end of its screen (#448, #544).
- Navide plugins: an in-window plugin panel no longer reloads whenever any plugin's contributions refresh (an install, a switch, a rollback). It reloads only when its own workspace, contribution or package version changes, so open panels keep what is not saved in them. A plugin switch with one of its panels open in the main window no longer fails and rolls back; the panel comes back on the new version in place. (#512)
- Pipelines: a slot's pane keeps its slot label as its name and messaging address. It was auto-titled from its first reply or role prompt, so panes sharing a role collided into `…-2` names, and a kickoff that says "message 畫師" pointed at a name that no longer existed (#448, #542).
- Pipelines (Manager mode): a Manager's `DISPATCH` reaches its worker even when the block does not parse from the Manager's screen. The router now also reads the Manager's reply text, and routes each block once. A `DISPATCH` sent before `---MANAGER-READY---` counts as READY, so the workers' held REPORTs go to the Manager instead of the whole stage waiting while it shows `running` (#539, #545).
- Pipelines (Manager mode): with a single commander, its workers' REPORTs no longer reach it before `---MANAGER-READY---`, and each `DISPATCH` reaches its worker once instead of twice. That commander is also the global Manager, and the global router routed its stage alongside the stage's own router (#539, #547).
- Claude Code panes: Claude Code 2.1.304 can stop a resumed conversation on a dialog before it reads anything ("Resume this conversation?", which says how much of your 5-hour usage limit resuming will use, or "Resume from summary / Resume full session as-is / Don't ask me again"). It can appear when Navide restores a pane at start-up or after an account switch. The pane now shows as waiting for you, messages wait instead of being typed into the dialog, and nothing is chosen for you. A chat or agent answer can no longer pick "Don't ask me again" (it is a permanent choice, like "don't ask again"). (#507)
- CLI panes: a turn whose answer ends inside a numbered list (for example a list of open items whose last item ends on "?") no longer reads as waiting for an answer. The pane shows idle, so `cli_reclaim_agent` and the other idle checks accept it. A question asked after the list, and every permission, AskUserQuestion and option menu, still reads as waiting. (#521)
- Agent panes (#402): a task given with `cli_open_agent` that the CLI shows as a collapsed paste Navide does not recognise (Grok Build draws a multi-line paste as a chip) is no longer typed a second time once the CLI has started working on it. When the CLI starts a new turn right after Navide presses Enter, the kickoff is reported as sent; before, it was typed again (running the task twice) and then reported as failed, which told the caller to send it a third time. (#508)
- Navide plugins: turning Developer Mode off also drops a developer folder that was chosen but not yet consented to; turning it on again means choosing the folder again (#532).
- Navide plugins: a first install that was staged but never activated with Restart now activates at the next launch, and a candidate that still needs you shows a notice in the main window (#505).
- Navide plugins: the disclosure card of a Navide plugin installed from a file no longer says it was not scanned next to Navide's own scan of it (#528).
- Plans: a plan whose file starts with a UTF-8 BOM no longer drops Plans v2 to legacy recovery (#525).
- Plans: the plan-frame guard no longer applies to websites shown in a Navide plugin web view (#529).
- Plans: in-page `#` links in a plan open in the Plan view, so a plan's click-to-enlarge image (a CSS `:target` lightbox) opens and closes there too; the same goes for the plan preview in the editor (#562, #563).
- Navide Browser: page text holding U+FEFF no longer breaks the plugin backend's frame (#533).
- Kimi Code panes: Kimi Code 0.39+ and 2.x sessions get their workspace again, so tokens and turn ends are attributed to it; a turn ends as soon as Kimi Code says so; the archived kimi-cli is named as archived (#531).
- OpenCode panes: a problem from a read that runs only on some passes no longer stays reported on a healthy database, and a half-migrated v2 database is disclosed (#526).
- Qwen Code panes: Qwen Code 0.25's multi-agent records in a session are no longer read as your prompts or as turn boundaries (#504).
- Pipelines: a slot's hand-off waits while its background subagent or shell is still running (#506).
- UI text: English that was hard-coded in the editor and Mini-IDE, the Git surfaces and the remaining components is now translated in zh-TW and ja-JP, and two Plans strings that showed their raw key are added (#509, #513, #514, #515).
- MCP servers (Windows): quitting Navide no longer leaves an MCP server's node.exe running after its cmd.exe wrapper has exited, as seen with context7 (`npx`). Stopping a stdio MCP server now also ends any of its processes still alive after the library's own teardown. This includes a program the server opened for you, such as a browser it launched.

### Security

- Extensions: Developer Mode settings changed by a program other than Navide are no longer taken as your consent. Navide signs every entry it writes (the key is kept with the operating system's secure storage); an entry it did not write leaves the switch off and the folder unloaded until you turn Developer Mode on again or consent to that folder again, and the launch reminder, the Navide Plugins page and the activity log say so. **Upgrading from 0.2.27 with Developer Mode in use:** the switch reads as off once and every local folder asks for your consent again, because the settings carry no signature yet. (#537)
- MCP: an agent can never close its own pane, its own workspace or its own window; the backend refuses it and the window refuses it again (#534).
- Navide Cloud: credentials and keys never leave this machine. The Credentials & keys row is gone from Sync, the sync engine refuses that scope, a credentials switch an older build left on reads as off, and share codes drop secrets (#530).
- Dependencies: certifi 2026.10.19 and vite 6.4.4 for published advisories (#549).

## [0.2.27] — 2026-10-20 — signed release

### Added

- Plugin SDK: `navide-plugin status` lists your namespace's versions with their review state (pending, approved, rejected with the reviewer's reason, yanked) and, once approved, the risk level and what the scan found that the manifest does not declare. `navide-plugin scan` runs the Registry's static scan locally on a .vsix or a staging directory, with the same rules and the same declared-versus-found comparison. `publish --via-navide` hands the .vsix to Navide's publish form, where you sign in and submit; the CLI reads and writes no token. `whoami` now answers for `NAVIDE_PLUGIN_TOKEN` too, in the order `publish` reads tokens. `validate` checks agent tools with the Registry's rules and names the expected tool prefix, the allowed values, and a file left out of `artifact-files.json`. `login`, `publish` and the other commands behave as before.
- Navide Browser: a Navide plugin, installed from the Navide Marketplace (it does not ship with the App; it needs Navide 0.2.27 or later), that opens real web pages inside Navide. Each agent pane works in its own background Space, so your own Spaces are never taken over; a Spaces overview shows every Space with a thumbnail and its state (Running, Need your action, Done), and your own Spaces are pinned. Agents get `browser_*` tools (open, snapshot with `@ref`s, click/fill/press/select/hover/scroll/goto/back, screenshot, hand off, wait for control, finish); when an agent hands a Space to you, or you take over, its commands are refused until you hand it back. All Spaces share one set of sign-ins kept on this computer, and Settings can clear them.
- MCP: agents can help install Navide plugins from a file. `marketplace_open`, `plugins_install_file_open` and `plugins_developer_mode_open` only show the page so you can do it yourself; `plugins_validate_package` checks a `.vsix` or folder without installing it; `plugins_package` builds the same `.vsix` as `navide-plugin package` beside the folder (never over an existing file); `plugins_install_file_fill` has Navide read the file once and hold that copy, then asks you in a Navide window, showing who asked, the path, the SHA-256 and that Navide has not reviewed it. Approving opens the same "Install from file" dialog and installs exactly that copy; the agent cannot approve it, and Developer Mode stays your switch. `plugins_list_installed` now names each plugin's source.
- MCP: `marketplace_request_update` updates an installed Navide plugin at once when the new version discloses exactly the same permissions, backend, agent tools and network access as the installed one; the user is told which agent updated it from which version, with a one-click downgrade in the announcements centre, and the update is recorded in `plugin_agent_actions`. Any change, or anything Navide cannot compare, files the request for the user's approval as before.
- Extensions: a `.vsix` signed by a developer who passed Navide's developer vetting reads as signed by that developer (this version still not reviewed by Navide) in the install dialog and in Extensions; once Navide revokes the key or the qualification it reads "Signature no longer valid". A file Navide has taken down by digest is refused with that reason.
- Extensions: a Navide plugin installed from a `.vsix` file that Navide takes down after the install is checked at every start and trust refresh. Taken down for a security reason, it is disabled and you are told why; it can be removed but not enabled again. Taken down by Navide, because its developer's qualification was revoked, or with no reason given, you are asked once whether to keep using, disable or remove it. Withdrawn by its developer, it is only labelled. Extensions keeps labelling each one. Files installed before this release can be checked only when they were signed.
- MCP: a `cli_account_switch` tool lets an agent ask to switch one CLI to another of its accounts. Nothing switches until the user agrees in a dialog in the main window that starts on Cancel and shows the vendor, the account it switches from and to, the calling pane and the agent's reason, labelled as the agent's with invisible characters shown; a no or no answer in time switches nothing. On a yes it is the same switch Settings → Accounts makes, never forced, so running panes are restarted only after the user agrees again. The agent gets back the result and the accounts' display names only (an account Navide added on its own is named after its email, so a name can be one) — never a credential or backend message. Only CLI panes can call it; `ui_invoke` cannot reach it.
- Registry (self-hosted) and Plugin SDK: Testplace opens. A namespace whose developer qualification is approved can publish with `navide-plugin publish --channel testplace`: the build gets the automatic checks only, is signed with an expiry 90 days out, and is listed and downloadable only for Navide Cloud accounts invited to it (`/api/testplace/*`, an account token). `navide-plugin testplace` manages single-use invites (no limit on how many testers), public test codes (the first one waits for a light review on `/admin/testplace`), early revocation (through the signed takedown list) and promotion of the same package to Marketplace review. Registry migration 12. A test build is valid for 90 days after it is published. Withdrawing one early (`navide-plugin testplace revoke`, or a yank) reaches testers who are online and signed in to Navide Cloud within 15 minutes; a tester who is offline or not signed in keeps it until it expires.
- Navide Marketplace: a **Testplace (invited)** view lists the tests you joined. Join with an invite (`tpi_…`) or a public test code (`tpc_…`) after signing in with your Navide Cloud account; a test build installs through the usual trust dialog, which always opens for it, and its "Source and review" row says what review it had: an invite build had the automated scan only; for a public test code, the code had a light human review and the version had none. Each test shows its expiry and, from 7 days before, a reminder; leaving a test keeps the installed build. When the developer's test build is promoted to the Navide Marketplace unchanged (same digest), it becomes the Marketplace version where it is installed, with no reinstall: the same files, permissions and data, now labelled reviewed. An expired test build is stopped with its settings and data kept and listed in Extensions with three choices: install the Navide Marketplace version, keep using it (marked expired; not offered when it was taken down), or remove it. A developer can invite testers from the Developer view; `marketplace_testplace_invite_open` and `_fill` open the same form, and only the user's Send invites anyone. The invite codes are shown once, in that form only.
- Accounts: the quota figures on Settings → Accounts cards now say what they mean: each reads as what is left (`72% Session (5h) left`), the bar's tooltip adds the used share, a current reading shows when it was updated, and Claude's window labels are translated. A signed-in Claude account that is not the default and has no login in its own folder gets a **Sign in to its own folder** button (the same sign-in as the pane badge's); once signed in there, its card reads that account's quota live and has its own Refresh. If the folder signs in as a different email than the card showed, the card warns you; nothing is blocked. "Reading this account's quota" now says it can take up to 3 minutes. (#409)
- Navide Marketplace: a **Developer** view (Settings → Navide Marketplace → Developer, beside Browse). Sign in as a developer in the browser; Navide keeps the tokens and a signing key encrypted with the operating system's keychain (on Linux it refuses to keep them as plain text) and never hands them to an agent. From there you file the developer qualification application, publish a `.vsix` (the form reads the file once and shows its id, version, SHA-256, disclosure and the permission changes from your last listed version; Submit signs exactly those bytes), and see your versions with their review state and a **Yank** button for each. `navide-plugin publish --via-navide` opens the same publish form through a `navide://publish` link. (#465)
- MCP: agents can help with the developer steps, but only you submit them. `marketplace_developer_application_open` / `_fill`, `marketplace_publish_open` / `_fill` and `marketplace_publish_yank_open` / `_fill` open the form, or fill a draft whose agent-written fields are marked "Written by an agent"; nothing is sent to Navide Cloud until you press Submit. When the asking pane has external influence, the form says so and still leaves the decision to you; the same note appears on an agent's Navide plugin request card and on the Testplace invite form. `marketplace_developer_status` and `marketplace_publish_status` report your application and your versions without handing out a token. Only when the configured Registry is on this computer (`localhost`, `[::1]` or 127.0.0.0/8) does `marketplace_publish_fill` publish at once, recorded as `publish-loopback`. (#465)
- Registry (self-hosted): developer qualification. Claiming a namespace, issuing publish tokens, changing keys and publishing need a qualification an admin approved. Developers apply on `/developer/apply` or from Navide's Developer view; admins review on `/admin/developers` (approve, reject, revoke). Revoking a qualification revokes the developer's tokens, freezes their namespaces, yanks every version and revokes their keys in one step. An account token (`nva_`) names the Navide Cloud account and cannot publish. `GET /api/trust/local-install` is a separately signed document of blocked digests and developer keys, which Navide reads for plugins installed from a file. Every decision is recorded (`GET /api/admin/audit`). Registry migration 11. (#461)
- Registry (self-hosted): a namespace self-claimed before developer qualification is grandfathered for 30 days: its owner keeps publishing while applying; the period pauses while an application is pending, resumes (extended by that time) after a rejection and ends with an approval, and the last 7 days show a reminder. After that, publishing is refused and the namespace is reclaimed with the same steps as a revocation. Every blocked digest carries a reason (`security`, `admin`, `qualification-revoked` or `developer-withdrawn`), which Navide uses to decide what to do with a plugin installed from that file; a `security` block is never downgraded. Registry migration 13. (#471)
- Registry (self-hosted): a namespace frozen by a revoked developer qualification, or reclaimed after its grace period, no longer counts toward the per-account namespace limit. Its name is not released: it stays with the original account and no other account can claim it. Unfreezing a namespace comes in a later version. (#492)

### Security

- Plans: only HTML whitespace may now come before a plan document's doctype when Navide places its Content Security Policy, in the Plans window and in the plan preview. A character JavaScript counts as whitespace but HTML does not (U+00A0, U+000B, U+2028, U+2029, U+1680, U+3000) used to push the policy out of `<head>`, where Chromium ignores it, so the plan's inline event handlers ran. A `<meta http-equiv="refresh">` is now stripped and a plan frame can no longer navigate away from its own document, so clicking an external link inside a plan no longer replaces the plan in its frame. A `<script>` is kept as JSON data only when it has a real `type="application/json"` attribute. (#462)

### Known issue in 0.2.26

- Plans CSP bypass (severity MED): in 0.2.26, a plan document with one of the characters above before its doctype ran its inline event handlers without the Content Security Policy, in the Plans window and in the plan preview. Fixed in this release (#462, see Security). On 0.2.26, open only plan documents you trust.

### Changed

- Channels: creating a new bot through a managing Telegram bot now starts with a heading naming that manager ("Create a new bot through @…"), shows the disclosure as a warning box instead of a muted hint, adds what it costs (if the manager's token leaks, every bot it created leaks with it), and labels the confirm button "Continue in Telegram" so it no longer repeats the menu item.
- Navide Guard: the "External influence" badge on a pane header now says since when (on the badge itself) and, in its tooltip, who sent the messages (the chat account, pane or device), that typing on this computer never adds the mark, and that High and Critical actions need your confirmation here (or that Guard is off). A message from a chat channel is shown as Chat app instead of Remote, in the tooltip and in the delivery log. Display only: what marks a pane and what needs confirmation are unchanged.
- MCP: `cli_accounts_list` no longer says its answer holds no email. An account's name is the name the user gave it, and an account Navide added on its own is named after the email it was signed in with, so a name can be an email; the tool and its documentation now say so. The answer itself is unchanged.
- MCP: the `cli_account_sign_in` entry said its confirmation dialog shows the account never as an email. The dialog shows the account's name, and an account Navide added on its own is named after the email it was signed in with, so it can show an email; the documentation now says so. Behaviour is unchanged.
- Releases are built and packaged with Bun instead of pnpm (Windows installers still run electron-builder under Node). The installers hold the same app; no user impact is expected. (#487)
- Grok Build: shared folder trust (#402, new in this release) shares to `~/.grok` only the workspace a pane was opened in, or a folder inside it, and only for panes this Navide started; any other row stays in that pane's own copy. Trust left in panes from earlier builds is shared only once Navide starts that pane again. Its records moved to `grok-folder-trust/` in Navide's data folder; the old files are copied once and left in place. (#489)
- MCP: `plugins_install_file_fill` refuses to stage a file when the copy would leave less than 5 GiB free on the disk (`STAGING_DISK_LOW`, naming the free space and the file's size), and writes nothing. There is no count quota; a file larger than an installable package (256 MiB) is refused.
- Navide plugins: a Navide plugin installed from a file now records its file's digest. If you go back to 0.2.26, local installs that carry a digest or a developer signature are quarantined and not loaded; they come back on 0.2.27 or later.

### Fixed

- Grok Build panes (#402): a folder you trusted in one Grok pane is trusted in every Grok pane, including new and rebuilt ones — each pane keeps its own copy of `~/.grok/trusted_folders.toml`, and Navide appends the folders the panes trusted to the end of your file (your comments and layout untouched; only the workspace a pane was opened in, or a folder inside it, is shared to `~/.grok`), backs the file up first, and removes exactly that text when the new convenience feature **Grok folder trust shared** is turned off. Navide answers Grok's trust prompt for a resumed pane too, only for the pane's own workspace, and a prompt still on screen now shows the pane as waiting, so messages wait instead of being typed into it; agents and chat relays can only refuse it. A fresh Grok pane starts with its own `--session-id` instead of being sent a session marker, which Grok answered as a prompt and spent a turn on. `cli_usage` says Grok Build does not report credits to other programs (use `/usage` in the pane) instead of a raw `Method not found`, and a pane whose `grok` is not xAI's Grok Build says so in its startup probe line.
- Navide plugins: the main window no longer reports `Cannot read properties of undefined (reading 'push')` at start when a Navide plugin declares a `detail` view, as the built-in Git does. A `detail` view still opens only through the view that owns it, never as a main-window region.
- Channels: in Channel connections and Settings → Channels, a chat the running bot does not know is named by its id instead of by the name its pane had when it was linked. The Channel connections description now says the status is the bot's: Connected means the bot is online, not that every chat can be reached.
- Pipelines: a slot whose kickoff never reached its agent no longer leaves the run `running` with a pane that never got its task. The run now stops as failed, with an error toast. The slot's node is marked failed with the reason (shown when you point at the node's status, and in MCP `pipeline_status` as `nodes[…].error`), and the slots stopped with it say which slot failed. The panes stay open, and a resume continues at the stage that failed. **This also stops the run when a kickoff reached the input box but could not be confirmed as submitted**, which used to be left running in case the agent had started anyway: on resume, a kickoff still in the input box is submitted with Enter rather than pasted a second time. (#448)
- Plans: plan documents are wider (up to 1180 px) and long code in a table cell wraps instead of being cut off; existing documents get this without edits. The plan preview keeps the doctype first, so it no longer renders in quirks mode. (#451)
- MCP: quitting Navide no longer hangs on an MCP server that does not exit. Each step of stopping a server ends after 5 s, a local server that ignores its shutdown is then ended with its child processes, and a stop that is cancelled still finishes; on Windows a failed `taskkill` is logged instead of dropped. (#454)
- Messages: badge colours follow the light or dark theme, and the route row is no longer styled as a badge. (#458)
- Navide plugins: stopping the agent tool result helper now ends only the helper's own process tree on every path, so in the rare case that its process id was reused, a pane that got the same id is no longer ended with it (follow-up to #445). (#457)
- OpenCode: Navide reads OpenCode 2.x sessions (its new `session_v2` and `session_message` tables), so turn ends, token counts, session binding and resume work again on a 2.x database, including one upgraded from 1.x, without counting the copied history twice. A database Navide cannot read (an unexpected SQLite error, or neither schema) is no longer passed over in silence: it is logged once and reported as `log_reader` in `cli_get_status` for that CLI's panes until a read succeeds. OpenCode 1.x is read with the same queries as before. (#485)
- Layout: in sidebar, spotlight and fullscreen modes, panes fill the stage width again after you widen the window. Each pane's column cap is still kept when you enter one of these modes, so going back to the grid does not garble Claude's scrollback; only after a widen lifted the cap does a pane reflow on its way back. (#495, continues #441, thanks @slighter12)
- Claude: rows Claude draws below its awaiting box (a statusLine, a hint row) no longer throw off the detection of a waiting pane, and a draft in the input box that ends with an anchor is no longer taken for a waiting prompt. Other CLIs keep the earlier frame check. (#497, continues #447, thanks @slighter12)
- Claude: a pane stays waiting for an answer (AWAITING) for as long as Claude's permission box is open, raised by Claude's own `PermissionRequest` hook instead of by screen text alone, until the box is answered. A `PostToolUse` or `PostToolUseFailure` that arrives after the turn has ended no longer reopens it (activity clock, message queue, loops, dev time) and no longer clears the Dock's to-review mark early. (#443, thanks @slighter12)
- MCP: after the backend had been running a long time, every MCP tool call from a pane could answer `-32603` until Navide restarted. The `/plan-mcp` endpoint's session task group is now rebuilt on the next request after it is cancelled unexpectedly, so the pane keeps working without a restart; such an error now names its cause, the method and the caller. The MCP library's warnings and errors (`mcp.*`, WARNING and above) are written to `backend.log`, and a refused credential (401) is logged. What set it off on the reporting machine is not known yet; the next occurrence will be logged. (#493, fixes #490)

### Documentation

- README (English, 繁體中文, 日本語): the supported-CLI list names all 15 CLIs, MiniMax Code included. (#486)

## [0.2.26] — 2026-10-19 — signed release

### Added

- Channels: a chat can wake its pane when the pane is not online. The offline reply carries a "▶️ 喚醒" button (on platforms without buttons, type `/wake`); waking reopens the pane's Navide window if needed and brings the pane back on its own conversation, never a new one. It is refused with the reason — and nothing is opened — when no Navide window is open, the CLI is out of quota, the conversation cannot be resumed, Navide is set to start fresh or to ask, or the conversation is already open in another pane. Messages sent while the pane was offline are kept (up to 20, for 30 minutes) and go in, in order, after the wake or when the pane comes back on its own; any that are pushed out, expire, do not fit the pane's queue or are lost to a Navide restart are named back to the chat. One wake at a time, 5 minutes apart per chat, at most 10 per chat per day. For a minute after Navide starts, a message for a pane that has not registered yet is held instead of answered offline. A wake for a pane that is already online, button or typed `/wake`, is answered and never sent to the CLI. The first 40 characters of each kept message are stored in `navide.db` until sent or reported (see privacy). (#412)
- Resume: Settings → Resume scope has an **Auto** option: when resuming, bring back only the panes whose CLI was still running when Navide last closed. Panes that were reclaimed, exited or never opened stay placeholders. The default is unchanged. (#414)
- Extensions: **Install from .vsix file…** installs a Navide plugin package you pick. It is not reviewed by Navide and not signed: the dialog says so, shows the publisher as self-declared and the package as not scanned, starts on Cancel and needs an explicit acknowledgement before consent. It never updates automatically. Replacing an installed Navide plugin of the same id is asked first and carries over no permissions, native backend consent, file-change permissions or agent tool approvals; when the source changes, the stored data is set aside instead of handed over. (#425)
- Extensions: **Developer Mode** (Settings → Navide Plugins, off by default) loads a Navide plugin you are developing from a folder. Inside Navide it can only be switched on that page and every change made there is recorded; while it is on a banner stays above the list and every launch reminds you. The setting is kept in an unsigned file that another program running as you, an agent CLI included, could also change without a record (see the plugin docs). A folder is asked about again when its permissions or backend change, not when its files change. Developer folders are checked against Navide's takedown list on every load. In a packaged build a self-hosted Registry (`AGENT_TEAM_MARKETPLACE_URL`) is used only while Developer Mode is on; with it off, a Navide plugin installed from one is not loaded and the page says why. (#428)
- Navide Marketplace: a pre-release version can be installed from its detail page, and is labelled 預覽版（已審核） in the trust dialog and in Extensions. (#426)
- Extensions: every Navide plugin shows where it came from (Navide Marketplace, pre-release, local file, developer folder, …) and what review it passed, in a "Source and review" row on its disclosure card, trust dialog and Disclosure overview. A local, developer or test package also keeps a mark in Navide's own chrome: a strip above its view, a dot on its sidebar tab and title-bar button. No source is ever called verified or safe. The native backend consent and the agent file-change approval name a local file or a developer folder as not reviewed by Navide. (#422, #423)
- MCP: a read-only `cli_accounts_list` tool lists the CLI accounts Navide keeps and which one each CLI runs on, read from the account store only: no email and no signed-in state, since both would mean reading the credentials.
- MCP: a read-only `cli_failover_state` tool lets an agent see what Navide's quota failover is doing: the policy, open incidents, how many automatic switches each account pool has left, and which vendor is blocked by a half-finished switch until the user resolves it. It reads only that in-memory state: nothing is refreshed or switched, no credential or Keychain item is read, accounts are named by slot id, and the live login's identity, fingerprint and raw error text are never returned.
- MCP: a `cli_account_sign_in` tool lets an agent open the sign-in Navide already offers for one CLI account — a parked account in its own private home, or a claude account inside its own folder — so the user only finishes it in the browser. Nothing opens until the user agrees in a dialog in the main window that starts on Cancel and shows the vendor, the account (never an email), the calling pane, the workspace the sign-in pane opens in (the caller's own) and the agent's reason, labelled as the agent's with invisible characters shown; a no, no answer in time, or the window leaving the caller's workspace meanwhile opens nothing. A sign-in the user starts from Settings → Accounts asks nothing new. It goes through the window's own sign-in, never switches accounts, returns no token, code or URL, and leaves the active account, the built-in Default and sign-ins that replace the live credential to the user. Only CLI panes can call it; `ui_invoke` cannot reach it.
- Accounts: signing in to a Claude account from Settings → Accounts now continues in the same pane with the sign-in for that account's own folder, and asks you to authorize once more, so the account no longer shows **Sign in** after it was signed in. It is skipped when the account is already the default. Closing that pane only leaves a reminder. (#434)

### Security

- What a CLI sign-in pane prints (an authorization URL, a pasted code) no longer reaches anything but that pane: it writes no log file, `cli_read_log` refuses it, `cli_get_status` and the chat relay get no screen text from it, a chat cannot be bound to it, and it is not shared with the editor's AI Chat or by dragging it onto another pane.
- Guard: answering a permission prompt remotely (the chat relay, `cli_answer_prompt`) can no longer pick Claude's "Yes, and switch to auto mode", which approves every later prompt like an "always allow"; answer it at the computer. (#442, thanks @slighter12)

### Changed

- Messaging: a message whose Enter went out but that nothing on screen confirms the CLI took (a collapsed paste with no input box in view, or growth only with no new turn within 12 s on a CLI that reports turns) is now reported as `unconfirmed` instead of delivered. It is not resent; its user record arriving later still confirms it. A scheduled run that ends `unconfirmed` is recorded as an error (with the usual backoff) instead of ok; it is not corrected if the message is confirmed later. Enter is never pressed again into a permission or confirm dialog. (#413, #416)
- Settings: the Disclosure overview is now the last section of Settings → Navide Plugins instead of a page of its own; links to it land there. It loads only when scrolled into view and refreshes only while visible. (#415)
- Guard: a Glob whose pattern can expand into a credential store (for example `**` under `~` or `/`, or `*ssh/*`) is graded high like listing the store, and a Grep whose glob names a store or secret file is graded critical like reading it; `{a,b}` braces are expanded and every `path`/`paths` entry of a file tool is checked. A Grep sweep that names no store stays normal. What Guard does with a grade follows your settings. (#427)
- Guard: an agent's write, delete, move, link or mode change of Navide's plugin install root (Developer Mode file and grants included), local trust records, native backend consent store, or the kept-source markers and set-aside folders beside backend data is graded critical (rule `plugin-store-write`, which can be lowered to high but not switched off); reading them is unchanged, and so is a plugin's own backend data. The output file of `curl`/`wget` and `>|` are graded like `>` everywhere, so downloading into a credential store, git hooks, CI workflows or agent CLI settings is graded as writing there. Guard sees only CLIs that run its hooks and the shell forms it parses; it does not stop other programs running as you. (#431)
- Extensions: the disclosure card of a Navide plugin with views now says that its views can reach the network and show external websites, which Navide does not filter or record; the card's network entries cover only commands and the native backend. A Navide plugin without views gets no such line, and where only Registry listing data is shown (the Navide Marketplace detail page, an agent's install request) it is said conditionally.
- Channels: the offline reply now says the pane's Navide window is not open or the pane was closed (it no longer suggests another workspace), in the Navide language. (#412)

### Fixed

- Navide plugins: the helper that carries large agent tool results now exits after 60 s idle, so it no longer keeps about 339 MiB after a large result (0.2.25 known item). The next large result starts a new one, about a second slower. (#429)
- Windows: restarting the agent tool result helper after its idle stop could fail with "The handle is invalid", so results over 1 MiB were refused for about a minute; fixed. On Windows the helper's own error output (stderr) is no longer written to Navide's backend log. Stopping the helper now ends only the helper's own process job, so a pane that was given the same process id is no longer ended with it. (#445)
- Pipelines: a workspace can start a pipeline again after an aborted run; a start reads the pipeline's current stages, a refused start says why (toast and log), and Reset also clears the stored run. (#420)
- Linux: panes and tools started by the packaged build no longer inherit its bundled `LD_LIBRARY_PATH` (`libcrypto.so.3: version 'OPENSSL_3.4.0' not found`). (#418)
- Scheduler: a job's daily run count starts at its local midnight on DST-change days too. (#419)
- Navide plugins: a Navide plugin from a test channel whose signed expiry has passed is refused, and an unknown Registry channel is refused instead of trusted. (#421)
- Registry (self-hosted): every `X-Admin-Token` endpoint now refuses with 401 while `REGISTRY_ADMIN_TOKEN` is unset, empty or blank (`POST /api/publishers` and `/featured` used to accept any request then); `REGISTRY_ALLOW_OPEN_ADMIN=1` reopens only those two for local development, and the `official` profile refuses it. Publishing with `channel=testplace` answers 409 `TESTPLACE_NOT_OPEN`, an unknown or mismatched `channel` answers 400, and test-channel versions are hidden from every public read. (#411, #421)
- Plugin SDK: `@navide/plugin-contracts` and `@navide/plugin-sdk` are tree-shakeable, so a plugin bundle keeps only the SDK it calls and the Registry scan no longer reports unused capabilities. (#410)
- Accounts: after a restart, a pane pinned to an account waits for the account list to load before deciding its pin, so it no longer comes back on another account and wrongly shows its quota as used up. (#435)
- Accounts: **Follow account switch** or **Continue with** on a claude pane where nothing has been typed yet reopens it fresh on the new account instead of failing with "Session not found on disk"; a pane with a conversation is still resumed. (#437)
- Accounts: **Continue with** or the account pin toggle no longer moves a sign-in pane to another account (it used to reopen it as a normal pane and silently cancel the sign-in). (#438)
- Claude: a pane waiting on Claude's current permission box (two- or four-option) is shown as waiting for an answer for as long as the box is open, and dialog text quoted in the conversation is no longer taken for a dialog. (#439, thanks @slighter12)
- macOS: switching input source with Cmd+Space while an IME reading is still being composed no longer sends the reading twice. (#440, thanks @slighter12)

## [0.2.25] — 2026-10-18 — signed release

### Added

- Extensions: an agent's request to install, update, roll back or remove a Navide plugin now opens a card in the main window: who asked, from which workspace, the agent's own reason (shown as the agent's words), the version's disclosure card from the Navide Marketplace (marked not verified yet), and for an update or a rollback what changes from the installed version. Approve runs the usual install, rollback or remove steps in that window, its trust dialog and remove confirmation included, and the result is reported back to the agent; Reject changes nothing. A request a closed window left half-done is settled by the other open windows after a short grace, instead of waiting for a new window. The plugin activity page now lists what agents did to each Navide plugin. (#383)
- Extensions: Navide keeps a local activity log of third-party Navide plugins: every request a plugin makes to the Navide app is recorded with the plugin, what it asked for, the workspace and whether it was allowed or refused. A file path is kept only relative to the workspace, file contents are never stored, and a shell call keeps only the executable and subcommand. A refusal because the plugin did not declare that permission is marked. Recording never slows or fails a plugin's request, and the bundled Plans, Git and Mini-IDE are not logged. Calls are counted per plugin, workspace, kind, key and minute, so a plugin repeating a call, even a refused one, adds to one row's count instead of a new row each time, and no row is keyed on text the plugin wrote; a plugin frontend's calls to its own backend are counted too. The activity page below shows it. (#368, #373, #374, #380, #397)
- Extensions: a Navide plugin installed from the Navide Marketplace can be disabled and enabled again. A disabled Navide plugin is still verified at startup, but its views and backend are not loaded, now or after a restart; its files, Grant and stored data are kept, and its row shows a Disabled badge and an Enable button. Enabling restores it under the Grant it already has. Update, rollback and remove keep working while it is disabled, and an update stays disabled. The bundled Plans, Git and Mini-IDE packages are not covered by this switch. (#333)
- MCP: `plugins_enable` now depends on who disabled the Navide plugin. One an agent disabled comes back at once, as before. One the user disabled in Extensions (or disabled before this was recorded) is not enabled: a request is filed instead, and it is enabled only when the user approves it in a Navide window. Navide records who disabled each Navide plugin from the Navide Marketplace; the user's own Enable and Disable switch works as before. (#385)
- MCP: an agent can ask for a Navide plugin to be installed, updated, rolled back or removed (`marketplace_request_install`, `_update`, `_rollback`, `plugins_request_remove`, `marketplace_request_status`); nothing happens until the user approves the request in a Navide window, and the tools have no consent argument. `plugins_disable` and `plugins_enable` act at once on an installed Marketplace package; the user is told which agent did it, with a one-click undo in the announcements centre. The bundled Plans, Git and Mini-IDE are refused. Every request, decision, disable and enable is recorded with the caller in navide.db (`plugin_agent_actions`). (#370, #376)
- Navide plugins (plan B1-b, Host side): Settings → Extensions → Native backends has a "Let agents call tools from third-party Navide plugins" switch and, under it, "Let external MCP clients call them too"; both are off by default, and with the first off nothing changes. When on, the Host serves the agent tools a third-party Navide plugin declares only after the user allowed that exact package, keeps a catalog of them for the core MCP server (`plugins.agentTools.sync`), and re-checks every call: switch, caller, disabled, quarantined, revoked or stopping package, consent, workspace grant, an open Navide workspace as the target, a one-time question naming the agent tool before the first write-risk tool there (asked again after an update or a new consent), the agent execution policy, and the call's deadline. Tools count as allowed only once the consent dialog has shown them (B1-a); until then none is served. Turning the first switch off also turns the second off. The plugin backend receives the calling pane, verified to the pane only. Declaring agent tools in a manifest and the MCP tools themselves come with B1-a and B1-c. (#347)
- MCP: three read-only tools, `marketplace_search`, `marketplace_detail` and `plugins_list_installed`, let an agent search the Navide Marketplace, read one Navide plugin's listing and disclosure card, and list the installed Navide plugins with their state. The Navide app answers them with the same search, detail and inventory the Navide Marketplace page and Settings → Navide Plugins use. They cannot install, update or remove anything. Text a package publisher wrote reaches the agent fenced as external content with a third-party Navide plugin label, and a pane that reads it is marked as having received external content. The Navide app's own fixed error wording (for example a bad `limit`) and the installed first-party `navide.` plugins stay plain and mark nothing. Invisible marks (variation selectors, combining marks) and filler characters cannot disguise the fence's boundary lines; elsewhere in the text they are kept. (#345, #359)
- Extensions: the bundled Plans, Git and Mini-IDE can no longer be removed; each can be disabled and enabled on its Bundled row instead. A disabled built-in shows no tab, window or legacy recovery view, and agents cannot reach it: with Plans disabled the `plan_*` MCP tools leave the tool list, a call from a CLI that cached the list answers `PLUGIN_TOOL_UNAVAILABLE` (reason `plugin-disabled`), no plan assets are provisioned and phone feedback on shared plans is refused; with Mini-IDE disabled, opens only the Mini-IDE can serve are shown disabled with the reason, while opens to an external default editor keep working; their shortcuts do nothing and pass the key through. Grants and stored data are kept, and Enable restores everything. With all three enabled, behaviour is unchanged. A Git or Mini-IDE removed by an earlier version comes back Disabled, and its row says that removal deleted its stored data. While Plans is disabled no plan document can be shared, and the backend knows the switch from its first instant (passed at spawn). The switches are written with a backup; a damaged file is restored from it, and with both unreadable the three built-ins stay disabled until **Reset switches**. A CLI sees `plan_*` again after it reconnects. (#348, #356, #362)
- Navide plugins: a Navide plugin with a native backend can declare agent tools (`backend.agentTools` in Manifest v2), and agents call them as MCP tools of the `navide` server, listed after Navide's own tools and labelled at the start of their description with the plugin, its version and its permissions. Nothing is served until the switch above is on and the consent dialog has shown the exact tools; any change to a tool asks again. Tool text cannot use invisible fillers, and two declared values that would be served as the same text are refused as ambiguous instead of guessed. Arguments and results of any size cross every hop in pieces, never cut by a size limit, and their sizes are recorded with each call. A package that stops being callable while a call starts answers with why (`plugin-disabled`, `plugin-not-installed`, …) instead of an error attributed to the plugin (#346, #352, #364, #365, #369, #375, #378).
- Navide Marketplace: every version carries a disclosure card, signed by the Navide Registry at publish and approval and checked against the downloaded package before install (a mismatch refuses the install). The card shows the risk level, what the publish-time scan of the JS and native backend found but the package does not declare, the declared permissions and the Registry's own facts, which are labelled unsigned. It appears on the Navide Marketplace detail page and in the install consent dialog, and an update lists what changed from the installed version (New, Removed). The native backend consent dialog is in zh-TW, en-US and ja-JP and names the backend's methods (#353, #354, #355, #360).
- Extensions: each Navide Marketplace plugin's "Permissions, grants and activity" section shows its activity: agent tool calls, files, commands, a daily trend, permissions declared but unused, uses not declared (in red, with the reason), unusual items, live calls and the queue backlog. Settings → Navide Plugins → Disclosure overview lists every installed package's disclosure card and activity totals, and a Registry rescan that finds new items is announced. Text the plugin wrote is shown as plain text (#371, #374, #377).
- Navide plugins: a native backend may declare `shell: "allowlist"` to run `git`, `gh` and `glab` through Navide's shell broker; the consent dialog marks it high risk, and the agent Execution Policy applies to agent-started commands. Full shell is still refused (#344).
- Navide plugins: when a third-party native backend goes over a resource threshold (memory, processes, CPU or data folder), Navide no longer stops it on its own. A notice in the main window says which plugin, what and how much, and you choose Stop or Keep running; it keeps running until you choose. Keep running raises that item's next notice to twice the current level. Every notice and choice is recorded. The thresholds are unchanged (#386, #377).
- Navide plugins: plugin backends are no longer capped at 64 calls in flight, 16 backend children, or fixed numbers of subscriptions, Bridge requests and queued events; the current and peak numbers are shown on the activity page instead (#363, #367).
- Navide plugins: removing a Navide plugin whose native backend left data asks whether to keep it for a reinstall, showing its size and location; delete is the default. With no data the confirmation is unchanged (#339).
- Channels: Telegram's "/" menu offers `/prompts` and `/skills`, each opening one group of the quick menu, and a read-only `/mcp` listing the MCP servers. Navide's commands in the menu are described in the Navide UI language (#338).
- Channels: `/resume` joins the Telegram "/" menu, and button lists are laid out a few to a row. On every platform a command addressed to the bot (`@bot stop`, a Slack or Discord mention) works as the command instead of going into the pane, and a platform without buttons is told the commands its buttons stand for (#326).

### Changed

- Channels: `/menu` and a bare `/start` no longer open the mixed menu; they answer "請改用 /prompts、/skills、/mcp" with a button for each, which runs that command (#389).
- Loop: an explicit interrupt of a pane, from the terminal, its menu or an agent's `cli_interrupt`, also stops its loop and says so, instead of the loop answering the interrupted turn with a continue. This covers a chat's `stop` and a self-evolution run interrupted for going over budget. A batch interrupt and the Interrupt button on an evolve announcement leave the loop running. Three continues in a row that fail to reach the pane also stop the loop with a notice. The done marker counts when wrapped in backticks, `*` or `_`, and a turn that ends before its continue was fully sent is no longer missed (#381).

### Fixed

- MCP: `marketplace_request_status` now reports a result that came in late. When another Navide window had settled a request as interrupted while the window carrying it out was reconnecting, and that window then reported what really happened, the answer carries `finished_late: true` and `settled` (what had been recorded before), with `status` and `error` the actual result. Every other answer is unchanged. (#398)
- Navide plugins: a `shell.run` result that was cut now says so. The Host shell broker still returns at most 8000 characters of `stdout` and of `stderr`; the result now also carries `truncated`, the full size of `stdout` in bytes (`stdoutBytes`) and, when `stderr` was cut, `stderrBytes`, for views and native backends alike. `exitCode`, `stdout` and `stderr` are unchanged, so the bundled Git reads exactly what it did before. Before, a cut result looked complete. (#395)
- Guard: the Grep and Glob tools now go through the same credential-location check as Read and `ls`. Grep searching `~/.ssh`, `~/.aws` or another credential store (by its path or its glob filter) is graded critical like reading the file, and Glob listing one is graded high like `ls`; before, both were always normal. `~/.claude/secrets` now counts as a credential store for every tool and shell command. Grep and Glob calls that touch no credential location are graded exactly as before, and what Guard does with a grade (allow, ask or deny) follows your existing settings. (#379)
- Guard: with Navide Guard switched off, no Guard notice appears ("could not check an action, allowed" no longer shows when a check timed out), and the pane badge no longer says High and Critical actions need your confirmation. The switch's description now says that chat-relay approvals, MCP prompt answers and terminal command protection are not covered by it (#382).
- Guard: Qwen Code's and GitHub Copilot CLI's search tools (`grep_search`, `rg`, `glob`) go through the credential-location check, and a search naming both `path` and `paths` checks every root in both (#384, #387).
- Interface scale: the scale set in Settings → Appearance is kept after a restart; it was read back as 100% at startup, which Linux users met on every restart (#405).
- MCP (Windows): a Navide plugin agent tool called without a pane (the Navide app or an external MCP client) accepts a drive-letter `workspace_path` such as `C:\Users\dev\proj` instead of refusing it (#404).
- Navide plugins: text a plugin controls has its invisible characters spelled out (`\u{202e}`, `\u{200b}`, …) on the activity page, the disclosure overview, notices, and the Navide Marketplace and Extensions listings, so a name or path can no longer be shown reversed or look like another plugin's (#396, #400).
- MCP: `/plan-mcp` checks a caller's credential before reading the request body, and each pane gets its own credential, revoked when the pane closes, instead of one shared by every pane (#336, #399).
- Account switching: switching Claude accounts no longer fails with "帳號切換失敗" once the stored credential is larger than about 4 KB (for example with several MCP logins); it was cut when stored (#330).
- Channels: a stale answer's current prompt is relayed to the chat once instead of twice (#329).
- Messaging: a pane that receives a message from an MCP client with no pane is no longer told to reply to it, which bounced with `No pane named "a host client"` (#328).
- Backend: token values are redacted for log handlers added later and in format-error reports, too (#313).
- Navide plugins: packaged builds ignore the plugin Developer Mode environment variables, so they can no longer load an unsigned local Navide plugin; plugin folders are read in a stable order (#331, #341).

## [0.2.24] — 2026-10-16 — signed release

### Added

- Channels: `/pending` (or `/pending@<bot>`; a command for another bot is ignored) re-sends every prompt still waiting for an answer in this chat or topic, each with the pane name, how many minutes it has waited, the prompt, its options and its buttons. The re-sent message becomes the prompt's own message, and the earlier copy drops its buttons and says "↓ 已重新列在下方". With nothing waiting, the reply is "目前沒有等待確認的 pane". Only prompts from this chat's bot, chat and topic are listed. At start the Telegram adapter adds the missing entries of its "/" menu (`pending`, `menu`, `status`, `stop`, and `cancel` from #316) to the bot's command list without replacing or reordering the bot's own commands; it writes nothing when the list is complete or cannot be read (#291).
- Channels: the warning a chat gets when it writes to a pane that is waiting for an answer now carries the prompt (up to 300 characters), its options, the answer hint and the same buttons as the prompt. On Telegram it quotes the original prompt message, so tapping the quote jumps back to it. It is edited along with the prompt when the prompt is answered, superseded or expires. A warning sent to a different chat or topic keeps the one-line hint, with no buttons or quote (#290).
- Channels: `/cancel` withdraws this chat's messages that have not gone into a pane yet, including lines still being joined, and replies with how many were withdrawn, how many came too late (already delivered or failed) and how many got no answer. When this chat still has messages waiting, the `stop` reply names the pane and adds "（還有 N 則在排隊；傳 /cancel 撤回）". The "已收到，等 pane 空檔…" acknowledgement carries "↩️ 撤回排隊中的訊息" and "⏹ 中斷 pane" buttons, removed when it turns into the working status. `cancel` joins the Telegram "/" menu (#316).
- Channels: a chat can resume a pane it stopped. After `stop`, the chat's next ordinary message resumes the pane before it is delivered, the same as typing into the pane, instead of queuing until it fails as "not-ready". The stop reply carries a "▶️ 繼續" button, and `/resume` does the same; both answer "pane 沒有停住" when the pane is not stopped. Commands never resume a pane (#318).
- Toasts: a delivery from a chat channel (Telegram, LINE and others) gets its own toast: a solid red header band reading "External channel · {platform} · {sender}" and a thin red frame over the normal toast background, shown for 8 s. Deliveries from another machine keep the solid red external toast, and Guard, other-workspace and ordinary toasts are unchanged (#283).

### Changed

- Scheduler: a job owned by a pane follows that pane's conversation. Rebuilding a pane on the same session, or resuming a closed pane's session in a new pane, hands its jobs to the new pane, so they can be changed again instead of failing with `SCHEDULER_NOT_OWNER`. A different or empty session, a pane name alone, an owner that was only unregistered by a backend restart, and a live owner never pass a job on. Each hand-over is recorded in the job's `owner_inherited` state and logged (#298).
- Self-evolution rules v3: runs also read the error ledger (`persisted`), the flaky-test ledger and pane exit and stall counts, group repeated signals, and write one daily "Error triage <date>" note with the count, first and last seen, evidence, class and what a fix would be. Triage only proposes: no signal leads to an edit, commit, push or PR. Ledger and log text is treated as data, never instructions (#288).
- Plugin developer docs: the Navide plugin developer docs match current main (the SDK entry pattern, that `definePlugin` `activate` is never called, the 10 s `ready()` install check, what Developer Mode and backends can and cannot do, current limits), and CI fails when their code examples or reference tables drift from the SDK, the manifest schema or the capability catalog (#299, #300).
- Dev web mode: `NAVIDE_DEV_WEB=1 node scripts/dev-web/serve.mjs` serves the main window to a local browser against an isolated backend, for headless checks. It is dev-only; release builds are checked to contain none of it (#287).
- Tests and CI: the backend suite runs on pytest-xdist workers on Linux and macOS and in the release gate's main pass (#286); `scripts/changed-backend-tests.mjs` runs only the backend tests a change can affect, and `release.sh` can overlap typecheck with the backend tests when `NAVIDE_RELEASE_OVERLAP_GATES=1` (off by default) (#285); pull-request CI skips the backend or frontend jobs a change cannot affect (#284); `scripts/ci-triage.mjs` classifies more failures correctly and refuses a ledger write without a run id (#282, #294, #305, #307); five flaky tests wait on events or report what they waited for (#293, #306, #308, #309), and the fixed-date quota cycle tests pin their clock instead of failing once that date passed (#314); backend tests reset the remote roster first, and three more waits use events or the connect allowance (#315, #319, #322, #324); the pre-commit relative-import scan runs in linear time, about five times faster (#323); and vendor modules can no longer add function-level app imports without a reviewed entry (#304).

### Fixed

- Channels: a person's chat messages no longer hit the agent-to-agent rate limit (5 per minute), which refused the sixth message and every resend in that minute with "⚠️ 訊息沒有送進 pane（rate-limit）". Chat messages have their own cap of 30 per minute per pane and sender; past it, the chat is told the message was not delivered and how many seconds to wait before resending. Messages from agents, groups, the scheduler and other devices keep the agent limit (#301).
- Channels: an answer from a chat, typed or by button, presses keys only while the window still shows the prompt and options the chat was shown. If the prompt has changed, the answer is not sent: the old request is used up, its message is edited to "superseded", the current prompt is relayed again, and the chat is told "⚠️ 畫面上的確認已經換了，這個回覆沒有送出；請在新的確認訊息重新選擇". A stale button is refused (#289).
- Read aloud (Linux): readback now speaks. Navide turns on Chromium's speech-dispatcher support, without which no voices were found and every utterance failed. On Windows, the voice hint in Settings › Voice Input points at Settings › Time & language › Speech instead of a macOS path; Linux names the system's speech settings; macOS is unchanged (#292).
- Shutdown: the backend no longer hangs at quit when a Git watcher burst is being recorded at the same moment (#295), and no longer waits on SQLite's busy timeout in that case; the burst's rows are now kept (#303).
- Channels: every channel label names the bot rather than the chat user: the pane-header chip, the sidebar marker and the Settings and popover bot names read "platform · bot", with the full platform · bot · chat · level in the tooltip and in Channel connections. The bot's name is the one you gave it in Navide, then the name the platform reports (Telegram, Discord), then its handle. Channel toasts still name the sender (#310).
- Channels: Claude's notes about an image it read are no longer mirrored to the chat as "你：[Image: …]", and no longer start a fake local run. A prompt with pasted images now reaches the chat with its typed text plus "🖼 圖片 ×N"; the images themselves are not sent (#320).
- Channels: the "⏳ pane 處理中…" status is turned into ✅ when the turn ends even if it ended while that status was still being sent, instead of staying on "working" above a finished reply (#321).
- Shutdown: a terminal whose CLI closed its output before it could be reaped at quit is now removed from the PTY registry before shutdown finishes, instead of being left behind (#317).
- Plans: overlapping plan-list calls share one follow-up scan instead of sometimes running an extra full scan; results were already correct (#325).
- Backend: the WebSocket connection token is no longer shown in uvicorn's handshake log line; token values in `t=` and `token=` query parameters are written as `***` in every backend log line. The line only went to the backend's terminal output, never to Navide's log files, and the token changes on every backend start (#311).
- Plugin SDK: a package scaffolded by `navide-plugin init` reports ready, so it passes the install check instead of failing it as written (#302).
- Plugins: a plugin backend's spawn or child error keeps its message in the diagnostic when the runtime's stack omits it (#297, thanks @slighter12), and installed plugins are scanned in directory-name order, the same on every filesystem (#296, thanks @slighter12).

## [0.2.23] — 2026-10-15 — signed release

### Added

- Status bar: a notifications bell shows whether system notifications are on (a crossed-out bell when off), a muted-speaker mark when the notification sound is off, and a warning dot when the system has denied Navide notifications. Clicking it opens a popover with the "System notifications" and "Notification sound" switches from Settings › Notifications, the notification permission status where the platform has one, and a "Notification settings ›" link. The switches are the same settings as that page, and both stay in step across windows (#264).
- Plans: agents can add a todo to an existing plan with the `plan_add_todo` MCP tool, appended or after a named todo, optionally owned by the user. The todo goes into `plan-meta` and gets its own row in the Plan view; an id is given (the next free `tN`) when none is passed, and a duplicate or malformed id is refused (#275).
- Panes: an agent CLI that exits with a non-zero code gets "⚠ Exited (code N)" in its title bar while the pane is exited or in error, with the code in the tooltip; it goes away once the pane runs again. A plain terminal's shell, and a 127 already explained as a missing CLI, are left out (#276, C1).
- Panes: a pane whose turn has shown no session-log activity and no screen output for 20 minutes gets "⏳ No activity 20+ min" in its title bar, cleared when it moves again. Panes whose CLI never reports log activity are left out. It is a reminder only: nothing is interrupted or restarted (#276, C2).
- Diagnostics: an on-disk error ledger, `logs/errors.jsonl` in Navide's data folder, collects backend faults (unretrieved task exceptions, `INTERNAL_ERROR` replies), renderer warnings and errors (including window `error` and `unhandledrejection`), and main-process faults (uncaught exceptions, a backend crash or restart give-up, a renderer that died). The backend part rotates at 512 KB with 3 backups, and the main process stops appending past 4 MB. For agents, `ui_diagnostics` returns the newest entries as `persisted`, even when no window answers (#276, B1–B3).

### Changed

- Windows and Linux keyboard shortcuts: the main window's sidebar tabs are now Ctrl+Alt+1–5 and Settings is Ctrl+,. Those keys no longer reach the CLI in a terminal pane. Ctrl+1–9 still selects the CLI type for the next pane. Ctrl+Alt is AltGr on Windows: on a keyboard layout where AltGr+digit types a character (German ² and ³, for example), that digit keeps typing the character and does not switch tabs. Tooltips show the platform's key instead of ⌘. macOS is unchanged (#263).
- Settings: Navide Cloud moves from the "Accounts & Agents" group into the group formerly named "Navide Plugins", now "Navide Services" (zh-TW「Navide 支援」, ja-JP「Navide サービス」). Navide Cloud › Sync lists one row per Agent Assets page, in the sidebar's order and under its names: MCP, Skills and Prompts can be turned on; Memory, Credentials & keys and Extensions are greyed out as "not syncable yet". A Memory switch an older build left on can still be turned off (#265).
- Cross-device messages: a message from a device that has already signed with the time signature (sig2) is now refused when it arrives without a usable one, instead of being accepted on the older signature (the 0.2.21 known limitation). Devices that have never sent sig2 are decided on the older signature as before. When the time signature checks out but its time is outside the window, the account window says the message was refused for clock skew, and that the other machine's clock is N minutes ahead of or behind this one (behind can also mean the message was held back on the way) (#274).
- Empty stage: a workspace tab with no panes shows one sentence, an "Open Agent" button that opens the sidebar's Agents tab, and an "or run the pipeline ▶" link that does what the sidebar's Run button does and is disabled when that button is, instead of the "Two ways to drive the team" card (#239).
- Welcome window: the recent list's state badges (completed / running / aborted), its relative times and the "Folder not found" tooltip are translated in zh-TW and ja-JP. The Open Workspace and Recent headings and the Settings link drop their emoji, the Navide mark sits beside the title, and the primary button uses the accent colour instead of green (#240).
- Plan spec: `_spec.md` says what a paged plan list entry's `meta` carries (no `reviewNotes`), and that an entry too big for one page keeps its `todos` counts, including `awaiting_user` (#252).
- Toasts: deliveries from another machine through Navide Cloud, and from a chat channel (Telegram, LINE and others), get their own solid red toast naming the device or sender and the target pane, shown for 8 s, in place of the "Instruction from another workspace" toast they wrongly showed before; only one toast appears. Navide Guard toasts get a red frame and a shield icon, and toasts from another local workspace an indigo bar with an "Other workspace · name" header. Every other toast looks as before (#280).
- Self-evolution: the token budget no longer counts context the CLI re-reads from cache. A run past 1.5× its budget is interrupted once, ends as "over_budget" and its auto-opened pane is reclaimed. A kickoff that could not be verified is confirmed once the pane spends tokens, or the task is sent once more to a pane that stays idle, and reported commits the repository does not have are named in the run's detail. The scheduled evolve job stays disabled (#276, A).
- Error ledger: a channel reply that could not be sent (`channels.reply_failed`), a plugin backend Navide gave up restarting (`plugin.backend_gave_up`, also in `main.log`), a throwing execution-policy resolver (still denied, now said once as `plugin.policy_resolver_failed`) and plans the Plans window cannot read or stat are recorded. What each one shows and does is unchanged (#276, D1, D2, D3, D5).
- CI triage: `scripts/ci-triage.mjs` sorts a PR's failed CI jobs into environment, test race or product defect and keeps `docs/testing/flaky.json`. It runs locally only (#276, E2).
- Release builds: the packaged app turns off the Electron fuses for RunAsNode, `NODE_OPTIONS` and the `--inspect` command-line arguments (#247).
- CI: GitHub Actions are pinned to commit SHAs, the release `uv run` steps use `--locked`, and the unused Antigravity usage-secrets provisioning steps are removed (#247).
- Tests: five tests that were flaky on loaded machines or Windows now order by events, read under the writers' lock, pre-warm PowerShell, skip a helper collected as a test file, or get a budget that fits a 110 MB copy (#238, #248, #253, #254, #256).

### Fixed

- Channels: when a turn ended without text, Navide holds the chat request for up to 120 s for that turn's text (0.2.22, #221). If the chat was unbound, or its pane went away, during that wait, the pane's next reply, including one typed at the keyboard, could be sent to the unbound chat. Unbinding now drops the held request, so nothing more is sent to that chat (#245).
- MCP: a pane's `/plan-mcp` credential is no longer in its command line, where `ps` shows it to every account on the machine. Claude, Copilot and Qwen panes are handed an owner-only (0600) config file under `plan-mcp-panes/` in Navide's data folder, emptied at startup; Codex panes read it from the `NAVIDE_MCP_TOKEN` environment variable and send it as a bearer header (#242).
- Cross-device trust: a block made in the policy editor, or held only by the signed policy, is kept in this machine's local copy too, so the device stays refused when the server stops serving the policy; a block lifted in the policy editor is lifted in the local copy as well (#243).
- Cross-device messages: a message goes into the replay ledger only after its signature verifies against a key the relay cannot make, so a relay can no longer push a delivered message's key out of the bounded ledger with forged messages and then replay it (#244).
- Messaging: an address whose first segment is a UUID-shaped folder (for example under `/var/folders/…/T/`, an app container or a worktree) and that names a pane on this machine stays on this machine instead of going to a remote device. The message channel refuses pairing frames and the pairing pane (`p2p-pairing-refused`); pairing goes only through the pairing flow in the account window (#246).
- Security: the Git accounts IPC handlers answer only Navide's own windows, and the legacy `shell.run` and plugin `terminal.run` calls require a workspace path instead of running the command in the backend's own folder (#249).
- Plans: the Host `plans.list` summary reports `awaiting_user` (unfinished todos only the user can do), as the MCP fallback already did (#234), and the Plans view counts "for you" todos for an entry too big for one list page, which arrives without `meta` (#236).
- Plans: when plan tools have no Host session, the error tells the agent to open Navide (or reopen its Plans view) and retry; error codes are unchanged (#237). `plan_list` and `plan_read` retry once when the Host answer times out; changes are not retried (#250).
- Plans: the Plans watcher is started only after the same Grant and agent Execution Policy check as the Plans filesystem calls (#251).
- Share links: a plan whose `plan-meta` tag lists `type` before `id`, as the provisioned template writes it, is shared under its plan name instead of its file name (#235).
- Channels: each row in Channel connections shows both ends of its link: the pane (named from any window, marked "Closed" when the pane is gone, "Unnamed pane" when it has no name), and the platform, the bot and the chat's title (or "chat <id>" when the chat has none), plus the topic for a topic link (#262).
- Terminal (Windows and Linux): Ctrl+click on a file path opens it, as Cmd+click does on macOS. Windows drive paths such as `C:\src\a.ts` are recognised, and a path the terminal shows with backslashes opens the file picker on the right file name. A row that repeats the previous row's last word (`ls src/a.ts` then `src/a.ts`) is no longer joined to it as one wrapped path (#257).
- Plans (Windows): opening a plan whose path the Host hands over with backslashes opens that plan (#258).
- Plugin views (Windows and Linux): a view that fills its window keeps the window's size after maximize, restore and full screen, including on GNOME, where the old size was reported first (#259).
- Title bar (Windows and Linux): the window can be dragged by the workspace name block in the title bar; the name, the path and the two hover buttons still respond to the pointer (#260).
- Windows and Linux: the quit confirmation and the cancelled-quit notice are titled "Navide" instead of "agent-team". On Linux, the maximize button no longer stays on "Restore" after the window manager restores the window without telling Navide (dragging it off the top, Super+Down, leaving a tile) (#261).
- Navide plugins: when the Registry cannot be reached for a package, an update check no longer erases the update found for it earlier; each package keeps its last known update while it is still newer than the installed version, and update badges show that answer. Removing a plugin, reloading the installed plugin list and switching "Get pre-releases" in Navide Plugins and Navide Marketplace now show an error when they fail instead of failing silently, and a failed pre-release switch puts the checkbox back (#268).
- Git panel: when the history or a commit cannot be read, the panel says "Read failed: <reason>" above the history it keeps, or in place of the commit detail, instead of looking like "no new commits". Both Git panel copies show it (#276, D4).
- Scheduler: a run whose message was only queued is updated once that message settles: ", then delivered", ", then failed: <reason>" (the run becomes an error) or ", outcome no longer tracked". Backoff and the job's state are not changed (#276, E1).
- Diagnostics: `ui.diagnostics.read` with a `limit` that cuts the page short returns the last returned entry as `nextSeq`, so a polling reader no longer skips the rest (#276, B2).
- Terminal: when a terminal pane's columns are locked narrower than the pane, which happens after switching the layout from Grid to sidebar, spotlight or fullscreen, the pane's right-click menu offers "Fit to pane width" (zh-TW「填滿面板寬度」, ja-JP「ペイン幅に合わせる」) to use the pane's full width. It is shown only while the pane is capped, and older output above may re-wrap a few lines. The lock a layout switch sets is unchanged (#277).
- Toasts: hard-coded English toasts in Git, Explorer, Search, the editor windows and the preview panel are translated in zh-TW and ja-JP; the update toast and prompts say "Navide v{version}" instead of "Agent-Team v{version}"; the idle-reclaim toast points at the pane's "Click to resume" card instead of saying to click the toast; and a failed convenience switch-back shows a translated message with the detail (#280).
- Diagnostics: `ui_diagnostics`' `persisted` ledger (new in this release, #276) shows a pane only entries from its own workspace, and a refused request carries none (#279).
- Plans: plan tools no longer warn "no live Navide pane uses workspace_path" for the plans of a pane working in a repository subfolder (#278).
- Registry website: "Requires Navide ≥ x" is shown only for a minimum above 0.1.0; the compatibility flag in the API is unchanged (#241).

## [0.2.22] — 2026-10-14 — signed release

### Added

- **Read aloud** (off by default): when a pane marked 🔊 finishes or needs an answer, Navide speaks a short notice with the system voice ("{pane} is done" / "{pane} needs your answer"; "{n} panes are done" when several finish together). The 🔊 toggle is in each pane's title bar, and Esc or the voice input shortcut stops speech at once. Turn it on with "Read replies aloud" in Settings › Voice Input › Read aloud, which also offers a voice picker, speed and preview. The "Voice model" row shows whether the recommended voice for the interface language is installed (美佳（Premium） for zh-TW, Ava (Premium) for en-US, Kyoko (Enhanced) for ja-JP); on macOS its Download button opens Accessibility › Spoken Content in System Settings. Speech is synthesized on this computer (#229).

### Changed

- Settings: the status badges, keyboard shortcuts and analyzer pages are polished further (#215, #219). Disabled Reset buttons keep readable text, the keyboard shortcuts page uses outlined icons instead of emoji with a visible legend under the toolbar, the analyzer has one primary button per page, and status badge descriptions and tags wrap instead of being cut off (most visible in ja-JP).
- Settings: the layout, CLI agents and CLI extensions pages are polished (round 4, #225). Icons are consistent and controls aligned, disabled controls are visible, push badges read "Push on / Push off / No push channel", the CLI extensions tab is shortened to "What Navide changes", the analyzer's ghost buttons have readable contrast, and ja-JP lines no longer leave a single character on its own line.
- Settings: the accounts, credentials and security pages are polished (round 5, #230). CLIs with several accounts are listed first with full email addresses, long explanations fold under "Details", Credentials switches between findings and inventory with a segmented control, deferred cards use a dashed outline, Security lists the CLIs in two columns with the terminal-protection sub-blocks nested, scope rows are labelled "Applies to", CLI initials are unique (for example KM and KL), the zh-TW sidebar reads "CLI 代理", and ja-JP line breaking follows the page's `lang` attribute. Visual only; no setting or behaviour changes.
- Account popover: each pane's "Follow account switch" toggle sits at the top of the account popover. The 🔗 button in the pane header is removed, and the header shows 📌 only when the pane is pinned (#223).
- Status bar: the backend popover (title, connection state, Restart/Start/Stop) and the pipeline pill (Stage N / M, completed/aborted) are translated in zh-TW and ja-JP instead of showing English (#222).
- Dependencies: fastapi 0.143, anthropic 1.13, ruff 0.17, koffi 3.3.3, Electron 44.7, Playwright and happy-dom (#207, #208, #209, #210, #211).
- Tests: four timing-sensitive tests now count clock reads, order by events or await their own return instead of waiting on wall-clock deadlines (#204, #206, #220, #228).
- Tests: the artifacts tests that time out under heavy machine load get a budget that fits the load (#232).

### Fixed

- Channels: a Telegram or other channel chat no longer stays on "⏳ 仍在執行" after Claude compacts an idle conversation; the compaction summary is no longer treated as a prompt from the pane (#213).
- Channels: when a channel-bound Claude pane hits its usage limit while a chat request is open, the chat is told once, with the reset time (and the limit menu's options when it is on screen). The request stays open, so a reply after the reset still arrives in the chat (#217).
- Channels: when Claude splits one reply into two transcript lines, the chat no longer gets an extra empty "（pane 回合結束，沒有文字輸出）" reply; the turn's text is replied once. A turn that is really empty still gets that notice, up to 120 s later (#221).
- Account switching: "Make all follow", the switch offer and the quota switch find a pane that was rebuilt while their question was open, and move it instead of reporting it missing (#214).
- CLI install prompt: the "Stop asking" box now shows up before the CLI status has loaded and is saved, so the Codex install prompt no longer comes back after every failed launch. A box the user ticked is not unticked by a status that arrives later (#216).
- CLI install prompt: an uncertain detection result no longer counts as "not installed", so a CLI that is already installed (common with nvm or a slow login shell) no longer gets the install prompt. The ＋ menu waits for the login-shell PATH before marking a CLI as missing and re-detects before prompting, a `--version` timeout counts as installed, and exit 127 opens the installer only when a probe confirms the CLI is missing (#226).
- Pipelines: pipeline tools use the pane's own workspace path when the pane sits in a subfolder of a repository (M1, M2; #227).
- Plans: a plan document keeps its DOCTYPE first when it is promoted (P3), and a failed Plans backend subscription answers with an error instead of leaving the Host waiting (P2) (#227).
- Plans: migrated Plans preferences land in the right workspace partition (X1), and the history backfill no longer stamps entries whose removal time is unknown with today's date (X2) (#227).
- Channels: a file in a folder whose name mentions "token" (for example "Token仲介平台") is no longer refused as a secret when sent as a chat attachment; the "*token*" rule now checks the file name only, folders named like a token directory are still refused, and the refusal message names the rule that matched (#233).
- Sync: sizing the skill review cache no longer fails when a review download removes its temporary file mid-count, so the next skill is held in the same round instead of the following one (#231).

## [0.2.21] — 2026-10-13 — signed release

### Added

- **One click switches every following Claude pane** (main window): clicking another account in a pane's account badge list swaps the live sign-in, and every following pane uses the new account from its next turn, without a restart and with one sign-in per account. New panes follow by default. The pin beside a pane's account badge fixes it to its account (the pane reopens once in that account's own folder and resumes its conversation, signing that folder in first if needed); clicking it again makes the pane follow (it reopens once on the live sign-in). "Make all follow" in the account list reopens every fixed pane on the live sign-in, asking once about panes that are working (move when finished, skip, or cancel). The account list is titled "Default account" and says how many panes follow. Following or fixed is remembered per pane in this computer's app storage and kept consistent across windows. "Move pinned panes along when switching Claude accounts" (0.2.20) is unchanged and still covers only fixed panes. Without any account folder sign-in, switching behaves as in 0.2.20.
- Cross-device pairing: a waiting pairing has a "Cancel request" button, and a pairing still in progress says about how many minutes are left.

### Changed

- Navide Guard: on a pane that has received external content, a command Guard cannot analyse is released only by an allow pattern with wildcards that matches the whole command (for example `python3 -c *`); other allow patterns do not release it. The release is written to the audit log, and the custom rules hint says so. Anything written in a way Guard cannot read is always left for you to confirm, so on such a pane a command like `find -exec … \;` may ask once more.
- Windows: Ctrl+V pastes in the terminal, and on Windows and Linux Ctrl+Shift+V does too; plain Ctrl+V on Linux still goes to the program, and macOS is unchanged. A plain shell on Windows no longer receives Ctrl+V as a key.
- Windows and Linux: right-clicking in a program that has mouse reporting on (Claude Code, vim, htop, …) is left to that program and no longer opens Navide's Copy/Paste menu; Shift+right-click opens it.
- Settings → Keyboard Shortcuts lists the application menu with the keys each platform uses: Ctrl chords on Windows and Linux, without the macOS-only Hide and Reload rows.
- Settings: the status badges, keyboard shortcuts and analyzer pages are tidied up; the analyzer uses line icons instead of emoji.
- CI: the Windows backend suite runs in four shards, the release workflow runs the Windows backend gates as sharded jobs beside the macOS build, and three tests that timed out on loaded runners now check order or wait longer instead (#185, #186, #187, #198, #200).

### Fixed

- A refused cross-device pairing ends at once, on either side, and the pairing card and the account window say why and what to do next, instead of showing "waiting" until the five-minute deadline. Starting a pairing while this machine's trust record cannot be read is refused up front with the reason.
- With several workspace windows open, a quit that was cancelled part-way (a refused close, the quit timer, or an update install that never started) no longer leaves the windows it had already closed out of the next launch. A window saved on a display that is no longer connected opens on the main display. Window restores, cancelled quits and abandoned update installs are written to `main.log`.
- Right-click submenus in the Git panel and the file explorer open to the left, or below, when opening to the right would be cut off at the view's edge.
- The channel menu in a pane header shows a chat connected to a pane in another window as "Connected to …" and does not offer it.
- A one-time schedule that came due while Navide was closed is no longer sent twice when the restart catch-up and the regular tick reach it together.
- The account switch dialog stays inside its card when a pane's status is long, shows out-of-quota accounts in grey instead of red, and tells you to switch to the built-in Default first instead of asking it to sign in inside a folder it does not have.

### Known limitations

- Cross-device messages without the send-time signature are still accepted in 0.2.21, with one notice per device. Refusing them from devices that already sign it was planned for this release and is not turned on yet.
- Panes that were running in an account folder before the update stay fixed; choose "Make all follow" in the account list to have them switch with the account.

## [0.2.20] — 2026-10-12 — signed release

### Added

- **Convenience features overview**: Settings → Agent Assets → Extensions → "Convenience features and what Navide changes on your computer" lists every place outside its own data folder that Navide writes to (CLI hooks and hook trust, the Codex sign-in, Cursor project MCP and skills, sign-in repair), why, and the cost of turning each off. Every such write goes through one gate, is announced in the Announcements panel and logged with the path of its backup (the latest five per target are kept). Turning a feature off backs up each target and removes Navide's entries; if a removal fails the switch stays on and says so. Anything you delete yourself is not added back: the feature is switched off with a notice and an "Allow again" button (a single deleted hook entry is skipped on its own, and deleted skill links are remembered). A folder that was deleted and re-created counts as a reset and gets its entry back, with a notice. Features already in use stay on after the update.
- **Account sign-in auto-repair**, allowed by default: when a CLI's live sign-in goes missing after an account switch, Navide writes the account you chose back. A live sign-in that is a different account, changed outside Navide, is never overwritten: you are asked to keep it or switch back. A sign-out outside Navide is reported once and not undone. Turned off, Navide does not touch the live sign-in at all and shows none of these prompts; signing in through Navide still applies.
- **Codex sign-in made in a pane**, allowed by default: when `~/.codex/auth.json` does not exist, the newest sign-in made inside a pane becomes this computer's Codex sign-in, with a notice. If that file existed and was removed outside Navide, you are told instead and nothing is promoted.
- **Move pinned panes along when switching Claude accounts** (Settings → General, off by default): switching accounts lists the Claude panes running on their own account's sign-in; the ones you tick reopen on the new account and resume their conversation. Panes on the old account and panes out of quota come pre-ticked, a busy pane is waited for and never interrupted, and an out-of-quota pane gets a "Switch account ›" button beside its badge. Off, switching behaves as in 0.2.19.
- **Share links** (Navide Cloud, when the server reports the `links` capability): Settings → Navide Cloud gains Sync / Share / Devices sub-tabs, and the Plans view a "Share link" button that turns a plan or report into a read-only link, encrypted on this computer with the key only in the link, for 1, 3, 7 or 30 days, optionally requiring sign-in and optionally sent to a direct chat. Secrets are masked before upload and key, credential and memory files are refused. The Share tab lists each link with its creator, expiry and opens, and copies, extends by 7 days, renews (the old link stops opening) or revokes one or all. Approvals and review notes left on a shared page come back to the plan, refused if the plan changed since. Agents get `share_create`, `share_list` and `share_revoke` over MCP, and Channels `/shares` and `/revoke`. Without the capability the page is the same as in 0.2.19 and the Share link button is hidden.
- **Sync version history** (Navide Cloud): Settings → Navide Cloud → Sync has a Version history card that keeps the last 10 versions or 30 days and can restore the previous version; a restored MCP server or skill waits for approval like any synced item. On a server that supports it, item bodies go to object storage directly, so large items are no longer held back by the message size limit.

### Changed

- Navide's hooks travel with each pane: Claude panes get them through `--settings` pointing at a file in Navide's data folder, Codex panes through command-line config, and Copilot panes through the pane's own hooks folder, instead of Navide writing them into `~/.claude/settings.json`, `~/.codex/config.toml` or `~/.copilot/hooks`. Entries older versions wrote there are backed up and taken back at startup, with a notice; if they cannot be taken back, they stay in use and nothing is added, so hooks never run twice.
- The cross-device pairing record lives in an encrypted file in Navide's data folder (AES-256-GCM, its key the only thing left in the Keychain), together with its notices and delivered-message ledger. An existing record moves over by itself on first start with every pairing kept, and a copy stays in the Keychain while it fits so an older build still reads current pairings. The device limit is back to 200.
- Navide Cloud: a device still on the account-wide token, or one older than 30 days, swaps it once for its own token on servers that issue them; a swap that fails part-way keeps the working token. Signing out revokes this device's token on the server, and a session ended elsewhere (password change, sign-out, revoked from another device, device removed, account deleted, replaced by a newer sign-in) says which. The desktop reports its version when it connects.
- Cross-device messages are signed with their send time too; in this release a message without that signature is still accepted, with one notice per device.
- Settings: Credentials & keys and the CLI extensions page (now named "Extensions") moved under Agent Assets; Navide Plugins and Navide Marketplace have their own group between Agent Assets and System.
- CI: longer backend suite timeouts on Linux and macOS, the Windows backend suite split into three shards, Electron downloaded before every artifact run, and more room for the pre-hello connect wait on slow Windows machines (#171, #172, #176, #177).

### Fixed

- Cross-device pairing no longer breaks after a restart: the pairing record outgrew the one macOS Keychain line it was written through, was saved cut off, and locked the machine out until it paired again. A record that would not fit is now refused before anything is written. A record 0.2.19 already saved cut off is recovered when every pin and block in it was written whole: the devices keep their keys and wait under "Needs you" in the account window for you to approve them again. One cut off earlier still reports itself as damaged and offers Start over.
- A block stays in force when this machine's copy of it cannot be saved, and the account window says so.
- Sync records from a device blocked on this machine are refused.
- Answering a legacy-row sync conflict with "keep local" pushes the kept copy again instead of raising the same conflict.
- Messages to a pane that is resuming its conversation wait until the CLI has started (up to 90 seconds) instead of being typed into its reload and lost; delivery is no longer reported from screen growth alone, and a message that went out but could not be confirmed is shown as unconfirmed, without Resend, until the transcript confirms it.
- The Extensions page has margins, scrolls and has clearer cards; a cut-off badge shows its full text on hover.

### Known limitations

- Navide's Claude hooks, Navide Guard included, apply only to Claude panes Navide opens, and not to one whose Claude command already passes its own `--settings`.
- Going back to an older Navide and then updating again can bring back skill links you removed.
- Going back to 0.2.19 loses the pairing notices, keeps only the pairings and blocks that still fit in the Keychain copy, and a device unblocked while on 0.2.19 is blocked again after updating.
- A block whose local copy could not be saved holds only until Navide restarts; block the device again afterwards.
- Moving pinned panes along an account switch: a pane waiting for your answer, or stuck while starting, can hold the move for up to 30 minutes; a pane that fails to resume gets only a summary message, so rebuild it from the pane; one long pane status can push the dialog's right side out of view; if one conversation is open in two panes, the wrong pane may be resumed.
- Share links cover plans and reports only, up to 32 MiB each, and "Send to the chat" goes to direct chats only.
- Sync version history: after a declined restore a conflict card may describe the declined version, two devices moving an account to the new storage at once may each ask about the same conflict, and one damaged item holds back its page of sync until it is repaired. Once an account has moved, a 0.2.19 device on it stops syncing until it is updated.

## [0.2.19] — 2026-10-11 — signed release

### Added

- **CLI extensions inventory**: Settings → CLI Extensions lists the CLI extensions each AI CLI installed for itself (Claude plugins and mods, Codex plugins and hooks, Copilot, Droid, Cursor, Grok, MiniMax Code, Muse, Qwen, opencode, Kilo and Pi plugins, extensions and hooks), with each one's execution tier (L1 text assets, L2 subprocess, L3 code inside the CLI's own process), the capabilities it can reach, whether the CLI asks before running it, and which hooks Navide installed. Read-only: it parses each CLI's files or runs a declared listing command with a timeout, and never installs, enables or changes anything. Agents get names and metadata through the new MCP tool `cli_extensions_list`.
- **Recent workspaces that stay**: Recent keeps every workspace you opened until you remove it, instead of dropping the oldest past 20. Open and pinned workspaces sit in their own group on top, the rest show ten at a time with "show more", a search box matches the whole history, and missing folders stay listed and marked. Every row can be removed from the list. Settings → General sets a storage limit (1000 by default, or off) that never drops an open or pinned workspace and says when it trimmed anything; going back to an older build keeps the list.
- **Settings → General → Resource limits**, every option off or unchanged until you set it: cap test-runner workers for new panes (`NAVIDE_TEST_MAX_WORKERS`); list servers that closed panes left running and stop one on a click (on by default; lists only when asked); also reclaim a focused pane untouched for N hours, as a click-to-resume card; reclaim a timed-out self-evolution run's pane after a grace period (30 minutes by default, 0 for never); and on macOS, a button that opens Spotlight's privacy settings so you can exclude build output.

### Changed

- Naming follows the new glossary (docs/en-US/glossary.md): Navide's own packages are "Navide plugins" in the "Navide Marketplace", an AI CLI's own add-ons are "CLI extensions". Settings: Integrations is now Agent Assets (MCP, skills, prompts, memory), Credentials & keys moved to Accounts & Agents, and Navide Plugins and Navide Marketplace moved to System; the old names still find them in Settings search.
- The repository moved to [Navide-dev/Navide](https://github.com/Navide-dev/Navide). Updates still come from the download mirror first; the GitHub fallback, the Help menu's repository and issue links, and the first-party Navide plugins' repository field point at the new address.
- The ✦ self-evolution badge on a workspace heading is display-only; open the panel from the heading's ⋯ menu or right-click menu.
- Plans diagrams render with mermaid 12 and keep their current layout and classic look. Also updated: Electron 44.6, electron-builder, ws, koffi, mammoth, and on the backend fastapi, anthropic, websockets and tzdata.
- The backend's `/health` reports event-loop lag and the shared thread pool's backlog.

### Fixed

- Closed panes no longer leave CLI processes running: a refused terminal kill is treated as a failure and swept, a reattached pane's PTYs are found under its earlier ids, quitting finishes its sweep within main's kill timer so Claude can shut down cleanly, and a timed-out `shell.run` stops its whole process group.
- A scheduled job that missed runs while the app was closed no longer fires twice when the catch-up and the regular tick reach it together.
- The channel chip on a pane shows the bound chat's name instead of repeating the pane's.
- Navide no longer overwrites a Claude `settings.json` it cannot parse, no longer moves files a tool wrote into the Muse pane home into your real home folder, stops adding a hook trust block to `~/.codex/config.toml` for every pane (and keeps that file's permissions), no longer hides your own Cursor skills from `git status`, keeps the real session file when a legacy copy replaces it during migration, and reads only plain names from the Cursor skills links manifest so a crafted entry cannot remove a link elsewhere on disk.
- When Navide is started from inside a pane, it no longer mistakes your real home folder for a project: the skills git-exclude walk and the MCP project config both check the real home, not the pane's `$HOME`.
- Settings → CLI Extensions masks credentials in hook command lines and recognises Navide's Windows Guard hook as Navide's.
- Pipeline graph: undo and redo wait for a pending save, and an unknown pipeline is reported as not found.

## [0.2.18] — 2026-10-09 — signed release

### Added

- **Approve what other devices sync**: a synced MCP server, skill or prompt that is new on this machine, or changes what would run here, is held until you approve it in Settings → Sync. The card shows the whole record: command, args, url, env and header names, the skill's frontmatter apart from its body, every file and which would be executable, and what changed. A large skill is downloaded into a sealed holding area for review first and lands exactly the copies shown; one over 64 MiB, or whose download failed, says why and cannot be approved. A remote delete of the default (loop) prompt is held too. A rejection stands until a newer record arrives, and a local edit while waiting ends the hold. A settings-bundle import previews each MCP server, skill, prompt and memory row the same way, whole.
- **Secret warnings**: Settings → Sync names prompts and MCP args or urls that look like they carry a credential, saying where, never what. Nothing is blocked; Dismiss holds until the item changes.
- **Credentials & keys**: Settings → Credentials & keys scans this machine's git credential helpers, gh and glab accounts, SSH keys and keychain items, and flags risks such as a token inside a remote URL, a key without a passphrase, or a token stored in plain text. It never shows a value and never changes anything; where it is safe, a finding offers a fix command to copy. Agents can query the names and findings over MCP.
- Channels: an `.html` file a pane attaches is sent as an A4 PDF, and every attachment goes with a report card (title and one-line summary); a reply to a card tells the pane which report you mean. A pane can send its workspace's plan documents.
- Channels: a reply longer than three messages goes as one preview plus the whole text as a Markdown file, where the platform takes files.
- Settings → Channels lists each bot's chats and the panes bound to each: jump to a pane, unbind one or several after one confirmation, and clear bindings whose pane is gone. In a group without topics each child pane's name carries a colour square, and the chat is told once that turning topics on gives each child its own.
- MCP: `cli_reclaim_agent` releases a finished pane by the same targets `cli_close_agent` takes, and reports the guard's reason when it refuses.
- Text cut off with an ellipsis shows in full on hover or focus across the app.

### Changed

- Memory (CLAUDE.md, AGENTS.md and other instruction files) is no longer synced; cloud sync covers prompts, skills and MCP. Local files and copies already on the server are left untouched, and settings bundles still export and import memory. A memory or credentials switch left on by an older build can only be turned off.
- Saving a prompt, MCP server or skill now syncs it shortly afterwards instead of on the next connect.
- A pane can attach hidden files and files outside its workspace, including files you dropped into Navide. Credential folders and files stay refused on every platform: `~/.ssh`, `~/.aws`, `~/.config/gh`, GnuPG, Kubernetes, Docker, keyrings, `.git-credentials`, the CLIs' `auth.json` and `.credentials*`, Navide's account slots, and Navide's own data folder apart from received attachments, PDFs and dropped files.
- `workspace_open` waits up to 15 s for its window and reports `ready`; `cli_open_agent` aimed at a workspace whose window is not ready answers `window_not_ready` at once instead of waiting 40 s; a `~/…` path is expanded first. `workspace_list` includes workspaces opened this way.
- The memory advisory shown when opening a pane counts only running CLI panes, not restore placeholders.

### Fixed

- Cloud sync: a replayed older record can no longer roll an item back or delete one re-created since; a different account starts every scope over (also when switched while Navide was closed) and a locked keychain is not mistaken for a sign-out; a record's origin is checked before it is applied; one item that cannot land no longer holds back its whole scope; skills keep their executable bit and new prompts get ids that cannot collide across devices.
- Settings → Sync names the account it syncs with, lists each scope's outcome after Sync now, and in an MCP conflict says which hidden env and header values differ.
- Unattended self-evolution runs no longer stop to ask a question; an idle run is nudged after 10 minutes and always reports back.
- A Claude pane that finished its turn stays finished: the idle notification Claude sends about a minute later no longer makes `cli_get_status` report it as active, or holds its queued messages for up to 2 minutes.
- Windows: a synced skill can no longer place files outside itself through drive paths, alternate data streams or device names (including `COM¹` and `con .txt`); ordinary names such as `aux.c` still install on macOS and Linux. A `~` workspace path resolves the same way as an absolute one.
- Saving an instruction file kept as a symlink (for example into a dotfiles repo) writes through the link instead of replacing it; a dangling link is refused.
- The Plans view is no longer withdrawn when one of its calls fails while the view itself is closing.

## [0.2.17] — 2026-10-08 — signed release

### Fixed

- The backend no longer stops itself when a check on Navide's process fails momentarily; an unreadable process identity is treated as unknown, not as Navide having quit.
- Backend shutdown is bounded to 3 seconds, so long-polling hook connections can no longer keep a stopped backend alive without a listener.
- After 3 failed reconnects the window asks Navide for the backend's current address and reconnects there instead of retrying a dead port.
- Backend lifecycle events (ready, failed to start, crash, automatic and manual restarts) are written to main.log.

### Changed

- The sidebar's self-evolution badge shows only ✦, coloured by state, with the state in its tooltip and accessible label.

## [0.2.16] — 2026-10-08 — signed release

### Added

- **Pipeline graph editor**: the Pipeline Manager is a full-window workspace, and a pipeline's detail view edits it as swimlanes (layers as columns) or on a free canvas, sharing one undo history. Steps can run side by side and join, approval gates hold the hand-off until passed or rejected, a reject loop goes back at most its retry limit (editable on the canvas, 1–10), a pinned step reuses its frozen output, and a run can restart from any node. The palette, inspector (step settings, upstream outputs, `{{prev.summary}}`, live view, pin and rerun), executions view, zoom controls and a run-coloured minimap come with it, and every view shows the live run with a direct Review for a waiting gate. MCP gains `pipeline_graph`, `pipeline_gate` and `pipeline_restart_from`.
- **Role step fields**: the Roles tab edits the settings fields a role shows in a pipeline step (names, types, defaults, choices and show/hide rules), with problems shown beside the field before Save.
- **Files in chats**: Telegram, Discord and Slack attachments sent to a pane are downloaded into the workspace's media folder and announced to the pane with their path; a pane can send files back with `---ATTACH--- <path>` lines in its MSG block, limited to its workspace or the attachments it received, never hidden files or keys. Files over 20 MB are refused, a failed download is reported and the text is still delivered. Matrix, Mattermost, Feishu, DingTalk and iMessage reply that media is not supported yet.
- **Reply quotes**: replying to a message in Telegram or Discord shows the pane the quoted message and its sender above your text, only for trusted authors, cut at 500 characters.
- **Resume interrupted panes on relaunch**: panes that were running a turn or waiting on a prompt, and the parents waiting on them, come back by themselves after a restart (up to 6, two at a time) without continuing on their own, and each parent is told which children came back. The rest are marked "Working at restart". Settings → General can turn it off.
- **Claude accounts on their own config dir**: a Claude account can sign in once inside its own config folder, so panes can run on different accounts at once. The quota badge picks the account new panes start on, Continue moves one pane onto another account with `--resume`, and these accounts are measured individually. Navide never reads or copies the token.
- **Workspace self-evolution** (off by default): a per-workspace panel, opened from a badge on the sidebar's workspace heading, runs a daily job that opens a pane to review the repository, fix small bugs in a worktree and commit them to the local main branch without pushing, and write everything else as proposals. Runs per day, time and token budget are capped, and every step is announced. System-owned jobs show read-only in the Schedule panel.
- **`cli_answer_prompt`**: an agent can answer another pane's permission prompt or menu, bound to the exact prompt `cli_get_status` reported. Navide Guard vetoes approving high/critical prompts, and every answer is disclosed and audited.
- **`ui.pane.reclaim`**: an agent can release finished panes through `ui_invoke`, with the status bar's guards, and is told why any pane was refused.
- Stage tabs show their pane count as live / total.
- Skills can be dragged into order in Settings → Prompts.

### Changed

- `workspace_open` and other global UI requests go to the most recently focused main window that can answer them, and report at once when there is none, instead of timing out after 15 s.
- A main, detached-group, Plans or Token Monitor window whose page process dies is logged and reloaded (at most 3 times a minute), reconnecting its panes instead of staying blank.

### Fixed

- A relaunch no longer files other workspaces' tab groups into the workspace on screen as empty `Run N` tabs.
- A Claude account-dir login that a pane found expired stops counting as signed in, so new panes fall back to the current account; deleting an account removes its config-dir login and is refused while panes still use it.
- A message relayed to another device is always answered and settled on the sending side, instead of sitting on queued or failing after 30 minutes.
- Pipelines: a run aborted at a gate resumes by waiting on that gate, a run that loses every slot closes its nodes, a gate before the first stage is waited on, failed node output reports are resent, and a refused graph edit rolls back to the saved graph.
- Chat attachments: path rules hold on Windows and case-insensitively, a file is rechecked while open, and a download's error body and total time are capped.
- A new pane's first instruction is not sent before the CLI has drawn its screen, and a kickoff left unsent in the composer is submitted.
- Windows: already-correct shared and skills links are recognized instead of rebuilt, and window focus order no longer ties on the coarse clock.
- The mini-IDE ships each Monaco language worker once, and public `glab` runs no longer check for updates.

## [0.2.15] — 2026-10-06 — signed release

### Added

- **First-run tour**: a fresh install is walked through its first steps by a small bubble beside the real control, one action at a time: pick a workspace folder on Welcome, press + to open an agent, give it a first instruction, hand another pane a task with @, drag one pane into another, and check the account and quota on the quota badge. A grey mask covers the rest of the window so a stray click cannot end it; each bubble stays until its step is done or you press Next, and the last step always shows and waits for Done. Existing installs never get it on their own; Help → First-Run Tour… replays it, also from Welcome.
- **Chat quick menu**: `/menu` (or a bare `/start`) in a bound Telegram, Discord or Slack chat shows the pane's prompts and skills as buttons; a press sends that item to the pane once. Unbound chats, offline panes and expired menus get a reply saying why.
- **Create a Telegram bot in one step**: a connected Telegram bot with Bot Management Mode on gets "Create a new bot" in Settings → Channels. After you confirm what it does, a prefilled Telegram link opens; once you create the bot there, Navide adds it and opens its link guide. Other Telegram bots explain how to turn the mode on.
- **Quick add a bot**: adding a new bot in Settings → Channels checks its credential, starts it and opens its link guide in one go, and keeps the bot only once the platform accepts the credential. A button fills the token from the clipboard when it matches the expected shape, and the Slack form links an app manifest template.
- **Embedded AI panels act like panes**: the AI panel in the Pipeline Manager, Plan, Git and Editor windows records its history, can be messaged by other panes (where its window can deliver messages), and shows which window it lives in, in the @-mention menu, Agent History, the close-workspace confirmation and its own header. Closing the window ends its panel, and a panel resumes its session after Navide quits and restarts. `cli_list_targets` and `cli_whoami` report a panel's `surface` and `window_kind`.
- Settings → Extensions lists the bundled Plans extension and shows the files each extension declares it reads and writes; Plans also says that its backend runs without a sandbox and which plan folders it reaches. Extension manifests can declare these file scopes (`permissions.scopes.fs`) as a disclosure; they never grant or limit access.

### Changed

- **Plans reads and writes plan files itself**: the Plans backend opens and saves plan files directly, under the same path checks Navide applies, instead of relaying every file through the app. Every access is still authorized by Navide per request, so an agent's Execution Policy and the Plans grant keep applying. The Plans list sends only the fields the view shows, so large libraries load faster.
- The builtin prompt a fresh install starts with is known to the backend from the start, so agents and `/menu` see it before the Prompts page is saved.
- Chat connections retry 5 s after a drop instead of 30 s; Telegram restarts its backoff after a successful poll, and a connection that drops right after it connects keeps backing off instead of retrying at the shortest delay.
- The running status message in a chat no longer counts seconds; the final "done" message keeps them.
- A message delivered to a busy embedded AI panel is reported as delivered while busy, and the message log notes it.
- Repository hooks run the CI secret scan (gitleaks) before a commit and before a push.

### Fixed

- **Chat confirmation buttons finish cleanly**: a prompt answered at the computer or in the chat, replaced by a newer one, outlived by its turn, timed out, or left by a pane that went offline is edited to say so and loses its buttons, instead of answering "this confirmation has expired" when pressed.
- **Schedules follow a rebuilt pane**: a job aimed at a pane that was rebuilt into the same session moves to the new pane. A job whose target stays gone for three runs in a row is turned off, shown in red in the Schedule panel, and you are told about it. "Retarget" is now "Rebind".
- A CLI whose credential store no pane has verified yet (kilo, opencode) shows "open a pane" instead of an error, and is no longer polled or warned about every five minutes.
- A first-party extension backend that fails restarts with backoff instead of staying down, with its own restart budget per window. Plans is marked available again once its backend is back, and when a workspace's agent Plans backend gives up, a notice names the folder and says how to restart it (open Plans there, or restart Navide).
- Plans keeps the reason a file operation failed instead of showing "Plugin request failed.", lists a plan folder it cannot read as unreadable instead of dropping its plans, and a retry is no longer undone by a call still running on the discarded backend.
- Concurrent writes to one file are serialised across processes, a held write lock fails the write after 10 s instead of hanging, and a failed upload part reports its real error.
- **Quitting**: a quit cancelled while windows close, or refused by a window, brings the backend, extension backends and window services back and lifts the shutdown screen; an abandoned update install no longer leaves the app thinking it is quitting; and closing a window again ends its embedded AI panels afterwards.
- Embedded AI panels: Stop or a clean `/exit` retires the panel's restore record instead of relaunching it next time, a panel whose extension was removed is ended, a refused roster registration is retried and explained, and one failed kill no longer leaves a window's other panels running.
- MCP calls into an extension backend wait past the Host's own deadline, so you see the Host's timeout error instead of a generic "did not answer", and requests the Host cannot serve are answered right away instead of timing out after 30 s.
- **Windows: messages in Chinese reach Claude panes intact**: a multi-line message to an idle Claude pane no longer arrives as `System.Object[]`, and non-ASCII text sent to an idle or busy pane is no longer garbled on a non-UTF-8 console (#147).
- **Git keeps working on partial status**: a failed or truncated status read no longer shows a clean repo, a fake "not a repo", or reports an unstage as done; discarding changes refuses instead of acting on an incomplete list, and the Git pane says when its list is truncated (#144).
- Account detection retries an unreadable or half-written identity instead of recording you as signed out, and the credential and Git watchers keep running after a failure and log it (#144).
- Plans: a plan too large to fit one list page keeps its archive state and actions instead of being offered "Upgrade".
- Quick add removes a bot it could not finish adding, including when the window closes mid-way or the 30 s limit runs out, and refuses a second quick add for the same bot. Creating a managed Telegram bot is refused up front when nobody is linked to the managing bot, and answered at once when its creator is not linked.
- A Telegram group that is not a forum is no longer asked for child topics on every new child pane; it is asked again after 30 minutes, so turning topics on later takes effect without restarting Navide. Channels also applies its reconnect backoff to reconnect requests and logs a failing background task.
- A schedule rebound to a rebuilt pane clears its red "target gone" marks, and asks to be switched back on only while it is still off.
- Usage polling fails only the vendor whose credential store cannot be read, instead of stopping the whole cycle.
- Windows hooks use a random temp file name, so leftover files can no longer silence every hook.
- Quitting Navide no longer hangs at 100% CPU while it closes the terminals.
- When a CLI exits on its own, its child processes, such as MCP servers, are cleaned up even when its terminal closes before the CLI has finished exiting.
- A pane whose session the server already dropped is no longer retried and warned about on every sweep.
- Security updates: tinypool, vue (@vue/server-renderer), source-map-js, dompurify and katex.
- `cli_send` to a chat sender tells the agent to reply with an MSG block instead of failing with an unknown target.
- Help covers voice input, Channels, Guard, the CLI Agents card grid and the other surfaces added since 0.2.10.

## [0.2.14] — 2026-10-02 — signed release

### Added

- **Third-party native backends, off by default**: an extension may ship its own backend program. It runs only after you turn on Settings → Extensions → native backends and approve that exact package version, inside a sandbox (Seatbelt on macOS, bubblewrap on Linux) with no network and write access limited to its own data folder. Any changed file asks again; Windows reports it as not supported yet.
- **Marketplace ratings and reports**: signed-in members can rate an extension and report one for review; the registry website gets a shared look and admin status bars.
- **`navide-plugin` publishing workflow**: the SDK CLI covers the whole path from a new project to a published, signed release, and a backend can declare the methods and events it serves.
- **Channel binding asks first**: picking a chat opens a confirmation step that shows what the chat will receive, with the current choice clearly marked; Connect binds with that level.
- **Several bots per platform**: Settings → Channels can add, rename and remove more than one bot for the same platform. Each bot keeps its own allowlist, pairing requests and link codes, and the bind menu groups chats by bot. Existing bots carry over as the main bot without signing in again.

### Changed

- CI runs a deterministic CLI regression suite against every supported agent CLI on macOS, Linux and Windows, and the merge gate now requires every job to pass (#140).
- The sidebar's workspace headings show live panes over total panes.
- Linux falls back to a basic password store when no unlocked keyring is available, and waits up to 120 s for the backend on first start.

### Fixed

- **Navide Guard on Windows**: the Claude Code (2.1.139 and later) and Codex guard hooks no longer start PowerShell, whose cold start could pass the 10 s hook timeout and let a denied command run; older Claude Code builds keep the previous hook.
- Guard closes several ways a heredoc, a here-string or a `#` could hide a later command, decides without waiting on the database lock, and keeps its rules current while they change.
- Windows: saving to the local database no longer stalls when an antivirus scans its journal file, and a burst of file changes is recorded in one write instead of one per file.
- **Windows hooks with a non-ASCII user folder**: Guard and the Claude Code and Codex hooks call the system curl by full path. A Git or MSYS2 curl earlier on PATH read a folder name such as `C:\Users\使用者` as `???` and never sent the request, so Guard got no decision.
- A pane answering a chat with an MSG block addressed to the sender now reaches the chat with just that text; it is no longer reported to the pane as an unknown target.
- Huge untracked trees no longer stall Git status, and status reads and change notifications stay bounded on very large repositories (#144).
- macOS: the backend no longer grows its memory with every file change on disk. The file watchers stopped retaining each filesystem event, and account detection now checks the CLI credential files themselves instead of watching your whole home folder (#144).
- Keychain secrets that look like hex, or contain non-ASCII characters, are read back exactly.
- The pane overview counts panes on offline devices as not opened.
- Onboarding no longer offers to install tools it already found.
- A Channels confirmation prompt that fails to reach the chat is retried; turning third-party backends off always stops them, even if the setting cannot be saved.
- **Answering CLI questions from a chat no longer gets stuck**: a wrong option number or a stale screen keeps the question answerable; each new question or permission prompt is posted in turn, including after the previous answer or an expired one; a bare `1`, `yes` or `no` answers the only open prompt, and other text gets an immediate hint instead of waiting in a queue; multi-select and free-text choices, and CLIs Navide cannot answer for, ask you to answer at the computer instead of showing buttons that do nothing; a plain question at the end of a turn no longer adds a misleading "needs confirmation" message.
- Tokens from a resumed session are attributed to the pane that ran them.
- A CLI that leaves a child process holding its output no longer hangs the check Navide runs before opening a pane, and the leftover process is cleaned up (#143).
- Droid sessions on Windows are found in the folder Droid actually uses (#142).
- Codex panes keep their session after the first poll, Droid sessions are attributed to the pane and workspace that ran them, Windows stops a process tree even when its root has already exited, and shutting down waits for pending pane registry writes before closing the database (#140).
- A Codex pane on Windows that has to start through a `.cmd` shim (one Navide cannot run through node directly) no longer exits with "The system cannot find the path specified." before Codex runs (#145).
- The AI CLI panel in the Git and Plans sidebars starts its CLI again: Codex (since 0.2.4) and other CLIs that Navide adds launch options to failed to start there, and on Windows the mini-IDE AI panel could not start any CLI (#146).
- The macOS installer window no longer shows `.background.tiff` and `.VolumeIcon.icns` above the Navide → Applications layout when Finder is set to show hidden files.
- Security updates: pyjwt.

## [0.2.13] — 2026-09-30 — signed release

### Added

- **Marketplace for third-party extensions**: a Discover page, a publisher self-service flow (sign in, claim a namespace, verify a domain by DNS, publish from the CLI), review before listing with secret scanning, name-similarity and blocklist checks, a pre-release channel you can opt into per extension, and extension packs that install a set of extensions together. `navide://` links open an extension's page in the app; installing always needs your confirmation.
- **Channel monitor**: a titlebar button with a status dot opens a window listing every pane bound to a chat, where you can jump to the pane or disconnect it. Automatic child topics are grouped under their parent binding.
- Workspace headings in the sidebar show live panes over total panes.
- **Channels two-way mirror**: a pane bound to a chat can mirror its activity there, and replies in the chat come back to the pane. A child pane opens its own topic under the parent's chat, and moving a pane to another chat moves its child topics with it.
- **Choose what a chat receives when you bind**: the bind dialog asks for a mirror level first, with a line on what each one sends. "Chat replies only" is preselected and sends nothing typed locally; Standard, Minimal and Full add local activity step by step. Bindings made before this release stay at chat replies only. Redaction only masks the channel's own bot credentials, and the dialog says so.
- The Plan window can open on one document via `ui.window.openPlans`.
- Voice settings show the model and the engine as separate status rows.

### Fixed

- Plans lists, opens and saves documents of any size, including plans heavy in CJK text, which used to fail to save above about 85,000 characters.
- Voice input pre-warms on connect and after the model downloads, so the first take shows live partials instead of cold-starting mid-take.
- Git remote operations get the time they need instead of timing out after 10 seconds and closing the credential prompt while you type.
- Opening a file from the terminal file picker or the mini-IDE says so when it fails, and the mini-IDE no longer opens duplicate tabs for one file.
- `Ctrl+C`, `Ctrl+\` and `Ctrl+Z` work in panes even when the backend was started in the background.
- On Windows, the backend exits promptly when the app closes instead of waiting up to about 15 seconds for an MCP server to start.
- A staging file swapped for a symlink during a chunked write is refused on every platform.
- Marketplace review signs only the artifacts the reviewer saw and refuses a decision that lost a race with another reviewer; uninstalling a pack never removes a member another installed pack still uses.
- Long mirrored messages are no longer split into a tiny first chunk.
- Dependency updates: electron 44.4.5, koffi 3.3.1, html-to-text 10, anthropic 1.8.0, and security fixes for pyjwt, brace-expansion and fast-uri.

## [0.2.12] — 2026-09-28 — signed release

### Added

- **Channels one-click account linking**: once a bot is connected, a guide under each platform links your own chat account without a pairing code to approve — open a Telegram DM, add the bot to a group or server, open a Slack DM, or get a one-time code to send to the bot (iMessage included). The code works once within 10 minutes; when it expires, when the link fails to save, or when the backend connection drops, the guide ends the wait and says why, and the bot replies in the chat if the link could not be saved. Each guide only reacts to its own code, so two guides open on the same platform no longer both report "linked".
- **Sidebar Workspace / Free modes**: Workspace groups agents under their workspace as before; Free lists every agent in one flat list, shows every pane on the stage, and focusing a pane from the sidebar no longer switches workspace. The choice is stored per user and windows that are already open follow it live (detached windows stay in Workspace). In Free mode, closing, rebuilding or reclaiming a tab still only acts on the current workspace's panes and now says how many panes from other workspaces were left alone. The header ＋ sits at the far right and, with no workspace open, opens the workspace picker. In Free mode each agent sits in its own outlined card and shows its workspace (parent/name) under its name, and in both modes an agent's name keeps its width instead of being cut short alongside the vendor label.
- **Extension rollback**: Settings → Extensions can roll an installed extension back to the package it displaced, offer the restart that finishes it, and show the host's own message, translated, when a rollback is refused or fails; a failed rollback restores the views it drained.

### Changed

- A pipeline run keeps at most two stages of CLIs alive at a time, so long pipelines use less memory.

### Fixed

- Display GitHub-generated release notes as readable text in the updater instead of exposing their HTML markup, including notes whose code spans contain comments.
- Closing a pane on Windows no longer reads the whole process table once per process, which could take several seconds with many processes running.
- A database write whose COMMIT fails now rolls back and releases the write lock, and keeps the original error if the rollback also fails.
- Background jobs started from worker threads write to the right data directory.
- The What's New tour closes the Settings window it opened and returns focus when it ends, and Help → What's New says so when there are no notes to show.
- Release workflow: the mirror is verified before the updater feed points at it, and re-running an old tag's release no longer moves Latest or replaces a published release's update files.

## [0.2.11] — 2026-09-27 — signed release

### Fixed

- **Channels works in the installed app.** 0.2.10 left every chat adapter (Telegram, Discord, Slack, Feishu, DingTalk, Matrix, Mattermost, iMessage) out of the packaged backend, so setting up any chat failed with "adapter is not available in this build"; development builds were not affected. The packaged backend now includes them, and a test keeps the packaging list in step with the supported platforms.
- The other modules the backend loads by name (the CLI log readers, the web server's auto-selected protocols, the async backend and the Windows time-zone data) are now listed explicitly in the packaging spec with tests, so they can no longer drop out of a build unnoticed. They were already included in 0.2.10.

## [0.2.10] — 2026-09-27 — signed release

### Highlights

- **Channels**: bridge chat apps to CLI panes, so you can talk to an agent from your phone. A chat binds to one pane, bind and unbind are announced in the chat, seen chats persist, and a permanent "don't ask again" option is never pressed from chat. Requests approved from a chat are still gated by Navide Guard: anything graded high or critical is refused.
- **Voice input**: hold a key to dictate into any pane, transcribed locally by whisper — no audio leaves the machine. Live partials while you speak, insert without sending or press Enter during a take to finish it and send (the capsule says so if the pane could not press Enter), hands-free mode, microphone choice with silent-microphone detection, and Chinese converted to Traditional (Taiwan) by default. The shortcut is recorded in place on **Settings → Voice Input**: a chord, a single key such as F13 or a lone Right Option, a lone ⌘ or ⌃ (started after a short solo hold, so ⌘ shortcuts still work), or on macOS the fn (🌐) key through a small listen-only helper that needs Input Monitoring. In toggle mode a ⌘ chord is accepted too; a shortcut that collides with a Navide command or a macOS shortcut is refused by name, with free alternatives suggested, and the recorder explains every press it cannot use. Long takes stay responsive: a stalled decode is cancelled so partials keep coming, and dropped or repeated phrases went to zero in testing. Microphone errors name the device.

### Added

- After updating, the What's New popup can carry a guided tour of the release: it asks **Take the tour / Not now**, and the tour dims the window and points at each new piece of UI in turn (→ / Enter, ←, Esc; a step whose target is not on screen says where to find it instead). 0.2.10 introduces Channels and Voice Input as two feature cards with a six-step tour. **Help → What's New…** reopens the current release's announcement, and a release row in the status-bar announcement centre offers the same tour. A tour is part of its version's announcement entry; see `docs/en-US/release-announcements.md`, and `release.sh` warns when the version being released has no entry.
- **Navide Guard**: a deterministic gate (fixed code, never an AI) that grades each risky CLI action as critical, high or normal and handles it by where the request came from — you at this computer, a chat app, another pane or device, or a pane that has taken in outside content. Chat-approved requests are always refused at high and above, and a tainted pane is always asked. The pane header shows a taint badge with a log of what was delivered to it. **Settings → Security → Navide Guard** lists the built-in rules with their default level and lets you raise, lower or turn them off, add custom rules at a chosen level, allow exceptions and edit the protected branches; loosening anything needs a confirmation, and eight floor rules (credentials, Keychain, download-and-run, deleting root or home, raw disk writes and formatting) can go no lower than high.
- **Terminal command protection**: plain terminal panes refuse destructive commands such as `rm -rf /`, `Remove-Item -Recurse -Force C:\` or `format C:`, reading each line as every shell would. **Settings → Security** shows the categories, custom block patterns, allow exceptions and a test box.
- MCP can open and drive plain terminal panes (`cli_open_agent` with a shell), with one Enter per line, a check that the shell is at its prompt where the platform supports it, and refusal of multi-line input the shell cannot take as one paste.
- **Marketplace**: packaged builds use the official registry at `server.navide.dev/registry`, with browse and detail pages, per-platform plugin packages, Windows `.exe` plugin backends and update reminders.
- An agent must get your approval in the main window before it installs a skill; the MCP tool only files the request.
- Scheduler jobs record which agent created them; an agent may change only its own jobs, and the number of jobs one agent owns is limited. The Tasker panel shows owners and limits.
- Cast a prompt skill into a running loop without breaking it.
- CLI risk: analyze a pane's risk signals with a CLI, attribute network signals to processes, and keep an observation log.
- Per-pane git snapshot (branch, drift, dirty state) in the roster and the network view.
- Skills too large for one sync record sync their files separately once the server supports it; until then the Skills switch keeps syncing settings only, as before. Install size limits are now separate from sync limits.
- One right-click menu for stage tabs and sidebar group headings; the subtree summary sits under the status badge.
- Onboarding and CLI management run every install, update and doctor in an embedded terminal inside Navide, and Windows installs use each vendor's official command.
- Stage verified Manifest v2 updates as immutable candidates and expose an explicit Restart Plugin activation flow. Candidate frontend views preflight hidden with no capability context; backend health and current trust are checked before activation, while restart drains and restores only the selected plugin.
- Build official Manifest v2 plugin artifacts from explicit canonical file lists, with deterministic ZIP metadata, target-specific backend validation, detached archive-signature tooling, and clean versioned factory resources.
- Add public, Host-validated plugin window requests and typed editor, Git, account, and Issue capability adapters for the ongoing miniIDE migration. Window targets retain caller/receiver authority separation; missing IDE assets no longer silently open files in the OS default editor.

### Changed

- Terminal panes stay RUNNING while Claude background tasks are live, with a 30-minute fuse.
- Polish the per-turn usage modal layout and the ∞ skill-picker ring.
- Deflate official plugin artifacts, keeping the archive deterministic for a canonical file list; the mini-IDE package drops from about 29 MB to about 7 MB.
- Require a Host-observed user gesture for the public `ui.openExternal` capability: the plugin preload marks a trusted pointer or key event from the last five seconds, and agent- or backend-initiated calls are refused with `USER_CANCELLED`.
- Mount plugin views inside the Mini IDE instead of bundling a copy of them; a mounted view now receives the workspace it was opened for and can call the Host, so it renders instead of showing an empty pane. The activity column continues with one entry per left contribution the Host catalogued for the installed extensions, drawn with the icon the extension declares, and mounts the one you pick; a view that cannot be mounted says so in place rather than leaving an empty pane. The IDE contains no Git or Plans code at all — about twenty duplicated Git UI files are gone — and **file diffs and branch comparisons now open in the Git window**, which owns those surfaces.
- Compose plugin views end to end: a mounted view receives the workspace it was opened for, can call the Host, opens its own detail views there (including a target such as a branch comparison), and takes part in close preparation — and a close or quit refused during that preparation now says so instead of appearing to hang.
- Keep a plugin window usable after **Reload Window**: the reloaded receiver registers in the document that replaces the old one, so its composition still works, while offers, acknowledgements and close requests from the replaced document stay refused.
- Keep file launching, keybinding writes and Git account management (`ui.openPath`, `ui.openTempFile`, `ui.writeKeybindings` and the Git account capabilities) for first-party plugins only: a third-party plugin granted `ui` could otherwise launch any program by opening a temporary `.bat` file. The built-in Mini-IDE, Git and Plans are unaffected.

### Fixed

- The tab-group icon buttons (add, rebuild all, collapse families) are the same size again; the rebuild icon is no longer squeezed.
- `cli_send_and_wait` no longer reports a turn that ended right at the deadline, or a reply recorded in the same clock tick on Windows, as `never_started` — for local and cross-device targets — so callers are not led to resend.
- On Windows, the temporary audio of a cancelled dictation is deleted even when another process briefly holds it open, and leftovers are swept on the next start.
- Voice dictation stays responsive on long takes: the streaming window no longer grows past its cap after a late boundary, a partial whose decode stalls is cancelled so later partials keep coming, and forced cuts no longer rely on stretched timestamps. Dropped phrases and repeated fragments went to zero in testing, and release-to-final latency dropped (p90 about 1.1 s → 0.3 s).
- Guard and terminal protection classify Windows paths and command spellings (case, `C:/` vs `C:\`, escape characters) that were previously never gated, and close fail-open paths.
- Windows fixes for pane git snapshots, recycled process ids, skill executable flags across devices and voice tests.
- Install, update and doctor runs no longer fail silently: a run that could not start says why, closing Settings mid-start no longer leaves an orphaned run, Cancel can be retried, keystrokes that did not reach the embedded terminal are flagged, and a refused install shows the backend's reason.
- On Windows, a successful install is no longer reported as failed because an installer's inner command left a non-zero exit code.
- A previously chosen CLI binary that can no longer be used is reported instead of being dropped silently.
- An agent's file write no longer shows up twice in the preview feed when the tool runs late (for example after a permission prompt or on a busy machine).
- Keep the embedded Git left surface usable when no detail receiver is paired: file and conflict requests fall back to the existing Host routes instead of silently doing nothing, and a refused detail request now reports the failure.
- Keep installing Manifest v1 packages through the legacy mutable path; Manifest v2 installs continue to stage an immutable candidate for the next restart.
- Deliver Mini-IDE AI terminal output to its embedded view, and hide a stale Git or Plans sidebar when returning to Explorer.
- Let verified pre-staging Registry plugins upgrade to immutable v2 packages without losing their rollback grant; keep factory installs with no prior grant restartable, and release frontend restart barriers after backend-only rollback or a failed promotion.
- Restore older Mini-IDE AI terminals recorded with the `editor` origin, including workspaces opened through symlinks, without relaxing profile, workspace, or unrelated-origin checks.
- Serialize plugin window close, reload, and quit preparation and report refused or failed closes; keep receiver registrations on cancelled navigation and retire them only after a new document commits.
- Consume a trusted `ui.openExternal` gesture only once, and keep public Issue provider commands within one request deadline so a late repository probe cannot start a mutation after timeout.
- The fn (🌐) helper reports a failed start, a failed or timed-out permission request and a refused subscription in the Voice Input settings, with Try again, instead of staying on "starting".

## [0.2.9] — 2026-09-23 — signed release

### Changed

- Show the **Schedule** tab as one timeline instead of stacked sections: items with an exact next run in time order, then fixed-interval items (launchd `StartInterval`, every-minute cron) from the shortest interval to the longest, each labelled with its interval rather than a made-up time, then on-demand and disabled items, both collapsed by default. A summary row counts failures and can filter to them, crontab lines read as plain words, removal moves into each row's ⋯ menu, and a load error becomes an inline note with a retry. On Windows the tab lists only Navide's own jobs; Navide never creates OS scheduled jobs.
- The quota-exhausted badge and the loop-paused notice show the date when the reset is not today (for example "back 9/28 01:46"), so a weekly reset no longer reads as minutes away.
- Align CLI menu, installer, Plans and Help labels with reviewed official product names and selected publisher suffixes, including Grok Build (SpaceXAI), while preserving vendor order, commands and existing pane names.
- Use the app's font in pane context menus so detached menu rendering does not fall back to a browser serif font.
- Keep destructive project-menu actions readable with a transparent default background, subtle danger color on hover or focus, and a visible keyboard focus outline, while preserving the existing close actions and confirmations.
- Move the language picker from Appearance to its own **Settings → Language** page. Settings search opens the new page, and the language preference still applies to every workspace.
- Replace repeated agent lists in **Settings → CLI Agents** with searchable, filterable cards and a single-agent settings drawer. Cards retain enable controls and drag ordering through the grip to the left of each title; Overview, Launch, Permissions, Push, and Install are stacked on one scrolling drawer page, preserving automatic setting persistence and closing before Settings when Escape is pressed.
- Show the status bar resource pill as live panes over all panes (`▤ 10 / 100`), so idle-reclaimed placeholders no longer read as open windows; help examples updated in all three locales.

### Added

- Name every CLI account, the built-in Default included, from its card in **Settings → Accounts** or from a row of the quota badge's account list; clearing the field restores the generated name. The name leads in the pane header, the account list, the cards, switch notices and Turn Stats, with the signed-in identity kept beside it. The pane header's quota badge now carries that account in its own section before the percentage — your name, or the part of the email before `@` — falling back to the number alone when an account has no name, no identity and no sibling account to be told apart from. Only the figure takes the warning and out-of-quota colours; the badge stays dashed while a reading is in flight, and a narrow pane shortens the name to its first character. The figure still belongs to the CLI's current account, not necessarily the one an older pane is running on.
- Add optional `run_group_id` to `cli_open_agent` for selecting an existing tab group or the manual tab when opening a fresh or resumed conversation, while preserving default group inheritance and session restoration.
- Make account quota history available without open panes, with evidence and local coverage details, stable cycle selection, bounded date ranges and paging, UTC calendar summaries, and full-range CSV exports. Missing token details remain gaps rather than zeros; completed-cycle averages require trusted limit evidence and available detail. Ambiguous weekly CLI clocks no longer invent a dated reset for ledger attribution.
- Add Japanese interface support, including persisted language selection, onboarding, native Navide menu labels, Plans and Token Monitor windows, and plugin locale propagation. Keep the existing Traditional Chinese fallback, pass the skipped-workspace count to its notice title, and format the audited date displays using the selected interface language.
- Add a triangle button after refresh to collapse or expand all eligible descendant-card families in the current tab in Auto, Spotlight, and Fullscreen. Mixed states collapse all; expansion opens nested families too. Parent cards, descendant counts, and the main terminal remain visible, other tabs keep their own state, and Grid or tabs without eligible families disable the button.
- Add backend-owned CLI risk observations in active pane headers: sampled unexpected TCP addresses and newly observed large opaque files, with observed absence/reappearance evidence, persistent Ignore/Allow exact-IP decisions and Reveal in folder. Coverage depends on vendor/platform support; stale or unavailable observations do not imply safety, and no automatic blocking or deletion occurs. Addresses in the published Cloudflare and Fastly ranges (shipped with the app, never fetched at runtime) are still recorded and labelled as a shared CDN but do not light the pill; **Settings → CLI Agents** lists those ranges and lets you add, disable or delete them (built-in ranges can be disabled, not deleted). General clouds such as AWS, GCP and Azure are not on that list. A CLI's loopback calls to Navide's own backend are not flagged, and Mach-O and PE executables are recognised alongside ELF.
- Add **Reclaim selected** and selection-wide notification mute/unmute to the multi-pane context menu, with grouped actions. Reclaim keeps existing protection checks, affects only eligible selected panes, and is disabled when none are eligible; muting a mixed selection mutes all of it.
- Add a Skills MCP workflow for inspection, bounded previews, add-only installation from local packages or public GitHub, and revision-checked delivery settings. Caller-bound previews pin exact content; local provenance survives restart, and delivery responses distinguish configuration from unknown current-session loading. Skills views refresh after committed changes and reconnects while retaining unsaved content and its original revision.
- Schedule work for a CLI pane from the **Schedule** tab (🗓): a job runs once at a set time (then disables itself) or repeats every N minutes, daily or weekly, and when due wakes the chosen pane — opening it first if it is a reclaimed placeholder — and sends it an instruction through the same delivery path as `cli_send`, so idle and typing holds still apply. Jobs can be run now and enabled or disabled; consecutive failures back off and each job has a daily run cap (24 by default). Six MCP tools (`scheduler_list`, `scheduler_upsert`, `scheduler_remove`, `scheduler_set_enabled`, `scheduler_run_now`, `scheduler_runs`) let an agent schedule work, including waking itself later; an update needs only the fields that change, and omitted fields and policy keys keep their stored values. Jobs fire only while Navide is running; by default a slot missed while it was closed runs once on the next start.
- Add an opt-in setting, off by default, under **Settings → General**: "Resume a loop right after switching when quota runs out". It applies only with account switching set to **Auto switch**: when a looping pane runs out of quota and the automatic switch completes — in place, or by restarting the same conversation, which carries the loop onto the new pane — the loop resumes by itself instead of offering the Continue button. If the switch has not settled within three minutes, the pane falls back to the Continue button. The switching rules themselves are unchanged.
- Add a **Reinstall** button beside Install in **Settings → CLI Agents**.
- Add MiniMax Code (`mcode`) to CLI selection, install detection and sign-in. Session history, resume, token/quota reporting, account switching, MCP and skills wiring remain unsupported.
- Add account switching when a CLI's active account runs out of quota, with an Off / Notify / Auto policy (Notify by default): one announcement per exhaustion lists the other accounts with the reliability of their readings; Auto makes a single attempt with the best candidate, limited to three automatic switches per rolling five hours and ten minutes apart per credential pool, stops the incident on any failure, never switches back by itself, and never re-sends work. Claude Code switches without restarting panes; other CLIs wait until every affected pane is safely idle, then stop, switch and resume each conversation; Aider asks for a new conversation. Account switched, conversation resumed and quota verified are reported separately, and a switch whose record could not be saved blocks further switches until reconciled. All fifteen CLIs declare an adapter with source-level evidence (no real-account round-trip recorded yet; MiniMax Code's is the newest and cannot resume a conversation). Sign-in is isolated for Claude Code, Codex, Grok, Kimi, Pi, Droid and MiniMax Code; the other CLIs sign in against their live store with the active account snapshotted and restored.

### Fixed

- In **Settings → Accounts**, an empty portable credential slot is now a compact **Paste credential** button in the card's action row instead of a full block, and the note that credential cloud sync is off — which pointed to a setting that does not exist yet — is gone.
- Switching to a parked account no longer asks you to sign in just because its saved access token has aged; a sign-in is requested only when the saved snapshot has no refresh token to renew with. The CLI health guide no longer lists Grok's bundled `~/.grok/bin/agent` as a second Cursor install, which kept reopening the guide.
- A long message sent to a focused Claude Code pane, collapsed by Claude Code into `[Pasted text …]`, is no longer reported as delivered when its Enter did not take; it is retried, as it already was in an unfocused pane.
- A "you've hit your limit" message now marks as ran out only the quota cycle whose reset it names, instead of every open cycle of the account, so Turn Stats no longer shows a weekly cycle "ran out" at 9 %. Rows written before this release are left as they are.
- Closing or deleting a tab now affects only the panes of the workspace you are viewing. With several workspaces held in one window, deleting a project's last tab could move same-named-tab panes of the other workspaces to "manual", and closing a tab could close them.
- On Windows, a CLI launch environment variable that differs from a reserved name only in case (for example `minimax_data_dir` or `claude_config_dir`) is now refused and marked in Settings like the upper-case spelling, instead of silently redirecting the pane's data directory. macOS and Linux are unchanged: there those are distinct variables.
- Image, video, audio and PDF previews show a load error instead of an empty pane when the file cannot be fetched.
- The pane-title rename box and the paste-credential field have a background again.
- Make every descendant counted on a parent card reachable in the Auto, Spotlight and Fullscreen pane lists: unfolding a family now also lists descendants that are minimized or live on another tab or project, each with a location hint. Clicking such a row switches project and tab, restores and focuses it like the left agent list; Cmd/Ctrl/Shift-click only selects it without switching or restoring. The bulk collapse/expand button keeps its current-tab scope, and the parent's `↳ n` chip is replaced by a readable summary such as "1 child pane · Running".
- Bind Kilo and OpenCode account operations to the credential store observed after CLI shell startup, preserving HOME/XDG settings. Refuse ambiguous or conflicting account mutations while retaining ordinary CLI execution; login waits until the outgoing credential snapshot is ready.
- Allow the Explorer and HTML preview to read interface prototypes and relative assets in `.agent-team/mockups/`, while preserving filesystem mutation protections and the preview's script-disabled sandbox.
- Stop Codex panes from submitting artificial session-marker turns on launch, fresh rebuild, or fresh restore. Configured prompts remain intact, session identity can arrive after the first real turn, and skills refreshes preserve session/runtime isolation in newly prepared pane homes.
- Keep Skills refreshes in request order and save/conflict state attached to the edited skill when selection changes. Reject local packages with unreadable subdirectories, and include nested `SKILL.md` attachments in shared and native inspection inventories.
- Keep active Antigravity and Grok sessions running when another command merely mentions a resume flag: duplicate detection no longer interprets compound shell commands, other executables or positional text after `--` as a resume request.
- Stop tools launched from a CLI pane on macOS from appearing in the Dock as another running Navide (which looked like the app relaunching in a loop). Every pane now runs under a bundled `Navide Pane` helper that LaunchServices treats as a UI-element application, so anything a pane starts is attributed to it and never gets a Dock tile; the helper forwards signals and exits with the command's status, and `NAVIDE_PANE_HELPER=0` runs panes bare.
- Preserve a pruned history pane's parent when resuming from another workspace only if the parent still exists in the target workspace; missing parents and explicitly recorded roots stay roots.
- Keep project overflow menus within the window and let long menus scroll without closing, so the final actions remain reachable near the bottom edge.
- Block MiniMax Code's legacy `MAVIS_DATA_DIR` data-root override alongside `MINIMAX_DATA_DIR`, including the reserved-variable notice in CLI launch settings.
- Keep CLI completion and message text across incremental updates: Antigravity rechecks assistant rows completed in place, Kimi streaming postpones inferred idle completion and can finish after new assistant content arrives, and Droid retains reply text when its outcome arrives in a later log poll.
- Recognize explicit Antigravity and Grok resume IDs when reaping a duplicate CLI process before replacement, and keep Grok's first session visible outside its per-pane home shim. Grok title-based resume remains outside ID-based duplicate detection.
- Reject Pi resume IDs that exist only in another workspace, where the CLI would otherwise start a new empty conversation. Honor `XDG_DATA_HOME` for OpenCode quota credentials and Kilo account switching and credential watching.
- Scan the Codex session tree once per pass instead of once per pane home: pane homes whose `sessions` is a symlink back to `~/.codex/sessions` no longer re-enumerate the same rollouts. Reclaim `~/.codex-panes/<id>` when its pane is closed or its spawn fails, and sweep leftover homes at backend start; a home that still holds a rollout, that Codex's state database still points at, or that a running process uses as its `CODEX_HOME` is always kept so `codex resume` keeps working (#121).
- Preserve recorded model and effort when resuming a closed pane from Agent History, including when its original pane record has been pruned. Missing fields in older clients no longer erase those recorded choices; legacy records without choices keep the vendor default.

## [0.2.8] — 2026-09-20 — signed release

### Added

- Fold a group and it closes up everything under it, from the sidebar and from the workspace heading. A folded row now stands for the family it hides when you drag it: the hidden descendants travel with it to another tab or another window, instead of the parent moving alone and leaving its children behind. Only the row you grabbed expands into its subtree — other folded rows in a multi-selection still move alone.
- Reclaim a whole project's CLIs at once. Every reclaimable pane in it becomes a click-to-resume placeholder, skipping the focused pane, one awaiting your answer, one holding unsent text and one that cannot be resumed.
- **Navide Cloud**'s pane list is grouped by device, then by state (running / idle / not opened), then by workspace, each group foldable, with a search box over pane, workspace and device names and a height cap so the dialog stops growing with the roster.
- Welcome's **New…** asks for a location and a name and creates that folder, instead of opening a picker and taking whatever it made. A name already taken, no permission to write there, and anything else now come back as their own message.

### Changed

- A group row's fold button appears when the pointer crosses the row, like the ＋ beside it. The workspace heading keeps its buttons visible — a heading is a landmark you aim at, a group row is one of many.

### Fixed

- Closing a claude pane on **macOS and Linux** now sends SIGTERM and waits before the kill, so claude runs its own exit handler. Without that the entry it writes into `~/.claude.json` on a fullscreen start outlived the process; a pane that did not live long enough to clear it — one opened and closed straight away, one ended moments after the app restored it, one taken by idle reclaim or a rebuild — left a strike behind, and two strikes turn claude's fullscreen renderer off. That is what makes the dim row of previous prompts stop appearing when you scroll up. **On Windows this does not apply yet**: the platform has no SIGTERM and Navide's kill path there terminates outright, tracked in [#120](https://github.com/nt-nerdtechnic/Navide/issues/120).
- A pane spawned during a workspace switch no longer files itself under the group of the workspace being left, and saving run groups can no longer write one workspace's groups over another's. If you kept two workspaces in one window on 0.2.7 you may already hold mixed rows: the fix only stops new ones, and `scripts/repair-run-group-ids.py` cleans up what is there (it dry-runs by default, backs the database up before writing, and refuses to run while Navide is open).
- Resuming an old session keeps its place in the pane tree. Pane records are pruned and history is not, so history now carries its own copy of the parent pointer instead of pointing at a record that may be gone.
- A create that has to reap a previous PTY first refuses to start a second CLI when that reap times out, rather than spawning over a process that may still be alive and letting two of them append to one session file.

## [0.2.7] — 2026-09-19 — signed release

### Changed

- The in-app updater now reads its feed from the dl.navide.dev mirror, the same host the website's download buttons use, and falls back to the GitHub Release only when the mirror cannot be reached on the network. Until now it was the other way round. The READMEs' download links point at the mirror as well, with the GitHub link beside each.
- Fold the Plugins group of the Settings sidebar into Integrations: **Extensions** and **Marketplace** now sit there after Memory, and the group wrapper is gone. **Notifications** leaves the middle of the long General page for a tab of its own, after Layout. The sidebar is four groups and eighteen tabs; searching Settings still finds every row where it was.
- Picking another CLI from a workspace heading's **＋** menu now opens it once without making it the default. The ✓ and what ＋ opens next time stay where you left them — only Ctrl+1…9 and Settings change the default.

### Fixed

- A Codex pane no longer reports **failed** about 30 seconds after starting while Codex itself sits at its prompt (#118). Creating a terminal waited for the attribution baseline scan, which opens every rollout file under the vendor's session tree to read its header; on a large tree that ran past the renderer's 30-second deadline. The pane is acknowledged as soon as its PTY is up and the scan runs behind it.
- Restore Codex pane naming and turn detection under Codex CLI 0.155, whose rollout log dropped the `user_message` event and moved the prompt into `item_completed`. Turns now end at `task_complete` / `turn_aborted` instead of at a per-tool-call `token_count`, so a long turn is no longer reported as finished each time Codex calls a tool.

## [0.2.6] — 2026-09-18 — signed release

### Added

- Give **Marketplace** its own page under Settings → Extensions. Searching the registry, installing, and the publisher-trust and permission dialogs move there from the Extensions page, which now holds only what is installed. **Execution policy is no longer a page of its own**: it is the block at the top of the Extensions page, with its scope badge and storage path, and searching Settings for it opens that page scrolled to the block. Both pages read one plugin inventory, so an install made on Marketplace shows on Extensions without reopening Settings.
- Translate the native application menu (File, Edit, View, Window…) and rebuild it when the UI language changes. Items with a system role keep the system's own label.
- Put the actions that needed a right-click into a workspace's **⋯** menu: reveal in Finder, copy path, rename, open in its own window, and — when the window still holds another workspace — close the workspace, with or without its panes. The context menu keeps them all as a second entry point.
- Dragging a folded pane row now carries its hidden subtree with it, to another tab or another window. Only the row being dragged expands into its subtree; other folded rows in a multi-selection still move alone.
- Sign in to Copilot CLI and Muse Code from **Settings → Accounts** with their own `login` commands, instead of opening a REPL to sign in inside.
- Help gains **Windows, Linux and cross-device** as a topic, a **Usage** section under Settings and System covering Token Monitor, Turn Stats and quota cycles, a note that Plans ships as a plugin, the 24 prompt-skill icons in the icon reference, and the full list of 53 MCP tools. Interface labels in help text are now read from the same locale keys the interface renders, which corrected twenty descriptions that had drifted. **Navide Cloud** moves from the General group of the Settings navigation to Accounts & Agents.
- Localize the model and effort refusal shown by the spawn dialog and Settings → CLI Agents; it read Chinese under the English interface.

### Fixed

- Stop a Claude or Kilo sign-in pane dying on `error: unknown option '--mcp-config'`. Signing in to the current account from Settings → Accounts has no login profile id, which is what the "is this a sign-in pane" check used to look at, so the pane was wired with MCP, skills and push flags that the login subcommand rejects. The check now asks whether the command was actually rewritten to a login subcommand; a vendor with no login subcommand keeps its ordinary REPL and its wiring.
- Stop grok being detected, spawned and updated as Cursor CLI. grok installs `~/.grok/bin/agent` — the name Cursor's binary uses — and `grok 1.0.34` satisfied a bare version pattern, so Settings showed Cursor CLI 1.0.34 installed, a Cursor pane ran grok, and **Update Cursor CLI** updated grok. Cursor now declares what its version output looks like; a candidate that fails that probe yields to the next name (`cursor-agent`), and the update command runs on the binary that was actually found. A machine with grok and no Cursor now correctly shows Cursor as not installed.
- Stop a Codex pane asking **Hooks need review** on every open, on Codex builds that gate `-c hooks.SessionStart` from the command line. After the prompt is seen once, no later Codex pane on this machine injects the hook; session binding falls back to log and marker detection, which is slower but complete, and Pipeline Log says so. **This switch is permanent and per machine; there is no UI to turn it back on yet.**
- Stop the usage-limit badge lighting on text that is not a limit — a replayed transcript, a quoted message, a pane writing *about* limits — and staying lit for hours while the CLI answered normally. A limit sentence in the terminal is now overruled by a fresh `/usage` reading that shows headroom (and triggers one refresh); conversely the badge lights from the reading alone when the account is spent, including a weekly wall with no reset time, shown without a clock. A badge you dismiss stays down until the next new reading. Also: the session-limit pattern no longer joins two unrelated sentences, and a cached reading no longer relights the badge right after an account switch. Cursor, Kilo and Pi keep the terminal-text-only behaviour.
- Detect CLIs on machines with a slow login shell, and CLIs installed under a custom npm prefix. The PATH probe timed out at 3 s and cached the timeout as an answer for five minutes; `npm config set prefix` was ignored. The probe now has a ceiling per caller — 8 s for status, 15 s for **Re-detect** and post-install rescans, 3 s before a pane opens — retries a failure after 60 s, and reads `prefix` from `npm_config_prefix` or `~/.npmrc` (absolute paths only). Settings waits up to 45 s for the first status instead of 10.
- Sync **Don't ask again** for the install prompt across windows, and stop asking when the opt-out list could not be loaded. A second window kept offering to install a CLI you had opted out of, and a status timeout was read as "never opted out". The prompt is now held when the list is unavailable, with a line in Pipeline Log.

## [0.2.5] — 2026-09-17 — signed release

### Added

- Give each CLI its own launch settings in **Settings → CLI Agents**: a default model and reasoning effort for new panes, a custom launch command, and extra environment variables. The manual spawn dialog gains Model and Effort fields for the CLIs that declare them, prefilled from that CLI's default. The tab now also carries the per-CLI status chips, the permission-bypass switch, the push channels and guided install, so everything about a CLI is in one place. These settings are per machine, not per project, and apply to panes opened afterwards. A custom launch command takes the command line over completely: Navide adds nothing to it, so the default model, the effort, the permission-bypass flag and the per-pane arguments are all left off, and setting a model alongside one is refused rather than ignored. Rebuilt and restored panes use the vendor's own resume syntax, and a sign-in pane uses the vendor's login command, so neither takes the custom line. Variables Navide manages itself — `ANTHROPIC_API_KEY`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and about twenty more — are dropped from the extra environment, with a toast saying so.
- Add **Remove all N panes** to a pane's context menu: close a pane together with every agent it spawned, in one step. It appears only on a pane that has descendants — previously the choice was to close the children or to close the pane and watch its children reattach to another parent in the sidebar.
- Let a push channel preference change reach every open window at once, and say what turning them all off costs: messages fall back to being typed into the other pane once it goes idle (slower), Claude Code's rewake stops working, and panes already running keep their old channel until restarted.

### Fixed

- Open panes for a CLI installed through `npm install -g`, nvm, volta, pnpm or bun when Navide was started from Finder. The backend's PATH probe could not see those installs and refused the spawn outright, which read as "works in Terminal, will not open in Navide". A probe that cannot find the binary no longer blocks; the pane's own login shell decides. Guided install follows the same evidence — it now offers itself when the shell actually reports `command not found` (exit 127), instead of appearing over a pane that was about to work.
- Accept a CLI whose `--version` exits non-zero but still prints a version. Settings counted such a CLI as installed while the spawn probe refused it, so it showed as installed and failed to open every time. A probe that names no version at all is still fatal. Separately, a resume command is now built from the vendor's own binary name rather than its key, which differed for any vendor not spelled in lower case.
- Keep `nvm use` working on macOS. Every nvm version directory was put at the front of PATH, so the node a user had selected — or the Homebrew node they had moved to while `~/.nvm` still existed — was quietly replaced. Those directories now go after the user's own PATH: the selected node stays first, and a CLI that exists only under nvm is still found. The pnpm home on macOS is `~/Library/pnpm`.
- Resume a pipeline stage again. Every pane the stage opened failed with `cwd does not exist: …/navide.db`: the project file became a SQLite database, and the front end still derived the working directory by trimming that path, so it handed the database file itself over as the workspace. It now uses the workspace path the backend recorded. A resume the backend refuses rolls the pipeline back and stops rather than spawning the next stage into a run that was never resumed, and the reason it refused survives the rollback. Pressing Resume twice no longer spawns the stage twice.
- Stop one flooded event queue taking a whole plugin backend down with it. Only protocol frames — request, response, cancel — are fatal on overflow now; a Host notification is dropped and counted, with the first drop recorded. A plugin backend that exits cleanly while ready records why, instead of disappearing without a trace.
- Label the workspace **⋯** menu's rebuild row instead of describing it in the row. The full sentence was the label, so it wrapped to six lines in a 168px menu next to a one-line **History** and read as broken. The row now carries a short label and the explanation moved to its tooltip. Nothing about the row's position, its order, what it does or when it is available changed.
- Let the out-of-quota badge be dismissed, and stop a dismissed one swallowing the next real limit. Clicking the badge clears the flag after a confirmation, and a loop waiting on quota resumes immediately. The first version matched any reset with the same clock time and never expired, so hitting the limit again the next day — or switching back to the account that had run out — produced no badge and no quota gate while a loop kept feeding a spent CLI. The suppression now lasts only until the reset it dismissed, and is tied to the account that raised it.

- Keep the user's home directory out of error text shown in the app. `OSError` stringifies with the filename that failed, so an unhandled missing-file error put an absolute path — and the account name inside it — into a toast or banner that ends up in a screenshot. The generic dispatcher now writes `~` instead of the home prefix; the rest of the message is unchanged, so it stays as useful for diagnosis as before.
- Localize the refusal shown when you switch to an account whose sign-in is still running. It was the one refusal on that path left in untranslated English, and it reached the toast verbatim once every refusal with a message started being toasted. It now uses the same string the delete path has always used.
- Toast every CLI account switch failure that carries a message, not only `PANES_RUNNING` and `SWITCH_RATE_LIMITED`. The other refusals (e.g. `PROFILE_SWAP_FAILED`) only ever reached the accounts panel's own banner, which sits above the per-agent sections and scrolls out of view once you're looking at one agent's row — clicking **Set as default** on a failing switch looked like it did nothing.
- Reopen the Plans, Git and Token Monitor windows after a clean quit, alongside the workspace windows that already came back. A Plans or Git window returns only when its workspace's main window did, so a workspace held back by the restore failure breaker cannot be let in through one of them. One-shot viewers — diff, branch diff and the editor — stay closed on purpose: reopening a diff of a change you have long since dealt with is noise, not restore. Their size and position come back with them.
- Stop a workspace being dropped from restore after three short sessions. Each launch charges every restored workspace one attempt up front, and only a backend that stayed up for a full minute paid it back — so three quick launches in a row spent a workspace's whole budget and it was quietly skipped from then on, without any of them having gone wrong. Reaching a clean quit now settles the charge too. A run whose backend could not be kept alive still counts against the workspace.

## [0.2.4] — 2026-09-17 — signed release

### Fixed

- **Upgrading with two devices:** a device on 0.2.3 and one on 0.2.4 cannot complete a new pairing, in either direction. The pairing handshake now carries an encryption key and has no version negotiation, so the older side is refused before a code is shown. It fails closed — the two machines never show different codes and both believe them — but neither says why: they sit on "waiting for the other device" until the request times out. Pair only once both devices are on 0.2.4. Devices paired on 0.2.3 keep working for messaging; sharing a sync key between them is refused until they are unpaired and paired again. **If you already use cloud sync, upgrade both devices together:** records written on 0.2.4 are sealed in a format 0.2.3 cannot open, so anything you add or edit on the upgraded device while the other is still on 0.2.3 never reaches it — and upgrading the second device afterwards does not backfill it, because the older release has already moved its read position past those records. Editing the item again on either device sends it afresh. Records written before the upgrade are untouched and keep syncing in both directions.
- Persist detected session identities before UI notification and preserve them across history registration and later snapshots; allow loading more History entries after an empty search and rerun content search for newly loaded entries.
- Bind Codex sessions to their originating pane using verified resume IDs and launch-scoped first-turn hooks; preserve hook trust and marker fallback, and skip redundant markers when a session is already bound.
- Hold the session marker while a keystroke-only startup dialog (Codex **Hooks need review**) is on screen instead of pasting into it, and type the marker into panes that a restart reopened as a fresh conversation; both cases left the pane without a resume id, so History showed no **Resume** button for it.
- Keep the terminal responsive while a CLI floods a pane with output: PTY input is no longer blocked behind the flood, and the reader pauses safely when a write is blocked.
- Wire per-pane home shims on Windows for MCP, and surface panes that could not be wired instead of failing silently.
- Keep older History pages reachable after a search, and refine tab and terminal styling.

### Added

- Fall back to the dl.navide.dev release mirror when GitHub's asset host cannot be reached: the updater switches its feed to the mirror after a network failure while checking or downloading and stays there for the session; a 404 or checksum failure is still reported as before. Every release is now mirrored (byte-for-byte, sha256-checked) by the release workflow, and the READMEs carry a mirror link beside each download.
- Add **Window → Token Monitor**, a separate window for local Claude turn history, model filtering, per-turn trends, and average/median usage over 14, 30, or 90 days. Display incomplete scan coverage and unknown account attribution explicitly; keep the existing Turn Stats modal.
- Keep local quota observations for the active Claude account slot using existing usage polls, with bounded retention and no extra provider requests. Quota observations are separate from transcript usage and do not estimate an official token allowance.
- Add a **Credentials** cloud-sync section (off by default) that carries portable CLI credentials pasted in **Settings → Accounts** to your other devices as ciphertext under the account sync key: random item ids, no tombstone by absence (removal stays local), sealed conflict rows, a round that fails rather than skips an unreadable record, and a cursor that waits for a key another device has not handed over yet. Accounts cards gain a per-credential cloud line, one-click use of a credential pasted elsewhere, and cards for credentials imported into named accounts; Settings → Sync shows the sync key id and can rotate it (records are re-sealed and paired devices receive the new key) or adopt a key from before accounts were bound. Physical two-device acceptance and vendor billing checks are pending.
- Add a **Quota Ledger** behind the token views: per-account quota cycles (the rolling 5-hour window, plus monthly and yearly aggregates), how often a cycle ran out, and which account each pane was bound to over time. A new **Quota Cycles** view charts them, and Turn Stats can be filtered by account and shows the CLI version each turn ran on.
- Add a per-turn token usage modal (**Turn Stats**) reachable from the menu and from the token panel, with session turn parsing behind it.
- ~~Add **Settings → Sharing**~~ — *Correction: this page was removed before 0.2.4 shipped and is awaiting a redesign. Exporting and importing the settings bundle is available under **Settings → General → Settings Management**; the cloud share code and the paired-device list described here did not ship.*
- Closing a workspace can leave its CLI panes running: the sidebar context menu separates **Close workspace** from **Close workspace and its CLI panes**, resumable pane records survive the close, and the confirmation dialog says which one is about to happen. Pipeline slots are retired by pane id on close, and rows show how many descendants a pane has.
- Fold workspace subtrees in the sidebar, and collapse the per-row rebuild-all action into the row's overflow menu.
- Add `manual_pane.release_pty`, which ends a pane's process while keeping its record so the pane can be restored later.
- Report the cached vendor quota and the launch identity in `cli_get_status`.

## [0.2.3] — 2026-09-15 — signed release


- First release where macOS, Windows x64, Windows arm64 and Linux x64 ship from the same commit (v0.2.2's Windows and Linux assets were uploaded later from a different commit).
- Windows: native arm64 installer (#100); ConPTY console host bundled and verified at build time (#86); backend follows the app into exit (#88); CLI panes receive their command directly, not through PowerShell (#87); two CI regressions fixed (#80).
- Windows/Linux: drawn window controls always above every overlay (#94); Plans window gets a title bar (#96); confirm before the last window closes (#81).
- Linux: package, binary and desktop entry renamed to navide (#85); hook works without curl (#83); backend follows the app into exit (#84).
- Backend: outbound TLS context built once, off the event loop — fixes terminal panes timing out on Windows while the analyzer polled (#102).
- MCP: cli_list_sessions and cli_place_pane; panes can resume an existing CLI conversation; sidebar drag-and-drop assigns pane lineage (#103, #104).
- Language defaults to the system locale when unset (#82); update manifests present for every platform; docs brought back in line with what ships (#101).

## [0.2.2] — 2026-09-13 — signed release

### Added

- Multi-platform support for Windows and Linux:
  - Windows: native NSIS installer packaging, ConPTY terminal integration, DPAPI secret encryption, Job Object resource governance, and osplat platform abstraction.
  - Linux: official AppImage packaging with static FUSE3 runtime, .desktop integration, and /proc resource probe.
- Prompt Skills enhancements:
  - Custom single-grapheme character and emoji icons with 24 builtin vector icons.
  - One-shot prompt casting for non-default skills without entering the infinity loop mode.
- Workspace & UI hierarchy improvements:
  - Workspace display name aliases across UI, plugins, and separate windows.
  - Full directory path display under sidebar workspace headers for clear disambiguation.
  - Subtree status indicators and badges on parent panes and meeting cards.
  - Token consumption attribution and display grouped by sidebar run group.
- MCP and Messaging protocol extensions:
  - Support waking cold-restored placeholder agents via `cli_send` and `ui.pane.open`.
  - Ack-only agent messages that log without injecting into terminal input.
  - Multi-device connectivity presence hints in `cli_whoami`.

### Changed

- Hardened Plans scanning and watcher infrastructure:
  - Single-flight concurrent scan coalescing to eliminate redundant backend scans.
  - Debounced watcher events and scan-start timestamps to prevent dropped updates during concurrent edits.
  - Accurate plan directory move tracking and path preservation.
  - Plans v2 retry affordance and recovery reason reporting.

## [0.2.1] — 2026-09-10 — signed release

### Changed

- Document that Plans legacy recovery is authorized only by the Host-minted
  pre-dispatch `legacy-safe-before-dispatch` disposition; post-dispatch errors,
  stopping, Grant revocation, and policy denial do not retry legacy.
- Explicitly declare and document the supported Node.js runtime as Node.js 22.12+ within the 22.x release line (with pnpm 10).
- Bound nested Plans discovery, cache unchanged development backend builds, and validate the production package against test-fixture contamination.

### Added

- Add a dedicated Settings → Execution Policy editor for the Host default,
  global user modes, explicit workspace source selection, untrusted repository
  recommendations, confirmed corrupt-state rebuild, and fail-closed recovery
  guidance. Extensions now shows Manifest Permissions, exact package-version
  Grant state, and the selected agent Execution Policy as separate concepts.
- Add the global agent Execution Policy v1 contract and Host-owned durable
  default/user policy store with strict fail-closed parsing, owner-only atomic
  persistence, lowercase shell-name canonicalization, case-insensitive agent
  executable policy matching, and a durable monotonic revision high-water mark.
  The setting remains separate from Manifest
  permissions and package-version Plugin Grants.
- Enforce Host-owned `user` and MCP-routed `agent` initiators across public
  capabilities and package-local Backend Wire calls, including policy revision
  rechecks before queued dispatch, complete shell-chain executable checks, and
  exact package-version Grant revocation that drains calls, subscriptions,
  events, views, and child backends without rolling back completed effects.
- Add the Host-only repository Execution Policy source service for strict,
  untrusted `.navide/execution-policy.json` recommendations, explicit
  per-repository source selection bound to inspected canonical-content
  fingerprints, durable owner-only selection state, monotonic revision floors,
  bounded recovery, typed fail-closed source results, strict user pins,
  revision-aware snapshot identities, and stale recommendations without source
  merging.
- Add an internal Electron-main Backend Wire v1 supervisor seam with real
  child-process health/unary conformance coverage, explicit child environment
  isolation, bounded cancellation tombstones, and subscription lifecycle
  conformance; general third-party backend catalog activation remains deferred.
- Add test-only integration evidence for the bounded Issue 21 Plans
  packaged-child round trip: the real `PlanWindowApp` mounted call site, public
  SDK backend client, sender-authenticated Host router, self-contained Python
  fixture child, and `plans.resolve_root` / `plans.changed` call-event path.
  CI and release gates build and run the fixture explicitly; it is not a
  production artifact, and the full third-party backend lifecycle and remaining
  Plans operations stay on their owning migration issues.
- Add the Host-private Plans core-service bridge, package-owned watcher, bounded
  child drain/restart lifecycle, and Python/Go packaged fixture parity. The
  combined production Plans package now consumes those seams with an explicit
  agent method allowlist and a retained legacy fallback.
- Activate the combined `navide.plans` Manifest v2 package with a self-contained
  Backend Wire executable, Host-private filesystem bridge, workspace-bound
  headless agent routing, Host-minted agent Initiators, workspace storage
  preference migration, package-owned change events, and fail-closed legacy
  recovery. Manual operations remain user-initiated and outside agent policy
  filtering; no public `plans` permission is added.

### Fixed

- Reject overlapping install and removal transactions for the same Plugin,
  preserving its package, Grant, and runtime rollback state.
- Gate Plans v2 activation and preference writes on completed storage migration
  and lifecycle persistence; fail closed when previous recovery state is unreadable.
- Restore the retained Plans toolbar and Review Notes inside the packaged
  Plans contribution, including overflow clicks, note editing focus,
  application confirmation, anchored comments, and plan-switch isolation.
  Opt-in development provenance and emitted-frontend integration checks now
  distinguish the selected installed package from the current worktree build.
- Prevent unintended editor opens from Plans navigation: standalone initial
  `rel_path` document loading and plan row clicks now only inspect and render
  the plan in the standalone view without invoking `ui.openInEditor`. Left-sidebar
  plan row selection invokes `ui.openPlansWindow` and never overwrites the
  active editor, leaving `ui.openInEditor` strictly for explicit "Open in editor"
  user actions.
- Fix production Plans history, section editing, preview metadata, recovery and lifecycle races; require explicit confirmation before selecting a full repository policy.

## [0.2.0] — 2026-09-07 — signed release

### Added

- Let `cli_get_status`, `cli_wait_idle` and `cli_send_and_wait` answer about
  panes on another device. The status was already being synced — the roster
  carries each remote pane's badge word and `cli_list_targets` was already
  handing it to agents — so only the target resolver was refusing. Remote
  answers say how much weaker they are rather than passing themselves off as
  local: `source` is `roster_status` or `roster_offline` and never
  `turn_complete`, a parked pane times out as `awaiting_unclassified` because
  the roster cannot tell a permission prompt from a question, and `offline` is
  a third answer returned at once instead of waited out. Reading a remote
  pane's log and driving its UI stay unavailable; those need a device-to-device
  request channel that does not exist.
- Let an agent ask another pane to stop with the new `cli_interrupt` MCP tool.
  Until now an agent could force-kill a pane — PTY and all, with no gate and no
  say from the pane being killed — but had no way to interrupt one, so a child
  running a refactor that was going wrong left its parent choosing between
  waiting for the turn to end and destroying the session. The per-vendor
  interrupt key already existed and was already wired to the PTY; only the MCP
  entry was missing. The tool is explicit that a keystroke is not a stop: it
  may abort the turn, only clear the input box, or on a second press quit the
  CLI, so the result has to be verified rather than assumed.
- Let an agent withdraw a message it sent with the new `cli_cancel_message`
  MCP tool. A message waits in the recipient's queue until that pane is between
  turns, so a sender that changed its mind previously had to let it land and
  then send a correction — costing the recipient a turn to work out the first
  message no longer applied. A withdrawal is recorded as `cancelled` rather
  than `failed`, since nothing went wrong and nothing should be resent.
- Let a CLI agent read the full text of messages sent to it with the new
  `cli_read_incoming` MCP tool. `cli_pending_incoming` shows 200 characters
  with the whitespace flattened, so until now an agent could read another
  pane's entire log but not one message addressed to itself. Reading consumes
  by default — a message read this way is not typed into the pane afterwards —
  and `peek` reads without consuming. Consuming reserves before it releases, so
  a lost confirmation returns the message to the queue rather than dropping it.
- Add the public Plugin Platform v2 contracts, SDK CLI, unified Vue UI package,
  and an external-workspace frontend package smoke workflow with fail-closed
  capability-denial coverage.
- Use the same Manifest, catalog, grant, instance, and capability lifecycle for
  official and third-party plugins. Until Marketplace acquisition is available,
  the App includes a removable factory Git package whose durable opt-out and
  explicit Extensions restore do not bypass that shared runtime.
- Add the Issue 16 Host-managed durable plugin/workspace storage adapter and
  lifecycle seams with authenticated package/workspace identity,
  version-matched candidate/active/previous snapshot selection, atomic JSON
  persistence, stable quota errors, and Host-derived package-version grants.
- Enforce Manifest v2 coarse `system` namespace and `shell` grants through the
  Host capability catalog, authenticated workspace binding, package-version
  approval, and fail-closed AI CLI/shell request planning.
- Allow the canonical `git` executable through Manifest v2 `shell.run`
  allowlist mode without adding a Git permission or first-party bypass.
- Add the optional official `navide.git` Manifest v2 package
  with isolated left and window custom views from one active package version,
  Host-owned Git contribution/account bridges, workspace storage continuity,
  and a retained legacy rollback path. Git-specific production source now lives
  in the plugin package; remote credentials remain Host-injected and the
  lifecycle selector uses a crash-safe atomic write. Approved v2 activation is
  attempted first; load/mount/readiness failure selects the retained legacy
  renderer for that process, while security and permission denials fail closed.
  Contribution artwork is decoded by the Host and rendered from the shared
  manifest catalog with a generic fallback for missing or invalid icons.
- Configurable lazy CLI restore: resume one CLI, the first Grid page, or the active tab when opening a workspace; preserve manual-tab grouping and recover uniquely attributable missing Claude conversations on realization.
- Add Meta Muse Code as a spawnable CLI agent, including install detection and one-click install. Resume, log reading and credential switching remain unavailable for it until they are verified against a real installation.
- Validate Manifest v2 frontend contributions consistently in the App and marketplace registry, including strict view discovery and package-entry checks.
- Validate, install, list, and remove Manifest v2 backend-only and combined packages from one active package version, and publish the Backend Wire v1 contract corpus.
- Add an internal Electron-main Backend Wire v1 supervisor seam with real
  child-process health/unary conformance coverage, explicit child environment
  isolation, bounded cancellation tombstones, and subscription lifecycle
  conformance; production catalog activation remains deferred.
- Require a verified Registry signature from a signer authorized by the
  App-pinned Registry root before a Manifest v2 marketplace package can be
  installed, including packages whose signed listing metadata has been
  modified.
- Stop scanning arbitrary external directories for legacy Python backend
  plugins; validate only the Host-bound Manifest v2 activation projection while
  packaged backend process supervision remains fail-closed.
- Keep Official Registry namespace authority separate from self-hosted root
  verification, fail closed while the independent production Registry root is
  unprovisioned, and reject publisher-key reuse as Registry trust.
- Add an opt-in `AGENT_TEAM_PLUGIN_DEV_PATH` seam for one explicitly selected
  local Manifest v1 or v2 frontend package. Manifest v1 is bounded local
  compatibility only: it remains unsigned, local-only, and cannot claim
  Registry provenance; reserved ids and backend contributions remain
  unavailable in Developer Mode.
- Tell a CLI agent when its inter-CLI message could not be delivered: a `[Navide MSG] delivery failed` notice naming the target and the reason is written back into the sending pane, through the same queue and idle gate as any other message.
- Deliver an inter-CLI message to a Claude pane through its Stop hook when its turn ends with one waiting: the message becomes the agent's next instruction instead of being typed in, so it never occupies the input box or waits behind whatever you are writing. Capped at 5 in a row per pane; anything else — an idle pane, another CLI, hooks not installed — still arrives the usual way, unchanged.

- Route an inter-CLI message through a CLI's own push channel where it has one, instead of typing it into the pane. Which channel a CLI offers is declared per vendor; a message that goes out this way is marked with the channel it used in the Messages panel, and anything that does not land there falls back to the ordinary typed delivery with no message lost and none delivered twice.
- Deliver a message to an OpenCode or Kilo pane over the HTTP interface that CLI already serves for its own terminal UI, instead of writing it to the terminal. The pane is launched with a loopback-only port of its own (Kilo's also with a per-pane password); an OpenCode port carries none, because that CLI cannot authenticate against its own server — see [Privacy and Data Flows](docs/en-US/privacy.md). A pane whose command already names a port is left alone.
- Deliver a message to a Qwen Code pane by appending one record to a per-pane file the CLI watches, instead of typing it in. The message joins the CLI's own queue rather than its composer, so a Qwen pane accepts one while you are half-way through writing a prompt in it.
- Switch any CLI's push channel off in Settings → CLI Agents → Push channels, with what each one costs stated next to it. All are on; switching one off sends messages to those panes the ordinary typed way, takes effect on panes already running without restarting them, and needs no restart itself: Claude's switch rewrites `~/.claude/settings.json` at once, so its hook appears or disappears with the switch. Switching one back on is immediate as well, except for a Claude pane, which regains its channel at its next turn end — and a Claude pane already open reads that settings file only when it starts, so the switch reaches it at its next start.
- Reach an **idle** Claude pane without typing into it either: a background hook waits on Navide and wakes the agent with the message when one arrives, covering the gap the Stop hook cannot — that one only fires as a turn ends. The message arrives as a system reminder and says so; anything Claude Code will not carry that way, including an envelope past its 10,000-character hook limit, still goes in the usual way.

- Answer an agent that asks `cli_send` to wait: `wait_for_delivery_s` holds the call until the message actually goes into the other pane and reports what happened — delivered, refused with its reason, or still queued with what is holding it and for how long. Left at its default of 0 the answer is unchanged, and a refusal still reports the send as the success it was, so nothing invites a resend that would dispatch the work twice.
- Take an inter-CLI message back before it is delivered: **Withdraw** on a queued row in the Messages panel drops it from the target's queue, so nothing is ever typed into that pane. It is offered only while the row is still queued — once delivery has started the text is being written and there is nothing to recall — and a withdrawn row can be resent like a failed one. A message queued in another workspace's window is withdrawn by asking that window, which owns the queue and answers with what actually happened.
- Report why an inter-CLI message has not gone out yet to the agent that sent it, not only to the Messages panel: `cli_check_message` now carries `hold` and `held_for_s`, and `cli_list_targets` names the same reason per pane as `hold_reason`, which is what makes its `busy` flag explainable. The reason is sent only when it changes, and only for a message the backend already tracks.
- Tell a CLI agent when its message is still queued, not only when it failed: after two minutes a `[Navide MSG] still held` notice naming the target, the reason and how long it has been waiting is written back into the sending pane. It is not a failure — the message is still on its way — and each message produces exactly one, however long it stays queued.
- Answer the same question for an MCP caller: `cli_check_message` and a timed-out `cli_send` wait now carry `stale` once a message has been queued more than two minutes, and the new `cli_inbox_summary` tool lists every send of your own that is currently stale or failed, with an excerpt of each. It takes no arguments and answers about the caller only — the pull half of delivery feedback, for an agent that stays too busy to be told.
- Say once, in the announcements feed, that a CLI pane or external MCP client left over from the previous version is holding that version's MCP tool list and needs reopening. Shown only when the backend actually started at a different version than the run before it.

- Ask what is waiting for you: the new `cli_pending_incoming` MCP tool lists the messages queued *for* the calling pane — sender, age, excerpt, and whether Navide wrote it. Every existing feedback path is typed into a pane, so it reaches an agent only between turns, which means an agent deep in a long piece of work was exactly the one that could not be told it had mail and had no way to ask either: `cli_inbox_summary` only ever answered "did what I sent get through?". It reads the persisted message log, so unlike `cli_inbox_summary` it survives a backend restart. Only a CLI pane has an inbox — a host or external caller has no messaging name and gets an error rather than a misleading empty list.
- Forward a spawned pane's turn to its parent when it ends without writing a report. `cli_open_agent` promises the caller a report back, but that report is the child agent's own output: a missed marker used to make it vanish with no queue row, no failure and nothing for either side to see. The first turn a spawned pane ends now settles that debt either way — its own report if it addressed the parent, otherwise that turn's output forwarded under a `fallback report` label so it can never be mistaken for the real thing. Once per pane, ever; nothing is sent if the parent closed or the turn carried no text.
- Report a message block Navide could not read. A turn that prints `---MSG-START---` and produces no block was the one failure nothing could describe — no message existed, so there was no queue entry, no log row and no notice. The pane that wrote it is now told, which is the only party that knows what it meant to send.
- Show at a glance whether a tab's agents are working: each run-group tab in the tab bar now carries a small dot — green while any CLI in that tab is running or starting, amber once every one of them has stopped, grey for a tab with no panes. A pane waiting on you counts as stopped: the dot answers one question only, and the pane badge still says which kind of stop it is. It reuses the colours the pane badges already use, says the same thing on hover and to a screen reader, and never animates.

- Add a per-device trust policy (allow, ask, or block) and network pairing controls to the account UI, the first step toward pairing with another machine over Navide's cross-device link.
- Add device pairing: confirmation tokens, a six-digit SAS comparison, live link status, and a pairing prompt UI, so trusting another machine requires an exchange a person checks rather than a bare address.
- Encrypt cross-device messages end to end: an ephemeral X25519 keypair per message, ECDH against the recipient's long-term public key, HKDF-SHA256, and AES-256-GCM, so the relay server can no longer read message text in transit — it previously stored it as plaintext.
- Support unpairing and revoking a pairing from the account modal, closing device trust in the other direction.
- Require a trust-confirmation key, handed to the backend over stdin's first line by the process that spawned it, before any of the six trust-changing actions (device pairing, revocation, policy changes) may run. A file or an environment variable would be readable by anything else on the machine, so a backend started without one on stdin — the tests, a developer running it by hand — refuses those actions instead of silently skipping the check. Ships alongside CLI accounts management and per-account usage tracking, and gives the credential vault's Keychain entries for app-owned secrets a name scoped to each backend data directory, so a second install (a dev build running alongside the packaged app) can no longer overwrite the other's stored server credential.

### Changed

- Accept a `---MSG-START---` marker standing on its own line with `to:` on the line below it. Both forms now open a message block. The injected hint still teaches the same-line form and that is still the one to write, but "the marker must be a whole line" reads just as easily as "the marker gets a line to itself" — and until now a block written that way was discarded as ordinary prose, so a reply an agent believed it had sent left no trace anywhere. The cost is booked explicitly: an unfenced bare marker quoted inside a message body now truncates the message it sits in, the same hazard the same-line form has always had.
- Deliver a message into a `claude` pane while its turn is still running. The two turn-boundary holds exist to wait for a boundary, and Claude Code supplies that boundary itself — text written to its PTY mid-turn lands in its own queue, the same path a person typing mid-turn uses. Waiting for the pane to fall idle is what made a reply from a busy pane take 78s where the other direction took 2s. Declared per vendor and measured, not assumed: `claude` alone today, and `qwen` deliberately stays held because it merges several queued messages into one submission. The typing hold still applies, the pane still reports itself busy to `cli_wait_idle` / `cli_list_targets`, and push channels are unaffected.
- Say plainly that a reply's `to:` belongs on the `---MSG-START---` line itself. The instruction Navide injects with every message and every spawned task said the marker "must be on its own line", which reads as an invitation to put `to:` on the next one — and a block written that way opens nothing: it is read as ordinary prose, so no message is queued, no delivery fails, and neither side sees a trace of it. The parser is unchanged; the wording, the in-app protocol reference and the three-language docs now state the rule and no longer imply the opposite.
- Stop promising that a spawned pane's result arrives on its own. `cli_open_agent` told callers they "never need to poll it", but that report is the child agent's own output rather than anything Navide guarantees: it waits until the parent is between turns, and it never comes at all if the child does not write the block. The tool description, the MCP server instructions, the spawn protocol text and the docs now say so and point at `cli_get_status` / `cli_wait_idle` for when you need to be sure.
- Rename the built-in MCP server from `navide-plans` to `navide`: tools now appear as `mcp__navide__*`, and a per-tool "always allow" saved for the old prefix will be asked once more. Stale `navide-plans` entries Navide itself wrote (Cursor project config, per-pane shim configs) are replaced in place; anything you added yourself is left alone.
- Wait for an inter-CLI message to be delivered before waiting for the turn it should produce: `cli_send_and_wait` spends at most half its timeout getting the message in, and answers `not_delivered` — with the hold or the refusal reason — when it never arrives. It previously reported the target as idle in that case, which reads as "it finished your work" when the work was never handed over.
- Hold an inter-CLI message while someone is typing into the target pane: a pane with an unsent input line, or one that took a keystroke in the last few seconds, is reported as `typing` in the Messages panel until the line is sent or cleared, so a delivery can no longer submit a half-written prompt along with itself.
- Write every injection into a CLI pane as a bracketed paste for the vendors whose TUI keeps the mode on, instead of only multi-line ones, and send the paste guards as whole writes so a chunk boundary can never cut one in half.

### Fixed

- Fill the complete Host slot with the isolated Git v2 left contribution,
  without exposing the browser's default white canvas or outer page margin.

- Make Git account sign-in safer by limiting saved credentials to the selected
  Git host, protecting clone destinations chosen in the folder picker, and
  keeping Git preferences and selected repositories when moving to Plugin
  Storage. A documented legacy Git recovery launch option remains available if
  a release needs to return temporarily to the previous Git interface.

- Restore Git contribution parity across the embedded and dedicated views,
  including AI CLI file/external opens, semantic resize/redraw/force controls,
  change badges, and Escape-to-close behavior without affecting sibling
  instances. GitHub/GitLab Issue calls remain Host-owned through the shared
  `git`/`gh`/`glab` executable allowlist. Embedded left-view failures now fail
  closed with a manual Retry state and ignore stale geometry completions.

- Harden staged plugin event and PTY ownership: stable capability-context
  refreshes no longer detach routes, in-flight creates are cancelled on view
  teardown and late committed creates receive one operation-scoped cleanup kill,
  stale reattach senders fail closed, and Manifest v2 raw PTY recovery remains
  explicitly deferred to a persistent Host ownership contract.
- Route public workspace events to the exact Host-selected package id, apply
  Manifest v2 PTY rules even when a descriptor is opened through the legacy
  adapter, and make instance subscription cleanup exactly-once for both active
  unsubscribe and view teardown.

- Keep Codex panes resumable after spawning sub-agents by excluding read-only thread-spawn child rollouts from the pane's persisted root session id.
- Keep Kimi Code's arrow-key navigation reliable in the embedded terminal by allowing 100 ms to reassemble split escape sequences while preserving an explicit `PI_TUI_ESC_TIMEOUT` override.
- Keep repository discovery responsive on slow filesystems by moving scans off the
  backend event loop and returning partial results after a bounded scan period.
- Keep a CLI agent's Navide tools working after its pane is rebuilt around it. Reloading a window, detaching a run group or taking one back gives the pane a new id while the CLI keeps quoting the one it was launched with, which used to fail every MCP tool for that pane — plan documents included — with "this pane's id is stale". The old id now resolves to the pane the process is actually attached to, and so do the pane's Claude Stop-hook delivery and what `cli_get_status` reports. Its push channel follows a window reload and a run group returning from a detached window, but not a detach itself — the window handing the pane over releases the channel before the receiving window claims the pane, so a detached pane is typed into until its CLI is restarted (a Claude pane re-arms its own hook at the next turn end and is unaffected). An id that names no pane at all is still refused.

- Authenticate the HTTP file routes and close two path bypasses: `/fs/raw`
  now requires the ws token instead of trusting any local process that could
  reach loopback, and `workspace=/` can no longer turn the escape check into
  a no-op; `/fs/page` instead serves previewed content under an HMAC
  capability scoped to one workspace, because that route hands untrusted
  HTML to a sandboxed iframe that could otherwise leak the ws token itself
  through an unsafe-url referrer or a remote image; and the internal
  workspace-directory guard now compares paths with `samefile` instead of
  string equality, closing the APFS case-insensitivity bypass where
  `.Agent-Team` walked around a check written for `.agent-team`.
- Refuse HTTP requests whose Host header does not name this loopback server,
  closing a DNS-rebinding path that could make a page same-origin with
  `127.0.0.1` and read the unauthenticated file routes' replies — including
  the 0600 ws token on disk. Also stop serving the FastAPI schema routes
  (`/docs`, `/redoc`, `/openapi.json`) and `/health`'s absolute backend-log
  path without authentication.
- Remove the unauthenticated `/mcp/servers` HTTP routes: guarded only by the
  loopback Host check, they let any local process PUT an arbitrary stdio MCP
  server and have it spawned immediately by `mcp_manager.reload()` — local
  unauthenticated remote code execution, bypassing the confirm-token trust
  mechanism entirely. The same functionality is already served by the
  ws_auth-gated `mcp.save_servers` websocket handler.
- Authenticate the loopback CLI hook endpoints (Claude, Copilot) with a
  per-backend session token instead of relying on the Host-header loopback
  check alone.
- Give the credential vault's Keychain fallback key its own name per app
  data directory, keyed off the actual data directory rather than an
  always-identical CLI-profiles root that had made the per-directory branch
  unreachable — a packaged and a dev backend had been silently sharing one
  `navide-device-trust` Keychain entry, and once each wrote it under a
  different code signature the Keychain ACL followed the last writer, so the
  other backend's trust store failed closed with every pairing gone. Add a
  person-confirmed `p2p.trust.rebuild` recovery path for that failure, gated
  through the same `trust:confirm` IPC allowlist as pairing and unblocking —
  the only way out before was deleting the Keychain item by hand, an
  unrecorded silent reset that is exactly what the store's lock exists to
  prevent.
- Validate that sensitive Electron IPC handlers (shell, fs, keybindings,
  trust confirmation) are called from the top frame of a real BrowserWindow,
  refusing webviews and subframes with `UNTRUSTED_SENDER` instead of
  trusting any IPC sender.
- Enforce pane ownership on the private-inbox `ui_invoke` actions
  (`ui.messaging.readIncoming`, `settleRead`): the caller's pane id now has
  to match the pane the action names, closing a path where one pane could
  read or settle another pane's incoming messages through MCP.
- Sanitize PTY injections: strip bracketed-paste guard sequences and unsafe
  C0 control bytes from a message body before it is written into a pane, so
  a message that happens to contain the paste end-guard can no longer drop
  the CLI out of paste mode partway through and have the rest of the text
  land as keystrokes — Enter, Ctrl+C, Ctrl+D — on someone else's machine.
- Make argument-safety an invariant of stored CLI model/effort arguments
  rather than a property of today's call graph: `manual_pane.spawn` now
  rejects an unsafe shape before persisting it, sharing one check
  (`model_args.py`) with the MCP entry point, so a value replayed from
  storage on restore cannot reintroduce an unsafe flag. Pinned with a test
  that enumerates every externally reachable spawn path and asserts a
  remote MCP or websocket caller can never supply a raw `commandOverride`.
- Fix two findings from a security review of the desktop-to-server link:
  trust-store reads answered from a cold in-process cache instead of
  loading the persisted state, which could report an already-pinned device
  as never seen and made the policy-sequence replay check vacuous; and the
  receive side now refuses plaintext from a peer this machine has already
  exchanged encrypted messages with, matching a rule the send side already
  enforced, instead of letting a relay downgrade the conversation by simply
  asking the receiver for it.
- Fix a message-deduplication race introduced while fixing the trust-store
  read bug above: take the dedup claim synchronously before any `await`, so
  two copies of the same message pushed at once can no longer both pass the
  membership check while the first is still writing its claim to the
  Keychain on a background thread.
- Require a person to confirm a device pairing at both ends instead of
  finishing it on the responder's confirmation alone — a relay that
  declines to forward the real request and answers with its own key could
  otherwise derive and echo back the same six-digit SAS the initiator was
  meant to compare against nobody.
- Reinforce device pairing: harden confirmation-token validation, tighten
  trust-store file permissions, and close gaps found while that pairing
  hardening was under review.
- Re-authenticate the desktop-to-server link when the trust record is
  rebuilt, so a machine that just discarded every pairing does not keep
  treating its existing connection as trusted.
- Stop a locked trust store from taking the whole account window down: a
  device row whose trust state cannot currently be read now shows nothing
  rather than crashing the device-list snapshot, and pairing is refused for
  that device rather than offered while its trust state is unknown.

### Documentation

- Add SECURITY.md private-reporting guidelines, scope, and safe-harbour language, a STRIDE threat model across four attacker positions, Chinese and Japanese security-policy translations, a weekly Dependabot config for npm/uv/GitHub Actions, and an advisory dependency-audit CI job (npm audit, pip-audit).
- Expand SECURITY.md and the threat model with further detail.
- Align the Chinese and Japanese security docs with the expanded root SECURITY.md and link them to the English threat model.

## [0.1.62] — 2026-07-26 — signed release

### Added

- Navigate Agent History log-search matches with Arrow Up/Down and clearer active-match highlighting.
- Add an in-process Plan MCP with plan CRUD, optimistic updates, dispatch, and Claude/Codex wiring; ship it as a built-in plugin.
- Finalize the built-in plugin system with a sandboxed mini-IDE, verified marketplace precedence, completed plugin capabilities, and an OS-editor fallback when the mini-IDE is unavailable.

### Changed

- Re-check updater state after a release has been downloaded.
- Align Active Agents rows and replace the remove action with minimize.
- Move Explorer deletions to the OS Trash so files and non-empty folders remain recoverable; preserve the original and report an error if Trash is unavailable.

### Fixed

- Scope CLI Agents ordering and disabled preferences per workspace, and close workspace-switch race and silent-loss gaps.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.61] — 2026-07-25 — signed release

### Added

- Aggregate plan and report documents across seven supported workspace directories.
- Harden Cmd+click links for CJK and emoji output, bare domains, wrapped paths, and workspace HTML reports.

### Changed

- Improve update-notification window restore and focus handling, show the available version in the update badge, and make minimized-agent state clearer.

### Fixed

- Harden CLI-account profile deletion and login-home credential harvesting and cleanup.
- Store Git account data with owner-only (`0600`) permissions.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.60] — 2026-07-25 — signed release

### Added

- Sign in to a CLI account from within Navide: a dedicated isolated login pane captures the new account's credentials and identity without disturbing the currently active account, and each account's signed-in identity is shown in the UI.
- Cmd+click a URL or file path in any CLI pane to open it — URLs open in your default browser, file paths open in the editor; bare domains are now linkified too.
- Open an HTML plan in your default browser from the plan review.

### Changed

- CLI account switching now swaps each account's credentials in place instead of isolating separate config homes, making switches faster and more reliable; swaps are hardened against concurrent switches and terminate the old process before handing over.
- Clearer wording on the app-update restart button.

### Fixed

- Cmd+click path hit-testing now handles CJK/wide-character paths and folder names that contain spaces or parentheses.
- Ignore IME composition keystrokes in the global shortcut dispatcher, so composing Chinese/Japanese/Korean text no longer fires shortcuts.
- Stop-pane messaging handles no longer accumulate `-2` suffixes across restarts.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.59] — 2026-07-24 — signed release

### Added

- Multi-select CLI panes (Cmd/Ctrl/Shift-click a pane header) for batch context-menu actions: interrupt, rebuild, minimize, restore, or remove the whole selection at once.
- @-mention autocomplete menu that lists other panes' messaging names on `@`, plus broadcast a message to every pane with `to: all`.
- Drag a plan row onto a CLI pane to inject the plan's goal into that pane.
- Switch a CLI account per pane from the usage badge, with colored per-account avatars and a shortcut to manage accounts in Settings.

### Changed

- Usage badges: Codex quota reflects its rate-limit windows and credits; per-model promotional rows are shown as real data (marked accordingly); usage is polled from the active CLI profile's isolated credentials.

### Fixed

- Offload blocking work off the event loop so `workspace.list_recent` no longer times out.
- Skip rebuild-via-resume when a CLI is busy, preserving in-flight work.
- De-duplicate redraw content instead of relying on a timing-window grace.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.58] — 2026-07-24 — signed release

### Added

- Codex quota badges now reflect its rate-limit windows and credits.
- Drive update download and restart-install directly from the status-bar update badge (one click, no detour through Settings).
- Renaming a pane to a messaging name another CLI already holds opens a collision-resolution prompt instead of failing.

### Changed

- CLI accounts: replace per-pane account binding with a single global active account per vendor, switchable from the titlebar. (Removes the per-pane profile picker and per-account token attribution introduced in 0.1.56.)
- The pane's messaging handle is now derived from its own name and stays in sync on rename/auto-title; the separate inline messaging-name editor is gone.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.57] — 2026-07-24 — signed release

### Added

- Per-CLI quota badges in pane headers.
- View a commit's per-file diff in the editor as a read-only tab.
- Status-bar indicator for background historic-log backfill.
- "@"-mention pane drop: dropping a pane when the cursor already sits after a bare `@` inserts that pane's messaging name instead of its full scrollback context.

### Changed

- Inter-CLI messaging: drop the manual compose UI; panes exchange messages through the `---MSG---` protocol.

### Fixed

- Reap detached grandchildren (e.g. MCP servers a CLI spawned) that are orphaned when a CLI or the backend dies, via persisted per-session descendant snapshots.
- Scope the pane attribution baseline scan to the pane's workspace folder instead of stat'ing the whole `~/.claude` tree on every spawn.
- Clear the backfill status pill when the workspace changes so it can't stick on.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.56] — 2026-07-24 — signed release

### Added

- CLI account profiles: run a CLI under an isolated account "profile" (its own home directory), switch the account per pane or when spawning, and manage accounts in a dedicated Settings tab. Token usage is tracked per account (`by_profile`, with a forward-migration that folds historical usage into the default account). No credentials are ever stored — only isolated home directories are registered.
- Move the update indicator into the bottom status bar.

### Fixed

- Cross-window pane drop now relies on Chromium's native same-app cross-window delivery, routing through the main process only as a fallback when no in-window target consumes the drop.
- Keep a cancelled loop from dropping a stray prompt into the pane or breaking the next loop start (per-pane generation guard).
- Stop a manual_pane.session retry flood that could time out terminal.create.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.55] — 2026-07-23 — signed release

### Added

- Inter-CLI messaging: panes address each other by name and exchange `---MSG---` protocol messages through an idle-gated, rate-limited queue, with a log/compose panel.
- Auto-derived pane names: an unnamed pane gets a heuristic title from its kickoff / first-turn text (a custom name always wins), persisted and broadcast to peer windows.
- Cross-window pane drop: drag a pane onto a terminal in another window to inject its context into that pane; drops route to the most-recently-focused overlapping window.
- Compact, click-to-expand Active Agents list with a status dot, a type·role sub-label, and a one-open-at-a-time accordion.
- Mini-IDE VS Code parity: filename-aware editor language detection, Toggle Word Wrap (Alt+Z), explorer drag-to-move, and tab rebinding that survives file renames/moves.
- Plans pane: search, stage filter, sort, and in-body to-do editing.
- Rebuild resumable CLI panes across all tabs from the sidebar.
- Configurable resume-spawn concurrency limit.

### Changed

- Focusing a pane that lives in another tab now switches to that tab.
- On macOS, Alt+letter keybindings match by physical key (so Option+letter shortcuts fire despite the special character the OS emits).

### Fixed

- Repaint alternate-buffer TUIs on drag-resize so the footer no longer stays garbled until the next output.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.54] — 2026-07-23 — signed release

### Added

- Star / favorite Agent History entries: a "starred only" filter, and starred entries are protected from bulk cleanup (an explicit single delete still removes them).
- Search Agent History by log content, not just metadata: a chunked, ANSI-stripped log searcher over IPC with a debounced query.
- Native application menu: Help, New Window, Open Recent, and About entries.

### Changed

- Capture Kimi resume session ids via a single-candidate fallback so a freshly spawned sibling pane stays bindable.
- Show the agent-type label alongside the optional role in pane headers.
- Settings: horizontally scrollable tab bar, scroll containers on several tab bodies, Roles-tab polish, and a dedicated Updates tab label.
- Throttle and extend the timeout for terminal creation.

### Fixed

- Harden log-content search across chunk boundaries: withhold incomplete ANSI escapes, flush the UTF-8 decoder at EOF (truncated multi-byte/CJK queries still match), and bound concurrent file opens to avoid EMFILE.
- Emit the Kimi turn-complete event once per turn and harden the notify path.
- Re-check the dead flag inside the WebSocket send lock to stop a disconnect flood.
- Ignore IME composition events during keydown in the rename flows.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.53] — 2026-07-23 — signed release

### Added

- Reconnect lost ("ghost") conversations: a restored pane whose saved session id has no transcript auto-reconnects to a unique provenance match, or surfaces a status-bar banner and a manual picker to reconnect to a previous conversation.
- Resume-on-open preference (always / never / ask) controlling whether opening a workspace resumes its previously spawned CLI panes, starts fresh, or asks each time.
- Loop auto-stop: the loop appends a done-instruction so the CLI prints a `<<LOOP_DONE>>` marker on its own line once the whole task is complete, and the app stops resending the resume prompt.

### Changed

- Assistant turn text is now carried only on turn completion (shared text-join helper and a larger both-ends activity-text cap), making turn-text judging more reliable.
- PlansPane: extract hard-coded strings to i18n, load legacy markdown plans in parallel, drop the background-refresh flicker, exclude archived plans from "delete all", and support keyboard activation on section headers.

### Fixed

- Attribution no longer guesses an ambiguous same-cwd session→pane claim; a hand-written `--session-id` is honored as an explicit, deterministic pin.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.52] — 2026-07-23 — signed release

### Changed

- Move the update controls (version, check for updates, auto-check/auto-download, release channel, and release notes) into their own **Updates** tab in Settings.
- The status-bar "close all" now acts on a single click with a confirmation dialog, replacing the double-click-to-arm gesture and its hint.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.51] — 2026-07-22 — signed release

### Added

- In-app update experience: full updater lifecycle and UX (check, download, restart, and release channel selection).
- Agent History: search filter plus history filtering and grouping.
- Spawn history tracking for panes.
- Plans: archive without deleting, approve directly from a draft, per-plan file path in the sidebar list, and section collapse in the editor.
- Store backup and forward-migration when the app version changes.
- Log-reader parsing, terminal cursor shortcuts, and keybinding/completion improvements.
- Dynamic latest-release badges in the READMEs.

### Fixed

- Keep the selected layout mode when only a single pane is visible.
- Propagate pane renames to peer windows and autofocus the rename input.
- Reap a killed child process on timeout; serialize git fetch per repository.

## [0.1.50] — 2026-07-21 — signed release

### Changed

- First **signed and notarized** stable release. Same feature set as the v0.1.49 preview, now built with a Developer ID certificate and Apple notarization and eligible for the in-app updater. Establishes the signed release pipeline.

## [0.1.49] — 2026-07-21 — unsigned preview

### Added

- Mini-IDE plugin system: a plugin architecture with an install / update / remove lifecycle, an Extensions view in Settings, and per-plugin verification and packaging. The whole surface is gated behind an opt-in flag (`AGENT_TEAM_MINI_IDE_PLUGIN`) and stays hidden until the main process confirms it is enabled.
- Plugin marketplace: a registry service, a publishing flow with a signing and trust model, and a discovery website to browse, search, and view plugin details.
- Kimi Code CLI integration: conversation-log reader and resume support.
- Git History window as a standalone view.
- Unified plan documents: a shared model for HTML and Markdown plans with in-place todo editing, stage snapshots with live refresh, a shared review toolbar, and Plans surfaced as a left-sidebar tab.
- Keybindings: Ctrl+1–5 to quick-select a CLI type, and Cmd+Shift+<n> to switch stage tabs.

### Changed

- Plans move to a left-sidebar tab with drill-down, replacing the pop-out window.
- Grid layout accepts custom column×row presets.
- Refreshed status-badge colors across components.

### Fixed

- Prevent stored XSS in the marketplace by serving plugin assets same-origin.
- Derive the Kimi resume session id from the directory name instead of the file stem, and validate the session exists during resume preflight.
- Stop focus/refit repaints from falsely showing a RUNNING pane badge.
- Plan QA hardening: preserve skipped/unknown todo fields, close panels on ESC, and fix blank todo-only plans.
- Externalize optional `ws` native dependencies (bufferutil, utf-8-validate) so the build does not break.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.48] — 2026-07-20 — unsigned preview

### Added

- Interactive plan documents: agent-authored HTML plans with a todo sidebar, live stage and status updates, comment anchors, and one-click task dispatch from the plan into CLI panes.
- Manual pane sessions for capturing terminal work outside a spawned agent.
- Status bar indicator for lingering CLI processes, with scan and reap actions.

### Changed

- Reduce keystroke echo latency in terminals with an adaptive output-flush fast path and focus-priority scheduling.
- Resolve CLI commands through an interactive login shell so PATH entries written by installers (for example `~/.local/bin` or Homebrew) are visible when the app is launched from Finder or the Dock.
- Refresh PATH from the login shell before spawning so newly installed CLIs are found without restarting the app.
- Improve npm-based dependency install detection during onboarding.

### Fixed

- CLI agents failing to launch in packaged builds because the backend inherited the GUI's restricted PATH.
- Spawn probe now degrades to a warning on timeout or transient errors instead of blocking the launch.
- Reap breakaway PTY processes that escaped group termination, preventing lingering CLI processes from accumulating.
- Agent history log preview reading the wrong path; the real log path is now stored and older entries are matched by filename across day folders.
- De-duplicate pane restore to avoid concurrent restore races.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.47] — 2026-07-17 — unsigned preview

### Added

- Serve XHTML files through the file preview backend.
- Loop auto-continue: loop status indicators (∞) in panes and the agent list, a configurable loop prompt in Settings, and automatic resume when a CLI session hits its usage limit.
- "General" tab and settings group in the Settings modal.

### Changed

- Handle dead WebSocket sessions gracefully in the backend.
- Handle subprocess timeouts in the terminal service.
- Prevent default browser behavior for terminal cursor shortcuts.
- Improve pane restore with rename stub handling.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.46] — 2026-07-16 — unsigned preview

### Changed

- Update rebuild logic to specifically target active tab CLI panes.
- Ensure focus continuity when marking items as seen in the UI.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.45] — 2026-07-16 — unsigned preview

### Changed

- Add `restoreMode` and `replacePaneId` to `spawnPane` to enable atomic pane replacement with focus continuity.
- Update pane rebuild logic to support `keepInList` during `onKill`.
- Refine terminal refit logic with `skipReattach` option for smoother layout transitions.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.44] — 2026-07-15 — unsigned preview

### Added

- Add log preview modal and improve terminal session handling.
- Add force option to kill terminal sessions.
- Add test scripts to simulate terminal input (`test_bp.exp`, `test_bp.js`, `test_pt.py`).

### Changed

- Improve PTY output handling with backpressure.
- Remove session check in `_drain` method for terminal sessions.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.43] — 2026-07-15 — unsigned preview

### Added

- Add inline pane renaming functionality to the UI.

### Changed

- Update test mocks to include `onResize` method for terminal tests.
- Fix CI build OOM issues by adjusting `NODE_OPTIONS`.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.42] — 2026-07-15 — unsigned preview

### Changed

- Refactor terminal UI: update terminal methods, fit logic, and temporarily disable auto-rebuild on resize to prevent unexpected CLI resumes.
- Update `spawnHistory` custom name logic to support session home normalization.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.41] — 2026-07-15 — unsigned preview

### Added

- Add a complete Japanese path for the public product and core user documentation.
- Add focused backend coverage for Claude hook installation and stop-hook payload forwarding.

### Changed

- Preserve Agent History custom titles when session-home paths require normalization.
- Support Command–Equal as an additional terminal zoom-in shortcut.
- Organize English, Traditional Chinese, and Japanese documentation under symmetric locale navigation.
- Update all supported-language download guidance to the v0.1.41 preview.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.40] — 2026-07-15 — unsigned preview

### Added

- Publish the first directly downloadable macOS arm64 preview through GitHub Releases.
- Add a complete Traditional Chinese path for the public product and core user documentation.
- Add regression coverage for token checkpoint rotation, persistence batching, shutdown ordering, and workspace replay.

### Changed

- Batch token metric persistence and serialize journal recovery so shutdown and lifecycle saves cannot be overwritten by older snapshots.
- Reset Codex and Grok ingestion checkpoints when their underlying log generation changes.
- Include recent rendered terminal context alongside durable CLI transcript references during handoff.
- Refine terminal zoom shortcuts and pane drag affordances.
- Update English and Traditional Chinese installation guidance with direct downloads and safe Gatekeeper instructions.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

### Documentation

- Reposition Navide as the engineering instrument for the Agent era: an AI-native environment for one engineer directing an AI engineering force.
- Add the Navide Manifesto and Product Vision.
- Define Genesis, Evolution, and Intervention as the three engineering loops.
- Define management by exception as the human-agent operating philosophy.
- Define `.agent-team/` as the local, per-user, Git-excluded Project Intelligence Layer.
- Replace the control-plane-only roadmap with a path toward complete professional IDE replacement through an Agent-era interaction model.
- Align supported agents with the current registry: Claude Code, Codex, Antigravity CLI, and Grok CLI.
- Replace fixed-stage claims with the configurable pipeline model and included workflow.
- Add and align the documentation index, getting-started guide, user guide, architecture, privacy and data flows, troubleshooting, and phased long-term roadmap.
- Correct repository clone commands, contribution checks, privacy claims, credential-storage statements, and release expectations.

## Development version history

The source tree reached package version `0.1.39` before the public release history was established. GitHub currently has no published Navide release, so versions in that range must not be represented as downloadable releases retroactively.

Future release entries should be added when a signed GitHub Release is published. Do not invent missing release notes from package-version bumps alone; reconstruct notable changes from commits and verification evidence as part of the first release preparation.

## [0.1.8] — 2026-06-01 — historical development snapshot

### Added

- Configurable SDLC pipeline with parallel agent slots
- Manager coordination protocol
- Local LLM analyzer and optional automatic answers
- Token usage tracking from supported CLI logs
- Context7 document injection
- Pipeline resume and workspace-scoped state
- Recent-workspace entry screen
- History timeline
- Role and stage management
- Claude Code lifecycle hooks
- Initial MIT-licensed open-source repository

`0.1.8` records a development milestone and was not a published GitHub Release.
