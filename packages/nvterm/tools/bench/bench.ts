import type { StreamFactory } from '../golden/driver.ts'
import type { Dataset } from './datasets.ts'

export interface BenchResult {
  dataset: string
  bytes: number
  /** Median over iterations. */
  mibPerSecond: number
  runsMs: number[]
}

/** Feeds the dataset in PTY-sized chunks and times until the terminal has parsed all of it. */
export async function measure(factory: StreamFactory, dataset: Dataset, options: { iterations?: number; chunkBytes?: number } = {}): Promise<BenchResult> {
  const iterations = options.iterations ?? 5
  const chunkBytes = options.chunkBytes ?? 64 * 1024
  const runsMs: number[] = []
  for (let run = 0; run < iterations; run++) {
    const stream = factory(120, 40)
    try {
      const start = performance.now()
      for (let i = 0; i < dataset.bytes.length; i += chunkBytes) stream.write(dataset.bytes.subarray(i, i + chunkBytes))
      await stream.flush()
      runsMs.push(performance.now() - start)
    } finally {
      stream.dispose()
    }
  }
  const sorted = [...runsMs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  return { dataset: dataset.id, bytes: dataset.bytes.length, mibPerSecond: dataset.bytes.length / (1024 * 1024) / (median / 1000), runsMs }
}
