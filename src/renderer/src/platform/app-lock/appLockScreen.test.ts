// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppLockScreenBridge, AppLockScreenInit } from '../../../../shared/appLock'
import { mountAppLockScreen } from './appLockScreen'

// The lock screen only asks main to unlock; it decides nothing itself.
// Touch ID is a fake bridge call — no real system dialog in tests.
const strings: AppLockScreenInit['strings'] = {
  title: 'Navide is locked', subtitle: 'Agents keep running.', pinLabel: 'PIN', unlock: 'Unlock',
  unlockWithSystem: 'Unlock with Touch ID', wrongPin: 'Wrong PIN.', cooldown: 'Wait {seconds} s.',
  systemFailed: 'Touch ID failed.', forgotPin: 'Forgot?',
}

function bridge(): AppLockScreenBridge & { unlockWithPin: ReturnType<typeof vi.fn>; unlockWithSystem: ReturnType<typeof vi.fn> } {
  return {
    init: vi.fn(),
    unlockWithPin: vi.fn(async () => ({ ok: false as const, error: 'wrong-pin' as const })),
    unlockWithSystem: vi.fn(async () => ({ ok: true as const })),
  }
}

let root: HTMLElement
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  root = document.getElementById('root')!
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('app lock screen', () => {
  it('sends the typed PIN to main and shows a wrong PIN', async () => {
    const b = bridge()
    mountAppLockScreen(root, b, { strings, systemUnlockAvailable: false, preferSystem: true })
    const input = root.querySelector('input')!
    input.value = '12a34'
    input.dispatchEvent(new Event('input'))
    expect(input.value).toBe('1234')
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(b.unlockWithPin).toHaveBeenCalledWith('1234')
    expect(root.querySelector('[role="alert"]')!.textContent).toBe('Wrong PIN.')
    expect(input.value).toBe('')
  })

  it('shows the cooldown in seconds', async () => {
    const b = bridge()
    b.unlockWithPin.mockResolvedValueOnce({ ok: false, error: 'cooldown', retryAfterMs: 59_100 })
    mountAppLockScreen(root, b, { strings, systemUnlockAvailable: false, preferSystem: false })
    const input = root.querySelector('input')!
    input.value = '0000'
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(root.querySelector('[role="alert"]')!.textContent).toBe('Wait 60 s.')
  })

  it('offers Touch ID only when it is available and chosen', async () => {
    const b = bridge()
    mountAppLockScreen(root, b, { strings, systemUnlockAvailable: true, preferSystem: true })
    const system = [...root.querySelectorAll('button')].find((el) => el.textContent === 'Unlock with Touch ID')!
    system.click()
    await flush()
    expect(b.unlockWithSystem).toHaveBeenCalledTimes(1)

    mountAppLockScreen(root, b, { strings, systemUnlockAvailable: true, preferSystem: false })
    expect([...root.querySelectorAll('button')].some((el) => el.textContent === 'Unlock with Touch ID')).toBe(false)
    mountAppLockScreen(root, b, { strings, systemUnlockAvailable: false, preferSystem: true })
    expect([...root.querySelectorAll('button')].some((el) => el.textContent === 'Unlock with Touch ID')).toBe(false)
  })
})
