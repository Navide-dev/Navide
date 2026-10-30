import { TerminalCore } from '../../src/terminal.ts'
import type { TerminalDriver, TerminalStream } from './driver.ts'

export const nvtermDriver: TerminalDriver = {
  name: 'nvterm',
  async run(fixture) {
    const term = new TerminalCore({ cols: fixture.cols, rows: fixture.rows, scrollback: 10000 })
    for (const chunk of fixture.chunks) term.write(chunk)
    return term.snapshot()
  },
}

export function createNvtermStream(cols: number, rows: number): TerminalStream {
  const term = new TerminalCore({ cols, rows, scrollback: 10000 })
  return {
    write: (chunk) => term.write(chunk),
    flush: async () => {},
    dispose: () => {},
  }
}
