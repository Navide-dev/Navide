import { expect, it } from 'vitest'
import { CLI_AGENT_SPECS } from './agentSpecs'
import { CLI_AGENT_SPECS as retainedSpecs } from '../../../../src/renderer/src/platform/plugin-shell/agents'

it('preserves the exact retained v1 execution picker order, labels and hints', () => {
  // Standalone agents (OpenClaw, Hermes Agent) are not coding CLIs and are
  // kept out of the execution picker, like the host's CLI dropdowns.
  const codingClis = retainedSpecs.filter((spec) => spec.category !== 'standalone')
  expect(CLI_AGENT_SPECS).toEqual(codingClis.map(({ agentKey, label, hint }) => ({ agentKey, label, hint })))
})
