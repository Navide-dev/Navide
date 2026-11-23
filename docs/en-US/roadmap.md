# Product Roadmap

English | [繁體中文](../zh-TW/roadmap.md) | [日本語](../ja-JP/roadmap.md) | [Documentation](README.md)

Navide's long-term direction is to become **the engineering instrument for the Agent era**: the primary environment in which one engineer directs an AI engineering force through the complete software lifecycle.

The destination is larger than a multi-agent terminal manager or control plane. An engineer should eventually be able to understand, create, navigate, edit, run, debug, test, review, version, and deliver software without returning to a traditional IDE as the primary working environment.

This roadmap is directional. It does not promise dates or claim that future capabilities have shipped. Released behavior belongs in [CHANGELOG.md](../../CHANGELOG.md); current behavior belongs in the [User Guide](user-guide.md); the underlying purpose belongs in the [Manifesto](manifesto.md) and [Product Vision](vision.md).

## North star

```text
Engineer defines an outcome
  → Navide recovers private project intelligence
  → the right agents and sessions are assembled
  → work is decomposed, owned, and synchronized
  → agents execute in parallel within visible boundaries
  → Navide detects conflicts, risks, and meaningful exceptions
  → tests, reviews, and evidence converge on a result
  → the engineer intervenes precisely where judgment matters
  → the result is accepted and becomes context for the next evolution
```

The user remains responsible for intent, lasting decisions, credentials, destructive actions, external publication, and final acceptance.

## Product principles

1. **One engineer, an AI engineering force** — optimize the complete system for an individual directing many agents, not for reproducing a traditional human organization chart.
2. **Outcomes before keystrokes** — the primary unit of work is a goal with acceptance evidence, while files and edits remain first-class implementation artifacts.
3. **Evolution is the center** — project creation matters, but repeated feature, fix, test, and refinement loops dominate real engineering work.
4. **Management by exception** — routine reversible work should continue without approval noise; ambiguity, risk, conflict, external impact, and irreversible actions should return to the engineer.
5. **Private project intelligence** — `.agent-team/` is local, per-user, excluded from Git, inspectable, controllable, and never an implicit team or cloud synchronization layer.
6. **Autonomous but not opaque** — work must remain visible, interruptible, recoverable, and accountable through evidence.
7. **Complete engineering capability** — Navide must eventually cover the professional workflow required to replace the traditional IDE, while reinterpreting that workflow for the Agent era.
8. **Provider independence** — agent and model capabilities should be explicit rather than hidden behind assumptions about one vendor.

## Today and destination

| Area | Today | Destination |
|---|---|---|
| Genesis | Configurable SDLC pipeline graph with parallel stages, approval gates, bounded reject loops, pinned nodes and restart-from | Adaptive creation workflow producing a validated initial system and durable project intelligence |
| Evolution | Manual panes and maintenance tasks | Intent-driven daily workspace coordinating multiple owned, dependent sessions |
| Intervention | Monaco, Diff, terminal, Git, diagnostics, review | Complete navigation, editing, execution, debugging, testing, review, versioning, and delivery environment |
| Coordination | Manager protocol, handoffs, history, session attribution | Structured shared state, ownership, dependency, conflict, and progress synchronization |
| Memory | Project state, runs, history, tokens | Versioned private Project Intelligence model for tasks, decisions, handoffs, evidence, and recovery |
| Autonomy | Manual toggles, analyzer, Full Auto, YOLO, timeouts | Policy-driven management by exception with explicit authority and escalation |
| Delivery | Git, issues, review, commit-related workflows | Traceable outcome-to-change-to-test-to-release lifecycle |

## Horizon 0 — Establish the instrument

**Outcome:** users can understand the new engineering model, install Navide, and evaluate it safely.

Scope:

- Manifesto, product vision, accurate current-capability documentation, architecture, privacy, and roadmap
- Canonical product naming and supported-agent information
- Repeatable signed macOS release and updater validation
- Guided first project and first Evolution task
- Product demonstration centered on agent coordination rather than editor novelty

Exit criteria:

- A new user can explain Genesis, Evolution, Intervention, and private Project Intelligence
- A clean supported Mac can complete the documented installation and first-run workflow
- The first signed GitHub Release contains all required updater assets
- Documentation distinguishes current behavior from future direction

## Horizon 1 — Reliable session fabric

**Outcome:** multiple agent sessions behave like a dependable local engineering force rather than unrelated terminal windows.

