import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import { createWindowCloseCoordinator, type WindowCloseHost, type WindowCloseOutcome } from './windowCloseCoordinator'

type CloseListener = (event: { preventDefault: () => void }) => void
const asMock = (fn: unknown): ReturnType<typeof vi.fn> => fn as ReturnType<typeof vi.fn>

function fakeWindow(id: number): BrowserWindow & {
  emitClose: () => { prevented: boolean }
  destroyed: boolean
} {
  const listeners: CloseListener[] = []
  const closedListeners: Array<() => void> = []
  const window = {
    id,
    destroyed: false,
    on: vi.fn((event: string, listener: CloseListener) => {
      if (event === 'close') listeners.push(listener)
      return window
    }),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'closed') closedListeners.push(listener)
      return window
    }),
    isDestroyed: () => window.destroyed,
    destroy: vi.fn(() => { window.destroyed = true }),
    emitClose: () => {
      let prevented = false
      for (const listener of listeners) listener({ preventDefault: () => { prevented = true } })
      return { prevented }
    },
  }
  return window as unknown as BrowserWindow & { emitClose: () => { prevented: boolean }; destroyed: boolean }
}

function fakeTarget(): WebContents {
  return {
    isDestroyed: () => false,
    reload: vi.fn(),
  } as unknown as WebContents
}

function makeHost(overrides: Partial<WindowCloseHost> = {}): WindowCloseHost {
  return {
    hasWindowCloseParticipants: () => true,
    prepareWindowClose: vi.fn(async (): Promise<WindowCloseOutcome> => ({ ok: true, id: 'prep-1' })),
    commitWindowClose: vi.fn(),
    cancelWindowClose: vi.fn(),
    windowForWebContents: () => null,
    ...overrides,
  }
}

