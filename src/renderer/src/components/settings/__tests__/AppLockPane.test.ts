// @vitest-environment happy-dom
// Settings → App Lock. The page reads main's status and asks main for every
// change; it never holds the PIN itself. The notice that this is a privacy
// screen and not access control is always on the page.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'

import AppLockPane from '../AppLockPane.vue'
import { DEFAULT_APP_LOCK_SETTINGS, type AppLockApi, type AppLockStatus } from '../../../../../shared/appLock'

function fakeApi(over: Partial<AppLockStatus> = {}) {
  let listener: ((s: AppLockStatus) => void) | null = null
  const status: AppLockStatus = { settings: { ...DEFAULT_APP_LOCK_SETTINGS }, hasPin: false, locked: false, systemUnlockAvailable: true, ...over }
  const api = {
    status: vi.fn(async () => status),
    updateSettings: vi.fn(async () => ({ ok: true as const })),
    setPin: vi.fn(async () => ({ ok: true as const })),
    resetPinWithSystem: vi.fn(async () => ({ ok: true as const })),
    removePin: vi.fn(async () => ({ ok: true as const })),
    lockNow: vi.fn(async () => ({ ok: true })),
    onStatus: vi.fn((cb: (s: AppLockStatus) => void) => { listener = cb; return () => { listener = null } }),
  } satisfies AppLockApi
  ;(window as unknown as { agentTeam: unknown }).agentTeam = { appLock: api }
  return { api, push: (s: AppLockStatus) => listener?.(s) }
}

async function mountPane() {
  const w = mount(AppLockPane, { global: { plugins: [i18n] } })
  await flushPromises()
  return w
}

afterEach(() => {
  delete (window as unknown as { agentTeam?: unknown }).agentTeam
})

describe('AppLockPane', () => {
  it('says it is a privacy screen, and cannot be turned on before a PIN exists', async () => {
    fakeApi()
    const w = await mountPane()
    expect(w.get('[data-testid="app-lock-notice"]').text()).toContain('not access control')
    expect(w.get('[data-testid="app-lock-enabled"]').attributes('disabled')).toBeDefined()
    expect(w.get('[data-testid="app-lock-lock-now"]').attributes('disabled')).toBeDefined()
  })

  it('sets a first PIN through main after checking both entries match', async () => {
    const { api } = fakeApi()
    const w = await mountPane()
    await w.get('[data-testid="app-lock-set-pin"]').trigger('click')
    await w.get('[data-testid="app-lock-new-pin"]').setValue('1234')
    await w.get('[data-testid="app-lock-confirm-pin"]').setValue('1243')
    await w.get('[data-testid="app-lock-pin-form"]').trigger('submit')
    expect(api.setPin).not.toHaveBeenCalled()
    expect(w.get('[data-testid="app-lock-error"]').text()).toContain("don't match")
    await w.get('[data-testid="app-lock-confirm-pin"]').setValue('1234')
    await w.get('[data-testid="app-lock-pin-form"]').trigger('submit')
    await flushPromises()
    expect(api.setPin).toHaveBeenCalledWith('1234')
  })

  it('keeps only digits in a PIN field', async () => {
    fakeApi()
    const w = await mountPane()
    await w.get('[data-testid="app-lock-set-pin"]').trigger('click')
    const input = w.get('[data-testid="app-lock-new-pin"]')
    await input.setValue('12ab34')
    expect((input.element as HTMLInputElement).value).toBe('1234')
  })

  it('changes and removes the PIN with the current one, and shows a wrong PIN', async () => {
    const { api } = fakeApi({ hasPin: true })
    api.removePin.mockResolvedValueOnce({ ok: false, error: 'wrong-pin' } as never)
    const w = await mountPane()
    await w.get('[data-testid="app-lock-remove-pin"]').trigger('click')
    await w.get('[data-testid="app-lock-current-pin"]').setValue('0000')
    await w.get('[data-testid="app-lock-pin-form"]').trigger('submit')
    await flushPromises()
    expect(api.removePin).toHaveBeenCalledWith('0000')
    expect(w.get('[data-testid="app-lock-error"]').text()).toContain('wrong')

    await w.get('[data-testid="app-lock-change-pin"]').trigger('click')
    await w.get('[data-testid="app-lock-current-pin"]').setValue('1234')
    await w.get('[data-testid="app-lock-new-pin"]').setValue('5678')
    await w.get('[data-testid="app-lock-confirm-pin"]').setValue('5678')
    await w.get('[data-testid="app-lock-pin-form"]').trigger('submit')
    await flushPromises()
    expect(api.setPin).toHaveBeenCalledWith('5678', '1234')
  })

  it('writes each setting through main and follows main’s status', async () => {
    const { api, push } = fakeApi({ hasPin: true })
    const w = await mountPane()
    await w.get('[data-testid="app-lock-enabled"]').trigger('click')
    expect(api.updateSettings).toHaveBeenCalledWith({ enabled: true })
    await w.get('[data-testid="app-lock-idle"]').setValue('30')
    expect(api.updateSettings).toHaveBeenCalledWith({ idleMinutes: 30 })
    await w.get('[data-testid="app-lock-on-start"]').trigger('click')
    expect(api.updateSettings).toHaveBeenCalledWith({ lockOnStart: true })

    push({ settings: { ...DEFAULT_APP_LOCK_SETTINGS, enabled: true }, hasPin: true, locked: false, systemUnlockAvailable: true })
    await flushPromises()
    await w.get('[data-testid="app-lock-lock-now"]').trigger('click')
    expect(api.lockNow).toHaveBeenCalled()
  })

  it('offers the Touch ID reset only where Touch ID exists, else the manual way out', async () => {
    fakeApi({ hasPin: true })
    const withTouchId = await mountPane()
    expect(withTouchId.find('[data-testid="app-lock-reset-pin"]').exists()).toBe(true)

    fakeApi({ hasPin: true, systemUnlockAvailable: false })
    const without = await mountPane()
    expect(without.find('[data-testid="app-lock-reset-pin"]').exists()).toBe(false)
    expect(without.text()).toContain('app-lock.json')
    expect(without.get('[data-testid="app-lock-method"]').attributes('disabled')).toBeDefined()
  })
})
