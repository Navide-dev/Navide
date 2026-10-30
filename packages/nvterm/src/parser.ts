// Escape sequence parser. Spec: Paul Williams, "A parser for DEC's
// ANSI-compatible video terminals" (vt100.net/emu/dec_ansi_parser): the
// states, actions and transitions below follow that description. Deviations,
// each a documented terminal convention:
//   - Input is Unicode code points; anything >= U+00A0 prints like GL.
//   - ':' (0x3A) separates sub-parameters (ITU T.416 / ECMA-48 5.4.2 note),
//     as SGR 4:3 and 38:2::r:g:b need, instead of sending CSI to ignore.
//   - BEL (0x07) also ends an OSC string (xterm ctlseqs).
//   - DEL (0x7F) is ignored in ground.
import { Params } from './params.ts'
import { REPLACEMENT, Utf8Decoder } from './utf8.ts'

export const State = {
  Ground: 0,
  Escape: 1,
  EscapeIntermediate: 2,
  CsiEntry: 3,
  CsiParam: 4,
  CsiIntermediate: 5,
  CsiIgnore: 6,
  DcsEntry: 7,
  DcsParam: 8,
  DcsIntermediate: 9,
  DcsPassthrough: 10,
  DcsIgnore: 11,
  OscString: 12,
  SosPmApcString: 13,
} as const
export type State = (typeof State)[keyof typeof State]

export interface ParserHandler {
  /** Printable code points `data[start..end)`; never contains controls. */
  print(data: Uint32Array, start: number, end: number): void
  /** A C0 or C1 control function. */
  execute(code: number): void
  /** `ESC <intermediates> <final>`. */
  escDispatch(intermediates: string, final: number): void
  /** `CSI <prefix> <params> <intermediates> <final>`; prefix is '' or one of '<=>?'. */
  csiDispatch(prefix: string, params: Params, intermediates: string, final: number): void
  /** A complete OSC string (without the introducer and terminator). Dropped if it overflowed. */
  oscDispatch(data: string): void
  dcsHook(prefix: string, params: Params, intermediates: string, final: number): void
  dcsPut(code: number): void
  dcsUnhook(): void
}

export interface ParserOptions {
  /** Longest OSC string kept, in code points. Longer strings are dropped. Default 8 Mi (fits large OSC 52). */
  maxOscLength?: number
}

const isC0Execute = (c: number): boolean => c <= 0x17 || c === 0x19 || (c >= 0x1c && c <= 0x1f)
const isPrintable = (c: number): boolean => (c >= 0x20 && c < 0x7f) || c >= 0xa0

export class Parser {
  state: State = State.Ground as State
  private readonly params = new Params()
  private prefix = ''
  private intermediates = ''
  private osc: number[] = []
  private oscOverflow = false
  private readonly maxOscLength: number
  private readonly decoder = new Utf8Decoder()
  private codePoints = new Uint32Array(4096)

  private readonly handler: ParserHandler

  constructor(handler: ParserHandler, options: ParserOptions = {}) {
    this.handler = handler
    this.maxOscLength = options.maxOscLength ?? 8 * 1024 * 1024
  }

  /** Decodes UTF-8 and parses. A character or sequence cut at the end continues on the next call. */
  parseBytes(bytes: Uint8Array): void {
    if (this.codePoints.length < bytes.length + 1) this.codePoints = new Uint32Array(bytes.length + 1)
    const n = this.decoder.decode(bytes, this.codePoints)
    this.parse(this.codePoints, 0, n)
  }

  parseString(text: string): void {
    const data = Uint32Array.from(text, (ch) => ch.codePointAt(0)!)
    this.parse(data, 0, data.length)
  }

  parse(data: Uint32Array, start: number, end: number): void {
    const h = this.handler
    let i = start
    while (i < end) {
      const c = data[i]!
      // Fast path: a run of printable characters in ground prints as one call.
      if (this.state === State.Ground && isPrintable(c)) {
        let j = i + 1
        while (j < end && isPrintable(data[j]!)) j++
        h.print(data, i, j)
        i = j
        continue
      }
      // Fast path: parameter bytes inside CSI skip the per-byte state switch.
      if ((this.state === State.CsiParam || this.state === State.CsiEntry) && c >= 0x30 && c <= 0x3b) {
        let j = i
        while (j < end) {
          const d = data[j]!
          if (d < 0x30 || d > 0x3b) break
          this.addParam(d)
          j++
        }
        this.state = State.CsiParam
        i = j
        continue
      }
      this.step(c)
      i++
    }
  }

  reset(): void {
    this.transition(State.Ground)
  }

