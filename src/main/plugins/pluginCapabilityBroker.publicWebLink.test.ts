import { describe, expect, it } from 'vitest'
import { capabilitiesV1 } from '../../../packages/plugin-contracts/src/index'
import { planPublicCapabilityCall } from './pluginCapabilityBroker'
import { PUBLIC_CAPABILITY_CATALOG } from './pluginCapabilityCatalog'
import { manifestV2CapabilityPolicy } from './pluginPermissions'

const entry = PUBLIC_CAPABILITY_CATALOG['ui.openExternal']
const policy = manifestV2CapabilityPolicy({ system: ['ui'] })
const binding = {
  pluginId: 'acme.links',
  packageVersion: '1.0.0',
  workspaceId: 'workspace-1',
  instanceId: 'instance-1',
  audience: 'external',
}

function call(url: string, extra: { userGesture?: boolean } = {}) {
  return {
    pluginId: binding.pluginId,
    ns: 'ui',
    method: 'openExternal',
    args: { url },
    reqId: 'web-link-1',
    ...extra,
  }
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    publisherEligible: false,
    userGrant: { packageVersion: binding.packageVersion, system: ['ui'] as const },
    runtimeBinding: binding,
    ...overrides,
  }
}

describe('public web link capability catalog', () => {
  it('keeps external links in the plugin-scoped UI catalog', () => {
    expect(entry).toMatchObject({
      address: 'ui.openExternal',
      kind: 'method',
      namespace: 'ui',
      scope: 'plugin',
      eligibility: 'public',
      requiresUserGesture: true,
    })
  })

  it.each(['http://example.com', 'https://example.com/path?q=1', 'HTTPS://EXAMPLE.COM'])(
    'accepts %s',
    (url) => {
      expect(entry?.validateRequest?.({ url })).toBe(true)
    },
  )

  it.each([
    'file:///Users/example/secret.txt',
    'javascript:alert(1)',
    'custom://example.test/path',
    'mailto:user@example.com',
    'https://',
    '',
  ])('rejects non-web or malformed URL %s', (url) => {
    expect(entry?.validateRequest?.({ url })).toBe(false)
  })

  it('keeps the existing broker grant gate around valid web links', () => {
    expect(planPublicCapabilityCall(call('https://example.com', { userGesture: true }), policy, context())).toMatchObject({
      kind: 'allow',
      plan: { address: 'ui.openExternal', scope: 'plugin', runtime: binding },
    })
    expect(planPublicCapabilityCall(call('https://example.com', { userGesture: true }), policy, context({ userGrant: null }))).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'CAPABILITY_DENIED' } },
    })
    expect(planPublicCapabilityCall(call('javascript:alert(1)', { userGesture: true }), policy, context())).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'INVALID_ARGUMENT' } },
    })
  })

  it('mirrors the published catalog gesture requirement onto the executable entry', () => {
    const flagged = (capabilitiesV1 as {
      methods: Array<{ address: string; requiresUserGesture?: boolean }>
    }).methods
      .filter((method) => method.requiresUserGesture === true)
      .map((method) => method.address)
    expect(flagged).toEqual(['ui.openExternal', 'web.create', 'web.setOwner', 'web.takeControl', 'web.returnControl', 'web.clearData'])
    for (const address of flagged) {
      expect(PUBLIC_CAPABILITY_CATALOG[address]?.requiresUserGesture).toBe(true)
    }
    // Reverse direction: the executable catalog must not gate an address the
    // published catalog does not declare as gesture-gated.
    const gated = Object.entries(PUBLIC_CAPABILITY_CATALOG)
      .filter(([, candidate]) => candidate.requiresUserGesture === true)
      .map(([address]) => address)
    expect(gated.sort()).toEqual([...flagged].sort())
  })

  it('refuses a web link the view did not open with a user gesture', () => {
    // An agent- or backend-driven view must not be able to hand a URL to the OS
    // browser. The preload only marks a gesture it observed itself.
    expect(planPublicCapabilityCall(call('https://example.com'), policy, context())).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'USER_CANCELLED' } },
    })
    expect(planPublicCapabilityCall(call('https://example.com', { userGesture: false }), policy, context())).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'USER_CANCELLED' } },
    })
  })

  it('leaves the gesture flag inert for addresses that do not require it', () => {
    // The gate is a catalog property: the same request must plan identically
    // whether or not the preload marked a gesture.
    const ungated = Object.entries(PUBLIC_CAPABILITY_CATALOG).find(
      ([address, candidate]) => address !== 'ui.openExternal' && candidate.requiresUserGesture !== true,
    )
    expect(ungated).toBeDefined()
    const [address, candidate] = ungated!
    const [ns, method] = address.split('.') as [string, string]
    const request = { pluginId: binding.pluginId, ns, method, args: candidate.kind === 'method' ? { url: 'https://example.com' } : {}, reqId: 'x' }
    expect(planPublicCapabilityCall({ ...request, userGesture: true }, policy, context()))
      .toEqual(planPublicCapabilityCall(request, policy, context()))
  })
})
