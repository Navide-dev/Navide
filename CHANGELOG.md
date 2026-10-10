# Changelog

All notable released changes to Navide will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
