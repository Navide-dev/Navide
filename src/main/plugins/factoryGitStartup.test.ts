import { describe, expect, it } from 'vitest'
import { activateFactoryGit, shouldAttemptFactoryGit } from './factoryGitStartup'

describe('shouldAttemptFactoryGit', () => {
  it('selects factory Git only for a non-opted-out profile with no installed package', () => {
    expect(shouldAttemptFactoryGit({ installedPackagePresent: false, optedOut: false })).toBe(true)
    expect(shouldAttemptFactoryGit({ installedPackagePresent: true, optedOut: false })).toBe(false)
    expect(shouldAttemptFactoryGit({ installedPackagePresent: false, optedOut: true })).toBe(false)
  })
})

describe('activateFactoryGit', () => {
  it('keeps a successfully loaded factory v2 package selected', () => {
    const activation = { pluginId: 'navide.git' }
    expect(activateFactoryGit(() => ({ loaded: true, activation }))).toEqual({ mode: 'v2', activation })
  })

  it('reports why the factory v2 bundle could not load', () => {
    expect(activateFactoryGit(() => ({ loaded: false, reason: 'entry file is missing' })))
      .toEqual({ mode: 'failed', reason: 'entry file is missing' })
  })

  it('converts a thrown factory loader into a reported failure', () => {
    expect(activateFactoryGit(() => { throw new Error('bundle parse failed') }))
      .toEqual({ mode: 'failed', reason: 'bundle parse failed' })
  })
})
