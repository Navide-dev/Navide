// Usage: node --import ./packages/nvterm/tools/register.mjs packages/nvterm/tools/bench/run.ts [--mib N] [--rounds N] [--only <dataset>]
// Prints parse throughput per dataset for xterm.js and nvterm as JSON
// (stability gate G4: nvterm must not be slower).
import { compare } from './bench'
import { datasets } from './datasets'
import { createNvtermStream } from '../golden/nvtermDriver'
import { createXtermStream } from '../golden/xtermOracle'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}

const mib = arg('--mib', 8)
const rounds = arg('--rounds', 7)
const results = []
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined
for (const dataset of datasets(mib * 1024 * 1024).filter((d) => !only || d.id === only)) {
  const r = await compare(createXtermStream, createNvtermStream, dataset, { rounds })
  results.push({ dataset: r.dataset, xtermMiBps: r.baselineMiBps, nvtermMiBps: r.candidateMiBps, ratio: r.ratio, ratios: r.ratios.map((x) => Number(x.toFixed(2))) })
}
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, mib, rounds, results }, null, 2))
