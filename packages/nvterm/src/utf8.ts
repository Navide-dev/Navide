// Streaming UTF-8 decoder. Spec: WHATWG Encoding Standard, "UTF-8 decoder"
// (replacement per maximal subpart), Unicode 15 section 3.9 table 3-7.

export const REPLACEMENT = 0xfffd

export class Utf8Decoder {
  private codePoint = 0
  private needed = 0
  private lower = 0x80
  private upper = 0xbf

  /**
   * Decodes `bytes` into `out` and returns how many code points were written.
   * A sequence cut off at the end of `bytes` is kept and finished by the next
   * call. `out` must hold at least `bytes.length + 1` entries.
   */
  decode(bytes: Uint8Array, out: Uint32Array): number {
    let n = 0
    let i = 0
    const len = bytes.length
    while (i < len) {
      const byte = bytes[i]!
      if (this.needed === 0) {
        if (byte < 0x80) {
          out[n++] = byte
        } else if (byte >= 0xc2 && byte <= 0xdf) {
          this.needed = 1
          this.codePoint = byte & 0x1f
        } else if (byte >= 0xe0 && byte <= 0xef) {
          if (byte === 0xe0) this.lower = 0xa0
          if (byte === 0xed) this.upper = 0x9f
          this.needed = 2
          this.codePoint = byte & 0x0f
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          if (byte === 0xf0) this.lower = 0x90
          if (byte === 0xf4) this.upper = 0x8f
          this.needed = 3
          this.codePoint = byte & 0x07
        } else {
          out[n++] = REPLACEMENT
        }
        i++
        continue
      }
      if (byte < this.lower || byte > this.upper) {
        // The partial sequence is one replacement; this byte starts over.
        this.reset()
        out[n++] = REPLACEMENT
        continue
      }
      this.lower = 0x80
      this.upper = 0xbf
      this.codePoint = (this.codePoint << 6) | (byte & 0x3f)
      i++
      if (--this.needed === 0) {
        out[n++] = this.codePoint
        this.codePoint = 0
      }
    }
    return n
  }

  /** Ends the stream: a pending partial sequence becomes one replacement character. */
  flush(out: Uint32Array): number {
    if (this.needed === 0) return 0
    this.reset()
    out[0] = REPLACEMENT
    return 1
  }

  private reset(): void {
    this.codePoint = 0
    this.needed = 0
    this.lower = 0x80
    this.upper = 0xbf
  }
}
