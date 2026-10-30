import { describe, expect, it } from 'vitest'
import { encodeKey, type KeyInput, type KeyOptions } from './keyboard.ts'

const base: KeyOptions = { applicationCursorKeys: false, applicationKeypad: false, isMac: false, macOptionIsMeta: false }
function key(k: string, mods: Partial<KeyInput> = {}, opts: Partial<KeyOptions> = {}): string | undefined {
  return encodeKey({ key: k, code: mods.code ?? '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }, { ...base, ...opts })
}

describe('encodeKey', () => {
  it.each([
    ['ArrowUp', {}, {}, '\x1b[A'],
    ['ArrowDown', {}, {}, '\x1b[B'],
    ['ArrowRight', {}, {}, '\x1b[C'],
    ['ArrowLeft', {}, {}, '\x1b[D'],
    ['Home', {}, {}, '\x1b[H'],
    ['End', {}, {}, '\x1b[F'],
    ['ArrowUp', {}, { applicationCursorKeys: true }, '\x1bOA'],
    ['End', {}, { applicationCursorKeys: true }, '\x1bOF'],
    ['ArrowUp', { shiftKey: true }, {}, '\x1b[1;2A'],
    ['ArrowLeft', { ctrlKey: true }, {}, '\x1b[1;5D'],
    ['ArrowRight', { altKey: true }, {}, '\x1b[1;3C'],
    ['ArrowRight', { ctrlKey: true, shiftKey: true }, { applicationCursorKeys: true }, '\x1b[1;6C'],
    ['Insert', {}, {}, '\x1b[2~'],
    ['Delete', {}, {}, '\x1b[3~'],
    ['PageUp', {}, {}, '\x1b[5~'],
    ['PageDown', { shiftKey: true }, {}, '\x1b[6;2~'],
    ['F1', {}, {}, '\x1bOP'],
    ['F4', {}, {}, '\x1bOS'],
    ['F1', { shiftKey: true }, {}, '\x1b[1;2P'],
    ['F5', {}, {}, '\x1b[15~'],
    ['F12', { ctrlKey: true }, {}, '\x1b[24;5~'],
    ['Enter', {}, {}, '\r'],
    ['Enter', { altKey: true }, {}, '\x1b\r'],
    ['Escape', {}, {}, '\x1b'],
    ['Tab', {}, {}, '\t'],
    ['Tab', { shiftKey: true }, {}, '\x1b[Z'],
    ['Backspace', {}, {}, '\x7f'],
    ['Backspace', { ctrlKey: true }, {}, '\x08'],
    ['Backspace', { altKey: true }, {}, '\x1b\x7f'],
    ['a', { ctrlKey: true }, {}, '\x01'],
    ['C', { ctrlKey: true, shiftKey: true }, {}, '\x03'],
    ['[', { ctrlKey: true }, {}, '\x1b'],
    [' ', { ctrlKey: true }, {}, '\x00'],
    ['/', { ctrlKey: true }, {}, '\x1f'],
    ['a', { altKey: true }, {}, '\x1ba'],
    ['a', { ctrlKey: true, altKey: true }, {}, '\x1b\x01'],
  ])('%s %j %j', (k, mods, opts, expected) => {
    expect(key(k, mods, opts)).toBe(expected)
  })

  it('leaves plain characters to the input element', () => {
    expect(key('a')).toBeUndefined()
    expect(key('中')).toBeUndefined()
    expect(key('A', { shiftKey: true })).toBeUndefined()
  })

  it('leaves Cmd shortcuts to the host', () => {
    expect(key('c', { metaKey: true })).toBeUndefined()
    expect(key('ArrowUp', { metaKey: true })).toBeUndefined()
  })

  it('on macOS, Option composes text unless macOptionIsMeta', () => {
    expect(key('å', { altKey: true }, { isMac: true })).toBeUndefined()
    expect(key('a', { altKey: true }, { isMac: true, macOptionIsMeta: true })).toBe('\x1ba')
    expect(key('ArrowLeft', { altKey: true }, { isMac: true })).toBe('\x1b[D')
  })

  it('application keypad mode sends SS3 for keypad keys', () => {
    expect(key('1', { code: 'Numpad1' }, { applicationKeypad: true })).toBe('\x1bOq')
    expect(key('Enter', { code: 'NumpadEnter' }, { applicationKeypad: true })).toBe('\x1bOM')
    expect(key('1', { code: 'Numpad1' })).toBeUndefined()
  })
})