describe('window close coordinator', () => {
  it('prevents native close, prepares, commits, then destroys exactly once', async () => {
    let release!: (outcome: WindowCloseOutcome) => void
    const pending = new Promise<WindowCloseOutcome>((resolve) => { release = resolve })
    const prepare = vi.fn(() => pending)
    const host = makeHost({ prepareWindowClose: prepare })
    const coordinator = createWindowCloseCoordinator(host)
    const window = fakeWindow(7)
    coordinator.watch(window)

    const first = window.emitClose()
    expect(first.prevented).toBe(true)
    expect(prepare).toHaveBeenCalledWith(window, 'native-window-close')

    // A second close while preparing is swallowed, not prepared twice.
    window.emitClose()
    expect(prepare).toHaveBeenCalledOnce()
    expect(window.destroy).not.toHaveBeenCalled()

    release({ ok: true, id: 'prep-1' })
    await vi.waitFor(() => expect(window.destroy).toHaveBeenCalledOnce())
    expect(host.commitWindowClose).toHaveBeenCalledWith('prep-1')
  })

  it('leaves the window alive on refusal and allows a later retry', async () => {
    const prepare = vi.fn(async (): Promise<WindowCloseOutcome> => ({ ok: false, reason: 'refused' }))
    const host = makeHost({ prepareWindowClose: prepare })
    const coordinator = createWindowCloseCoordinator(host)
    const window = fakeWindow(8)
    coordinator.watch(window)

    expect(window.emitClose().prevented).toBe(true)
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    expect(window.destroy).not.toHaveBeenCalled()
    expect(host.commitWindowClose).not.toHaveBeenCalled()

    window.emitClose()
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
  })

  it('routes menu reload through preparation and skips it when refused', async () => {
    const target = fakeTarget()
    const window = fakeWindow(9)
    const host = makeHost({ windowForWebContents: () => window })
    const coordinator = createWindowCloseCoordinator(host)
    expect(await coordinator.prepareAndReload(target)).toBe(true)
    expect(host.prepareWindowClose).toHaveBeenCalledWith(window, 'reload')
    expect(host.commitWindowClose).toHaveBeenCalledWith('prep-1')
    expect(target.reload).toHaveBeenCalledOnce()

    const refusedTarget = fakeTarget()
    const refused = makeHost({
      windowForWebContents: () => window,
      prepareWindowClose: vi.fn(async (): Promise<WindowCloseOutcome> => ({ ok: false, reason: 'busy' })),
    })
    expect(await createWindowCloseCoordinator(refused).prepareAndReload(refusedTarget)).toBe(true)
    expect(refusedTarget.reload).not.toHaveBeenCalled()
  })

  it('serializes native close, reload, and quit on the same window while preparation is pending', async () => {
    let release!: (outcome: WindowCloseOutcome) => void
    const pending = new Promise<WindowCloseOutcome>((resolve) => { release = resolve })
    const window = fakeWindow(16)
    const target = fakeTarget()
    const host = makeHost({
      windowForWebContents: () => window,
      prepareWindowClose: vi.fn(() => pending),
    })
    const coordinator = createWindowCloseCoordinator(host)
    coordinator.watch(window)
    const firstReload = coordinator.prepareAndReload(target)
    expect(window.emitClose().prevented).toBe(true)
    expect(await coordinator.prepareAndReload(target)).toBe(true)
    expect(await coordinator.prepareForQuit([window])).toBe(false)
    expect(host.prepareWindowClose).toHaveBeenCalledOnce()
    release({ ok: true, id: 'prep-1' })
    expect(await firstReload).toBe(true)
    expect(host.commitWindowClose).toHaveBeenCalledOnce()
    expect(target.reload).toHaveBeenCalledOnce()
  })

  it('reports refusal and rejection for native close, reload, and quit without closing', async () => {
    const window = fakeWindow(17)
    const target = fakeTarget()
    const notifyCloseRefused = vi.fn()
    const host = makeHost({
      windowForWebContents: () => window,
      notifyCloseRefused,
      prepareWindowClose: vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'refused' })
        .mockResolvedValueOnce({ ok: false, reason: 'timeout' })
        .mockRejectedValueOnce(new Error('unavailable')),
    })
    const coordinator = createWindowCloseCoordinator(host)
    coordinator.watch(window)
    window.emitClose()
    await vi.waitFor(() => expect(notifyCloseRefused).toHaveBeenCalledWith(window, 'native-window-close', 'refused'))
    expect(await coordinator.prepareAndReload(target)).toBe(true)
    expect(notifyCloseRefused).toHaveBeenCalledWith(window, 'reload', 'timeout')
    expect(await coordinator.prepareForQuit([window])).toBe(false)
    expect(notifyCloseRefused).toHaveBeenCalledWith(window, 'quit', 'unavailable')
    expect(window.destroy).not.toHaveBeenCalled()
    expect(target.reload).not.toHaveBeenCalled()
  })

  it('does not touch unguarded windows or targets without a window', async () => {
    const noParticipants = makeHost({ hasWindowCloseParticipants: () => false })
    const coordinator = createWindowCloseCoordinator(noParticipants)
    const window = fakeWindow(10)
    coordinator.watch(window)
    expect(window.emitClose().prevented).toBe(false)
    expect(noParticipants.prepareWindowClose).not.toHaveBeenCalled()

    const noWindow = makeHost({ windowForWebContents: () => null })
    expect(await createWindowCloseCoordinator(noWindow).prepareAndReload(fakeTarget())).toBe(false)
    expect(noWindow.prepareWindowClose).not.toHaveBeenCalled()
  })

  it('prepares every affected window before destroying any, cancelling on refusal', async () => {
    const first = fakeWindow(11)
    const second = fakeWindow(12)
    const accepted = makeHost()
    expect(await createWindowCloseCoordinator(accepted).prepareForQuit([first, second])).toBe(true)
    expect(accepted.prepareWindowClose).toHaveBeenCalledTimes(2)
    expect(accepted.commitWindowClose).toHaveBeenCalledTimes(2)
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(second.destroy).toHaveBeenCalledOnce()

    const refusedWindow = fakeWindow(13)
    const refused = makeHost({
      prepareWindowClose: vi.fn(async (): Promise<WindowCloseOutcome> => ({ ok: false, reason: 'timeout' })),
    })
    expect(await createWindowCloseCoordinator(refused).prepareForQuit([refusedWindow])).toBe(false)
    expect(refused.commitWindowClose).not.toHaveBeenCalled()
    expect(refusedWindow.destroy).not.toHaveBeenCalled()
  })

  it('cancels already-prepared windows when a later window refuses during quit', async () => {
    const first = fakeWindow(14)
    const second = fakeWindow(15)
    let call = 0
    const host = makeHost({
      prepareWindowClose: vi.fn(async (): Promise<WindowCloseOutcome> => {
        call += 1
        return call === 1 ? { ok: true, id: 'prep-a' } : { ok: false, reason: 'refused' }
      }),
    })
    expect(await createWindowCloseCoordinator(host).prepareForQuit([first, second])).toBe(false)
    expect(host.commitWindowClose).not.toHaveBeenCalled()
    expect(host.cancelWindowClose).toHaveBeenCalledWith('prep-a')
    expect(first.destroy).not.toHaveBeenCalled()
    expect(second.destroy).not.toHaveBeenCalled()
  })

  // SIGTERM, a logout or a shutdown: participants still get to save, but no
  // answer keeps the app running and nothing is put on screen.
  describe('forced quit', () => {
    it.each(['refused', 'busy', 'timeout'] as const)('goes ahead when a participant answers %s', async (reason) => {
      const kept = fakeWindow(21)
      const other = fakeWindow(22)
      const logForcedQuitIgnored = vi.fn()
      const notifyCloseRefused = vi.fn()
      const host = makeHost({
        logForcedQuitIgnored,
        notifyCloseRefused,
        prepareWindowClose: vi.fn(async (window: BrowserWindow): Promise<WindowCloseOutcome> =>
          window === kept ? { ok: false, reason } : { ok: true, id: 'prep-other' }),
      })
      expect(await createWindowCloseCoordinator(host).prepareForQuit([kept, other], { forced: true })).toBe(true)
      // The participant that answered was saved and committed; the other is logged.
      expect(host.commitWindowClose).toHaveBeenCalledWith('prep-other')
      expect(logForcedQuitIgnored).toHaveBeenCalledWith(kept, reason)
      expect(notifyCloseRefused).not.toHaveBeenCalled()
      expect(kept.destroy).toHaveBeenCalledOnce()
      expect(other.destroy).toHaveBeenCalledOnce()
    })

    it('stops waiting for a participant that never answers', async () => {
      vi.useFakeTimers()
      try {
        const window = fakeWindow(23)
        let answer!: (outcome: WindowCloseOutcome) => void
        const host = makeHost({
          logForcedQuitIgnored: vi.fn(),
          prepareWindowClose: vi.fn(() => new Promise<WindowCloseOutcome>((resolve) => { answer = resolve })),
        })
        const quit = createWindowCloseCoordinator(host).prepareForQuit([window], { forced: true, deadlineMs: 1000 })
        await vi.advanceTimersByTimeAsync(1000)
        expect(await quit).toBe(true)
        expect(host.logForcedQuitIgnored).toHaveBeenCalledWith(window, 'timeout')
        expect(window.destroy).toHaveBeenCalledOnce()
        // A late answer is released, never committed.
        answer({ ok: true, id: 'late' })
        await vi.advanceTimersByTimeAsync(0)
        expect(host.cancelWindowClose).toHaveBeenCalledWith('late')
        expect(host.commitWindowClose).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('goes ahead past a window already busy closing', async () => {
      let release!: (outcome: WindowCloseOutcome) => void
      const host = makeHost({
        logForcedQuitIgnored: vi.fn(),
        prepareWindowClose: vi.fn(() => new Promise<WindowCloseOutcome>((resolve) => { release = resolve })),
      })
      const coordinator = createWindowCloseCoordinator(host)
      const window = fakeWindow(24)
      coordinator.watch(window)
      window.emitClose()
      expect(await coordinator.prepareForQuit([window], { forced: true })).toBe(true)
      expect(host.logForcedQuitIgnored).toHaveBeenCalledWith(window, 'busy')
      expect(window.destroy).toHaveBeenCalledOnce()
      release({ ok: false, reason: 'refused' })
    })

    it('a user quit can still be refused', async () => {
      const window = fakeWindow(25)
      const host = makeHost({
        notifyCloseRefused: vi.fn(),
        prepareWindowClose: vi.fn(async (): Promise<WindowCloseOutcome> => ({ ok: false, reason: 'refused' })),
      })
      expect(await createWindowCloseCoordinator(host).prepareForQuit([window], { forced: false })).toBe(false)
      expect(host.notifyCloseRefused).toHaveBeenCalledWith(window, 'quit', 'refused')
      expect(window.destroy).not.toHaveBeenCalled()
    })
  })
})