Scope:

- Explicit lifecycle states for preparing, ready, working, waiting, blocked, failed, completed, interrupted, and resumable sessions
- Durable session identity, provider binding, rebuild, resume, and crash recovery
- Structured session presence, ownership, progress, blockers, questions, and completion events
- Clear distinction between raw terminal activity and engineering state
- Reliable input delivery, cancellation, retry, timeout, and recovery semantics
- Local diagnostics that explain why a session cannot progress or resume

Exit criteria:

- Representative sessions survive application restart without silent state loss
- Session identity and ownership remain stable across supported resume flows
- Every automatic lifecycle transition has a visible cause
- A failed session offers a recoverable action or an actionable diagnostic

## Horizon 2 — Private Project Intelligence Layer

**Outcome:** each new session can inherit the engineer's accumulated understanding of the project without replaying every conversation.

Scope:

- Versioned local schema for project state, sessions, runs, tasks, decisions, handoffs, evidence, and coordination metadata
- Clear separation between derived state, durable knowledge, raw logs, caches, and secrets
- Structured facts and decisions with source and freshness metadata
- Context assembly based on the current goal rather than indiscriminate history injection
- Retention, compaction, deletion, redaction, backup, and explicit local export/import
- Inspectable UI showing what Navide remembers and what a session will receive

Exit criteria:

- A resumed or replacement session receives the relevant goal, constraints, decisions, and evidence without manual transcript copying
- Users can inspect and delete remembered information
- `.agent-team/` remains excluded from Git and no private state is synchronized implicitly
- Schema migration and corruption recovery are tested
- Context selection avoids silently treating stale agent output as current project truth

## Horizon 3 — Evolution Workspace

**Outcome:** daily feature development, fixes, tests, tuning, and maintenance become a coherent intent-driven loop.

Scope:

- Replace the idea of maintenance as an afterthought with a first-class Evolution workspace
- Goals with scope, acceptance criteria, priority, dependencies, and evidence requirements
- Navide-proposed session composition that the engineer can edit
- Task ownership, dependency graph, parallel scheduling, and partial retry
- File, module, repository, and environment scope awareness
- Conflict prevention or early warning for overlapping agent work
- Continuous loop from goal through implementation, tests, repair, review, and acceptance
- Checkpoints that allow an Evolution run to be forked or resumed

Exit criteria:

- An engineer can start the next feature without constructing every session manually
- Independent tasks execute in parallel while dependencies wait deterministically
- Overlapping ownership is visible before destructive integration
- Failed nodes can retry without restarting successful independent work
- The accepted result becomes context for the next Evolution goal

## Horizon 4 — Management by exception

**Outcome:** Navide protects the engineer's attention without surrendering control.

Scope:

- Explicit authority profiles for exploration, workspace edits, commands, tests, network access, credentials, Git publication, deployment, and unrestricted execution
- Exception model for ambiguity, conflict, failed evidence, protected resources, external impact, budget limits, and irreversible actions
- Consolidated decision queue instead of independent prompts from every session
- Manager and peer coordination that can resolve routine questions before escalation
- Secret detection and redaction before handoff, cloud requests, diagnostics, and export
- Workspace and protected-path isolation using platform capabilities where enforceable
- Complete audit trail for policy, escalation, override, and acceptance decisions

Exit criteria:

- Routine reversible workflows can complete without approval fatigue
- Sensitive or irreversible actions cannot proceed outside the effective policy
- Every escalation explains the decision, available evidence, consequences, and recommended next step
- Handoff and diagnostic redaction pass adversarial tests
- Unsupported sandbox guarantees are stated honestly for every platform and agent

## Horizon 5 — Complete Intervention environment

**Outcome:** an engineer can perform every precision task required to understand and change software without another IDE as the primary environment.

Scope:

- Fast project navigation, global search, symbol search, references, and code intelligence
- Robust Monaco editing, multi-file operations, diagnostics, refactoring, formatting, and language-server integration
- Integrated run configurations, tasks, test discovery, test results, logs, and interactive terminals
- Debugging with breakpoints, stack and variable inspection, evaluation, and agent-readable debug evidence
- First-class Diff, branch comparison, conflicts, history, blame, and review
- Git branches, worktrees, commits, remotes, pull requests, checks, and review feedback
- Extension points for languages, tools, debuggers, test systems, and engineering views
- Performance, accessibility, keyboard control, and large-workspace reliability

