import type { ScreenSnapshot } from '../../src/snapshot.ts'
import type { Fixture } from '../fixtures/fixtures.ts'

/** One terminal implementation, reduced to "bytes in, screen out". */
export interface TerminalDriver {
  name: string
  run(fixture: Fixture): Promise<ScreenSnapshot>
}

/** A live terminal for throughput measurement. */
export interface TerminalStream {
  write(chunk: Uint8Array): void
  /** Resolves once everything written so far has been parsed. */
  flush(): Promise<void>
  dispose(): void
}

export type StreamFactory = (cols: number, rows: number) => TerminalStream
