# Navide

> **The engineering instrument for the Agent era.**
>
> One engineer. An entire AI engineering force.

Navide is an open-source, AI-native software engineering environment for one person directing multiple coding agents. It brings goals, agents, sessions, private project intelligence, engineering tools, and acceptance evidence into one local-first workspace.

It is not another chat panel inside the traditional IDE. Navide is being built as the environment that comes after it.

English | [繁體中文](README.zh-TW.md) | [日本語](README.ja-JP.md)

[Download v0.2.19](https://github.com/Navide-dev/Navide/releases/tag/v0.2.19) | [Getting started](docs/en-US/getting-started.md) | [Documentation](docs/en-US/README.md) | [Roadmap](docs/en-US/roadmap.md)

[![Latest release](https://img.shields.io/github/v/release/Navide-dev/Navide?sort=semver&label=release&logo=github)](https://github.com/Navide-dev/Navide/releases/latest)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](docs/en-US/getting-started.md)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## AI changed execution. Coordination is the new bottleneck.

The traditional IDE was designed for an engineer who personally performs most implementation work: open a file, write code, run a tool, repeat.

AI changes that premise. One engineer can now ask multiple agents to research, plan, implement, test, review, and refine software in parallel. The limiting problem moves from typing code to directing work:

- Which agent should own each outcome?
- What context and constraints does each session need?
- Where are sessions overlapping, waiting, or failing?
- When does a decision require human judgment?
- What evidence shows that the result is ready?

AI models provide the execution power. Navide provides the engineering system required to direct it.

```text
Traditional IDE
Engineer -> edits files and operates tools -> software

Navide
Engineer -> directs goals, agents, decisions, and evidence -> software
```

The engineer remains responsible for intent, architecture, risk, judgment, and final acceptance. Agents take on repeatable execution. Navide keeps the work visible, synchronized, interruptible, and recoverable.

## What Navide changes

### Direct the work

Turn an engineering goal into independent sessions, assigned roles, parallel execution, and configurable development stages. Navide supports multiple coding agents without forcing every task through one conversation.

### Keep project intelligence

Carry workspace-scoped state, prior runs, session information, handoffs, and history across individual agent conversations. Private project intelligence stays under `<workspace>/.agent-team/` and is excluded from Git.

### Intervene where judgment matters

Let reversible work continue while it remains visible. Return the engineer's attention when ambiguity, risk, conflict, external impact, or an irreversible decision makes human judgment valuable. Use Diff, editor, terminal, diagnostics, Git, tests, and review for precise intervention.

## One environment, three engineering loops

### Genesis — idea to first working form

Start a new project through a configurable pipeline covering requirements, planning, design, implementation, security review, and testing. Multiple agent slots can work in parallel while context moves between stages.

### Evolution — continuous product development

Develop features, fix defects, run tests, tune behavior, and maintain an existing project through coordinated sessions. This repeated Evolution loop—not a one-time generation flow—is the center of daily engineering work.

### Intervention — precise human control

Inspect and change results directly when necessary. Editing remains a first-class professional capability, but it becomes one mode of control inside a larger engineering system rather than the only way software work moves forward.

## Navide builds Navide

Navide is already the primary development environment used by its founder to evolve this project.

New projects begin from requirements and a Pipeline. Daily product work happens through multiple agent sessions for implementation, testing, correction, review, and refinement. The integrated mini IDE is opened selectively to inspect results or make precise edits.

This is first-party dogfooding evidence, not independent customer validation. The next proof must come from other engineers using Navide on their own real projects.

## Available today

- **Multi-agent workspaces:** run any of 14 supported coding CLIs — Aider, Antigravity CLI, Claude Code, Codex, Copilot CLI, Cursor CLI, Droid, Grok CLI, Kilo Code, Kimi Code, Muse Code, OpenCode, Pi, Qwen Code — or a plain terminal, each in its own pane.
- **CLI management:** detect installed coding CLIs, their versions and install methods, and run each CLI's own official update and diagnostic commands.
- **Session lifecycle:** detect, persist, rebuild, and resume supported CLI sessions.
- **Configurable pipelines:** define stages, parallel slots, agents, roles, kickoff prompts, questions, documentation queries, and completion sentinels.
- **Manager coordination:** route structured dispatches and worker questions and carry context across stages.
- **Automation controls:** combine terminal activity, provider logs, hooks, and optional local analysis through Manual, Strict, Continuous, Full Auto, and YOLO modes.
- **Private project history:** retain workspace-scoped state, run events, handoffs, and compatible token summaries under `.agent-team/`.
- **Engineering surfaces:** explore and edit files, inspect plans and diffs, resolve conflicts, use terminals, Git and multi-repository workflows, handle issues, review changes, and use the embedded AI terminal.
- **Observability:** inspect History and compatible CLI token usage by workspace, stage, pane, and run.

## Available today and the destination

Navide has a working local-first foundation, but the complete Agent-era environment is a long-term product direction.

| Available today | Product direction |
|---|---|
| Independent coding-agent and terminal sessions | Intent-driven task and dependency orchestration |
| Configurable multi-stage Pipelines | Adaptive Genesis and continuous Evolution workflows |
| Local workspace state and history | An inspectable, controllable Project Intelligence Layer |
| Manual and analyzer-assisted automation controls | Complete policy-driven management by exception |
| Editor, Diff, terminal, Git, tests, and review surfaces | Full professional delivery without another IDE as the primary environment |

Product direction describes intent, not currently shipped behavior or a delivery-date promise. See the [Product Roadmap](docs/en-US/roadmap.md) for scope and exit criteria.

## Private by default, honest about boundaries

Navide's orchestration process, private project intelligence, and workspace state run locally. Navide does not operate a project telemetry service or require a Navide account.

Local-first does not mean universally offline. External agent CLIs, cloud AI providers, Context7, search, Git hosting, MCP servers, and update checks may communicate with third parties when used. Agents normally inherit the current user's operating-system permissions, and Navide does not yet provide a complete workspace sandbox.

Read [Privacy and Data Flows](docs/en-US/privacy.md) and the [Security Policy](SECURITY.md) before using sensitive code, credentials, YOLO, or Full Auto.

## Try Navide

Navide supports macOS 13+ on Apple silicon, Linux x64, and Windows on x64 or Arm. The v0.2.19 release ships macOS builds signed with a Developer ID certificate and notarized by Apple, plus Windows x64 and Arm64 installers and Linux x64 packages:

- [Download DMG](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-arm64.dmg) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-arm64.dmg))
- [Download ZIP](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-arm64.zip) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-arm64.zip))
- [Download Windows x64 installer](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-win-x64.exe) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-win-x64.exe))
- [Download Windows Arm64 installer](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-win-arm64.exe) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-win-arm64.exe))
- [Download Linux AppImage](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-x86_64.AppImage) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-x86_64.AppImage)) · [Download Linux .deb](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-amd64.deb) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-amd64.deb))

