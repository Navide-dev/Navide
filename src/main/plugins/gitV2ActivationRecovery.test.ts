import { describe, expect, it } from 'vitest'
import { isSelectedGitV2ActivationFailure } from './gitV2ActivationRecovery'

const failure = {
  pluginId: 'navide.git',
  packageVersion: '2.0.0',
  reason: 'plugin readiness handshake timed out',
}

const selectedDescriptor = () => ({
  id: 'navide.git',
  packageVersion: '2.0.0',
  capabilityPolicy: { kind: 'manifest-v2' },
})

describe('isSelectedGitV2ActivationFailure', () => {
  it('accepts a failure of the selected, granted Git v2 package', () => {
    expect(isSelectedGitV2ActivationFailure(failure, { selectedDescriptor, hasExactGrant: () => true })).toBe(true)
  })

  it.each([
    ['another package', { ...failure, pluginId: 'acme.git' }, true],
    ['a stale package version', { ...failure, packageVersion: '1.0.0' }, true],
    ['a missing grant', failure, false],
  ])('rejects %s', (_label, activationFailure, hasGrant) => {
    expect(isSelectedGitV2ActivationFailure(activationFailure, {
      selectedDescriptor,
      hasExactGrant: () => hasGrant,
    })).toBe(false)
  })

  it('rejects a failure when no Git package is selected', () => {
    expect(isSelectedGitV2ActivationFailure(failure, {
      selectedDescriptor: () => null,
      hasExactGrant: () => true,
    })).toBe(false)
  })
})
