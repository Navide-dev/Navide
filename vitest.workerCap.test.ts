import { describe, expect, it, vi } from 'vitest'

import { testWorkerCap } from './vitest.workerCap'

// Navide's "Resource limits" setting hands new panes NAVIDE_TEST_MAX_WORKERS
// (backend resource_limits.TEST_WORKERS_ENV). Unset — the default — must leave
// vitest's own pool sizing alone, and anything unparseable fails open the same
// way rather than breaking the run.
describe('testWorkerCap', () => {
  it('leaves the pool alone when the variable is unset', () => {
    expect(testWorkerCap({})).toEqual({})
  })

  it('caps the pool at the value Navide set', () => {
    expect(testWorkerCap({ NAVIDE_TEST_MAX_WORKERS: '4' })).toEqual({ maxWorkers: 4, minWorkers: 1 })
  })

  it.each(['', '0', '-2', 'abc', '2.5', '1e3', '65'])('ignores %j', (value) => {
    expect(testWorkerCap({ NAVIDE_TEST_MAX_WORKERS: value })).toEqual({})
  })
})

describe('vitest.config', () => {
  async function loadConfig(value: string | undefined) {
    const saved = process.env.NAVIDE_TEST_MAX_WORKERS
    if (value === undefined) delete process.env.NAVIDE_TEST_MAX_WORKERS
    else process.env.NAVIDE_TEST_MAX_WORKERS = value
    try {
      vi.resetModules()
      return (await import('./vitest.config')).default
    } finally {
      if (saved === undefined) delete process.env.NAVIDE_TEST_MAX_WORKERS
      else process.env.NAVIDE_TEST_MAX_WORKERS = saved
    }
  }

  it('keeps vitest\'s own pool sizing by default', async () => {
    const config = await loadConfig(undefined)
    expect(config.test?.maxWorkers).toBeUndefined()
    expect(config.test?.minWorkers).toBeUndefined()
  })

  it('applies the cap a Navide pane hands it', async () => {
    const config = await loadConfig('3')
    expect(config.test?.maxWorkers).toBe(3)
    expect(config.test?.minWorkers).toBe(1)
  })
})
