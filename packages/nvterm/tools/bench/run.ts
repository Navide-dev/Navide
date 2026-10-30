// Usage: node packages/nvterm/tools/bench/run.ts [--mib N] [--iterations N]
// Prints parse throughput per dataset as JSON. Only xterm.js exists until M1,
// so this records the baseline nvterm has to match (stability gate G4).
import { measure } from './bench.ts'
import { datasets } from './datasets.ts'
import { createXtermStream } from '../golden/xtermOracle.ts'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}

const mib = arg('--mib', 8)
const iterations = arg('--iterations', 5)
const results = []
for (const dataset of datasets(mib * 1024 * 1024)) {
  results.push({ driver: 'xterm.js', ...(await measure(createXtermStream, dataset, { iterations })) })
}
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, mib, iterations, results }, null, 2))
