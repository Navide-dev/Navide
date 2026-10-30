import { describe, expect, it } from 'vitest'
import { MAX_ENTRIES, MAX_VALUE, OMITTED, Params } from './params.ts'

function parse(text: string): Params {
  const p = new Params()
  for (const ch of text) {
    if (ch === ';') p.nextParam()
    else if (ch === ':') p.nextSubParam()
    else p.addDigit(Number(ch))
  }
  return p
}

describe('Params', () => {
  it('has no parameters for an empty string', () => {
    expect(parse('').length).toBe(0)
    expect(parse('').get(0, 7)).toBe(7)
  })

  it('treats empty positions as omitted', () => {
    expect(parse(';5;').toArray()).toEqual([[OMITTED], [5], [OMITTED]])
    expect(parse(';5').get(0, 1)).toBe(1)
  })

  it('count() maps both omitted and 0 to the default', () => {
    expect(parse('0;3').count(0)).toBe(1)
    expect(parse('0;3').count(1)).toBe(3)
    expect(parse('').count(0, 4)).toBe(4)
  })

  it('collects colon sub-parameters, including empty ones', () => {
    const p = parse('38:2::10:20:30;4:3;1')
    expect(p.length).toBe(3)
    expect(p.toArray()).toEqual([[38, 2, OMITTED, 10, 20, 30], [4, 3], [1]])
    expect(p.hasSub(0)).toBe(true)
    expect(p.hasSub(2)).toBe(false)
  })

  it('clamps large values', () => {
    expect(parse('99999999').get(0, 0)).toBe(MAX_VALUE)
  })

  it('drops parameters past the limit without disturbing the kept ones', () => {
    const p = parse(Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => String(i + 1)).join(';'))
    expect(p.length).toBe(MAX_ENTRIES)
    expect(p.get(MAX_ENTRIES - 1, 0)).toBe(MAX_ENTRIES)
  })

  it('reset() clears everything', () => {
    const p = parse('1;2;3')
    p.reset()
    expect(p.length).toBe(0)
  })
})
