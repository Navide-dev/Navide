import { afterEach, describe, expect, it, vi } from 'vitest'
import { platformId, setPlatformId, type PlatformId } from '../shared/osplat'
import { guardLastWindowClose, lastWindowCloseNeedsPrompt, type LastWindowCloseDeps } from './last-window-close'

const BASELINE = platformId()

const base = { mac: false, confirmEnabled: true, quitConfirmed: false, promptOpen: false, liveWindows: 1 }

describe('lastWindowCloseNeedsPrompt', () => {
  it('prompts when the last window closes on a platform where that quits the app', () => {
    expect(lastWindowCloseNeedsPrompt(base)).toBe(true)
  })

  it('never prompts on macOS, where closing a window does not quit', () => {
    expect(lastWindowCloseNeedsPrompt({ ...base, mac: true })).toBe(false)
  })

  it('lets a non-last window close without asking', () => {
    expect(lastWindowCloseNeedsPrompt({ ...base, liveWindows: 2 })).toBe(false)
  })

  it('stays out of the way once the user disabled the confirmation', () => {
    expect(lastWindowCloseNeedsPrompt({ ...base, confirmEnabled: false })).toBe(false)
  })

  it('does not ask again while app.quit() is closing the windows of a confirmed quit', () => {
    expect(lastWindowCloseNeedsPrompt({ ...base, quitConfirmed: true })).toBe(false)
  })

  it('keeps vetoing the close while the dialog is already open', () => {
    expect(lastWindowCloseNeedsPrompt({ ...base, promptOpen: true, liveWindows: 2 })).toBe(true)
  })
})

// The regression this pins: on Ubuntu, close the last window → "Quit?" →
// Cancel → the window was already gone and the app kept running headless.
describe('guardLastWindowClose', () => {
  afterEach(() => { setPlatformId(BASELINE) })

  function deps(overrides: Partial<Omit<LastWindowCloseDeps, 'quit'>> = {}): LastWindowCloseDeps & { quit: ReturnType<typeof vi.fn> } {
    return {
      liveWindows: () => 1,
      confirmEnabled: () => true,
      quitConfirmed: () => false,
      promptOpen: () => false,
      ask: () => Promise.resolve(false),
      ...overrides,
      quit: vi.fn(),
    }
  }

  for (const platform of ['linux', 'win32'] as PlatformId[]) {
    it(`${platform}: Cancel vetoes the close, so the window survives and nothing quits`, async () => {
      setPlatformId(platform)
      const e = { preventDefault: vi.fn() }
      const d = deps()
      expect(guardLastWindowClose(e, d)).toBe(true)
      expect(e.preventDefault).toHaveBeenCalledTimes(1)
      await Promise.resolve()
      expect(d.quit).not.toHaveBeenCalled()
    })

    it(`${platform}: Quit starts the quit instead of letting the window die first`, async () => {
      setPlatformId(platform)
      const e = { preventDefault: vi.fn() }
      const d = deps({ ask: () => Promise.resolve(true) })
      expect(guardLastWindowClose(e, d)).toBe(true)
      expect(e.preventDefault).toHaveBeenCalledTimes(1)
      await Promise.resolve()
      expect(d.quit).toHaveBeenCalledTimes(1)
    })
  }

  it('darwin: closing a window is not a quit, so the close goes through untouched', () => {
    setPlatformId('darwin')
    const e = { preventDefault: vi.fn() }
    const ask = vi.fn(() => Promise.resolve(false))
    const d = deps({ ask })
    expect(guardLastWindowClose(e, d)).toBe(false)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })

  it('linux: a second close while the dialog is up is vetoed without a second dialog', () => {
    setPlatformId('linux')
    const e = { preventDefault: vi.fn() }
    const ask = vi.fn(() => Promise.resolve(false))
    const d = deps({ ask, promptOpen: () => true })
    expect(guardLastWindowClose(e, d)).toBe(true)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(ask).not.toHaveBeenCalled()
  })

  it('linux: main window closed first, a plugin window last — only the last close prompts, once', async () => {
    // The guard is attached to every window Electron creates, so the window
    // that happens to be last is the one that asks, whatever kind it is.
    setPlatformId('linux')
    let live = 2
    const ask = vi.fn(() => Promise.resolve(false))
    const d = deps({ ask, liveWindows: () => live })
    const closeMain = { preventDefault: vi.fn() }
    expect(guardLastWindowClose(closeMain, d)).toBe(false)
    expect(closeMain.preventDefault).not.toHaveBeenCalled()
    live = 1
    const closePlans = { preventDefault: vi.fn() }
    expect(guardLastWindowClose(closePlans, d)).toBe(true)
    expect(closePlans.preventDefault).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(d.quit).not.toHaveBeenCalled()
  })

  it('linux: closing one of several windows does not prompt', () => {
    setPlatformId('linux')
    const e = { preventDefault: vi.fn() }
    expect(guardLastWindowClose(e, deps({ liveWindows: () => 2 }))).toBe(false)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
})
