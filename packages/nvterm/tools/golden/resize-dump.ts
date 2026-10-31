// Usage: ... resize-dump.ts <fixture-id> <width>: prints both screens (and scrollback length) after the resize.
import { createRequire } from 'node:module'
import { TerminalCore } from '../../src/terminal'
import { fixtures } from '../fixtures/fixtures'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless')
const [id, w] = process.argv.slice(2)
const f = fixtures.find((x) => x.id === id)!
const x = new Terminal({ cols: f.cols, rows: f.rows, scrollback: 10000, allowProposedApi: true })
const n = new TerminalCore({ cols: f.cols, rows: f.rows, scrollback: 10000 })
for (const c of f.chunks) { await new Promise<void>((r) => x.write(c, r)); n.write(c) }
x.resize(Number(w), f.rows); await new Promise<void>((r) => x.write('', r)); n.resize(Number(w), f.rows)
const xb = x.buffer.active
console.log(`xterm  base=${xb.baseY} cursor=${xb.cursorX},${xb.cursorY}`)
for (let i = 0; i < Math.min(xb.length, 8); i++) { const l = xb.getLine(i)!; console.log(`  ${i}${l.isWrapped ? '+' : ' '} ${JSON.stringify(l.translateToString(true))}`) }
const nb = n.active
console.log(`nvterm base=${nb.scrollbackLength} cursor=${nb.x},${nb.y}`)
for (let i = 0; i < Math.min(nb.length, 8); i++) { const l = nb.absoluteLine(i)!; let s = ''; for (let c = 0; c < l.cols; c++) if (l.widths[c] !== 0) s += l.chars(c) || ' '; console.log(`  ${i}${l.wrapped ? '+' : ' '} ${JSON.stringify(s.trimEnd())}`) }
x.dispose()
