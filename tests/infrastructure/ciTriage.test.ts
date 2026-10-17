import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyLog, mergeIntoLedger, splitJobLogs } from '../../scripts/ci-triage.mjs'

// Real lines from the 2026-10-15 PR runs (#266, #267), trimmed to what matters.
const PYTEST_RACE = `2026-10-15T04:18:03.0400740Z E                   subprocess.TimeoutExpired: Command '['python', '-m', 'tests.cli_regression.support.backend_entry']' timed out after 15 seconds
2026-10-15T04:18:03.6306030Z FAILED backend/tests/cli_regression/test_vendor_contracts.py::test_vendor_launch[kilo] - AssertionError: backend shutdown timed out; see /tmp/backend.log
2026-10-15T04:18:03.6307820Z ===== 1 failed, 11666 passed, 32 skipped, 21 warnings in 985.69s (0:16:25) =====`

const PYTEST_DEFECT = `2026-10-15T04:21:49.1950681Z FAILED backend/tests/test_share_mcp_tools.py::test_the_existing_tools_are_exactly_mains_and_the_share_tools_come_after - assert [{'descriptio...bject'}}, ...] == [{'descriptio...bject'}}, ...]
2026-10-15T04:21:49.8824370Z ===== 1 failed, 11638 passed, 61 skipped, 21 warnings in 750.43s (0:12:30) =====`

const VITEST_DEFECT = ` FAIL  |unit| src/renderer/src/composables/__tests__/useEvolve.test.ts > useEvolve > v1.1: over_budget is a warn row
AssertionError: expected [ Array(1) ] to deeply equal [ Array(1) ]`

const VITEST_TIMEOUT = ` FAIL  |unit| src/main/plugins/frontendPluginManager.test.ts > host > restarts a child
Error: Test timed out in 5000ms.`

const ENVIRONMENT = `2026-10-15T04:10:00.0000000Z npm error code ECONNRESET
2026-10-15T04:10:00.0000000Z npm error network read ECONNRESET
2026-10-15T04:10:01.0000000Z ##[error]Process completed with exit code 1.`

const CANCELLED = `2026-10-15T04:27:00.0000000Z ##[error]The operation was canceled.`

