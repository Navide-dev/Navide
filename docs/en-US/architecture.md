# Architecture

This document describes the product model and stable ownership boundaries in the current Navide application. For the underlying beliefs, see the [Manifesto](manifesto.md). For historical implementation milestones, see [spec.md](spec.md). For future direction, see [roadmap.md](roadmap.md).

## Product architecture

Navide is an AI-native engineering environment for one engineer directing multiple coding agents. The orchestration control plane is a core subsystem, not the complete product identity.

The product is organized around three engineering loops:

```text
Genesis
Idea → requirements → plan → design → implementation → review → tests → prototype

Evolution
Goal → coordinated sessions → changes → tests → correction → verified result → next goal

Intervention
Observe → inspect evidence → edit / command / redirect → resume coordinated execution
```

Genesis creates the first working form. Evolution is the everyday center of development. Intervention preserves precise human control throughout both.

### Management by exception

The engineer owns intent, constraints, lasting decisions, external or irreversible actions, and final acceptance. Agents own execution inside approved boundaries. Navide owns session lifecycle, synchronization, visibility, recovery, and returning meaningful exceptions to the engineer.

The intended behavior is highly autonomous but not opaque: continuous execution, continuous visibility, immediate interruption, and evidence-backed accountability.

## System context

Navide is a desktop engineering environment built around external coding-agent CLIs and local engineering tools. It does not host the foundation models used by those CLIs and does not replace their authentication, billing, sandbox, or data policy.

```text
User and workspace
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Navide desktop application                               │
│                                                          │
│ Electron main ── IPC ── Vue renderer ── WS/HTTP ── Python│
│                                                          │
└──────────────────────────────────────────────────────────┘
        │ PTY, files, Git, local logs, MCP, model requests
        ▼
External agent CLIs, local models, cloud providers, and Git hosts
```

## Process boundaries

### Electron main process

The Electron main process owns operating-system integration:

- Application and window lifecycle
- Preload bridge and renderer IPC
- Python backend process startup and health supervision
- Native file dialogs, menus, permissions, and dock behavior
- Separate editor and management windows
- In-app update state and release checks

The renderer must not receive unrestricted Node.js access. Native operations should cross the preload boundary through narrow, typed APIs.

### Vue renderer

The renderer owns interactive application state and workflow presentation:

- Workspace entry and recent-workspace UI
- Pane layouts, terminal rendering, and user input
- Pipeline state machine and stage activation
- Manager/worker protocol parsing and routing
- Settings, roles, pipelines, MCP, and analyzer controls
- Explorer, Monaco editor, Git, issues, review, AI terminal, history, and token views

Renderer composables communicate with the backend through correlated WebSocket requests and broadcast events. Terminal display state is distinct from the underlying PTY state.

### Python FastAPI backend

The backend owns long-running local services and persistence:

- PTY creation, input buffering, resize, output batching, and session registry
- Workspace project state and recent workspaces
- File, Git, issue, review, and editor services
- Agent CLI log readers, session attribution, activity events, and token usage
- Local analyzer and optional model-provider calls
- MCP lifecycle and Context7 document injection
- Claude Code hooks and backend event ingestion
- Run history, UI settings, roles, and pipeline definitions

The backend listens on loopback and is supervised by Electron. It is not intended to be exposed as a network service.

### Windows and workspaces

A window holds one or more workspaces and displays one of them at a time. The
distinction matters because the three processes answer different questions
about them:

- **Electron main** knows which window holds which workspaces, and is the
  authority on "is this folder already open?". A folder open in two windows
  would run two sets of PTY and Git operations against one checkout, so a
  second request to open one is redirected to the window that already has it.
- **The renderer** owns the order they are listed in and which one is on
  screen. Switching changes only the latter: the panes of the others keep
  running, keep their entries in the sidebar, and are simply not drawn.
- **The backend** is per workspace throughout — project state, run groups,
  history and pane records are all keyed by workspace path, and a pane records
  the workspace it was started in. Nothing there changed to support several per
  window.

Two consequences worth stating, because both have been implemented the wrong
way at least once:

- Anything acting on *one pane* must use that pane's workspace, not the one on
  screen. Anything acting on *the workspace* — rebuild-all, close-all, pane
  order — is scoped to the one on screen, since its control sits on that
  workspace's row.
- Leaving a workspace and switching away from it are different operations.
  Leaving returns it to a clean slate; switching must not disturb it at all.

A detached window is one run group's view of a single workspace and does
neither of these.

## Runtime workflow

### Evolution session

```text
User defines an engineering outcome and selects or accepts an agent and role
  → renderer builds spawn request
  → backend starts PTY with CLI command
  → renderer waits for CLI readiness
  → role and task are injected
  → log reader binds the provider session when available
  → output, activity, history, and token events update the UI
  → additional sessions can be coordinated in parallel
  → tests, corrections, and evidence converge on a result
```

The current manual-spawn and maintenance flows are early implementations of this Evolution loop.

### Genesis pipeline

```text
Task description
  → load configurable stages and slots
  → pre-spawn eligible agent panes
  → activate current stage with prior-stage context
  → run slots in parallel
  → collect questions, analyzer signals, and completion sentinels
  → manager routes work when configured
  → persist handoff and advance
  → produce a first working form and enter continuous Evolution
```

Completion is a workflow signal, not proof that generated code is correct. Git review and explicit verification remain quality gates.

## Persistence boundaries

### Private Project Intelligence Layer

