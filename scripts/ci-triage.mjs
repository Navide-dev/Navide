#!/usr/bin/env node
// Classify why a PR's CI jobs failed, and keep a ledger of tests that fail.
//
//   node scripts/ci-triage.mjs --pr 266            # print one line per failed test
//   node scripts/ci-triage.mjs --pr 266 --write    # ... and add them to docs/testing/flaky.json
//   node scripts/ci-triage.mjs --log job.log --job "Backend tests (macOS)"   # a saved log
//   node scripts/ci-triage.mjs --log run.log --run 38790727272 --pr 300 --write
//                                  # gh run view --log-failed output: each job is its own row source
//
// Four categories, the triage habit RELEASING.md describes, made repeatable:
//   environment     the runner or the network failed, not a test (no failing test in the log,
//                   or a network/disk/cancel signature, or a vitest worker RPC timeout in a
//                   run whose tests all passed, or a Windows shard stopped at its time cap
//                   by backend/ci_windows_tests.py — "still running at cap");
//   test-race       a test failed on time: a timeout signature, a wait that gave up, a port race,
//                   or a test the ledger knows as a race — rerun before blaming code;
//   needs-review    a test the ledger does not know as a race that either raised an IndexError or
//                   KeyError in a backend/tests/ frame (it may have read a list too early) or was
//                   stopped by pytest-timeout (a hang can be a real deadlock) — a person decides;
//   product-defect  anything else: an assertion, a type error, a lint error — fix the code.
// Local only, on purpose: it costs no runner minutes and posts nothing anywhere.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENVIRONMENT = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|Could not resolve host|operation timed out|No space left on device|rate limit|50[234] (Bad Gateway|Service Unavailable|Gateway Timeout)|The operation was canceled|runner has received a shutdown signal|lost communication with the server|exceeded the maximum execution time|An action could not be found at the URI|Failed to download archive|Unable to resolve action/i
// Signatures, not bare words: an assertion diff can quote any text (a tool
// description saying "timed out" is not a timeout).
const TEST_RACE = /TimeoutExpired|timed out after \d|shutdown timed out|Test timed out in \d|TimeoutError|asyncio\.exceptions\.CancelledError|deadlock detected|EADDRINUSE|address already in use|condition never became true/i
// pytest-timeout dumps every thread's stack between these banners and ends
// pytest, so the test it stopped has no FAILED line: name it from its frame.
// A real deadlock surfaces exactly this way (#295, #303), so it needs review
// unless the ledger already knows the test as a race.
const PYTEST_TIMEOUT = /\+{3,} Timeout \+{3,}/
const TEST_FRAME = /^\s*File ".*?[\\/](backend[\\/]tests[\\/][^"]+\.py)", line \d+, in (test_\w+)$/
// The required-check job that fails whenever another job does; it is never the cause.
const AGGREGATE_JOB = 'Lint and test'
// A vitest worker that missed the fixed 60 s RPC deadline on a loaded runner:
// an unhandled error that fails a run whose tests may all have passed.
const VITEST_RPC_TIMEOUT = /\[vitest-worker\]: Timeout calling "onTaskUpdate"/
const MAX_RUNS_PER_TEST = 20
// backend/ci_windows_tests.py ends a shard still running at its time cap with
// this line, after a progress line every minute. Only progress tells a slow
// runner (results still rising) from one test hung at the cap (they stood
// still); it is read only for a job with no failing test.
const SHARD_CAP = /--- pytest exit: still running at cap/
const SHARD_PROGRESS = /^--- (\d+)s: (\d+) results; last: (\S+)/
const PROGRESS_WINDOW = 3

/** The shard's last progress lines, oldest first, one per reported second
 *  (the wrapper prints its log twice). */
function shardProgress(lines) {
  const bySecond = new Map()
  for (const line of lines) {
    const m = SHARD_PROGRESS.exec(line)
    if (m) bySecond.set(Number(m[1]), { results: Number(m[2]), test: m[3].replace(/\\+/g, '/') })
  }
  return [...bySecond].sort((a, b) => a[0] - b[0]).map(([, v]) => v).slice(-PROGRESS_WINDOW)
}

/** The file of the innermost frame pytest reported for `test` when it raised an
 *  IndexError or KeyError: the `path:line: IndexError` line closing the test's
 *  section under FAILURES. Null when the log has no such line. */
