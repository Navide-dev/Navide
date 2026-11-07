import { describe, expect, it } from 'vitest'
import capabilities from '../../../packages/plugin-contracts/src/schemas/capabilities-v1.json'
import { AGENTS_EVENTS } from '../../../packages/plugin-contracts/src/agents'
import { AGENTS_EVENT_FIELDS, HOST_AGENT_EVENT_TYPE, parseHostAgentEvent } from './agentsEvents'
import { PUBLIC_CAPABILITY_EVENT_ADDRESSES, publicCapabilityEntry } from './pluginCapabilityCatalog'
import {
  isPublicCapabilityEventAllowed,
  type AuthenticatedRuntimeBinding,
  type HostCapabilityContext,
} from './pluginCapabilityBroker'
import type { ManifestV2CapabilityPolicy } from './pluginPermissions'

const WS = '/work/alpha'
const frame = (event: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  event, workspace_path: WS, payload, ...extra,
})

describe('plugins.host_event frame', () => {
  it('is the WS type the backend broadcasts', () => {
    expect(HOST_AGENT_EVENT_TYPE).toBe('plugins.host_event')
  })

  it('parses every event with exactly its pinned fields', () => {
    expect(parseHostAgentEvent(frame('agents.turnEnded', { paneId: 'p1', name: 'w' }))).toEqual({
      event: 'agents.turnEnded', workspacePath: WS, payload: { paneId: 'p1', name: 'w' },
    })
    expect(parseHostAgentEvent(frame('agents.messageReceived', {
      id: 'm', createdAt: 1, status: 'delivered', sender: 'a', recipient: 'b', kind: '', reason: '',
      deliveredAt: null, correlationId: '', replyTo: '', bodyLength: 3,
    }))?.event).toBe('agents.messageReceived')
  })

  it('drops a frame carrying any extra field, such as message text', () => {
    expect(parseHostAgentEvent(frame('agents.turnEnded', { paneId: 'p1', name: 'w', content: 'secret' }))).toBeNull()
    expect(parseHostAgentEvent(frame('agents.turnEnded', { paneId: 'p1', name: 'w' }, { body: 'x' }))).toBeNull()
  })

  it('drops unknown events, missing fields, wrong types and an empty workspace', () => {
    expect(parseHostAgentEvent(frame('agents.unknown', {}))).toBeNull()
    expect(parseHostAgentEvent(frame('agents.turnEnded', { paneId: 'p1' }))).toBeNull()
    expect(parseHostAgentEvent(frame('agents.scheduleFired', { jobId: 'j', name: '', actionKind: 'message', manual: 'no' }))).toBeNull()
    expect(parseHostAgentEvent({ ...frame('agents.paneClosed', { paneId: 'p', name: 'n' }), workspace_path: '' })).toBeNull()
    expect(parseHostAgentEvent(null)).toBeNull()
  })
})

describe('agents.* event catalog', () => {
  const catalogEvents = (capabilities as unknown as { capabilities: Array<{ address: string; payload?: { required?: string[]; properties?: Record<string, unknown> } }> })
    .capabilities.filter(entry => entry.payload && (AGENTS_EVENTS as readonly string[]).includes(entry.address))

  it('lists every event in capabilities-v1.json with the fields the Host validates', () => {
    expect(catalogEvents.map(entry => entry.address)).toEqual([...AGENTS_EVENTS])
    for (const entry of catalogEvents) {
      const fields = Object.keys(AGENTS_EVENT_FIELDS[entry.address as (typeof AGENTS_EVENTS)[number]]).sort()
      expect(Object.keys(entry.payload?.properties ?? {}).sort()).toEqual(fields)
      expect([...(entry.payload?.required ?? [])].sort()).toEqual(fields)
    }
  })

  it('catalogs them as public agents events', () => {
    for (const address of AGENTS_EVENTS) {
      expect(PUBLIC_CAPABILITY_EVENT_ADDRESSES).toContain(address)
      expect(publicCapabilityEntry(address)).toMatchObject({ kind: 'event', namespace: 'agents', scope: 'workspace' })
    }
  })
})

describe('agents.* event authorization', () => {
  const binding: AuthenticatedRuntimeBinding = {
    pluginId: 'acme.watch', packageVersion: '1.0.0', workspaceId: 'w1', instanceId: 'i1', audience: 'view',
  }
  const policy = (agentEvents?: string[]): ManifestV2CapabilityPolicy => ({
    kind: 'manifest-v2', system: ['agents'], grants: [],
    ...(agentEvents ? { agentEvents: agentEvents as ManifestV2CapabilityPolicy['agentEvents'] } : {}),
  })
  const context = (system: string[] = ['agents']): HostCapabilityContext => ({
    runtimeBinding: binding,
    userGrant: { packageVersion: '1.0.0', system },
  } as unknown as HostCapabilityContext)
  const payload = { paneId: 'p1', name: 'w' }

  it('delivers a declared event to a granted receiver', () => {
    expect(isPublicCapabilityEventAllowed(policy(['agents.turnEnded']), 'agents.turnEnded', payload, context(), 'acme.watch', binding)).toBe(true)
  })

  it('withholds an event the manifest did not declare', () => {
    expect(isPublicCapabilityEventAllowed(policy(['agents.paneIdle']), 'agents.turnEnded', payload, context(), 'acme.watch', binding)).toBe(false)
    expect(isPublicCapabilityEventAllowed(policy(), 'agents.turnEnded', payload, context(), 'acme.watch', binding)).toBe(false)
  })

  it('withholds every event when the grant lacks agents', () => {
    expect(isPublicCapabilityEventAllowed(policy(['agents.turnEnded']), 'agents.turnEnded', payload, context([]), 'acme.watch', binding)).toBe(false)
  })

  it('withholds an event from another binding or without a source binding', () => {
    expect(isPublicCapabilityEventAllowed(policy(['agents.turnEnded']), 'agents.turnEnded', payload, context(), 'acme.watch', { ...binding, workspaceId: 'w2' })).toBe(false)
    expect(isPublicCapabilityEventAllowed(policy(['agents.turnEnded']), 'agents.turnEnded', payload, context(), 'acme.watch')).toBe(false)
  })
})
