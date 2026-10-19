import { describe, expect, it } from 'vitest'
import {
  executionPolicyAllows,
  isPublicCapabilityEventAllowed,
  planPublicCapabilityCall,
  type AuthenticatedInitiator,
  type CapabilityCall,
  type HostCapabilityContext,
} from './pluginCapabilityBroker'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import type { ExecutionPolicySnapshot } from './executionPolicy'
import type { StorageSnapshotTier } from './pluginCapabilityBroker'

const binding = {
  pluginId: 'acme.policy',
  packageVersion: '1.0.0',
  workspaceId: 'workspace-1',
  instanceId: 'instance-1',
  audience: 'panel',
} as const

const agent: AuthenticatedInitiator = {
  kind: 'agent',
  source: 'mcp',
  id: 'agent-request-1',
}

const user: AuthenticatedInitiator = {
  kind: 'user',
  id: 'user-1',
}

function snapshot(policy: ExecutionPolicySnapshot['policy'], revision = 1): ExecutionPolicySnapshot {
  return { policy, revision, state: 'user' }
}

function call(overrides: Partial<CapabilityCall> = {}): CapabilityCall {
  return {
    pluginId: binding.pluginId,
    ns: 'fs',
    method: 'readFile',
    args: { path: 'README.md' },
    reqId: 'req-1',
    ...overrides,
  }
}

function context(overrides: Partial<HostCapabilityContext> = {}): HostCapabilityContext {
  return {
    publisherEligible: true,
    userGrant: { packageVersion: binding.packageVersion, system: ['fs'], shell: 'allowlist' },
    runtimeBinding: binding,
    initiator: agent,
    executionPolicy: snapshot({
      schemaVersion: 1,
      mode: 'allowlist',
      system: ['fs'],
      shell: ['git'],
    }),
    ...overrides,
  }
}

