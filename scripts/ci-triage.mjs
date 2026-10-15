#!/usr/bin/env node
// Classify why a PR's CI jobs failed, and keep a ledger of tests that fail.
//
//   bun scripts/ci-triage.mjs --pr 266            # print one line per failed test
//   bun scripts/ci-triage.mjs --pr 266 --write    # ... and add them to docs/testing/flaky.json
//   bun scripts/ci-triage.mjs --log job.log --job "Backend tests (macOS)"   # a saved log
//
// Three categories, the triage habit RELEASING.md describes, made repeatable:
//   environment     the runner or the network failed, not a test (no failing test in the log,
//                   or a network/disk/cancel signature);
//   test-race       a test failed on time: a timeout, a hang, a port race — rerun before blaming code;
//   product-defect  anything else: an assertion, a type error, a lint error — fix the code.
// Local only, on purpose: it costs no runner minutes and posts nothing anywhere.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENVIRONMENT = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|Could not resolve host|operation timed out|No space left on device|rate limit|50[234] (Bad Gateway|Service Unavailable|Gateway Timeout)|The operation was canceled|runner has received a shutdown signal|lost communication with the server|exceeded the maximum execution time/i
// Signatures, not bare words: an assertion diff can quote any text (a tool
// description saying "timed out" is not a timeout).
const TEST_RACE = /TimeoutExpired|timed out after \d|shutdown timed out|Test timed out in \d|TimeoutError|asyncio\.exceptions\.CancelledError|deadlock detected|EADDRINUSE|address already in use/i
const MAX_RUNS_PER_TEST = 20

/** Drop the runner's leading ISO timestamp. */
function bare(line) {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '')
}

/** One entry per failed test: {test, category, evidence}. A job that failed
 *  with no failing test in its log gets a single "(job)" entry. */
export function classifyLog(text) {
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
    const category = ENVIRONMENT.test(context) ? 'environment' : TEST_RACE.test(context) ? 'test-race' : 'product-defect'
    out.push({ test, category, evidence: line.trim().slice(0, 400) })
  }
  if (out.length === 0) {
    const failed = lines.find((l) => /##\[error\]/.test(l))
    if (failed) {
      const env = lines.find((l) => ENVIRONMENT.test(l))
      out.push({
        test: '(job)',
        category: env || /canceled/i.test(failed) ? 'environment' : 'product-defect',
        evidence: (env ?? failed).trim().slice(0, 400),
      })
    }
  }
  return out
}

/** Add one job's entries to the ledger at `path`, counting each test once per
 *  (run, job). `run` is {run, job, pr, at}. */
export function mergeIntoLedger(path, entries, run) {
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
  const jobs = []
  if (opt('--log')) {
    jobs.push({ job: opt('--job') ?? '(local log)', run: 0, pr: 0, at: new Date().toISOString(), text: readFileSync(opt('--log'), 'utf8') })
  } else if (opt('--pr')) {
    const pr = Number(opt('--pr'))
    const repo = JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner
    for (const j of failedJobs(pr)) {
      jobs.push({ ...j, pr, text: gh(['api', `repos/${repo}/actions/jobs/${j.id}/logs`]) })
    }
  } else {
    process.stderr.write('usage: ci-triage.mjs (--pr N | --log FILE [--job NAME]) [--write] [--ledger PATH]\n')
    return 2
  }
  if (jobs.length === 0) process.stdout.write('no failed Actions jobs\n')
  for (const j of jobs) {
    const entries = classifyLog(j.text)
    for (const e of entries) process.stdout.write(`${e.category.padEnd(15)} ${j.job} :: ${e.test}\n  ${e.evidence}\n`)
    if (write && entries.length) mergeIntoLedger(ledgerPath, entries, { run: j.run, job: j.job, pr: j.pr, at: j.at })
  }
  if (write) process.stdout.write(`ledger: ${ledgerPath}\n`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