function lookupErrorPath(lines, test) {
  const name = test.split('::').slice(1).join('.')
  const start = lines.findIndex((l) => /^_{3,} (.+) _{3,}$/.exec(l)?.[1] === name)
  if (start < 0) return null
  let path = null
  for (let i = start + 1; i < lines.length && !/^(_{3,} .+ _{3,}|={3,}.*)$/.test(lines[i]); i++) {
    const m = /^(\S+):\d+: (?:IndexError|KeyError)$/.exec(lines[i])
    if (m) path = m[1].replace(/\\+/g, '/')
  }
  return path
}

/** True when the log has a vitest "Tests" summary and none of them counts a
 *  failed test. */
function vitestAllPassed(lines) {
  const summaries = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).filter((l) => /^\s*Tests\s+\d/.test(l))
  return summaries.length > 0 && summaries.every((l) => !/\bfailed\b/.test(l))
}

/** Drop the runner's leading ISO timestamp. */
function bare(line) {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '')
}

/** One entry per failed test: {test, category, evidence}. A job that failed
 *  with no failing test in its log gets a single "(job)" entry. A test in
 *  `knownRaces` (the ledger's test-race rows) stays a race: a timing assert
 *  can fail with any message. */
export function classifyLog(text, { knownRaces = new Set() } = {}) {
  const lines = text.split(/\r?\n/).map(bare)
  const out = []
  const seen = new Set()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let test = null
    const pytest = /^FAILED (\S+::\S+?)(?: - (.*))?$/.exec(line)
    const vitest = /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+\.(?:test|spec)\.[cm]?[jt]sx? > .+)$/.exec(line)
    // Windows logs print the path with escaped backslashes; one test is one row.
    if (pytest) test = pytest[1].replace(/\\+/g, '/')
    else if (vitest) test = vitest[1].trim().replace(/\\+/g, '/')
    if (!test || seen.has(test)) continue
    seen.add(test)
    // The failure's own message plus what was printed just before and after it.
    const context = lines.slice(Math.max(0, i - 3), i + 4).join('\n')
    const category = ENVIRONMENT.test(context) ? 'environment'
      : TEST_RACE.test(context) || knownRaces.has(test) ? 'test-race'
        : /(^|\/)backend\/tests\//.test(lookupErrorPath(lines, test) ?? '') ? 'needs-review'
          : 'product-defect'
    out.push({ test, category, evidence: line.trim().slice(0, 400) })
  }
  if (out.length === 0) {
    const failed = lines.find((l) => /##\[error\]/.test(l))
    const cap = failed ? lines.find((l) => SHARD_CAP.test(l)) : undefined
    const progress = cap ? shardProgress(lines) : []
    const stalled = cap && !(progress.length > 1 && progress.at(-1).results > progress[0].results)
    if (stalled) {
      const last = progress.at(-1)
      out.push({
        test: last?.test ?? '(job)',
        category: knownRaces.has(last?.test) ? 'test-race' : 'needs-review',
        evidence: (last ? `${cap.trim()}; results stood at ${last.results}` : cap.trim()).slice(0, 400),
      })
    } else if (failed) {
      const env = cap ?? lines.find((l) => ENVIRONMENT.test(l))
      const rpcTimeout = env ? undefined : lines.find((l) => VITEST_RPC_TIMEOUT.test(l))
      const timedOut = !env && !rpcTimeout && lines.some((l) => PYTEST_TIMEOUT.test(l))
      const frame = timedOut ? lines.map((l) => TEST_FRAME.exec(l)).find(Boolean) : null
      const test = frame ? `${frame[1].replace(/\\+/g, '/')}::${frame[2]}` : '(job)'
      out.push({
        test,
        category: env || /canceled/i.test(failed) ? 'environment'
          : rpcTimeout ? (vitestAllPassed(lines) ? 'environment' : 'needs-review')
            : timedOut ? (knownRaces.has(test) ? 'test-race' : 'needs-review') : 'product-defect',
        evidence: (env ?? rpcTimeout ?? frame?.[0] ?? failed).trim().slice(0, 400),
      })
    }
  }
  return out
}

/** A saved log as [{job, text}]. `gh run view --log` / `--log-failed` puts
 *  several jobs in one file, each line prefixed "job<TAB>step<TAB>"; a job log
 *  from the API has no prefix and is all `job`. */
