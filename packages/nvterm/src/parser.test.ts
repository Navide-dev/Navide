import { describe, expect, it } from 'vitest'
import type { Params } from './params'
import { Parser, State, type ParserHandler } from './parser'

type Event = (string | number | number[][])[]

/** Records every handler call; consecutive prints are merged. */
function record(input: string | Uint8Array | (string | Uint8Array)[], options = {}): { events: Event[]; parser: Parser } {
  const events: Event[] = []
  const handler: ParserHandler = {
    print(data, start, end) {
      const text = String.fromCodePoint(...data.subarray(start, end))
      const last = events[events.length - 1]
      if (last?.[0] === 'print') last[1] += text
      else events.push(['print', text])
    },
    execute: (code) => events.push(['execute', code]),
    escDispatch: (intermediates, final) => events.push(['esc', intermediates, String.fromCharCode(final)]),
    csiDispatch: (prefix: string, params: Params, intermediates, final) =>
      events.push(['csi', prefix, params.toArray(), intermediates, String.fromCharCode(final)]),
    oscDispatch: (data) => events.push(['osc', data]),
    dcsHook: (prefix, params, intermediates, final) => events.push(['dcs-hook', prefix, params.toArray(), intermediates, String.fromCharCode(final)]),
    dcsPut: (code) => {
      const last = events[events.length - 1]
      if (last?.[0] === 'dcs-put') last[1] += String.fromCodePoint(code)
      else events.push(['dcs-put', String.fromCodePoint(code)])
    },
    dcsUnhook: () => events.push(['dcs-unhook']),
  }
  const parser = new Parser(handler, options)
  for (const chunk of Array.isArray(input) ? input : [input]) {
    if (typeof chunk === 'string') parser.parseBytes(new TextEncoder().encode(chunk))
    else parser.parseBytes(chunk)
  }
  return { events, parser }
}

const ESC = '\x1b'

describe('Parser: ground', () => {
  it('prints text and executes C0 controls', () => {
    expect(record('ab\r\ncd\x07').events).toEqual([['print', 'ab'], ['execute', 13], ['execute', 10], ['print', 'cd'], ['execute', 7]])
  })

  it('prints non-ASCII text and ignores DEL', () => {
    expect(record('中\x7f文😀').events).toEqual([['print', '中文😀']])
  })

  it('executes C1 controls given as code points', () => {
    // U+0085 NEL, U+0084 IND
    expect(record('a\u0085b\u0084').events).toEqual([['print', 'a'], ['execute', 0x85], ['print', 'b'], ['execute', 0x84]])
  })
})

describe('Parser: ESC', () => {
  it.each([
    [`${ESC}7`, ['esc', '', '7']],
    [`${ESC}M`, ['esc', '', 'M']],
    [`${ESC}(0`, ['esc', '(', '0']],
    [`${ESC}#8`, ['esc', '#', '8']],
    [`${ESC} F`, ['esc', ' ', 'F']],
  ])('%j', (input, expected) => {
    expect(record(input).events).toEqual([expected])
  })

  it('executes C0 controls in the middle of an escape sequence', () => {
    // Williams: C0 in the escape state executes and stays in the escape state.
    expect(record(`${ESC}\n(B`).events).toEqual([['execute', 10], ['esc', '(', 'B']])
    expect(record(`${ESC}(\nB`).events).toEqual([['execute', 10], ['esc', '(', 'B']])
  })

  it('CAN and SUB abort a sequence and are executed', () => {
    expect(record(`${ESC}[1\x18A`).events).toEqual([['execute', 0x18], ['print', 'A']])
    expect(record(`${ESC}(\x1aB`).events).toEqual([['execute', 0x1a], ['print', 'B']])
  })

  it('ESC restarts a sequence in progress', () => {
    expect(record(`${ESC}[1;2${ESC}[3m`).events).toEqual([['csi', '', [[3]], '', 'm']])
  })
})

