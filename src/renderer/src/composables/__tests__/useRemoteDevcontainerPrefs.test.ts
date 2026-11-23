// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import {
  REMOTE_DEVCONTAINER_KEY,
  REMOTE_LOGIN_DONE_KEY,
  REMOTE_RECENT_KEY,
  REMOTE_RECENT_MAX,
  isRemoteLoginDone,
  loadRemoteRecent,
  markRemoteLoginDone,
  rememberRemoteRecent,
  setRemoteDevcontainerEnabled,
  useRemoteDevcontainerPrefs,
} from '../useRemoteDevcontainerPrefs'

// Settings → General → Experimental features → Remote container panes. Off
// unless the stored value is exactly true; the two lists it remembers hold
// host / container / CLI names and nothing else.

describe('useRemoteDevcontainerPrefs', () => {
  beforeEach(() => __resetSettingsForTest())
  afterEach(() => setRemoteDevcontainerEnabled(false))

  it('is off by default and writes the shared key when turned on', () => {
    const { remoteEnabled } = useRemoteDevcontainerPrefs()
    expect(remoteEnabled.value).toBe(false)
    setRemoteDevcontainerEnabled(true)
    expect(remoteEnabled.value).toBe(true)
    expect(settingsGet(REMOTE_DEVCONTAINER_KEY, null)).toBe(true)
  })

  it('remembers recent targets newest first, de-duplicated, capped, names only', () => {
    for (let i = 0; i < REMOTE_RECENT_MAX + 3; i++) {
      rememberRemoteRecent({ host: `h${i}`, container: 'c', agentKey: 'claude' })
    }
    rememberRemoteRecent({ host: 'h4', container: 'c', agentKey: 'claude' })
    const recent = loadRemoteRecent()
    expect(recent).toHaveLength(REMOTE_RECENT_MAX)
    expect(recent[0]).toEqual({ host: 'h4', container: 'c', agentKey: 'claude' })
    expect(recent.filter((r) => r.host === 'h4')).toHaveLength(1)
    // Extra fields a caller might pass never reach the store.
    rememberRemoteRecent({ host: 'x', container: 'y', agentKey: 'codex', network: { mode: 'bridge', gateway: '1.2.3.4' } } as never)
    const stored = settingsGet<unknown[]>(REMOTE_RECENT_KEY, [])
    expect(stored[0]).toEqual({ host: 'x', container: 'y', agentKey: 'codex' })
    for (const row of stored) expect(Object.keys(row as object).sort()).toEqual(['agentKey', 'container', 'host'])
  })

  it('drops malformed recent rows read back from the store', () => {
    settingsSet(REMOTE_RECENT_KEY, [{ host: 'a', container: 'b', agentKey: 'claude' }, { host: 1 }, 'x', { host: 'a', container: 'b', agentKey: 'gemini' }])
    expect(loadRemoteRecent()).toEqual([{ host: 'a', container: 'b', agentKey: 'claude' }])
  })

  it('remembers a dismissed sign-in card per host + container + CLI', () => {
    expect(isRemoteLoginDone('h', 'c', 'claude')).toBe(false)
    markRemoteLoginDone('h', 'c', 'claude')
    expect(isRemoteLoginDone('h', 'c', 'claude')).toBe(true)
    expect(isRemoteLoginDone('h', 'c', 'codex')).toBe(false)
    expect(isRemoteLoginDone('h', 'other', 'claude')).toBe(false)
    const stored = settingsGet<unknown[]>(REMOTE_LOGIN_DONE_KEY, [])
    expect(stored).toEqual([{ host: 'h', container: 'c', agentKey: 'claude' }])
  })
})
