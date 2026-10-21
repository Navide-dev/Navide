# Getting Started

English | [繁體中文](../zh-TW/getting-started.md) | [日本語](../ja-JP/getting-started.md) | [Documentation](README.md)

Navide supports macOS 13 or newer on Apple silicon, Linux x64, and Windows on x64 or Arm. The [latest GitHub release](https://github.com/Navide-dev/Navide/releases/latest) provides DMG and ZIP downloads for macOS, signed with a Developer ID certificate and notarized by Apple, NSIS installers for Windows x64 and Arm64, and an AppImage and a `.deb` for Linux x64. If a GitHub download stalls or fails, the same files are served from the dl.navide.dev mirror — the README's download list carries a *mirror* link beside every file, and navide.dev switches to it automatically when it is reachable.

To install on macOS, download the DMG and copy Navide to Applications, then open it normally — no Gatekeeper workaround is needed.

The Windows build is not code-signed, so SmartScreen warns on first run.

## Install on Windows

Download `Navide-<version>-win-x64.exe` (or `Navide-<version>-win-arm64.exe` on Windows on Arm) from the release and run it. The installer is not code-signed, so SmartScreen shows "Windows protected your PC" on first run: choose **More info → Run anyway**. Code signing for Windows is deferred, so expect this prompt on every new installer until it ships. In-app updates work on Windows, but they install without signature verification for the same reason.

## Install on Linux

Two packages are published for x64:

- **AppImage** — `chmod +x Navide-<version>-x86_64.AppImage`, then run it. It carries its own FUSE runtime and updates itself through the in-app updater.
- **`.deb`** — `sudo apt install ./Navide-<version>-amd64.deb`. It installs to `/opt/Navide/navide` with a `navide` command on `PATH` and a desktop entry; updates come through the package manager, not the in-app updater.

## What you need to install from source

- macOS 13+ on Apple silicon, Linux x64, or Windows on x64 or Arm
- Bun (the version pinned in `.bun-version`); Node.js is not needed for daily development; pnpm 10.x is needed only for one test in the full `bun run test:run` (see “Development checks”)
- Python 3.12+
- uv 0.11+
- At least one of the 14 supported coding CLIs (Aider, Antigravity CLI, Claude Code, Codex, Copilot CLI, Cursor CLI, Droid, Grok CLI, Kilo Code, Kimi Code, Muse Code, OpenCode, Pi, Qwen Code) — the [User Guide](user-guide.md#manual-agent-panes) lists them
- Optional: Ollama or a local GGUF model for local analysis
- On Windows: Developer Mode (**Settings → For developers**) or running Navide elevated, so it can create the symbolic links behind per-pane CLI homes and managed skills

Each coding CLI has its own installation, authentication, subscription, and data policy. Navide does not replace those requirements.

## Install from source

```bash
git clone https://github.com/Navide-dev/Navide.git
cd Navide
bun install
uv --project backend sync
bun run dev
```

`bun run dev` starts the Electron application, Vite renderer, and Python FastAPI backend together.

## First launch

The onboarding wizard checks the required runtimes and detects available agent CLIs. Complete these steps:

1. Resolve any blocked foundation dependency.
2. Confirm that at least one coding CLI is available and authenticated.
3. Configure a local analyzer if you want intent detection and automatic answers.
4. On macOS, grant only the permissions needed by the workflows you use.
5. Open a trusted project folder as the workspace.

On macOS, Navide may request Automation, Files and Folders, or Full Disk Access depending on how agents and terminals interact with the workspace. Review the reason shown by macOS before granting a permission. Windows and Linux have no equivalent prompts.

After onboarding, Settings → CLI Agents lists every detected CLI with its version, install method, and last update result, and runs that CLI's own update and diagnostic commands.

## Run a first task

For the smallest successful test:

1. Open a disposable or version-controlled workspace.
2. Spawn one agent manually.
3. Give it a read-only task such as “summarize this repository.”
4. Confirm that terminal output, session detection, and History update.
5. Review Token Stats if the CLI exposes compatible usage logs.

After the manual flow works, try a pipeline with a small task. Review stage definitions and disable YOLO or Full Auto until you understand their effects.

## Development checks

```bash
bun run typecheck
bun run test:run
uv --project backend run pytest backend/tests
```

Run the frontend tests with `bun run test:run`, never with bare `bun test`: that runs Bun's own test runner instead of Vitest and ignores the project's Vitest configuration. Do not use `bun run test` either; it starts Vitest in watch mode. The full `bun run test:run` includes `src/main/plugins/pluginExternalWorkspace.test.ts`, which simulates an external plugin author who uses pnpm: it needs a real pnpm 10.x on `PATH` and fails with `Executable not found in $PATH: "pnpm"` without one (it is not skipped). Do not mix `bun install` and `pnpm install` in one `node_modules`.

See [Troubleshooting](troubleshooting.md) if the app, backend, CLI, session binding, analyzer, or token tracking does not start as expected.
