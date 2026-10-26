import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolsSyncPayload } from '../../shared/pluginAgentTools'
import type { ExecutionPolicySnapshot } from './executionPolicy'
import { HOST_DEFAULT_EXECUTION_POLICY } from './executionPolicy'
import { FrontendPluginManager } from './frontendPluginManager'
import { PluginAgentToolsHost } from './pluginAgentToolsHost'
import type { PluginBackendHost } from './pluginBackendHost'
import { BackendPluginError } from './pluginBackendSupervisor'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import { readInstalledManifestV2, thirdPartyBackendLaunchSpec, type ThirdPartyLaunchSpec } from './pluginThirdPartyBackends'

// B1 integration (plan navide_b5ecff, B1-4 and the non-regression section):
// the Host's agent tool path end to end, from the catalog to a real backend
// child on stdio (the backend-wire fixture the supervisor tests use), with the
// call racing every way a package can stop being callable. Only tmp
// directories are used, and every child this file starts is checked to have
// exited by the PID it was started with.

// The manager imports electron for its view lifecycle, which this file never
// opens; without a stub the real package would try to fetch its binary.
vi.mock('electron', () => ({}))

const FIXTURE = fileURLToPath(new URL('./test-fixtures/backend-wire-child.mjs', import.meta.url))

interface PackageFixture {
  id: string
  prefix: string
  version: string
  tools?: Array<{ name: string; method: string; risk: 'read' | 'write' }>
}

interface Live {
  mgr: FrontendPluginManager
  gate: PluginAgentToolsHost
  root: string
  workspace: string
  specs: Map<string, ThirdPartyLaunchSpec>
  switches: { enabled: boolean; externalCallers: boolean }
  disabled: Set<string>
  consented: Set<string>
  since: Map<string, string>
  /** B1-a's agentToolNamesSince, keyed `<pluginId> <name>`. */
  nameSince: Map<string, string>
  /** Remove a package entirely, as an uninstall would. */
  remove: (pluginId: string) => void
  confirmWrite: ReturnType<typeof vi.fn>
  sent: AgentToolsSyncPayload[]
  pids: number[]
  /** The global third-party native backend switch the admitter honours. */
  native: { enabled: boolean }
  /** Hold the next backend admission (the bind) until released. */
  holdBind: () => { release: () => void; waiting: () => boolean }
  /** Register a hold's release, so the cleanup frees it even after a failure. */
  onCleanup: (release: () => void) => void
  request: (pluginId: string, name: string, args?: Record<string, unknown>, revision?: number) => Record<string, unknown>
  call: (pluginId: string, name: string, args?: Record<string, unknown>, revision?: number) => Promise<Record<string, unknown>>
  backendHost: () => PluginBackendHost
}

/** One cleanup per live(), registered as soon as its tmp root exists. */
const cleanups: Array<() => Promise<void>> = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((done) => setTimeout(done, 20))
  }
}

afterEach(async () => {
  // Every cleanup runs, and every tmp root is removed, even when one fails.
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw failures[0]
  // Longer than a cleanup's own wait (10 s), so its finally always runs
  // before the hook could be abandoned.
}, 30_000)

function writePackage(root: string, pkg: PackageFixture): ThirdPartyLaunchSpec {
  const packageDir = join(root, 'packages', pkg.id, pkg.version)
  mkdirSync(join(packageDir, 'backend'), { recursive: true })
  writeFileSync(join(packageDir, 'backend', 'fixture'), 'binary', { mode: 0o700 })
  writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2, apiVersion: '^1.0.0', id: pkg.id, name: pkg.id, version: pkg.version, publisher: pkg.id.split('.')[0],
    permissions: { system: ['fs'] },
    marketplace: { description: 'Fixture.', license: 'MIT' },
    backend: { entry: 'backend/fixture', protocolVersion: 1, activation: 'startup', methods: ['fixture.echo', 'fixture.delay'] },
  }))
  const parsed = readInstalledManifestV2(packageDir)
  const tools = (pkg.tools ?? [
    { name: `${pkg.prefix}_echo`, method: 'fixture.echo', risk: 'read' as const },
    { name: `${pkg.prefix}_slow`, method: 'fixture.delay', risk: 'read' as const },
    { name: `${pkg.prefix}_write`, method: 'fixture.echo', risk: 'write' as const },
  ]).map((tool) => ({
    ...tool, title: tool.name, description: `The ${tool.name} tool.`, inputSchema: { type: 'object', properties: {} },
  }))
  return thirdPartyBackendLaunchSpec(
    {
      pluginId: pkg.id, packageVersion: pkg.version, packageDir, views: [],
      backend: { entryFile: join(packageDir, 'backend', 'fixture'), protocolVersion: 1, activation: 'startup' },
    },
    { ...parsed, backend: { ...parsed.backend!, ...(tools.length > 0 ? { agentTools: tools } : {}) } as never },
  )!
}