describe('Parser: CSI', () => {
  it.each([
    [`${ESC}[m`, ['csi', '', [], '', 'm']],
    [`${ESC}[0m`, ['csi', '', [[0]], '', 'm']],
    [`${ESC}[1;31m`, ['csi', '', [[1], [31]], '', 'm']],
    [`${ESC}[;5H`, ['csi', '', [[-1], [5]], '', 'H']],
    [`${ESC}[?1049h`, ['csi', '?', [[1049]], '', 'h']],
    [`${ESC}[?1000;1006h`, ['csi', '?', [[1000], [1006]], '', 'h']],
    [`${ESC}[>c`, ['csi', '>', [], '', 'c']],
    [`${ESC}[2 q`, ['csi', '', [[2]], ' ', 'q']],
    [`${ESC}[!p`, ['csi', '', [], '!', 'p']],
    [`${ESC}[4:3m`, ['csi', '', [[4, 3]], '', 'm']],
    [`${ESC}[38:2::10:20:30m`, ['csi', '', [[38, 2, -1, 10, 20, 30]], '', 'm']],
    [`${ESC}[38;2;10;20;30m`, ['csi', '', [[38], [2], [10], [20], [30]], '', 'm']],
    [`\u009b5A`, ['csi', '', [[5]], '', 'A']],
  ])('%j', (input, expected) => {
    expect(record(input).events).toEqual([expected])
  })

  it('a private marker after a parameter sends the sequence to csi_ignore', () => {
    expect(record(`${ESC}[1?2hX`).events).toEqual([['print', 'X']])
  })

  it('a parameter byte after an intermediate sends the sequence to csi_ignore', () => {
    expect(record(`${ESC}[ 1qX`).events).toEqual([['print', 'X']])
  })

  it('executes C0 controls inside CSI without breaking it', () => {
    expect(record(`${ESC}[1\r;2H`).events).toEqual([['execute', 13], ['csi', '', [[1], [2]], '', 'H']])
  })

  it('parses a sequence split across every possible chunk boundary', () => {
    const seq = `${ESC}[?1;22;333h`
    for (let cut = 1; cut < seq.length; cut++) {
      expect(record([seq.slice(0, cut), seq.slice(cut)]).events, `cut ${cut}`).toEqual([['csi', '?', [[1], [22], [333]], '', 'h']])
    }
  })
})

describe('Parser: OSC', () => {
  it('terminates with BEL, ST (ESC \\) and C1 ST', () => {
    expect(record(`${ESC}]0;title${'\x07'}`).events).toEqual([['osc', '0;title']])
    expect(record(`${ESC}]2;title${ESC}\\x`).events).toEqual([['osc', '2;title'], ['esc', '', '\\'], ['print', 'x']])
    expect(record(`${ESC}]2;t\u009c`).events).toEqual([['osc', '2;t']])
  })

  it('keeps non-ASCII text and ignores C0 controls inside', () => {
    expect(record(`${ESC}]2;中\n文\x07`).events).toEqual([['osc', '2;中文']])
  })

  it('carries OSC 8 and OSC 52 payloads intact', () => {
    expect(record(`${ESC}]8;id=1;https://e.com/a?b=c${ESC}\\`).events[0]).toEqual(['osc', '8;id=1;https://e.com/a?b=c'])
    expect(record(`${ESC}]52;c;aGVsbG8=\x07`).events).toEqual([['osc', '52;c;aGVsbG8=']])
  })

  it('drops an OSC string longer than the limit', () => {
    expect(record(`${ESC}]2;${'x'.repeat(20)}\x07ok`, { maxOscLength: 10 }).events).toEqual([['print', 'ok']])
  })

  it('CAN aborts an OSC string (exit action still runs)', () => {
    const { events, parser } = record(`${ESC}]2;abc\x18`)
    expect(events).toEqual([['osc', '2;abc'], ['execute', 0x18]])
    expect(parser.state).toBe(State.Ground)
  })
})

describe('Parser: DCS, SOS/PM/APC', () => {
  it('hooks, passes data through and unhooks on ST', () => {
    expect(record(`${ESC}P1$qm${ESC}\\`).events).toEqual([
      ['dcs-hook', '', [[1]], '$', 'q'], ['dcs-put', 'm'], ['dcs-unhook'], ['esc', '', '\\'],
    ])
  })

  it('ignores a malformed DCS until ST', () => {
    expect(record(`${ESC}P1?2qdata${ESC}\\x`).events).toEqual([['esc', '', '\\'], ['print', 'x']])
  })

  it('swallows SOS, PM and APC strings', () => {
    expect(record(`a${ESC}_apc data${ESC}\\b${ESC}^pm${ESC}\\c${ESC}Xsos${ESC}\\d`).events.filter((e) => e[0] === 'print'))
      .toEqual([['print', 'a'], ['print', 'b'], ['print', 'c'], ['print', 'd']])
  })
})
