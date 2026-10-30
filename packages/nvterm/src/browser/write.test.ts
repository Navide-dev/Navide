import { describe, expect, it } from 'vitest'
import { NvTerminal } from './nvterminal'

const big = (lines: number, tag: string): string => Array.from({ length: lines }, (_, i) => `${tag} ${i} ${'中文'.repeat(20)}`).join('\r\n')

describe('NvTerminal.write slicing', () => {
  it('parses small writes immediately', () => {
    const t = new NvTerminal({ cols: 20, rows: 3 })
    t.write('abc')
    expect(t.core.active.line(0).chars(2)).toBe('c')
  })

  it('parses a large write in slices and calls back once all of it is parsed', async () => {
    const t = new NvTerminal({ cols: 120, rows: 10, scrollback: 50000 })
    const text = big(8000, 'row') // ~1.2 MB of UTF-8
    let done = false
    await new Promise<void>((resolve) => t.write(text, () => { done = true; resolve() }))
    expect(done).toBe(true)
    expect(t.core.active.scrollbackLength).toBe(8000 - 10)
    expect(t.core.active.line(9).chars(0)).toBe('r')
  })

  it('keeps writes and callbacks in order when a small write follows a large one', async () => {
    const t = new NvTerminal({ cols: 120, rows: 5, scrollback: 50000 })
    const order: string[] = []
    t.write(big(6000, 'a'), () => order.push('big'))
    t.write('\r\nTAIL', () => order.push('small'))
    await new Promise<void>((resolve) => t.write('', () => { order.push('barrier'); resolve() }))
    expect(order).toEqual(['big', 'small', 'barrier'])
    // Whether or not the large write needed more than one slice on this machine, the small one
    // must land after all of it: TAIL on the last row, right below the large write's last line.
    const text = (row: number) => Array.from({ length: 8 }, (_, x) => t.core.active.line(row).chars(x) || ' ').join('').trimEnd()
    expect(text(4)).toBe('TAIL')
    expect(text(3)).toBe('a 5999 中')
  })

  it('a character split across slices is decoded correctly', async () => {
    const t = new NvTerminal({ cols: 200, rows: 3, scrollback: 100 })
    const bytes = new TextEncoder().encode('中'.repeat(100_000))
    await new Promise<void>((resolve) => t.write(bytes, resolve))
    const line = t.core.active.line(2)
    for (let x = 0; x < 200; x += 2) expect(line.chars(x)).toBe('中')
  })

  it('stops parsing after dispose', async () => {
    const t = new NvTerminal({ cols: 80, rows: 5 })
    let called = false
    t.write(big(6000, 'x'), () => { called = true })
    t.dispose()
    await new Promise((r) => setTimeout(r, 50))
    expect(called).toBe(false)
  })
})
