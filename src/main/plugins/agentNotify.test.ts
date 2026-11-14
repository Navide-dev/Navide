import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { capabilitiesV1, parseManifestV2 } from '../../../packages/plugin-contracts/src/index'
import { AgentNotifyLimiter, PluginNotifySwitchStore, validateAgentNotifyOperation, validateAgentNotifyRequest } from './agentNotify'
import { executionPolicyAllows, planPublicCapabilityCall } from './pluginCapabilityBroker'
import { PUBLIC_CAPABILITY_CATALOG } from './pluginCapabilityCatalog'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import { HOST_DEFAULT_EXECUTION_POLICY } from './executionPolicy'
import { SENSITIVE_CAPABILITIES } from './pluginVerify'
import { computeDisclosure } from '../../shared/pluginDisclosure'

const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('agentNotify.send (plan P4)', () => {
  it('takes a pane name, plain text of at most 2 KB and an optional reference, nothing else', () => {
    expect(validateAgentNotifyRequest('agentNotify.send', { to: 'dev', text: 'done' })).toBe(true)
    expect(validateAgentNotifyRequest('agentNotify.send', { to: 'dev', text: 'done', ref: 'job-7' })).toBe(true)
    expect(validateAgentNotifyRequest('agentNotify.send', { to: 'dev', text: 'é'.repeat(1024) })).toBe(true)
    expect(validateAgentNotifyRequest('agentNotify.send', { to: 'dev', text: 'é'.repeat(1025) })).toBe(false)
    expect(validateAgentNotifyRequest('agentNotify.send', { to: 'dev', text: '  ' })).toBe(false)
    expect(validateAgentNotifyRequest('agentNotify.send', { to: '', text: 'x' })).toBe(false)
    expect(validateAgentNotifyRequest('agentNotify.send', { to: 'dev', text: 'x', ref: 'r'.repeat(201) })).toBe(false)
    // The sender is the Host's to fill, never the plugin's.
    expect(validateAgentNotifyRequest('agentNotify.send', { to: 'dev', text: 'x', from: 'user' })).toBe(false)
    expect(validateAgentNotifyRequest('agentNotify.broadcast', { to: 'dev', text: 'x' })).toBe(false)
    expect(validateAgentNotifyOperation('send', { to: 'dev', text: 'x' })).toBe(true)
    expect(validateAgentNotifyOperation('send-all', { to: 'dev', text: 'x' })).toBe(false)
  })

  it('lets one plugin send 6 a minute, every pane together, apart from other plugins', () => {
    let now = 1_000_000
    const limiter = new AgentNotifyLimiter(6, () => now)
    expect(Array.from({ length: 7 }, () => limiter.take('acme.a'))).toEqual([true, true, true, true, true, true, false])
    expect(limiter.take('acme.b')).toBe(true)
    now += 60_001
    expect(limiter.take('acme.a')).toBe(true)
  })

  it('keeps the "Notify agent panes" switch off unless the user turned it on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navide-notify-switch-'))
    roots.push(dir)
    const store = new PluginNotifySwitchStore(dir)
    expect(store.has('acme.a')).toBe(false)
    store.add('acme.a')
    expect(new PluginNotifySwitchStore(dir).has('acme.a')).toBe(true)
    store.remove('acme.a')
    expect(new PluginNotifySwitchStore(dir).has('acme.a')).toBe(false)
  })
})

const binding = { pluginId: 'acme.grok', packageVersion: '1.0.0', workspaceId: 'workspace-1', instanceId: 'instance-1', audience: 'main' }
const call = (args: Record<string, unknown>) => ({ pluginId: binding.pluginId, ns: 'agentNotify', method: 'send', args, reqId: 'req-1' })
const context = (system: string[], overrides: Record<string, unknown> = {}) => ({
  publisherEligible: false, userGrant: { packageVersion: binding.packageVersion, system }, runtimeBinding: binding, ...overrides,
}) as never
const agent = { kind: 'agent', source: 'mcp', id: 'agent-1' } as const
const policySnapshot = (mode: 'full' | 'allowlist' | 'denylist', system: string[]) =>
  ({ policy: { schemaVersion: 1, mode, system, shell: [] }, revision: 1, state: 'user' }) as never

describe('agentNotify in the catalog, the broker and the disclosure', () => {
  it('is a workspace-scoped method of its own namespace, in both catalogs', () => {
    expect(PUBLIC_CAPABILITY_CATALOG['agentNotify.send']).toMatchObject({
      kind: 'method', namespace: 'agentNotify', scope: 'workspace', eligibility: 'public',
    })
    const json = capabilitiesV1 as { methods: Array<{ address: string; permission: unknown; since?: string }> }
    expect(json.methods.find((method) => method.address === 'agentNotify.send')).toMatchObject({
      permission: { id: 'system', access: 'agentNotify', scope: 'workspace' }, since: '1.4.0',
    })
  })

  it('needs its own declaration and grant: reading agents does not give it', () => {
    const declared = manifestV2CapabilityPolicy({ system: ['agents', 'agentNotify'] })
    expect(planPublicCapabilityCall(call({ to: 'dev', text: 'done' }), declared, context(['agents', 'agentNotify'])))
      .toMatchObject({ kind: 'allow', plan: { address: 'agentNotify.send', scope: 'workspace' } })
    expect(planPublicCapabilityCall(call({ to: 'dev', text: 'done' }), declared, context(['agents'])))
      .toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
    expect(planPublicCapabilityCall(call({ to: 'dev', text: 'done' }), manifestV2CapabilityPolicy({ system: ['agents'] }), context(['agents', 'agentNotify'])))
      .toMatchObject({ kind: 'deny' })
    expect(planPublicCapabilityCall(call({ to: 'dev', text: 'done', from: 'user' }), declared, context(['agentNotify'])))
      .toMatchObject({ kind: 'deny', response: { error: { code: 'INVALID_ARGUMENT' } } })
  })

  it('is never given to an agent by omission, and the Host default policy leaves it out', () => {
    expect(executionPolicyAllows(agent, policySnapshot('denylist', []), 'agentNotify')).toBe(false)
    expect(executionPolicyAllows(agent, policySnapshot('allowlist', ['agents']), 'agentNotify')).toBe(false)
    expect(executionPolicyAllows(agent, policySnapshot('allowlist', ['agentNotify']), 'agentNotify')).toBe(true)
    expect(HOST_DEFAULT_EXECUTION_POLICY.system).not.toContain('agentNotify')
  })

  it('is disclosed as high risk and marked sensitive', () => {
    expect(SENSITIVE_CAPABILITIES).toContain('agentNotify')
    const disclosure = computeDisclosure({
      schemaVersion: 2, id: 'acme.grok', version: '1.0.0', publisher: 'acme', permissions: { system: ['agentNotify'] },
    } as never)
    expect(disclosure.risk.level).toBe('high')
    expect(disclosure.summary.clauses).toContainEqual({ key: 'agentNotify', params: {} })
    expect(parseManifestV2({
      schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.grok', name: 'Grok', version: '1.0.0', publisher: 'acme',
      permissions: { system: ['agentNotify'] }, marketplace: { description: 'Grok', license: 'MIT' },
      contributes: { views: [{ id: 'main', kind: 'custom', location: 'window', title: 'Grok', entry: 'index.html' }] },
    }).permissions.system).toEqual(['agentNotify'])
  })
})
