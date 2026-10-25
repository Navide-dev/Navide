import { describe, expect, it } from 'vitest'
import { capabilitiesV1, parseManifestV2, type PluginSystemNamespace } from '../../../packages/plugin-contracts/src/index'
import { executionPolicyAllows, planPublicCapabilityCall } from './pluginCapabilityBroker'
import { PUBLIC_CAPABILITY_CATALOG } from './pluginCapabilityCatalog'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import { AGENTS_METHODS, validateAgentsOperation, validateAgentsRequest } from './agentsCapability'
import { SENSITIVE_CAPABILITIES } from './pluginVerify'

const binding = {
  pluginId: 'acme.agentmap',
  packageVersion: '1.0.0',
  workspaceId: 'workspace-1',
  instanceId: 'instance-1',
  audience: 'main',
}

function call(address: string, args: Record<string, unknown> = {}) {
  const [ns, method] = address.split('.')
  return { pluginId: binding.pluginId, ns: ns!, method: method!, args, reqId: `req-${address}` }
}

function context(system: PluginSystemNamespace[], overrides: Record<string, unknown> = {}) {
  return {
    publisherEligible: false,
    userGrant: { packageVersion: binding.packageVersion, system },
    runtimeBinding: binding,
    ...overrides,
  }
}

const agent = { kind: 'agent', source: 'mcp', id: 'agent-1' } as const

function policySnapshot(mode: 'full' | 'allowlist' | 'denylist', system: string[]) {
  return { policy: { schemaVersion: 1, mode, system, shell: [] }, revision: 1, state: 'user' } as never
}

describe('agents capability catalog', () => {
  it('lists the read-only surface, and the JSON catalog agrees on every permission', () => {
    expect(AGENTS_METHODS).toEqual([
      'agents.listPanes', 'agents.lineage', 'agents.listMessages', 'agents.listSessions', 'agentMessages.read',
    ])
    const json = capabilitiesV1 as { methods: Array<{ address: string; permission: unknown; requiresUserGesture?: boolean }> }
    for (const address of AGENTS_METHODS) {
      const namespace = address.startsWith('agentMessages.') ? 'agentMessages' : 'agents'
      expect(PUBLIC_CAPABILITY_CATALOG[address]).toMatchObject({
        kind: 'method', namespace, scope: 'workspace', eligibility: 'public',
      })
      const entry = json.methods.find((method) => method.address === address)
      expect(entry?.permission).toEqual({ id: 'system', access: namespace, scope: 'workspace' })
      expect(entry?.requiresUserGesture).toBeUndefined()
    }
  })

  it('keeps message text out of the metadata results', () => {
    const json = capabilitiesV1 as { methods: Array<{ address: string; result: unknown }> }
    for (const address of AGENTS_METHODS.filter((item) => item.startsWith('agents.'))) {
      const result = JSON.stringify(json.methods.find((method) => method.address === address)?.result)
      for (const key of ['"body"', '"content"', '"excerpt"', '"transcript"', '"profileId"', '"usage"']) {
        expect(result).not.toContain(key)
      }
    }
  })

  it('marks only message text as sensitive', () => {
    expect(SENSITIVE_CAPABILITIES).toContain('agentMessages')
    expect(SENSITIVE_CAPABILITIES).not.toContain('agents')
  })
})

describe('agents request validation', () => {
  it.each([
    ['agents.listPanes', {}],
    ['agents.lineage', { includeRemoved: true }],
    ['agents.listMessages', { paneId: 'p1', since: 0, limit: 200 }],
    ['agents.listSessions', { limit: 1 }],
    ['agentMessages.read', { id: 'm1' }],
  ])('accepts %s %j', (address, args) => {
    expect(validateAgentsRequest(address, args)).toBe(true)
  })

  it.each([
    ['agents.listPanes', { workspacePath: '/other' }],
    ['agents.lineage', { includeRemoved: 'yes' }],
    ['agents.listMessages', { limit: 0 }],
    ['agents.listMessages', { limit: 201 }],
    ['agents.listMessages', { since: -1 }],
    ['agents.listMessages', { paneId: '' }],
    ['agents.listSessions', { cursor: 'x' }],
    ['agentMessages.read', {}],
    ['agentMessages.read', { id: 'm1', workspace: '/other' }],
    ['agents.readTranscript', {}],
  ])('refuses %s %j', (address, args) => {
    expect(validateAgentsRequest(address, args)).toBe(false)
  })

  it('validates Bridge operations by backend name', () => {
    expect(validateAgentsOperation('read_message', { id: 'm1' })).toBe(true)
    expect(validateAgentsOperation('read_log', {})).toBe(false)
    expect(validateAgentsOperation('list_panes', null)).toBe(false)
  })
})

