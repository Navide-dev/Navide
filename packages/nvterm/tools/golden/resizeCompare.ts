// Compares reflow between nvterm and the xterm.js oracle: each fixture is
// written, then the terminal is resized through `widths` (same rows), and the
// two screens are diffed after every step.
import { createRequire } from 'node:module'
import type { Terminal as XtermTerminal } from '@xterm/headless'
import { diffSnapshots, type SnapshotDiff } from '../../src/snapshot'
import { TerminalCore } from '../../src/terminal'
import type { Fixture } from '../fixtures/fixtures'
import { snapshotOf } from './xtermOracle'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless')
const { Unicode11Addon } = require('@xterm/addon-unicode11') as typeof import('@xterm/addon-unicode11')

function writeXterm(term: XtermTerminal, data: Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

export async function compareResize(fixture: Fixture, widths: number[]): Promise<{ width: number; diffs: SnapshotDiff[] }[]> {
  const x = new Terminal({ cols: fixture.cols, rows: fixture.rows, scrollback: 10000, allowProposedApi: true })
  x.loadAddon(new Unicode11Addon())
  x.unicode.activeVersion = '11'
  const n = new TerminalCore({ cols: fixture.cols, rows: fixture.rows, scrollback: 10000 })
  for (const chunk of fixture.chunks) {
    await writeXterm(x, chunk)
    n.write(chunk)
  }
  const steps = []
  for (const width of widths) {
    x.resize(width, fixture.rows)
    await writeXterm(x, new Uint8Array())
    n.resize(width, fixture.rows)
    steps.push({ width, diffs: diffSnapshots(snapshotOf(x), n.snapshot()) })
  }
  x.dispose()
  return steps
}
