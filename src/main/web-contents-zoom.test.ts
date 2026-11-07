import { describe, expect, it, vi } from 'vitest'
import { lockPageZoom } from './web-contents-zoom'

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

describe('lockPageZoom', () => {
  it('resets page zoom immediately and disables visual zoom', () => {
    const { contents } = webContentsStub()

    lockPageZoom(contents as never)

    expect(contents.setZoomFactor).toHaveBeenCalledWith(1)
    expect(contents.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1)
  })

  it('resets a retained Chromium zoom factor after each load', () => {
    const { contents, listeners } = webContentsStub()
    lockPageZoom(contents as never)
    contents.setZoomFactor.mockClear()

    listeners.get('did-finish-load')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledOnce()
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1)
  })

  it('resets page zoom when zoom is requested', () => {
    const { contents, listeners } = webContentsStub()
    lockPageZoom(contents as never)
    contents.setZoomFactor.mockClear()

    listeners.get('zoom-changed')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledOnce()
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1)
  })

  it('pins to the interface scale the app owns, not to 1', () => {
    const { contents } = webContentsStub()

    lockPageZoom(contents as never, () => 1.25)

    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.25)
  })

  it('re-reads the scale on each event so a later change reaches an old window', () => {
    const { contents, listeners } = webContentsStub()
    let scale = 1
    lockPageZoom(contents as never, () => scale)
    scale = 1.5
    contents.setZoomFactor.mockClear()

    listeners.get('did-finish-load')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.5)
  })

  it('restores the interface scale after a pinch gesture rather than dropping to 1', () => {
    const { contents, listeners } = webContentsStub()
    lockPageZoom(contents as never, () => 1.1)
    contents.setZoomFactor.mockClear()

    listeners.get('zoom-changed')?.()

    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.1)
  })

  it('falls back to 1 when the provider yields an unusable factor', () => {
    const { contents } = webContentsStub()

    lockPageZoom(contents as never, () => Number.NaN)

    expect(contents.setZoomFactor).toHaveBeenCalledWith(1)
  })
})