describe('classifyLog — one entry per failed test, in one of three categories', () => {
  it('reads a pytest timeout during shutdown as a test race', () => {
    expect(classifyLog(PYTEST_RACE)).toEqual([expect.objectContaining({
      test: 'backend/tests/cli_regression/test_vendor_contracts.py::test_vendor_launch[kilo]',
      category: 'test-race',
    })])
  })

  it('reads a plain assertion as a product defect', () => {
    const [entry] = classifyLog(PYTEST_DEFECT)
    expect(entry.category).toBe('product-defect')
    expect(entry.test).toBe('backend/tests/test_share_mcp_tools.py::test_the_existing_tools_are_exactly_mains_and_the_share_tools_come_after')
  })

  it('reads vitest failures the same way', () => {
    expect(classifyLog(VITEST_DEFECT)).toEqual([expect.objectContaining({
      test: 'src/renderer/src/composables/__tests__/useEvolve.test.ts > useEvolve > v1.1: over_budget is a warn row',
      category: 'product-defect',
    })])
    expect(classifyLog(VITEST_TIMEOUT)[0].category).toBe('test-race')
  })

  it('reads a job that failed without a failing test from its environment', () => {
    expect(classifyLog(ENVIRONMENT)).toEqual([expect.objectContaining({ test: '(job)', category: 'environment' })])
    expect(classifyLog(CANCELLED)).toEqual([expect.objectContaining({ test: '(job)', category: 'environment' })])
  })

  it('does not read "timed out" quoted inside an assertion diff as a race', () => {
    const log = `2026-10-15T04:20:38.7407494Z FAILED backend\\\\tests\\\\test_share_mcp_tools.py::test_x - assert [{'description': "e.g. injectText resending content because its echo check timed out"}] == []`
    expect(classifyLog(log)[0].category).toBe('product-defect')
  })

  it('names a Windows test with forward slashes, so one test is one ledger row', () => {
    const log = `2026-10-15T04:20:38.7407494Z FAILED backend\\\\tests\\\\test_share_mcp_tools.py::test_x - assert 1 == 2`
    expect(classifyLog(log)[0].test).toBe('backend/tests/test_share_mcp_tools.py::test_x')
  })

  it('reads a runner that could not download an action as the environment (#276, 2026-10-15)', () => {
    const log = `2026-10-15T05:43:37.7555290Z ##[error]An action could not be found at the URI 'https://codeload.github.com/actions/setup-go/tar.gz/b7ad1dad31e06c5925ef5d2fc7ad053ef454303e' (A646:26C2D0)
2026-10-15T05:43:37.7575250Z ##[error]Failed to download archive 'https://codeload.github.com/actions/setup-go/tar.gz/b7ad1dad' after 1 attempts.`
    expect(classifyLog(log)).toEqual([expect.objectContaining({ test: '(job)', category: 'environment' })])
  })

  it('reads a Windows shard stopped at its time cap as the environment (#356, run 38990627241, Windows 4/4)', () => {
    // The whole shard ran slow (results still rising at the cap, VM CPU
    // 3-16%); the test running at 1800 s did not fail. The rerun passed in 13m36s.
    const log = `2026-10-17T01:32:42.5238093Z --- pytest pid 7572, cap 1800s, --shard 4/4 --junitxml test-results/ci/backend.xml --collection-report test-results/ci/backend-collection.json
2026-10-17T02:01:12.9921057Z --- 1740s: 2420 results; last: backend\\tests\\test_stt_service.py::test_crash_fails_pending_then_respawns
2026-10-17T02:02:13.0114721Z --- 1800s: 2486 results; last: backend\\tests\\test_sync_engine.py::test_the_disk_work_of_a_round_runs_in_a_worker_thread
2026-10-17T02:02:13.0126472Z     vm: 19.9% of 16378 MiB used, cpu 4.6%, 135 processes
2026-10-17T02:02:13.0139859Z --- pytest exit: still running at cap
2026-10-17T02:02:13.1703968Z backend\\tests\\test_sync_engine.py::test_the_disk_work_of_a_round_runs_in_a_worker_thread --- summary:
2026-10-17T02:02:13.1979855Z ##[error]Process completed with exit code 1.`
    expect(classifyLog(log)).toEqual([expect.objectContaining({
      test: '(job)', category: 'environment', evidence: '--- pytest exit: still running at cap',
    })])
  })

  it('reads a shard stopped at its cap with no progress as the stuck test needing review (#359 review R3)', () => {
    // The same cap line, but the result count stood still: one test hung
    // (a deadlock pytest-timeout could not stop), not a slow runner.
    const log = `2026-10-17T01:32:42.5238093Z --- pytest pid 7572, cap 1800s, --shard 4/4
2026-10-17T01:39:42.0000000Z --- 420s: 900 results; last: backend\\tests\\test_y.py::test_hang
2026-10-17T02:00:12.0000000Z --- 1680s: 900 results; last: backend\\tests\\test_y.py::test_hang
2026-10-17T02:01:12.0000000Z --- 1740s: 900 results; last: backend\\tests\\test_y.py::test_hang
2026-10-17T02:02:13.0114721Z --- 1800s: 900 results; last: backend\\tests\\test_y.py::test_hang
2026-10-17T02:02:13.0139859Z --- pytest exit: still running at cap
2026-10-17T02:02:13.1979855Z ##[error]Process completed with exit code 1.`
    expect(classifyLog(log)).toEqual([expect.objectContaining({
      test: 'backend/tests/test_y.py::test_hang', category: 'needs-review',
    })])
  })

  it('never lets the cap line turn a failed test near it into the environment (#359 review)', () => {
    const log = `2026-10-17T02:02:12.0000000Z FAILED backend/tests/test_x.py::test_a - assert 1 == 2
2026-10-17T02:02:13.0114721Z --- 1800s: 2486 results; last: backend\\tests\\test_x.py::test_b
2026-10-17T02:02:13.0139859Z --- pytest exit: still running at cap
2026-10-17T02:02:13.1979855Z ##[error]Process completed with exit code 1.`
    expect(classifyLog(log)).toEqual([expect.objectContaining({
      test: 'backend/tests/test_x.py::test_a', category: 'product-defect',
    })])
  })

  it('keeps a test the ledger already knows as a race a race, whatever its message', () => {
    const log = `2026-10-15T05:30:00.0000000Z FAILED backend\\\\tests\\\\test_voice_handlers.py::test_a_partial_over_its_budget_is_cancelled_and_streaming_goes_on - AssertionError: ({'bytes': 88000, 'cancelled': True}, {'bytes': 320000, 'cancelled': False})`
    expect(classifyLog(log)[0].category).toBe('product-defect')
    const known = new Set(['backend/tests/test_voice_handlers.py::test_a_partial_over_its_budget_is_cancelled_and_streaming_goes_on'])
    expect(classifyLog(log, { knownRaces: known })[0].category).toBe('test-race')
  })

  describe('an IndexError or KeyError raised in a test file', () => {
    // The pin_audit flake from PR #285 (run 38763082739, attempt 1), trimmed.
    const PIN_AUDIT = 'backend/tests/test_server_link_pin_audit.py::test_refused_confirms_never_fill_the_record[keychain]'
    const lookupLog = ({ frame, error, failed }: { frame: string, error: string, failed: string }) => `2026-10-15T15:53:05.8883068Z =================================== FAILURES ===================================
2026-10-15T15:53:05.8886541Z ____________ test_refused_confirms_never_fill_the_record[keychain] _____________
2026-10-15T15:53:05.8887254Z [gw1] linux -- Python 3.12.15 /home/runner/work/Navide/Navide/backend/.venv/bin/python
2026-10-15T15:53:05.8894320Z             for _ in range(10):
2026-10-15T15:53:05.8894606Z                 await asyncio.sleep(0.03)
2026-10-15T15:53:05.8894920Z                 n = len(server.opened)
2026-10-15T15:53:05.8895235Z >               await server.opened[-1].close()
2026-10-15T15:53:05.8895545Z                       ^^^^^^^^^^^^^^^^^
2026-10-15T15:53:05.8895867Z E               ${error}
2026-10-15T15:53:05.8896101Z
2026-10-15T15:53:05.8896287Z ${frame}
2026-10-15T15:53:05.8896774Z ----------------------------- Captured stderr call -----------------------------
2026-10-15T15:53:05.8899596Z reading the navide-server credential
2026-10-15T15:53:06.3004557Z =========================== short test summary info ============================
2026-10-15T15:53:06.3005337Z FAILED ${failed} - ${error}
2026-10-15T15:53:06.3006131Z ===== 1 failed, 11700 passed, 61 skipped, 45 warnings in 448.14s (0:07:28) =====`
    const indexError = lookupLog({
      frame: 'backend/tests/test_server_link_pin_audit.py:259: IndexError',
      error: 'IndexError: list index out of range',
      failed: PIN_AUDIT,
    })

    it('is a test race when the ledger knows the test as one', () => {
      expect(classifyLog(indexError, { knownRaces: new Set([PIN_AUDIT]) })).toEqual([
        expect.objectContaining({ test: PIN_AUDIT, category: 'test-race' }),
      ])
    })

    it('needs review when the ledger does not know the test', () => {
      expect(classifyLog(indexError)[0].category).toBe('needs-review')
    })

    it('needs review for a KeyError the same way', () => {
      const log = lookupLog({
        frame: 'backend/tests/test_server_link_pin_audit.py:259: KeyError',
        error: "KeyError: 'pins'",
        failed: PIN_AUDIT,
      })
      expect(classifyLog(log)[0].category).toBe('needs-review')
    })

    it('stays a product defect when the failing frame is in product code', () => {
      const log = lookupLog({
        frame: 'backend/agent_team_backend/trust_store.py:412: IndexError',
        error: 'IndexError: list index out of range',
        failed: PIN_AUDIT,
      })
      expect(classifyLog(log)[0].category).toBe('product-defect')
    })

    it('reads a Windows path the same way', () => {
      const log = lookupLog({
        frame: 'backend\\tests\\test_server_link_pin_audit.py:259: IndexError',
        error: 'IndexError: list index out of range',
        failed: PIN_AUDIT.replace(/\//g, '\\\\'),
      })
      expect(classifyLog(log, { knownRaces: new Set([PIN_AUDIT]) })[0]).toMatchObject({ test: PIN_AUDIT, category: 'test-race' })
      expect(classifyLog(log)[0].category).toBe('needs-review')
    })
  })

  it('keeps the evidence line without the timestamp', () => {
    const [entry] = classifyLog(PYTEST_DEFECT)
    expect(entry.evidence.startsWith('FAILED backend/tests/test_share_mcp_tools.py')).toBe(true)
  })

  it('returns nothing for a log with no failure in it', () => {
    expect(classifyLog('===== 120 passed in 3.2s =====')).toEqual([])
  })
})

// `gh run view 38790727272 --attempt 1 --log-failed` (PR #300), trimmed: one
// file, three failed jobs, each line prefixed "job<TAB>step<TAB>".
const MIXED_JOBS = `Backend tests (macOS, 1/1)	UNKNOWN STEP	2026-10-15T19:11:17.3608700Z =========================== short test summary info ============================
Backend tests (macOS, 1/1)	UNKNOWN STEP	2026-10-15T19:11:17.3609380Z FAILED backend/tests/test_preview_log.py::test_shutdown_close_does_not_deadlock_with_a_watcher_burst - AssertionError: close_all deadlocked with the burst
Backend tests (macOS, 1/1)	UNKNOWN STEP	2026-10-15T19:11:17.3610010Z assert (not True)
Backend tests (macOS, 1/1)	UNKNOWN STEP	2026-10-15T19:11:17.3611260Z ===== 1 failed, 11768 passed, 32 skipped, 46 warnings in 300.32s (0:05:00) =====
Backend tests (macOS, 1/1)	UNKNOWN STEP	2026-10-15T19:11:28.3792230Z ##[error]Process completed with exit code 1.
Backend tests (Windows, 4/4)	UNKNOWN STEP	2026-10-15T19:29:02.6850048Z --- 960s: 2934 results; last: FAILED backend\\tests\\test_server_link_trust.py::test_a_conflict_that_survives_the_retry_says_what_it_is - AssertionError: condition never be
Backend tests (Windows, 4/4)	UNKNOWN STEP	2026-10-15T19:29:02.7450569Z =========================== short test summary info ===========================
Backend tests (Windows, 4/4)	UNKNOWN STEP	2026-10-15T19:29:02.7453663Z FAILED backend\\tests\\test_server_link_trust.py::test_a_conflict_that_survives_the_retry_says_what_it_is - AssertionError: condition never became true
Backend tests (Windows, 4/4)	UNKNOWN STEP	2026-10-15T19:29:02.7456427Z = 1 failed, 2877 passed, 68 skipped, 8804 deselected, 12 warnings in 918.17s (0:15:18) =
Backend tests (Windows, 4/4)	UNKNOWN STEP	2026-10-15T19:29:02.7922192Z ##[error]Process completed with exit code 1.
Lint and test	Require every check to succeed	2026-10-15T19:29:12.8164352Z ##[error]Process completed with exit code 1.`

// PR #305 run 38807333845 attempt 1, Backend tests (Windows, 3/4), trimmed:
// pytest-timeout dumped every thread's stack and ended pytest, so no FAILED line.
const PYTEST_TIMEOUT_DUMP = String.raw`2026-10-15T21:15:23.2640906Z --- 480s: 852 results; last: backend\tests\test_db.py::test_commits_are_not_blocked_by_a_reader_holding_the_journal +++++++++++++++++++++++++++++++++++ Timeout +++++++++
2026-10-15T21:15:23.2674803Z --- pytest exit: 1
2026-10-15T21:15:23.2689020Z --- last 200 lines of pytest.log:
2026-10-15T21:15:23.2767901Z ~~~~~~~~~~~~~~~~~~~~~~~~~ Stack of vault-io_4 (6540) ~~~~~~~~~~~~~~~~~~~~~~~~~~
2026-10-15T21:15:23.2773721Z   File "C:\hostedtoolcache\windows\Python\3.12.10\x64\Lib\threading.py", line 1032, in _bootstrap
2026-10-15T21:15:23.3798429Z   File "D:\a\Navide\Navide\backend\.venv\Lib\site-packages\_pytest\python.py", line 167, in pytest_pyfunc_call
2026-10-15T21:15:23.3805545Z     result = testfunction(**testargs)
2026-10-15T21:15:23.3813260Z   File "D:\a\Navide\Navide\backend\tests\test_db.py", line 230, in test_commits_are_not_blocked_by_a_reader_holding_the_journal
2026-10-15T21:15:23.3819878Z     db.kv_set(f"k{i}", i, now=i)
2026-10-15T21:15:23.3852224Z   File "D:\a\Navide\Navide\backend\agent_team_backend\db.py", line 105, in transaction
2026-10-15T21:15:23.3858071Z     with self._lock:
2026-10-15T21:15:23.3864151Z +++++++++++++++++++++++++++++++++++ Timeout +++++++++++++++++++++++++++++++++++
2026-10-15T21:15:23.3870331Z --- summary:
2026-10-15T21:15:23.4403174Z ##[error]Process completed with exit code 1.`

describe('test races without a timing word in the assertion', () => {
  it('reads a wait helper that gave up as a race (run 38790727272, Windows 4/4)', () => {
    const log = String.raw`2026-10-15T19:29:02.7453663Z FAILED backend\tests\test_server_link_trust.py::test_a_conflict_that_survives_the_retry_says_what_it_is - AssertionError: condition never became true`
    expect(classifyLog(log)).toEqual([expect.objectContaining({
      test: 'backend/tests/test_server_link_trust.py::test_a_conflict_that_survives_the_retry_says_what_it_is',
      category: 'test-race',
    })])
  })

  it('reads a pytest-timeout stack dump as the stopped test needing review: a real deadlock hangs the same way', () => {
    const [entry, ...rest] = classifyLog(PYTEST_TIMEOUT_DUMP)
    expect(rest).toEqual([])
    expect(entry).toMatchObject({
      test: 'backend/tests/test_db.py::test_commits_are_not_blocked_by_a_reader_holding_the_journal',
      category: 'needs-review',
    })
    expect(entry.evidence).toContain('test_db.py", line 230, in test_commits_are_not_blocked_by_a_reader_holding_the_journal')
  })

  it('keeps a timed-out test the ledger knows as a race a race', () => {
    const known = new Set(['backend/tests/test_db.py::test_commits_are_not_blocked_by_a_reader_holding_the_journal'])
    expect(classifyLog(PYTEST_TIMEOUT_DUMP, { knownRaces: known })[0].category).toBe('test-race')
  })

  it('still lets the environment win over a timeout dump', () => {
    const log = `2026-10-15T21:10:00.0000000Z npm error network read ECONNRESET\n${PYTEST_TIMEOUT_DUMP}`
    expect(classifyLog(log)).toEqual([expect.objectContaining({ category: 'environment' })])
  })
})

// Build and artifact contracts, 2026-10-16, trimmed: every test passed, but a
// worker missed vitest's 60 s RPC deadline and the run exited 1.
const E = '\u001b'
const VITEST_RPC_TIMEOUT_WINDOWS = `2026-10-16T11:18:28.1949349Z  ${E}[32m✓${E}[39m ${E}[30m${E}[45m artifacts ${E}[49m${E}[39m plugins/navide-mini-ide/tests/packageBoundary.test.ts ${E}[2m(${E}[22m${E}[2m1 test${E}[22m${E}[2m)${E}[22m${E}[33m 88309${E}[2mms${E}[22m${E}[39m\r
2026-10-16T11:18:28.2224554Z ${E}[31m⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯${E}[39m\r
2026-10-16T11:18:28.2226044Z ${E}[31m${E}[1mVitest caught 1 unhandled error during the test run.${E}[22m${E}[39m\r
2026-10-16T11:18:28.2254390Z ${E}[31m${E}[1mError${E}[22m: [vitest-worker]: Timeout calling "onTaskUpdate"${E}[39m\r
2026-10-16T11:18:28.2258764Z ${E}[36m ${E}[2m❯${E}[22m Object.onTimeoutError node_modules/.pnpm/vitest@3.2.7/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:${E}[2m53:10${E}[22m${E}[39m\r
2026-10-16T11:18:28.2287418Z ${E}[2m Test Files ${E}[22m ${E}[1m${E}[32m22 passed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[33m4 skipped${E}[39m${E}[90m (26)${E}[39m\r
2026-10-16T11:18:28.2289824Z ${E}[2m      Tests ${E}[22m ${E}[1m${E}[32m203 passed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[33m46 skipped${E}[39m${E}[90m (249)${E}[39m\r
2026-10-16T11:18:28.2290965Z ${E}[2m     Errors ${E}[22m ${E}[1m${E}[31m1 error${E}[39m${E}[22m\r
2026-10-16T11:18:28.6411294Z ##[error]Process completed with exit code 1.\r`

const VITEST_RPC_TIMEOUT_MACOS = `2026-10-16T10:29:37.2803970Z  ${E}[32m✓${E}[39m ${E}[30m${E}[45m artifacts ${E}[49m${E}[39m tests/integration/plansPackagedRoundtrip.test.ts ${E}[2m(${E}[22m${E}[2m5 tests${E}[22m${E}[2m)${E}[22m${E}[33m 9993${E}[2mms${E}[22m${E}[39m
2026-10-16T10:29:37.3439810Z ${E}[31m${E}[1mVitest caught 1 unhandled error during the test run.${E}[22m${E}[39m
2026-10-16T10:29:37.3446200Z ${E}[2m Test Files ${E}[22m ${E}[1m${E}[32m26 passed${E}[39m${E}[22m${E}[90m (26)${E}[39m
2026-10-16T10:29:37.3454300Z ${E}[2m      Tests ${E}[22m ${E}[1m${E}[32m248 passed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[33m1 skipped${E}[39m${E}[90m (249)${E}[39m
2026-10-16T10:29:37.3459880Z ${E}[2m     Errors ${E}[22m ${E}[1m${E}[31m1 error${E}[39m${E}[22m
2026-10-16T10:29:37.3471160Z ${E}[31m${E}[1mError${E}[22m: [vitest-worker]: Timeout calling "onTaskUpdate"${E}[39m
2026-10-16T10:29:38.0559380Z ##[error]Process completed with exit code 1.`

describe('a vitest worker that missed the RPC deadline', () => {
  it('is the environment when every test in the job passed (Windows, job 116943096414)', () => {
    expect(classifyLog(VITEST_RPC_TIMEOUT_WINDOWS)).toEqual([expect.objectContaining({
      test: '(job)',
      category: 'environment',
      evidence: expect.stringContaining('[vitest-worker]: Timeout calling "onTaskUpdate"'),
    })])
  })

  it('is the environment on macOS the same way (PR #324, job 116924889337)', () => {
    expect(classifyLog(VITEST_RPC_TIMEOUT_MACOS)).toEqual([expect.objectContaining({ test: '(job)', category: 'environment' })])
  })

  it('needs review when a test in the same job failed', () => {
    const log = VITEST_RPC_TIMEOUT_MACOS.replace(`${E}[32m248 passed`, `${E}[31m1 failed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[1m${E}[32m247 passed`)
    expect(classifyLog(log)).toEqual([expect.objectContaining({ test: '(job)', category: 'needs-review' })])
  })
})

describe('splitJobLogs — one saved log, possibly several jobs', () => {
  it('gives each job of a gh run view --log-failed file its own failures', () => {
    const jobs = splitJobLogs(MIXED_JOBS, '(local log)')
    expect(jobs.map((j) => [j.job, classifyLog(j.text).map((e) => [e.test, e.evidence.split(' - ')[0]])])).toEqual([
      ['Backend tests (macOS, 1/1)', [[
        'backend/tests/test_preview_log.py::test_shutdown_close_does_not_deadlock_with_a_watcher_burst',
        'FAILED backend/tests/test_preview_log.py::test_shutdown_close_does_not_deadlock_with_a_watcher_burst',
      ]]],
      ['Backend tests (Windows, 4/4)', [[
        'backend/tests/test_server_link_trust.py::test_a_conflict_that_survives_the_retry_says_what_it_is',
        'FAILED backend\\tests\\test_server_link_trust.py::test_a_conflict_that_survives_the_retry_says_what_it_is',
      ]]],
      ['Lint and test', [['(job)', '##[error]Process completed with exit code 1.']]],
    ])
  })

  it('leaves out the aggregate Lint and test job, which fails whenever another job does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-'))
    try {
      const path = join(dir, 'run.log')
      writeFileSync(path, MIXED_JOBS)
      const out = execFileSync(process.execPath, ['scripts/ci-triage.mjs', '--log', path], { encoding: 'utf8' })
      expect(out).toContain('Backend tests (Windows, 4/4)')
      expect(out).not.toContain('Lint and test')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps a single job log, as the API returns it, under the given job name', () => {
    expect(splitJobLogs(PYTEST_DEFECT, 'Backend tests (macOS, 1/1)')).toEqual([{ job: 'Backend tests (macOS, 1/1)', text: PYTEST_DEFECT }])
  })
})