  private step(c: number): void {
    const h = this.handler
    // "Anywhere" transitions (Williams: from every state).
    if (c === 0x1b) return this.transition(State.Escape)
    if (c === 0x18 || c === 0x1a) {
      this.transition(State.Ground)
      return h.execute(c)
    }
    if (c >= 0x80 && c <= 0x9f) {
      switch (c) {
        case 0x90: return this.transition(State.DcsEntry)
        case 0x9b: return this.transition(State.CsiEntry)
        case 0x9c: return this.transition(State.Ground)
        case 0x9d: return this.transition(State.OscString)
        case 0x98: case 0x9e: case 0x9f: return this.transition(State.SosPmApcString)
        default:
          this.transition(State.Ground)
          return h.execute(c)
      }
    }

    switch (this.state) {
      case State.Ground:
        if (isC0Execute(c)) h.execute(c)
        // Printables are handled by the fast path; DEL is ignored.
        return

      case State.Escape:
        if (isC0Execute(c)) return h.execute(c)
        if (c === 0x7f) return
        if (c >= 0x20 && c <= 0x2f) {
          this.intermediates += String.fromCharCode(c)
          this.state = State.EscapeIntermediate
          return
        }
        switch (c) {
          case 0x5b: return this.transition(State.CsiEntry)
          case 0x5d: return this.transition(State.OscString)
          case 0x50: return this.transition(State.DcsEntry)
          case 0x58: case 0x5e: case 0x5f: return this.transition(State.SosPmApcString)
        }
        if (c >= 0x30 && c <= 0x7e) {
          h.escDispatch(this.intermediates, c)
          return this.transition(State.Ground)
        }
        return

      case State.EscapeIntermediate:
        if (isC0Execute(c)) return h.execute(c)
        if (c >= 0x20 && c <= 0x2f) {
          this.intermediates += String.fromCharCode(c)
          return
        }
        if (c >= 0x30 && c <= 0x7e) {
          h.escDispatch(this.intermediates, c)
          return this.transition(State.Ground)
        }
        return

      case State.CsiEntry:
      case State.CsiParam:
        if (isC0Execute(c)) return h.execute(c)
        if (c === 0x7f) return
        if ((c >= 0x30 && c <= 0x39) || c === 0x3b || c === 0x3a) {
          this.addParam(c)
          this.state = State.CsiParam
          return
        }
        if (c >= 0x3c && c <= 0x3f) {
          if (this.state === State.CsiEntry) {
            this.prefix = String.fromCharCode(c)
            this.state = State.CsiParam
          } else {
            this.state = State.CsiIgnore
          }
          return
        }
        if (c >= 0x20 && c <= 0x2f) {
          this.intermediates += String.fromCharCode(c)
          this.state = State.CsiIntermediate
          return
        }
        if (c >= 0x40 && c <= 0x7e) return this.csiDispatch(c)
        return

      case State.CsiIntermediate:
        if (isC0Execute(c)) return h.execute(c)
        if (c >= 0x20 && c <= 0x2f) {
          this.intermediates += String.fromCharCode(c)
          return
        }
        if (c >= 0x30 && c <= 0x3f) {
          this.state = State.CsiIgnore
          return
        }
        if (c >= 0x40 && c <= 0x7e) return this.csiDispatch(c)
        return

      case State.CsiIgnore:
        if (isC0Execute(c)) return h.execute(c)
        if (c >= 0x40 && c <= 0x7e) this.transition(State.Ground)
        return

      case State.DcsEntry:
      case State.DcsParam:
        if (c === 0x7f || c < 0x20) return
        if ((c >= 0x30 && c <= 0x39) || c === 0x3b || c === 0x3a) {
          this.addParam(c)
          this.state = State.DcsParam
          return
        }
        if (c >= 0x3c && c <= 0x3f) {
          if (this.state === State.DcsEntry) {
            this.prefix = String.fromCharCode(c)
            this.state = State.DcsParam
          } else {
            this.state = State.DcsIgnore
          }
          return
        }
        if (c >= 0x20 && c <= 0x2f) {
          this.intermediates += String.fromCharCode(c)
          this.state = State.DcsIntermediate
          return
        }
        if (c >= 0x40 && c <= 0x7e) return this.dcsHook(c)
        return

      case State.DcsIntermediate:
        if (c === 0x7f || c < 0x20) return
        if (c >= 0x20 && c <= 0x2f) {
          this.intermediates += String.fromCharCode(c)
          return
        }
        if (c >= 0x30 && c <= 0x3f) {
          this.state = State.DcsIgnore
          return
        }
        if (c >= 0x40 && c <= 0x7e) return this.dcsHook(c)
        return

      case State.DcsPassthrough:
        if (c !== 0x7f) h.dcsPut(c)
        return

      case State.DcsIgnore:
      case State.SosPmApcString:
        return

      case State.OscString:
        if (c === 0x07) return this.transition(State.Ground)
        if (c < 0x20) return
        if (this.osc.length < this.maxOscLength) this.osc.push(c)
        else this.oscOverflow = true
        return
    }
  }

  private addParam(c: number): void {
    if (c === 0x3b) this.params.nextParam()
    else if (c === 0x3a) this.params.nextSubParam()
    else this.params.addDigit(c - 0x30)
  }

  private csiDispatch(final: number): void {
    this.handler.csiDispatch(this.prefix, this.params, this.intermediates, final)
    this.transition(State.Ground)
  }

  private dcsHook(final: number): void {
    this.handler.dcsHook(this.prefix, this.params, this.intermediates, final)
    this.state = State.DcsPassthrough
  }

  /** Runs the exit action of the current state, then the entry action of `next`. */
  private transition(next: State): void {
    if (this.state === State.OscString) {
      if (!this.oscOverflow) this.handler.oscDispatch(codePointsToString(this.osc))
      this.osc = []
      this.oscOverflow = false
    } else if (this.state === State.DcsPassthrough) {
      this.handler.dcsUnhook()
    }
    this.state = next
    if (next === State.Escape || next === State.CsiEntry || next === State.DcsEntry) {
      this.params.reset()
      this.prefix = ''
      this.intermediates = ''
    }
  }
}

function codePointsToString(codes: number[]): string {
  let out = ''
  for (let i = 0; i < codes.length; i += 8192) {
    out += String.fromCodePoint(...codes.slice(i, i + 8192).map((c) => (c > 0x10ffff ? REPLACEMENT : c)))
  }
  return out
}
