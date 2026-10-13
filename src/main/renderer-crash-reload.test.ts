import { describe, expect, it, vi } from 'vitest'
import type { RenderProcessGoneDetails } from 'electron'
import { watchRendererCrashes } from './renderer-crash-reload'

function fakeWindow() {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const win = {
    destroyed: false,
    contentsDestroyed: false,
    isDestroyed: () => win.destroyed,
    webContents: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on: (event: string, listener: (...args: any[]) => void) => { listeners.set(event, listener) },
      isDestroyed: () => win.contentsDestroyed,
      reload: vi.fn(),
    },
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
    gone: (reason: RenderProcessGoneDetails['reason'], exitCode = 9) =>
      win.emit('render-process-gone', {}, { reason, exitCode }),
  }
  return win
}

function setup(overrides: { now?: () => number } = {}) {
  const win = fakeWindow()
  const log = vi.fn()
  watchRendererCrashes(win, { kind: 'main', log, ...overrides })
  return { win, log }
}

describe('watchRendererCrashes', () => {
  it('reloads a window whose renderer was killed and logs why', () => {
    const { win, log } = setup()
    win.gone('killed', 15)
    expect(win.webContents.reload).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('kind=main reason=killed exitCode=15; reloading (1/3)'))
  })

  it('reloads after a crash too', () => {
    const { win } = setup()
    win.gone('crashed')
    expect(win.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload after a clean exit', () => {
    const { win, log } = setup()
    win.gone('clean-exit', 0)
    expect(win.webContents.reload).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reason=clean-exit exitCode=0; not reloading'))
  })

  it('skips the reload when the window is already destroyed', () => {
    const { win, log } = setup()
    win.destroyed = true
    win.gone('killed')
    expect(win.webContents.reload).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('window already destroyed'))
  })

  it('skips the reload when only the web contents are destroyed', () => {
    const { win } = setup()
    win.contentsDestroyed = true
    win.gone('killed')
    expect(win.webContents.reload).not.toHaveBeenCalled()
  })

  it('stops reloading after three crashes inside a minute', () => {
    let t = 0
    const { win, log } = setup({ now: () => t })
    for (let i = 0; i < 4; i++) { win.gone('crashed'); t += 10_000 }
    expect(win.webContents.reload).toHaveBeenCalledTimes(3)
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('reload limit reached'))
  })

  it('reloads again once the earlier crashes fall out of the window', () => {
    let t = 0
    const { win } = setup({ now: () => t })
    for (let i = 0; i < 3; i++) { win.gone('crashed'); t += 1_000 }
    t = 60_000
    win.gone('crashed')
    expect(win.webContents.reload).toHaveBeenCalledTimes(4)
  })

  it('logs unresponsive and responsive', () => {
    const { win, log } = setup()
    win.emit('unresponsive')
    win.emit('responsive')
    expect(log).toHaveBeenCalledWith('[main] renderer unresponsive kind=main')
    expect(log).toHaveBeenCalledWith('[main] renderer responsive again kind=main')
  })
})