export function splitJobLogs(text, job) {
  const lines = text.split(/\r?\n/)
  if (!lines.some((l) => /^[^\t]+\t[^\t]+\t/.test(l))) return [{ job, text }]
  const jobs = new Map()
  for (const line of lines) {
    const m = /^([^\t]+)\t[^\t]+\t(.*)$/.exec(line)
    if (!m) continue
    if (!jobs.has(m[1])) jobs.set(m[1], [])
    jobs.get(m[1]).push(m[2])
  }
  return [...jobs].map(([name, body]) => ({ job: name, text: body.join('\n') }))
}

/** Add one job's entries to the ledger at `path`, counting each test once per
 *  (run, job). `run` is {run, job, pr, at}; a missing or 0 run id is refused,
 *  since every such run would count as the same one. */
export function mergeIntoLedger(path, entries, run) {
  if (!(Number(run.run) > 0)) throw new Error('mergeIntoLedger needs a run id (pass --run with --log)')
  const ledger = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schema: 1, tests: [] }
  for (const entry of entries) {
    let row = ledger.tests.find((t) => t.test === entry.test)
    if (!row) {
      row = { test: entry.test, category: entry.category, count: 0, firstSeen: run.at, lastSeen: run.at, runs: [] }
      ledger.tests.push(row)
    }
    if (row.runs.some((r) => r.run === run.run && r.job === run.job)) continue
    row.count += 1
    row.category = entry.category
    if (run.at < row.firstSeen) row.firstSeen = run.at
    if (run.at > row.lastSeen) row.lastSeen = run.at
    row.runs.push({ run: run.run, job: run.job, pr: run.pr, at: run.at, evidence: entry.evidence })
    row.runs = row.runs.slice(-MAX_RUNS_PER_TEST)
  }
  ledger.tests.sort((a, b) => b.count - a.count || a.test.localeCompare(b.test))
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`)
  return ledger
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

/** The PR's failed check runs that are GitHub Actions jobs: [{job, id, run}]. */
function failedJobs(pr) {
  const rollup = JSON.parse(gh(['pr', 'view', String(pr), '--json', 'statusCheckRollup'])).statusCheckRollup ?? []
  return rollup
    .filter((c) => c.conclusion === 'FAILURE' && /\/actions\/runs\/\d+\/job\/\d+/.test(c.detailsUrl ?? ''))
    .map((c) => {
      const [, run, id] = /\/runs\/(\d+)\/job\/(\d+)/.exec(c.detailsUrl)
      return { job: c.name, id: Number(id), run: Number(run), at: c.completedAt ?? new Date().toISOString() }
    })
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const write = argv.includes('--write')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const ledgerPath = opt('--ledger') ?? join(root, 'docs', 'testing', 'flaky.json')
  const known = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')).tests ?? [] : []
  const knownRaces = new Set(known.filter((t) => t.category === 'test-race').map((t) => t.test))
  const jobs = []
  if (opt('--log')) {
    if (write && !(Number(opt('--run')) > 0)) {
      process.stderr.write('--log with --write needs --run N (the Actions run id)\n')
      return 2
    }
    const meta = { run: Number(opt('--run') ?? 0), pr: Number(opt('--pr') ?? 0), at: new Date().toISOString() }
    for (const j of splitJobLogs(readFileSync(opt('--log'), 'utf8'), opt('--job') ?? '(local log)')) jobs.push({ ...meta, ...j })
  } else if (opt('--pr')) {
    const pr = Number(opt('--pr'))
    const repo = JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner
    for (const j of failedJobs(pr)) {
      jobs.push({ ...j, pr, text: gh(['api', `repos/${repo}/actions/jobs/${j.id}/logs`]) })
    }
  } else {
    process.stderr.write('usage: ci-triage.mjs (--pr N | --log FILE [--job NAME] [--run N] [--pr N]) [--write] [--ledger PATH]\n')
    return 2
  }
  if (jobs.length === 0) process.stdout.write('no failed Actions jobs\n')
  for (const j of jobs) {
    if (j.job === AGGREGATE_JOB) continue
    const entries = classifyLog(j.text, { knownRaces })
    for (const e of entries) process.stdout.write(`${e.category.padEnd(15)} ${j.job} :: ${e.test}\n  ${e.evidence}\n`)
    if (write && entries.length) mergeIntoLedger(ledgerPath, entries, { run: j.run, job: j.job, pr: j.pr, at: j.at })
  }
  if (write) process.stdout.write(`ledger: ${ledgerPath}\n`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
