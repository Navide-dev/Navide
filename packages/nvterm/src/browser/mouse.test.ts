import { describe, expect, it } from 'vitest'
import { encodeMouse, type MouseReport } from './mouse'

const at = (r: Partial<MouseReport>): MouseReport => ({ action: 'down', button: 0, col: 4, row: 2, x: 40, y: 30, shift: false, alt: false, ctrl: false, ...r })

describe('encodeMouse', () => {
  it('reports nothing without tracking', () => {
    expect(encodeMouse(at({}), 'none', 'sgr')).toBeUndefined()
  })

  it.each([
    ['SGR press', at({}), 'vt200', 'sgr', '\x1b[<0;5;3M'],
    ['SGR release keeps the button', at({ action: 'up', button: 2 }), 'vt200', 'sgr', '\x1b[<2;5;3m'],
    ['SGR modifiers', at({ shift: true, alt: true, ctrl: true }), 'vt200', 'sgr', '\x1b[<28;5;3M'],
    ['SGR wheel up', at({ action: 'wheel', wheel: 'up' }), 'vt200', 'sgr', '\x1b[<64;5;3M'],
    ['SGR wheel down', at({ action: 'wheel', wheel: 'down' }), 'vt200', 'sgr', '\x1b[<65;5;3M'],
    ['SGR drag', at({ action: 'move', button: 0 }), 'drag', 'sgr', '\x1b[<32;5;3M'],
    ['SGR any-event motion without a button', at({ action: 'move', button: -1 }), 'any', 'sgr', '\x1b[<35;5;3M'],
    ['SGR pixels', at({}), 'vt200', 'sgr-pixels', '\x1b[<0;41;31M'],
    ['default press', at({}), 'vt200', 'default', '\x1b[M %#'],
    ['default release is button 3', at({ action: 'up' }), 'vt200', 'default', '\x1b[M#%#'],
    ['urxvt', at({}), 'vt200', 'urxvt', '\x1b[32;5;3M'],
    ['X10 press has no modifiers', at({ shift: true }), 'x10', 'default', '\x1b[M %#'],
  ] as const)('%s', (_name, report, tracking, encoding, expected) => {
    expect(encodeMouse(report, tracking, encoding)).toBe(expected)
  })

  it('filters events by tracking mode', () => {
    expect(encodeMouse(at({ action: 'up' }), 'x10', 'sgr')).toBeUndefined()
    expect(encodeMouse(at({ action: 'move' }), 'vt200', 'sgr')).toBeUndefined()
    expect(encodeMouse(at({ action: 'move', button: -1 }), 'drag', 'sgr')).toBeUndefined()
  })

  it('default encoding cannot express columns past 223', () => {
    expect(encodeMouse(at({ col: 300 }), 'vt200', 'default')).toBeUndefined()
    expect(encodeMouse(at({ col: 300 }), 'vt200', 'sgr')).toBe('\x1b[<0;301;3M')
  })
})