Exit criteria:

- Target users complete representative professional projects without opening another IDE for a missing core capability
- Intervention preserves context and returns cleanly to coordinated agent execution
- Agents and humans can reference the same diagnostics, tests, symbols, diffs, and debug evidence
- Large repositories remain responsive under defined performance budgets

This horizon does not require copying every traditional IDE interaction. It requires outcome parity through a better Agent-era model.

## Horizon 6 — Verifiable Genesis and delivery

**Outcome:** a product can move from initial intent to continuous delivery through one traceable engineering environment.

Scope:

- Adaptive Genesis workflow that produces requirements, architecture, implementation, tests, and an explicit first Evolution backlog
- Immutable run manifest connecting intent, repositories, base revisions, agents, policies, actions, artifacts, and evidence
- Provenance from requirement to task, change, test, review, commit, and release
- GitHub issue and pull-request intake with repository and permission preflight
- Intentional branch, commit, push, draft-PR, check, review, and follow-up flows
- Build, packaging, deployment, and release gates with explicit human authority
- Reproducible run export and fork-from-checkpoint behavior

Exit criteria:

- A new product can enter Genesis and emerge as a tested prototype with an Evolution-ready project model
- An accepted goal can produce a draft PR with linked evidence and explicit user approval
- Failed checks and review feedback become scoped follow-up work
- External writes, deployment, and release never occur through ambiguous authority
- Exported run evidence can be inspected without the original live sessions

## Horizon 7 — Agent, platform, and ecosystem maturity

**Outcome:** Navide remains durable as models, agents, languages, tools, and operating systems change.

Scope:

- Declarative adapter contract for agent identity, installation, capabilities, permissions, launch, readiness, resume, interruption, session discovery, and usage
- Compatibility test kit and adapter health diagnostics
- Reusable roles, pipelines, policies, team configurations, and engineering templates
- Safe template packaging with version and capability metadata
- Linux support with PTY, paths, permissions, packaging, and update parity — in `main`, covered by the Linux CI gates and shipped as an AppImage and a `.deb` for x64 since v0.2.2; remaining work is publishing the arm64 build, which release CI currently produces only on a manual dispatch
- Windows support with ConPTY, filesystem behavior, packaging, and policy parity — in `main`, covered by the Windows CI gates and shipped as an NSIS installer for x64 since v0.2.2; remaining work is code signing and a graceful CLI shutdown signal. Task Scheduler integration is not planned: Navide never creates scheduled jobs of its own, and Task Scheduler already lists, enables, disables and removes the machine's tasks. Revisit only if Navide starts registering tasks itself — then as a third execution kind over the PowerShell `ScheduledTasks` module
- Platform and adapter capability matrix
- Internationalization and accessible workflows

Exit criteria:

- A simple agent can be integrated without editing core pipeline UI logic
- Built-in adapters pass a shared compatibility suite
- Templates cannot execute code or grant authority implicitly
- Platform CI covers unit, integration, packaging, terminal, editor, and representative Evolution workflows
- Unsupported capabilities are visible before execution

## Cross-cutting quality gates

Every horizon must address:

- Backward-compatible local state or an explicit migration path
- Threat model and privacy-data-flow changes
- Unit, integration, and end-to-end coverage proportional to risk
- Recovery, diagnostics, and user-controlled deletion
- Performance, storage, accessibility, and internationalization
- Current-capability documentation and release notes
- Clear human authority for credentials, destructive operations, external writes, deployment, and publication

## Measures of progress

Navide does not currently collect product telemetry. Measures should come from local reports, tests, opt-in diagnostics, or explicitly shared issue data unless a future privacy-reviewed telemetry design is adopted.

Useful measures include:

- Engineers using Navide as their primary daily environment
- Time from opening a workspace to starting a healthy Evolution goal
- Session binding, rebuild, resume, and recovery success
- Parallel sessions completed without ownership conflict or manual context copying
- Exceptions that required human judgment versus routine approval prompts avoided
- Goals completed with linked changes, tests, review, and evidence
- Time spent directing and accepting work versus repairing orchestration failures
- Traditional IDE exits required to complete a representative workflow
- Secrets prevented from entering handoffs, cloud requests, or exported artifacts

## The destination

Navide is complete in its ambition when an engineer can begin with an idea, assemble and direct an AI engineering force, evolve the product continuously, intervene with precision, and deliver trustworthy software—while the traditional IDE is no longer the center of the work.
