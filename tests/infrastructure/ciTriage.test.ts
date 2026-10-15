import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyLog, mergeIntoLedger } from '../../scripts/ci-triage.mjs'

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
