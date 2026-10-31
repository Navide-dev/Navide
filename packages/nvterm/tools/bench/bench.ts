import type { StreamFactory } from '../golden/driver'
import type { Dataset } from './datasets'

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

export interface ComparisonResult {
  dataset: string
  bytes: number
  /** Median throughput of each side, MiB/s. */
  baselineMiBps: number
  candidateMiBps: number
  /** Median of the per-round ratios candidate / baseline (above 1 = candidate faster). */
  ratio: number
  ratios: number[]
}

async function timeOnce(factory: StreamFactory, bytes: Uint8Array, chunkBytes: number): Promise<number> {
  const stream = factory(120, 40)
  try {
    const start = performance.now()
    for (let i = 0; i < bytes.length; i += chunkBytes) stream.write(bytes.subarray(i, i + chunkBytes))
    await stream.flush()
    return performance.now() - start
  } finally {
    stream.dispose()
  }
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

/**
 * Times two implementations in alternating rounds after a warm-up round, so
 * machine load drifting during the run affects both sides alike. The ratio
 * is the median of the per-round ratios.
 */
export async function compare(baseline: StreamFactory, candidate: StreamFactory, dataset: Dataset, options: { rounds?: number; chunkBytes?: number } = {}): Promise<ComparisonResult> {
  const rounds = options.rounds ?? 7
  const chunkBytes = options.chunkBytes ?? 64 * 1024
  await timeOnce(baseline, dataset.bytes, chunkBytes)
  await timeOnce(candidate, dataset.bytes, chunkBytes)
  const a: number[] = []
  const b: number[] = []
  for (let round = 0; round < rounds; round++) {
    // Alternate which side goes first.
    if (round % 2 === 0) {
      a.push(await timeOnce(baseline, dataset.bytes, chunkBytes))
      b.push(await timeOnce(candidate, dataset.bytes, chunkBytes))
    } else {
      b.push(await timeOnce(candidate, dataset.bytes, chunkBytes))
      a.push(await timeOnce(baseline, dataset.bytes, chunkBytes))
    }
  }
  const mib = dataset.bytes.length / (1024 * 1024)
  const ratios = a.map((ms, i) => ms / b[i]!)
  return { dataset: dataset.id, bytes: dataset.bytes.length, baselineMiBps: mib / (median(a) / 1000), candidateMiBps: mib / (median(b) / 1000), ratio: median(ratios), ratios }
}
