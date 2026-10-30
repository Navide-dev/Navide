import { describe, expect, it } from 'vitest'
import { FitAddon, SerializeAddon, Terminal, Unicode11Addon } from './xterm.ts'

describe('xterm compatibility layer (headless parts)', () => {
  it('constructs with Navide-style options and keeps defaults for the rest', () => {
    const t = new Terminal({ macOptionClickForcesSelection: true, fontSize: 14, cursorBlink: true, convertEol: false, scrollback: 10000, minimumContrastRatio: 7, allowProposedApi: true })
    expect(t.cols).toBe(80)
    expect(t.rows).toBe(24)
    expect(t.nv.options.fontSize).toBe(14)
    expect(t.nv.options.minimumContrastRatio).toBe(7)
    t.loadAddon(new Unicode11Addon())
    t.unicode.activeVersion = '11'
    expect(t.unicode.activeVersion).toBe('11')
  })

  it('forwards runtime option changes', () => {
    const t = new Terminal({ fontSize: 12 })
    t.options.fontSize = 16
    t.options.cursorBlink = false
    expect(t.nv.options.fontSize).toBe(16)
    expect(t.nv.options.cursorBlink).toBe(false)
    expect(t.options.fontSize).toBe(16)
  })

  it('exposes the buffer the way Navide reads it', () => {
    const t = new Terminal({ cols: 10, rows: 3 })
    t.write('ab中cdefghijk')
    const buf = t.buffer.active
    expect(buf.type).toBe('normal')
    expect(buf.cursorY).toBe(1)
    expect(buf.baseY).toBe(0)
    const line = buf.getLine(0)!
    expect(line.translateToString(true)).toBe('ab中cdefgh')
    expect(line.translateToString(false, 0, 4)).toBe('ab中')
    expect(line.getCell(2)!.getWidth()).toBe(2)
    expect(line.getCell(3)!.getWidth()).toBe(0)
    expect(line.getCell(2)!.getChars()).toBe('中')
    expect(buf.getLine(1)!.isWrapped).toBe(true)
    t.write('\x1b[?1049h')
    expect(t.buffer.active.type).toBe('alternate')
  })

  it('reports modes', () => {
    const t = new Terminal()
    t.write('\x1b[?2004h\x1b[?1002h')
    expect(t.modes.bracketedPasteMode).toBe(true)
    expect(t.modes.mouseTrackingMode).toBe('drag')
  })

  it('serializes through SerializeAddon, with the alternate screen boundary', () => {
    const t = new Terminal({ cols: 10, rows: 3 })
    const serializer = new SerializeAddon()
    t.loadAddon(serializer)
    t.write('hi\x1b[?1049hTUI')
    expect(serializer.serialize({ scrollback: 100, excludeAltBuffer: true })).toBe('hi')
    expect(serializer.serialize({ excludeAltBuffer: false })).toContain('\x1b[?1049h\x1b[H')
  })

  it('mirrors the private shapes Navide uses', () => {
    const t = new Terminal()
    expect(t._core._renderService.dimensions.css.cell.width).toBe(0)
    expect(() => t._core._renderService.clear()).not.toThrow()
    expect(t._core._compositionHelper.isComposing).toBe(false)
    expect(() => t._core._compositionHelper.compositionend()).not.toThrow()
  })

  it('FitAddon is inert before open()', () => {
    const t = new Terminal()
    const fit = new FitAddon()
    t.loadAddon(fit)
    expect(fit.proposeDimensions()).toBeUndefined()
    expect(() => fit.fit()).not.toThrow()
  })

  it('reset() and clear() behave as in xterm.js', () => {
    const t = new Terminal({ cols: 10, rows: 3, scrollback: 100 })
    t.write('1\r\n2\r\n3\r\n4\r\n$ prompt')
    t.clear()
    expect(t.buffer.active.baseY).toBe(0)
    expect(t.buffer.active.getLine(0)!.translateToString(true)).toBe('$ prompt')
    expect(t.buffer.active.cursorY).toBe(0)
    t.reset()
    expect(t.buffer.active.getLine(0)!.translateToString(true)).toBe('')
  })

  it('dispose() disposes addons', () => {
    const t = new Terminal()
    let disposed = 0
    t.loadAddon({ activate() {}, dispose() { disposed++ } })
    t.dispose()
    expect(disposed).toBe(1)
  })
})
