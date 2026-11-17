import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import contract from '../git-feature/gitBridgeContract.json'
import { GIT_BRIDGE_VERSION, GIT_EVENT_TYPES, GIT_REQUEST_TYPES } from '../git-feature/gitTransport'

// navide.git's copy of the bridge contract it was built against
// (../git-feature/gitBridgeContract.json). The Host checks its own copy in
// src/main/plugins/gitBridgeContract.test.ts; the two must stay identical
// (tests/infrastructure/gitBridgeContract.test.ts) while both live here.

const FROZEN: Record<string, string> = {
  '1.0.0': 'e5662703a772cf81a61047764c8e87feac60164cb95014b7f4e5fff1b517c7ec',
}
const digest = (value: { requests: string[]; events: string[] }): string =>
  createHash('sha256').update(JSON.stringify({ requests: value.requests, events: value.events })).digest('hex')

describe('navide.git bridge contract, plugin side', () => {
  it('is frozen at the version the transport declares', () => {
    expect(GIT_BRIDGE_VERSION).toBe(contract.version)
    expect(FROZEN[contract.version], `record ${contract.version} in FROZEN`).toBe(digest(contract))
  })

  it('sends only contract requests', () => {
    expect(GIT_REQUEST_TYPES.filter((type) => !contract.requests.includes(type))).toEqual([])
  })

  it('listens to exactly the contract events', () => {
    expect([...GIT_EVENT_TYPES].sort()).toEqual(contract.events)
  })
})
