import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CLI_AGENT_SPECS } from '../../src/renderer/src/platform/plugin-shell/agents'

// Values the pinned navide.plans version (Navide-dev/navide-plans) was built
// with and the Host relies on; navide-plans checks its own sources against the
// same values. Update tests/fixtures/navide-plans/ with the pin.
const contract = JSON.parse(readFileSync('tests/fixtures/navide-plans/contract.json', 'utf8')) as {
  agentSpecs: Array<{ agentKey: string; label: string; hint: string }>
}

describe('navide.plans, Host side', () => {
  it('keeps the retained v1 execution picker in step with the Host agent registry', () => {
    // Order, labels and hints of the picker Plans shows; a CLI added to the
    // Host needs a Plans release that lists it too.
    expect(contract.agentSpecs).toEqual(CLI_AGENT_SPECS.map(({ agentKey, label, hint }) => ({ agentKey, label, hint })))
  })
})
