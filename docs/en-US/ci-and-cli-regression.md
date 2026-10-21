# CI and CLI regression infrastructure

Navide's regression baseline protects the application's integration with coding
CLIs without installing a vendor CLI, signing in, calling an AI provider, or
driving Electron's UI. macOS, Linux and Windows retain the complete frontend
and backend suites. Platform-specific scenarios run on their native host.

## Responsibilities

The required `Lint and test` status aggregates the CI jobs. Type checks and
the existing Python correctness lint run once. Frontend tests run separately
from application builds and artifact integration checks, so a slow build does
not hold ordinary test feedback behind it. Backend tests include both existing
regressions and the CLI contracts. Windows retains the detached pytest runner,
four shards and Job Object supervision that avoid the Actions console hang.

Vitest projects distinguish ordinary tests, CLI contracts and tests consuming
built packages. Only artifact tests prepare package tarballs. Shared artifacts
have one writer before workers start: a test must not rebuild a shared `dist`
directory while another test consumes it. Production builds keep their normal
build mode; inherited `NODE_ENV=test` must not change their content or build ID.

Standalone artifact tests reuse a local success stamp only when source,
configuration, lockfile, toolchain/build-environment and output fingerprints
match, and the required entrypoints still exist. Missing or changed outputs,
partial stamps and failed builds force preparation again. The CI artifact job
consumes its immediately preceding unconditional build without using that cache.

Package composition tests remain distinct from UI E2E. Packaged Plans checks
exercise the production backend and its host composition, with the Go fixture
kept separate from production output. Registry contracts, deterministic STT
tests and dependency audits retain their own responsibilities. Release,
publishing and mirror workflows are outside this change.

## Required workflow

| Job | Platform | Responsibility |
| --- | --- | --- |
| Static checks and test inventory | Linux | All application/plugin type checks, backend Ruff, collection ownership and aggregate-gate tests |
| Frontend tests | macOS, Linux, Windows | Complete unit and CLI Vitest projects, including the real TypeScript WebSocket client |
| Build and artifact contracts | macOS, Linux, Windows | One application/plugin build, packed-package boundaries; macOS also exercises packaged Plans fixtures and production backend |
| Backend tests | macOS, Linux, Windows | Complete pytest suite; Windows uses four deterministic shards and detached supervision |
| Marketplace registry | Linux | Registry lint/tests and plugin contract fixtures |
| Speech sidecar | macOS | Deterministic Rust tests; model-backed transcription remains explicit manual smoke |
| Dependency audit | Linux | Existing dependency policy, including its visible Windows ARM advisory exception |
| Lint and test | Linux | Reject any missing, failed, cancelled or skipped upstream job |

The aggregate verdict is a shell step with explicit job-result inputs; it needs
no checkout or Node setup. Infrastructure tests execute that actual shell body
for success and every non-success result, and verify that every job is in
`needs`. Shell execution is mandatory in the Linux static job; local hosts probe
for Bash. Backend job budgets are 25 minutes on macOS/Linux and 45 minutes
per Windows shard, with a separate 35-minute detached-runner wait limit.

Secret scanning remains a separate workflow. Repository branch protection must
continue requiring the stable `Lint and test` check; changing remote repository
settings is not part of this local implementation.

## Shared and vendor regressions

Shared scenarios exercise process ownership, PTY/ConPTY input and output,
interrupt dispatch, backpressure, exit and cleanup, WebSocket disconnect and
reattach, session attribution, persistence and checkpoint replay. They run once
per applicable platform, not once per vendor. Fault-injection tests remain
valuable alongside real OS tests: a controlled partial write or blocked emit
can reproduce an interleaving a real child cannot reliably schedule.

Vendor scenarios exercise the actual registered adapter, its argument and
environment contracts, reader and attribution semantics, and the transports
Navide wires for that vendor. Unsupported capabilities are negative contracts,
not skipped tests. Platform-specific fixture requirements are declared in the
coverage inventory so an intentional host exclusion is not counted as missing
coverage. Ordinary shell terminals are not a CLI vendor. The source registries
determine the supported roster; the coverage inventory must agree with both
registries.

