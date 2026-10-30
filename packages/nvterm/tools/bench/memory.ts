// Usage: node --expose-gc --import ./packages/nvterm/tools/register.mjs packages/nvterm/tools/bench/memory.ts [--lines N] [--cols N]
// Heap held by a full scrollback of mixed CLI-like output, after GC:
// xterm.js headless, nvterm as written, nvterm after packing cold scrollback.
import { createRequire } from 'node:module'
import { TerminalCore } from '../../src/terminal'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless')

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const lines = arg('--lines', 10000)
const cols = arg('--cols', 120)
const rows = 40

/** Mixed output: short status lines, code, coloured diff lines, CJK prose, an emoji now and then. */
function output(): Uint8Array {
  const out: string[] = []
  for (let i = 0; i < lines; i++) {
    switch (i % 5) {
      case 0: out.push(`\x1b[2m[${i}] step done\x1b[0m`); break
      case 1: out.push(`  const value${i} = compute(input, { retries: ${i % 7}, timeoutMs: 3000 }) // ${'x'.repeat(i % 40)}`); break
      case 2: out.push(`\x1b[48;2;0;40;0m\x1b[32m+ added line ${i} in src/module${i % 13}.ts\x1b[K\x1b[0m`); break
      case 3: out.push(`輸出第 ${i} 行：中文說明文字，混合 English words 與標點。`); break
      default: out.push(`${i} ✅ passed 😀 ${'-'.repeat(i % 60)}`)
    }
  }
  return new TextEncoder().encode(out.join('\r\n'))
}

const gc = (globalThis as { gc?: () => void }).gc
if (!gc) throw new Error('run with node --expose-gc')
/** JS heap plus memory outside it (typed array storage lives there). */
function heap(): number {
  gc!(); gc!()
  const m = process.memoryUsage()
  return m.heapUsed + m.external
}

const data = output()
const results: Record<string, number> = {}

{
  const before = heap()
  const term = new Terminal({ cols, rows, scrollback: lines, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(data, resolve))
  results['xterm.js'] = heap() - before
  term.dispose()
}
{
  const before = heap()
  const core = new TerminalCore({ cols, rows, scrollback: lines })
  core.write(data)
  results['nvterm (unpacked)'] = heap() - before
  core.packScrollback()
  results['nvterm (packed)'] = heap() - before
  if (core.active.scrollbackLength < 0) console.log('unreachable')
}

const mib = (b: number) => (b / (1024 * 1024)).toFixed(1)
console.log(JSON.stringify({ node: process.version, lines, cols, mib: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Number(mib(v))])) }, null, 2))
