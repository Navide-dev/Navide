# Redesign report: lifecycle runtime on main

Branch `refactor/cli-runtime-lifecycle-main`, based on upstream/main
`75272dd4b`, pushed to the fork (draft PR 18). The design is in `DESIGN.md`.

This is the state after fix round 8 (the last two Lows of review 8), first in
this report after the PR summary; round 7 (five items) follows it, then round
6 (the full review). Round
5 answers reviews 5-A and 5-B (no finding Medium
or higher). Round 4's section follows
(reviews 4-A and 4-B). Round 2 ended at `5690f50d1` (CI run 43553202513 was
its last); round 3 answered review 3-A (N1 to N7), whose section follows
round 4's. Round 2's section follows that, then round 1's own table, and the
rest describes what the branch holds now. Round 1 ended at `aec1a324b`; its
two reviews (2-A: WITH LIMITS, 2-B: NOT READY as a base) are in the round 2
section, finding by finding.

## PR summary

- **What it is.** An experimental, off-by-default Rust process
  (`navide-cli-runtime`) that reads the same CLI transcripts and stores the
  Python log readers read, for three calls: usage (`parse_incremental`),
  activity (`parse_activity`) and turns (`turns_for_session`). A CLI's facts
  (where its records live, how to launch and resume it, how its records map to
  events) are one declaration in the crate; the Python registry, the frontend
  agent specs and the Rust readers are all read from it. The Python readers
  stay in the tree and answer whenever the runtime cannot.
- **What it costs, and what it does not do.** A routed call costs about 63 µs
  against 23 µs for the Python reader (micro-benchmark below; the round 7
  re-run, 2026-11-14). The figure before round 6 was 62 µs against 23 µs.
  This PR does not
  target the lag with hundreds of agents; it is the seam, the declaration flow
  and the parity proof that a later stage builds on.
- **What is off by default.** The `rustCliRuntime` UI setting (no Settings
  toggle; `ui.settings.set`). With it off no process is started and no call is
  routed. Rollback is setting it false.
- **What was not run.** The signed release dry run; `electron-builder --dir`
  (this repository has no unsigned `--dir` script and `dist` needs pnpm);
  Linux and Windows locally (CI covers them, see the CI table in the round 6
  section); the Rust side of the Windows path.
- **Also not run.**
  - No reader call was routed through a packaged sidecar. In the packaged-like
    layout (a frozen backend beside `<resources>/bin/navide-cli-runtime`) only
    `/health` was read, so the handshake and the calls were not exercised there.
  - The perf harness (hundreds of panes) was not re-run for round 6, 7 or 8.
    The micro-benchmark was re-run in round 7 (2026-11-14, see below); its
    earlier 62 µs / 23 µs figure predated round 6.

## Fix round 8 (the last two Lows of review 8)

Starts from `3b7761217`. Round 7's CI run 43614420146 failed only
`test_webhook_listener.py::test_oversized_headers_are_refused`, in a file this
branch does not touch; the failed job was re-run.

| Item | Status | What changed | The test that shows it |
|------|--------|--------------|------------------------|
| **L1** `json.loads(bytes)` decodes with `surrogatepass`, so `22 ED A0 80 22` (`"\ud800"`) was `Rejected` | Fixed, narrower than the brief | `pyjson::parse_bytes` answers `Python` for bytes that are valid UTF-8 once encoded surrogates (`ED A0..BF 80..BF`) are let through. The brief said to answer `Python` for any bytes `from_utf8` refuses; that was tried first and made the Cursor `cursor_db` parity step hand its activity call over, because a protobuf blob (`12 FF …`) sat in the JSON column. CPython rejects such a blob (probe: `22eda08022` accepted as `'\ud800'`, `12ff2066696c65` raises `UnicodeDecodeError`), so it stays `Rejected` and no text Python reads is `Rejected`. | `tests/json_dialect.json` gains `22eda08022` (`python`, `python_accepts: true`; 66 cases); `12ff2066696c65` stays `rejected`. Crate test `bytes_that_are_not_utf8_are_python_s_only_for_encoded_surrogates` adds a cut-short surrogate, a surrogate beside a bad byte, and two surrogates. **Fails on old code:** `cargo test --offline --lib the_recorded_dialect_cases` failed with `"22eda08022": rejected, expected "python"`. |
| **L2** "seven" items | Fixed | Round 7 had five table rows (K2, K1, C2, A1, A2); the sentence now says so. | Docs only. |
| PR summary | Fixed | Leads with 63 µs against 23 µs; one sentence says the earlier figure was 62/23. | Docs only. |

Results: `cargo test --offline` 49 passed; `cargo clippy --offline
--all-targets` no warnings; the json, parity and seam tests 184 passed; the same
three with `-p tests.cli_runtime_on` plus `backend/tests/vendors`: 969 passed, 1
skipped, all 17 CLIs in the table with `fallback=0`.

## Fix round 7 (the last review's five items)

Starts from `a8d6d00fa` (round 6 head; its final CI is run 43610111921: green,
Secret scan 43610111901: green). Every item below is the manager's decision
from review 7; nothing else changed.