async function live(packages: PackageFixture[], options: { enabled?: boolean } = {}): Promise<Live> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tools-integration-')))
  const pids: number[] = []
  const releases: Array<() => void> = []
  let managed: FrontendPluginManager | undefined
  cleanups.push(async () => {
    let exited = false
    try {
      // A test that failed before releasing a hold would leave the close
      // waiting on it: free every hold, and bound the close.
      for (const release of releases.splice(0)) release()
      let bound: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          managed?.closeBackendPlugins(),
          new Promise((done) => {
            bound = setTimeout(done, 10_000)
          }),
        ])
      } finally {
        clearTimeout(bound)
      }
      // Only the PIDs this file started, each waited for until it is gone.
      await waitUntil(() => pids.every((pid) => !alive(pid)))
      exited = true
    } finally {
      try {
        // Last resort, only when the wait failed and only for this file's own
        // PIDs still alive (never a PID that exited and may be reused); one
        // that exits in between (ESRCH) is already what is wanted.
        if (!exited) {
          for (const pid of pids.filter(alive)) {
            try {
              process.kill(pid, 'SIGKILL')
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
            }
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const mgr = new FrontendPluginManager()
  managed = mgr
  const policy: ExecutionPolicySnapshot = { policy: HOST_DEFAULT_EXECUTION_POLICY, revision: 1, state: 'default' }
  mgr.setExecutionPolicyResolver(() => policy)
  mgr.setCapabilityGrantResolver((_pluginId, packageVersion) => ({ packageVersion, system: ['fs'], storage: true }))
  const specs = new Map<string, ThirdPartyLaunchSpec>()
  for (const pkg of packages) {
    const spec = writePackage(root, pkg)
    mgr.registerDescriptor({
      id: pkg.id, packageVersion: pkg.version, packageDir: spec.packageDir, requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }), devUrl: '',
      entryFile: join(spec.packageDir, 'index.html'), views: [],
    }, { builtin: true })
    mgr.registerBackendActivation(spec)
    specs.set(pkg.id, spec)
  }
  // A real child on stdio, without the OS sandbox (that is the live
  // pluginBackendHost.thirdParty test's job): what is under test is the
  // agent tool path in front of it. Like ThirdPartyBackendController, it
  // refuses while the global native backend switch is off.
  const native = { enabled: true }
  let bindHold: Promise<void> | undefined
  let bindWaiting = false
  const refuseWhenOff = (): void => {
    if (!native.enabled) throw new BackendPluginError('BACKEND_UNAVAILABLE', 'third-party native backends are turned off')
  }
  mgr.setThirdPartyBackendAdmitter(async () => {
    if (bindHold) {
      bindWaiting = true
      await bindHold
    }
    refuseWhenOff()
    return {
    spawnProcess: (_entryFile, spawnOptions) => {
      const child = spawn(process.execPath, [FIXTURE], {
        ...spawnOptions,
        env: { ...spawnOptions.env, NAVIDE_FIXTURE: 'backend-wire' },
      }) as ChildProcessWithoutNullStreams
      if (child.pid !== undefined) pids.push(child.pid)
      return child
    },
    bridgeDispatcher: { dispatch: vi.fn() },
    beforeSpawn: async () => refuseWhenOff(),
    noteFailure: () => null,
    workspaceRoot: workspace,
    }
  })
  const switches = { enabled: options.enabled ?? true, externalCallers: false }
  const disabled = new Set<string>()
  const consented = new Set(packages.map((pkg) => pkg.id))
  const since = new Map(packages.map((pkg, index) => [pkg.id, new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString()]))
  const nameSince = new Map<string, string>()
  const confirmWrite = vi.fn(async () => true)
  const sent: AgentToolsSyncPayload[] = []
  const current = (pluginId: string): ThirdPartyLaunchSpec | undefined =>
    mgr.getBackendActivation(pluginId, specs.get(pluginId)?.packageVersion ?? '') as ThirdPartyLaunchSpec | undefined
  const gate = new PluginAgentToolsHost({
    switches: () => ({ ...switches }),
    setSwitches: (change) => Object.assign(switches, change),
    listPackages: () => [...specs.keys()].map(current).filter((spec): spec is ThirdPartyLaunchSpec => Boolean(spec)),
    // As the main process wires it: native backends turned off globally count
    // as disabled for every package.
    isDisabled: (pluginId) => !native.enabled || disabled.has(pluginId),
    hasConsent: async (candidate) => consented.has(candidate.pluginId),
    agentToolSince: (pluginId, name) => nameSince.get(`${pluginId} ${name}`) ?? since.get(pluginId) ?? null,
    setAgentMethods: (pluginId, version, methods) => mgr.setThirdPartyAgentMethods(pluginId, version, methods),
    confirmWrite,
    send: async (payload) => {
      sent.push(structuredClone(payload))
      return 'delivered'
    },
  })
  mgr.setAgentToolsHost(gate)
  mgr.setAgentToolWorkspaceResolver((candidate) => candidate === workspace)
  await gate.refresh()
  // The version a CLI last saw for each package, kept after a removal.
  const versions = new Map(packages.map((pkg) => [pkg.id, pkg.version]))
  let next = 0
  const request = (pluginId: string, name: string, args: Record<string, unknown> = {}, revision?: number) => ({
    request_id: `mcp:${++next}`,
    operation: 'agentTool',
    target: { plugin_id: pluginId, workspace_path: workspace },
    tool: { name, plugin_version: versions.get(pluginId) ?? '0.0.0', sync_revision: revision ?? sent.at(-1)?.revision ?? 0 },
    caller: { kind: 'pane', paneId: 'p-41', workspace },
    payload: { arguments: args },
  })
  const result: Live = {
    mgr, gate, root, workspace, specs, switches, disabled, consented, since, nameSince, confirmWrite, sent, pids, native, request,
    holdBind: () => {
      let release!: () => void
      bindHold = new Promise((done) => {
        release = () => {
          bindHold = undefined
          done()
        }
      })
      releases.push(release)
      bindWaiting = false
      return { release, waiting: () => bindWaiting }
    },
    onCleanup: (release) => {
      releases.push(release)
    },
    remove: (pluginId) => {
      specs.delete(pluginId)
    },
    call: async (pluginId, name, args, revision) =>
      await mgr.executeAgentToolCall(request(pluginId, name, args, revision)) as unknown as Record<string, unknown>,
    backendHost: () => (mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost,
  }
  return result
}

const DEVMAP: PackageFixture = { id: 'acme.fixture', prefix: 'fixture', version: '1.0.0' }

describe('agent tools end to end through a real backend child (B1-4)', () => {
  it('catalog → consent → switch on → served → called → routed to the child → answered with the pane identity', async () => {
    const f = await live([DEVMAP])
    const snapshot = f.sent.at(-1)!
    expect(snapshot).toMatchObject({ enabled: true, externalCallers: false })
    expect(snapshot.tools.map((entry) => [entry.name, entry.state])).toEqual([
      ['fixture_echo', 'available'], ['fixture_slow', 'available'], ['fixture_write', 'available'],
    ])
    const response = await f.call('acme.fixture', 'fixture_echo', { block: 'b1' })
    expect(response).toMatchObject({ ok: true, meta: { resultBytes: expect.any(Number), crossWorkspace: false } })
    const answer = response.result as { arguments: unknown; runtime: { initiator: unknown; pluginId: string } }
    expect(answer.arguments).toEqual({ block: 'b1' })
    expect(answer.runtime.pluginId).toBe('acme.fixture')
    expect(answer.runtime.initiator).toMatchObject({
      kind: 'agent', source: 'mcp', caller: { kind: 'pane', paneId: 'p-41', workspace: f.workspace, verifiedTo: 'pane' },
    })
    expect(f.pids).toHaveLength(1)
    expect(alive(f.pids[0])).toBe(true)
  }, 30_000)
})


/** A write confirmation the test answers itself: the call waits there,
 *  admitted but not yet dispatched, while the package changes. */
function holdWrites(f: Live): { release: (answer: boolean) => void; waiting: () => boolean } {
  let resolveAnswer: ((answer: boolean) => void) | undefined
  f.confirmWrite.mockImplementation(() => new Promise<boolean>((done) => {
    resolveAnswer = done
  }))
  f.onCleanup(() => resolveAnswer?.(false))
  return { release: (answer) => resolveAnswer?.(answer), waiting: () => resolveAnswer !== undefined }
}

/** The five ways a package stops being callable, each in the order the main
 *  process applies it (src/main/index.ts). */
const STOPS: Array<[string, string, (f: Live) => Promise<void>]> = [
  ['disable', 'plugin-disabled', async (f) => {
    f.disabled.add('acme.fixture')
    await f.mgr.stopThirdPartyBackends('acme.fixture')
    await f.gate.refresh()
  }],
  ['quarantine', 'plugin-quarantined', async (f) => {
    f.gate.mark('acme.fixture', 'quarantined')
    await f.gate.refresh()
  }],
  ['remove', 'plugin-not-installed', async (f) => {
    f.remove('acme.fixture')
    await f.mgr.stopThirdPartyBackends('acme.fixture')
    await f.gate.refresh()
  }],
  ['revoke consent', 'consent-required', async (f) => {
    f.consented.delete('acme.fixture')
    await f.mgr.stopThirdPartyBackends('acme.fixture')
    await f.gate.refresh()
  }],
  ['turn the master switch off', 'master-switch-off', async (f) => {
    await f.gate.setSwitches({ enabled: false })
  }],
  // Spawn-time trust revocation (index.ts scheduleDeniedBackendRuntimeQuarantine).
  ['revoke trust', 'plugin-revoked', async (f) => {
    f.gate.mark('acme.fixture', 'revoked')
    await f.gate.refresh()
    await f.mgr.revokePackageVersion('acme.fixture', '1.0.0')
  }],
]

/** The global third-party kill switch, in ThirdPartyBackendController.setEnabled(false)'s
 *  order, then the catalog refresh plugins:nativeBackends:setEnabled runs after it. */
async function nativeBackendsOff(f: Live): Promise<void> {
  f.native.enabled = false
  await f.mgr.stopThirdPartyBackends(null)
  await f.gate.refresh()
}

function agentToolCallsInFlight(f: Live): number {
  return (f.mgr as unknown as { agentToolCalls: Map<string, unknown> }).agentToolCalls.size
}

describe('a package stops being callable while a call waits (B1-4 races)', () => {
  for (const [label, reason, stop] of STOPS) {
    it(`${label} while the call is admitted but not dispatched: refused, never reaches the child`, async () => {
      const f = await live([DEVMAP])
      const hold = holdWrites(f)
      const pending = f.call('acme.fixture', 'fixture_write', { block: 'b1' })
      await waitUntil(hold.waiting)
      await stop(f)
      hold.release(true)
      const response = await pending
      expect(response).toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE' })
      // The reason names the stop. Only a revoked consent may be seen first
      // as the tool leaving the served methods: recheck does not ask consent.
      expect(label === 'revoke consent' ? [reason, 'tool-not-consented'] : [reason]).toContain(response.reason)
      expect(f.pids).toEqual([])
      expect(agentToolCallsInFlight(f)).toBe(0)
    }, 30_000)

    it(`${label}, then a call as from a CLI that still lists the old catalog: refused by the Host`, async () => {
      const f = await live([DEVMAP])
      const listed = f.sent.at(-1)!.revision
      await stop(f)
      const response = await f.call('acme.fixture', 'fixture_echo', {}, listed)
      expect(response).toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason })
      expect(f.pids).toEqual([])
    }, 30_000)
  }

  // Every stop also ends the child: the drains stop it, and the others close
  // the agent-tool binding it serves (setAgentMethods with no methods).
  const STOPS_THE_CHILD = new Set(['disable', 'quarantine', 'remove', 'revoke consent', 'turn the master switch off', 'revoke trust'])

  for (const [label, , stop] of STOPS) {
    it(`${label} while the call runs in the child: the call ends as stopping, nothing is left behind`, async () => {
      const f = await live([DEVMAP])
      // Long enough that only the stop can end it, whatever the load.
      const pending = f.call('acme.fixture', 'fixture_slow', { milliseconds: 20_000 })
      await waitUntil(() => agentToolCallsInFlight(f) === 1)
      await stop(f)
      // The answer the child would still give is not waited for.
      await expect(pending).resolves.toMatchObject({
        ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'plugin-stopping',
      })
      if (STOPS_THE_CHILD.has(label)) await waitUntil(() => f.pids.every((pid) => !alive(pid)))
      await expect(f.call('acme.fixture', 'fixture_echo', {})).resolves.toMatchObject({
        ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE',
      })
      expect(agentToolCallsInFlight(f)).toBe(0)
    }, 30_000)
  }

  // A running call the Host cancels for any reason but a stop (the view's
  // backend is closed: supervisor USER_CANCELLED) is not a plugin failure.
  it('a running call the Host cancels answers as stopping, not as a plugin failure', async () => {
    const f = await live([DEVMAP])
    const host = f.backendHost()
    const call = host.call.bind(host)
    vi.spyOn(host, 'call').mockImplementationOnce(async (...args: Parameters<PluginBackendHost['call']>) => {
      await call(...args).catch(() => undefined)
      throw new BackendPluginError('USER_CANCELLED')
    })
    const response = await f.call('acme.fixture', 'fixture_echo', {})
    expect(response).toMatchObject({
      ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'plugin-stopping',
    })
    expect(response).not.toHaveProperty('plugin_error')
    expect(agentToolCallsInFlight(f)).toBe(0)
  }, 30_000)

  // Not a stop of this package: Navide closes every backend (a quit). The
  // call is drained with the child, which is not a plugin failure either.
  it('Navide closes all backends while the call runs in the child: the call ends as stopping', async () => {
    const f = await live([DEVMAP])
    const pending = f.call('acme.fixture', 'fixture_slow', { milliseconds: 20_000 })
    await waitUntil(() => agentToolCallsInFlight(f) === 1)
    await f.mgr.closeBackendPlugins()
    const response = await pending
    expect(response).toMatchObject({
      ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'plugin-stopping',
    })
    expect(response).not.toHaveProperty('plugin_error')
    await waitUntil(() => f.pids.every((pid) => !alive(pid)))
    expect(agentToolCallsInFlight(f)).toBe(0)
  }, 30_000)
})

