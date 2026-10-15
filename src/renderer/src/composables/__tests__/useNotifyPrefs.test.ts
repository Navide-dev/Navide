// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory settings backend; the listener is captured so a broadcast from
// another window (or the Settings page in this one) can be replayed. Hoisted
// for the same reason as useStatusBadgePrefs.test.ts: the module subscribes at
// import time.
const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  writes: [] as Array<[string, unknown]>,
  listener: null as ((keys: string[]) => void) | null,
}))

vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) => (h.store.has(key) ? h.store.get(key) : fallback),
  settingsSet: (key: string, value: unknown) => {
    h.writes.push([key, value])
    h.store.set(key, value)
  },
  onSettingsChanged: (cb: (keys: string[]) => void) => {
    h.listener = cb
    return () => {
      h.listener = null
    }
  },
}))

import {
  __reloadNotifyPrefsForTest,
  notifySoundOn,
  setNotifySoundOn,
  setSystemNotifyOn,
  systemNotifyOn,
} from '../useNotifyPrefs'
import { SYSTEM_NOTIFY_ENABLED_KEY, systemNotifyEnabled } from '../useSystemNotify'
import { NOTIFY_SOUND_ENABLED_KEY, notifySoundEnabled } from '../useSoundNotify'

describe('useNotifyPrefs', () => {
  beforeEach(() => {
    h.store.clear()
    h.writes.length = 0
    __reloadNotifyPrefsForTest()
  })

  it('starts from the stored settings, both on by default', () => {
    expect(systemNotifyOn.value).toBe(true)
    expect(notifySoundOn.value).toBe(true)
    h.store.set(SYSTEM_NOTIFY_ENABLED_KEY, false)
    h.store.set(NOTIFY_SOUND_ENABLED_KEY, false)
    __reloadNotifyPrefsForTest()
    expect(systemNotifyOn.value).toBe(false)
    expect(notifySoundOn.value).toBe(false)
  })

  it('writes the very settings the Settings page writes', () => {
    setSystemNotifyOn(false)
    setNotifySoundOn(false)
    expect(h.writes).toEqual([
      [SYSTEM_NOTIFY_ENABLED_KEY, false],
      [NOTIFY_SOUND_ENABLED_KEY, false],
    ])
    // The gates the notifications and sounds actually consult see it at once.
    expect(systemNotifyEnabled()).toBe(false)
    expect(notifySoundEnabled()).toBe(false)
    expect(systemNotifyOn.value).toBe(false)
    expect(notifySoundOn.value).toBe(false)
  })

  it('follows a change made in another window', () => {
    h.store.set(SYSTEM_NOTIFY_ENABLED_KEY, false)
    h.listener?.([SYSTEM_NOTIFY_ENABLED_KEY])
    expect(systemNotifyOn.value).toBe(false)
    expect(notifySoundOn.value).toBe(true)

    h.store.set(NOTIFY_SOUND_ENABLED_KEY, false)
    h.listener?.(['agentTeam.unrelated'])
    expect(notifySoundOn.value).toBe(true)
    h.listener?.([NOTIFY_SOUND_ENABLED_KEY])
    expect(notifySoundOn.value).toBe(false)
  })
})
