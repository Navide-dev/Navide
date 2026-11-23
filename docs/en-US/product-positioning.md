# Product Positioning and Public Claims

English | [繁體中文](../zh-TW/product-positioning.md) | [日本語](../ja-JP/product-positioning.md) | [Documentation](README.md)

This document keeps Navide's public story consistent across the README, website copy, demonstrations, release notes, presentations, and community posts. It is a communication reference, not a substitute for the user guide, roadmap, or release history.

## Category

Navide is an **AI-native software engineering environment** and **the engineering instrument for the Agent era**.

It is not positioned as another code editor, terminal multiplexer, IDE plug-in, or AI chat panel. Those may be parts of the interface, but the product category is defined by the complete system around agent-era engineering work:

- Goals and acceptance criteria
- Agents, roles, and sessions
- Parallel execution and coordination
- Private project intelligence
- Human exceptions and intervention
- Changes, tests, reviews, and evidence

## Primary audience

Navide is built first for one person who owns an end-to-end software outcome and directs multiple coding agents:

- Independent developers
- Technical founders
- Engineers responsible for an entire product area

Team and enterprise narratives must not displace this initial focus unless the product strategy changes explicitly.

## Problem

AI increases the amount of execution one engineer can initiate. It does not automatically solve ownership, coordination, durable context, visibility, exceptions, or verification.

The traditional IDE assumes that one engineer manually drives one primary stream of work. Agent-era engineering requires an environment that organizes intent and concurrent execution.

## Core promise

> **One engineer. An entire AI engineering force.**

Navide turns goals into coordinated, visible, and verifiable software work while the engineer retains responsibility for intent, architecture, risk, judgment, and final acceptance.

## Category contrast

> **The traditional IDE organizes code. Navide organizes engineering work.**

```text
Traditional IDE
Engineer -> edits files and operates tools -> software

Navide
Engineer -> directs goals, agents, decisions, and evidence -> software
```

This contrast explains the change in center of gravity. It does not imply that files, editing, terminals, or traditional engineering tools become unimportant.

## Message hierarchy

### 1. Direct the work

Turn an outcome into coordinated agents, independent sessions, assigned roles, parallel execution, and configurable development stages.

### 2. Keep project intelligence

Recover workspace-scoped state, prior runs, session information, handoffs, and history across individual agent conversations through the local `.agent-team/` layer.

### 3. Intervene where judgment matters

Allow reversible work to continue visibly. Return attention to the engineer for ambiguity, risk, conflict, external impact, irreversible action, or subjective product judgment. Keep Diff, editor, terminal, diagnostics, Git, tests, and review available for precise control.

## Product model

- **Genesis** turns an idea into its first working form.
- **Evolution** continuously develops, tests, fixes, and refines a real product. It is the daily center of Navide.
- **Intervention** gives the engineer direct professional control when judgment or precision is required.

## Proof hierarchy

Public evidence should advance in this order:

1. **Shipped product behavior** — visible current capability backed by the application, tests, documentation, or release artifact.
2. **Founder dogfooding** — Navide is used as the primary environment for developing Navide. This is valid first-party evidence.
3. **Independent user workflow** — another engineer uses Navide on a real project and permits the experience to be shared.
4. **Repeatable outcomes** — multiple users report a consistent valuable workflow.
5. **Measured product evidence** — adoption, retention, performance, or quality claims supported by a defined and reviewable method.

Founder dogfooding must never be described as customer validation. Future direction must never be described as shipped behavior.

## Controlled vocabulary

| Prefer | Meaning | Avoid |
|---|---|---|
| AI-native engineering environment | Product category | AI IDE without further explanation |
| Engineering instrument for the Agent era | Vision and brand category | Generic AI productivity tool |
| AI engineering force | Multiple agents directed by one engineer | AI employees, autonomous company |
| Session | One agent or terminal execution context | Bot thread |
| Private Project Intelligence | Local per-user workspace context | Team memory, cloud memory |
| Management by exception | Human attention returns for meaningful judgment | Full autonomy, no supervision |
| Available today | Verified current capability | Production-ready without release evidence |
| Product direction | Intended future outcome | Coming soon without a real commitment |

## Current supportable claims

- Navide supports multiple independent coding-agent and terminal panes.
- The current registry supports 14 coding CLIs — Aider, Antigravity CLI, Claude Code, Codex, Copilot CLI, Cursor CLI, Droid, Grok CLI, Kilo Code, Kimi Code, Muse Code, OpenCode, Pi, Qwen Code — plus plain terminal sessions.
- Supported sessions can be detected, persisted, rebuilt, and resumed.
- Pipelines can define stages, parallel slots, roles, prompts, questions, documentation queries, and completion sentinels.
- Workspace-scoped state, run events, handoffs, and compatible token summaries are stored under `.agent-team/`.
- Navide provides editor, Diff, terminal, diagnostics, Git, test, and review surfaces.
- Navide is local-first and does not require a Navide account.
- Navide supports macOS 13+ on Apple silicon, Linux x64, and Windows on x64 or Arm. The v0.2.2 release provides macOS downloads signed with a Developer ID certificate and notarized by Apple, a Windows x64 installer, and Linux x64 packages, alongside source installation; the native Windows on Arm installer is built by release CI and ships from the next release, and the Windows build is not code-signed.
- Navide's founder uses it as the primary environment for developing Navide.

## Directional claims that require a label

- Navide will replace the traditional IDE as the primary engineering environment.
- Navide will provide complete policy-driven management by exception.
- Navide will comprehensively detect conflicts, risks, idle sessions, and failures.
- The Project Intelligence Layer will become fully inspectable, portable, redactable, and controllable.
- An engineer will be able to move a product from idea to trustworthy delivery without another IDE as the center of work.

Use `product direction`, `long-term direction`, `destination`, or equivalent language wherever these claims appear.

## Claims that are not currently supportable

- A signed or notarized download is available for every supported platform (the Windows build is not code-signed).
- Navide provides a complete workspace sandbox.
- Navide is universally offline.
- Navide makes an engineer a specific multiple faster.
- Navide has customer adoption, retention, or performance figures.
- Named companies or independent engineers endorse Navide.
- Navide currently replaces every professional IDE workflow.

These claims require new product or market evidence before publication.

## Documentation roles

- The root README is the concise public product story and source-install entry point.
- The Manifesto explains the historical shift and beliefs behind the product.
- Product Vision defines target user, doctrine, ownership, and success.
- The Roadmap separates today's system from the intended destination.
- The User Guide describes current behavior.
- The Changelog and GitHub Releases describe shipped changes.
- Privacy and Security documents define current boundaries, not aspirational guarantees.
