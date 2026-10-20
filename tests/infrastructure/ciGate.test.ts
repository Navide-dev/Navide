import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

type Step = {
  name?: string; run?: string; if?: string; uses?: string; shell?: string
  env?: Record<string, string>; 'continue-on-error'?: boolean
}
const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, {
    needs?: string[]; if?: string; steps: Step[]; 'timeout-minutes'?: string | number
    strategy?: { matrix: { include: Array<{ platform: string; shard?: string; timeout?: number }> } }
  }>
}
const gate = workflow.jobs['lint-and-test']
const verdict = gate.steps.find((step) => step.name === 'Require every check to succeed')!
const results = Object.keys(verdict.env ?? {}).filter((key) => key.endsWith('_RESULT'))
// The path filter's verdicts: which job groups the changes job asked for.
const filters = Object.keys(verdict.env ?? {}).filter((key) => !key.endsWith('_RESULT'))
const shellEnvironment = { ...process.env }
delete shellEnvironment.BASH_ENV
delete shellEnvironment.ENV
const bashAvailable = spawnSync('bash', ['--noprofile', '--norc', '-c', 'exit 0'], {
  env: shellEnvironment, encoding: 'utf8', timeout: 5000,
}).status === 0

describe('required CI gate', () => {
  it('requires every verification job, including native speech tests', () => {
    expect(gate.needs?.slice().sort())
      .toEqual(Object.keys(workflow.jobs).filter((name) => name !== 'lint-and-test').sort())
    expect(gate.if).toContain('always()')
    expect(filters.sort()).toEqual(['RUN_BACKEND', 'RUN_FRONTEND'])
    for (const key of filters) {
      expect(verdict.env?.[key]).toBe(`\${{ needs.changes.outputs.${key.slice(4).toLowerCase()} }}`)
    }
    const mapped = results.map((key) => verdict.env![key]).map((value) => {
      const match = value.match(/needs(?:\.([\w-]+)|\['([\w-]+)'\])\.result/)
      expect(match, `unrecognized result mapping: ${value}`).not.toBeNull()
      return match?.[1] ?? match?.[2]
    })
    expect(mapped.sort()).toEqual(gate.needs?.slice().sort())
    expect(gate.steps.some((step) => step.uses)).toBe(false)
    expect(verdict.shell).toBe('bash')
  })

  it('requires executable shell validation in the Linux static job', () => {
    const step = workflow.jobs.static.steps.find((entry) => entry.run?.startsWith('bun run test:infrastructure'))
    expect(step?.env?.NAVIDE_REQUIRE_CI_SHELL).toBe('1')
    if (process.env.NAVIDE_REQUIRE_CI_SHELL === '1') expect(bashAvailable).toBe(true)
  })

  // Probe the capability rather than assuming every Windows host has Git Bash.
  // The required Linux static job fails above if this executable check cannot run.
  describe.skipIf(!bashAvailable)('actual workflow shell verdict', () => {
    function run(overrides: Record<string, string | undefined>) {
      const env: NodeJS.ProcessEnv = {
        ...shellEnvironment,
        ...Object.fromEntries(results.map((key) => [key, 'success'])),
        ...Object.fromEntries(filters.map((key) => [key, 'true'])),
      }
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[key]
        else env[key] = value
      }
      return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', verdict.run!], {
        encoding: 'utf8', env, timeout: 5000,
      })
    }

    it('accepts successful results from every required job', () => {
      const result = run({})
      expect(result.status, result.stderr).toBe(0)
    })

    it.each(['failure', 'cancelled', 'skipped', '', undefined])('rejects any required result of %s', (value) => {
      for (const key of results) expect(run({ [key]: value }).status, key).toBe(1)
    })

    it('rejects an entirely missing set of results', () => {
      expect(run(Object.fromEntries(results.map((key) => [key, undefined]))).status).toBe(1)
    })

    const groups = [
      { filter: 'RUN_FRONTEND', jobs: ['FRONTEND_RESULT', 'BUILD_ARTIFACTS_RESULT', 'PNPM_LOCKFILE_RESULT'] },
      { filter: 'RUN_BACKEND', jobs: ['BACKEND_RESULT'] },
    ]

    it('accepts a job group the path filter chose not to run', () => {
      for (const { filter, jobs } of groups) {
        const result = run({ [filter]: 'false', ...Object.fromEntries(jobs.map((key) => [key, 'skipped'])) })
        expect(result.status, `${filter}: ${result.stdout}${result.stderr}`).toBe(0)
      }
    })

    it.each(['failure', 'cancelled', ''])('still rejects a filtered-out job whose result is %s', (value) => {
      for (const { filter, jobs } of groups) {
        for (const key of jobs) expect(run({ [filter]: 'false', [key]: value }).status, key).toBe(1)
      }
    })

    it.each(['true', '', undefined])('rejects a skipped job the filter asked for (filter %s)', (value) => {
      for (const { filter, jobs } of groups) {
        for (const key of jobs) expect(run({ [filter]: value, [key]: 'skipped' }).status, key).toBe(1)
      }
    })

    it('excuses only the group the filter skipped', () => {
      const others = results.filter((key) => !groups.some((group) => group.jobs.includes(key)))
      for (const key of others) {
        expect(run({ RUN_FRONTEND: 'false', RUN_BACKEND: 'false', [key]: 'skipped' }).status, key).toBe(1)
      }
      expect(run({ RUN_BACKEND: 'false', FRONTEND_RESULT: 'skipped' }).status).toBe(1)
      expect(run({ RUN_FRONTEND: 'false', BACKEND_RESULT: 'skipped' }).status).toBe(1)
    })
  })

  it('retains complete source and artifact suites on every supported desktop platform', () => {
    for (const name of ['frontend', 'build-artifacts', 'backend']) {
      const job = workflow.jobs[name]
      expect([...new Set(job.strategy?.matrix.include.map((entry) => entry.platform))].sort())
        .toEqual(['Linux', 'Windows', 'macOS'])
      expect(job.steps.some((step) => step.uses?.startsWith('actions/upload-artifact@') && step.if === 'always()')).toBe(true)
    }
    expect(workflow.jobs.backend.strategy?.matrix.include.filter((entry) => entry.platform === 'Windows')
      .map((entry) => entry.shard)).toEqual(['1/5', '2/5', '3/5', '4/5', '5/5'])
  })

  it('preserves platform time budgets and best-effort Windows diagnostics', () => {
    const backend = workflow.jobs.backend
    expect(backend['timeout-minutes']).toBe('${{ matrix.timeout }}')
    expect(backend.strategy?.matrix.include.map(({ platform, timeout }) => [platform, timeout]))
      .toEqual([['macOS', 25], ['Linux', 25], ['Windows', 45], ['Windows', 45], ['Windows', 45], ['Windows', 45], ['Windows', 45]])
    const diagnostic = backend.steps.find((step) => step.name === 'Report the backend test log')!
    expect(diagnostic.if).toContain('always()')
    expect(diagnostic.if).toContain("runner.os == 'Windows'")
    expect(diagnostic.shell).toBe('pwsh')
    expect(diagnostic['continue-on-error']).toBe(true)
    expect(diagnostic.run).toContain('Get-Process')
    expect(diagnostic.run).toContain('pytest.log')
  })

  it('does not let diagnostic uploads replace the test verdict', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps.filter((entry) => entry.uses?.startsWith('actions/upload-artifact@'))) {
        expect(step['continue-on-error']).toBe(true)
      }
    }
  })
})