describe('mergeIntoLedger — docs/testing/flaky.json', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('counts each test across runs, once per run and job', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flaky-'))
    dirs.push(dir)
    const path = join(dir, 'flaky.json')
    const entries = classifyLog(PYTEST_RACE)
    const run = { run: 38679265730, job: 'Backend tests (macOS, 1/1)', pr: 266, at: '2026-10-15T04:18:03Z' }
    mergeIntoLedger(path, entries, run)
    mergeIntoLedger(path, entries, run) // the same run read twice
    mergeIntoLedger(path, entries, { ...run, run: 1, at: '2026-10-16T00:00:00Z' })
    const ledger = JSON.parse(readFileSync(path, 'utf8'))
    expect(ledger.schema).toBe(1)
    expect(ledger.tests).toHaveLength(1)
    expect(ledger.tests[0]).toMatchObject({
      test: 'backend/tests/cli_regression/test_vendor_contracts.py::test_vendor_launch[kilo]',
      category: 'test-race',
      count: 2,
      firstSeen: '2026-10-15T04:18:03Z',
      lastSeen: '2026-10-16T00:00:00Z',
    })
    expect(ledger.tests[0].runs).toHaveLength(2)
  })

  it('refuses a run without a run id, so two unknown runs never collapse into one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flaky-'))
    dirs.push(dir)
    const path = join(dir, 'flaky.json')
    const entries = classifyLog(PYTEST_RACE)
    expect(() => mergeIntoLedger(path, entries, { run: 0, job: 'j', pr: 0, at: '2026-10-15T00:00:00Z' })).toThrow(/run id/)
    expect(() => mergeIntoLedger(path, entries, { job: 'j', pr: 0, at: '2026-10-15T00:00:00Z' } as never)).toThrow(/run id/)
    expect(existsSync(path)).toBe(false)
  })

  it('keeps an existing ledger and its other tests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flaky-'))
    dirs.push(dir)
    const path = join(dir, 'flaky.json')
    writeFileSync(path, JSON.stringify({ schema: 1, tests: [{ test: 'other', category: 'environment', count: 3, firstSeen: 'a', lastSeen: 'b', runs: [] }] }))
    mergeIntoLedger(path, classifyLog(PYTEST_DEFECT), { run: 2, job: 'j', pr: 267, at: 'c' })
    const ledger = JSON.parse(readFileSync(path, 'utf8'))
    expect(ledger.tests.map((t: { test: string }) => t.test).sort()).toEqual([
      'backend/tests/test_share_mcp_tools.py::test_the_existing_tools_are_exactly_mains_and_the_share_tools_come_after',
      'other',
    ])
  })
})
