#!/usr/bin/env node
// Runs the backend test files a change can affect, through the isolated
// runner (scripts/isolated-pytest.sh): a local shortcut, never a substitute
// for the full suite that CI and the release gates run.
//
//   node scripts/changed-backend-tests.mjs [base] [--list] [-- pytest args]
//
// "Changed" is everything between `base` (default origin/main) and the
// working tree, untracked files included, like `vitest --changed`. A changed
// test file selects itself; a changed agent_team_backend module selects the
// tests that import it (or name it, as mock.patch does); a changed
// non-backend file selects the tests that name it or its directory. Anything
// else under backend/ (conftest, helpers, pyproject, the lock) and anything
// that cannot be read selects the whole suite.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WHOLE_SUITE = ['backend/tests']
const PACKAGE = 'backend/agent_team_backend/'

/** Dotted module name of a backend source file, or null. */
export function moduleOf(file) {
  if (!file.startsWith(PACKAGE) || !file.endsWith('.py')) return null
  return file.slice('backend/'.length, -'.py'.length).replace(/\/__init__$/, '').split('/').join('.')
}

/** Modules a Python source imports, absolute or relative to `module`. */
export function importsOf(text, module, isPackage) {
  const found = new Set()
  const base = isPackage ? module : module.split('.').slice(0, -1).join('.')
  const resolveFrom = (dots, name) => {
    if (dots === 0) return name
    const parts = base.split('.')
    const anchor = parts.slice(0, parts.length - (dots - 1)).join('.')
    return name ? `${anchor}.${name}` : anchor
  }
  for (const m of text.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+(\([^)]*\)|[^\n]*)/gm)) {
    const from = resolveFrom(m[1].length, m[2])
    found.add(from)
    for (const name of m[3].replace(/#[^\n]*/g, '').replace(/[()]/g, '').split(/[,\n]/)) {
      const imported = name.trim().split(/\s+/)[0]
      if (/^\w+$/.test(imported)) found.add(`${from}.${imported}`)
    }
  }
  for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm)) {
    for (const name of m[1].split(',')) found.add(name.trim().split(/\s+/)[0])
  }
  return found
}

/**
 * @param changed repository-relative paths
 * @param repo { files: tracked and untracked paths, read(path): string }
 * @returns test paths for pytest; WHOLE_SUITE when unsure; [] when nothing applies
 */
export function selectTests(changed, repo) {
  const tests = repo.files.filter((f) => f.startsWith('backend/tests/') && /(^|\/)test_[^/]*\.py$/.test(f))
  const selected = new Set()
  const changedModules = new Set()
  for (const file of changed) {
    if (file.startsWith('backend/tests/')) {
      if (!tests.includes(file)) {
        if (/(^|\/)test_[^/]*\.py$/.test(file)) continue // deleted test file
        return WHOLE_SUITE // conftest, helpers, fixtures, support code
      }
      selected.add(file)
    } else if (moduleOf(file) !== null) {
      changedModules.add(moduleOf(file))
    } else if (file.startsWith('backend/')) {
      return WHOLE_SUITE
    } else {
      const base = file.slice(file.lastIndexOf('/') + 1)
      const dir = dirname(file)
      for (const test of tests) {
        const text = repo.read(test)
        if (text.includes(base) || (dir.includes('/') && text.includes(dir))) selected.add(test)
      }
    }
  }
  // Direct importers only: through the app and ws_handlers nearly every
  // module reaches nearly every test, so the import closure would select
  // most of the suite. Indirect breakage is what the full suite is for.
  // Importing a.b.c runs a/__init__ and a/b/__init__ too, so a changed
  // package counts for every submodule imported from it.
  const importsModule = (imports, target) =>
    [...imports].some((name) => name === target || name.startsWith(`${target}.`))
  for (const test of changedModules.size > 0 ? tests : []) {
    const text = repo.read(test)
    const imports = importsOf(text, '', false)
    // Names in strings count too: mock.patch("agent_team_backend.x.y").
    if ([...changedModules].some((target) => importsModule(imports, target) || text.includes(`${target}.`) || text.includes(`"${target}"`) || text.includes(`'${target}'`))) {
      selected.add(test)
    }
  }
  return [...selected].sort()
}

const USAGE = `usage: node scripts/changed-backend-tests.mjs [base] [--list] [-- pytest args]

Runs the backend test files that the changes since base (default origin/main)
can affect, through scripts/isolated-pytest.sh.

  --list      print the selection and run nothing
  -h, --help  print this and run nothing
  --          everything after it goes to pytest
`

/**
 * Own arguments; anything after `--` goes to pytest untouched.
 * @returns { help: true } | { error } | { base, list, pytestArgs }
 */
export function parseArgs(argv) {
  const split = argv.indexOf('--')
  const own = split >= 0 ? argv.slice(0, split) : argv
  const pytestArgs = split >= 0 ? argv.slice(split + 1) : []
  if (own.includes('--help') || own.includes('-h')) return { help: true }
  let base = null
  for (const arg of own) {
    if (arg === '--list') continue
    if (arg.startsWith('-')) return { error: `unknown option: ${arg}` }
    if (base !== null) return { error: `more than one base: ${arg}` }
    base = arg
  }
  return { base: base ?? 'origin/main', list: own.includes('--list'), pytestArgs }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean)
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (args.error) {
    process.stderr.write(`${args.error}\n${USAGE}`)
    return 2
  }
  const { base, list, pytestArgs } = args
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  process.chdir(root)
  let selected
  try {
    const changed = [...new Set([
      ...git(['diff', '--name-only', '--no-renames', `${base}...HEAD`]),
      ...git(['diff', '--name-only', '--no-renames', 'HEAD']),
      ...git(['ls-files', '--others', '--exclude-standard']),
    ])]
    const files = [...new Set([...git(['ls-files']), ...git(['ls-files', '--others', '--exclude-standard'])])]
      .filter((f) => existsSync(f))
    selected = selectTests(changed, { files, read: (f) => readFileSync(f, 'utf8') })
  } catch (error) {
    process.stderr.write(`could not work out the change, running the whole suite: ${error.message}\n`)
    selected = WHOLE_SUITE
  }
  if (list) {
    process.stdout.write(selected.map((f) => `${f}\n`).join(''))
    return 0
  }
  if (selected.length === 0) {
    process.stdout.write(`no backend tests affected by changes since ${base}\n`)
    return 0
  }
  if (process.platform === 'win32') {
    process.stderr.write('the isolated runner (scripts/isolated-pytest.sh) needs bash on macOS or Linux; use --list\n')
    return 2
  }
  process.stdout.write(`running ${selected === WHOLE_SUITE ? 'the whole backend suite' : `${selected.length} test file(s)`}\n`)
  // Never plain `uv run pytest`: the isolated runner keeps the tests away from
  // the real HOME and keychain, and never syncs the venv.
  const run = spawnSync('bash', ['scripts/isolated-pytest.sh', ...selected, ...pytestArgs], { stdio: 'inherit' })
  return run.status ?? 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
