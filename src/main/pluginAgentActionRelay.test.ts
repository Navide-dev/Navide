import { describe, expect, it, vi } from 'vitest'
import { createPluginAgentActionRelay } from './pluginAgentActionRelay'
import type { NoticeWindow } from './plansBackendStoppedRelay'

const notice = {
  action: 'disable' as const,
  pluginId: 'nerdtechnic.devmap',
  pluginVersion: '0.2.0',
  requester: { paneId: null, paneName: null, workspace: null, callerKind: 'external' as const },
}

function fakeWindow(loading = false): NoticeWindow & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  return { isDestroyed: () => false, webContents: { isLoading: () => loading, send }, send }
}

describe('plugin agent action relay', () => {
  it('sends to a loaded main window at once', () => {
    const win = fakeWindow()
    createPluginAgentActionRelay({ window: () => win }).notify(notice)
    expect(win.send).toHaveBeenCalledWith('plugins:agentAction', notice)
  })

  it('holds a notice with no window, or a loading one, until a window finishes loading', () => {
    let current: NoticeWindow | null = null
    const relay = createPluginAgentActionRelay({ window: () => current })
    relay.notify(notice)
    const loading = fakeWindow(true)
    current = loading
    relay.notify({ ...notice, action: 'enable' })
    expect(loading.send).not.toHaveBeenCalled()
    const ready = fakeWindow()
    relay.flush(ready)
    expect(ready.send.mock.calls.map((call) => call[1].action)).toEqual(['disable', 'enable'])
    relay.flush(ready)
    expect(ready.send).toHaveBeenCalledTimes(2)
  })
})