| CLI | Contracts represented in the baseline |
| --- | --- |
| Aider | Per-pane Markdown history, last-section markers, file identity, partial tails and ID-less restore |
| Antigravity | Conversation SQLite/protobuf, pending-row updates, workspace/marker attribution and explicit conversation resume |
| Claude Code | JSONL usage and activity, pinned/resumed sessions, hooks, background tasks, rewake and graceful shutdown selection |
| Codex | Rollout format, explicit turn completion, delayed discovery, launch-scoped SessionStart, pane homes, subagent exclusion and ESC interrupt |
| Copilot | SQLite and legacy JSONL precedence, cumulative usage, completed turns, markers, hooks and resume |
| Cursor | Executable aliases, SQLite WAL, JSON/protobuf discrimination, workspace markers, event ordering and reply tails |
| Droid | Its own cwd encoding (POSIX and native Windows spellings), session layouts, cumulative sidecars, split reply/outcome and inherited parent environment |
| Grok | Official grok-build updates, cwd layouts, UUID resume claims, explicit completion and streamed text |
| Kilo | Its own database/root/vendor identity plus the shared OpenCode schema and authenticated TUI push |
| Kimi | Session-directory identity, wire records, cancellation, inferred idle completion and ESC timeout environment |
| MiniMax Code | Interactive launch/login and environment handling; no reader, session resume, model or effort contract |
| Muse | Session-directory identity, main-stream accounting, child-stream exclusion, explicit terminal records and resume |
| OpenCode | SQLite streaming updates, row checkpoints, top-level markers and unauthenticated loopback TUI push |
| Pi | Header identity, lazy flush, whole-file rewrites, entry deduplication, workspace-scoped resume and inferred idle |
| Qwen | Active/archive logs, usage semantics, automated-record exclusion, inferred idle, hooks and input-file push |

Kilo shares OpenCode's reader implementation. Reuse schema scenarios and
fixtures; test Kilo's adapter selection and differing paths/authentication
explicitly. Do not duplicate the entire process-lifecycle suite for either.

## Isolation and fixture rules

The backend process harness establishes temporary home, application data,
configuration and cache locations **before importing the application**. Each
backend owns its database and event loop. Tests do not run the app's lifespan
against the process-global stores used by unrelated unit tests.

External CLI processes are controlled fixtures. Navide's terminal service,
handlers, readers, watcher, attribution and persistence remain real. Fake
processes can record arguments, acknowledge input, emit output, write vendor
session records and implement a loopback protocol. They do not implement a
second copy of Navide's lifecycle. Backend network and launch guards fail the test even
when application code catches the refused operation. The controlled fake peer
programs are repository fixtures; this is a deterministic test boundary, not a
general operating-system sandbox for arbitrary third-party executables.

Use explicit readiness and acknowledgement messages with deadlines. Use a
controlled clock for inferred-idle logic; do not sleep eight seconds to test
an eight-second threshold. Native I/O still needs a real event loop and bounded
waits. Always clean up children, readers, sockets and temporary state on failure.

Fixtures record their provenance and whether they are synthetic or sanitized
recordings. Preserve the difficult shapes that caught real bugs: SQLite WAL,
in-place row updates, partial JSONL records, reused inode/offset anchors,
whole-file rewrites, ambiguous same-directory sessions and a WebSocket that
yields during a send. A friendlier fixture can make a broken implementation
pass. Expected results must be independent literals, not generated by the
reader under test. Never include real credentials or private conversations.

## Historical guarantees and coverage maintenance

The [historical catalog](../testing/cli-regressions.json) records stable IDs,
owning subsystem/vendor, repair commits, executable tests, evidence and limits.
Existing strong tests remain the evidence; a new harness does not require
rewriting them. Source-text assertions can check wiring but do not establish
behavioral coverage. Retired mechanisms are recorded as superseded rather
than preserved as requirements, notably the old active WebSocket heartbeat.

