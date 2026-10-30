import { describe, expect, it } from 'vitest'
import { fixtures } from './fixtures.ts'

describe('fixtures', () => {
  it('has at least 30 fixtures with unique kebab-case ids', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30)
    const ids = fixtures.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('every fixture has bytes and a sane size', () => {
    for (const f of fixtures) {
      expect(f.chunks.length, f.id).toBeGreaterThan(0)
      expect(f.chunks.reduce((n, c) => n + c.length, 0), f.id).toBeGreaterThan(0)
      expect(f.cols, f.id).toBeGreaterThanOrEqual(20)
      expect(f.rows, f.id).toBeGreaterThanOrEqual(5)
    }
  })

  it('the split fixtures really split multi-byte characters and escape sequences', () => {
    const utf8 = fixtures.find((f) => f.id === 'utf8-split-chunks')!
    // A chunk starting with a UTF-8 continuation byte (10xxxxxx) proves a split mid-character.
    expect(utf8.chunks.some((c) => (c[0]! & 0xc0) === 0x80)).toBe(true)
    const esc = fixtures.find((f) => f.id === 'escape-split-chunks')!
    expect(esc.chunks.some((c) => c[c.length - 1] === 0x1b)).toBe(true)
  })
})
