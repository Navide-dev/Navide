// Cell width of a code point. Spec: UAX #11; rules and data in widthTable.ts.
import { WIDE, ZERO_WIDTH } from './widthTable.ts'

function inRanges(table: Uint32Array, cp: number): boolean {
  let lo = 0
  let hi = (table.length >> 1) - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cp < table[mid * 2]!) hi = mid - 1
    else if (cp > table[mid * 2 + 1]!) lo = mid + 1
    else return true
  }
  return false
}

const bmpCache = new Uint8Array(0x10000).fill(0xff)

/** 0 (combines with the previous cell), 1 or 2. Controls are never printed and report 0. */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp >= 0x20 && cp < 0x7f) return 1
  if (cp < 0xa0) return 0
  if (cp < 0x10000) {
    const cached = bmpCache[cp]!
    if (cached !== 0xff) return cached as 0 | 1 | 2
    const w = compute(cp)
    bmpCache[cp] = w
    return w
  }
  return compute(cp)
}

function compute(cp: number): 0 | 1 | 2 {
  if (inRanges(ZERO_WIDTH, cp)) return 0
  if (inRanges(WIDE, cp)) return 2
  return 1
}
