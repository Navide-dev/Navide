// Usage: node --import ./packages/nvterm/tools/register.mjs packages/nvterm/tools/golden/resize-run.ts
// Prints, per fixture, how many cells differ from xterm.js after narrowing to half width and widening back.
import { fixtures } from '../fixtures/fixtures'
import { compareResize } from './resizeCompare'

for (const f of fixtures) {
  const steps = await compareResize(f, [Math.max(10, Math.floor(f.cols / 2)), f.cols])
  const summary = steps.map((s) => `${s.width}:${s.diffs.length}`).join(' ')
  const kinds = [...new Set(steps.flatMap((s) => s.diffs.map((d) => d.kind)))].join(',')
  if (steps.some((s) => s.diffs.length)) console.log(`${f.id.padEnd(28)} ${summary} ${kinds}`)
}
