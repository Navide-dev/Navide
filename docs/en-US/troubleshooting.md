# Troubleshooting

English | [繁體中文](../zh-TW/troubleshooting.md) | [日本語](../ja-JP/troubleshooting.md) | [Documentation](README.md)

## The app does not start

1. Confirm Node.js 22.12+ (22.x), pnpm 10+, Python 3.12+, and uv 0.11+.
2. Reinstall locked dependencies:

   ```bash
   pnpm install --frozen-lockfile
   uv --project backend sync --locked
   ```

3. Start from a terminal with `pnpm dev` and inspect the first backend or Electron error.
4. Run `pnpm typecheck` to distinguish environment problems from source errors.

## Backend health stays unavailable

- Confirm another process is not blocking local loopback communication.
- Check whether operating-system security software (Gatekeeper, SmartScreen or Defender, an endpoint agent) denied the packaged Python backend.
- In development, run `uv --project backend run python -m agent_team_backend` separately to expose startup errors.

## An agent CLI is missing

- Run the CLI's version command in a normal interactive terminal.
- Restart Navide after installation so it receives the updated `PATH`.
- Complete the CLI's own authentication flow before spawning it in Navide.
- Confirm the executable name: Settings → CLI Agents lists every supported CLI, shows the resolved path of each detected one, and offers the vendor's install command for a missing one.

## A CLI reports that its own auto-update failed

A pane may show a vendor message such as `✘ Auto-update failed`. Several panes updating the same CLI at once can collide, because a CLI's installation directory is shared across every pane and profile.

- Open Settings → CLI Agents. A failed update is reported there with the time, the versions involved, and which config home recorded it.
- Use the update action on that row. It runs the CLI's own update command (for example `claude update`, `codex update`, `agy update`, `grok update`) in a terminal; Navide never updates a CLI itself. A CLI without an update subcommand links to its vendor documentation instead.
- Set Auto-update to Manual for that CLI if collisions repeat. Navide then passes the vendor's own opt-out variable to every spawn, and you update from this panel instead.
- A running session keeps the binary it started with; restart the pane after an update.

## A pane remains on “detecting session”

Codex, Antigravity, and Grok rely on log or database discovery to bind a new CLI session to a Navide pane.

For Codex, open `/hooks` to inspect pending hook reviews. An MCP startup failure or a third-party `SessionEnd` timeout warning needs separate investigation and does not by itself indicate a session ID collision. Codex 0.154 queues `SessionStart` for the first turn; opening the TUI alone does not guarantee that event has run.

Some Codex builds treat the `SessionStart` hook Navide passes on the command line as an unreviewed hook and raise **Hooks need review** on every pane. A version number does not say which do — 0.155 does not here, 0.154 was reported doing so — so Navide observes instead: the first pane that shows the screen records it, every later Codex pane opens without that hook, and the Pipeline Log says so.

- Navide does **not** write your `~/.codex/config.toml`, and does **not** pass `--dangerously-bypass-hook-trust` — that flag would also exempt the hooks in your own `hooks.json` from review.
- Dropping the hook costs only a shortcut for matching a pane to its session. Sessions are still identified from logs and markers, so nothing stops working.
- If the screen is already up, answer it for that pane (`2` = trust all and continue) or close the pane; it will not block again.

- Send a normal message so the CLI persists the pane marker.
- Confirm the CLI can write to its normal session directory.
- Do not immediately rebuild or resume before the first session is detected.
- If detection never completes, preserve the pane output and relevant backend log before filing an issue.

## Resume does not work

- Verify that the pane previously reached a detected session state.
- Confirm the original CLI still has the session in its own history.
- Check that the workspace path has not changed.
- A CLI upgrade may change resume syntax or session storage; include CLI and Navide versions in a bug report.

## Codex conversations are missing from History

