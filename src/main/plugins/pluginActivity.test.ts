import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_ACTIVITY_RECORD_MESSAGE } from '../../shared/pluginAgentTools'
import { activityRowFor, backendCallAddress, PluginActivityRecorder, type PluginActivityRow } from './pluginActivity'
import {
  buildError,
  buildSuccess,
  isUndeclaredDenial,
  planCapabilityCall,
  type CapabilityCall,
  type CapabilityResponse,
  type HostCapabilityContext,
} from './pluginCapabilityBroker'
import { manifestV2CapabilityPolicy } from './pluginPermissions'

const call = (overrides: Partial<CapabilityCall> = {}): CapabilityCall => ({
  pluginId: 'acme.indexer',
  ns: 'fs',
  method: 'readFile',
  args: { path: '/Users/me/project/src/a.py' },
  reqId: 'req-1',
  ...overrides,
})

const AT = 1_792_108_800_123
const row = (c: CapabilityCall, response: CapabilityResponse): PluginActivityRow =>
  activityRowFor({ pluginId: 'acme.indexer', packageVersion: '1.0.0', workspace: '/Users/me/project', call: c, response, at: AT })

const respond = (plan: ReturnType<typeof planCapabilityCall>): CapabilityResponse => {
  if (plan.kind !== 'respond') throw new Error(`expected a refusal, got ${plan.kind}`)
  return plan.response
}

describe('activityRowFor', () => {
  it('records an allowed fs call with its path, and nothing of its content', () => {
    const c = call({ method: 'writeFile', args: { path: 'src/a.py', content: 'secret body' } })
    expect(row(c, buildSuccess('req-1', { ok: true }))).toEqual({
      plugin_id: 'acme.indexer',
      plugin_version: '1.0.0',
      workspace: '/Users/me/project',
      source: 'broker',
      address: 'fs.writeFile',
      outcome: 'allowed',
      fs_path: 'src/a.py',
      at: AT,
    })
  })

  it('dates a row when the call completed, not when its batch is sent (#368 follow-up L3)', () => {
    const before = Date.now()
    const dated = activityRowFor({
      pluginId: 'acme.indexer', packageVersion: '1.0.0', workspace: '', call: call(), response: buildSuccess('r', {}),
    })
    expect(dated.at).toBeGreaterThanOrEqual(before)
    expect(dated.at).toBeLessThanOrEqual(Date.now())
  })

  it('records a shell call as the shell source with its command line', () => {
    const c = call({ ns: 'shell', method: 'run', args: { command: 'git log -n 3' } })
    expect(row(c, buildSuccess('req-1', {}))).toMatchObject({
      source: 'shell', address: 'shell.run', outcome: 'allowed', shell_command: 'git log -n 3',
    })
  })

  it('reads a broker refusal as denied and a failure as error', () => {
    expect(row(call(), buildError('req-1', 'CAPABILITY_DENIED', 'package-version grant is missing'))).toMatchObject({
      outcome: 'denied',
    })
    expect(row(call(), buildError('req-1', 'CAPABILITY_DENIED', 'x')).denied_reason).toBeUndefined()
    expect(row(call(), buildError('req-1', 'INTERNAL_ERROR', 'public capability failed')).outcome).toBe('error')
  })

  it('marks a refusal of an undeclared namespace as undeclared (legacy policy)', () => {
    const response = respond(planCapabilityCall(call({ ns: 'net', method: 'fetch' }), ['fs']))
    expect(isUndeclaredDenial(response)).toBe(true)
    expect(row(call({ ns: 'net', method: 'fetch', args: {} }), response)).toMatchObject({
      outcome: 'denied', denied_reason: 'undeclared', address: 'net.fetch',
    })
  })

  it('marks a refusal of an undeclared Manifest v2 namespace or shell as undeclared', () => {
    const policy = manifestV2CapabilityPolicy({ system: ['ui'] })
    const context: HostCapabilityContext = {
      publisherEligible: true,
      userGrant: { packageVersion: '1.0.0', system: ['ui'] },
      runtimeBinding: {
        pluginId: 'acme.indexer', packageVersion: '1.0.0', workspaceId: 'w', instanceId: 'i', audience: 'a',
      },
    }
    const fsRefused = respond(planCapabilityCall(call(), policy, context))
    const shellRefused = respond(planCapabilityCall(call({ ns: 'shell', method: 'run', args: { command: 'ls' } }), policy, context))
    expect(isUndeclaredDenial(fsRefused)).toBe(true)
    expect(isUndeclaredDenial(shellRefused)).toBe(true)
    // A declared namespace refused for another reason is not "undeclared".
    const ungranted = respond(planCapabilityCall(call({ ns: 'ui', method: 'openExternal', args: { url: 'https://x' } }), policy, {
      ...context, userGrant: null,
    }))
    expect(isUndeclaredDenial(ungranted)).toBe(false)
  })

  it('leaves the plugin-facing envelope unchanged', () => {
    const response = respond(planCapabilityCall(call({ ns: 'net', method: 'fetch' }), ['fs']))
    expect(Object.keys(response).sort()).toEqual(['error', 'ok', 'reqId'])
  })
})

