import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_CAPABILITY_PROGRESS_MESSAGE,
  AGENT_CAPABILITY_REQUEST_CHUNK_EVENT,
  AGENT_TOOL_CHUNK_IDLE_MS,
  AGENT_TOOL_DEFAULT_TIMEOUT_MS,
  AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE,
  AGENT_TOOL_CHUNK_BYTES,
  AGENT_TOOL_MAX_TIMEOUT_MS,
  AGENT_TOOL_STABILITY_CAP_BYTES,
  BACKEND_WIRE_ARGUMENT_CHUNK_METHOD,
  BACKEND_WIRE_ARGUMENT_CHUNKS_KEY,
  BACKEND_WIRE_RESULT_CHUNK_METHOD,
  BACKEND_WIRE_RESULT_CHUNKS_KEY,
  CORE_TOOL_NAMES,
  PLUGIN_APPROVAL_DECIDE_ACTION,
  RESERVED_TOOL_PREFIXES,
  agentToolResultBytes,
  deriveAgentToolPrefix,
  isValidAgentToolText,
  reassembleAgentToolPayloadText,
  sanitizeAgentToolResultText,
  splitAgentToolPayloadText,
  utf8ByteLength,
  validateAgentToolName,
  validateAgentTools,
} from './pluginAgentTools'
import type { AgentToolProgressMessage, AgentToolTimeoutReason } from './pluginAgentTools'
import { canonicalContractJson } from './pluginDisclosure'

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

describe('chunked transfer of results and arguments (no size cap, section 4.4)', () => {
  const chunking = load('payload-chunking.json') as {
    constants: Record<string, string | number>
    splits: Case<{ name: string; text: string; maxBytes: number; expected: string[] }>
    reassembly: Case<{ name: string; chunks: Array<{ seq: unknown; data: unknown }>; summary: unknown; chunkBytes: number; expected: unknown }>
    arguments: Case<{ name: string; arguments: unknown; text: string; maxBytes: number; expected: string[] }>
    argumentsDigest: Case<{ name: string; arguments: unknown; canonical: boolean; bytes: number; sha256: string }>
  }

  it('pins the transport constants to the shared fixture', () => {
    expect({
      chunkBytes: AGENT_TOOL_CHUNK_BYTES,
      wireResultChunkMethod: BACKEND_WIRE_RESULT_CHUNK_METHOD,
      wireResultChunksKey: BACKEND_WIRE_RESULT_CHUNKS_KEY,
      wireArgumentChunkMethod: BACKEND_WIRE_ARGUMENT_CHUNK_METHOD,
      wireArgumentChunksKey: BACKEND_WIRE_ARGUMENT_CHUNKS_KEY,
      wsResultChunkMessage: AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE,
      wsRequestChunkEvent: AGENT_CAPABILITY_REQUEST_CHUNK_EVENT,
      invalidCode: 'PLUGIN_TOOL_CHUNKS_INVALID',
      wsProgressMessage: AGENT_CAPABILITY_PROGRESS_MESSAGE,
      chunkIdleMs: AGENT_TOOL_CHUNK_IDLE_MS,
      timeoutReasons: ['execution', 'transfer-idle'] satisfies AgentToolTimeoutReason[],
      progressPhases: ['arguments', 'execution', 'result'] satisfies AgentToolProgressMessage['phase'][],
    }).toEqual(chunking.constants)
  })

  it('keeps a fully escaped piece inside a 1 MiB child frame reader in both directions', () => {
    // The built-in Plans backend's reader; read as text because it is Python.
    const plans = readFileSync(join(process.cwd(), 'plugins/navide-plans/backend/plans_backend.py'), 'utf8')
    const frame = Number(/^MAX_FRAME_BYTES = ([\d_]+)$/m.exec(plans)?.[1]?.replace(/_/g, ''))
    expect(frame).toBe(1_048_576)
    for (const method of [BACKEND_WIRE_RESULT_CHUNK_METHOD, BACKEND_WIRE_ARGUMENT_CHUNK_METHOD]) {
      const worst = JSON.stringify({
        jsonrpc: '2.0', method,
        params: { requestId: 'x'.repeat(64), seq: Number.MAX_SAFE_INTEGER, data: '\u0001'.repeat(AGENT_TOOL_CHUNK_BYTES) },
      })
      expect(utf8ByteLength(worst) + 1).toBeLessThan(frame)
    }
  })

  it.each(chunking.splits)('splits: $name', ({ text, maxBytes, expected }) => {
    const pieces = splitAgentToolPayloadText(text, maxBytes)
    expect(pieces).toEqual(expected)
    expect(pieces.every((p) => utf8ByteLength(p) <= maxBytes)).toBe(true)
  })

  it('refuses a piece size that cannot hold every code point', () => {
    expect(() => splitAgentToolPayloadText('abc', 3)).toThrow(RangeError)
  })

  it.each(chunking.reassembly)('reassembles: $name', ({ chunks, summary, chunkBytes, expected }) => {
    expect(reassembleAgentToolPayloadText(chunks, summary, chunkBytes)).toEqual(expected)
  })

  it.each(chunking.arguments)('cuts arguments from the shared compact spelling: $name', ({ arguments: args, text, maxBytes, expected }) => {
    expect(JSON.stringify(args)).toBe(text)
    const pieces = splitAgentToolPayloadText(text, maxBytes)
    expect(pieces).toEqual(expected)
    const joined = reassembleAgentToolPayloadText(pieces.map((data, seq) => ({ seq, data })), { chunks: pieces.length, bytes: utf8ByteLength(text) }, maxBytes)
    expect(JSON.parse((joined as { text: string }).text)).toEqual(args)
  })

  it.each(chunking.argumentsDigest)('counts args_bytes like resultBytes: $name', ({ arguments: args, bytes }) => {
    expect(utf8ByteLength(JSON.stringify(args))).toBe(bytes)
  })

  it.each(chunking.argumentsDigest.filter((c) => c.canonical))('hashes args_sha256 over the canonical spelling: $name', ({ arguments: args, sha256 }) => {
    // src/shared has no hash function; node:crypto is fine in this test file only.
    expect(createHash('sha256').update(canonicalContractJson(args), 'utf8').digest('hex')).toBe(sha256)
  })

  // Both directions cut and join with the same two functions, so one run covers results and arguments.
  it('carries a 10 MiB result or argument object intact with no cap and discloses its size', () => {
    const value = { rows: Array.from({ length: 42_000 }, (_, i) => `row ${i} 中文 😀 ${'x'.repeat(230)}`) }
    const text = JSON.stringify(value)
    const bytes = agentToolResultBytes(value)
    expect(bytes).toBe(utf8ByteLength(text))
    expect(bytes).toBeGreaterThan(10 * 1_048_576)
    const pieces = splitAgentToolPayloadText(text)
    expect(pieces.length).toBeGreaterThanOrEqual(Math.ceil(bytes / AGENT_TOOL_CHUNK_BYTES))
    expect(pieces.every((p) => utf8ByteLength(p) <= AGENT_TOOL_CHUNK_BYTES)).toBe(true)
    const shuffled = pieces.map((data, seq) => ({ seq, data })).reverse()
    const joined = reassembleAgentToolPayloadText(shuffled, { chunks: pieces.length, bytes })
    expect(joined).toEqual({ ok: true, text })
    expect(JSON.parse((joined as { text: string }).text)).toEqual(value)
  }, 60_000)

  it('measures an absent result as JSON null', () => {
    expect(agentToolResultBytes(undefined)).toBe(4)
    expect(agentToolResultBytes(null)).toBe(4)
  })
})
