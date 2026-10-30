import { describe, expect, it } from 'vitest'
import { TerminalCore } from '../terminal.ts'
import { Selection } from './selection.ts'

function setup(text: string, cols = 10, rows = 4, scrollback = 100) {
  const core = new TerminalCore({ cols, rows, scrollback })
  core.write(text)
  const sel = new Selection(() => core.active)
  const id = (absRow: number) => core.active.dropped + absRow
  return { core, sel, id }
}

describe('Selection', () => {
  it('is inactive until it spans something', () => {
    const { sel, id } = setup('hello')
    expect(sel.active).toBe(false)
    sel.start({ x: 1, y: id(0) }, 'char')
    expect(sel.active).toBe(false)
    sel.extend({ x: 4, y: id(0) })
    expect(sel.text()).toBe('ell')
  })

  it('works backwards too', () => {
    const { sel, id } = setup('hello')
    sel.start({ x: 4, y: id(0) }, 'char')
    sel.extend({ x: 1, y: id(0) })
    expect(sel.text()).toBe('ell')
  })

  it('joins wrapped lines without a newline and trims line ends', () => {
    const { sel, id } = setup('abcdefghijklm\r\nnext   ', 10, 4)
    sel.start({ x: 0, y: id(0) }, 'char')
    sel.extend({ x: 10, y: id(2) })
    expect(sel.text()).toBe('abcdefghijklm\nnext')
  })

  it('copies wide characters once', () => {
    const { sel, id } = setup('中文 abc')
    sel.start({ x: 0, y: id(0) }, 'char')
    sel.extend({ x: 10, y: id(0) })
    expect(sel.text()).toBe('中文 abc')
  })

  it('word mode expands to word boundaries', () => {
    const { sel, id } = setup('foo bar.baz qux', 20)
    sel.start({ x: 6, y: id(0) }, 'word')
    sel.extend({ x: 6, y: id(0) })
    expect(sel.text()).toBe('bar.baz')
  })

  it('line mode takes the whole logical line', () => {
    const { sel, id } = setup('abcdefghijklm\r\nnext', 10, 4)
    sel.start({ x: 3, y: id(1) }, 'line')
    expect(sel.text()).toBe('abcdefghijklm')
  })

  it('select(col, row, len) and selectAll', () => {
    const { sel } = setup('hello\r\nworld')
    sel.select(1, 0, 3)
    expect(sel.text()).toBe('ell')
    sel.selectAll()
    expect(sel.text()).toBe('hello\nworld')
  })

  it('stays on the same text while output scrolls, until that text is dropped', () => {
    const { core, sel, id } = setup('keep me', 10, 2, 3)
    sel.start({ x: 0, y: id(0) }, 'char')
    sel.extend({ x: 7, y: id(0) })
    core.write('\r\n1\r\n2')
    expect(sel.text()).toBe('keep me')
    core.write('\r\n3\r\n4\r\n5\r\n6')
    expect(sel.range()).toBeNull()
    expect(sel.text()).toBe('')
  })

  it('contains() follows the normalized range', () => {
    const { sel, id } = setup('abcdef')
    sel.start({ x: 4, y: id(0) }, 'char')
    sel.extend({ x: 1, y: id(0) })
    expect([0, 1, 2, 3, 4].map((x) => sel.contains(x, id(0)))).toEqual([false, true, true, true, false])
  })
})
