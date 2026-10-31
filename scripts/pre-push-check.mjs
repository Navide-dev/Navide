#!/usr/bin/env node
// Runs, before a push, the checks most likely to turn CI red: a few minutes
// here instead of a 20-30 minute CI round trip. A local shortcut, never a
// substitute for CI, which still runs every suite on every platform.
//
//   node scripts/pre-push-check.mjs [--list]
//
// Every command is the one .github/workflows/ci.yml runs, apart from the
// no-sync uv forms (the venvs are left alone). What runs depends on the
// change since origin/main, working tree included, like `vitest --changed`:
//   - always: the repository-scanning guards `vitest --changed` cannot select
//     (they read the tree instead of importing it), tests/infrastructure, the
//     official plugin fingerprints;
//   - by path: Python compile and ruff, lockfile parity, typecheck, the guards
//     that need built packages, the whole i18n test folder, the contract
//     fixtures, the marketplace checks;
//   - last: `vitest --changed` and scripts/changed-backend-tests.mjs.
//
// Only one run happens at a time across all worktrees of this clone: a lockfile
// in the shared git directory queues the others, and a dead holder's lock is
// taken over. Before every check it waits while the 1-minute load is at or
// above MAX_LOAD. Every check runs even after one fails; the exit code is 0
// when all passed, 1 when any failed, 2 when the checks could not run.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const BASE = 'origin/main'
const MAX_LOAD = 60
const WAIT_POLL_MS = 15_000
const LOCK_NAME = 'pre-push-check.lock'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// A test that walks the tree and owns no temporary directory reads the
// repository, so `vitest --changed` and the backend selector cannot find it.
const FRONTEND_SCAN = /readdirSync|globSync|ls-files|readdir\(|recursive: true/
const FRONTEND_TEMP = /mkdtemp|tmpdir\(\)/
const BACKEND_SCAN = /rglob|os\.walk|\.glob\(|ls-files/
const BACKEND_TEMP = /tmp_path|mkdtemp|TemporaryDirectory/
// Scanners the patterns above miss: they name a temporary directory themselves.
const FRONTEND_SCAN_EXTRA = ['src/main/crossPlatformTestHygiene.test.ts']
const BACKEND_SCAN_EXTRA = ['backend/tests/test_cross_platform_test_hygiene.py']
// Scanners owned by the artifacts project, whose setup builds the public
// packages first (about 100 s): they run only when a package could have moved.
const ARTIFACT_GUARD = /^plugins\/[^/]+\/tests\//

const I18N_TESTS = 'packages/plugin-ui/src/foundation/i18n/__tests__'
const REGISTRY = 'marketplace/registry'
const REGISTRY_RUN = ['uv', '--project', REGISTRY, 'run', '--no-sync']
const LOCKFILES = new Set(['package.json', 'pnpm-lock.yaml', 'bun.lock'])
const TYPED = /\.(ts|tsx|mts|cts|vue)$|(^|\/)tsconfig[^/]*\.json$/
const LOCALE = /(^|\/)locales\/|(^|\/)i18n\//
const CONTRACT_INPUT = /^(docs\/plugin-contracts|marketplace)\/|^backend\/agent_team_backend\/plugins\/agent_tools_contract\.py$/

let activeChild = null
let cleanups = []

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
}

function say(line) {
  process.stdout.write(`[pre-push] ${line}\n`)
}

function changedFiles() {
  return [...new Set([
    ...git(['diff', '--name-only', '--no-renames', `${BASE}...HEAD`]),
    ...git(['diff', '--name-only', '--no-renames', 'HEAD']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ])].sort()
}

function discover(pattern, scan, temp) {
  return git(['ls-files', pattern]).filter((file) => {
    if (!existsSync(join(ROOT, file))) return false
    const text = readFileSync(join(ROOT, file), 'utf8')
    return scan.test(text) && !temp.test(text)
  })
}

function scanGuards(localeChanged) {
  const frontend = discover('*.test.ts', FRONTEND_SCAN, FRONTEND_TEMP)
    .concat(FRONTEND_SCAN_EXTRA)
    .filter((file) => !file.startsWith('tests/infrastructure/'))
    // Without the change the folder's scanners still run here; with it, the
    // locale check below runs them along with the rest of the folder.
    .filter((file) => !(localeChanged && file.startsWith(`${I18N_TESTS}/`)))
  const backend = discover('backend/tests/*.py', BACKEND_SCAN, BACKEND_TEMP).concat(BACKEND_SCAN_EXTRA)
  return {
    frontend: [...new Set(frontend)].filter((file) => !ARTIFACT_GUARD.test(file)),
    artifacts: [...new Set(frontend)].filter((file) => ARTIFACT_GUARD.test(file)),
    backend: [...new Set(backend)],
  }
}

/** @returns ordered checks: { name, argv, env? } or { name, skip: reason } */
function buildPlan(changed) {
  const py = changed.filter((file) => file.endsWith('.py') && existsSync(join(ROOT, file)))
  const localeChanged = changed.some((file) => LOCALE.test(file) && !file.includes('/__tests__/'))
  const marketplace = changed.some((file) => file.startsWith('marketplace/'))
  const contract = changed.some((file) => CONTRACT_INPUT.test(file))
  const guards = scanGuards(localeChanged)
  const when = (condition, reason, check) => (condition ? check : { name: check.name, skip: reason })
  return [
    { name: 'official plugin fingerprints', argv: ['node', 'scripts/official-plugin-fingerprints.mjs'] },
    when(py.length > 0, 'no Python file changed', {
      name: 'compile changed Python',
      // compile() rather than py_compile: nothing lands in __pycache__.
      argv: ['uv', '--project', 'backend', 'run', '--no-sync', 'python', '-c',
        'import sys\nfor f in sys.argv[1:]:\n    compile(open(f, "rb").read(), f, "exec")', ...py],
    }),
    when(changed.some((file) => file.startsWith('backend/') && file.endsWith('.py')), 'no backend Python changed', {
      name: 'backend ruff',
      argv: ['uv', '--project', 'backend', 'run', '--no-sync', 'ruff', 'check', 'backend'],
    }),
    when(changed.some((file) => LOCKFILES.has(file)), 'no manifest or lockfile changed', {
      name: 'lockfile parity',
      argv: ['node', 'scripts/check-lockfile-parity.mjs'],
    }),
    when(changed.some((file) => TYPED.test(file)), 'no typed source changed', {
      name: 'typecheck',
      argv: ['pnpm', 'typecheck'],
    }),
    {
      name: `scanning guards (${guards.frontend.length} frontend)`,
      argv: ['pnpm', 'vitest', 'run', '--project', 'unit', ...guards.frontend],
    },
    when(changed.some((file) => /^(plugins|packages)\//.test(file)), 'no plugin or package changed', {
      name: `scanning guards (${guards.artifacts.length} plugin package)`,
      argv: ['pnpm', 'vitest', 'run', '--project', 'artifacts', ...guards.artifacts],
    }),
    { name: 'tests/infrastructure', argv: ['pnpm', 'run', 'test:infrastructure'] },
    when(localeChanged, 'no locale changed', {
      name: 'i18n tests folder',
      argv: ['pnpm', 'vitest', 'run', '--project', 'unit', I18N_TESTS],
    }),
    {
      name: `scanning guards (${guards.backend.length} backend)`,
      argv: ['bash', 'scripts/isolated-pytest.sh', ...guards.backend],
    },
    when(contract || marketplace, 'no contract or marketplace file changed', {
      name: 'registry environment',
      argv: ['uv', '--project', REGISTRY, 'sync', '--locked'],
    }),
    when(contract, 'no contract input changed', {
      name: 'plugin contract fixtures',
      argv: [...REGISTRY_RUN, 'python', 'docs/plugin-contracts/validate-fixtures.py'],
    }),
    when(marketplace, 'no marketplace file changed', {
      name: 'marketplace ruff',
      argv: [...REGISTRY_RUN, 'ruff', 'check', `${REGISTRY}/registry`, `${REGISTRY}/tests`],
    }),
    when(marketplace, 'no marketplace file changed', {
      name: 'marketplace tests',
      argv: [...REGISTRY_RUN, 'pytest', `${REGISTRY}/tests`],
      isolated: true,
    }),
    { name: 'vitest --changed', argv: ['pnpm', 'vitest', 'run', '--changed', BASE] },
    { name: 'changed backend tests', argv: ['node', 'scripts/changed-backend-tests.mjs'] },
  ]
}

// The same reach as scripts/isolated-pytest.sh, which takes only backend/ paths:
// a throwaway HOME and TMPDIR, and nothing inherited from the caller.
function isolatedEnv() {
  const scratch = mkdtempSync(join(tmpdir(), 'navide-pre-push-'))
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }))
  return {
    HOME: scratch,
    TMPDIR: scratch,
    USER: process.env.USER ?? '',
    LANG: 'en_US.UTF-8',
    PATH: process.env.PATH ?? '',
  }
}

