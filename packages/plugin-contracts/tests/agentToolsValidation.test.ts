import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateAgentTools } from '../src/agentToolsValidation'

// The Registry (agent_tools_contract.py) and the Host (src/shared/pluginAgentTools.ts)
// are held to the same fixture.
const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/agent-tools-validation.json'), 'utf8')
)

describe('validateAgentTools', () => {
  it.each(fixture.cases as Array<{ name: string; manifest: { id?: unknown; backend?: unknown }; expectedErrors: unknown[] }>)(
    '$name', ({ manifest, expectedErrors }) => {
      expect(validateAgentTools(manifest)).toEqual(expectedErrors)
    })
})
