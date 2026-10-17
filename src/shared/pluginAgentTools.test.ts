import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_TOOL_DEFAULT_TIMEOUT_MS,
  AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE,
  AGENT_TOOL_MAX_TIMEOUT_MS,
  AGENT_TOOL_RESULT_CHUNK_BYTES,
  AGENT_TOOL_STABILITY_CAP_BYTES,
  BACKEND_WIRE_RESULT_CHUNK_METHOD,
  BACKEND_WIRE_RESULT_CHUNKS_KEY,
  CORE_TOOL_NAMES,
  PLUGIN_APPROVAL_DECIDE_ACTION,
  RESERVED_TOOL_PREFIXES,
  agentToolResultBytes,
  deriveAgentToolPrefix,
  isValidAgentToolText,
  reassembleAgentToolResultText,
  sanitizeAgentToolResultText,
  splitAgentToolResultText,
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

  it('keeps the timeout bounds of the existing Host backend call', () => {
    expect(AGENT_TOOL_DEFAULT_TIMEOUT_MS).toBe(30_000)
    // Read as text: src/shared is also compiled by the web project, which cannot import src/main.
    const limits = readFileSync(join(process.cwd(), 'src/main/plugins/pluginBackendLimits.ts'), 'utf8')
    const declared = /export const MAX_BACKEND_TIMEOUT_MS = ([\d_]+)/.exec(limits)?.[1]
    expect(Number(declared?.replace(/_/g, ''))).toBe(AGENT_TOOL_MAX_TIMEOUT_MS)
  })
})

describe('contract fragments that are not wired yet', () => {
  it('leaves plugin-manifest-v2.schema.json refusing backend.agentTools until B1-a', () => {
    const schema = JSON.parse(readFileSync(join(process.cwd(), 'docs/plugin-contracts/plugin-manifest-v2.schema.json'), 'utf8'))
    expect(schema.$defs.backend.additionalProperties).toBe(false)
    expect(schema.$defs.backend.properties).not.toHaveProperty('agentTools')
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

describe('chunked result transfer (DB9 decision a: no result cap)', () => {
  const chunking = load('result-chunking.json') as {
    constants: Record<string, string | number>
    splits: Case<{ name: string; text: string; maxBytes: number; expected: string[] }>
    reassembly: Case<{ name: string; chunks: Array<{ seq: unknown; data: unknown }>; summary: unknown; expected: unknown }>
  }

  it('pins the transport constants to the shared fixture', () => {
    expect({
      chunkBytes: AGENT_TOOL_RESULT_CHUNK_BYTES,
      wireChunkMethod: BACKEND_WIRE_RESULT_CHUNK_METHOD,
      wireChunksKey: BACKEND_WIRE_RESULT_CHUNKS_KEY,
      wsChunkMessage: AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE,
      invalidCode: 'RESULT_CHUNKS_INVALID',
    }).toEqual(chunking.constants)
  })

  it('keeps a fully escaped piece inside one Backend Wire frame', () => {
    // Read as text: src/shared is also compiled by the web project, which cannot import src/main.
    const supervisor = readFileSync(join(process.cwd(), 'src/main/plugins/pluginBackendSupervisor.ts'), 'utf8')
    const frame = Number(/maxFrameBytes \?\? ([\d_]+)/.exec(supervisor)?.[1]?.replace(/_/g, ''))
    expect(frame).toBeGreaterThan(0)
    const worst = JSON.stringify({
      jsonrpc: '2.0', method: BACKEND_WIRE_RESULT_CHUNK_METHOD,
      params: { requestId: 'x'.repeat(64), seq: Number.MAX_SAFE_INTEGER, data: '\u0001'.repeat(AGENT_TOOL_RESULT_CHUNK_BYTES) },
    })
    expect(utf8ByteLength(worst) + 1).toBeLessThan(frame)
  })

  it.each(chunking.splits)('splits: $name', ({ text, maxBytes, expected }) => {
    const pieces = splitAgentToolResultText(text, maxBytes)
    expect(pieces).toEqual(expected)
    expect(pieces.every((p) => utf8ByteLength(p) <= maxBytes)).toBe(true)
  })

  it('refuses a piece size that cannot hold every code point', () => {
    expect(() => splitAgentToolResultText('abc', 3)).toThrow(RangeError)
  })

  it.each(chunking.reassembly)('reassembles: $name', ({ chunks, summary, expected }) => {
    expect(reassembleAgentToolResultText(chunks, summary)).toEqual(expected)
  })

  it('carries a 10 MiB result intact with no cap and discloses its size', () => {
    const result = { rows: Array.from({ length: 42_000 }, (_, i) => `row ${i} 中文 😀 ${'x'.repeat(230)}`) }
    const text = JSON.stringify(result)
    const bytes = agentToolResultBytes(result)
    expect(bytes).toBe(utf8ByteLength(text))
    expect(bytes).toBeGreaterThan(10 * 1_048_576)
    const pieces = splitAgentToolResultText(text)
    expect(pieces.length).toBeGreaterThanOrEqual(Math.ceil(bytes / AGENT_TOOL_RESULT_CHUNK_BYTES))
    expect(pieces.every((p) => utf8ByteLength(p) <= AGENT_TOOL_RESULT_CHUNK_BYTES)).toBe(true)
    const shuffled = pieces.map((data, seq) => ({ seq, data })).reverse()
    const joined = reassembleAgentToolResultText(shuffled, { chunks: pieces.length, bytes })
    expect(joined).toEqual({ ok: true, text })
    expect(JSON.parse((joined as { text: string }).text)).toEqual(result)
  })

  it('measures an absent result as JSON null', () => {
    expect(agentToolResultBytes(undefined)).toBe(4)
    expect(agentToolResultBytes(null)).toBe(4)
  })
})
