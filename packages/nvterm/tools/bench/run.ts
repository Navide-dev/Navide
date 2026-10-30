// Usage: node packages/nvterm/tools/bench/run.ts [--mib N] [--rounds N]
// Prints parse throughput per dataset for xterm.js and nvterm as JSON
// (stability gate G4: nvterm must not be slower).
import { compare } from './bench.ts'
import { datasets } from './datasets.ts'
import { createNvtermStream } from '../golden/nvtermDriver.ts'
import { createXtermStream } from '../golden/xtermOracle.ts'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}

const mib = arg('--mib', 8)
const rounds = arg('--rounds', 7)
const results = []
for (const dataset of datasets(mib * 1024 * 1024)) {
  const r = await compare(createXtermStream, createNvtermStream, dataset, { rounds })
  results.push({ dataset: r.dataset, xtermMiBps: r.baselineMiBps, nvtermMiBps: r.candidateMiBps, ratio: r.ratio, ratios: r.ratios.map((x) => Number(x.toFixed(2))) })
}
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, mib, rounds, results }, null, 2))
