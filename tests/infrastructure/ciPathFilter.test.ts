import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { FRONTEND_ONLY, isBackendOnly, isFrontendOnly, scopes } from '../../scripts/ci-changed-scopes.mjs'

type Job = { needs?: string | string[]; if?: string; outputs?: Record<string, string>; steps: Array<{ id?: string; run?: string; with?: Record<string, unknown> }> }
const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  concurrency: { 'cancel-in-progress': unknown }
  jobs: Record<string, Job>
}
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)

describe('CI path filter rules', () => {
  it('runs everything for pushes and any non pull request event', () => {
    for (const event of ['push', 'workflow_dispatch', 'schedule', '']) {
      expect(scopes({ event, files: ['src/renderer/src/App.vue'] })).toEqual({ backend: true, frontend: true })
    }
  })

  it('runs everything when the changed files are unknown or empty', () => {
    expect(scopes({ event: 'pull_request', files: null })).toEqual({ backend: true, frontend: true })
    expect(scopes({ event: 'pull_request', files: [] })).toEqual({ backend: true, frontend: true })
  })

  it('skips the backend group for a frontend-only change', () => {
    expect(scopes({ event: 'pull_request', files: ['src/renderer/src/App.vue', 'src/preload/index.ts', 'e2e/app.spec.ts'] }))
      .toEqual({ backend: false, frontend: true })
  })

  it('skips the frontend group for a change to backend tests only', () => {
    expect(scopes({ event: 'pull_request', files: ['backend/tests/test_projects.py', 'backend/tests/cli_regression/catalog.py'] }))
      .toEqual({ backend: true, frontend: false })
  })

  it.each([
    'backend/agent_team_backend/app.py',
    'backend/pyproject.toml',
    'backend/uv.lock',
    'src/main/index.ts',
    'src/shared/osplat.ts',
    'src/renderer/plugins/plans/plugin.json',
    'src/renderer/src/platform/plugin-shell/agents/claude.ts',
    'src/renderer/src/lib/promptSkillSeed.ts',
    'plugins/navide-plans/backend/plans_backend.py',
    'package.json',
    'bun.lock',
    '.github/workflows/ci.yml',
    'scripts/ci-changed-scopes.mjs',
    'docs/en-US/architecture.md',
    'README.md',
  ])('runs everything when %s changes, alone or with either side', (file) => {
    for (const files of [[file], [file, 'src/renderer/src/App.vue'], [file, 'backend/tests/test_projects.py']]) {
      expect(scopes({ event: 'pull_request', files })).toEqual({ backend: true, frontend: true })
    }
  })

  it('runs everything when the CLI wire test\'s Python harness changes', () => {
    for (const file of [
      'backend/tests/__init__.py',
      'backend/tests/cli_regression/__init__.py',
      'backend/tests/cli_regression/support/backend_process.py',
      'backend/tests/cli_regression/support/fake_cli.py',
    ]) {
      expect(scopes({ event: 'pull_request', files: [file] })).toEqual({ backend: true, frontend: true })
    }
  })

  it('runs everything for a change that touches both sides', () => {
    expect(scopes({ event: 'pull_request', files: ['src/renderer/src/App.vue', 'backend/tests/test_projects.py'] }))
      .toEqual({ backend: true, frontend: true })
  })

  it('matches directories by prefix and never by substring', () => {
    expect(isFrontendOnly('src/renderer-old/x.ts')).toBe(false)
    expect(isFrontendOnly('other/src/renderer/x.ts')).toBe(false)
    expect(isBackendOnly('backend/tests_extra/x.py')).toBe(false)
    expect(isBackendOnly('plugins/x/backend/tests/x.py')).toBe(false)
  })
})