describe('a package stops while its binding is made (the bind-to-dispatch window)', () => {

  // Only a stop replaces a failed bind's error: a real failure that also ran
  // past the deadline is still reported as the plugin's failure.
  it('a bind that fails on its own past the deadline keeps its plugin error', async () => {
    const f = await live([DEVMAP])
    const mgr = f.mgr as unknown as { bindHeadlessAgentToolBackend: () => Promise<string> }
    vi.spyOn(mgr, 'bindHeadlessAgentToolBackend').mockImplementationOnce(async () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000)
      throw new BackendPluginError('BACKEND_UNAVAILABLE', 'spawn failed')
    })
    try {
      const response = await f.call('acme.fixture', 'fixture_echo', {})
      expect(response).toMatchObject({
        ok: false, error_code: 'PLUGIN_TOOL_FAILED', plugin_error: 'BACKEND_UNAVAILABLE',
      })
    } finally {
      vi.mocked(Date.now).mockRestore()
    }
    expect(agentToolCallsInFlight(f)).toBe(0)
  }, 30_000)

  for (const [label, reason, stop] of STOPS) {
    it(`${label} while the backend is being bound for a read call: refused before dispatch`, async () => {
      const f = await live([DEVMAP])
      // A read tool asks no confirmation: only the check after the bind is
      // left between this stop and the child.
      const hold = f.holdBind()
      const pending = f.call('acme.fixture', 'fixture_echo', { block: 'b1' })
      await waitUntil(hold.waiting)
      // A stop that drains the backend waits for the bind in progress: start
      // it (its state changes apply at once), then let the bind finish.
      const stopping = stop(f)
      hold.release()
      await stopping
      const response = await pending
      // Never dispatched, whichever stop.
      expect(response).toMatchObject({ ok: false })
      expect(response.result).toBeUndefined()
      // A bind the stop cancelled is the stop, not a plugin failure.
      expect(response).toMatchObject({ error_code: 'PLUGIN_TOOL_UNAVAILABLE' })
      // The catalog does not ask consent, so a revoked consent is seen only
      // as the stop cancelling the bind; every other stop names itself.
      expect(response.reason).toBe(label === 'revoke consent' ? 'plugin-stopping' : reason)
      expect(response).not.toHaveProperty('plugin_error')
      expect(agentToolCallsInFlight(f)).toBe(0)
    }, 30_000)
  }
})

