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
  request: (pluginId: string, name: string, args?: Record<string, unknown>, revision?: number) => Record<string, unknown>
  call: (pluginId: string, name: string, args?: Record<string, unknown>, revision?: number) => Promise<Record<string, unknown>>
  backendHost: () => PluginBackendHost
}

const lives: Live[] = []

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
  for (const live of lives.splice(0)) {
    await live.mgr.closeBackendPlugins()
    // Only the PIDs this file started, each waited for until it is gone.
    await waitUntil(() => live.pids.every((pid) => !alive(pid)))
    rmSync(live.root, { recursive: true, force: true })
  }
})

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
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const mgr = new FrontendPluginManager()
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
  const pids: number[] = []
  // A real child on stdio, without the OS sandbox (that is the live
  // pluginBackendHost.thirdParty test's job): what is under test is the
  // agent tool path in front of it.
  mgr.setThirdPartyBackendAdmitter(async () => ({
    spawnProcess: (_entryFile, spawnOptions) => {
      const child = spawn(process.execPath, [FIXTURE], {
        ...spawnOptions,
        env: { ...spawnOptions.env, NAVIDE_FIXTURE: 'backend-wire' },
      }) as ChildProcessWithoutNullStreams
      if (child.pid !== undefined) pids.push(child.pid)
      return child
    },
    bridgeDispatcher: { dispatch: vi.fn() },
    beforeSpawn: async () => undefined,
    noteFailure: () => null,
    workspaceRoot: workspace,
  }))
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
    isDisabled: (pluginId) => disabled.has(pluginId),
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
    mgr, gate, root, workspace, specs, switches, disabled, consented, since, nameSince, confirmWrite, sent, pids, request,
    remove: (pluginId) => {
      specs.delete(pluginId)
    },
    call: async (pluginId, name, args, revision) =>
      await mgr.executeAgentToolCall(request(pluginId, name, args, revision)) as unknown as Record<string, unknown>,
    backendHost: () => (mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost,
  }
  lives.push(result)
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
]

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
      // The reason names the stop, except that a stop which also took the
      // tool out of the served methods may be seen first as that.
      expect([reason, 'tool-not-consented']).toContain(response.reason)
      expect(f.pids).toEqual([])
      expect(agentToolCallsInFlight(f)).toBe(0)
    }, 30_000)

    it(`${label}, then a call from a CLI that still lists the old catalog: refused by the Host`, async () => {
      const f = await live([DEVMAP])
      const listed = f.sent.at(-1)!.revision
      await stop(f)
      const response = await f.call('acme.fixture', 'fixture_echo', {}, listed)
      expect(response).toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason })
      expect(f.pids).toEqual([])
    }, 30_000)
  }

  // Disable, remove and a revoked consent also stop the child; quarantine and
  // the master switch leave it to its idle shutdown (THIRD_PARTY_BACKEND_IDLE_MS).
  const STOPS_THE_CHILD = new Set(['disable', 'remove', 'revoke consent'])

  for (const [label, , stop] of STOPS) {
    it(`${label} while the call runs in the child: the call ends as stopping, nothing is left behind`, async () => {
      const f = await live([DEVMAP])
      const pending = f.call('acme.fixture', 'fixture_slow', { milliseconds: 2_000 })
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