Links go to dl.navide.dev, the same host the app updates itself from; the *GitHub* link beside each one is the same file, byte for byte, on the GitHub Release (the release workflow publishes both and checks their checksums match).

Copy Navide to Applications and open it normally — no Gatekeeper workaround is needed. In-app auto-update is available from this release onward.

Linux and Windows run the same CI gates as macOS. The Windows build is not code-signed yet, so SmartScreen warns on first run, the Executions window has nothing to list there by design (it reads the user crontab and macOS launchd; Windows Task Scheduler is deliberately not integrated, since Navide never creates scheduled jobs of its own and Task Scheduler already manages the machine's tasks), per-pane CLI homes and managed skills need Windows Developer Mode or an elevated Navide because they are built from symbolic links, and a CLI is terminated rather than asked to stop, so it may not flush its transcript before a pane closes.

For a development checkout, install from source instead.

### Source prerequisites

- Node.js 22.12+ (22.x) and pnpm 10+
- Python 3.12+ and uv 0.11+
- At least one supported coding CLI
- Optional: Ollama or a local GGUF model for analysis

### Install from source

```bash
git clone https://github.com/Navide-dev/Navide.git
cd Navide
pnpm install
uv --project backend sync
pnpm dev
```

The onboarding wizard checks runtimes, detects agent CLIs, and explains relevant macOS permissions. Continue with [Getting Started](docs/en-US/getting-started.md) and the [User Guide](docs/en-US/user-guide.md).

## Documentation and deeper reading

- **Use Navide:** [Getting started](docs/en-US/getting-started.md), [User guide](docs/en-US/user-guide.md), and [Troubleshooting](docs/en-US/troubleshooting.md)
- **Understand the product:** [Manifesto](docs/en-US/manifesto.md), [Vision](docs/en-US/vision.md), [Positioning](docs/en-US/product-positioning.md), and [Roadmap](docs/en-US/roadmap.md)
- **Review the boundaries:** [Privacy and data flows](docs/en-US/privacy.md) and [Security policy](SECURITY.md)
- **Explore everything:** [English documentation index](docs/en-US/README.md) or [language gateway](docs/README.md)

## License

MIT © Navide Team
