import { describe, expect, it, vi } from 'vitest'
import { createPluginStagedCandidateRelay } from './pluginStagedCandidateRelay'
import type { NoticeWindow } from './plansBackendStoppedRelay'

const notice = { pluginId: 'acme.todo', version: '1.0.0', reason: 'staged candidate quarantined: digest mismatch' }

function fakeWindow(loading = false): NoticeWindow & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  return { isDestroyed: () => false, webContents: { isLoading: () => loading, send }, send }
}

describe('plugin staged candidate relay', () => {
  it('sends to a loaded main window at once', () => {
    const win = fakeWindow()
    createPluginStagedCandidateRelay({ window: () => win }).notify(notice)
    expect(win.send).toHaveBeenCalledWith('plugins:stagedCandidateNotActivated', notice)
  })

  it('holds a notice with no window, or a loading one, until a window finishes loading', () => {
    let current: NoticeWindow | null = null
    const relay = createPluginStagedCandidateRelay({ window: () => current })
    relay.notify(notice)
    const loading = fakeWindow(true)
    current = loading
    relay.notify({ ...notice, pluginId: 'acme.other' })
    expect(loading.send).not.toHaveBeenCalled()
    const ready = fakeWindow()
    relay.flush(ready)
    expect(ready.send.mock.calls.map((call) => call[1].pluginId)).toEqual(['acme.todo', 'acme.other'])
    relay.flush(ready)
    expect(ready.send).toHaveBeenCalledTimes(2)
  })
})
