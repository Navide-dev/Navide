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

describe('plugin staged update relay', () => {
  const updates = [{ pluginId: 'acme.todo', activeVersion: '1.0.0', stagedVersion: '1.1.0' }]

  it('sends the staged updates to a loaded main window at once', () => {
    const win = fakeWindow()
    createPluginStagedCandidateRelay({ window: () => win }).notifyStagedUpdates(updates)
    expect(win.send).toHaveBeenCalledWith('plugins:stagedUpdates', updates)
  })

  it('holds them, in order with the other notice, until a window finishes loading', () => {
    const relay = createPluginStagedCandidateRelay({ window: () => null })
    relay.notify(notice)
    relay.notifyStagedUpdates(updates)
    const ready = fakeWindow()
    relay.flush(ready)
    expect(ready.send.mock.calls).toEqual([
      ['plugins:stagedCandidateNotActivated', notice],
      ['plugins:stagedUpdates', updates],
    ])
  })
})

describe('plugin switch relay (L3)', () => {
  it('sends a version switch to a loaded main window, or holds it until one loads', () => {
    const switched = { pluginId: 'acme.todo', fromVersion: '1.0.0', toVersion: '1.1.0', source: 'marketplace' as const, at: 5 }
    const win = fakeWindow()
    createPluginStagedCandidateRelay({ window: () => win }).notifySwitched(switched)
    expect(win.send).toHaveBeenCalledWith('plugins:switched', switched)

    const relay = createPluginStagedCandidateRelay({ window: () => null })
    relay.notifySwitched(switched)
    const ready = fakeWindow()
    relay.flush(ready)
    expect(ready.send).toHaveBeenCalledWith('plugins:switched', switched)
  })
})
