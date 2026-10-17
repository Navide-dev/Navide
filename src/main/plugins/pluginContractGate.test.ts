import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseExecutionPolicyJson,
  parseManifestJson as parsePublicManifestJson,
  parseManifestV2 as parsePublicManifestV2,
} from '../../../packages/plugin-contracts/src/index'
import {
  parseInstalledManifest,
  parseManifestJson as parseHostManifestJson,
} from './pluginManifest'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import { planPublicCapabilityCall } from './pluginCapabilityBroker'
import { parseBackendWireFrame, parseBackendWireHostFrame } from './pluginBackendSupervisor'
import { readManifestFromEntries, type ZipEntry } from './pluginPackage'

const CONTRACT_FIXTURES = join(process.cwd(), 'docs/plugin-contracts')
const MANIFEST_FIXTURES = join(CONTRACT_FIXTURES, 'fixtures')
const POLICY_FIXTURES = join(CONTRACT_FIXTURES, 'execution-policy-fixtures')
const WIRE_FIXTURES = join(CONTRACT_FIXTURES, 'backend-wire-fixtures')
const BACKEND_WIRE_CHILD = fileURLToPath(new URL('./test-fixtures/backend-wire-child.mjs', import.meta.url))

const validManifestFixtures = readdirSync(join(MANIFEST_FIXTURES, 'valid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const invalidManifestFixtures = readdirSync(join(MANIFEST_FIXTURES, 'invalid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
// Agent-tools rules the manifest schema cannot express (contract section 2.6):
// the public parser mirrors the schema, so only the Host and package seams
// (and the Registry) refuse these.
const contractRuleOnlyManifestFixtures = new Set([
  'agent-tools-duplicate-name.json',
  'agent-tools-fractional-number.json',
  'agent-tools-method-undeclared.json',
  'agent-tools-prefix-mismatch.json',
  'agent-tools-reserved-prefix.json',
])
const rawManifestFixtures = readdirSync(join(MANIFEST_FIXTURES, 'invalid-raw'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const validExecutionPolicyFixtures = readdirSync(join(POLICY_FIXTURES, 'valid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const invalidExecutionPolicyFixtures = readdirSync(join(POLICY_FIXTURES, 'invalid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const rawExecutionPolicyFixtures = readdirSync(join(POLICY_FIXTURES, 'invalid-raw'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const validWireFixtures = readdirSync(join(WIRE_FIXTURES, 'valid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const invalidWireFixtures = readdirSync(join(WIRE_FIXTURES, 'invalid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const rawWireFixtures = readdirSync(join(WIRE_FIXTURES, 'invalid-raw'))
  .filter((name) => name.endsWith('.json'))
  .sort()

const childToHostWireFixtures = [
  'application-error-without-id.json',
  'error-with-server-info.json',
  'malformed-server-info.json',
  'missing-result-type.json',
  'missing-result-value.json',
  'missing-server-info.json',
  'result-chunk-without-request-id.json',
  'result-chunks-with-value.json',
  'subscription-close-missing-id.json',
]
const hostToChildWireFixtures = [
  'missing-mcp-meta.json',
  'null-request-id.json',
  'spoofed-runtime-context.json',
  'unknown-wire-method.json',
  'wrong-mcp-version.json',
]

function readFixture(group: string, name: string): string {
  return readFileSync(join(MANIFEST_FIXTURES, group, name), 'utf8')
}

function readExecutionPolicyFixture(group: string, name: string): string {
  return readFileSync(join(POLICY_FIXTURES, group, name), 'utf8')
}

function manifestEntry(raw: string): ZipEntry {
  return {
    path: 'manifest.json',
    data: Buffer.from(raw, 'utf8'),
    kind: 'file',
    type: 'regular',
    executable: false,
  }
}

function runtimeContext() {
  return {
    publisherEligible: false,
    userGrant: {
      packageVersion: '1.0.0',
      system: ['fs', 'ui'] as const,
      shell: 'allowlist' as const,
    },
    runtimeBinding: {
      pluginId: 'acme.files',
      packageVersion: '1.0.0',
      workspaceId: 'workspace-1',
      instanceId: 'instance-1',
      audience: 'view-1',
    },
  }
}

describe('B0 integrated Manifest v2 corpus gate', () => {
  it.each(validManifestFixtures)('accepts %s through public, Host, and package seams', (name) => {
    const raw = readFixture('valid', name)
    const source = parsePublicManifestJson(raw)
    const publicManifest = parsePublicManifestV2(source)
    const hostManifest = parseInstalledManifest(source)
    const packageManifest = readManifestFromEntries([manifestEntry(raw)])

    expect(hostManifest).toEqual(publicManifest)
    expect(parseInstalledManifest(packageManifest)).toEqual(publicManifest)
  })

  it.each(invalidManifestFixtures)('rejects %s through public, Host, and package seams', (name) => {
    const raw = readFixture('invalid', name)
    const source = parsePublicManifestJson(raw)

    if (contractRuleOnlyManifestFixtures.has(name)) expect(() => parsePublicManifestV2(source)).not.toThrow()
    else expect(() => parsePublicManifestV2(source)).toThrow()
    expect(() => parseInstalledManifest(source)).toThrow()
    expect(() => parseInstalledManifest(readManifestFromEntries([manifestEntry(raw)]))).toThrow()
  })

  it.each(rawManifestFixtures)('rejects raw Manifest input %s before schema validation', (name) => {
    const raw = readFixture('invalid-raw', name)

    expect(() => parsePublicManifestJson(raw)).toThrow()
    expect(() => parseHostManifestJson(raw)).toThrow()
    expect(() => readManifestFromEntries([manifestEntry(raw)])).toThrow()
  })

  it('accepts the strict composition fields through public, Host, and package seams', () => {
    const manifest = JSON.parse(readFixture('valid', 'frontend-multi-view.json')) as Record<string, any>
    manifest.contributes.views = [
      {
        id: 'left', kind: 'custom', location: 'left', title: 'Left',
        entry: 'frontend/left/index.html', detailView: 'detail',
      },
      {
        id: 'detail', kind: 'custom', location: 'detail', title: 'Detail',
        entry: 'frontend/detail/index.html', targetSchema: 'schemas/item.json',
      },
      {
        id: 'window', kind: 'custom', location: 'window', title: 'Window',
        entry: 'frontend/window/index.html',
        receives: {
          protocolVersion: 1, locations: ['left', 'detail'],
          editorTargets: { protocolVersion: 1 }, closeGuard: { protocolVersion: 1 },
        },
      },
    ]
    const raw = JSON.stringify(manifest)
    const parsed = parsePublicManifestV2(parsePublicManifestJson(raw))

    expect(parsed.contributes?.views).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'left', detailView: 'detail' }),
      expect.objectContaining({ id: 'detail', targetSchema: 'schemas/item.json' }),
      expect.objectContaining({
        id: 'window',
        receives: {
          protocolVersion: 1, locations: ['left', 'detail'],
          editorTargets: { protocolVersion: 1 }, closeGuard: { protocolVersion: 1 },
        },
      }),
    ]))
    expect(parseInstalledManifest(parsed)).toEqual(parsed)
    expect(parseInstalledManifest(readManifestFromEntries([manifestEntry(raw)]))).toEqual(parsed)
  })

  it.each([
    ['detailView on a non-left view', (manifest: Record<string, any>) => { manifest.contributes.views[0].detailView = 'detail' }],
    ['targetSchema on a non-detail view', (manifest: Record<string, any>) => { manifest.contributes.views[0].targetSchema = 'schemas/item.json' }],
    ['receives on a non-window view', (manifest: Record<string, any>) => { manifest.contributes.views[0].receives = { protocolVersion: 1, locations: ['left'] } }],
    ['unsafe targetSchema', (manifest: Record<string, any>) => { manifest.contributes.views[0].location = 'detail'; manifest.contributes.views[0].targetSchema = '../item.json' }],
    ['unknown receives field', (manifest: Record<string, any>) => { manifest.contributes.views[0].location = 'window'; manifest.contributes.views[0].receives = { protocolVersion: 1, locations: ['left'], extra: true } }],
    ['unsupported closeGuard version', (manifest: Record<string, any>) => { manifest.contributes.views[0].location = 'window'; manifest.contributes.views[0].receives = { protocolVersion: 1, locations: ['left'], closeGuard: { protocolVersion: 2 } } }],
    ['unknown closeGuard field', (manifest: Record<string, any>) => { manifest.contributes.views[0].location = 'window'; manifest.contributes.views[0].receives = { protocolVersion: 1, locations: ['left'], closeGuard: { protocolVersion: 1, onPrepare: 'nope' } } }],
    ['closeGuard without locations', (manifest: Record<string, any>) => { manifest.contributes.views[0].location = 'window'; manifest.contributes.views[0].receives = { protocolVersion: 1, closeGuard: { protocolVersion: 1 } } }],
  ])('rejects %s through public, Host, and package seams', (_name, mutate) => {
    const manifest = JSON.parse(readFixture('valid', 'frontend-multi-view.json')) as Record<string, any>
    mutate(manifest)
    const raw = JSON.stringify(manifest)
    expect(() => parsePublicManifestV2(parsePublicManifestJson(raw))).toThrow()
    expect(() => parseInstalledManifest(JSON.parse(raw))).toThrow()
  })
})

describe('Global agent Execution Policy contract gate', () => {
  it.each(validExecutionPolicyFixtures)('accepts valid fixture %s at the public parser seam', (name) => {
    expect(() => parseExecutionPolicyJson(readExecutionPolicyFixture('valid', name))).not.toThrow()
  })

  it.each(invalidExecutionPolicyFixtures)('rejects invalid fixture %s at the public parser seam', (name) => {
    expect(() => parseExecutionPolicyJson(readExecutionPolicyFixture('invalid', name))).toThrow()
  })

  it.each(rawExecutionPolicyFixtures)('rejects raw fixture %s before policy validation', (name) => {
    expect(() => parseExecutionPolicyJson(readExecutionPolicyFixture('invalid-raw', name))).toThrow()
  })
})

describe('B0 capability and Backend Wire contract gate', () => {
  it('allows declared fs/Git access and denies unsafe or undeclared shell calls', () => {
    const manifest = parsePublicManifestV2(
      parsePublicManifestJson(readFixture('valid', 'frontend-multi-view.json'))
    )
    const policy = manifestV2CapabilityPolicy(manifest.permissions)
    const context = runtimeContext()

    const fsDecision = planPublicCapabilityCall(
      {
        pluginId: manifest.id,
        ns: 'fs',
        method: 'readFile',
        args: { path: 'README.md' },
        reqId: 'fs-1',
      },
      policy,
      context
    )
    expect(fsDecision.kind).toBe('allow')

    const gitDecision = planPublicCapabilityCall(
      {
        pluginId: manifest.id,
        ns: 'shell',
        method: 'run',
        args: { command: 'git status' },
        reqId: 'git-1',
      },
      policy,
      context
    )
    expect(gitDecision.kind).toBe('allow')

    const unsafeShellDecision = planPublicCapabilityCall(
      {
        pluginId: manifest.id,
        ns: 'shell',
        method: 'run',
        args: { command: 'python -c unsafe' },
        reqId: 'shell-1',
      },
      policy,
      context
    )
    expect(unsafeShellDecision).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'CAPABILITY_DENIED' } },
    })

    const undeclaredShellDecision = planPublicCapabilityCall(
      {
        pluginId: 'navide.skills',
        ns: 'shell',
        method: 'run',
        args: { command: 'git status' },
        reqId: 'shell-2',
      },
      manifestV2CapabilityPolicy({}),
      {
        publisherEligible: false,
        userGrant: { packageVersion: '1.0.0', system: [] },
        runtimeBinding: {
          pluginId: 'navide.skills',
          packageVersion: '1.0.0',
          workspaceId: 'workspace-1',
          instanceId: 'instance-1',
          audience: 'view-1',
        },
      }
    )
    expect(undeclaredShellDecision).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'CAPABILITY_DENIED' } },
    })
  })

  it.each(validWireFixtures)('accepts the valid Backend Wire frame %s at the Host framing seam', (name) => {
    const raw = readFileSync(join(WIRE_FIXTURES, 'valid', name), 'utf8').trimEnd()
    expect(() => parseBackendWireFrame(raw)).not.toThrow()
  })

  it('classifies every semantic-invalid Backend Wire fixture by direction', () => {
    expect([...childToHostWireFixtures, ...hostToChildWireFixtures].sort()).toEqual(invalidWireFixtures)
  })

  it.each(childToHostWireFixtures)('rejects child-to-Host semantic-invalid fixture %s at the Host seam', (name) => {
    const raw = readFileSync(join(WIRE_FIXTURES, 'invalid', name), 'utf8').trimEnd()

    expect(() => parseBackendWireHostFrame(raw)).toThrow(
      'Backend plugin returned an invalid protocol message.'
    )
  })

  it.each(hostToChildWireFixtures)('returns a stable child protocol error for Host-to-child fixture %s', (name) => {
    const raw = readFileSync(join(WIRE_FIXTURES, 'invalid', name), 'utf8').trimEnd()
    const input = JSON.parse(raw) as { id?: unknown }
    const result = spawnSync(process.execPath, [BACKEND_WIRE_CHILD], {
      encoding: 'utf8',
      input: `${raw}\n`,
      maxBuffer: 1_000_000,
      timeout: 5_000,
    })
    const expected: { jsonrpc: '2.0'; error: { code: -32600; message: 'Invalid request' }; id?: string | number } = {
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid request' },
    }
    if (
      (typeof input.id === 'string' && input.id.length > 0) ||
      (typeof input.id === 'number' && Number.isInteger(input.id))
    ) {
      expected.id = input.id
    }

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(result.stdout.trim())).toEqual(expected)
  })

  it('keeps runtime.initiator an additive optional field of Backend Wire v1', () => {
    const schema = JSON.parse(
      readFileSync(join(CONTRACT_FIXTURES, 'backend-wire-v1.schema.json'), 'utf8')
    ) as { $id: string; $defs: { runtime: { required: string[]; properties: Record<string, unknown> } } }
    const runtime = schema.$defs.runtime

    // The contract stays v1: `initiator` is defined (so `additionalProperties:
    // false` permits it) but not required (so a pre-initiator runtime frame,
    // which is what a backend vendored against the original v1 emits, is valid).
    expect(schema.$id).toBe('https://navide.dev/schemas/backend-wire-v1.schema.json')
    expect(runtime.properties.initiator).toBeDefined()
    expect(runtime.required).not.toContain('initiator')

    const legacyFrame = JSON.parse(
      readFileSync(join(WIRE_FIXTURES, 'valid', 'call-without-initiator.json'), 'utf8')
    ) as { params: { runtime: Record<string, unknown> } }
    const legacyKeys = Object.keys(legacyFrame.params.runtime)
    expect(legacyKeys).not.toContain('initiator')
    expect(runtime.required.every((key) => legacyKeys.includes(key))).toBe(true)
    expect(legacyKeys.every((key) => key in runtime.properties)).toBe(true)
  })

  it('answers a Backend Wire v1 call whose runtime omits the optional initiator', () => {
    const raw = readFileSync(join(WIRE_FIXTURES, 'valid', 'call-without-initiator.json'), 'utf8').trimEnd()
    const result = spawnSync(process.execPath, [BACKEND_WIRE_CHILD], {
      encoding: 'utf8',
      input: `${raw}\n`,
      maxBuffer: 1_000_000,
      timeout: 5_000,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const response = JSON.parse(result.stdout.trim()) as {
      id: string
      result?: { value?: { runtime?: unknown } }
      error?: unknown
    }
    expect(response.error).toBeUndefined()
    expect(response.id).toBe('req-2')
    expect(response.result?.value?.runtime).toEqual(
      (JSON.parse(raw) as { params: { runtime: unknown } }).params.runtime
    )
  })

  it('answers a call whose agent initiator carries the additive agent-tool caller', () => {
    const raw = readFileSync(join(WIRE_FIXTURES, 'valid', 'call-agent-tool-caller.json'), 'utf8').trimEnd()
    const result = spawnSync(process.execPath, [BACKEND_WIRE_CHILD], {
      encoding: 'utf8',
      input: `${raw}\n`,
      maxBuffer: 1_000_000,
      timeout: 5_000,
    })

    expect(result.status).toBe(0)
    const response = JSON.parse(result.stdout.trim()) as { id: string; error?: unknown; result?: { value?: { runtime?: unknown } } }
    expect(response.error).toBeUndefined()
    expect(response.id).toBe('req-3')
    expect(response.result?.value?.runtime).toEqual(
      (JSON.parse(raw) as { params: { runtime: unknown } }).params.runtime
    )
    const schema = JSON.parse(
      readFileSync(join(CONTRACT_FIXTURES, 'backend-wire-v1.schema.json'), 'utf8')
    ) as { $defs: { initiator: { oneOf: Array<{ required: string[]; properties: Record<string, unknown> }> } } }
    const agent = schema.$defs.initiator.oneOf[1]
    expect(agent.properties.caller).toBeDefined()
    expect(agent.required).not.toContain('caller')
  })

  it.each(rawWireFixtures)('rejects raw Backend Wire input %s at the Host framing seam', (name) => {
    const raw = readFileSync(join(WIRE_FIXTURES, 'invalid-raw', name), 'utf8')
    expect(() => parseBackendWireFrame(raw)).toThrow(
      'Backend plugin returned an invalid protocol message.'
    )
  })
})

