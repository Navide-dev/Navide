import { describe, expect, it } from 'vitest'
import { createPlansBackendStoppedRelay, type NoticeWindow } from './plansBackendStoppedRelay'

// A headless Plans child that gave up is told to the user through a main
// window. With no main window open (macOS keeps running with all closed), or
// one still loading its page, the notice must wait for the next window instead
// of being dropped.
function fakeWindow(opts: { loading?: boolean; destroyed?: boolean } = {}) {
  const sent: Array<[string, unknown]> = []
  const win: NoticeWindow & { sent: typeof sent; loading: boolean } = {
    sent,
    loading: opts.loading ?? false,
    isDestroyed: () => opts.destroyed ?? false,
    webContents: {
      isLoading: () => win.loading,
      send: (channel: string, payload: unknown) => { sent.push([channel, payload]) },
    },
  }
  return win
}

describe('plans:backendStopped relay', () => {
  it('sends at once to the workspace window', () => {
    const win = fakeWindow()
    const relay = createPlansBackendStoppedRelay({ find: () => win, fallback: () => null })
    relay.notify('/ws/a')
    expect(win.sent).toEqual([['plans:backendStopped', { workspacePath: '/ws/a' }]])
  })

  it('holds the notice while no main window is open and sends it to the next one', () => {
    const relay = createPlansBackendStoppedRelay({ find: () => null, fallback: () => null })
    relay.notify('/ws/a')
    relay.notify('/ws/a')
    relay.notify('/ws/b')
    const next = fakeWindow()
    relay.flush(next)
    expect(next.sent).toEqual([
      ['plans:backendStopped', { workspacePath: '/ws/a' }],
      ['plans:backendStopped', { workspacePath: '/ws/b' }],
    ])
    relay.flush(fakeWindow())
    expect(next.sent).toHaveLength(2)
  })

  it('holds the notice for a window still loading its page', () => {
    const win = fakeWindow({ loading: true })
    const relay = createPlansBackendStoppedRelay({ find: () => win, fallback: () => null })
    relay.notify('/ws/a')
    expect(win.sent).toEqual([])
    win.loading = false
    relay.flush(win)
    expect(win.sent).toEqual([['plans:backendStopped', { workspacePath: '/ws/a' }]])
  })

  it('skips a destroyed window for the fallback', () => {
    const gone = fakeWindow({ destroyed: true })
    const other = fakeWindow()
    const relay = createPlansBackendStoppedRelay({ find: () => gone, fallback: () => other })
    relay.notify('/ws/a')
    expect(gone.sent).toEqual([])
    expect(other.sent).toEqual([['plans:backendStopped', { workspacePath: '/ws/a' }]])
  })
})