describe('PluginActivityRecorder', () => {
  afterEach(() => { vi.useRealTimers() })
  const sample = row(call(), buildSuccess('req-1', {}))

  it('sends the queued rows in one batch after the interval', async () => {
    vi.useFakeTimers()
    const sent: unknown[][] = []
    const recorder = new PluginActivityRecorder(() => (type, payload) => { sent.push([type, payload]) }, 1000)
    recorder.record(sample)
    recorder.record(sample)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toEqual([[PLUGIN_ACTIVITY_RECORD_MESSAGE, { rows: [sample, sample] }]])
    expect(recorder.pending).toBe(0)
  })

  it('drops a batch with no backend, or whose send fails, and keeps recording', async () => {
    let send: (() => Promise<void>) | null = null
    const recorder = new PluginActivityRecorder(() => send, 1000)
    recorder.record(sample)
    await recorder.flush()
    expect(recorder.pending).toBe(0)
    send = () => Promise.reject(new Error('socket closed'))
    recorder.record(sample)
    await expect(recorder.flush()).resolves.toBeUndefined()
    expect(recorder.pending).toBe(0)
  })

  it('never makes the caller wait for the backend', () => {
    let release: () => void = () => {}
    const recorder = new PluginActivityRecorder(() => () => new Promise<void>((resolve) => { release = resolve }), 0)
    const started = performance.now()
    for (let i = 0; i < 10_000; i++) recorder.record(sample)
    expect(performance.now() - started).toBeLessThan(200)
    release()
  })
})

describe('backend calls are counted per key within a batch (H1)', () => {
  it('sends one row per (plugin, version, workspace, address, outcome) with its count', async () => {
    const sent: unknown[] = []
    const recorder = new PluginActivityRecorder(() => async (_type, payload) => { sent.push(payload) }, 60_000)
    const call = { plugin_id: 'acme.x', plugin_version: '1.0.0', workspace: '/w', address: backendCallAddress('devmap.read') }
    const minute = 1_792_108_800_000
    for (let i = 0; i < 1000; i++) recorder.recordBackendCall({ ...call, outcome: 'allowed' }, minute + i)
    recorder.recordBackendCall({ ...call, outcome: 'cancelled' }, minute + 5)
    recorder.recordBackendCall({ ...call, workspace: '/other', outcome: 'allowed' }, minute + 5)
    // The next minute is its own row.
    recorder.recordBackendCall({ ...call, outcome: 'allowed' }, minute + 60_000)
    expect(recorder.pending).toBe(4)
    await recorder.flush()
    expect(sent).toEqual([{ rows: [
      { ...call, at: minute, source: 'backend', outcome: 'allowed', count: 1000 },
      { ...call, at: minute, source: 'backend', outcome: 'cancelled', count: 1 },
      { ...call, at: minute, workspace: '/other', source: 'backend', outcome: 'allowed', count: 1 },
      { ...call, at: minute + 60_000, source: 'backend', outcome: 'allowed', count: 1 },
    ] }])
    expect(recorder.pending).toBe(0)
  })

  it('keeps a method named like a system namespace apart from it', () => {
    expect(backendCallAddress('fs.read')).toBe('backend.fs.read')
  })
})