The CLI contract inventory lives under `tests/fixtures/cli-regression/`.
Adding an integration requires its source registration, contract cases and
fixtures in the same change. Merely adding a test filename or an empty inventory
entry is insufficient. Collection checks detect missing cases; execution
checks distinguish passing contracts from skipped, failed or unexecuted cases.
Test discovery also checks suite ownership so a plugin's separate configuration
cannot silently leave tests outside CI.

## What these tests cannot establish

An offline fake proves how Navide handles the recorded contract. It cannot
prove that a new vendor version still implements that contract, that a real
account can sign in, that a provider's quota report is accurate, or that an
actual TUI accepts the bytes as intended. Inferred idle remains inference for
Kimi, Pi and Qwen. Private protobuf/SQLite formats are only covered for the
documented fixture shapes. Synthetic nonzero Muse usage does not certify real
provider accounting.

Source ConPTY tests do not certify a frozen release's bundled OpenConsole.
Existing packaging checks and manual release verification cover that separate
failure mode. Claude's POSIX graceful shutdown guarantee does not imply a
Windows equivalent. A successful interrupt request means Navide accepted and
dispatched it, not that a real vendor has stopped all work.

Manual acceptance after lifecycle or vendor changes:

1. Open fresh and resumed panes for affected vendors; check the actual command,
   login/trust prompts and session identity.
2. Send multiline input, interrupt a running turn, then send another request.
3. Reconnect/reload and confirm the conversation and visible terminal history;
   close panes and check for remaining vendor processes.
4. Check completion, waiting-for-input and turn text against the real TUI,
   including multi-pane workspaces and late transcript writes.
5. Run the existing packaged application/provider smoke procedure manually.

## Why the structure changed

The previous suite already contained substantial reader tests and real native
PTY tests. The gaps were collection and composition: Mini IDE boundary tests
were omitted from the root suite, some disconnect tests never disconnected,
and several frontend coordination tests only searched component source text.
Global package preparation made even small tests build and pack packages;
three OS jobs repeated static checks and serialized tests behind builds.

The baseline CI run at `c0eff2e8` took 17 minutes 22 seconds. Its Windows frontend
job spent about two minutes on typecheck, eight and a half on tests, then five
and a half on builds. This is a measured starting point, not a promised runtime
for every runner. Compare setup, test/build durations, shard distribution and
runner minutes after the change. Do not trade away platform coverage, hide
flakes behind automatic retries, or infer billing savings from wall time alone.

## Retained and replaced mechanisms

| Existing mechanism | Decision and reason |
| --- | --- |
| Reader unit tests, adverse session fixtures and native terminal tests | Retain; they cover precise parser/interleaving and OS failure modes that broad scenarios cannot schedule reliably |
| Detached Windows runner and Job Object supervision | Retain; these protect against a previously observed Actions console/process hang |
| Per-platform static checks mixed with test/build steps | Consolidate static checks once and separate source tests from artifact builds to expose failures sooner |
| Global build/pack before every Vitest invocation | Replace with artifact-project setup; consume prebuilt CI artifacts and give shared distributions one writer |
| Plugin-specific test configuration outside root discovery | Integrate all test files under an exact-one-project ownership invariant; include Mini IDE's typecheck |
| Source-text-only App coordination checks | Supplement wiring checks with production helper execution and a real cross-language reconnect case |
| Informal supported-vendor/test-file matching | Replace with source/catalog parity, capability cases, actual collection and successful-execution checks |
| Implicit model smoke that returned early without a model | Explicitly mark it manual; required STT tests no longer imply model execution |

The production refactor is limited to extracting existing frontend coordination
logic. The regression harness composes the current backend handlers and services;
it does not replace them with a parallel lifecycle implementation.

## Local commands and diagnostics

Use Bun (the version pinned in `.bun-version`), Python 3.12 and the locked environments:

