import { expect, it } from 'vitest'
import { CLI_AGENT_SPECS } from './agentSpecs'
import { CLI_AGENT_SPECS as liveSpecs } from '../../../../src/renderer/src/platform/plugin-shell/agents'

// The retained copy is the frozen v1 picker: the CLIs main had, and nothing
// added since. A CLI declared later is in the live list but not here, and
// needs no edit here, so only the recorded keys are compared.
it('preserves the exact retained v1 execution picker order, labels and hints', () => {
  const recorded = CLI_AGENT_SPECS.map((spec) => spec.agentKey)
  const live = liveSpecs.map(({ agentKey, label, hint }) => ({ agentKey, label, hint }))
  // Every recorded CLI is still there, and in the order v1 listed them.
  expect(recorded.filter((key) => !live.some((spec) => spec.agentKey === key))).toEqual([])
  expect(live.filter((spec) => recorded.includes(spec.agentKey))).toEqual(CLI_AGENT_SPECS)
})
