import { describe, expect, it } from 'vitest'
import { charWidth } from './width'
import { UNICODE_VERSION } from './widthTable'

const cp = (s: string): number => s.codePointAt(0)!

describe('charWidth (Unicode 11 tables)', () => {
  it('is generated from Unicode 11.0.0', () => {
    expect(UNICODE_VERSION).toBe('11.0.0')
  })

  it.each([
    ['ASCII letter', 'a', 1],
    ['space', ' ', 1],
    ['Latin-1 é', 'é', 1],
    ['Greek α', 'α', 1],
    ['Cyrillic Ж', 'Ж', 1],
    ['box drawing ─', '─', 1],
    ['ambiguous ° (EAW A is narrow)', '°', 1],
    ['ambiguous ← (EAW A is narrow)', '←', 1],
    ['CJK ideograph 中', '中', 2],
    ['CJK extension A 㐀', '㐀', 2],
    ['CJK extension B 𠀀', '𠀀', 2],
    ['Hiragana あ', 'あ', 2],
    ['Katakana ア', 'ア', 2],
    ['halfwidth katakana ｱ', 'ｱ', 1],
    ['fullwidth Ａ', 'Ａ', 2],
    ['fullwidth comma ，', '，', 2],
    ['ideographic space', '　', 2],
    ['Hangul syllable 한', '한', 2],
    ['Hangul leading jamo ᄀ', 'ᄀ', 2],
    ['Hangul medial jamo (combines)', 'ᅡ', 0],
    ['emoji 😀', '😀', 2],
    ['emoji 🚀', '🚀', 2],
    ['emoji ✅ (presentation W)', '✅', 2],
    ['heart ❤ (text presentation, narrow)', '❤', 1],
    ['skin tone modifier', '\u{1F3FD}', 2],
    ['regional indicator (EAW N)', '\u{1F1F9}', 1],
    ['combining acute', '́', 0],
    ['combining enclosing keycap', '⃣', 0],
    ['Devanagari vowel sign i (Mc is not zero)', 'ि', 1],
    ['Devanagari virama (Mn)', '्', 0],
    ['ZWJ', '‍', 0],
    ['ZWSP', '​', 0],
    ['VS16', '️', 0],
    ['soft hyphen keeps a cell', '­', 1],
    ['Arabic number sign keeps a cell', '؀', 1],
    ['BOM / ZWNBSP', '﻿', 0],
    ['C1 control', '\u0085', 0],
    ['DEL', '\u007f', 0],
    ['unassigned CJK block code point defaults wide', '鿾', 2],
  ])('%s', (_name, ch, width) => {
    expect(charWidth(cp(ch))).toBe(width)
  })

  it('caches BMP lookups without changing answers', () => {
    expect(charWidth(cp('中'))).toBe(2)
    expect(charWidth(cp('中'))).toBe(2)
    expect(charWidth(cp('́'))).toBe(0)
  })
})
