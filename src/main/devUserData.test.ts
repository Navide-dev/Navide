import { describe, expect, it } from 'vitest'

import { devUserDataPath } from './devUserData'

const BASE = '/Users/me/Library/Application Support/Navide'

describe('devUserDataPath', () => {
  it('keeps the standard dev profile beside the packaged app’s', () => {
    expect(devUserDataPath(BASE, {}, null)).toEqual({ path: `${BASE}-dev`, ignored: null })
  })

  it('keeps the Plans dev profile as it was', () => {
    expect(devUserDataPath(BASE, {}, 'alice')).toEqual({ path: `${BASE}-dev-plans-alice`, ignored: null })
  })

  it('uses NAVIDE_DEV_USER_DATA_DIR as it is when it is an absolute path', () => {
    const env = { NAVIDE_DEV_USER_DATA_DIR: '/tmp/navide-fresh.abc' }
    expect(devUserDataPath(BASE, env, null)).toEqual({ path: '/tmp/navide-fresh.abc', ignored: null })
    // An explicit directory is the whole answer: no profile suffix is added.
    expect(devUserDataPath(BASE, env, 'alice')).toEqual({ path: '/tmp/navide-fresh.abc', ignored: null })
  })

  it('ignores a relative or blank NAVIDE_DEV_USER_DATA_DIR, saying so', () => {
    expect(devUserDataPath(BASE, { NAVIDE_DEV_USER_DATA_DIR: 'fresh' }, null)).toEqual({
      path: `${BASE}-dev`,
      ignored: 'fresh',
    })
    expect(devUserDataPath(BASE, { NAVIDE_DEV_USER_DATA_DIR: '' }, null)).toEqual({ path: `${BASE}-dev`, ignored: null })
  })
})