function run(argv, env = process.env) {
  return new Promise((done) => {
    // Its own process group, so a signal to this script can stop the whole tree.
    const child = spawn(argv[0], argv.slice(1), { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'], detached: true })
    activeChild = child
    child.on('error', (error) => {
      activeChild = null
      process.stderr.write(`${error.message}\n`)
      done(127)
    })
    child.on('exit', (code) => {
      activeChild = null
      done(code ?? 1)
    })
  })
}

/** { over: boolean, load: string }; throws when the load cannot be read. */
function readLoad() {
  const awk = `{
    if (!match($0, /load averages?: */)) exit 2
    rest = substr($0, RSTART + RLENGTH)
    gsub(/,/, " ", rest)
    split(rest, fields, " ")
    print fields[1]
    exit (fields[1] + 0 >= max) ? 1 : 0
  }`
  const probe = spawnSync('sh', ['-c', `LC_ALL=C uptime | awk -v max=${MAX_LOAD} '${awk}'`], { encoding: 'utf8' })
  const load = probe.stdout?.trim()
  if (!load || (probe.status !== 0 && probe.status !== 1)) throw new Error('could not read the load average')
  return { over: probe.status === 1, load }
}

async function waitForLoad() {
  for (let state = readLoad(); state.over; state = readLoad()) {
    say(`1-minute load ${state.load} is at or above ${MAX_LOAD}, waiting`)
    await sleep(WAIT_POLL_MS)
  }
}

function holderAlive(pid) {
  if (!Number.isInteger(pid)) return false
  // The command as well as the pid: a pid can be reused after a crash.
  const probe = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return probe.stdout?.includes('pre-push-check') ?? false
}

function parseHolder(text) {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function takeOverStale(lock, staleText) {
  const aside = `${lock}.stale.${process.pid}`
  try {
    renameSync(lock, aside)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  // Another waiter may have taken it over first; a live lock goes back.
  if (readFileSync(aside, 'utf8') !== staleText) {
    try {
      linkSync(aside, lock)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  unlinkSync(aside)
}

async function acquireLock(lock, branch) {
  const mine = JSON.stringify({ pid: process.pid, branch, started: new Date().toISOString() })
  const draft = `${lock}.${process.pid}`
  writeFileSync(draft, mine)
  try {
    for (;;) {
      try {
        // link() is atomic and fails on an existing lock, and the lock is
        // never seen half written.
        linkSync(draft, lock)
        return mine
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      const text = readIfPresent(lock)
      if (text === null) continue
      const holder = parseHolder(text)
      if (!holderAlive(holder.pid)) {
        say(`lock holder ${holder.pid ?? '(unreadable)'} is gone, taking the lock over`)
        takeOverStale(lock, text)
        continue
      }
      say(`queued behind pid ${holder.pid} (${holder.branch}, started ${holder.started})`)
      await sleep(WAIT_POLL_MS)
    }
  } finally {
    unlinkSync(draft)
  }
}

function warnOnBehind() {
  const fetch = spawnSync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: ROOT, encoding: 'utf8' })
  const warnings = []
  if (fetch.status !== 0) warnings.push(`could not fetch origin/main, comparing against the local ref: ${fetch.stderr.trim()}`)
  const behind = Number(git(['rev-list', '--count', `HEAD..${BASE}`])[0])
  if (behind > 0) {
    warnings.push(`this branch is ${behind} commit(s) behind ${BASE}: a stacked PR carries old problems forward. Not merging; merge ${BASE} yourself if this PR should verify against it.`)
  }
  return warnings
}

function warnOnUnstaged() {
  const unstaged = [...new Set([
    ...git(['diff', '--name-only']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ])]
  if (unstaged.length === 0) return []
  return [`${unstaged.length} unstaged or untracked file(s): the fingerprint checks read the git index, so git add them first or they go unchecked (${unstaged.slice(0, 5).join(', ')}${unstaged.length > 5 ? ', ...' : ''})`]
}

function report(results, warnings) {
  const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`.padStart(8)
  process.stdout.write('\n[pre-push] summary\n')
  for (const { name, status, ms, detail } of results) {
    process.stdout.write(`  ${status.padEnd(4)} ${ms === undefined ? '        ' : seconds(ms)}  ${name}${detail ? `  (${detail})` : ''}\n`)
  }
  for (const warning of warnings) process.stdout.write(`  WARN ${warning}\n`)
  const counted = (status) => results.filter((result) => result.status === status).length
  const total = results.reduce((sum, result) => sum + (result.ms ?? 0), 0)
  process.stdout.write(`[pre-push] ${counted('PASS')} passed, ${counted('FAIL')} failed, ${counted('SKIP')} skipped in ${seconds(total).trim()}\n`)
}

const USAGE = `usage: node scripts/pre-push-check.mjs [--list]

Runs the checks most likely to fail CI for the changes since ${BASE}.

  --list      print what would run and run nothing
  -h, --help  print this and run nothing
`

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }
  const unknown = argv.find((arg) => arg !== '--list')
  if (unknown) {
    process.stderr.write(`unknown option: ${unknown}\n${USAGE}`)
    return 2
  }
  if (process.platform === 'win32') {
    process.stderr.write('this needs bash, awk and sandboxing from macOS or Linux; run the checks one by one on Windows\n')
    return 2
  }
  const missing = ['node_modules', 'backend/.venv'].filter((path) => !existsSync(join(ROOT, path)))
  if (missing.length > 0) {
    process.stderr.write(`missing ${missing.join(' and ')}: run \`pnpm install\` and \`uv --project backend sync\` in this checkout\n`)
    return 2
  }
  if (argv.includes('--list')) {
    for (const check of buildPlan(changedFiles())) {
      process.stdout.write(check.skip ? `SKIP ${check.name} (${check.skip})\n` : `RUN  ${check.name}: ${check.argv.slice(0, 6).join(' ')}\n`)
    }
    return 0
  }

  const lock = join(resolve(ROOT, git(['rev-parse', '--git-common-dir'])[0]), LOCK_NAME)
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])[0]
  const mine = await acquireLock(lock, branch)
  cleanups.push(() => {
    if (readIfPresent(lock) === mine) unlinkSync(lock)
  })

  // After the queue: main may have moved while this run waited.
  const warnings = [...warnOnBehind(), ...warnOnUnstaged()]
  for (const warning of warnings) say(`WARNING: ${warning}`)

  const results = []
  for (const check of buildPlan(changedFiles())) {
    if (check.skip) {
      results.push({ name: check.name, status: 'SKIP', detail: check.skip })
      continue
    }
    await waitForLoad()
    say(`running ${check.name}`)
    const started = performance.now()
    const code = await run(check.argv, check.isolated ? isolatedEnv() : process.env)
    results.push({
      name: check.name,
      status: code === 0 ? 'PASS' : 'FAIL',
      ms: performance.now() - started,
      detail: code === 0 ? '' : `exit ${code}`,
    })
  }
  report(results, warnings)
  return results.some((result) => result.status === 'FAIL') ? 1 : 0
}

function cleanUp() {
  for (const cleanup of cleanups) cleanup()
  cleanups = []
}

for (const [signal, number] of [['SIGHUP', 1], ['SIGINT', 2], ['SIGTERM', 15]]) {
  process.on(signal, () => {
    if (activeChild?.pid) {
      try {
        process.kill(-activeChild.pid, 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    process.exit(128 + number)
  })
}
process.on('exit', cleanUp)

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`pre-push-check could not run: ${error.message}\n`)
    process.exitCode = 2
  },
)