- Codex rollout files in the pane's isolated `~/.codex-panes/<session_home_id>/sessions` directory are separate from Navide's history metadata. A missing History entry does not mean the original conversation file was deleted.
- History search covers loaded entries. Load more entries to continue searching older conversations, even when the current search has no results; content search runs again for the newly loaded entries.
- To resume a known conversation outside Navide, use its original `CODEX_HOME` and exact session ID. Do not choose the latest session when several conversations share that home.
- Detected session IDs are now saved by the backend before notifying the UI and preserved when later snapshots omit them. This does not automatically recover older entries whose session identity was already lost.
- A removed Codex entry with no **Session** line has no resume id, so History shows no **Resume** button. The common causes were a **Hooks need review** screen swallowing the session marker at startup and a restart that reopened the pane as a fresh conversation without one; both are fixed. The rollout still exists — find it by time and `cwd` under `sessions/` and run `codex resume <id>` with that `CODEX_HOME`.

## Token Stats is empty or duplicated

- Token tracking depends on provider log formats and only sees usage after the CLI writes compatible records.
- Confirm that Navide has associated the CLI session with the current workspace and pane.
- Compare with the provider dashboard for billing; Navide's display is operational telemetry.
- If duplication persists, report the CLI version, session ID if safe, and a redacted example record.

## Local analyzer is unavailable

- For Ollama, verify that the service is running and the configured model exists.
- For a GGUF model, verify the file path, architecture support, and available memory.
- Analyzer failure should degrade optional automation rather than prevent normal manual terminal use.

## macOS permissions block a workflow

Open **System Settings → Privacy & Security** and inspect Automation, Files and Folders, Accessibility, and Full Disk Access. Grant only permissions required for the specific CLI and workspace. Restart the affected application after changing permissions.

## Windows blocks the first launch

The Windows installer is not code-signed, so SmartScreen shows "Windows protected your PC" with the publisher listed as unknown. Choose **More info → Run anyway**. This is expected for every Navide installer until Windows code signing ships; it is not a sign of a tampered download — verify the file came from the GitHub release page if in doubt.

## The Linux AppImage does not start

- Make it executable first: `chmod +x Navide-<version>-x86_64.AppImage`. The AppImage bundles its own FUSE runtime, so no `libfuse` package is needed.
- If you installed the `.deb`, launch `navide` from a terminal to see the startup error; updates for that package come from `apt`, not the in-app updater.

## Copy and paste behave oddly in a terminal pane

- While a CLI has mouse reporting on, a plain drag is forwarded to the program and selects nothing. Hold **Option** (macOS) or **Shift** (Windows/Linux) while dragging to force a text selection.
- **Edit → Copy**, the pane's right-click **Copy**, and **⌘C / Ctrl+C** all copy the terminal selection. A terminal selection is invisible to the operating system, so a third-party accessibility or clipboard utility running in the background — Typeless and similar tools that intercept the Edit menu or the pasteboard — can swallow the copy. If a copy silently does nothing, quit that utility (or exclude Navide in **System Settings → Privacy & Security → Accessibility**) and try again.
- To insert a newline without submitting in a CLI pane, press **Shift+Enter**, **Ctrl+Enter**, or **⌘Enter**. In a plain shell pane only Shift+Enter does this — Ctrl+Enter keeps submitting, because that is what a shell expects. Plain Enter always submits.

## Context7 or documentation injection fails

Documentation injection is best-effort. Check the MCP configuration, package runtime, and network access. A failed fetch should not block a manual task; disable the integration if the workspace must remain offline.

## Git authentication prompts do not complete

- Verify the remote with `git remote -v`.
- Test the same fetch or push in a normal terminal.
- Prefer your existing SSH agent or credential-manager setup.
- Never paste access tokens into issue reports or terminal screenshots.

## Filing a useful bug

Include:

- Navide commit or version
- Operating system version and architecture
- Agent CLI name and version
- Reproduction steps
- Expected and actual behavior
- Redacted logs or screenshots

Use the repository's [bug report template](https://github.com/Navide-dev/Navide/issues/new?template=bug_report.yml). Report vulnerabilities privately according to the [Security Policy](../../SECURITY.md).