`.agent-team/` is the local, per-user intelligence layer for a workspace. Today it contains project state such as pipeline progress, run history, and token summaries. Its future model may include structured tasks, decisions, handoffs, evidence, and session-coordination metadata.

It has a strict boundary:

- Private to the individual Navide user
- Stored inside the local workspace
- Excluded from Git
- Not a human-team synchronization mechanism
- Separate from repository-owned source and shared documentation
- Portable only through a future explicit export/import operation
- Subject to deletion, retention, and redaction controls

Files under this directory can include task descriptions and agent output; treat them as private project data.

### Repository-shared project truth

Source code, tests, configuration, and explicitly authored project documents remain the team-visible truth shared through Git. Information from private project intelligence becomes shared only through an intentional artifact such as a specification, decision record, test report, commit, issue, or pull request.

### Application-scoped

The application data directory contains registries and preferences such as roles, pipeline definitions, recent workspaces, analyzer settings, token attribution metadata, and optional AI provider credentials.

### Provider-owned

Supported coding CLIs, Git clients, model runtimes, and MCP servers retain their own configuration, sessions, credentials, logs, and caches. Navide reads selected provider-owned logs or databases for session attribution and usage reporting.

## Agent integration boundary

An agent integration is declared per vendor rather than threaded through the application. One spec file on each side — `backend/agent_team_backend/cli_vendors/<key>.py` and `src/renderer/src/platform/plugin-shell/agents/<key>.ts` — declares that CLI's credentials, usage interface, resume syntax, session paths, spawn environment, log reader and install entry, and one registration line on each side publishes it. Shared modules read the registry instead of branching on the agent key, and a vendor module may not import another vendor or any application module.

A capability the spec leaves undeclared is treated as unsupported for that vendor and degrades gracefully; it never falls back to another vendor's behavior. This keeps a partial integration honest — a CLI can ship with spawning and install detection while resume, log reading and credential switching stay visibly unavailable until they are verified against a real installation.

See [Adding a CLI vendor](../adding-a-cli-vendor.md) for the procedure, and the [CLI Integration Records](cli-extension-guide.md) for per-vendor integration records. Credential-vault behavior is the remaining surface that vendor files cannot fully declare.

## Session synchronization direction

Multi-session work must evolve beyond copying terminal output between panes. The shared local coordination model should let a session discover:

- Its assigned goal, scope, dependencies, and acceptance criteria
- Which other sessions exist and what they own
- Current progress, blockers, questions, and handoffs
- Files, modules, or repositories at risk of conflicting changes
- Project decisions and verified facts relevant to the task
- Tests and evidence required before completion

Sessions should publish structured progress back to the Project Intelligence Layer while preserving raw provider output for diagnosis. A manager may coordinate complex work, but it should not be the only place where shared state exists.

## Trust boundaries

- External agents can execute commands with the current user's permissions.
- YOLO mode can remove external CLI approval or sandbox gates.
- Cloud providers and MCP servers receive data according to the selected feature and configuration.
- Cross-agent handoffs can propagate sensitive text.
- Local API-key file permissions are defense in depth, not a secret vault.
- Git history and run artifacts can preserve data after a working file is deleted.

See [Privacy and Data Flows](privacy.md) and [SECURITY.md](../../SECURITY.md).

## Git v2 process boundary and recovery

The production Git v2 package runs in an isolated plugin renderer. Its Git and
Issue requests cross a narrow Host-owned bridge to Electron main and then the
local backend; the package never receives a generic backend route, a terminal
surface, or a Git credential.

Git account credentials are bound by the Host to one canonical HTTPS hostname.
The Host sends a credential only for that destination, and the backend asks
again which HTTPS host Git is prompting for before it answers. Picker-selected
paths use short-lived, per-instance, one-time Host grants. A clone grant permits
only one safe direct child of the chosen directory; a successful clone creates
the separate grant required to open its exact result as a workspace.

Git events are routed by Host-owned workspace and instance identity, so one
view cannot refresh another workspace. Plugin Storage owns Git preferences and
the selected repository value; older project/local values are read-only runtime
seeds and never replace a newer storage value.

Git uses the same installed Manifest, catalog, exact-version grant, instance,
and capability runtime as third-party packages. Until Marketplace acquisition
is available, the App ships a factory `navide.git` package and activates it on a
fresh profile. A verified Marketplace version takes precedence. Removing the
factory package records a durable opt-out; restart does not reinstall it, and
the Navide Plugins view is the only place that restores it.

Electron main tries the selected v2 descriptor first. A load, mount, or ready
failure retires the whole v2 Git package and selects the retained legacy
descriptor for the remainder of that process. Trust, signature, revocation,
grant, and capability denials fail closed without fallback. An installed
`navide.git` directory that fails validation also remains a visible hard
failure instead of being hidden by the factory or legacy copy.
`NAVIDE_GIT_RECOVERY=legacy` forces the recovery descriptor before activation.
Neither recovery path mutates Plugin Storage snapshots or legacy seeds. This
is a compatibility recovery path, not a generic version lifecycle.

## Architectural direction

Long-term architecture work must turn the current control plane and engineering surfaces into a complete AI-native engineering environment. It should not copy traditional IDE interfaces uncritically, but it must eventually cover the full professional workflow. The primary seams are:

1. A declarative agent-adapter contract
2. A durable orchestration event and artifact model
3. Policy-controlled tool execution and workspace isolation
4. Dependency-graph scheduling beyond a fixed linear pipeline
5. Connectors that turn external work items into reviewable delivery runs
6. Integrated navigation, editing, execution, debugging, testing, review, versioning, and delivery