// Literal paths in source code, with Python `Path / "a" / "b"` joins collapsed.
// Backticks quote only in JS/TS; in Python they are docstring markup.
function pathLiterals(text: string, quotes: string): string[] {
  const literal = new RegExp(`([${quotes}])([^${quotes}\\n]+)\\1`, 'g')
  const joined = /(['"])[^'"\n]+\1(?:\s*\)?\s*\/\s*\(?\s*(['"])[^'"\n]+\2)+/g
  const out = [...text.matchAll(literal)].map((m) => m[2])
  for (const m of text.matchAll(joined)) out.push([...m[0].matchAll(/(['"])([^'"\n]+)\1/g)].map((x) => x[2]).join('/'))
  return out.map((s) => s.replace(/^\.?\//, '').replace(/\/$/, ''))
}

// Files among `candidates` that `sources` name: by path, path tail, enclosing
// directory, or a bare basename that names exactly one tracked file.
function referenced(sources: string[], candidates: string[]): Map<string, string> {
  const byTail = new Map<string, string[]>()
  const byDir = new Map<string, string[]>()
  const add = (map: Map<string, string[]>, key: string, file: string) => map.set(key, [...(map.get(key) ?? []), file])
  for (const file of candidates) {
    const parts = file.split('/')
    for (let i = 0; i < parts.length; i++) add(byTail, parts.slice(i).join('/'), file)
    for (let i = 2; i < parts.length; i++) add(byDir, parts.slice(0, i).join('/'), file)
  }
  const basenames = new Map<string, number>()
  for (const t of tracked) {
    const base = t.slice(t.lastIndexOf('/') + 1)
    basenames.set(base, (basenames.get(base) ?? 0) + 1)
  }
  const hits = new Map<string, string>()
  for (const source of sources) {
    for (const s of pathLiterals(readFileSync(source, 'utf8'), '\'"')) {
      if (!s.includes('/') && basenames.get(s) !== 1) continue
      for (const file of [...(byTail.get(s) ?? []), ...(byDir.get(s) ?? [])]) hits.set(file, source)
    }
  }
  return hits
}

describe('path filter allowlists match what the suites read', () => {
  it('lists no frontend-only file that backend code or tests name', () => {
    const backendSources = tracked.filter((f) => f.startsWith('backend/') && f.endsWith('.py'))
    const underPrefixes = tracked.filter((f) => FRONTEND_ONLY.some((p) => f.startsWith(p)))
    const hits = referenced(backendSources, underPrefixes)
    // The scan is not blind: it finds the files the backend is known to read.
    expect(hits.has('src/renderer/src/lib/promptSkillSeed.ts')).toBe(true)
    expect(hits.has('src/renderer/src/platform/plugin-shell/agents/claude.ts')).toBe(true)
    const leaked = [...hits].filter(([file]) => isFrontendOnly(file)).map(([file, source]) => `${file} <- ${source}`)
    expect(leaked, 'add these to FRONTEND_SHARED in scripts/ci-changed-scopes.mjs').toEqual([])
  })

  it('lists no backend-only file that frontend code, tests or scripts read', () => {
    const code = /\.(ts|mts|mjs|js|cjs|vue)$/
    const sources = tracked.filter((f) => code.test(f) && !f.startsWith('backend/'))
    // Log-line fixtures, not reads; and the filter and its own tests.
    const allowed = new Set([
      'tests/infrastructure/ciTriage.test.ts',
      'tests/infrastructure/ciPathFilter.test.ts',
      'scripts/ci-changed-scopes.mjs',
      // `bun run test:cli` runs pytest itself; CI's frontend job does not use it.
      'scripts/run-cli-tests.mjs',
      // A local test picker; it and its test run in the static job, which the
      // filter never skips.
      'scripts/changed-backend-tests.mjs',
      'tests/infrastructure/changedBackendTests.test.ts',
    ])
    const offenders = sources.filter((source) => {
      if (allowed.has(source)) return false
      const text = readFileSync(source, 'utf8').split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
      // Python embedded in a test imports the harness as `tests.<module>`.
      const modules = [...text.matchAll(/\b(?:from|import)\s+(tests(?:\.\w+)+)/g)]
        .map((m) => `backend/${m[1].replaceAll('.', '/')}.py`)
      return pathLiterals(text, '\'"`').some((s) => isBackendOnly(`${s}/`) || isBackendOnly(s)) ||
        modules.some(isBackendOnly) ||
        /['"]backend['"]\s*,\s*['"]tests['"]/.test(text)
    })
    expect(offenders, 'these read backend/tests; narrow BACKEND_ONLY in scripts/ci-changed-scopes.mjs').toEqual([])
  })
})

describe('CI workflow wiring of the path filter', () => {
  it('publishes the filter verdicts from the changes job', () => {
    const job = workflow.jobs.changes
    expect(job.outputs).toEqual({
      backend: '${{ steps.scopes.outputs.backend }}',
      frontend: '${{ steps.scopes.outputs.frontend }}',
    })
    const step = job.steps.find((entry) => entry.id === 'scopes')
    expect(step?.run).toBe('node scripts/ci-changed-scopes.mjs')
    // The merge commit's first parent must be present for the diff.
    expect(job.steps[0].with?.['fetch-depth']).toBe(2)
  })

  it.each([
    ['backend', 'backend'],
    ['frontend', 'frontend'],
    ['build-artifacts', 'frontend'],
  ])('gates %s on the %s verdict and runs it when the verdict is missing', (name, output) => {
    const job = workflow.jobs[name]
    expect(job.needs).toBe('changes')
    expect(job.if).toBe(`\${{ !cancelled() && needs.changes.outputs.${output} != 'false' }}`)
  })

  it('leaves every other job unfiltered', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (['backend', 'frontend', 'build-artifacts', 'lint-and-test'].includes(name)) continue
      expect(job.if, name).toBeUndefined()
    }
  })

  it('never cancels a run on main', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.ref != 'refs/heads/main' }}")
  })
})

describe('changed-scopes script', () => {
  function runScript(event: string) {
    return execFileSync('node', ['scripts/ci-changed-scopes.mjs'], {
      encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: '' },
    })
  }

  it('reports both groups for a push without reading the diff', () => {
    expect(runScript('push')).toContain('backend=true\nfrontend=true\n')
  })
})
