// Control sequence parameters. Spec: ECMA-48 5.4.1-5.4.2 (parameter string,
// ';' separates parameters, omitted parameters take the default); ':'
// separates sub-parameters of one parameter (ECMA-48 5.4.2 b, ITU T.416).

/** Parameters and sub-parameters beyond this many are dropped (Williams: "ignore further"). */
export const MAX_ENTRIES = 64
/** A larger value is clamped to this. */
export const MAX_VALUE = 0xffff
/** Marks an omitted parameter. */
export const OMITTED = -1

export class Params {
  /** Every parameter and sub-parameter in order; OMITTED when empty. */
  private readonly values = new Int32Array(MAX_ENTRIES)
  /** 1 when the entry at the same index is a sub-parameter of the parameter before it. */
  private readonly isSub = new Uint8Array(MAX_ENTRIES)
  /** Entry index of each top-level parameter. */
  private readonly top = new Uint8Array(MAX_ENTRIES)
  private entries = 0
  /** Set once a parameter did not fit; everything after it is dropped too. */
  private dropped = false
  /** Number of top-level parameters. A sequence with no parameter characters has 0. */
  length = 0

  reset(): void {
    this.entries = 0
    this.length = 0
    this.dropped = false
  }

  addDigit(digit: number): void {
    if (this.entries === 0) this.push(false)
    if (this.dropped) return
    const i = this.entries - 1
    const prev = this.values[i]!
    this.values[i] = Math.min(MAX_VALUE, (prev === OMITTED ? 0 : prev) * 10 + digit)
  }

  nextParam(): void {
    if (this.entries === 0) this.push(false)
    this.push(false)
  }

  nextSubParam(): void {
    if (this.entries === 0) this.push(false)
    this.push(true)
  }

  /** The i-th top-level parameter, or `fallback` when it is omitted or absent. */
  get(i: number, fallback: number): number {
    if (i >= this.length) return fallback
    const v = this.values[this.top[i]!]!
    return v === OMITTED ? fallback : v
  }

  /** Like get(), but 0 also means "use the default" (ECMA-48 convention for most counts). */
  count(i: number, fallback = 1): number {
    const v = this.get(i, fallback)
    return v === 0 ? fallback : v
  }

  /** Sub-parameters following the i-th top-level parameter (OMITTED for empty ones). */
  sub(i: number): number[] {
    const out: number[] = []
    if (i >= this.length) return out
    for (let e = this.top[i]! + 1; e < this.entries && this.isSub[e] === 1; e++) out.push(this.values[e]!)
    return out
  }

  hasSub(i: number): boolean {
    const e = i < this.length ? this.top[i]! + 1 : this.entries
    return e < this.entries && this.isSub[e] === 1
  }

  /** For tests and debugging: [value, ...subs] per parameter. */
  toArray(): number[][] {
    return Array.from({ length: this.length }, (_, i) => [this.get(i, OMITTED), ...this.sub(i)])
  }

  private push(sub: boolean): void {
    if (this.entries === MAX_ENTRIES) {
      this.dropped = true
      return
    }
    this.values[this.entries] = OMITTED
    this.isSub[this.entries] = sub ? 1 : 0
    if (!sub) this.top[this.length++] = this.entries
    this.entries++
  }
}