```sh
bun install --frozen-lockfile
uv --project backend sync --locked
bun run typecheck
uv --project backend run --locked ruff check backend
bun run test:infrastructure
bun run test:frontend
bun run build
bun run test:artifacts:ci
uv --project backend run --locked pytest backend/tests --timeout=120 -o faulthandler_timeout=180 --junitxml=test-results/ci/backend.xml --durations=30 --collection-report=test-results/ci/backend-collection.json
```

`bun run test:run` remains the complete Vitest entrypoint. Never run bare
`bun test`: it starts Bun's own test runner instead of Vitest and ignores
`vitest.config.ts`. For a focused contract
loop, use `bun run test:cli` (frontend plus all marked backend historical/shared/
vendor cases) or `bun run test:cli:frontend`. The CLI entrypoint enables the
execution reporter: every vendor must finish its contract assertions. For a
single local case, use `bun run test:run --project cli <file>` or
`uv --project backend run --locked pytest <backend-test-nodeid>`; focused runs
intentionally do not claim complete roster execution.

`bun run test:artifacts:ci` consumes a preceding `bun run build`; use
`bun run test:artifacts` for standalone artifact preparation. On macOS the CI
entrypoint also needs Go for the packaged fixture. `bun run test:packaged-plans`
remains the standalone packaged Plans check. The artifact project includes
`pluginExternalWorkspace.test.ts`, which plays an external plugin author who
uses pnpm and needs a real `pnpm` (10.x) on `PATH`; without one it fails with
`Executable not found in $PATH: "pnpm"`. CI installs pnpm for that test only.
These commands exercise backend and package composition without driving
Electron windows.

Other required checks:

```sh
uv --project marketplace/registry sync --locked
uv --project marketplace/registry run --locked ruff check marketplace/registry/registry marketplace/registry/tests
uv --project marketplace/registry run --locked pytest marketplace/registry/tests
uv --project marketplace/registry run --locked python docs/plugin-contracts/validate-fixtures.py
cargo test --locked --manifest-path native/navide-stt/Cargo.toml
```

Rust STT compilation requires CMake and the native compiler toolchain. Its
ignored transcription test requires a manually supplied model and is never
part of the provider-free gate. Dependency audit commands remain in the
workflow because they consult current advisory services.

CI uploads `test-results/ci/` on success and failure: JUnit/JSON frontend
results, backend JUnit and durations, contract execution receipts, and isolated
backend event/output logs. Windows also retains the detached runner log and
completion verdict. CLI diagnostics exclude authentication endpoints, token
files and credential stores. Artifact retention is seven days. Pytest's
`--collection-report` records the full and selected node IDs so shard ownership
can be reproduced with `--shard K/4` (for example `--shard 1/4`).

Windows also prints a final process snapshot, result count and log tail. These
diagnostics and all artifact uploads are best effort: an upload outage or
process-exhaustion error must not replace the test verdict.

Do not run independent artifact builds concurrently in the same checkout.
Each invocation prepares shared distributions before worker startup; separate
jobs have separate workspaces. Reproduce native Windows or Linux failures on
that platform; path swapping on macOS does not exercise ConPTY or Linux PTYs.

## Platform-scoped vendor fixtures

Claude's graceful-shutdown fixture needs a POSIX PTY, so the coverage
inventory requires it on POSIX hosts and excludes it from Windows required
outcomes. Every other vendor contract, Droid's reader and resume fixtures
included, is required on every supported platform; Droid's session directory
is encoded with the host's spelling (POSIX or native Windows).

## Implementation validation (2026-09-30)

Local validation used macOS arm64, Node 22.23.2 and Python 3.12.11 with the
repository lockfiles. These are local results, not a claim that the new Actions
matrix has run on Linux or Windows.

