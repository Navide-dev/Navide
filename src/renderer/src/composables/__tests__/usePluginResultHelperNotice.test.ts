// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { usePluginResultHelperNotice } from '../usePluginResultHelperNotice'

type State = { state: 'idle' | 'ready' | 'unavailable'; lastError: string; since: number }

describe('usePluginResultHelperNotice', () => {
  let saved: typeof i18n.global.locale.value
  let handler: ((state: State) => void) | null = null
  beforeEach(() => {
    saved = i18n.global.locale.value
    i18n.global.locale.value = 'en-US'
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: {
        onResultHelperState: vi.fn((h: (state: State) => void) => {
          handler = h
          return () => { handler = null }
        }),
      },
    }
  })
  afterEach(() => {
    i18n.global.locale.value = saved
    delete (window as unknown as Record<string, unknown>).agentTeam
    for (const toast of useNotify().toasts.value) useNotify().dismissToast(toast.id)
  })

  it('notes the first time the helper cannot be used, once per session, without interrupting', () => {
    const stop = usePluginResultHelperNotice()
    handler!({ state: 'ready', lastError: '', since: 1 })
    expect(useNotify().toasts.value).toEqual([])
    handler!({ state: 'unavailable', lastError: 'it exited before it was ready', since: 2 })
    handler!({ state: 'idle', lastError: '', since: 3 })
    handler!({ state: 'unavailable', lastError: 'again', since: 4 })
    const messages = useNotify().toasts.value.map((toast) => toast.message)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('it exited before it was ready')
    expect(messages[0]).toContain('1 MiB')
    expect(useNotify().dialog.value).toBeNull()
    stop()
    expect(handler).toBeNull()
  })

  it('does nothing on a Host without the channel', () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: {} }
    expect(() => usePluginResultHelperNotice()()).not.toThrow()
  })
})