describe('Manifest v2 filesystem scopes are disclosure only', () => {
  it('changes no capability policy or broker decision', () => {
    const scoped = parsePublicManifestV2(
      parsePublicManifestJson(readFixture('valid', 'fs-scopes-declared.json'))
    )
    const unscopedSource = parsePublicManifestJson(readFixture('valid', 'fs-scopes-declared.json')) as Record<string, any>
    delete unscopedSource.permissions.scopes
    const unscoped = parsePublicManifestV2(unscopedSource)
    expect(scoped.permissions.scopes).toBeDefined()

    const scopedPolicy = manifestV2CapabilityPolicy(scoped.permissions)
    const unscopedPolicy = manifestV2CapabilityPolicy(unscoped.permissions)
    expect(scopedPolicy).toEqual(unscopedPolicy)

    const context = {
      ...runtimeContext(),
      runtimeBinding: { ...runtimeContext().runtimeBinding, pluginId: scoped.id },
    }
    const calls = [
      { ns: 'fs', method: 'readFile', args: { path: '.acme/notes/today.md' } },
      { ns: 'fs', method: 'readFile', args: { path: 'outside-the-scope.md' } },
      { ns: 'fs', method: 'listDirectory', args: { path: '' } },
      { ns: 'ui', method: 'openInEditor', args: { path: 'docs/readme.md' } },
      { ns: 'shell', method: 'run', args: { command: 'git status' } },
    ]
    for (const [index, call] of calls.entries()) {
      const request = { pluginId: scoped.id, reqId: `scope-${index}`, ...call }
      expect(planPublicCapabilityCall(request, scopedPolicy, context)).toEqual(
        planPublicCapabilityCall(request, unscopedPolicy, context)
      )
    }
  })
})
