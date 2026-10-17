import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_TOOL_DEFAULT_TIMEOUT_MS,
  AGENT_TOOL_MAX_TIMEOUT_MS,
  AGENT_TOOL_STABILITY_CAP_BYTES,
  CORE_TOOL_NAMES,
  PLUGIN_APPROVAL_DECIDE_ACTION,
  RESERVED_TOOL_PREFIXES,
  deriveAgentToolPrefix,
  isValidAgentToolText,
  sanitizeAgentToolResultText,
  utf8ByteLength,
  validateAgentToolName,
  validateAgentTools,
} from './pluginAgentTools'

// The Python implementation (backend/agent_team_backend/plugins/agent_tools_contract.py)
// is held to the same fixtures by backend/tests/test_plugin_agent_tools_contract.py.
const FIXTURES = join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures')
const load = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
type Case<T> = T[]

describe('agent tool names', () => {
  const reserved = load('reserved-names-v1.json')
  const names = load('tool-names.json') as {
    prefixes: Case<{ pluginId: unknown; expectedPrefix: string | null }>
    names: Case<{ pluginId: unknown; name: unknown; expectedError: string | null }>
  }

  it('pins the reserved prefixes and the core tool names to the shared fixture', () => {
    expect([...RESERVED_TOOL_PREFIXES]).toEqual(reserved.reservedPrefixes)
    expect([...CORE_TOOL_NAMES]).toEqual(reserved.coreToolNames)
  })

  it.each(names.prefixes)('derives the prefix of $pluginId', ({ pluginId, expectedPrefix }) => {
    expect(deriveAgentToolPrefix(pluginId)).toBe(expectedPrefix)
  })

  it.each(names.names)('validates $name for $pluginId', ({ pluginId, name, expectedError }) => {
    expect(validateAgentToolName(name, pluginId)).toBe(expectedError)
  })
})

describe('agent tool text rules', () => {
  const texts = load('texts.json') as {
    texts: Case<{ value: unknown; valid: boolean }>
    results: Case<{ value: string; expected: string }>
    byteLengths: Case<{ value: string; expected: number }>
  }

  it.each(texts.texts)('accepts or refuses %j as title/description', ({ value, valid }) => {
    expect(isValidAgentToolText(value)).toBe(valid)
  })

  it.each(texts.results)('strips control characters from result %j', ({ value, expected }) => {
    expect(sanitizeAgentToolResultText(value)).toBe(expected)
  })

  it.each(texts.byteLengths)('counts %j in UTF-8 bytes', ({ value, expected }) => {
    expect(utf8ByteLength(value)).toBe(expected)
  })
})

describe('validateAgentTools', () => {
  const cases = load('agent-tools-validation.json').cases as Case<{ name: string; manifest: { id?: unknown; backend?: unknown }; expectedErrors: unknown[] }>

  it.each(cases)('$name', ({ manifest, expectedErrors }) => {
    expect(validateAgentTools(manifest)).toEqual(expectedErrors)
  })

  it('applies the DB9 1 MiB stability cap to the description and the input schema', () => {
    const big = 'x'.repeat(AGENT_TOOL_STABILITY_CAP_BYTES + 1)
    const tool = {
      name: 'devmap_read', method: 'devmap.read', risk: 'read', title: 'Read',
      description: big, inputSchema: { type: 'object', description: big },
    }
    const manifest = { id: 'nerdtechnic.devmap', backend: { methods: ['devmap.read'], agentTools: [tool] } }
    expect(validateAgentTools(manifest)).toEqual([
      { index: 0, field: 'description', code: 'AGENT_TOOL_TOO_LARGE' },
      { index: 0, field: 'inputSchema', code: 'AGENT_TOOL_TOO_LARGE' },
    ])
    const atCap = { ...tool, description: 'x'.repeat(AGENT_TOOL_STABILITY_CAP_BYTES), inputSchema: { type: 'object' } }
    expect(validateAgentTools({ ...manifest, backend: { ...manifest.backend, agentTools: [atCap] } })).toEqual([])
  })

  it('limits neither the number of tools nor the size of the whole declaration', () => {
    const tool = (index: number, size: number) => ({
      name: `devmap_t${index}`, method: 'devmap.read', risk: 'read', title: 'T',
      description: 'x'.repeat(size), inputSchema: { type: 'object' },
    })
    const manifest = (tools: unknown[]) => ({ id: 'nerdtechnic.devmap', backend: { methods: ['devmap.read'], agentTools: tools } })
    // Two tools of ~600 KiB: each item is under the per-field cap; the total
    // over 1 MiB is disclosed (count and size), not refused.
    const many = Array.from({ length: 2 }, (_, index) => tool(index, 600 * 1024))
    expect(validateAgentTools(manifest(many))).toEqual([])
    expect(validateAgentTools(manifest(Array.from({ length: 500 }, (_, index) => tool(index, 100))))).toEqual([])
  })

  it('keeps the timeout bounds of the existing Host backend call', () => {
    expect(AGENT_TOOL_DEFAULT_TIMEOUT_MS).toBe(30_000)
    // Read as text: src/shared is also compiled by the web project, which cannot import src/main.
    const limits = readFileSync(join(process.cwd(), 'src/main/plugins/pluginBackendLimits.ts'), 'utf8')
    const declared = /export const MAX_BACKEND_TIMEOUT_MS = ([\d_]+)/.exec(limits)?.[1]
    expect(Number(declared?.replace(/_/g, ''))).toBe(AGENT_TOOL_MAX_TIMEOUT_MS)
  })
})

describe('contract fragments', () => {
  it('has plugin-manifest-v2.schema.json (both copies) accept backend.agentTools exactly as the fragment', () => {
    const fragment = load('manifest-agent-tools.fragment.schema.json')
    for (const path of [
      'docs/plugin-contracts/plugin-manifest-v2.schema.json',
      'packages/plugin-contracts/src/schemas/plugin-manifest-v2.schema.json',
    ]) {
      const schema = JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'))
      expect(schema.$defs.backend.additionalProperties).toBe(false)
      const { description, ...field } = schema.$defs.backend.properties.agentTools
      expect(typeof description).toBe('string')
      expect(field).toEqual(fragment.backendProperties.agentTools)
      expect(schema.$defs.agentTool).toEqual(fragment.$defs.agentTool)
      expect(schema.$defs.agentToolText).toEqual(fragment.$defs.agentToolText)
    }
  })

  it('keeps the schema fragment consistent with the validator constants', () => {
    const fragment = load('manifest-agent-tools.fragment.schema.json')
    const tool = fragment.$defs.agentTool
    expect(tool.properties.timeoutMs).toEqual({
      type: 'integer', minimum: 1, maximum: AGENT_TOOL_MAX_TIMEOUT_MS, default: AGENT_TOOL_DEFAULT_TIMEOUT_MS,
    })
    expect(tool.required).toEqual(['name', 'method', 'risk', 'title', 'description', 'inputSchema'])
  })

  it('names the trust-confirm action the B2 decide handler will require', () => {
    expect(PLUGIN_APPROVAL_DECIDE_ACTION).toBe('plugins.agent_request.decide')
  })
})
