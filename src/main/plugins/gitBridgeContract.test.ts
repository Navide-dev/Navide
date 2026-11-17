import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import contract from '../../shared/gitBridgeContract.json'
import { HOST_GIT_EVENT_TYPES, HOST_GIT_REQUEST_TYPES } from '../../shared/gitCompatibility'
import { CAP_EVENTS, CAP_MAP } from './capabilityMap'

// The Host side of the navide.git bridge contract (src/shared/gitBridgeContract.json).
// navide.git ships through the Navide Marketplace on its own schedule, so an
// installed copy may meet a newer or older Host: what the Host serves on the
// bridge changes only with the contract's version. The plugin checks its own
// copy in plugins/navide-git/src/__tests__/gitBridgeContract.test.ts.

// One digest per released contract version. Changing the messages without a
// new version (and a new line here) fails; a minor version may only add.
const FROZEN: Record<string, string> = {
  '1.0.0': 'e5662703a772cf81a61047764c8e87feac60164cb95014b7f4e5fff1b517c7ec',
}
const digest = (value: { requests: string[]; events: string[] }): string =>
  createHash('sha256').update(JSON.stringify({ requests: value.requests, events: value.events })).digest('hex')

describe('navide.git bridge contract, Host side', () => {
  it('is frozen at its version', () => {
    expect(contract.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(FROZEN[contract.version], `record ${contract.version} in FROZEN`).toBe(digest(contract))
    expect([...contract.requests].sort()).toEqual(contract.requests)
    expect([...contract.events].sort()).toEqual(contract.events)
  })

  it('maps exactly the contract requests on the git.request bridge', () => {
    const mapped = Object.keys(CAP_MAP).filter((key) => key.startsWith('git.')).sort()
    expect(mapped).toEqual(contract.requests)
    for (const type of contract.requests) expect(CAP_MAP[type], type).toBe(type)
  })

  it('forwards every contract event', () => {
    for (const event of contract.events) expect(CAP_EVENTS[event], event).toBeDefined()
    expect([...HOST_GIT_EVENT_TYPES].sort()).toEqual(contract.events)
  })

  it('has a backend handler for every request and an emitter for every event', () => {
    const backend = execFileSync('git', ['ls-files', '--', 'backend/agent_team_backend/*.py'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map((file) => readFileSync(file, 'utf8')).join('\n')
    const handled = new Set([...backend.matchAll(/@handler\("(git\.[a-z_]+)"\)/g)].map((match) => match[1]))
    expect(contract.requests.filter((type) => !handled.has(type))).toEqual([])
    for (const event of contract.events) expect(backend.includes(`"${event}"`), event).toBe(true)
  })

  it('keeps the legacy recovery inventory inside the contract', () => {
    expect(HOST_GIT_REQUEST_TYPES.filter((type) => !contract.requests.includes(type))).toEqual([])
  })
})
