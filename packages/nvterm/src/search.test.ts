import { describe, expect, it } from 'vitest'
import { findAll, findFrom } from './search'
import { TerminalCore } from './terminal'

function buf(text: string, cols = 20, rows = 5, scrollback = 100) {
  const t = new TerminalCore({ cols, rows, scrollback })
  t.write(text)
  return t.active
}

describe('search', () => {
  it('finds plain text, case-insensitive by default', () => {
    expect(findAll(buf('Hello world\r\nhello again'), 'hello')).toEqual([
      { x: 0, y: 0, endX: 5, endY: 0 },
      { x: 0, y: 1, endX: 5, endY: 1 },
    ])
    expect(findAll(buf('Hello hello'), 'hello', { caseSensitive: true })).toEqual([{ x: 6, y: 0, endX: 11, endY: 0 }])
  })

  it('treats regex characters literally unless regex is on', () => {
    expect(findAll(buf('a.c abc'), 'a.c')).toHaveLength(1)
    expect(findAll(buf('a.c abc'), 'a.c', { regex: true })).toHaveLength(2)
    expect(findAll(buf('x'), '(', { regex: true })).toEqual([])
  })

  it('matches across an autowrap', () => {
    const b = buf('0123456789abcdefghWRAPPED', 20)
    expect(findAll(b, 'ghWRAP')).toEqual([{ x: 16, y: 0, endX: 2, endY: 1 }])
  })

  it('maps wide characters to their columns', () => {
    expect(findAll(buf('ab中文cd'), '文c')).toEqual([{ x: 4, y: 0, endX: 7, endY: 0 }])
    expect(findAll(buf('ab中文'), '文')).toEqual([{ x: 4, y: 0, endX: 6, endY: 0 }])
  })

  it('whole word', () => {
    expect(findAll(buf('cat concat cat_x cat.'), 'cat', { wholeWord: true }).map((m) => m.x)).toEqual([0, 17])
  })

  it('searches the scrollback too', () => {
    const b = buf(Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\r\n'), 20, 5)
    expect(findAll(b, 'row 2').map((m) => m.y)).toEqual([2, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
  })

  it('findFrom moves forwards and backwards and wraps around', () => {
    const b = buf('aa x aa x aa')
    expect(findFrom(b, 'aa', { x: 0, y: 0 }, false)).toMatchObject({ x: 5 })
    expect(findFrom(b, 'aa', { x: 10, y: 0 }, false)).toMatchObject({ x: 0 })
    expect(findFrom(b, 'aa', { x: 5, y: 0 }, true)).toMatchObject({ x: 0 })
    expect(findFrom(b, 'aa', { x: 0, y: 0 }, true)).toMatchObject({ x: 10 })
    expect(findFrom(b, 'zz', { x: 0, y: 0 }, false)).toBeUndefined()
  })
})
