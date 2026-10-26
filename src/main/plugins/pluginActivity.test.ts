import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_ACTIVITY_RECORD_MESSAGE } from '../../shared/pluginAgentTools'
import {
  ACTIVITY_DENIED_TARGET,
  ACTIVITY_FAILED_TARGET,
  ACTIVITY_MISSING_TARGET,
  ACTIVITY_UNKNOWN_ADDRESS,
  READ_ONLY_ADDRESSES,
  activityRowFor,
  backendCallAddress,
  PluginActivityRecorder,
  type PluginActivityRow,
} from './pluginActivity'
import {
  buildError,
  buildSuccess,
  isKnownCapabilityAddress,
  isUndeclaredDenial,
  isUndispatched,
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
      count: 1,
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
      // net.fetch is no capability the broker routes: one fixed address.
      outcome: 'denied', denied_reason: 'undeclared', address: ACTIVITY_UNKNOWN_ADDRESS,
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

// Final review part 2, H1: a plugin needs no permission to be refused, and
// what it writes (address, path, command) has no length or variety limit.
describe('text the plugin wrote is never a key', () => {
  it('records a capability the broker does not know under one address, and a refused or failed call without its path or command', () => {
    expect(row(call({ ns: 'made', method: 'up' }), buildError('req-1', 'METHOD_NOT_FOUND', 'x'))).toMatchObject({
      address: ACTIVITY_UNKNOWN_ADDRESS, outcome: 'error',
    })
    expect(row(call(), buildError('req-1', 'CAPABILITY_DENIED', 'x'))).toMatchObject({ fs_path: ACTIVITY_DENIED_TARGET })
    expect(row(call(), buildError('req-1', 'INTERNAL_ERROR', 'x'))).toMatchObject({ fs_path: ACTIVITY_FAILED_TARGET })
    // A failed write or command may have done something first: it keeps its text (security review).
    const write = call({ method: 'writeFile', args: { path: 'src/new.ts', content: 'x' } })
    expect(row(write, buildError('req-1', 'TIMEOUT', 'x')).fs_path).toBe('src/new.ts')
    const run = call({ ns: 'shell', method: 'run', args: { command: 'git push origin' } })
    expect(row(run, buildError('req-1', 'INTERNAL_ERROR', 'x')).shell_command).toBe('git push origin')
    // Whatever code a handler answered with: it was dispatched, so it keeps its path.
    expect(row(write, buildError('req-1', 'INVALID_ARGUMENT', 'x')).fs_path).toBe('src/new.ts')
    // An unknown address ran nothing.
    expect(row(call({ method: 'readFile2' }), buildError('req-1', 'METHOD_NOT_FOUND', 'x')).fs_path).toBe(ACTIVITY_FAILED_TARGET)
    const shell = call({ ns: 'shell', method: 'run', args: { command: 'curl -u me:secret https://x' } })
    expect(row(shell, buildError('req-1', 'CAPABILITY_DENIED', 'x'))).toMatchObject({ shell_command: ACTIVITY_DENIED_TARGET })
    // An allowed call keeps them: that IO happened.
    expect(row(call(), buildSuccess('req-1', {}))).toMatchObject({ address: 'fs.readFile', fs_path: '/Users/me/project/src/a.py' })
  })

  // Review of #397: fs.stat answers ok for a path that does not exist (MED-2),
  // and a plugin's own path may be spelled like a fixed value (MED-1).
  it('records an allowed call that found nothing as <missing>, and escapes a path spelled like a fixed value', () => {
    const stat = (path: string) => call({ method: 'stat', args: { path } })
    for (let i = 0; i < 3; i++) {
      expect(row(stat(`/tmp/nothing-${i}`), buildSuccess('req-1', { exists: false, is_directory: false, size: 0 })).fs_path)
        .toBe(ACTIVITY_MISSING_TARGET)
    }
    expect(row(stat('src/a.py'), buildSuccess('req-1', { exists: true, size: 3 })).fs_path).toBe('src/a.py')
    // readFile / listDirectory answer a missing path with ok: false inside a successful call.
    const read = call({ method: 'readFile', args: { path: '/tmp/nothing' } })
    expect(row(read, buildSuccess('req-1', { ok: false, error: 'not a file', content: '' }))).toMatchObject({
      outcome: 'allowed', fs_path: ACTIVITY_MISSING_TARGET,
    })
    expect(row(read, buildSuccess('req-1', { ok: true, content: 'x' })).fs_path).toBe('/tmp/nothing')
    // A write keeps its path whatever it answered: it may have changed something first (security review).
    const write = call({ method: 'writeFile', args: { path: 'src/new.ts', content: 'x' } })
    expect(row(write, buildSuccess('req-1', { ok: false, error: 'conflict' })).fs_path).toBe('src/new.ts')
    for (const value of ['<denied>', '<failed>', '<unknown>', '<missing>']) {
      expect(row(stat(value), buildSuccess('req-1', { exists: true })).fs_path).toBe(`./${value}`)
    }
  })

  // Review of #397 (7c9b995d3): whether a call ran is the broker's own mark,
  // never a guess from its error code.
  describe('a failed call before and after dispatch', () => {
    const policy = manifestV2CapabilityPolicy({ system: ['fs'] })
    const context: HostCapabilityContext = {
      publisherEligible: true,
      userGrant: { packageVersion: '1.0.0', system: ['fs'] },
      runtimeBinding: {
        pluginId: 'acme.indexer', packageVersion: '1.0.0', workspaceId: 'w', instanceId: 'i', audience: 'a',
      },
    }

    it('records a writeFile refused before it ran as <failed>, and one that failed in its handler with its path', () => {
      const invalid = call({ method: 'writeFile', args: { path: 'src/new.ts' } })  // no content: refused by the planner
      const refused = respond(planCapabilityCall(invalid, policy, context))
      expect(refused.error?.code).toBe('INVALID_ARGUMENT')
      expect(isUndispatched(refused)).toBe(true)
      expect(row(invalid, refused)).toMatchObject({ outcome: 'error', fs_path: ACTIVITY_FAILED_TARGET })
      const ran = call({ method: 'writeFile', args: { path: 'src/new.ts', content: 'x' } })
      expect(planCapabilityCall(ran, policy, context).kind).not.toBe('respond')
      expect(row(ran, buildError('req-1', 'INVALID_ARGUMENT', 'from the handler')).fs_path).toBe('src/new.ts')
    })

    it('counts 1000 different paths to an unknown public capability as one row', async () => {
      const sent: Array<{ rows: unknown[] }> = []
      const recorder = new PluginActivityRecorder(() => async (_type, payload) => { sent.push(payload) }, 60_000)
      for (let i = 0; i < 1000; i++) {
        const bogus = call({ method: 'bogus', args: { path: `src/${i}.ts` } })
        const response = respond(planCapabilityCall(bogus, policy, context))
        expect(response.error?.code).toBe('METHOD_NOT_FOUND')
        recorder.record(activityRowFor({ pluginId: 'acme.indexer', packageVersion: '1.0.0', workspace: '/w', call: bogus, response, at: AT }))
      }
      await recorder.flush()
      expect(sent[0].rows).toEqual([expect.objectContaining({
        address: ACTIVITY_UNKNOWN_ADDRESS, outcome: 'error', fs_path: ACTIVITY_FAILED_TARGET, count: 1000,
      })])
    })

    it('keeps 100,000 stat and readFile calls to paths that do not exist at a handful of keys (HIGH-1)', async () => {
      const sent: Array<{ rows: unknown[] }> = []
      const recorder = new PluginActivityRecorder(() => async (_type, payload) => { sent.push(payload) }, 60_000)
      for (let i = 0; i < 100_000; i++) {
        const stat = call({ method: 'stat', args: { path: `missing/${i}` } })
        recorder.record(activityRowFor({
          pluginId: 'acme.indexer', packageVersion: '1.0.0', workspace: '/w', call: stat, at: AT,
          response: buildSuccess('r', { exists: false, is_directory: false, size: 0 }),
        }))
        const read = call({ method: 'readFile', args: { path: `missing/${i}` } })
        recorder.record(activityRowFor({
          pluginId: 'acme.indexer', packageVersion: '1.0.0', workspace: '/w', call: read, at: AT,
          response: buildSuccess('r', { ok: false, error: 'not a file', content: '' }),
        }))
        recorder.record(activityRowFor({
          pluginId: 'acme.indexer', packageVersion: '1.0.0', workspace: '/w', call: read, at: AT,
          response: buildError('r', 'TIMEOUT', 'x'),
        }))
      }
      expect(recorder.pending).toBeLessThan(10)
      await recorder.flush()
      expect(sent[0].rows).toHaveLength(3)
    })

    it('keeps v2 createFile and createDirectory out of the read-only list', () => {
      expect(READ_ONLY_ADDRESSES.has('fs.createFile')).toBe(false)
      expect(READ_ONLY_ADDRESSES.has('fs.createDirectory')).toBe(false)
      expect(READ_ONLY_ADDRESSES.has('fs.findInFiles')).toBe(false)  // its search runs a process
    })
  })

  it('knows exactly the capabilities the broker routes', () => {
    expect(isKnownCapabilityAddress('fs', 'readFile')).toBe(true)  // public catalog
    expect(isKnownCapabilityAddress('ui', 'open_in_editor')).toBe(true)  // Host action
    // `ping` answers any method name: each would be a new key (security review of #397).
    expect(isKnownCapabilityAddress('ping', 'anything')).toBe(false)
    expect(isKnownCapabilityAddress('fs', 'readFile2')).toBe(false)
    expect(isKnownCapabilityAddress('toString', '')).toBe(false)
  })

  it('counts 300,000 refused calls with 300,000 different names and paths as one row', async () => {
    const sent: Array<{ rows: unknown[] }> = []
    const recorder = new PluginActivityRecorder(() => async (_type, payload) => { sent.push(payload) }, 60_000)
    for (let i = 0; i < 300_000; i++) {
      recorder.record(activityRowFor({
        pluginId: 'acme.indexer', packageVersion: '1.0.0', workspace: '/w', at: AT,
        call: call({ ns: `ns${i}`, method: `m${i}`, args: { path: `/tmp/${i}` } }),
        response: buildError('req-1', 'METHOD_NOT_FOUND', 'x'),
      }))
    }
    expect(recorder.pending).toBe(1)
    await recorder.flush()
    expect(sent[0].rows).toEqual([expect.objectContaining({ address: ACTIVITY_UNKNOWN_ADDRESS, count: 300_000 })])
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
    // Same key, same minute: one row, counted twice.
    expect(sent).toEqual([[PLUGIN_ACTIVITY_RECORD_MESSAGE, { rows: [{ ...sample, count: 2 }] }]])
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