describe('agents broker decisions', () => {
  const policy = manifestV2CapabilityPolicy({ system: ['agents', 'agentMessages'] })

  it('allows metadata with the agents grant and message text only with agentMessages', () => {
    expect(planPublicCapabilityCall(call('agents.listPanes'), policy, context(['agents'])))
      .toMatchObject({ kind: 'allow', plan: { address: 'agents.listPanes', scope: 'workspace' } })
    expect(planPublicCapabilityCall(call('agentMessages.read', { id: 'm1' }), policy, context(['agents'])))
      .toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
    expect(planPublicCapabilityCall(call('agentMessages.read', { id: 'm1' }), policy, context(['agents', 'agentMessages'])))
      .toMatchObject({ kind: 'allow' })
  })

  it('refuses an undeclared namespace and a missing grant', () => {
    const metadataOnly = manifestV2CapabilityPolicy({ system: ['agents'] })
    expect(planPublicCapabilityCall(call('agentMessages.read', { id: 'm1' }), metadataOnly, context(['agents', 'agentMessages'])))
      .toMatchObject({ kind: 'deny' })
    expect(planPublicCapabilityCall(call('agents.listPanes'), policy, context(['ui'])))
      .toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
    expect(planPublicCapabilityCall(call('agents.listPanes'), policy, context(['agents'], { userGrant: null })))
      .toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('needs a workspace binding', () => {
    expect(planPublicCapabilityCall(
      call('agents.listPanes'), policy, context(['agents'], { runtimeBinding: { ...binding, workspaceId: null } }),
    )).toMatchObject({ kind: 'deny', response: { error: { code: 'WORKSPACE_SCOPE_VIOLATION' } } })
  })

  it('never gives an agent agent data or message text by omission from a policy', () => {
    expect(executionPolicyAllows(agent, policySnapshot('denylist', []), 'agentMessages')).toBe(false)
    expect(executionPolicyAllows(agent, policySnapshot('allowlist', ['agents']), 'agentMessages')).toBe(false)
    expect(executionPolicyAllows(agent, policySnapshot('allowlist', ['agentMessages']), 'agentMessages')).toBe(true)
    expect(executionPolicyAllows(agent, policySnapshot('full', []), 'agentMessages')).toBe(true)
    // Metadata is never admitted by omission either: a denylist predating it never names it.
    expect(executionPolicyAllows(agent, policySnapshot('denylist', []), 'agents')).toBe(false)
    expect(executionPolicyAllows(agent, policySnapshot('denylist', ['agents']), 'agents')).toBe(false)
    expect(executionPolicyAllows(agent, policySnapshot('allowlist', ['agents']), 'agents')).toBe(true)
    expect(executionPolicyAllows(agent, policySnapshot('full', []), 'agents')).toBe(true)
  })
})

describe('agents manifest declaration', () => {
  const manifest = (system: string[]) => ({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.agentmap',
    name: 'Agent Map',
    version: '1.0.0',
    publisher: 'acme',
    permissions: { system },
    marketplace: { description: 'Agent map', license: 'MIT' },
    contributes: { views: [{ id: 'main', kind: 'custom', location: 'window', title: 'Agent Map', entry: 'index.html' }] },
  })

  it('accepts agents alone and agentMessages beside agents', () => {
    expect(parseManifestV2(manifest(['agents'])).permissions.system).toEqual(['agents'])
    expect(parseManifestV2(manifest(['fs', 'ui', 'aiCli', 'web', 'agents', 'agentMessages'])).permissions.system)
      .toHaveLength(6)
  })

  it('refuses message text without the agent metadata it belongs to', () => {
    expect(() => parseManifestV2(manifest(['agentMessages']))).toThrow(/agentMessages without agents/)
  })
})
