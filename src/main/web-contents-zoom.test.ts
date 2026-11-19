import { describe, expect, it, vi } from 'vitest'
import { lockPageZoom } from './web-contents-zoom'

const FRAME_DISPOSED = 'Render frame was disposed before WebFrameMain could be accessed'

function webContentsStub() {
  const listeners = new Map<string, () => void>()
  return {
    listeners,
    contents: {
      setZoomFactor: vi.fn(),
      setVisualZoomLevelLimits: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener)
      })
    }
  }
}

/** Electron 45 throws from frame-backed calls on a WebContents whose render
 *  frame is not there yet, as `web-contents-created` hands it over. */
function unloadedWebContentsStub() {
  const stub = webContentsStub()
  let loaded = false
  stub.contents.setZoomFactor.mockImplementation(() => {
    if (!loaded) throw new Error(FRAME_DISPOSED)
  })
  stub.contents.setVisualZoomLevelLimits.mockImplementation(() => {
    if (!loaded) throw new Error(FRAME_DISPOSED)
    return Promise.resolve()
  })
  return { ...stub, load: () => (loaded = true) }
}

describe('lockPageZoom', () => {
  it('touches no frame-backed API while the WebContents is being created', () => {
    const { contents } = webContentsStub()

    lockPageZoom(contents as never)

    expect(contents.setZoomFactor).not.toHaveBeenCalled()
    expect(contents.setVisualZoomLevelLimits).not.toHaveBeenCalled()
  })

  it('does not throw for a WebContents whose render frame is not there yet', () => {
    const { contents } = unloadedWebContentsStub()
    const log = vi.fn()

    expect(() => lockPageZoom(contents as never, () => 1, log)).not.toThrow()
  })

  it('still locks zoom once a WebContents created before its frame loads', () => {
    const { contents, listeners, load } = unloadedWebContentsStub()
    lockPageZoom(contents as never, () => 1.25, vi.fn())

    load()
    listeners.get('did-finish-load')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.25)
    expect(contents.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1)
  })

  it('pins the zoom factor as soon as a document commits', () => {
    const { contents, listeners } = webContentsStub()
    lockPageZoom(contents as never, () => 1.25)

    listeners.get('did-navigate')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.25)
  })

  it('logs instead of throwing when a frame-backed call fails', () => {
    const { contents, listeners } = unloadedWebContentsStub()
    const log = vi.fn()
    lockPageZoom(contents as never, () => 1, log)

    expect(() => listeners.get('did-finish-load')?.()).not.toThrow()

    expect(log).toHaveBeenCalledWith(expect.stringContaining(FRAME_DISPOSED))
  })

  it('logs a rejected visual zoom limit instead of leaving it unhandled', async () => {
    const { contents, listeners } = webContentsStub()
    contents.setVisualZoomLevelLimits.mockRejectedValue(new Error(FRAME_DISPOSED))
    const log = vi.fn()
    lockPageZoom(contents as never, () => 1, log)

    listeners.get('did-finish-load')?.()
    await Promise.resolve()

    expect(log).toHaveBeenCalledWith(expect.stringContaining('setVisualZoomLevelLimits'))
  })

  it('resets a retained Chromium zoom factor and disables visual zoom after each load', () => {
    const { contents, listeners } = webContentsStub()
    lockPageZoom(contents as never)

    listeners.get('did-finish-load')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledOnce()
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1)
    expect(contents.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1)
  })

  it('resets page zoom when zoom is requested', () => {
    const { contents, listeners } = webContentsStub()
    lockPageZoom(contents as never)

    listeners.get('zoom-changed')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledOnce()
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1)
  })

  it('pins to the interface scale the app owns, not to 1', () => {
    const { contents, listeners } = webContentsStub()

    lockPageZoom(contents as never, () => 1.25)
    listeners.get('did-finish-load')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.25)
  })

  it('re-reads the scale on each event so a later change reaches an old window', () => {
    const { contents, listeners } = webContentsStub()
    let scale = 1
    lockPageZoom(contents as never, () => scale)
    scale = 1.5

    listeners.get('did-finish-load')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.5)
  })

  it('restores the interface scale after a pinch gesture rather than dropping to 1', () => {
    const { contents, listeners } = webContentsStub()
    lockPageZoom(contents as never, () => 1.1)

    listeners.get('zoom-changed')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.1)
  })

  it('falls back to 1 when the provider yields an unusable factor', () => {
    const { contents, listeners } = webContentsStub()

    lockPageZoom(contents as never, () => Number.NaN)
    listeners.get('did-finish-load')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledWith(1)
  })
})