describe('agent execution policy enforcement', () => {
  it('allows an allowlisted namespace and denies another before dispatch', () => {
    expect(executionPolicyAllows(agent, context().executionPolicy, 'fs')).toBe(true)
    expect(executionPolicyAllows(agent, context().executionPolicy, 'ui')).toBe(false)
    expect(
      planPublicCapabilityCall(
        call(),
        manifestV2CapabilityPolicy({ system: ['fs'] }),
        context()
      )
    ).toMatchObject({ kind: 'allow' })
  })

  it('checks every top-level executable in an agent shell chain', () => {
    const policy = snapshot({
      schemaVersion: 1,
      mode: 'allowlist',
      system: [],
      shell: ['git', 'gh'],
    })
    expect(executionPolicyAllows(agent, policy, 'shell', 'git status && gh pr list')).toBe(true)
    expect(executionPolicyAllows(agent, policy, 'shell', 'git status |& gh pr list')).toBe(true)
    expect(executionPolicyAllows(agent, policy, 'shell', 'git status && rm -rf .')).toBe(false)
  })

  it('matches allowlist executable names case-insensitively', () => {
    const policy = snapshot({
      schemaVersion: 1,
      mode: 'allowlist',
      system: [],
      shell: ['git'],
    })
    expect(executionPolicyAllows(agent, policy, 'shell', 'GIT status')).toBe(true)
  })

  it('matches denylist executable names case-insensitively', () => {
    const policy = snapshot({
      schemaVersion: 1,
      mode: 'denylist',
      system: [],
      shell: ['git'],
    })
    expect(executionPolicyAllows(agent, policy, 'shell', 'GIT status')).toBe(false)
  })

  it('treats denylist entries as denied namespaces and executables', () => {
    const policy = snapshot({
      schemaVersion: 1,
      mode: 'denylist',
      system: ['ui'],
      shell: ['rm'],
    })
    expect(executionPolicyAllows(agent, policy, 'fs')).toBe(true)
    expect(executionPolicyAllows(agent, policy, 'ui')).toBe(false)
    expect(executionPolicyAllows(agent, policy, 'shell', 'git status')).toBe(true)
    expect(executionPolicyAllows(agent, policy, 'shell', 'git status; rm -rf .')).toBe(false)
  })

  it('does not filter direct user operations', () => {
    const failClosed = snapshot({
      schemaVersion: 1,
      mode: 'allowlist',
      system: [],
      shell: [],
    })
    expect(executionPolicyAllows(user, failClosed, 'fs')).toBe(true)
    expect(
      planPublicCapabilityCall(
        call(),
        manifestV2CapabilityPolicy({ system: ['fs'] }),
        context({ initiator: user, executionPolicy: failClosed })
      )
    ).toMatchObject({ kind: 'allow' })
  })

  it('lets full mode bypass only the agent filters', () => {
    const full = snapshot({ schemaVersion: 1, mode: 'full', system: [], shell: [] })
    expect(executionPolicyAllows(agent, full, 'ui')).toBe(true)
    expect(
      planPublicCapabilityCall(
        call({ ns: 'ui', method: 'openExternal', args: { url: 'https://example.com' } }),
        manifestV2CapabilityPolicy({ system: ['fs'] }),
        context({ executionPolicy: full })
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('retains the agent initiator on a Host-managed storage plan', () => {
    const result = planPublicCapabilityCall(
      call({ ns: 'storage', method: 'get', args: { scope: 'plugin', key: 'state' } }),
      manifestV2CapabilityPolicy({ system: [] }),
      context({
        userGrant: { packageVersion: binding.packageVersion, system: [], storage: true },
        storageSnapshots: new Map<StorageSnapshotTier, string>([['active', binding.packageVersion]]),
        storageSnapshotTier: 'active',
      })
    )

    expect(result).toMatchObject({ kind: 'allow', plan: { initiator: agent } })
  })
})

describe('web namespace admission', () => {
  const webCall = (overrides: Partial<CapabilityCall> = {}) =>
    call({ ns: 'web', method: 'list', args: {}, ...overrides })
  const webContext = (overrides: Partial<HostCapabilityContext> = {}) => context({
    userGrant: { packageVersion: binding.packageVersion, system: ['web'] },
    executionPolicy: snapshot({ schemaVersion: 1, mode: 'allowlist', system: ['web'], shell: [] }),
    ...overrides,
  })

  it('refuses web.* from a package that did not declare web', () => {
    expect(planPublicCapabilityCall(webCall(), manifestV2CapabilityPolicy({ system: ['fs', 'ui'] }), webContext()))
      .toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED', message: "system namespace 'web' is not declared" } } })
  })

  it('refuses web.* when the user grant does not include web', () => {
    expect(planPublicCapabilityCall(
      webCall(),
      manifestV2CapabilityPolicy({ system: ['web'] }),
      webContext({ userGrant: { packageVersion: binding.packageVersion, system: ['ui'] } }),
    )).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('admits a declared and granted web call and still gates gesture methods', () => {
    expect(planPublicCapabilityCall(webCall(), manifestV2CapabilityPolicy({ system: ['web'] }), webContext()))
      .toMatchObject({ kind: 'allow', plan: { address: 'web.list', scope: 'plugin' } })
    expect(planPublicCapabilityCall(
      webCall({ method: 'create', args: { space: 'Research' } }),
      manifestV2CapabilityPolicy({ system: ['web'] }),
      webContext({ initiator: user }),
    )).toMatchObject({ kind: 'deny', response: { error: { code: 'USER_CANCELLED' } } })
    expect(planPublicCapabilityCall(
      webCall({ method: 'create', args: { space: 'Research', url: 'file:///etc/passwd' }, userGesture: true }),
      manifestV2CapabilityPolicy({ system: ['web'] }),
      webContext({ initiator: user }),
    )).toMatchObject({ kind: 'deny', response: { error: { code: 'INVALID_ARGUMENT' } } })
  })

  it('never default-allows web for an agent', () => {
    const denylist = snapshot({ schemaVersion: 1, mode: 'denylist', system: [], shell: [] })
    const allowlistWithoutWeb = snapshot({ schemaVersion: 1, mode: 'allowlist', system: ['fs', 'ui', 'aiCli'], shell: [] })
    const allowlistWithWeb = snapshot({ schemaVersion: 1, mode: 'allowlist', system: ['web'], shell: [] })
    expect(executionPolicyAllows(agent, denylist, 'web')).toBe(false)
    expect(executionPolicyAllows(agent, denylist, 'fs')).toBe(true)
    expect(executionPolicyAllows(agent, allowlistWithoutWeb, 'web')).toBe(false)
    expect(executionPolicyAllows(agent, allowlistWithWeb, 'web')).toBe(true)
    expect(executionPolicyAllows(agent, undefined, 'web')).toBe(false)
    expect(executionPolicyAllows(user, denylist, 'web')).toBe(true)
    expect(planPublicCapabilityCall(
      webCall(),
      manifestV2CapabilityPolicy({ system: ['web'] }),
      webContext({ executionPolicy: denylist }),
    )).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED', message: 'agent execution policy denied the operation' } } })
  })

  it('routes web.changed only to a declared and granted audience with a valid payload', () => {
    const policy = manifestV2CapabilityPolicy({ system: ['web'] })
    const payload = { views: [{ viewId: 'v1', space: 'S', owner: 'user', control: 'user', state: 'idle', url: 'about:blank', title: '', loading: false, attached: false }] }
    expect(isPublicCapabilityEventAllowed(policy, 'web.changed', payload, webContext(), binding.pluginId, binding)).toBe(true)
    expect(isPublicCapabilityEventAllowed(policy, 'web.changed', { views: [{}] }, webContext(), binding.pluginId, binding)).toBe(false)
    expect(isPublicCapabilityEventAllowed(policy, 'web.changed', payload, webContext(), binding.pluginId)).toBe(false)
    expect(isPublicCapabilityEventAllowed(manifestV2CapabilityPolicy({ system: ['ui'] }), 'web.changed', payload, webContext(), binding.pluginId, binding)).toBe(false)
  })
})