| Check actually run | Result |
| --- | --- |
| Complete frontend unit + CLI projects with mandatory contract reporter | 786 files, 11,757 tests passed |
| Complete artifact project with packaged and production Plans enabled | 22 files, 200 tests passed |
| `pnpm typecheck` (including Mini IDE) | Passed |
| `pnpm build` and production Plans fixture-exclusion check | Passed |
| Infrastructure discovery/aggregate/artifact-input tests | 10 passed |
| Frontend CLI entrypoint after harness isolation changes | 53 passed |
| Marketplace registry suite | 299 passed |
| Backend and marketplace Ruff; plugin contract fixture validator | Passed |
| Rust sidecar | 29 passed; 1 explicit manual model test ignored |
| Complete backend suite (before the exit-verdict review fix) | 8,583 passed, 3 deferred reader failures, 18 platform/capability skips; 329.21 seconds |
| Focused harness/shared checks after discovery-file readiness hardening | 22 passed |
| Exit-verdict review fix: isolation, shared, vendor transport and launch | 51 passed, including premature clean exit, crash and nonzero shutdown rejection |
| Frontend/backend WebSocket regression after the exit-verdict fix | 1 passed |
| Diff whitespace check | Passed |

The exit-verdict fix checks the real backend's process outcome and preserves
cleanup and diagnostics before failing. Both premature exit and nonzero
shutdown cases first failed against the old harness with `DID NOT RAISE`.
Focused Ruff checks passed; the complete suites above were not rerun for this
harness-only follow-up. Native Linux and Windows confirmation remains in CI.

The final frontend run temporarily removed public package distributions,
`dist-plugins` and `out`. All unit and CLI tests passed without those outputs,
and none recreated them; the original outputs were restored afterward. SDK
command tests that execute built packages belong to the artifact project.
The final artifact run consumed the restored build and passed all 200 tests.

The initial local installations were behind the existing lockfiles; validation
synchronized them without changing dependencies. STT compilation used CMake
from a temporary `uv run --no-project --with cmake` environment because CMake
was absent from the machine. No real provider, login, AI quota or UI automation
was used. Remote Actions, native Linux/Windows execution, advisory-service
audits and manual provider/release smoke were not run in this session.

### Post-review corrections (2026-09-30)

The channel approval test's fixture now supplies an explicit pane workspace.
This PR's temporary HOME isolation exposed the fixture's fallback to HOME and
changed Guard's classification of relative deletion targets. The earlier
description of that failure as an upstream defect was incorrect: upstream
`7c96aca7` passed its normal CI. The fixture correction retains HOME isolation,
the real Guard and the original rejection assertion; it changes no Guard policy.

Both App kickoff call sites are now executed with the real retry coordinator,
checking that injection evidence reaches the callback and its returned echo.
Negative mutations prove either dropped connection is detected. The router
scan-window assertion starts at the actual awaited kickoff completion, including
the gap before cancellation handling and the local result assignment. Retry
limits and their log messages share constants (three kickoff attempts, eight
pane-session persistence attempts). The separate fake CLI installers remain.

Local validation after these corrections:

| Check actually run | Result |
| --- | --- |
| Complete frontend unit + CLI projects with mandatory contract reporter | 797 files, 11,879 tests passed |
| Infrastructure inventory, actual shell gate and artifact cache | 40 passed |
| `pnpm typecheck`; backend Ruff | Passed |
| `pnpm build` and production Plans fixture-exclusion check | Passed |
| Complete prepared artifact suite, including packaged/production Plans | 22 files, 201 tests passed |
| Channel mirror suite, native macOS and Windows path seam | 37 passed in each run |
| Complete backend suite before the subsequent reader fixes | 8,709 passed, exactly three deferred reader failures, 18 platform/capability skips; 333.26 seconds |
| Complete backend suite after the Droid platform-scoped fixture change (macOS arm64) | 8,724 passed, 18 skipped, 15 warnings; 326.04 seconds |
| Two consecutive standalone artifact preparations | Both passed; second run preserved the success stamp and sampled output contents/mtimes |

Native Linux/Windows execution, live provider smoke and manual Electron checks
remain separate from these local results. The two Droid reader/resume fixtures
were then required on POSIX hosts and excluded from Windows required outcomes;
the Droid Windows session-path fix later removed that exclusion.
