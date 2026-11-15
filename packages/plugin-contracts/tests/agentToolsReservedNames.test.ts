import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CORE_TOOL_NAMES, RESERVED_TOOL_PREFIXES } from '../src/agentToolsValidation'

// The names a plugin's agent tool may not take: the same fixture the Host
// (src/shared/pluginAgentTools.test.ts), the backend and the Registry check
// themselves against, so a validation run with this package agrees with them.
describe('reserved agent tool names', () => {
  const reserved = JSON.parse(
    readFileSync('docs/plugin-contracts/agent-tools-fixtures/reserved-names-v1.json', 'utf8'),
  ) as { reservedPrefixes: string[]; coreToolNames: string[] }

  it('match the shared contract fixture', () => {
    expect([...RESERVED_TOOL_PREFIXES]).toEqual(reserved.reservedPrefixes)
    expect([...CORE_TOOL_NAMES]).toEqual(reserved.coreToolNames)
  })
})
