// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { useNativeBackendDefaultOnNotice } from '../useNativeBackendDefaultOnNotice'

describe('useNativeBackendDefaultOnNotice', () => {
  let saved: typeof i18n.global.locale.value
  const install = (take: (() => Promise<boolean>) | undefined): void => {
    ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: { nativeBackends: take ? { takeDefaultOnNotice: take } : {} } }
  }
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  beforeEach(() => {
    saved = i18n.global.locale.value
    i18n.global.locale.value = 'en-US'
  })
  afterEach(() => {
    i18n.global.locale.value = saved
    delete (window as unknown as Record<string, unknown>).agentTeam
    for (const toast of useNotify().toasts.value) useNotify().dismissToast(toast.id)
  })

  it('tells the user once, until dismissed, with an action that opens the switch', async () => {
    vi.useFakeTimers()
    const openSwitch = vi.fn()
    install(vi.fn(async () => true))
    useNativeBackendDefaultOnNotice(openSwitch)
    await vi.runAllTimersAsync()
    vi.useRealTimers()
    const toasts = useNotify().toasts.value
    expect(toasts.map((toast) => toast.message)).toEqual([
      'Native backends of third-party Navide plugins are now on by default. You can turn them off in Settings → Navide Plugins → Developer and native code.',
    ])
    expect(toasts[0].action?.label).toBe('Open Settings')
    toasts[0].action!.run()
    expect(openSwitch).toHaveBeenCalledTimes(1)
  })

  it('shows nothing when the main process has nothing to report, or cannot be asked', async () => {
    install(vi.fn(async () => false))
    useNativeBackendDefaultOnNotice(vi.fn())
    install(vi.fn(async () => { throw new Error('unavailable') }))
    useNativeBackendDefaultOnNotice(vi.fn())
    install(undefined)
    useNativeBackendDefaultOnNotice(vi.fn())
    await flush()
    expect(useNotify().toasts.value).toEqual([])
  })
})
