import { describe, expect, it } from 'vitest'

import { APP_LOCK_STRINGS, appLockStrings } from './appLockStrings'

describe('appLockStrings', () => {
  it('names the platform system unlock and leaves {seconds} for the lock screen', () => {
    const hello = appLockStrings('en-US', 'Windows Hello')
    expect(hello.screen.unlockWithSystem).toBe('Unlock with Windows Hello')
    expect(hello.screen.cooldown).toContain('{seconds}')
    expect(appLockStrings('zh-TW', 'Touch ID').screen.unlockWithSystem).toBe('用 Touch ID 解鎖')
  })

  it('leaves no {system} behind in any language', () => {
    for (const locale of Object.keys(APP_LOCK_STRINGS)) {
      for (const text of Object.values(appLockStrings(locale, 'Windows Hello').screen)) {
        expect(text).not.toContain('{system}')
        expect(text).not.toContain('Touch ID')
      }
    }
  })
})