describe('the global native backend switch turns off around a call', () => {
  it('while the call is admitted but not dispatched: unavailable, no child starts', async () => {
    const f = await live([DEVMAP])
    const hold = holdWrites(f)
    const pending = f.call('acme.fixture', 'fixture_write', { block: 'b1' })
    await waitUntil(hold.waiting)
    await nativeBackendsOff(f)
    hold.release(true)
    await expect(pending).resolves.toMatchObject({
      ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'plugin-disabled',
    })
    expect(f.pids).toEqual([])
    expect(agentToolCallsInFlight(f)).toBe(0)
  }, 30_000)

  it('before a call: the catalog says so and the call is unavailable, no child starts', async () => {
    const f = await live([DEVMAP])
    await nativeBackendsOff(f)
    expect(f.sent.at(-1)!.tools.map((entry) => entry.state)).toEqual([
      'plugin-disabled', 'plugin-disabled', 'plugin-disabled',
    ])
    await expect(f.call('acme.fixture', 'fixture_echo', {})).resolves.toMatchObject({
      ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'plugin-disabled',
    })
    expect(f.pids).toEqual([])
  }, 30_000)

  it('while the call runs in the child: the call ends as stopping, the child stops, nothing is left behind', async () => {
    const f = await live([DEVMAP])
    const pending = f.call('acme.fixture', 'fixture_slow', { milliseconds: 20_000 })
    await waitUntil(() => agentToolCallsInFlight(f) === 1)
    await nativeBackendsOff(f)
    await expect(pending).resolves.toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE' })
    await waitUntil(() => f.pids.every((pid) => !alive(pid)))
    expect(agentToolCallsInFlight(f)).toBe(0)
  }, 30_000)

  it('while the backend is being bound for a read call: unavailable, never dispatched', async () => {
    const f = await live([DEVMAP])
    const hold = f.holdBind()
    const pending = f.call('acme.fixture', 'fixture_echo', {})
    await waitUntil(hold.waiting)
    const stopping = nativeBackendsOff(f)
    hold.release()
    await stopping
    const response = await pending
    expect(response).toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'plugin-disabled' })
    expect(response).not.toHaveProperty('plugin_error')
    expect(f.pids).toEqual([])
  }, 30_000)

  it('turning it back on serves the tools again', async () => {
    const f = await live([DEVMAP])
    await nativeBackendsOff(f)
    f.native.enabled = true
    await f.gate.refresh()
    expect(f.sent.at(-1)!.tools.every((entry) => entry.state === 'available')).toBe(true)
    await expect(f.call('acme.fixture', 'fixture_echo', {})).resolves.toMatchObject({ ok: true })
  }, 30_000)
})

