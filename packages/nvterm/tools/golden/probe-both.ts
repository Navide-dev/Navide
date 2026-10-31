// Usage: node --import ./packages/nvterm/tools/register.mjs packages/nvterm/tools/golden/probe-both.ts '<js string literal>' [cols] [rows]
// Runs one input through the oracle and nvterm and prints the differences.
import { diffSnapshots } from '../../src/snapshot'
import { nvtermDriver } from './nvtermDriver'
import { xtermDriver } from './xtermOracle'

const input = JSON.parse(`"${process.argv[2] ?? ''}"`) as string
const fixture = { id: 'probe', description: '', cols: Number(process.argv[3] ?? 10), rows: Number(process.argv[4] ?? 3), chunks: [new TextEncoder().encode(input)] }
const diffs = diffSnapshots(await xtermDriver.run(fixture), await nvtermDriver.run(fixture))
console.log(diffs.length ? diffs.map((d) => JSON.stringify(d)).join('\n') : 'same')
