import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PINNED_GIT_BRIDGE_VERSION, gitBridgeCompatible } from '../../src/main/plugins/officialPluginVersions'

// navide.git lives in its own repository (Navide-dev/navide-git) and pins the
// bridge contract version it was built against. The Host serves the contract
// in src/shared/gitBridgeContract.json; a Host change bumps its version
// (src/main/plugins/gitBridgeContract.test.ts freezes each one).
const hostContract = JSON.parse(readFileSync('src/shared/gitBridgeContract.json', 'utf8')) as { version: string }

describe('navide.git bridge contract versions', () => {
  it('the Host serves the contract the pinned navide.git was built against', () => {
    expect(gitBridgeCompatible(hostContract.version, PINNED_GIT_BRIDGE_VERSION)).toBe(true)
  })

  it('accepts the same version', () => {
    expect(gitBridgeCompatible('1.0.0', '1.0.0')).toBe(true)
    expect(gitBridgeCompatible('1.2.3', '1.2.3')).toBe(true)
  })

  it('accepts a newer Host minor or patch', () => {
    expect(gitBridgeCompatible('1.1.0', '1.0.0')).toBe(true)
    expect(gitBridgeCompatible('1.0.1', '1.0.0')).toBe(true)
    expect(gitBridgeCompatible('1.2.0', '1.1.9')).toBe(true)
  })

  it('refuses an older Host minor or patch', () => {
    expect(gitBridgeCompatible('1.0.0', '1.1.0')).toBe(false)
    expect(gitBridgeCompatible('1.1.0', '1.1.1')).toBe(false)
  })

  it('refuses a different major either way', () => {
    expect(gitBridgeCompatible('2.0.0', '1.0.0')).toBe(false)
    expect(gitBridgeCompatible('1.9.9', '2.0.0')).toBe(false)
  })

  it('refuses a malformed version', () => {
    expect(gitBridgeCompatible('1.0', '1.0.0')).toBe(false)
    expect(gitBridgeCompatible('1.0.0', 'v1.0.0')).toBe(false)
  })
})
