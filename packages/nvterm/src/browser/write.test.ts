import { afterEach, describe, expect, it, vi } from 'vitest'
import { NvTerminal } from './nvterminal'

const big = (lines: number, tag: string): string => Array.from({ length: lines }, (_, i) => `${tag} ${i} ${'中文'.repeat(20)}`).join('\r\n')

// One 64 KiB slice per task, whatever the machine speed: a large write is then
// always still in progress after write() returns, and the tests below do not
// depend on how fast the runner parses.
const oneSlicePerTask = { sliceBytes: 64 * 1024, slicesPerTask: 1 }

/** Runs queued slices (each scheduled with setTimeout 0) until the write queue is empty. */
async function drainAll(): Promise<void> {
  await vi.runAllTimersAsync()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('NvTerminal.write slicing', () => {
  it('parses small writes immediately', () => {
    const t = new NvTerminal({ cols: 20, rows: 3 })
    t.write('abc')
    expect(t.core.active.line(0).chars(2)).toBe('c')
  })

  it('parses a large write in slices and calls back once all of it is parsed', async () => {
    vi.useFakeTimers()
    const t = new NvTerminal({ cols: 120, rows: 10, scrollback: 50000, writeSlicing: oneSlicePerTask })
    const text = big(8000, 'row') // ~1 MB of UTF-8: well over one slice
    let done = false
    t.write(text, () => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    expect(t.core.active.scrollbackLength).toBeLessThan(8000 - 10) // only the first slice so far
    await drainAll()
    expect(done).toBe(true)
    expect(t.core.active.scrollbackLength).toBe(8000 - 10)
    expect(t.core.active.line(9).chars(0)).toBe('r')
  })

  it('keeps writes and callbacks in order when a small write follows a large one', async () => {
    vi.useFakeTimers()
    const t = new NvTerminal({ cols: 120, rows: 5, scrollback: 50000, writeSlicing: oneSlicePerTask })
    const order: string[] = []
    t.write(big(6000, 'a'), () => order.push('big'))
    t.write('\r\nTAIL', () => order.push('small'))
    // The large write is still in progress, so the small one has not been parsed ahead of it.
    expect(t.core.active.line(4).chars(0)).not.toBe('T')
    t.write('', () => order.push('barrier'))
    await drainAll()
    expect(order).toEqual(['big', 'small', 'barrier'])
    const text = (row: number) => Array.from({ length: 8 }, (_, x) => t.core.active.line(row).chars(x) || ' ').join('').trimEnd()
    expect(text(4)).toBe('TAIL')
    expect(text(3)).toBe('a 5999 中')
  })

  it('a character split across slices is decoded correctly', async () => {
    vi.useFakeTimers()
    const t = new NvTerminal({ cols: 200, rows: 3, scrollback: 100, writeSlicing: { sliceBytes: 1001, slicesPerTask: 1 } })
    // 1001-byte slices cut through the 3-byte characters at varying offsets.
    const bytes = new TextEncoder().encode('中'.repeat(100_000))
    let done = false
    t.write(bytes, () => { done = true })
    await drainAll()
    expect(done).toBe(true)
    const line = t.core.active.line(2)
    for (let x = 0; x < 200; x += 2) expect(line.chars(x)).toBe('中')
  })

  it('stops parsing after dispose', async () => {
    vi.useFakeTimers()
    const t = new NvTerminal({ cols: 80, rows: 5, writeSlicing: oneSlicePerTask })
    let called = false
    t.write(big(6000, 'x'), () => { called = true })
    // Still in progress by construction (one slice per task); dispose mid-write.
    t.dispose()
    await drainAll()
    expect(called).toBe(false)
  })

  it('the default slicing is unchanged: 256 KiB parse at once', () => {
    const t = new NvTerminal({ cols: 80, rows: 5 })
    const text = 'y'.repeat(200 * 1024)
    t.write(text)
    expect(t.core.active.line(4).chars(0)).toBe('y')
  })
})
