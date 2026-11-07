import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentToolViewId, parseManifestV2, validateAgentTools } from '../src/index'

// Batch 4: `contributes.agentTools` lets a frontend-only package serve agent
// tools from one of its views (contract section 2.9). The parser, the JSON
// Schema (validate-fixtures.py), validateAgentTools and the Registry agree on
// the normative fixtures.

const FIXTURES = join(process.cwd(), 'docs/plugin-contracts/fixtures')
const read = (group: string, name: string): Record<string, any> => JSON.parse(readFileSync(join(FIXTURES, group, name), 'utf8'))

function refusal(raw: unknown): string {
  try {
    parseManifestV2(raw)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the manifest to be refused')
}

describe('contributes.agentTools', () => {
  it('parses the valid fixture and keeps the view binding', () => {
    const manifest = parseManifestV2(read('valid', 'view-agent-tools.json'))
    expect(manifest.backend).toBeUndefined()
    expect(manifest.contributes?.agentTools?.map((tool) => [tool.name, tool.view, tool.risk])).toEqual([
      ['hello_greet', 'main', 'read'], ['hello_note', 'main', 'write'],
    ])
    expect(validateAgentTools(manifest)).toEqual([])
  })

  it('refuses a tool that names an undeclared view, a method field, or a name a backend tool already uses', () => {
    const raw = read('valid', 'view-agent-tools.json')
    const other = structuredClone(raw)
    other.contributes.agentTools[0].view = 'side'
    expect(refusal(other)).toContain('is not a declared view')
    expect(refusal(read('invalid', 'view-agent-tool-method.json'))).toContain('method')
    const both = structuredClone(raw)
    both.backend = {
      entry: 'backend/hello', protocolVersion: 1, activation: 'startup', methods: ['hello.greet'],
      agentTools: [{ name: 'hello_greet', method: 'hello.greet', risk: 'read', title: 't', description: 'd', inputSchema: { type: 'object' } }],
    }
    expect(validateAgentTools(both)).toEqual([{ index: 0, field: 'name', code: 'AGENT_TOOL_NAME_DUPLICATE', list: 'contributes' }])
  })

  it('spells the view binding as method "view:<id>" and reads it back', () => {
    expect(agentToolViewId('view:main')).toBe('main')
    expect(agentToolViewId('hello.greet')).toBeNull()
    expect(agentToolViewId(undefined)).toBeNull()
  })
})
