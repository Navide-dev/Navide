// Usage: node packages/nvterm/tools/bench/run.ts [--mib N] [--iterations N]
// Prints parse throughput per dataset for xterm.js and nvterm as JSON
// (stability gate G4: nvterm must not be slower).
import { measure } from './bench.ts'
import { datasets } from './datasets.ts'
import { createNvtermStream } from '../golden/nvtermDriver.ts'
import { createXtermStream } from '../golden/xtermOracle.ts'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}

const mib = arg('--mib', 8)
const iterations = arg('--iterations', 5)
const results = []
for (const dataset of datasets(mib * 1024 * 1024)) {
  const xterm = await measure(createXtermStream, dataset, { iterations })
  const nvterm = await measure(createNvtermStream, dataset, { iterations })
  results.push({ dataset: dataset.id, xtermMiBps: xterm.mibPerSecond, nvtermMiBps: nvterm.mibPerSecond, ratio: nvterm.mibPerSecond / xterm.mibPerSecond })
}
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, mib, iterations, results }, null, 2))
