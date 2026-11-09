import { describe, expect, it } from 'vitest'
import {
  interPluginBackendError,
  interPluginTargetError,
  validateInterPluginCallRequest,
  type InterPluginTarget,
} from './pluginInterCall'
import { planPublicCapabilityCall, type HostCapabilityContext } from './pluginCapabilityBroker'
import { publicCapabilityEntry } from './pluginCapabilityCatalog'
import type { ManifestV2CapabilityPolicy } from './pluginPermissions'

const target: InterPluginTarget = {
  pluginId: 'acme.target', api: ['lookup'], backendMethods: ['lookup', 'internal'], backendAvailable: true,
}

describe('plugins.call request', () => {
  it('accepts a plugin id, a method and any JSON args', () => {
    expect(validateInterPluginCallRequest({ pluginId: 'acme.target', method: 'lookup', args: null })).toBe(true)
  })

  it('refuses extra keys, missing args and an invalid id', () => {
    expect(validateInterPluginCallRequest({ pluginId: 'acme.target', method: 'lookup', args: {}, extra: 1 })).toBe(false)
    expect(validateInterPluginCallRequest({ pluginId: 'acme.target', method: 'lookup' })).toBe(false)
    expect(validateInterPluginCallRequest({ pluginId: 'Not An Id', method: 'lookup', args: {} })).toBe(false)
    expect(validateInterPluginCallRequest({ pluginId: 'acme.target', method: '', args: {} })).toBe(false)
  })

  it('is cataloged as a workspace-scoped plugins method', () => {
    expect(publicCapabilityEntry('plugins.call')).toMatchObject({ kind: 'method', namespace: 'plugins', scope: 'workspace' })
  })
})

describe('plugins.call target', () => {
  it('serves a method the target offers in contributes.api', () => {
    expect(interPluginTargetError('acme.caller', target, 'lookup')).toBeNull()
  })

  it('answers METHOD_NOT_FOUND for a missing target, itself, or a method not in contributes.api', () => {
    expect(interPluginTargetError('acme.caller', null, 'lookup')?.code).toBe('METHOD_NOT_FOUND')
    expect(interPluginTargetError('acme.target', target, 'lookup')?.code).toBe('METHOD_NOT_FOUND')
    expect(interPluginTargetError('acme.caller', target, 'internal')?.code).toBe('METHOD_NOT_FOUND')
  })

  it('answers BACKEND_UNAVAILABLE at once where the target has no backend', () => {
    expect(interPluginTargetError('acme.caller', { ...target, backendAvailable: false }, 'lookup')?.code)
      .toBe('BACKEND_UNAVAILABLE')
  })

  it('keeps public backend codes and hides everything else', () => {
    expect(interPluginBackendError('TIMEOUT').code).toBe('TIMEOUT')
    expect(interPluginBackendError('PROTOCOL_ERROR').code).toBe('INTERNAL_ERROR')
    expect(interPluginBackendError(undefined).code).toBe('INTERNAL_ERROR')
  })
})

describe('plugins.call caller authorization', () => {
  const binding = { pluginId: 'acme.caller', packageVersion: '1.0.0', workspaceId: 'w1', instanceId: 'i1', audience: 'view' }
  const context = { runtimeBinding: binding, userGrant: { packageVersion: '1.0.0', system: [] } } as unknown as HostCapabilityContext
  const policy = (plugins?: string[]): ManifestV2CapabilityPolicy => ({
    kind: 'manifest-v2', system: [], grants: [], ...(plugins ? { plugins } : {}),
  })
  const call = (pluginId: string) => ({
    reqId: 'r1', pluginId: 'acme.caller', ns: 'plugins', method: 'call',
    args: { pluginId, method: 'lookup', args: {} },
  })

  it('plans a call to a declared target', () => {
    expect(planPublicCapabilityCall(call('acme.target') as never, policy(['acme.target']), context).kind).toBe('allow')
  })

  it('denies a target the caller did not declare', () => {
    expect(planPublicCapabilityCall(call('acme.other') as never, policy(['acme.target']), context).kind).toBe('deny')
    expect(planPublicCapabilityCall(call('acme.target') as never, policy(), context).kind).toBe('deny')
  })
})
