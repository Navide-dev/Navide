import { describe, expect, it } from 'vitest'
import { createXtermStream } from '../golden/xtermOracle.ts'
import { measure } from './bench.ts'
import { datasets } from './datasets.ts'

describe('throughput benchmark harness', () => {
  it('builds every dataset near the requested size', () => {
    const sets = datasets(64 * 1024)
    expect(sets.map((d) => d.id)).toEqual(['ascii', 'cjk', 'sgr', 'tui'])
    for (const d of sets) expect(d.bytes.length, d.id).toBeGreaterThanOrEqual(64 * 1024)
  })

  it('measures a small dataset end to end (smoke only, not a benchmark run)', async () => {
    const result = await measure(createXtermStream, datasets(32 * 1024)[0]!, { iterations: 1 })
    expect(result.runsMs).toHaveLength(1)
    expect(result.mibPerSecond).toBeGreaterThan(0)
  })
})
