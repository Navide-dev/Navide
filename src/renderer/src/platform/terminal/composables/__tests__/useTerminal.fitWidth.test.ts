// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// "Fit to pane width" is glue between useTerminal and the resize controller's
// cols cap, so the controller (and xterm, which won't boot in happy-dom) are
// mocked and only the delegation is asserted. The cap arithmetic itself lives
// in createResizeController.

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(),
  sendResizeNow: vi.fn(),
  requestResizeRedraw: vi.fn(),
  setColsCap: vi.fn(),
  capCols: vi.fn((cols: number) => cols),
  attachObserver: vi.fn(),
  dispose: vi.fn(),
  ackedCols: 0,
  ackedRows: 0,
}))

// The buffer the mocked terminal is showing; 'alternate' has no scrollback.
const bufferType = vi.hoisted(() => ({ value: 'normal' as 'normal' | 'alternate' }))

vi.mock('../useTerminalResize', () => ({
  createResizeController: () => ctrl,
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    buffer = {
      get active() {
        return { type: bufferType.value, viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined }
      },
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onResize(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onData(): { dispose(): void } {
      return { dispose(): void {} }
    }
    write(): void {}
    writeln(): void {}
    resize(): void {}
    focus(): void {}
    select(): void {}
    clearSelection(): void {}
    hasSelection(): boolean { return false }
    onSelectionChange(_handler: () => void): { dispose: () => void } {
      return { dispose: (): void => {} }
    }
    scrollLines(): void {}
    scrollToBottom(): void {}
    dispose(): void {}
  }
  return { Terminal }
})

// null simulates a hidden pane, which proposes no dimensions.
const fitDims = vi.hoisted(() => ({ value: { cols: 160, rows: 24 } as { cols: number; rows: number } | null }))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } | undefined {
      return fitDims.value ? { ...fitDims.value } : undefined
    }
  },
}))

import { useTerminal } from '../useTerminal'

function mountedTerminal() {
  const mock = createMockBackend()
  const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
  result.mount(document.createElement('div'))
  return { result, scope }
}

describe('useTerminal — fit to pane width', () => {
  afterEach(() => {
    vi.clearAllMocks()
    ctrl.capCols.mockImplementation((cols: number) => cols)
    fitDims.value = { cols: 160, rows: 24 }
    bufferType.value = 'normal'
  })

  it('reads as capped only while the cap leaves part of the container blank', () => {
    const { result, scope } = mountedTerminal()
    expect(result.isColsCapped()).toBe(false) // no cap: capCols is identity
    ctrl.capCols.mockImplementation((cols: number) => Math.min(cols, 80))
    expect(result.isColsCapped()).toBe(true)
    fitDims.value = { cols: 70, rows: 24 } // container narrower than the cap
    expect(result.isColsCapped()).toBe(false)
    scope.stop()
  })

  it('never reads a hidden pane as capped', () => {
    const { result, scope } = mountedTerminal()
    ctrl.capCols.mockImplementation((cols: number) => Math.min(cols, 80))
    fitDims.value = null
    expect(result.isColsCapped()).toBe(false)
    scope.stop()
  })

  it('unlockCols lifts the cap, then fits and arms the gated redraw', () => {
    const { result, scope } = mountedTerminal()
    result.unlockCols()
    expect(ctrl.setColsCap).toHaveBeenCalledWith(null)
    expect(ctrl.applyFit).toHaveBeenCalledTimes(1)
    expect(ctrl.requestResizeRedraw).toHaveBeenCalledTimes(1)
    expect(ctrl.setColsCap.mock.invocationCallOrder[0])
      .toBeLessThan(ctrl.applyFit.mock.invocationCallOrder[0])
    scope.stop()
  })

  // The layout-mode path must stay exactly what it was: lockCols only sets or
  // clears the cap and never fits on its own (App.vue fits after a frame).
  it('leaves lockCols unchanged', () => {
    const { result, scope } = mountedTerminal()
    result.lockCols(true)
    expect(ctrl.setColsCap).toHaveBeenLastCalledWith(80)
    result.lockCols(false)
    expect(ctrl.setColsCap).toHaveBeenLastCalledWith(null)
    expect(ctrl.applyFit).not.toHaveBeenCalled()
    expect(ctrl.requestResizeRedraw).not.toHaveBeenCalled()
    scope.stop()
  })

  // xterm keeps no scrollback for the alternate buffer and never reflows it, so
  // there is nothing for a cap to protect: that pane fills the stage at once.
  it('never caps a pane that is showing its alternate screen', () => {
    bufferType.value = 'alternate'
    const { result, scope } = mountedTerminal()
    result.lockCols(true)
    expect(ctrl.setColsCap).toHaveBeenLastCalledWith(null)
    scope.stop()
  })

  it('clears a stale cap when the pane has since moved to its alternate screen', () => {
    const { result, scope } = mountedTerminal()
    result.lockCols(true)
    expect(ctrl.setColsCap).toHaveBeenLastCalledWith(80)
    bufferType.value = 'alternate'
    result.lockCols(true)
    expect(ctrl.setColsCap).toHaveBeenLastCalledWith(null)
    scope.stop()
  })
})