| Item | Status | What changed | The test that shows it |
|------|--------|--------------|------------------------|
| **K2** bytes that `json.loads(bytes)` reads were `Rejected` | Fixed | `pyjson::parse_bytes` answers `Python` for bytes that start with a UTF-8 BOM (`EF BB BF`) or a UTF-16 BOM (`FF FE`, `FE FF`), or that hold a NUL in the first 4 bytes (how `json.detect_encoding` recognises UTF-16 and UTF-32 without a mark). Otherwise as before: valid UTF-8 only. | `tests/json_dialect.json` gains 13 cases (65 in all): a duplicate key, `-NaN` twice, and 10 byte cases given as `hex` (plain UTF-8, UTF-8 BOM, UTF-16 LE and BE with a BOM, UTF-16 without one, UTF-32 without one, a BOM in front of a non-JSON body, non-UTF-8 bytes, an unfinished object). `test_cli_runtime_json.py` checks each `python_accepts` against CPython 3.12 (69 passed) and the crate test checks each `expect`. The parity scenario `cursor_db` gains a blob cell of UTF-8-with-BOM JSON (`python_reads: ["activity@4"]`): switch-on equals all-Python. **Fails on old code:** `env -u NAVIDE_PANE_MARK uv --project backend run pytest -q backend/tests/test_cli_runtime_parity.py -k "switch_on and cursor"` with the new check disabled failed: the switch-on run returned no activity event for the BOM step, where all-Python returned a `turn_complete` event (the BOM cell's record was lost); the crate test `the_recorded_dialect_cases_are_told_apart_as_python_does` failed 7 byte cases (`rejected, expected "python"`) before the fix. The duplicate-key and `-NaN` cases passed on the old code (they pin what the review checked by hand). |
| **K1** `notes` / `reads` applied outside the fallback | Fixed | `_ask` only asks; each route applies `notes` and `reads` (`_apply_side`) inside its conversion `try`, after the result is converted and before the caller's state is touched. `_log_notes` and `_apply_reads` read every entry before they write any, so a malformed entry writes nothing. | `test_what_an_unreadable_answer_said_beside_its_result_is_not_applied_and_the_reader_reads` (seam; usage, activity and turns, each with an answer whose `result` is `None` and with a `reads` entry that has no `reason` after a valid one): falls back, the reader's own read returns, one "shape this backend cannot read" line, nothing in the read-problem registry. **Fails on old code:** the same command on the round 6 `cli_runtime.py` failed all 6 cases (`AttributeError` on a `None` result; `KeyError: 'reason'`, with the first entry already written to the registry). |
| **C2** docs: "the next call is the runtime's again" | Fixed | Corrected in the `OUTCOMES` comment of `cli_runtime.py` and under "Rust differences from main (known)". | Docs only. |
| **A1** dialect case count | Fixed | The round 6 table says 65 cases (52 when round 6 ended). | `len(json.loads(tests/json_dialect.json))` is 65. |
| **A2** "What was not run" | Fixed | Added the packaged sidecar, the perf harness, and the re-run micro-benchmark. | See "Micro-benchmark" for the new numbers. |

### Decisions inside the items

- `parse_bytes` checks the BOM and NUL rules before it decodes, so a text such
  as `\0\0` is `Python` (wider than CPython, which then rejects it): a wider
  answer costs a call, never a record.
- The `hex` form was added to `json_dialect.json` rather than a second file, so
  the crate and Python read one list; `text` cases are unchanged.
- The seam test uses OpenCode's reader because it has the read-problem
  registry (`_report_problem` / `_read_ok`); a reader without one ignores
  `reads` as before.
- The parity scenario declares only `activity@4` as a hand-over: in this
  scenario Cursor's usage and turns calls were answered by the runtime (the
  test's call count shows it), and the counter assertion (`python == hand-overs
  x routes`) holds with the switch on and with the plugin.

### Commands and results (round 7)

| Command | Result |
|---------|--------|
| `cargo test --offline` | 49 passed (8 suites). |
| `cargo clippy --offline --all-targets` | no issues. |
| `cargo check --offline --all-targets` | no warnings. |
| `env -u NAVIDE_PANE_MARK uv --project backend run pytest -q` on parity, seam, json, declarations (switch off) | 309 passed. |
| the same four files plus `backend/tests/vendors`, `test_claude_activity_resume.py`, `test_activity_high_water.py` with `-p tests.cli_runtime_on` (switch on) | 1119 passed, 4 skipped. All 17 CLIs are in the counter table and `fallback=0` for every one. Against round 6 the table changed for one CLI: `cursor` rust 47 -> 49 and python 0 -> 3 (the new BOM step's one hand-over: 2 in `test_switch_on_matches_python[cursor_db]`, which counts it once per route, and 1 in `test_python_readers_match_the_parity_fixtures[cursor_db]`, where the plugin's class route answers; each run alone was checked: 2 and 1). Every other row is round 6's, line for line. |
| `node scripts/changed-backend-tests.mjs` (bare, after the last code change, waited for in-turn) | exit 0: 16971 passed, 40 skipped, 110 deselected, 1 xfailed (13 min 23 s), then the serial pass 106 passed, 4 skipped. |
| `git fetch upstream`, `git merge-tree --write-tree upstream/main HEAD` | clean (a tree id, no conflicts). upstream/main had moved to `1a6259b0d`. |
| `uv --project backend run python backend/tests/bench_cli_runtime.py` and `... 500 20000` | see "Micro-benchmark": 63.1 µs routed against 22.6 µs (empty start); 65.0 against 22.5 (20,000 earlier records). |

`cargo fmt --check` was not used: the crate has never been rustfmt-formatted
(it reports differences in files this round did not touch).

The CI result for the round 7 head is in the delivery message.

## Fix round 6 (full review): state of this report

This is the state after fix round 6. The branch was first merged with
upstream/main (`f2e636827`, a merge commit); the work follows in small commits
`6b886d067`, `ed2cd0f71`, `5b1757416`, `20a2f842b` and the ones this section
ends with. Round 5's section follows.

### Deliberate non-fault outcome added this round

`python` is a new per-CLI outcome next to `rust`, `unsupported`, `unreadable`,
`deferred` and `fallback`. It means: "Python can read this and the runtime
cannot, so Python answered, and nothing was committed on the way". It is not a
fault: it does not count toward the breaker and does not kill the process. The
switch-on counter table prints it as `python=`. With the switch on and the
`tests.cli_runtime_on` plugin, `fallback` is 0 for all 17 observed CLIs (see
the switch-on row below). The parity tests never reset the process-wide counts
(`reset_counts` is the plugin's alone): they take a snapshot before the reads
and assert on the difference. The first round 6 push (`d91e17b29`) reset them
inside two tests, so its plugin run listed only 5 CLIs and its end-of-session
"no fault fallback" gate covered only the tests after the last reset; that was
found by review and fixed in the commit after it.

**One deviation from the brief, on purpose.** The brief says a terminated line
that fails to parse in Rust makes the call a Python one. `pyjson::parse` is a
classifier instead (`Value`, `Python`, `Rejected`): a line is handed over only
when Python's `json.loads` would accept it and `serde_json` would not (lone
surrogate escapes, `NaN` / `Infinity` / `-Infinity`, nesting past 128 levels).
A line neither parser accepts is stepped over exactly as main steps over it.
The literal rule would keep plain-text cells (Hermes `content`, OpenCode rows
that are not JSON) and genuinely corrupt lines on Python for good.

### Findings

| Item | Status | What changed | The test that shows it |
|------|--------|--------------|------------------------|
| **Merge, L1** `MCP_TIMEOUT` | Fixed | `git merge upstream/main`; claude's `env_defaults` carries `MCP_TIMEOUT=120000`; declarations regenerated; `cli_declarations_main.json` follows upstream's later change. | `test_spawn_env_request.py::test_a_claude_pane_gets_a_longer_mcp_connect_budget` passes; `test_cli_declarations.py`. |
| **C1** a record Python reads is stepped over | Fixed | `pyjson::parse` / `lenient`; `Error::PythonReads` is wire kind `python` and outcome `python`; nothing is committed on a hand-over (file lines, SQLite JSON cells). | Six new probe fixtures (`claude_probe_{surrogate,nan,deep,corrupt}`, `codex_probe_surrogate`, `opencode_probe_surrogate`) in `test_switch_on_matches_python` (switch-on equals all-Python, for usage, activity and turns); `test_cli_runtime_json.py` (52 dialect cases when round 6 ended, 65 after round 7: `tests/json_dialect.json`). **Fails on old code:** `... pytest backend/tests/test_cli_runtime_parity.py -k "test_switch_on_matches_python and probe"` failed 6 probes on the pre-fix binary. `claude_probe_corrupt` shows that Python steps over a corrupt line, so the next checkpoint is past it and nothing loops. |
| **C2** a request the runtime cannot parse | Fixed | `wire::parse_request` parses to `Value` first and answers a bad request under its id (kind `request`, or `python`); a non-UTF-8 line is answered, not fatal. `_Client.call` encodes strictly (`ensure_ascii=False`, `allow_nan=False`); a path or key Python cannot send raises `PythonReads` before a slot is taken: no request, no kill, no breaker failure. | Crate: `a_request_that_cannot_be_parsed_is_answered_under_its_id`. Seam: `test_a_request_python_cannot_send_as_utf8_is_python_reads_it_and_the_process_is_left_alone`, `test_a_request_the_process_refuses_is_answered_at_once_and_does_not_count_against_it`, `test_the_binary_answers_a_request_it_cannot_parse_under_its_id` (the real binary). **Not shown failing on old code** (read from the code: `lines()` aborted on non-UTF-8, and an `id: null` answer waited the 10 s timeout). |
| **R1 / C4** SQLite open mode | Fixed | `mode=ro` first, checked with a schema probe; `immutable=1` only when that is refused and the database has no `-wal` / `-shm`; after an immutable read a `-wal` that appeared discards the read (`PythonReads`). The comment about the system SQLite stays. | `a_wal_database_without_sidecars_is_read_and_a_wal_that_appears_after_an_immutable_read_is_noticed` (it uses `wal_checkpoint(TRUNCATE)` and removes the sidecars by hand; macOS was confirmed to take the immutable path). The remaining difference is listed under "Rust differences from main (known)". |
| **C3** a field missing from the answer | Fixed | The conversion of an answer into Python objects is inside the fallback (`_bad_answer`: `rust` is taken back, `fallback` counted, logged once per CLI); `_activity` converts everything before it mutates the caller's bag. | `test_an_answer_that_cannot_be_read_falls_back_to_python_not_into_the_watcher` (seam). Not shown failing on old code. |
| **C3 / L-C2** build identity | Fixed | `observes` carries `_runtime` {version, declarations (FNV-1a of `registry::launch_json()`)}. Python compares both (`RUNTIME_VERSION`, a hash of `cli_declarations.json` with CRLF normalised); a mismatch kills the process and `status()["binary"]` is False. `status()` has a `runtime` block. | `observes_says_which_build_answered` (crate); the three build-mismatch cases and `test_a_build_that_is_not_this_backends_counts_as_no_binary` (three cases) and `test_the_seams_runtime_version_is_the_crates` in `test_cli_runtime_seam.py`; the health key set in `test_health_diagnostics.py`. |
| **L-C2** stderr | Fixed | stderr is piped and drained by a thread; the last 8 lines (200 chars each) are logged once when the process dies abnormally; the panic hook prints only `file:line`, never a record. | `test_what_the_process_wrote_to_stderr_is_logged_once_bounded_when_it_dies` (seam). |
| **N1** binary lookup | Fixed | `OSError` / `RuntimeError` in the lookup is "no binary"; `apply()` never raises. | `test_a_binary_that_cannot_even_be_looked_for_is_no_binary`. |
| **N3** `target/release` | Fixed | Searched only when not frozen; frozen uses the packaged `<resources>/bin`. | `test_the_repository_build_is_looked_for_only_outside_the_packaged_backend`. |
| **S1** CONTRIBUTING | Fixed | Declaration-flow bullet, Rust 1.85 floor, `NAVIDE_DECLARATIONS_WRITE=1 cargo test --test checked_in`. | Docs only. |
| **S2** `_template.py` step 4 | Fixed | Removed, steps renumbered, says nothing is added to the PyInstaller spec. | Docs only. |
| **S3** import allowlist | Fixed | `_declared` named in `docs/adding-a-cli-vendor.md`. | Docs only. |
| **S4** `label=` | Fixed | `declared()` returns the label; the 20 hand-written lines are gone; `registry.py` builds `VendorSpec(key=key, **declared(key))`. Main's observable labels are unchanged (`cli_declarations_main.json` holds main's 20). | `test_cli_declarations.py::test_the_display_label_is_mains`, the registry and vendor suites. |
| **S5** CHANGELOG | Fixed | One Unreleased "Added" line. | Docs only. |
| **L-C1** operator section | Fixed | "Rust CLI runtime (experimental)" in `docs/en-US/cli-extension-guide.md`: how to turn it on, where the binary resolves, `NAVIDE_CLI_RUNTIME_BIN`, `/health` `diagnostics.cli_runtime`, rollback. | Docs only. |
| **L-C5** this report | Fixed | The round 5 CI row says run 43581709159: green; the size table is recounted. | Docs only. |
| **Rust hygiene** | Fixed | clippy's `cursor.rs` warning (`typed`); `Cargo.toml` says `catch_unwind` needs `panic = "unwind"`; the per-event `tail.checkpoint.clone()` that carried the old `recent_keys` is dropped from one `base` copy (event checkpoints are compared by parity, so the clone itself stays). | Crate suite; the parity fixtures. |
| **L-C3** mid-session flip | Fixed | One flip test per route family. | `test_cli_runtime_parity.py` flip test over `claude_turns`, `codex_rewrites`, `opencode_v1`: Rust, Python, Rust over a growing store, equal to an all-Python run. |
| **L2** packaged build | Done locally, partly | See below. | Commands below. |
| **C-N6** Hermes `is_numeric` against `\d` | Recorded as a known difference | Under "Rust differences from main (known)". | None. |

### Packaging (L2)

- `uv --project backend run --locked pyinstaller --noconfirm --distpath <scratch>/pydist --workpath <scratch>/pywork backend/agent_team_backend.spec` (`release.yml` runs `uv run --locked pyinstaller agent_team_backend.spec` from `backend/`): exit 0.
- The archive table of contents holds all 20 vendor modules, `base`, `_declared`, `_protocols`, `_template` and `registry`; `_internal/agent_team_backend/cli_declarations.json` is present.
- The frozen backend started with an isolated data directory and home: "LogWatcher started · 17 reader(s)", `/health` status ok, `diagnostics.cli_runtime` present (`enabled` false, `state` off, `binary` false, `failures` 0, `runtime` all null, `calls` empty).
- A packaged-like layout (`res/bin/agent_team_backend/` beside `res/bin/navide-cli-runtime`, `rustCliRuntime` preset to true): `/health` showed `enabled` true, `state` idle, `binary` true. No transcript call was made, so the handshake was **not** exercised there.
- `electron-builder --dir` was **not** run: there is no unsigned `--dir` script, and `dist` is `pnpm build && electron-builder`.
- The build outputs were removed and `git status` was clean afterwards.

### Commands and results (round 6)

| Command | Result |
|---------|--------|
| `cargo test --offline` | 49 passed (8 suites). |
| `cargo check --offline --all-targets` | no warnings. |
| `cargo clippy --offline --all-targets` | no issues. |
| `env -u NAVIDE_PANE_MARK uv --project backend run pytest` on vendors, parity, seam, json, claude_activity_resume, activity_high_water, declarations, registry, health, shutdown_seen_flush, osplat, osplat_windows_discovery, pyinstaller_spec, spawn_env_request (switch off) | 1255 passed, 3 skipped. |
| the same set with `-p tests.cli_runtime_on` (switch on) | 918 passed, 4 skipped (the round 5 set: vendors, parity, seam, `test_claude_activity_resume.py`, `test_activity_high_water.py`). All 17 observed CLIs are in the table and `fallback=0` for every one. The counts are round 5's, line for line (`unsupported`: copilot 29, hermes 2, openclaw 2, opencode 2; `deferred`: opencode 7; `unreadable`: grok 2, pi 1), plus the new `python` column (claude 27, codex 9, opencode 9, all others 0: the probe fixtures' hand-overs, counted by two routes each under the plugin). The probe test asserts `python == hand-overs x routes` on a snapshot difference, with routes 2 under the plugin (the class route and the wrapped instance's) and 1 without it. Its expected run is made with the switch off, so it is Python's under the plugin as well. |
| `... pytest -q backend/tests/test_cli_runtime_parity.py backend/tests/test_cli_runtime_seam.py backend/tests/test_cli_runtime_json.py` (switch off, after the counter fix) | 163 passed. |
| `bun run vitest run --changed upstream/main` | 20547 passed, 1 failed: `pluginExternalWorkspace.test.ts`, `Executable not found in $PATH: "pnpm"` (no pnpm here; the same failure as rounds 2 to 5; not touched by this branch). |
| `bun run typecheck:web` | no errors. |
| `node scripts/changed-backend-tests.mjs` (bare, after the last code change) | exit 0: 16951 passed, 40 skipped, 110 deselected, 1 xfailed (13 min 24 s), then the serial pass 106 passed, 4 skipped. Run again after the counter-reset fix (the last code change); only this report was edited after it. |
| `git merge-tree --write-tree upstream/main HEAD` | clean (a tree id, no conflicts), run against HEAD before the report commit. |

| CI | Result |
|----|--------|
| Run on the round 6 push (`d91e17b29`) | run 43607754703: green (every job, Windows included); Secret scan 43607754771: green. |
| Run on the push that fixes the counter reset (`a8d6d00fa`, the round 6 head) | run 43610111921: green; Secret scan 43610111901: green; `gh pr checks 18`: 24 passed, 0 failed. |

## Fix round 5: the Lows and every known contradiction

"Before" is the head `c59d2a8ad`. No crate source changed this round (Python,
tests and documents only), so `cargo` was not re-run.

| Item | Status | What changed | The test that shows it |
|------|--------|--------------|------------------------|
| **N4 / B5-2** documents that contradicted round 4 | Fixed | `DESIGN.md` (the remaining-gates paragraph now lists only the regression inventory and the prose); `docs/adding-a-cli-vendor.md` (step 4: a reader module only when a reader exists, `_MIGRATED_READERS` / `__all__` optional and asked by no test; step 7: the `SNAPSHOT` needs no entry; Frontend steps 5 and 7: the plans copy is frozen v1 and the flagless list is a recorded subset; the "Other hand-kept lists" introduction); `docs/en-US/cli-extension-guide.md` step 4; the `submitTurnConfirm.ts` comment; `docs/en-US/architecture.md` (the planned transport). The round 4 CI row below. The guide also says that a **second binary name** (an alias or legacy binary) is the one thing added by hand to `CLI_NAMES`' alias set in `isolation.py`. | Docs only. |
| **N1** memory table order | Recorded, behaviour unchanged | Listed under "Rust differences from main (known)" (it is Python's). The comment in `native_memory.py` no longer says the order is unobservable. | New `test_native_memory.py::test_a_workspace_that_is_a_cli_s_user_directory_lists_the_file_under_the_first_row_that_reaches_it`: workspace `home/.codex`, `AGENTS.md` there. Pins Project `AGENTS.md` now, User `.codex/AGENTS.md` with main's row order, equal readers and an equal set of allowed paths. It passed on the first run (it pins current behaviour; both labels were asserted, so the prediction in the review is confirmed). |
| **N2** pins by count | Fixed | `_VERIFIED` is held to main's sixteen by key; the extensions declaration is held to main's nineteen by key. | `test_every_vendor_has_a_verified_version_or_says_why_it_has_none`, `test_every_vendor_declares_where_its_extensions_live_or_says_it_has_none`. Not shown failing: they only tighten (a mutation was not run). |
| **N3** risk roots no longer pinned by hand | Kept as decided | The guide says a new CLI pins its roots in its own `tests/vendors/test_<key>.py` (step 7). | Docs only. |
| **N5** a start that hangs; `deferred` with no binary | Fixed | `binary()` is looked for before anything is `starting`, outside the lock, so with no binary no caller is counted as stepping aside. A start has a deadline (`START_DEADLINE_S`, 30 s): the next caller past it abandons the start by epoch (the state leaves `starting`, one failed start is counted and the restart is backed off), and a client the late start returns is reaped. | `test_nothing_is_starting_while_the_binary_is_being_looked_for`, `test_a_start_past_its_deadline_is_abandoned_and_what_it_returns_later_is_not_used` (late start comes up / late start fails: no second failure). |
| **B5-1 (1)** `apply(False)` then `apply(True)` during a start | Fixed | A start takes an epoch when it begins; `apply()` moves the epoch on and clears `starting`, and a start installs its process only if its epoch is still current. | `test_a_start_that_began_before_the_switch_went_off_and_on_installs_nothing`. |
| **B5-1 (2)** `_ask`'s cold-start `deferred` | Documented | Making it consistent would count `deferred` for a CLI the runtime may never observe (`_known` is empty before the first handshake), and would move the counter table; the comment in `_ask` says why. | None. |
| **N7** `memory_sources` shape | Fixed | Every scope is one of the two values and no part is empty, absolute, a separator or `..`. | New `test_every_declared_row_is_a_relative_path_of_one_of_the_two_scopes`. |
| **SNAPSHOT** | Fixed | `test_install_deps_snapshot.py` compares the recorded ids, in relative order, with the live entries of those ids; a new CLI adds nothing. | `test_agent_cli_install_entries_unchanged`. |
| **N6** what `observed` means | Documented | The guide: `observed` = the runtime declares records, a Python reader exists, and it reports turn starts; a CLI that breaks the equality needs a new declared field. | Docs only. |
| **M1–M4, P2, P7** DESIGN.md | Written, design only | M1: the host's control operations from `terminals.py` (spawn, write, resize with the drain barrier, foreground query, kill with the descendant snapshot, exit, the pid registry) and how a backend injection and the user's keystrokes are ordered (whole input frames, an input lease with a 2 s bound). M2: P3 compares per-stream concatenated bytes and the byte offsets of resize and exit, plus frame invariants, not frame sequences. M3: a slow consumer is treated as no consumer after a bound and catches up by replay (a `gap` frame when the offset is gone); only the owner's credit counts, a second consumer is a watcher. M4: the hop stage's measure is "not worse", the end state's is the 200-pane improvement, a renderer-side measure is added, and the Unix socket + message port is weighed against a hand-written WebSocket (decision: the socket and port, the WebSocket as the fallback). P7: the header has an `offset` field. P2: the handshake checks `Origin`, and the token is never put in a URL. | None: no code changed. |

### What the three new start-path tests were checked against

The tests were written first. They were then run **one per invocation** against
the committed (unfixed) `cli_runtime.py`, with only the `START_DEADLINE_S`
constant added so that they fail on behaviour and not on a missing name (run
together, a failed test leaves `_starting` set and made the next one fail for
the wrong reason; that run was discarded). Each failed for the reason it
tests: the binary test saw `state == "starting"` and the second caller counted
`deferred: 1`; both deadline cases (`comes up` and `fails`) saw `starting`
where `waiting-to-restart` was expected after the deadline; the off-and-on
test saw `starting` where `idle` was expected after the flip. That last test's
final assertion (nothing installed) was not reached on the old code; that the
old code installs the late process is read from the code (`_enabled` is true
and `_stopping` false again when the start returns). Then the fixed file was
restored (`git diff` shows it) and all pass: `test_cli_runtime_seam.py` 24
passed (20 before). The first draft of the binary test recursed through
`status()`, which also looks for the binary; that was the test's bug and is
fixed.

### Commands and results (round 5)

| Command | Result |
|---------|--------|
| `env -u NAVIDE_PANE_MARK uv --project backend run pytest -q -p tests.cli_runtime_on backend/tests/vendors backend/tests/test_cli_runtime_parity.py backend/tests/test_cli_runtime_seam.py backend/tests/test_claude_activity_resume.py backend/tests/test_activity_high_water.py` | 889 passed, 4 skipped. `fallback=0` for all 17 observed CLIs; the counter table is round 4's, line for line (`unsupported` copilot 29, hermes 2, openclaw 2, opencode 2; `deferred` opencode 7; `unreadable` grok 2, pi 1). |
| `... pytest -q backend/tests/vendors/test_install_deps_snapshot.py backend/tests/test_cli_extensions.py backend/tests/test_spawn_probe_version_drift.py` | 79 passed. |
| `... pytest -q backend/tests/test_native_memory.py` | 54 passed. |
| `uv --project backend run ruff check` on the seven changed Python files | all checks passed. |
| `bun run vitest run --changed upstream/main` | 20507 passed, 1 failed: `pluginExternalWorkspace.test.ts`, `Executable not found in $PATH: "pnpm"` (no pnpm on this machine; the same failure as rounds 2 to 4; not touched by this branch). |
| `bun run typecheck:web` | no errors. |
| `node scripts/changed-backend-tests.mjs` (bare, after the last code change) | exit 0: 16723 passed, 40 skipped, 1 xfailed (17 min), then the serial pass 106 passed, 4 skipped. Run after the last code change; the report and this row were edited after it (documents only). |

| CI | Result |
|----|--------|
| Run on the round 5 push | run 43581709159: green |

## Fix round 4: every review 4 finding

"Before" is the head `06d6fbce0`. CI run 43567091901 on it had one failed
Windows shard, `guard/test_decision_latency.py` (a 0.2 s timing test this
branch does not touch). The first round-4 worker stopped on an API error; a
second one finished the work below.

| Finding | Status | What changed | The test that shows it |
|---------|--------|--------------|------------------------|
| **F1** (4-A) CI red on the head, not in the report | Reported | Stated above and in the CI row below. Not re-run (a re-run is a `gh` write). | None. |
| **F2 = B4-1** a start that fails with anything but `OSError` raised into the reader call or skipped the backoff | Fixed (`d75bb009c`) | `_client_for_call` catches `Exception` around `binary()` and `_Client(exe)`, counts it, falls back and backs off. `_Client.__init__` kills and reaps its child when a helper thread cannot start. | `test_cli_runtime_seam.py::test_a_start_that_cannot_get_a_thread_falls_back_backs_off_and_kills_the_child` (stand-in `Popen`, then a thread start that raises). Run against the old `cli_runtime.py`: failed (`RuntimeError: can't start new thread` reached the caller). Fixed: passes. |
| **F3** calls during a start were counted as faults | Fixed (`d75bb009c`) | `status()["state"]` is `starting` while a start is in flight; calls that step aside are `deferred`, not `fallback`; a start longer than a few seconds is logged once. | `test_calls_during_a_start_are_deferred_not_faults_and_the_state_says_starting` (a start held open). Old code: failed (no such state). Fixed: passes. |
| **F4** `collect_submodules` could return an empty list without failing the build | Fixed (`f017519b8`) | `on_error="raise"`; the spec asserts the registry module is in the list. | `test_pyinstaller_spec.py` checks both. |
| **F5 = B4-2** nothing said a recorded CLI's adapter file was still there | Fixed (`13e573371`) | The recorded keys must keep `cli_vendors/<key>.py`, `log_readers/<key>.py` (placeholders included) and `agents/<key>.ts`; a new CLI edits nothing. | `test_every_cli_main_had_still_has_its_vendor_module_and_log_reader_module`; `declared.test.ts` "still has the spec file of every CLI main had". **Deletion proof, run in this round:** with `log_readers/mcode.py` moved away the backend test failed ("adapter files of CLIs main had are gone: ['backend/agent_team_backend/log_readers/mcode.py']"); with `agents/mcode.ts` moved away the frontend test failed. Both files restored; `git status` shows them untouched. |
| **F6** the vendor guide stated rules the relaxed tests no longer hold | Fixed | `docs/adding-a-cli-vendor.md` (the `collect_submodules` rule, step 5 `memory_sources`, step 10 `extensions_none_reason`, "Other hand-kept lists", "Verify"), `docs/en-US/cli-extension-guide.md` (step 4). | None: documentation. |
| **Derivable lists** (both reviews, goal 1) | Fixed except three, below | `EXPECTED_VENDORS` is a recorded subset and `CLI_NAMES` comes from the declarations (`6938ce94c`); `observed` is exported from the declarations and `NO_LOG_READER` / `TURN_START_SIGNAL` derive from it (`89bf3a10a`); the plans plugin's frozen copy compares only recorded keys and the add menu's cap is a fixed budget (`e262e15f3`); `MEMORY_SOURCES` moved onto `VendorSpec.memory_sources` (`0aab88753`); the three exemption sets are `cli_unverified_reason`, `extensions_none_reason`, `data_dirs_none_reason` (`d26a01a6f`); `cliPermission.test.ts`'s "flagless" list is a recorded subset (this round). `MCP_WIRED` stays by hand: its fact is in the Python spec and a generated field would add a second source of it. | `test_guard_refuses_every_declared_cli_program`, `test_inventory_holds_every_cli_main_had`, `test_every_row_is_declared_on_the_vendor_it_names`, `test_the_assembled_table_has_main_s_entries_and_each_cli_s_order`, `test_which_cli_comes_first_in_the_table_is_not_observable`, `test_every_vendor_declares_where_its_extensions_live_or_says_it_has_none`, `test_every_vendor_has_a_verified_version_or_says_why_it_has_none`, `test_every_vendor_declares_data_dirs_or_says_why_it_has_none`, `ControlPane.addMenu.test.ts` "the scroller cap is a fixed budget that scrolls, not a count of the roster". |
| **Task 7** DESIGN.md plan | Written, design only | DESIGN.md "The plan, item by item (P1–P9)"; `docs/en-US/architecture.md` "Trust boundaries" gets the host's renderer socket as a planned item. | None: no code changed. |

### The second fake-CLI proof

A throwaway CLI, `fakegoose`, a copy of goose with all its adapter files
(`cli_vendors/fakegoose.py`, `log_readers/fakegoose.py`, `vendors/fakegoose.rs`,
`agents/fakegoose.ts`, `tests/fixtures/cli-regression/fakegoose.json`) and a
regenerated declaration pair, then the full backend suite
(`node scripts/changed-backend-tests.mjs`) and the full frontend suite
(`bun run vitest run`). Reverted afterwards; `git status` held none of its files.

What it still needed beyond its own files, and which test asked:

| File | Test that asked |
|------|-----------------|
| `tests/fixtures/cli-regression/catalog.json` (entry; the fixture is its own file) | the regression inventory gate, "vendor coverage differs: missing=['fakegoose']" |
| `tests/cli/vendorContracts.test.ts` (a row) | "matches the supported registry and backend regression catalog exactly" |
| the `SNAPSHOT` in `backend/tests/vendors/test_install_deps_snapshot.py` | `test_agent_cli_install_entries_unchanged` |
| `README.md` / `README.ja-JP.md` / `README.zh-TW.md` vendor count and list | `test_cli_vendors_registry.py::test_readmes_list_every_registered_vendor` |
| the `vendors` table in `CliAgentsHelp.vue` | `test_help_panel_sign_in_column_matches_login_command_args` |

Two more failures were defects in this round's own tests, not policy lists,
and are fixed in the commit: `test_native_memory.py::test_which_cli_comes_first_in_the_table_is_not_observable`
swapped in main's 87 recorded rows and so dropped a new CLI's rows (it now
appends the rows of unrecorded CLIs), and `cliPermission.test.ts` listed the
flagless vendors exactly (now a recorded subset). With both fixed the CLI
passed them with its own files only.

Not fixed: the install `SNAPSHOT`, the README count and list and the Help panel
row. They are product copy and an install-order recording that a person
should state for a new CLI; the guides list them. The frontend run also failed
`pluginExternalWorkspace.test.ts` (`Executable not found in $PATH: "pnpm"`),
the same machine limit as rounds 2 and 3.

After the revert: `cargo test --offline` passed, and `checked_in` agrees with
the restored copies (nothing was regenerated by hand).

### Commands and results (round 4, after the last change)

| Command | Result |
|---------|--------|
| `node scripts/changed-backend-tests.mjs` (bare, no pipe) | exit 0: 16717 passed, 40 skipped, 1 xfailed, then the serial pass 106 passed, 4 skipped. |
| `bun run vitest run` | 20507 passed, 1 failed: `src/main/plugins/pluginExternalWorkspace.test.ts`, `Executable not found in $PATH: "pnpm"` (no pnpm on this machine; not touched by this branch; the same failure as rounds 2 and 3). |
| `cargo test --offline` (crate), run after the fake CLI was reverted | passed (exit 0). |
| `bun run typecheck:web` | no errors. |
| `uv --project backend run ruff check backend/tests/test_native_memory.py` | all checks passed. |
| the two new seam tests against `06d6fbce0`'s `cli_runtime.py` | both failed; both pass on the fix (20 passed in `test_cli_runtime_seam.py`). |

| CI | Result |
|----|--------|
| Run 43575701753 on `c59d2a8ad` (round 4's push) | 21 jobs passed, including both `Rust CLI runtime` legs. One failed: `Backend tests (Windows, 1/5)`, only `channels/test_manager.py::test_stuck_seam_does_not_block_other_chats[interrupt]` (a 0.2 s wall-clock assert), so the `Lint and test` gate failed. An upstream flake: upstream PR 885 fixes that test, after upstream's release dry run 43559161079 measured 0.735 s against the budget with none of this branch's code. This branch touches no channels or guard code, and nothing of the Rust runtime runs on Windows. Not re-run (a `gh` write). |

Not verified: the Linux and Windows runs (CI is their first), and the `pnpm`-based
external workspace test.

## Fix round 3: every review 3-A finding

"Before" is what the code at `5690f50d1` did. Each fix names the test that
shows it; where a test was run against the unfixed code, the result is given.

| Finding | Status | What changed | The test that shows it |
|---------|--------|--------------|------------------------|
| **N1** Medium: the next stage (process model and channel) was not designed | Design only, as decided | DESIGN.md, "The next stage: process model and channel": a PTY host that is never killed and never opens SQLite, and an observe worker that may be killed and restarted; a framed duplex channel (type, stream id, length, raw payload) and the four gaps of today's one-line-per-request wire it closes; a circuit that is per file, not per process. Marked planned, not built. | None: no code changed. Not verified by running anything, and says so. |
| **N2** Medium: adding a CLI still edited the recording tests, and tests forbade a declaration-only CLI | Fixed for the recordings; the whole-repo policy lists remain (below) | The recording tests iterate over the recorded keys only (`test_cli_declarations.py` `RECORDED`, `test_cli_vendors_registry.py`, `declared.test.ts`). Order tests compare relative order. The tests that forbade a CLI with no module or spec file are relaxed to "every recorded one is still there". `docs/adding-a-cli-vendor.md`, `docs/en-US/cli-extension-guide.md` and DESIGN.md say what a new CLI needs, from the proof below. | Backend: `test_cli_vendors_registry.py::test_a_declared_cli_with_no_module_is_registered_from_its_declaration` (a test-only declaration, registry reloaded). Frontend: `declared.test.ts` "a declared CLI with no spec file" (the declarations mocked). Plus `test_the_recording_of_main_is_of_declared_clis`, `test_the_runtime_and_the_backend_name_the_same_sessions`. |
| **N3** Low: two callers could both start the process | Fixed | `_starting` is set under `_state` by the caller that starts it; the others return `None` (fall back) while it is set, and it is cleared in a `finally`. | `test_cli_runtime_seam.py::test_one_failed_start_is_one_attempt_and_one_failure_however_many_callers_wanted_it` (callers behind a barrier). With the flag removed the test failed (several attempts); with it, one attempt and one failure. |
| **N4** Low: the fallback counts were "at least"; `wrap` was not idempotent | Fixed | The seam tests compare exact counts: `expected * routes`, where `routes` is 2 under `tests/cli_runtime_on.py` (it routes the class and the instance) and 1 otherwise. The stalled-seam count is `(2*steps+1+1)*routes`: Python's `turns_for_session` makes one nested routed `parse_activity`. `wrap` returns a reader it has already routed. | `test_wrapping_a_reader_twice_routes_it_once`. With the guard removed it failed (twice the calls). |
| **N5** Low: 20 hand-written `hiddenimports` | Fixed | `backend/agent_team_backend.spec` collects `cli_vendors` with `collect_submodules`; the hand list is gone. | `test_pyinstaller_spec.py::test_every_vendor_module_is_a_hidden_import`, `test_every_vendor_module_is_a_declared_cli`, `test_every_lazy_log_reader_vendor_is_a_hidden_import`. |
| **N6** Low: no `rust-version`, a bare build-failure message, a toolchain-home case | Fixed | `Cargo.toml` declares `rust-version = "1.85"`: found by trying, 1.85 builds and tests the crate, 1.80 cannot read the lock (`hashbrown 0.17.1` needs `edition2024`). The failure message names `rust-version` and `NAVIDE_CLI_RUNTIME_REQUIRED=0`. The build sets `CARGO_HOME` to the account's when the environment has none, and `RUSTUP_HOME` only if it exists. | `backend/tests/test_cli_runtime_build.py` (three tests: the failure message names what it needs and how to skip; the crate declares a `rust-version` and the message quotes it; `CARGO_HOME` and `RUSTUP_HOME` cases). The 1.85 floor itself is a method result, not a test: 1.85 built and tested the crate, 1.80 did not. |
| **N7** Low: a build that gave up left an older staged runtime in the package | Fixed | `scripts/build-cli-runtime.mjs` removes the staged binary when it gives up. `build-stt.mjs` is unchanged, as decided. | `tests/infrastructure/cliRuntimePackaging.test.ts` "a build that gives up leaves no older runtime staged" (3 tests). With the `rmSync` removed, the test failed. |

### The fake-CLI proof (goal 1, end to end)

A throwaway CLI, `fakecli`, was added as the guides describe: one
declaration `src/vendors/fakecli.rs` and one `launch` record, devin-like (no
log reader, no resume). Then the checked-in copies were regenerated
(`NAVIDE_DECLARATIONS_WRITE=1 cargo test --test checked_in`) and the whole
backend and frontend suites run. Everything was then reverted; no fake file is
in any commit (`git status` clean of it).

- **Registration works with no list edited.** The backend registered
  `fakecli` from its declaration in the right place; the frontend `agents`
  index did the same; the four recording lists needed no edit.
- **The suites still wanted, per CLI:** an entry and a fixture in the CLI
  regression catalog (`catalog.py`, `catalog.json`; the inventory gate aborts
  the whole run with "vendor coverage differs"); a row in
  `tests/cli/vendorContracts.test.ts`; and hand lists that name every CLI:
  the launch-argv inventory, the three READMEs, the Help panel table and
  `helpCliFacts.ts`, native memory, verified versions, risk declarations,
  extensions; in the frontend, the plans "retained" row, `TURN_START_SIGNAL`
  and the ControlPane cap. Of 12 backend failures in the first pass, 4 were
  the recording tests and the spec list (fixed by the relaxations and N5
  above); 8 are these policy lists.
- **Decision:** those lists are product policy (a CLI is not shipped until
  someone says what its README, risk and version are), not recordings of
  main, so they are not relaxed. They are listed in the guides and DESIGN.md
  as the work a new CLI really needs; "one file" is true of the runtime and
  the registration, not of the whole repository.

### Commands and results (round 3, after the last change)

| Command | Result |
|---------|--------|
| `cargo test --offline` (crate) | 37 passed. |
| `cargo check --offline --all-targets` (crate) | Finished, no warnings (also clean with `RUSTFLAGS="-D warnings"`). |
| switch off: `test_cli_runtime_seam.py`, `test_cli_runtime_build.py`, `test_pyinstaller_spec.py` | 35 passed, 1 skipped (Windows only). |
| switch off: `test_cli_declarations.py`, `test_cli_vendors_registry.py` | 128 passed. |
| switch on: `uv --project backend run pytest -p tests.cli_runtime_on backend/tests/vendors backend/tests/test_cli_runtime_parity.py backend/tests/test_cli_runtime_seam.py backend/tests/test_claude_activity_resume.py backend/tests/test_activity_high_water.py` | 881 passed, 4 skipped; fallback 0 for every observed CLI. |
| `node scripts/changed-backend-tests.mjs`, in full, after the last change | exit 0: 16638 passed, 111 skipped, 1 xfailed, then the serial pass 105 passed, 4 skipped. |
| `uv --project backend run ruff check` on the changed Python files | all checks passed. |
| `bun run vitest run tests/infrastructure/cliRuntimePackaging.test.ts src/renderer/src/platform/plugin-shell/agents` | 107 passed (4 files). |
| `bun run vitest run --changed upstream/main` | 20506 passed, 1 failed: `src/main/plugins/pluginExternalWorkspace.test.ts`, `Executable not found in $PATH: "pnpm"`. This machine has no pnpm and the install is a network step; the test is not touched by this branch. Run alone it fails the same way. It is the same pnpm failure as in round 2. |
| `bun run typecheck:web` | no errors. |

Not verified: the Linux run (CI's `cli-runtime` job is its first), a release
dry run (signing, notarization, package contents), and the `pnpm`-based
external workspace test above.

## Fix round 2: every review 2 finding

"Before" is what the code at `aec1a324b` did. Each fix names the test that
shows it; where that test was run against the unfixed code, the result is
given.

### Acted on

| Finding | Status | What changed | The test that shows it |
|---------|--------|--------------|------------------------|
| **B-1** High, **A goal 1**: adding a CLI edited two shared registries | Fixed | A declaration names the CLI's place in the two lists (`Cli::order.menu`, `order.registry`). `cli_vendors/registry.py` imports each declared CLI's module by its key; `agents/index.ts` finds spec files with `import.meta.glob`. Neither keeps a list, and a declared CLI with no adapter file is registered from its declaration alone. `AgentKey` is the declared keys, so the frontend copy of the declarations became a typed constant (`agents/_cli_declarations.ts`). DESIGN.md and `docs/en-US/cli-extension-guide.md` state exactly which files a new CLI needs. | Backend: `test_cli_vendors_registry.py::test_registry_is_discovered_in_mains_order` (main's order, recorded; each spec is its module's `SPEC`), `test_a_declared_cli_with_no_module_is_registered_from_its_declaration`, `test_a_vendor_module_that_cannot_be_imported_is_not_mistaken_for_a_missing_one`, `test_pyinstaller_spec.py::test_every_vendor_module_is_a_hidden_import`. Before the hand tuple was deleted, a one-off test compared the discovered tuple with it, spec by spec, by identity: 20 of 20, same order. Frontend: `agents/__tests__/declared.test.ts` "lists the specs in the order main listed them", `specs.test.ts` "lists every spec file, found without being registered". |
| **B-2** High, **A-N1** Medium: the currency test compared the JSON with a prebuilt binary and skipped without one; no CI ran the crate | Fixed | `tests/checked_in.rs` (plain `cargo test`, no binary) compares both checked-in copies with what the source prints and rewrites them on request. The backend currency test runs `cargo run -- declarations launch`. Every backend test that runs the runtime has cargo bring the release build up to date first (`tests/cli_runtime_build.py`): with `NAVIDE_CLI_RUNTIME_REQUIRED=1` a runtime that cannot be built is a failure, never a skip. CI has a `cli-runtime` job on Linux and macOS, on the backend scope of `scripts/ci-changed-scopes.mjs` and in the required gate: `cargo check` with warnings denied, `cargo test`, the sidecar build, the backend's runtime tests with the switch off, then the vendor suites with `-p tests.cli_runtime_on`. | `tests/checked_in.rs::the_checked_in_declarations_are_what_the_source_prints`: run after `order` was added to the declarations and before regenerating, it failed on the stale JSON with no release rebuild. `tests/infrastructure/cliRuntimePackaging.test.ts` ("Rust CLI runtime in CI"), `ciPathFilter.test.ts`. |
| **B-3** Medium, **A-N2** Medium: one dead process counted once per waiting caller | Fixed | Every process that becomes the current one has a generation; `_process_failed` counts a generation once, under `_state`. | `test_cli_runtime_seam.py::test_one_dead_process_is_one_failure_however_many_callers_waited`: 8 callers behind a barrier, a stand-in that exits once all 8 are waiting. Before: `failures == 8`, breaker open. After: 1, `waiting-to-restart`. |
| **B-4** Medium, **A-N10**: `Vendor::probe` took `&mut dyn FnMut` | Fixed | `probe` is generic over the query function. `src/` holds no `dyn`. `registry::observer(key)` builds the one observer asked for. | Compile-time; `grep -rn dyn src/` is empty. |
| **Packaging** (A, B): no build step put the binary in a package | Wired, not yet exercised | `scripts/build-cli-runtime.mjs` (modelled on `build-stt.mjs`; `build:cli-runtime`) stages the release binary in `build/cli-runtime/`; the macOS and Linux `extraResources` copy it to `<resources>/bin`; `release.yml` builds it where it builds the speech sidecar (required on macOS arm64 and Linux x64, best-effort on the Linux arm64 dry run), verifies its Developer ID signature and hardened runtime on macOS and its presence in the Linux AppImage. Windows carries nothing, and the script, `package.json` and the tests say so. **A release dry run is still needed**: none was run, so signing, notarization and the package contents are unverified. | `tests/infrastructure/cliRuntimePackaging.test.ts` (16 tests: script, staged name against the seam's, both resource lists, no Windows entry, the three release jobs, the macOS and Linux verify steps). The script itself was run: it built and staged the binary. |
| **Routed-call overhead** (manager; the harness's 0.19 ms against 0.10 ms) | Reduced; the boundary's own cost remains | Found with `backend/tests/bench_cli_runtime.py`: every call read the **whole transcript** to look at the header lines a slot is seeded from. Fixed in `observe/file.rs::all_lines` (line by line, no further than asked) and one path lookup saved in the tail read. Numbers under "Micro-benchmark". | `observe/file.rs::a_header_read_stops_at_the_lines_it_was_asked_for` (a pipe that never ends: the old read would not return). |
| **A-N3** Low: a call registered as the reader thread ended waited out its timeout | Fixed | `dead` is set and checked under the lock a call registers under. | `test_a_call_that_arrives_as_the_process_dies_does_not_wait_out_its_timeout`. Before: `TimeoutError` after 30 s. |
| **A-N4** Medium if confirmed: `joined` read a cell's type after converting it to text | Confirmed, fixed | The type is read first. | `observe/sqlite.rs::a_blob_that_is_not_utf8_is_joined_as_a_blob`. Written first, it failed against the old order: `joined` returned `None` for a BLOB holding `0xFF`. |
| **A-N5** Low: an error answer logged on every poll; a panic dropped a whole lane's reader memory | Fixed | The seam logs an error answer once per CLI and kind (`status()` still counts every one). A panic replaces only the observer of the request's CLI. | `test_an_error_answered_on_every_poll_is_logged_once_and_counted_every_time` (before: 5 warnings); `wire.rs::a_panic_costs_only_its_own_clis_reader_memory` (before: the other CLI's observer was rebuilt too). |
| **A-N6** Low, **A-D2** frontend: 17 hand-written resume patterns | Partly generated; the rest documented | `declared()` derives `resumeCommandPattern` from the declared program, base arguments and resume arguments: the command Navide itself builds. Six hand-written patterns that only repeated it are deleted (antigravity, codex, goose, grok, muse, pi), and claude, droid and qwen now carry the pattern that was App.vue's generic fallback for them. Seven stay hand-written because they recognize more than the declared command, which the declaration's resume arguments cannot express: a short-flag alias (kilo, kimi, opencode), the `=` and spaced forms both (copilot, cursor, openclaw), a former program name (cursor), arguments in between (hermes, openclaw). aider's is for its id-less restore. Deriving them from `resume.parse` instead was tried on paper and rejected: it would change what six CLIs recognize (it would add `=` forms and aliases main's patterns refuse). | `declared.test.ts` "%s recognizes a resume command as on main": all 20, the regex source compared with a recording of main's (or the generic shape where main had none). |
| **A-N7** Low: a reader call after `shutdown()` started the process again | Fixed | `shutdown()` sets a flag `_client_for_call` honours; applying the switch clears it. | `test_a_call_after_shutdown_does_not_start_the_process_again`. Before: a new process was asked `observes` and `usage`. |
| **A-N8** Low, **A-D4** residual: antigravity opened two connections per walk | Fixed | A slot seeded from the database is declared (`SqliteRecords::seeds`, `StoreSeed`) and read on the walk's own connection; `sqlite::joined(path, …)`, the second opener, is gone. | The antigravity parity fixtures replay unchanged. No test counts connections: `Db::open` has one caller and nothing else opens one. |

### Not acted on

| Finding | Why |
|---------|-----|
| **A-N9** Low: the rule-coverage trace does not see effects, `Settling.when`, `revisit.when`, label queries, initialiser alternatives, `Ext` branches or the parts of `ExactTurns` | Not small. Each of those is a separate trace point in the engine and needs a fixture record that reaches it, recorded from main's Python; several (orphan handling in exact turns) have no recorded scenario yet. Left as stated in round 1: the check covers rule matches. |
| **A**, small leftover: `LINE_KEY` repeated in 8 vendor files | Each is a `const` of that vendor's own `Text<V>`. Sharing it needs a generic associated constant holding a promoted slice, which was not tried; eight one-line constants were judged cheaper than the risk. |
| **A**: the opencode / kilo `reads` and `deferred` costs (the Rust path depends on the Python reader; deferral is per CLI, not per database; a busy database is read twice) | Port debt by the reviewer's own verdict, not a defect of this stage. Carried under "Not done". |
| Header slot read on every call (found by the benchmark) | See "Micro-benchmark": about 15 of the remaining 35 µs. Matching main's per-file cache needs the observer's memory in slot initialisation at seven call sites and a per-CLI declared choice; planned with the next wire. |

Two things review 2-A pointed at in this report are corrected below: the
backoff is `1 s × 2ⁿ`, so 1, 2, 4 and 8 s before the breaker opens at the
fifth failure, and the 60 s cap in the code is not reached with these
constants; and "one connection per observer call" is now true of antigravity
too.

### Found while fixing

- **The crate's unit tests were flaky on macOS once a SQLite unit test joined
  them**: the PTY test's child was killed with signal 9 before it wrote
  anything, in 12 of about 58 runs. In none of 16 runs with the SQLite test
  left out, and none of 16 with its connection opened under
  `session::FD_FORK_LOCK`, which is what the test now does. The cause is not
  established (a hypothesis only: the system SQLite's descriptors across
  `fork`). It matters for the next stage, where one process will both read
  SQLite stores and fork panes; `session.rs` and DESIGN.md record it.
- The same PTY test read its child's output after the child had exited, and
  its drain helper threw away a read that returned data right after the
  exit. The child now waits for a line and the output is read while it is
  alive.
- Two `wire.rs` tests swapped the process's panic hook at the same time, so
  the silent hook could stay in place and hide another test's failure
  message. They take turns now.

## Micro-benchmark

`uv --project backend run python backend/tests/bench_cli_runtime.py <rounds>
<earlier>`: a Claude transcript in the fake agent's format grows by one
record, then `parse_incremental` and `parse_activity` are called, `rounds`
times, on a transcript that already holds `earlier` records. macOS, release
build, microseconds per call, median; "mean" is the mean of the two methods.

| Transcript | main's Python reader | Routed, before | Routed, after |
|------------|---------------------:|---------------:|--------------:|
| starts empty, 2,000 rounds | 22.9 | 82.1 | 61.8 |
| 20,000 earlier records, 500 rounds | 23.5 | 392.5 | 62.7 |

Re-run in round 7 (2026-11-14, macOS, release build, head `a8d6d00fa` plus
the round 7 changes, which the benchmark's Claude transcript does not touch):
`uv --project backend run python backend/tests/bench_cli_runtime.py` (2,000
rounds, starts empty) and `... bench_cli_runtime.py 500 20000`. The first
table's "after" column was measured before round 6; these are the current
numbers.

| Transcript | main's Python reader | Routed, round 7 |
|------------|---------------------:|----------------:|
| starts empty, 2,000 rounds | 22.6 | 63.1 |
| 20,000 earlier records, 500 rounds | 22.5 | 65.0 |

Per method (µs, round 7): `parse_incremental` 24.2 / 63.3 and
`parse_activity` 21.0 / 63.0 (empty start); 24.2 / 65.3 and 20.7 / 64.7
(20,000 earlier). One routed usage call taken apart (empty start): encode
1.6, pipe 11.5, threads 8.0, rust 35.8, decode 1.5, objects 0.5. Every call
was answered by the runtime (`fallback` 0). The routed call is about 3 times
Python's, as before round 6; the perf harness was not re-run.

"Before" in the first row is the runtime as built at `aec1a324b` plus this
round's earlier commits (the read path was untouched until then). The second
row's "before" was measured with the old whole-file read put back beside the
new code for one run, since the old binary was gone by then; that slightly
overstates it (the same construction gave 88.0 where the true old binary
gave 82.1 in the first row).

One routed usage call, taken apart (after; 20,000 earlier records):

| Part | µs |
|------|---:|
| request encoded to a JSON line (Python) | 1.7 |
| pipe round trip and the runtime's own request handling (a `ping`) | 12.4 |
| the seam's writer and reader threads and the caller's queue | 7.0 |
| the read itself in Rust, with its larger answer | 35.1 |
| answer parsed (Python) | 1.6 |
| result objects built (Python) | 0.4 |

Inside the 35 µs, measured in the runtime with a throwaway timing test: the
slot header read about 15, the tail read about 20, request parsing 2,
building and serialising the answer 3. JSON is not where the time goes; file
opens are (two per call on macOS).

What this means for the harness's result: its transcripts were short (180
records at most), so the whole-file read was a small part of its 0.19 ms.
The fix removes a cost that grew with the transcript (20 µs per call by
2,000 records, 330 by 20,000) and will move the harness's number only a
little; that was not re-measured with the harness, which was not run this
round. The rest of the gap to Python is the process boundary
(about 19 µs) and the per-call header read, neither of which this round
removes; DESIGN.md has the plan (a framed duplex channel before PTY and
WebSocket work, the header value kept per file with it). No
unchanged-file shortcut was added in Python: main's reader has none.

## Fix round 1: every review finding

"Before" is what the unfixed code did. Where a test could show the failure it
is named; where it could not, that is said.

### Design (review A D1–D7, review B design 1, 5, 6)

| Finding | Status | What changed | The test that shows it |
|---------|--------|--------------|------------------------|
| **A-D1** High: the shared vocabulary was the union of every vendor's quirks | Fixed | A vendor is a type implementing `decl::Vendor`; the observer is `Observer<V>`, monomorphised. One-vendor value extraction moved out of `Pred`/`Text`/`Num`/`SlotInit` into each vendor's `Ext` enum and its pure functions (`text`, `num`, `pred`, `init`, `probe`). Every remaining record-reading variant has two or more users, or is a combinator (DESIGN.md lists which, and which single-user items stay because they are mechanics). DESIGN.md says a new store shape is a core change by design. | `tests/extensibility.rs::observe_runs_end_to_end` declares a CLI outside `src/` with an `Ext` of its own and no core edit. The 27 parity fixtures replay unchanged in meaning through the new engine. |
| **A-D2** High: the Rust declaration was an additional source; three stages unused | Fixed | `declarations launch` is exported to `backend/agent_team_backend/cli_declarations.json` and an identical copy in the frontend's `agents/`. All 20 backend vendor modules and all 20 frontend agent specs read launch and resume through `declared(key)`; the hand-written copies and 16 Python `_resume_id_from_command` functions are deleted. Unused pieces removed: `Observe.store`, the wire's `argv` op, `launch.rs`. `session.rs` is kept and DESIGN.md says plainly it is not wired. `main.rs`'s header is corrected. | `backend/tests/test_cli_declarations.py`: `test_launch_and_resume_fields_are_mains` and `test_resume_ids_are_mains` compare against a recording of main's values and of the id each of main's parsers read from about 4,800 commands (`cli_declarations_main.json`, recorded before the old copies were deleted); `test_the_checked_in_declarations_are_current`; `test_backend_and_frontend_read_the_same_declarations`; `test_the_runtime_names_the_same_sessions`. Frontend: `agents/__tests__/declared.test.ts`. Before: 13 CLIs' launch declarations differed from main (no `env_strip`; kimi's spawn default). |
| **A-D3** Medium, **B-design-1** High: stringly slots, run-time validity, no traits | Fixed | `slots!` makes a typed enum per vendor (a misspelt slot does not compile; a lookup is an array index). `Cursor` and the usage modes are folded into each backend's own `Spec` (`JsonlRecords`, `TextRecords`, `SqliteRecords`), so an illegal combination cannot be written. `unreachable!` replaced by `Error::Unsupported`. Protobuf extractors get raw bytes (`Scope::blob`), no hex round trip. `Vendor`, `Backend<V>`, `SlotKey`, `Visit` are traits with static dispatch. | Compile-time for slots and combinations. `proto.rs::scans_like_mains_pb_scan`; `tests/declarations.rs` for what is left to check at run time. |
| **A-D4** Medium: a connection and a schema check per query, no key cache | Fixed | One connection per observer call (`db.rs`, `Conn`; `Db::open` has one caller), `requires` checked once on it, resolved partition labels kept in the observer (`Memo.labels`), unresolved ones not. | No test counts connections; it holds by construction. `openclaw_db` fixture exercises the label cache across polls. |
| **A-D5** Medium, **B-design-5** Low: generic code in a hook, duplicated, run per row | Fixed | `unquote` and the POSIX path normaliser are in `src/text.rs`, used by both. antigravity's workspace is a slot initialiser, computed once per walk. | `text.rs::unquote_matches_urllib`, `posix_paths_and_enclosures`; `antigravity.rs::workspace_prefers_a_directory_then_frequency_then_length`. |
| **A-D6** Low: boilerplate in every vendor file | Fixed | `Turns::None` / `Turns::Inferred`; constructors `Launch::of`, `Reading::of`, `Activity::rules`, `Emit::active` / `done` / `last`, `FileUsage::per_record`, `Anchored::of`; `unobserved!`. | — |
| **A-D7** Low: dead vocabulary | Fixed | `Num::MapSum`, `Num::Required`, `Effect::SetOnce` removed, with everything else nothing read (`Observe.store`, the `argv` op, `launch.rs`, `Db::scalar`). | `cargo check --all-targets`: no warnings. |
| **B-design-6** Low: Windows PTY and file identity, `session.rs` not on the wire | Not fixed (by decision) | Off Unix the runtime observes nothing (A-S6). PTY ownership is not part of this round; DESIGN.md says so. | — |

### Seam (review A S1–S8, review B design 2–4)

| Finding | Status | What changed | The test that shows it |
|---------|--------|--------------|------------------------|
| **A-S1**, **B-design-2** High: no read timeout under one lock the switch-off path also took | Fixed | A writer thread and a reader thread own the pipes; a caller waits for its answer on its own queue with a timeout (10 s), holding no lock. On timeout the process is killed and Python answers. `apply(False)` sets a flag and kills the process without any lock a call holds. | `test_cli_runtime_seam.py::test_a_stalled_process_times_out_and_python_answers`, `test_switching_off_returns_at_once_and_frees_a_stalled_call` (a stand-in process that never answers). |
| **A-S2** Medium: no backoff; a panic killed shared state | Fixed | `catch_unwind` per request in `serve`. In the seam: restart after `1 s × 2ⁿ` (1, 2, 4, 8 s; the code's 60 s cap is not reached before the breaker opens), and after 5 failures in a row the runtime stays on Python until the switch is flipped, saying so once. Round 2 made a failure a process, not a caller (B-3). | `wire.rs::a_panicking_request_answers_an_error_and_the_next_one_is_served`; `test_a_process_that_keeps_dying_is_given_up_on_and_said_once`, `test_a_failed_process_is_not_restarted_before_its_delay`. |
| **A-S3** Medium: one lock and one single-threaded child | Fixed | `serve` answers on four worker lanes keyed by vendor and path (one file's reads stay in order, different files run side by side); the Python side holds no lock across a call. | `wire.rs::a_slow_read_does_not_hold_up_another_file`, `one_files_requests_are_answered_in_order`. |
| **A-S4** Medium: switch on with no binary was silent | Fixed | Logged once. Outcomes are counted per CLI (`rust`, `unsupported`, `unreadable`, `deferred`, `fallback`) and reported in `/health` diagnostics. | `test_switched_on_without_a_binary_says_so_once`, `test_status_counts_who_answered`, `test_health_diagnostics.py::test_health_reports_the_rust_cli_runtime_switch`. |
| **A-S5** Low: `_stop()` could stall the event loop | Fixed | The process is reaped in a thread. | `test_switching_off_returns_at_once_and_frees_a_stalled_call`. |
| **A-S6**: file identity off Unix, spawn flags, the wrong osplat helper | Fixed | Off Unix `observes` answers nothing, so nothing is routed. `osplat` has `bundled_executable(name)` and `helper_process_options()`. | `test_osplat_windows_discovery.py` (both helpers, Windows and POSIX). The off-Unix `observes` answer is a `cfg` constant and was not run: this machine is macOS. |
| **B-design-3** High: missing shutdown; binary found only in a dev checkout | Fixed, except packaging | A shutdown handler of its own (`app._stop_cli_runtime`, registered after `_stop_log_watcher`, so the watcher has stopped) calls `cli_runtime.shutdown` through `asyncio.to_thread`. `binary()` looks where a packaged app keeps its sidecars (`frozen_env.packaged_bin_dir()`), as `navide-stt` does. Packaging was not done in round 1; round 2 wired it (see above). | `test_shutdown_seen_flush.py::test_the_rust_cli_runtime_is_stopped_off_the_event_loop_after_the_watcher`; `test_the_binary_is_looked_up_like_the_other_sidecars`. |
| **B-design-4** Medium: `cost_ledger.py` built readers outside `wrap` | Fixed | Both sites wrap. | `test_the_cost_ledgers_own_readers_go_through_the_switch`. |
| **A-S7** Low: text describing a UI that does not exist; guide not updated | Fixed | The seam's and `app.py`'s text say there is no toggle. `docs/en-US/cli-extension-guide.md` has the declaration steps and the switch; `docs/adding-a-cli-vendor.md` starts with them. | — |
| **A-S8** Medium: the switch-on suite could not tell Rust from a silent fallback | Fixed | `tests/cli_runtime_on.py` prints who answered every routed call per CLI and fails on any fallback, or on a declined store whose CLI is not listed with its reason (`EXPECTED_UNSUPPORTED`). | The table under "Commands and results". |

### Parity (review A P1–P5, review B parity 1–5)

Before the fixes, `cargo test --test parity` on the unfixed crate with the new
fixtures reported 12 mismatches (aider turns, claude cwd and bad-bytes turns,
muse subagent turns, openclaw unkeyed, and others). All fixtures were recorded
from Python with the switch off.

| Finding | Status | What changed | The test that shows it |
|---------|--------|--------------|------------------------|
| **A-P1**, **B-parity-3** Medium: claude cwd not NFC | Fixed | The declaration says `cwd_form: Form::Nfc`; the runtime hands the cwd on as written and the seam normalises it. No new Rust dependency. | `claude_rules` fixture (a cwd written decomposed), through the seam in `test_switch_on_matches_python[claude_rules]`. |
| **A-P2** Medium: muse sub-agent turns | Fixed | `Vendor::accepts` gates usage and activity only; turns are gated by the file name, as main's are. The fixture compares turns (no `skip_turns`). | `muse_subagent` fixture. |
| **A-P3** Low, **B-parity-2** Medium: naive ISO stamps as UTC | Fixed | `time.rs` reads a naive stamp as local time, with CPython's algorithm over `libc::localtime_r`. | `tests/local_time.rs::a_naive_stamp_is_read_in_the_local_zone` (sets a non-UTC `TZ`). Not run against the old code, which read naive stamps as UTC by its own comment. |
| **B-parity-1** High: an unkeyed openclaw session aborted the whole pass | Fixed | A partition no query labels keeps its own name and leaves a note; the keyed ones are read. The seam logs the note once, through the reader's logger. | `openclaw_db` fixture (a step with an unkeyed session); `test_what_the_reader_would_log_is_logged_once_through_its_own_logger`. |
| **B-parity-4** Medium: aider `turns()` line splitting | Fixed | The whole-file usage pass reads with the same `text_lines` as the walk (`\n`, `\r\n`, a lone `\r`, an unterminated last line). | `aider_history` fixture's last step; `file.rs::text_lines_follow_universal_newlines`. |
| **A-P4** Low, **B-parity-5** Medium: fixture coverage | Fixed, and now enforced | New fixtures and steps: `claude_rules` (background tasks, `AskUserQuestion`, `TaskStop`, queue operations, compact and meta prompts, a malformed line), `claude_dash_dir`, `claude_bad_bytes` (a line that is not UTF-8), `codex_rewrites` (truncation, replacement, the `basis` upgrade, an empty `__lasttext__:`), openclaw unkeyed, aider `\r` and unterminated token lines, and more below. The parity test now traces which activity and usage rules match and **fails for a declared rule no fixture record reaches**. It found 8 (a qwen task notification, a legacy codex record, a goose action response, Kilo's OpenCode 2 rows); each has a recorded step now. | `tests/parity.rs::every_fixture_matches_mains_readers_and_every_rule_has_a_record`. Not traced: the effects inside a rule, and the parts of an exact-turns declaration. |
| **A-P5** Low: openclaw unkeyed sessions fell back every call | Fixed | By B-parity-1 and the D4 cache. | As B-parity-1. |

### Coverage (review A §6, review B 2.6)

| Item | Status | What changed | The test that shows it |
|------|--------|--------------|------------------------|
| **copilot** | Declared | The 1.0.78+ central store: an anchored row watermark for usage (`SqlUsage::Anchored`), a walk over two tables for activity (`SqlWalk::Tables`). Any other file answers `Unsupported`, so main's reader still reads the 1.0.75 `events.jsonl`; so does a store that cannot be read, which main's reader warns about. `Num::MapSum` was removed (A-D7). | `copilot_store` fixture (a rebuilt store, a row replaced under the watermark); `tests/vendors/test_copilot.py` with the switch on: 56 calls answered by Rust, 29 declined as declared. |
| **opencode, kilo** | Declared, both | One declaration (`vendors::opencode::store!`) expanded for the two vendor types. The schema is chosen per read by the vendor's probe (`SqlUsage::OneOf`, `SqlWalk::OneOf`, `Vendor::probe`). The anchored watermark gained rows still settling (`pending`), a tag naming the table it was taken on, and a lookup the store may not answer (`session.version`). The wire carries `reads`, which the seam applies to the reader's `read_problem()` registry. | Fixtures `opencode_v1`, `opencode_v2` (an upgraded database; a 1.x mark; a 1.x binary writing last, disclosed and then cleared), `opencode_odd_schema` (unknown, then half-upgraded), `kilo_store`, `kilo_v2`: each step compares the open read problem too. `test_what_the_schema_check_finds_reaches_the_readers_problem_registry`, `test_a_failing_query_is_the_readers_to_record_and_to_clear`. |

One thing here is narrower than the brief's wording, on purpose. The wire's
`reads` carry what the schema check finds (which the runtime decides). A
**query that fails** is not reported over the wire: the call answers
`Unsupported`, main's reader makes the same read and records why with its own
classification and sqlite's message, and while it has a failing query on
record it makes its own reads (`OpencodeLogReader.reads_itself()`, the one
method added to main's reader), so the query that recorded a problem is the
one that clears it. Reporting failures from Rust would have meant a second
copy of main's transient-error rules and of its registry keys, which are its
SQL strings.

## What the branch holds

- **Core** (`src/` without `src/vendors/`): the vendor and backend traits,
  the record-access language, three backends (JSONL, text log, SQLite), the
  activity walk with the inferred-turn tracker, exact and inferred turns, the
  seen-keys bag codec, the wire. No vendor is named in it.
- **Declarations**: all 20 CLIs of main's registry, one file each, with
  launch and resume. Records are declared for 17: aider, antigravity, claude,
  codex, copilot, cursor, droid, goose, grok, hermes, kilo, kimi, muse,
  openclaw, opencode, pi, qwen. devin, kiro and mcode have no log reader on
  main.
- **Single source**: the two generated copies of `declarations launch`
  (`cli_declarations.json` for the backend, `agents/_cli_declarations.ts` for
  the frontend), read by `cli_vendors/_declared.py` and `agents/_declared.ts`.
  They are also the list of CLIs: `cli_vendors/registry.py` and
  `agents/index.ts` are built from them and keep no list of their own.
- **Seam**: `backend/agent_team_backend/cli_runtime.py`, off by default.
- **Packaging and CI**: `scripts/build-cli-runtime.mjs`, the macOS and Linux
  `extraResources`, the `release.yml` steps, and CI's `cli-runtime` job.

## Size (`wc -l`)

| Part | Lines |
|------|-------|
| Core: `src/` without `src/vendors/` (22 files, 7,018, unit tests included) plus `build.rs` (35); counted after round 6 | 7,053 |
| Declarations: `src/vendors/` (20 files) | 3,427 |
| of which extension code: each file's `Ext` enum, `impl Vendor` and helper functions, unit tests excluded (round 1's count by item line ranges, less the 6 lines of antigravity's removed `init`) | about 700 |
| of which the three launch-and-resume-only files (devin, kiro, mcode) | 45 |
| Crate tests: `tests/*.rs` (parity replay and rule coverage, declaration checks, the checked-in copies, the extensibility toy CLI, local time) | 728 |
| Parity fixtures: `tests/parity/*.json` (round 6 added 6 probe fixtures) and `tests/json_dialect.json` (55 cases) | 33 files, 1 file |
| Seam: `cli_runtime.py` | 913 |
| Readers of the generated declarations: `_declared.py` 133, `_declared.ts` 97 | 230 |
| The two registries: `cli_vendors/registry.py` 148 (was 160, with its hand list), `agents/index.ts` 67 (was 76) | 215 |
| Tooling: `scripts/build-cli-runtime.mjs` 62, `backend/tests/cli_runtime_build.py` 112, `backend/tests/bench_cli_runtime.py` 208 | 382 |

The core grew by 221 lines in round 2: `StoreSeed` and `Order` in `decl.rs`,
the bounded header read, and unit tests (the header read on a pipe, the
SQLite cell type, a panic's reach, the test database writer).

Extension code by file (round 1's count): aider 120, antigravity 90, cursor 64, opencode 60
(shared with kilo), grok 51, openclaw 49, claude 43, goose 39, muse 37,
hermes 34, qwen 30, codex 29, kimi 25, pi 21, copilot 7 and droid 7 (their
`impl Vendor` only; both declare `NoExt`).

## Commands and results

Run in this worktree on macOS (rustc 1.99.1), on the final code of round 2.
Nothing was run on Linux or Windows.

| Command | Result |
|---------|--------|
| `cargo test --offline` (in `native/navide-cli-runtime`) | 37 passed, 8 suites |
| `cargo check --offline --all-targets`, and again with `RUSTFLAGS="-D warnings"` as CI runs it | clean, no warnings |
| `cargo build --release --locked`; `NAVIDE_CLI_RUNTIME_REQUIRED=1 node scripts/build-cli-runtime.mjs` | built; staged in `build/cli-runtime/` |
| switch off: `uv --project backend run pytest backend/tests/vendors backend/tests/test_cli_runtime_parity.py backend/tests/test_cli_runtime_seam.py backend/tests/test_claude_activity_resume.py backend/tests/test_activity_high_water.py backend/tests/test_cli_declarations.py backend/tests/test_cli_vendors_registry.py backend/tests/test_health_diagnostics.py backend/tests/test_shutdown_seen_flush.py backend/tests/test_osplat.py backend/tests/test_osplat_windows_discovery.py backend/tests/test_pyinstaller_spec.py` | 1,101 passed, 3 skipped (the runtime built from source by the tests) |
| switch on: `uv --project backend run pytest -p tests.cli_runtime_on backend/tests/vendors backend/tests/test_cli_runtime_parity.py backend/tests/test_cli_runtime_seam.py backend/tests/test_claude_activity_resume.py backend/tests/test_activity_high_water.py` | 878 passed, 4 skipped (the mcode package is not installed; the 3 Python read meters, reason printed); fallback 0 for every observed CLI |
| `node scripts/changed-backend-tests.mjs -- -n 4 --dist loadfile -m "not serial"` (the whole suite; re-run after the last change, exit 0) | 16,664 passed, 38 skipped, 1 xfailed in 3:30; its unsandboxed files: 105 passed, 4 skipped |
| `node scripts/changed-backend-tests.mjs -- -m serial` | 16 passed, 2 skipped (the script exits 5 here: its second pass has no serial test to select) |
| `uv --project backend run ruff check backend` | all checks passed |
| `bun run vitest run --changed upstream/main` (re-run after the last change) | 1,339 files, 20,551 tests, **1 failed**: `src/main/plugins/pluginExternalWorkspace.test.ts`, "Executable not found in $PATH: pnpm". pnpm is not installed on this machine; the test does not touch this branch's code, and CI installs pnpm for the job that runs it. |
| the affected files: `bun run vitest run src/renderer/src/platform/plugin-shell tests/cli plugins/navide-plans/src/retained` and the four tests that read the agent list | 29 files, 604 tests passed |
| `bun run vitest run tests/infrastructure` | 24 files, 266 passed, 4 skipped |
| `bun run typecheck` (node, integration, the plugins, web, public) | passed |

Inside the isolated runner (`changed-backend-tests`, which starts from an
empty environment with no cargo), the tests that drive the runtime used the
release build because it was newer than every crate source; one test skipped
there, the `cargo run` currency check, which the switch-off row above and
`tests/checked_in.rs` both ran.

Who answered the routed reader calls in the switch-on run:

```
aider        rust=69   unsupported=0   unreadable=0  deferred=0  fallback=0
antigravity  rust=59   unsupported=0   unreadable=0  deferred=0  fallback=0
claude       rust=122  unsupported=0   unreadable=0  deferred=0  fallback=0
codex        rust=131  unsupported=0   unreadable=0  deferred=0  fallback=0
copilot      rust=56   unsupported=29  unreadable=0  deferred=0  fallback=0
cursor       rust=56   unsupported=0   unreadable=0  deferred=0  fallback=0
droid        rust=55   unsupported=0   unreadable=0  deferred=0  fallback=0
goose        rust=31   unsupported=0   unreadable=0  deferred=0  fallback=0
grok         rust=47   unsupported=0   unreadable=2  deferred=0  fallback=0
hermes       rust=36   unsupported=2   unreadable=0  deferred=0  fallback=0
kilo         rust=52   unsupported=0   unreadable=0  deferred=0  fallback=0
kimi         rust=69   unsupported=0   unreadable=0  deferred=0  fallback=0
muse         rust=58   unsupported=0   unreadable=0  deferred=0  fallback=0
openclaw     rust=59   unsupported=2   unreadable=0  deferred=0  fallback=0
opencode     rust=152  unsupported=2   unreadable=0  deferred=7  fallback=0
pi           rust=61   unsupported=0   unreadable=1  deferred=0  fallback=0
qwen         rust=60   unsupported=0   unreadable=0  deferred=0  fallback=0
```

`unsupported` is a declared answer, listed with its reason in
`tests/cli_runtime_on.py`; `unreadable` is a file the test removed or made
unreadable, where the Python reader decides what that means, as on main;
`deferred` is OpenCode's reader making its own reads while it has a failing
query on record. No call fell back on a fault.

Failures on the way in round 2; the results in the table are from after
their fixes.

- The first switch-on run of round 2 ended with 2 failed, 876 passed: two of
  the new seam tests compared fallback counts exactly, and
  `tests.cli_runtime_on` routes the reader class as well as the instance, so
  each call is counted twice there. They compared "at least" for the rest of
  round 2; round 3 (N4) makes them exact again, multiplied by the number of
  routes. The switch-off runs before it could not show this.
- The first `--changed upstream/main` frontend run had 3 failures: the pnpm
  one above, `ciGate.test.ts` (the new CI job was not in its backend group)
  and `ciPathFilter.test.ts` (the new packaging test named a path under
  `backend/tests` as a string, which that ratchet reads as a frontend test
  reading backend tests). Both tests were corrected.
- The first full backend run of round 2 passed with every runtime test
  skipped: the isolated runner has no cargo on its `PATH`, and the tests had
  just been changed to build with cargo. The build helper's rule for that
  case (use the release build only when no source is newer) is the result.
- The crate's unit tests failed in about one run in five until the SQLite
  test was kept apart from the PTY test's fork (see "Found while fixing").

Round 1's two (three registry checks reading the spec sources by regular
expression; `test_acp_tui_unchanged.py` pinning `app._stop_log_watcher`) are
in the history of this file.

### CI run 43553202513 (round 2's push, `ee4d932d2`)

Three causes failed seven jobs (the gate job is the seventh, failing because
the others did). The first two are fixed; neither fix has run on the platform
it is for, so the next CI run is their first.

| Job | Cause | Fix |
|-----|-------|-----|
| Rust CLI runtime (Linux), "switch off" step: 52 failed, every one in `cli_runtime_build.cargo()` with "rustup could not choose a version of cargo to run … no default is configured". The steps after it did not run. | The suite's conftest points `HOME` at an empty directory before any test module is imported, and a rustup-managed cargo looks for its toolchains under `$HOME/.rustup`. The `cargo test` step before it ran in the step's own shell, with the real `HOME`. | `cargo()` runs cargo with `RUSTUP_HOME` and `CARGO_HOME` named from the account's home in the password database, unless the environment already names them. Test: `test_cargo_runs_with_the_accounts_rust_homes_not_the_suites_empty_home`. |
| Backend tests (Windows), all five shards: 26 failures, all `test_python_readers_match_the_parity_fixtures`. | The fixtures record what main's readers return on Unix. On Windows the same readers return the same paths with its separators (`<root>\share\…` in `file_path`, `path` and `cwd`, and a cwd of `\usr`); every differing line in the five logs is one of those. The same 26 failed on round 1's push (`aec1a324b`, run 43535726613), so this is not from round 2. | The test is skipped on Windows: the fixtures are for a runtime that is built on Unix only. The readers' own vendor tests still run there. |
| Backend tests (Windows, 3/5): `test_server_link_pin_audit.py::test_forget_called_after_settle_promotion[file]`, "condition never became true" after its 5 s wait. | Not from this branch, which changes no server-link code or test (`git diff upstream/main...HEAD` over those files is empty). It passed in the same shard on round 1's push. A wait that timed out once is all the log shows; the cause is not established. | None. |

Reproduced before the fix, on macOS, by putting a rustup-managed cargo first
on `PATH` with no `RUSTUP_TOOLCHAIN` set. This machine's environment names
its toolchain there, and with it named rustup does not fail under the
redirected `HOME`: it downloads and installs that toolchain into the empty
directory (`cargo --version` run that way printed "the missing active
toolchain … has been auto-installed"). So the round 2 runs passed here by
installing a toolchain into each run's throwaway home, which the fix also
stops.

- `cargo --version` with `HOME` at an empty directory printed the same rustup
  error as CI.
- `test_the_checked_in_declarations_are_current`, with the conftest's own
  `HOME`, failed with it too.

After the fix, in that same environment with `NAVIDE_CLI_RUNTIME_REQUIRED=1`,
the three files of the failed step passed (158). The new test, run with the
fix taken out, failed: the stand-in cargo was given no `RUSTUP_HOME`.

Why the macOS leg of the same job passed with the same rustup setup is not
established: nothing in its log shows how its cargo found a toolchain. (A
hypothesis only: that runner's environment names a rustup home or a
toolchain, as this machine's does.)

Re-run after these fixes, in the usual environment:

| Command | Result |
|---------|--------|
| switch off: the three files of the failed step, `test_cli_vendors_registry.py` and `test_pyinstaller_spec.py` | 193 passed, 1 skipped (Windows only) |
| switch on: the command in the table above | 879 passed, 4 skipped; fallback 0 for every observed CLI |
| `node scripts/changed-backend-tests.mjs -- -k "cli_runtime or cli_declarations"` (the isolated runner) | 159 passed, 1 skipped (the `cargo run` currency check; no cargo there) |
| `uv --project backend run ruff check` on the three changed files | all checks passed |

## Python defects found (main unchanged)

1. A line that is not UTF-8 raises `UnicodeDecodeError` in the JSONL activity
   walks after the mark has moved past the lines before it, so that walk's
   events are lost. The runtime reproduces it (`claude_bad_bytes`).
2. A JSON line that is valid but not an object (`[1]`, `"x"`) raises
   `AttributeError` in readers that call `.get` on it.
3. grok `_iso` raises `TypeError` on a non-numeric timestamp.
4. kimi (a quirk, possibly intended): after `turn.cancel` the tracker stays
   `cancelled` until the next `turn.prompt`, so every loop event in between is
   ignored, including reply text the CLI writes without a new prompt.
5. droid: `legacy_seen` grows without bound.
6. droid: a sidecar with invalid UTF-8 raises `UnicodeDecodeError`.
7. goose: a row whose counters are all zero is read again every cycle (the
   watermark only moves on an event).
8. goose, hermes: a `toolCall` that is not an object crashes the walk.
9. openclaw: `int(nan)` / `int(inf)` usage values raise.
10. openclaw: `remember()` matches marks by prefix, so a session whose id is a
    `::`-prefix of another's removes the other's mark.
11. openclaw: a `seq` like `--5` crashes `int()`.
12. antigravity: malformed `agy_pending::` JSON crashes `json.loads`.
13. cursor: a row without an id is keyed `blob:None`.
14. aider: activity's mark never moves back, so after the history is rewritten
    shorter, its first lines up to the old mark are never delivered
    (`set_activity_high_water` documents it as intended; the parity scenario
    shows the loss).
15. opencode (OpenCode 2): one `session_message` row whose `data` is not JSON
    makes `json_set` fail the whole usage query ("malformed JSON", recorded as
    `query-failed`), and no later usage read gets past that row while it is
    above the watermark. Found while recording the fixture; the row was taken
    out of the scenario because a declined read cannot be replayed.
16. copilot: a store read that fails is warned about once per process, so a
    second store failing for another reason is never mentioned.

(The first report listed muse's `turns_for_session` crediting a subagent
log's own usage as a defect. It is main's behaviour, and the runtime now does
the same: review A P2.)

## Rust differences from main (known)

Still open, all in cases no fixture or vendor test reaches:

- JSONL activity walks split on `\n` only; main's text mode also ends a line
  at a lone `\r`, which a JSON writer does not produce. Text logs (aider) do
  split on `\r`.
- opencode / kilo: a message id that is SQL `NULL` is keyed `msg:` (main:
  `msg:None`); a negative `seq` is not clamped to 0 when looking up a turn's
  reply; the reply of a 1.x turn is read in the same query as its `part` row
  (main: a second query, a moment later).
- opencode / kilo on Windows: main turns OpenCode 2's forward-slash paths
  back; the runtime observes nothing off Unix, so this is not written.
- Floats written with underscores (`"1_000.5"`) are not parsed where main's
  `_num` would.
- antigravity's workspace is recomputed every walk (main caches by mtime), and
  its is-a-directory test is relative to the process cwd for relative paths.
- A JSON BOM inside a SQLite BLOB (round 7): `json.loads(bytes)` detects the
  encoding, so bytes that start with a UTF-8 or UTF-16 BOM, or hold a NUL in
  the first 4 bytes (UTF-16 or UTF-32 without a mark), are handed to the Python
  reader (`pyjson::parse_bytes` answers `Python`); the runtime does not strip
  or decode them itself. A BOM in front of *text* (`json.loads(str)`) is still
  rejected, as main rejects it. Anything else that is not UTF-8 is `Rejected`.
- goose's store env value is not checked for being absolute.
- `\d` is ASCII in aider's matchers and `char::is_numeric` in hermes's (main:
  Unicode decimal digits); aider's case-insensitive words fold ASCII only.
  (C-N6, recorded in round 6: the Hermes difference is not fixed.)
- **Python reads a call (round 6).** A terminated line or JSON column that
  `serde_json` rejects and Python's `json.loads` may read (a lone surrogate
  escape, `NaN` / `Infinity`, a number out of a double's range or of any
  length, nesting past 128 levels) hands the whole call to the Python reader:
  the answer is the non-fault kind `python` (counted as `python`), nothing is
  committed. On an incremental path (usage, activity) the next call is the
  runtime's again once Python's reader has stepped past the record as main
  does. **That does not hold for whole-file passes** (`turns_for_session`,
  SQLite counters, full-usage passes): they have no checkpoint to move, so
  after one Python-only record they stay on Python for that file for as long as
  the record is in it (each poll is counted as `python`). That costs time and
  never a record. The rule is the classifier
  `pyjson::parse` (`Value`, `Python` or `Rejected`), not "any parse failure",
  which would have kept plain-text cells (hermes `content`, opencode rows that
  are not JSON) and corrupt lines on Python for good. The classifier is
  deliberately wider than Python (an out-of-range or malformed number is
  treated as `0`, nesting beyond 900 levels is Python's to read or raise on): a
  wider classifier costs a call, never a record. A record only Python parses
  inside the header region of a file keeps that file's *header reads* on
  Python until it is past the region. An unterminated last line only Python
  parses is handed over as well; an incomplete line is waited for as before.
  Sidecar JSON documents, the seen-keys bag and cursor parses are unchanged.
- SQLite (round 6): `mode=ro` is tried first, as on main; `immutable=1` is
  used only for a closed WAL database (no `-wal`, no `-shm`) that the system
  SQLite refuses, and a `-wal` that appears after such a read hands the call
  to Python. What is left: a writer that starts, commits and closes (so its
  `-wal` is gone again) between the open and that check is not noticed; a
  `mode=ro` read of main would have seen its rows, and the next poll does.
- Python, not Rust: the memory table (`native_memory.MEMORY_SOURCES`) is
  assembled in registry order, main's was in its own, and the order shows in
  one case. `candidates()` keeps the scope and relative path of the first row
  to reach a path, so when the workspace is itself a CLI's user directory
  (`~/.codex`) its `AGENTS.md` is listed under Project as `AGENTS.md`, where
  main listed it under User as `.codex/AGENTS.md`. The set of allowed paths,
  the readers and `canonical` are the same. Kept (no order reproduces main in
  every nested case); pinned by
  `test_native_memory.py::test_a_workspace_that_is_a_cli_s_user_directory_lists_the_file_under_the_first_row_that_reaches_it`.
- claude's three read-meter tests measure Python's own `Path.open` reads; with
  the switch on they are skipped by `tests/cli_runtime_on.py` with that
  reason, and the behaviour is tested in
  `observe/file.rs::a_stale_resume_point_reads_from_the_head`.

The list above was carried over from the first report where an item was not
touched this round; the JSONL `\r` item was re-read in the code.

## Not done

- **A release dry run.** Packaging is wired and tested as text
  (`cliRuntimePackaging.test.ts`), and the build script was run locally, but
  no release or dry run was run: the signed and notarized Mach-O, and the
  binary inside the Linux packages, are unverified until one is.
- **Linux.** Nothing of this crate or its backend tests was ever run on
  Linux locally (no Linux machine or container here). CI's `cli-runtime` job
  is its first run there.
- **The wire.** Still one JSON line per request over stdio; the framed duplex
  channel is planned in DESIGN.md, with the per-file header value.
- **The harness.** The perf harness was not re-run after the read-path fix.
- **opencode / kilo port debt** (review 2-A): the Rust path for copilot,
  opencode and kilo still depends on the Python reader for a failing query;
  deferral is per CLI, not per database; a busy database is read twice per
  poll.
- **Rule-coverage tracing** beyond rule matches (review 2-A N9).
- **A Settings toggle** for `rustCliRuntime`.
- **PTY ownership** (`session.rs` is kept, unwired), **Windows ConPTY** and
  **Windows file identity**.
- **devin, kiro, mcode**: main has no log reader; launch and resume only.
- **copilot's 1.0.75 `events.jsonl`** stays main's reader's (it reconciles
  against the store and needs a YAML file for its cwd).
- The first brief said 21 CLIs; main's registry has 20.
