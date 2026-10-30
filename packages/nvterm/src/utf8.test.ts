import { describe, expect, it } from 'vitest'
import { REPLACEMENT, Utf8Decoder } from './utf8.ts'

function decodeChunks(...chunks: number[][]): number[] {
  const decoder = new Utf8Decoder()
  const out: number[] = []
  for (const chunk of chunks) {
    const buf = new Uint32Array(chunk.length + 1)
    out.push(...buf.subarray(0, decoder.decode(Uint8Array.from(chunk), buf)))
  }
  const tail = new Uint32Array(1)
  out.push(...tail.subarray(0, decoder.flush(tail)))
  return out
}

const bytes = (s: string): number[] => [...new TextEncoder().encode(s)]
const cps = (s: string): number[] => Array.from(s, (c) => c.codePointAt(0)!)
const R = REPLACEMENT

describe('Utf8Decoder', () => {
  it('decodes 1- to 4-byte sequences', () => {
    expect(decodeChunks(bytes('aé中😀'))).toEqual(cps('aé中😀'))
  })

  it('finishes a sequence split at any byte boundary', () => {
    const all = bytes('é中😀')
    for (let cut = 1; cut < all.length; cut++) {
      expect(decodeChunks(all.slice(0, cut), all.slice(cut)), `cut ${cut}`).toEqual(cps('é中😀'))
    }
  })

  it('decodes a stream fed one byte at a time', () => {
    const all = bytes('mixed 中文 😀 text')
    expect(decodeChunks(...all.map((b) => [b]))).toEqual(cps('mixed 中文 😀 text'))
  })

  // WHATWG: one replacement per maximal subpart, the offending byte is reprocessed.
  it.each([
    ['lone continuation byte', [0x80], [R]],
    ['invalid lead bytes C0, C1, F5, FF', [0xc0, 0xc1, 0xf5, 0xff], [R, R, R, R]],
    ['truncated 3-byte then ASCII', [0xe4, 0xb8, 0x41], [R, 0x41]],
    ['overlong 3-byte (E0 80)', [0xe0, 0x80, 0x80], [R, R, R]],
    ['surrogate (ED A0 80)', [0xed, 0xa0, 0x80], [R, R, R]],
    ['above U+10FFFF (F4 90)', [0xf4, 0x90, 0x80, 0x80], [R, R, R, R]],
    ['truncated 4-byte at end of stream', [0xf0, 0x9f, 0x98], [R]],
    ['highest valid code point', [0xf4, 0x8f, 0xbf, 0xbf], [0x10ffff]],
  ])('%s', (_name, input, expected) => {
    expect(decodeChunks(input)).toEqual(expected)
  })
})
