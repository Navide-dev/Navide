import { expect, it } from 'vitest'
import { CLI_AGENT_SPECS } from './agentSpecs'
import { CLI_AGENT_SPECS as retainedSpecs } from '../../../../src/renderer/src/platform/plugin-shell/agents'

it('preserves the exact retained v1 execution picker order, labels and hints', () => {
  expect(CLI_AGENT_SPECS).toEqual(retainedSpecs.map(({ agentKey, label, hint }) => ({ agentKey, label, hint })))
})
