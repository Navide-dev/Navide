// Usage: node --import ./packages/nvterm/tools/register.mjs packages/nvterm/tools/golden/probe.ts '<js string literal>' [cols] [rows]
// Prints the oracle's screen for one input: a quick black-box question to xterm.js.
import { describeCell } from '../../src/snapshot'
import { xtermDriver } from './xtermOracle'

const input = JSON.parse(`"${process.argv[2] ?? ''}"`) as string
const cols = Number(process.argv[3] ?? 10)
const rows = Number(process.argv[4] ?? 3)
const snap = await xtermDriver.run({ id: 'probe', description: '', cols, rows, chunks: [new TextEncoder().encode(input)] })
console.log(`cursor ${snap.cursor.x},${snap.cursor.y} buffer ${snap.buffer} scrollback ${snap.scrollbackLength}`)
snap.lines.forEach((line, r) => {
  const cells = line.cells.map((c, i) => [i, c] as const).filter(([, c]) => c.chars !== '' || c.bg !== 'd' || c.flags || c.width !== 1)
  console.log(`row ${r}${line.wrapped ? ' (wrapped)' : ''}: ${cells.map(([i, c]) => `${i}=${describeCell(c)}`).join(' | ')}`)
})
