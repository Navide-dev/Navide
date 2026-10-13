import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, string> }
type Job = {
  if?: string; needs?: string | string[]; 'runs-on'?: string; 'timeout-minutes'?: string | number
  environment?: unknown; steps: Step[]
  strategy?: { 'fail-fast'?: boolean; matrix: { include: Array<{ arch: string; runner: string; shard: string; timeout: number }> } }
}
const source = readFileSync('.github/workflows/release.yml', 'utf8')
const jobs = (parse(source) as { jobs: Record<string, Job> }).jobs
const gates = jobs['release-windows-gates']
const legs = gates.strategy!.matrix.include
const packaging = { x64: jobs['release-windows-x64'], arm64: jobs['release-windows-arm64'] }
const needsOf = (job: Job) => [job.needs ?? []].flat()

describe('Windows release gates', () => {
  it('run every shard of the complete backend suite on each shipped Windows runner', () => {
    expect(gates.strategy?.['fail-fast']).toBe(false)
    for (const [arch, job] of Object.entries(packaging)) {
      const own = legs.filter((leg) => leg.arch === arch)
      const n = own.length
      expect(n).toBeGreaterThan(1)
      expect(own.map((leg) => leg.shard)).toEqual(Array.from({ length: n }, (_, i) => `${i + 1}/${n}`))
      for (const leg of own) expect(leg.runner).toBe(job['runs-on'])
    }
    expect(legs).toHaveLength(Object.keys(packaging).length * 4)
    expect(gates['runs-on']).toBe('${{ matrix.runner }}')
    expect(gates['timeout-minutes']).toBe('${{ matrix.timeout }}')
    for (const leg of legs) expect(leg.timeout).toBeLessThanOrEqual(60)

    const gate = gates.steps.find((step) => step.name === 'Run Windows release gates')!
    const commands = gate.run!.trim().split('\n').map((line) => line.trim())
    // The whole tree, narrowed by nothing but the shard: no -k, paths or deselects.
    expect(commands).toEqual([
      'uv --project backend run ruff check backend',
      'uv --project backend run pytest backend/tests --shard ${{ matrix.shard }}',
    ])
    expect(gates.steps.find((step) => step.uses?.startsWith('actions/setup-python@'))?.with?.['python-version'])
      .toBe(packaging.x64.steps.find((step) => step.uses?.startsWith('actions/setup-python@'))?.with?.['python-version'])
  })

  it('hold back packaging, and so the release, until every shard passed', () => {
    expect(gates.if).toBe(packaging.x64.if)
    expect(needsOf(gates)).toEqual([])
    expect(needsOf(packaging.x64)).toEqual(['release-macos-arm64', 'release-windows-gates'])
    expect(needsOf(packaging.arm64)).toEqual(['release-windows-x64'])
    expect(needsOf(jobs['publish-release'])).toContain('release-windows-gates')
  })

  it('move the suite out of the packaging jobs without touching what they publish', () => {
    for (const job of Object.values(packaging)) {
      expect(job.steps.some((step) => step.run?.includes('pytest'))).toBe(false)
      expect(job.environment).toEqual({ name: 'production', url: 'https://github.com/Navide-dev/Navide/releases/latest' })
    }
    // Tests get no deployment environment and no secrets.
    expect(gates.environment).toBeUndefined()
    const block = source.slice(source.indexOf('  release-windows-gates:'), source.indexOf('  release-windows-x64:'))
    expect(block).not.toContain('secrets.')
  })
})
