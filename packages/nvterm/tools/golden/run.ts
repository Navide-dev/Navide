// Usage: node --import ./packages/nvterm/tools/register.mjs packages/nvterm/tools/golden/run.ts [fixture-id ...]
// Compares every fixture (or the named ones) between the oracle and the
// candidate driver and prints untriaged differences. Exits 1 if any remain.
import { readFileSync } from 'node:fs'
import { fixtures } from '../fixtures/fixtures'
import { compareAll, type Triage } from './compare'
import { nvtermDriver } from './nvtermDriver'
import { xtermDriver } from './xtermOracle'

const candidate = nvtermDriver
const triage = JSON.parse(readFileSync(new URL('./triage.json', import.meta.url), 'utf8')) as Triage
const wanted = new Set(process.argv.slice(2))
const selected = wanted.size ? fixtures.filter((f) => wanted.has(f.id)) : fixtures

const results = await compareAll(selected, xtermDriver, candidate, triage)
let untriaged = 0
for (const result of results) {
  const status = result.untriaged.length ? 'FAIL' : result.diffs.length ? 'TRIAGED' : 'OK'
  console.log(`${status.padEnd(8)}${result.fixture} (${result.diffs.length} diffs, ${result.untriaged.length} untriaged)`)
  for (const diff of result.untriaged.slice(0, 5)) console.log(`        ${JSON.stringify(diff)}`)
  untriaged += result.untriaged.length
}
console.log(`\n${results.length} fixtures, ${untriaged} untriaged diffs`)
process.exitCode = untriaged ? 1 : 0
