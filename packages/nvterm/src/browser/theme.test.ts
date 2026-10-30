import { describe, expect, it } from 'vitest'
import { PALETTE, RGB } from '../style.ts'
import { buildPalette, cellColor, contrastRatio, ensureContrast, parseColor, resolveTheme } from './theme.ts'

describe('theme', () => {
  it.each([
    ['#fff', [0xffffff, 1]],
    ['#102030', [0x102030, 1]],
    ['#10203080', [0x102030, 128 / 255]],
    ['rgb(1, 2, 3)', [0x010203, 1]],
    ['rgba(1,2,3,0.5)', [0x010203, 0.5]],
    ['#00000000', [0, 0]],
    ['nonsense', undefined],
  ])('parseColor(%s)', (text, expected) => {
    expect(parseColor(text)).toEqual(expected)
  })

  it('builds the 256-colour palette: system colours, 6x6x6 cube, greys', () => {
    const p = buildPalette({ red: '#ff0000' })
    expect(p[1]).toBe(0xff0000)
    expect(p[16]).toBe(0x000000)
    expect(p[21]).toBe(0x0000ff)
    expect(p[196]).toBe(0xff0000)
    expect(p[231]).toBe(0xffffff)
    expect(p[232]).toBe(0x080808)
    expect(p[255]).toBe(0xeeeeee)
  })

  it('resolves cell colours', () => {
    const colors = resolveTheme({ foreground: '#abcdef' })
    expect(cellColor(0, colors, 0x123456)).toBe(0x123456)
    expect(cellColor(PALETTE | 196, colors, 0)).toBe(0xff0000)
    expect(cellColor(RGB | 0x010203, colors, 0)).toBe(0x010203)
  })

  it('keeps a transparent background alpha', () => {
    expect(resolveTheme({ background: '#00000000' }).backgroundAlpha).toBe(0)
  })

  it('ensureContrast reaches the ratio and leaves good pairs alone', () => {
    expect(ensureContrast(0xffffff, 0x000000, 7)).toBe(0xffffff)
    const adjusted = ensureContrast(0x333333, 0x222222, 7)
    expect(contrastRatio(adjusted, 0x222222)).toBeGreaterThanOrEqual(7)
    const onLight = ensureContrast(0xdddddd, 0xffffff, 4.5)
    expect(contrastRatio(onLight, 0xffffff)).toBeGreaterThanOrEqual(4.5)
    expect(ensureContrast(0x333333, 0x222222, 1)).toBe(0x333333)
  })
})