// Guard: quarantined code must not keep running in the background (it ends
// within milliseconds today, when the quarantine closes its binding).
describe('quarantine stops the headless agent-tool child at once', () => {
  it('a running child ends right after the quarantine, and the tools stay unavailable', async () => {
    const f = await live([DEVMAP])
    await expect(f.call('acme.fixture', 'fixture_echo', {})).resolves.toMatchObject({ ok: true })
    expect(f.pids.filter(alive)).toHaveLength(1)
    f.gate.mark('acme.fixture', 'quarantined')
    await f.gate.refresh()
    await waitUntil(() => f.pids.every((pid) => !alive(pid)), 5_000)
    await expect(f.call('acme.fixture', 'fixture_echo', {})).resolves.toMatchObject({
      ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'plugin-quarantined',
    })
    expect(f.pids.filter(alive)).toEqual([])
  }, 30_000)
})

describe('two packages claim the same name (DB1)', () => {
  const ALPHA: PackageFixture = { id: 'alpha.fixture', prefix: 'fixture', version: '1.0.0', tools: [
    { name: 'fixture_echo', method: 'fixture.echo', risk: 'read' },
  ] }
  const BETA: PackageFixture = { id: 'beta.fixture', prefix: 'fixture', version: '1.0.0', tools: [
    { name: 'fixture_echo', method: 'fixture.echo', risk: 'read' },
    { name: 'fixture_slow', method: 'fixture.delay', risk: 'read' },
  ] }

  it('the package allowed first holds the name; the later one is offline for it; calls go to the holder', async () => {
    const f = await live([ALPHA, BETA])
    const states = f.sent.at(-1)!.tools.map((entry) => [entry.pluginId, entry.name, entry.state])
    expect(states).toEqual(expect.arrayContaining([
      ['alpha.fixture', 'fixture_echo', 'available'],
      ['beta.fixture', 'fixture_echo', 'name-collision'],
      ['beta.fixture', 'fixture_slow', 'available'],
    ]))
    const served = await f.call('alpha.fixture', 'fixture_echo', {})
    expect((served.result as { runtime: { pluginId: string } }).runtime.pluginId).toBe('alpha.fixture')
    await expect(f.call('beta.fixture', 'fixture_echo', {})).resolves.toMatchObject({
      ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'name-collision',
    })
  }, 30_000)

  it('a name an update adds counts from that update, so it cannot take a held name', async () => {
    // alpha was allowed first (1.0.0, fixture_echo); its update 1.1.0 adds
    // beta's fixture_slow, allowed later than beta was.
    const f = await live([{ ...ALPHA, version: '1.1.0', tools: [
      { name: 'fixture_echo', method: 'fixture.echo', risk: 'read' },
      { name: 'fixture_slow', method: 'fixture.delay', risk: 'read' },
    ] }, BETA])
    f.nameSince.set('alpha.fixture fixture_slow', '2026-10-02T00:00:00.000Z')
    await f.gate.refresh()
    const states = f.sent.at(-1)!.tools.map((entry) => [entry.pluginId, entry.name, entry.state])
    expect(states).toEqual(expect.arrayContaining([
      ['alpha.fixture', 'fixture_slow', 'name-collision'],
      ['beta.fixture', 'fixture_slow', 'available'],
    ]))
    const served = await f.call('beta.fixture', 'fixture_slow', { milliseconds: 1 })
    expect(served).toMatchObject({ ok: true, result: { delayed: true } })
  }, 30_000)
})

describe('no regression against main', () => {
  it('master switch off: nothing is pushed, agentMethods stay empty, calls are refused, no child starts', async () => {
    const f = await live([DEVMAP], { enabled: false })
    expect(f.sent).toEqual([])
    expect(f.specs.get('acme.fixture')!.agentMethods).toEqual([])
    expect(f.backendHost().agentToolMethodsFor('acme.fixture', '1.0.0')).toEqual([])
    await expect(f.call('acme.fixture', 'fixture_echo', {})).resolves.toMatchObject({
      ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'master-switch-off',
    })
    expect(f.pids).toEqual([])
  }, 30_000)

  it('a package without agentTools stays out of the catalog, gets no agent methods, and no child starts for it', async () => {
    const plain: PackageFixture = { id: 'plain.indexer', prefix: 'indexer', version: '1.0.0', tools: [] }
    const f = await live([plain])
    expect(f.sent.at(-1)!.tools).toEqual([])
    expect(f.backendHost().agentToolMethodsFor('plain.indexer', '1.0.0')).toEqual([])
    await expect(f.call('plain.indexer', 'indexer_echo', {})).resolves.toMatchObject({
      ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE',
    })
    expect(f.pids).toEqual([])
  }, 30_000)
})
