import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginBackendHost, THIRD_PARTY_BACKEND_IDLE_MS } from './pluginBackendHost'
import {
  BackendPluginError,
  type BackendPluginLaunchSpec,
  type PluginBackendSupervisor,
  type PluginBackendSupervisorOptions,
} from './pluginBackendSupervisor'
import { SANDBOX_EXEC_PATH } from './pluginBackendSandbox'
import { NativeBackendStore } from './pluginNativeBackendStore'
import { ThirdPartyBackendController, type ThirdPartyAdmission } from './pluginThirdPartyBackends'

const workspace = realpathSync(process.cwd())

function thirdParty(packageDir = workspace, entryFile = join(workspace, 'backend')): BackendPluginLaunchSpec {
  return {
    pluginId: 'acme.indexer',
    packageVersion: '1.0.0',
    packageDir,
    entryFile,
    protocolVersion: 1,
    activation: 'startup',
    approvedMethods: ['fixture.echo', 'fixture.exit', 'plans.resolve_root'],
    agentMethods: [],
    approvedEvents: [],
    approvedBridgePorts: ['filesystem'],
    thirdParty: { name: 'Indexer', system: ['fs'] },
  }
}

const plans: BackendPluginLaunchSpec = {
  ...thirdParty(),
  pluginId: 'navide.plans',
  thirdParty: undefined,
}

function runtime(pluginId: string, instanceId = 'view-1') {
  return {
    pluginId,
    packageVersion: '1.0.0',
    workspaceId: 'workspace-1',
    instanceId,
    contributionKey: `${pluginId}.view`,
    hostWindowId: 'window-1',
    initiator: { kind: 'user', id: 'user-1' },
  } as const
}

function fakeSupervisor() {
  return {
    start: vi.fn(async () => ({ serverInfo: { name: 'x', version: '1' } })),
    restart: vi.fn(async () => ({ serverInfo: { name: 'x', version: '1' } })),
    close: vi.fn(async () => undefined),
  } as unknown as PluginBackendSupervisor
}

function admission(overrides: Partial<ThirdPartyAdmission> = {}): ThirdPartyAdmission {
  return {
    spawnProcess: vi.fn() as never,
    bridgeDispatcher: { dispatch: vi.fn() },
    beforeSpawn: vi.fn(async () => undefined),
    noteFailure: vi.fn(() => 1_000),
    workspaceRoot: workspace,
    ...overrides,
  }
}

const hosts: PluginBackendHost[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(hosts.splice(0).map((host) => host.close()))
})

describe('PluginBackendHost third-party branch', () => {
  it('refuses every third-party backend when no admission gate is installed', async () => {
    const createSupervisor = vi.fn(fakeSupervisor)
    const host = new PluginBackendHost({ createSupervisor })
    hosts.push(host)
    host.register(thirdParty())
    await expect(host.bindView(runtime('acme.indexer'), workspace, workspace))
      .rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    expect(createSupervisor).not.toHaveBeenCalled()
  })

  it('launches through the admission: sandboxed spawn, package bridge, workspace root, gate before spawn', async () => {
    const granted = admission()
    const admitThirdParty = vi.fn(async () => granted)
    const reverifyBeforeSpawn = vi.fn()
    let options: PluginBackendSupervisorOptions | undefined
    const resolvePlanRoot = vi.fn()
    const host = new PluginBackendHost({
      admitThirdParty,
      reverifyBeforeSpawn,
      resolvePlanRoot,
      createSupervisor: (_activation, next) => {
        options = next
        return fakeSupervisor()
      },
    })
    hosts.push(host)
    host.register(thirdParty())
    await host.bindView(runtime('acme.indexer'), workspace, workspace)
    expect(admitThirdParty).toHaveBeenCalledWith(expect.objectContaining({ pluginId: 'acme.indexer' }), workspace, expect.any(String))
    expect(resolvePlanRoot).not.toHaveBeenCalled()
    expect(options?.spawnProcess).toBe(granted.spawnProcess)
    expect(options?.bridgeDispatcher).toBe(granted.bridgeDispatcher)
    expect(options?.authorizedPlanRoot?.value).toBe(workspace)
    await options?.beforeSpawn?.()
    expect(reverifyBeforeSpawn).toHaveBeenCalled()
    expect(granted.beforeSpawn).toHaveBeenCalled()
  })

  it('never routes the first-party Plans backend through the third-party gate', async () => {
    const admitThirdParty = vi.fn(async () => admission())
    const host = new PluginBackendHost({
      admitThirdParty,
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
      createSupervisor: () => fakeSupervisor(),
    })
    hosts.push(host)
    host.register(plans)
    await host.bindView(runtime('navide.plans'), workspace, workspace)
    expect(admitThirdParty).not.toHaveBeenCalled()
  })

  it('restarts a failed child after the admission delay, and stays down on null', async () => {
    vi.useFakeTimers()
    const supervisor = fakeSupervisor()
    let options: PluginBackendSupervisorOptions | undefined
    const noteFailure = vi.fn<() => number | null>().mockReturnValueOnce(1_000).mockReturnValueOnce(null)
    const host = new PluginBackendHost({
      admitThirdParty: async () => admission({ noteFailure }),
      createSupervisor: (_activation, next) => {
        options = next
        return supervisor
      },
    })
    hosts.push(host)
    host.register(thirdParty())
    await host.bindView(runtime('acme.indexer'), workspace, workspace)
    options?.onFailure?.(new BackendPluginError('BACKEND_UNAVAILABLE'))
    await vi.advanceTimersByTimeAsync(999)
    expect(supervisor.restart).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(supervisor.restart).toHaveBeenCalledTimes(1)
    options?.onFailure?.(new BackendPluginError('BACKEND_UNAVAILABLE'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(supervisor.restart).toHaveBeenCalledTimes(1)
  })

  it('kill switch stops only third-party children', async () => {
    const supervisors: PluginBackendSupervisor[] = []
    const host = new PluginBackendHost({
      admitThirdParty: async () => admission(),
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
      createSupervisor: () => {
        const supervisor = fakeSupervisor()
        supervisors.push(supervisor)
        return supervisor
      },
    })
    hosts.push(host)
    host.register(thirdParty())
    host.register(plans)
    await host.bindView(runtime('acme.indexer'), workspace, workspace)
    await host.bindView(runtime('navide.plans', 'view-2'), workspace, workspace)
    await host.stopThirdPartyBackends(null)
    expect(supervisors[0].close).toHaveBeenCalled()
    expect(supervisors[1].close).not.toHaveBeenCalled()
    await expect(host.call('view-1', 'fixture.echo', null)).rejects.toMatchObject({ code: 'INVALID_RUNTIME' })
  })
})

describe('third-party idle auto-shutdown', () => {
  function controllableSupervisor(call: () => Promise<unknown>) {
    const subscriptions: Array<{ settle: () => void }> = []
    const supervisor = {
      start: vi.fn(async () => ({ serverInfo: { name: 'x', version: '1' } })),
      restart: vi.fn(),
      close: vi.fn(async () => undefined),
      clientFor: vi.fn(() => ({
        call: vi.fn(call),
        subscribe: vi.fn(() => {
          let settle!: () => void
          const settled = new Promise<void>((resolve) => { settle = resolve })
          subscriptions.push({ settle })
          return { dispose: vi.fn(), ready: Promise.resolve(), settled, acknowledged: Promise.resolve() }
        }),
      })),
    }
    return { supervisor: supervisor as unknown as PluginBackendSupervisor, subscriptions }
  }

  async function setup(call: () => Promise<unknown> = async () => ({ ok: true })) {
    vi.useFakeTimers()
    const supervisors: ReturnType<typeof controllableSupervisor>[] = []
    const admitThirdParty = vi.fn(async () => admission())
    const host = new PluginBackendHost({
      admitThirdParty,
      createSupervisor: () => {
        const next = controllableSupervisor(call)
        supervisors.push(next)
        return next.supervisor
      },
    })
    hosts.push(host)
    host.register({ ...thirdParty(), approvedEvents: ['files.changed'] })
    await host.bindView(runtime('acme.indexer'), workspace, workspace)
    return { host, admitThirdParty, supervisors }
  }

  it('stops the child after ten minutes without traffic', async () => {
    const { host, admitThirdParty, supervisors } = await setup()
    await host.call('view-1', 'fixture.echo', null)
    await vi.advanceTimersByTimeAsync(THIRD_PARTY_BACKEND_IDLE_MS - 1)
    expect(supervisors[0].supervisor.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(supervisors[0].supervisor.close).toHaveBeenCalledTimes(1)
    expect(admitThirdParty).toHaveBeenCalledTimes(1)
  })

  it('restarts lazily on the next call through the admission gate again', async () => {
    const { host, admitThirdParty, supervisors } = await setup()
    await host.call('view-1', 'fixture.echo', null)
    await vi.advanceTimersByTimeAsync(THIRD_PARTY_BACKEND_IDLE_MS)
    await expect(host.call('view-1', 'fixture.echo', null)).resolves.toEqual({ ok: true })
    expect(admitThirdParty).toHaveBeenCalledTimes(2)
    expect(supervisors).toHaveLength(2)
    expect(supervisors[1].supervisor.start).toHaveBeenCalled()
    // The new child idles out in turn.
    await vi.advanceTimersByTimeAsync(THIRD_PARTY_BACKEND_IDLE_MS)
    expect(supervisors[1].supervisor.close).toHaveBeenCalledTimes(1)
  })

  it('re-admission can refuse, and the next call tries again', async () => {
    const { host, admitThirdParty } = await setup()
    await vi.advanceTimersByTimeAsync(THIRD_PARTY_BACKEND_IDLE_MS)
    admitThirdParty.mockRejectedValueOnce(new BackendPluginError('BACKEND_UNAVAILABLE', 'turned off'))
    await expect(host.call('view-1', 'fixture.echo', null)).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    await expect(host.call('view-1', 'fixture.echo', null)).resolves.toEqual({ ok: true })
    expect(admitThirdParty).toHaveBeenCalledTimes(3)
  })

  it('never stops while a request is in flight', async () => {
    let finish!: (value: unknown) => void
    const { host, supervisors } = await setup(() => new Promise((resolve) => { finish = resolve }))
    const pending = host.call('view-1', 'fixture.echo', null)
    await vi.advanceTimersByTimeAsync(3 * THIRD_PARTY_BACKEND_IDLE_MS)
    expect(supervisors[0].supervisor.close).not.toHaveBeenCalled()
    finish({ ok: true })
    await expect(pending).resolves.toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(THIRD_PARTY_BACKEND_IDLE_MS)
    expect(supervisors[0].supervisor.close).toHaveBeenCalledTimes(1)
  })

  it('never stops while a subscription is open', async () => {
    const { host, supervisors } = await setup()
    await host.subscribe('view-1', 'files.changed', vi.fn())
    await vi.advanceTimersByTimeAsync(3 * THIRD_PARTY_BACKEND_IDLE_MS)
    expect(supervisors[0].supervisor.close).not.toHaveBeenCalled()
    supervisors[0].subscriptions[0].settle()
    await vi.advanceTimersByTimeAsync(THIRD_PARTY_BACKEND_IDLE_MS)
    expect(supervisors[0].supervisor.close).toHaveBeenCalledTimes(1)
  })

  it('does not apply to the first-party Plans backend', async () => {
    vi.useFakeTimers()
    const supervisor = controllableSupervisor(async () => ({ ok: true }))
    const host = new PluginBackendHost({
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
      createSupervisor: () => supervisor.supervisor,
    })
    hosts.push(host)
    host.register(plans)
    await host.bindView(runtime('navide.plans'), workspace, workspace)
    await host.call('view-1', 'fixture.echo', null)
    await vi.advanceTimersByTimeAsync(3 * THIRD_PARTY_BACKEND_IDLE_MS)
    expect(supervisor.supervisor.close).not.toHaveBeenCalled()
  })
})

const packagedFixture = join(process.cwd(), 'dist-test-fixtures/plans/backend/navide-plans')
const canRunLive = process.platform === 'darwin' && existsSync(SANDBOX_EXEC_PATH) && existsSync(packagedFixture)

describe.runIf(canRunLive)('third-party backend end to end in the macOS sandbox (live, PyInstaller)', () => {
  it('admits with consent, answers inside Seatbelt, and is denied ungranted bridge operations', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'third-party-e2e-')))
    const packageDir = join(root, 'package')
    mkdirSync(join(packageDir, 'backend'), { recursive: true })
    const entryFile = join(packageDir, 'backend', 'acme-indexer')
    copyFileSync(packagedFixture, entryFile)
    const store = new NativeBackendStore(join(root, 'store'))
    store.setEnabled(true)
    const promptConsent = vi.fn(async () => true)
    const controller = new ThirdPartyBackendController({
      store,
      dataRoot: join(root, 'data'),
      promptConsent,
      filesystemPort: () => undefined,
    })
    const host = new PluginBackendHost({
      admitThirdParty: (activation, workspacePath) => controller.admit(activation as never, workspacePath),
    })
    hosts.push(host)
    try {
      const spec = thirdParty(packageDir, entryFile)
      host.register(spec)
      await host.bindView(runtime('acme.indexer'), packageDir, root)
      expect(promptConsent).toHaveBeenCalledTimes(1)
      await expect(host.call('view-1', 'fixture.echo', { value: 1 }))
        .resolves.toMatchObject({ arguments: { value: 1 } })
      // filesystem.resolve_root is not part of the package bridge.
      await expect(host.call('view-1', 'plans.resolve_root', { workspace_path: root }))
        .rejects.toMatchObject({ code: 'PLUGIN_ERROR' })
      // The extraction directory lives in the private data directory.
      expect(existsSync(join(root, 'data', 'acme.indexer', 'tmp'))).toBe(true)
    } finally {
      await host.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('agent methods of a third-party backend (plan B1-b)', () => {
  const agent = { kind: 'agent', source: 'mcp', id: 'agent-1' } as const
  function callingSupervisor() {
    const call = vi.fn(async () => 'ok')
    const supervisor = {
      ...fakeSupervisor(),
      clientFor: vi.fn(() => ({ call })),
    } as unknown as PluginBackendSupervisor
    return { supervisor, call }
  }

  it('opens exactly the given set on agent-tool bindings only, never on views or the activation', async () => {
    const { supervisor, call } = callingSupervisor()
    const host = new PluginBackendHost({ admitThirdParty: async () => admission(), createSupervisor: () => supervisor })
    hosts.push(host)
    host.register(thirdParty())
    await host.bindView(runtime('acme.indexer'), workspace, workspace)
    const headless = await host.bindAgentToolWorkspace(
      { ...runtime('acme.indexer'), instanceId: null, contributionKey: null, hostWindowId: null },
      workspace,
      workspace,
    )
    await expect(host.call(headless, 'fixture.echo', null, { initiator: agent })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })

    expect(host.setAgentMethods('acme.indexer', '1.0.0', ['fixture.echo'])).toBe(true)
    await expect(host.call(headless, 'fixture.echo', null, { initiator: agent })).resolves.toBe('ok')
    await expect(host.call(headless, 'fixture.exit', null, { initiator: agent })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    // The view the user opened stays closed to agents, and so does the activation.
    await expect(host.call('view-1', 'fixture.echo', null, { initiator: agent })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(host.activationForPlugin('acme.indexer')?.agentMethods).toEqual([])
    expect(host.agentToolMethodsFor('acme.indexer', '1.0.0')).toEqual(['fixture.echo'])

    host.setAgentMethods('acme.indexer', '1.0.0', [])
    await expect(host.call(headless, 'fixture.echo', null, { initiator: agent })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('binds agent-tool workspaces for third-party packages only', async () => {
    const host = new PluginBackendHost({
      admitThirdParty: async () => admission(),
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
      createSupervisor: () => fakeSupervisor(),
    })
    hosts.push(host)
    host.register(plans)
    await expect(host.bindAgentToolWorkspace(
      { ...runtime('navide.plans'), instanceId: null, contributionKey: null, hostWindowId: null },
      workspace,
      workspace,
    )).rejects.toMatchObject({ code: 'INVALID_RUNTIME' })
  })

  it('refuses a method the package did not declare, and never touches Plans', () => {
    const host = new PluginBackendHost({ createSupervisor: () => fakeSupervisor() })
    hosts.push(host)
    host.register(thirdParty())
    host.register({ ...plans, agentMethods: ['fixture.echo'] })
    expect(() => host.setAgentMethods('acme.indexer', '1.0.0', ['not.declared'])).toThrow(BackendPluginError)
    expect(host.agentToolMethodsFor('acme.indexer', '1.0.0')).toEqual([])
    expect(host.setAgentMethods('navide.plans', '1.0.0', [])).toBe(false)
    expect(host.activationForPlugin('navide.plans')?.agentMethods).toEqual(['fixture.echo'])
    expect(host.setAgentMethods('acme.missing', '1.0.0', [])).toBe(false)
  })

  it('reports whether an instance is still bound', async () => {
    const host = new PluginBackendHost({ admitThirdParty: async () => admission(), createSupervisor: () => fakeSupervisor() })
    hosts.push(host)
    host.register(thirdParty())
    await host.bindView(runtime('acme.indexer'), workspace, workspace)
    expect(host.isBound('view-1')).toBe(true)
    await host.stopThirdPartyBackends('acme.indexer')
    expect(host.isBound('view-1')).toBe(false)
    expect(host.isBound('never')).toBe(false)
  })
})

describe('agent-tool caller on the runtime the child receives (plan B1-b)', () => {
  it('passes the Host-resolved caller through, frozen', async () => {
    const clientFor = vi.fn(() => ({ call: vi.fn(async () => 'ok') }))
    const supervisor = { ...fakeSupervisor(), clientFor } as unknown as PluginBackendSupervisor
    const host = new PluginBackendHost({ admitThirdParty: async () => admission(), createSupervisor: () => supervisor })
    hosts.push(host)
    host.register(thirdParty())
    host.setAgentMethods('acme.indexer', '1.0.0', ['fixture.echo'])
    const headless = await host.bindAgentToolWorkspace(
      { ...runtime('acme.indexer'), instanceId: null, contributionKey: null, hostWindowId: null },
      workspace,
      workspace,
    )
    const caller = { kind: 'pane', paneId: 'p-1', workspace, verifiedTo: 'pane' } as const
    await host.call(headless, 'fixture.echo', null, { initiator: { kind: 'agent', source: 'mcp', id: 'a-2', caller } })
    const [childRuntime] = clientFor.mock.calls[0] as unknown as [{ initiator: { caller?: unknown } }]
    expect(childRuntime.initiator).toEqual({ kind: 'agent', source: 'mcp', id: 'a-2', caller })
    expect(Object.isFrozen(childRuntime.initiator.caller)).toBe(true)
  })
})

describe('agent methods of a first-party backend (navide.browser)', () => {
  const agent = { kind: 'agent', source: 'mcp', id: 'agent-1' } as const
  const browser: BackendPluginLaunchSpec = {
    ...thirdParty(),
    pluginId: 'navide.browser',
    approvedMethods: ['browser.list', 'browser.act'],
    approvedBridgePorts: ['web'],
    thirdParty: undefined,
  }

  it('opens agent-tool methods and a headless binding outside the third-party gate', async () => {
    const call = vi.fn(async () => 'ok')
    const createSupervisor = vi.fn(() => ({ ...fakeSupervisor(), clientFor: vi.fn(() => ({ call })) }) as unknown as PluginBackendSupervisor)
    const admitThirdParty = vi.fn(async () => admission())
    const host = new PluginBackendHost({ admitThirdParty, createSupervisor })
    hosts.push(host)
    host.register(browser)
    expect(host.setAgentMethods('navide.browser', '1.0.0', ['browser.list'])).toBe(true)
    const headless = await host.bindAgentToolWorkspace(
      { ...runtime('navide.browser'), instanceId: null, contributionKey: null, hostWindowId: null },
      workspace,
      workspace,
    )
    expect(admitThirdParty).not.toHaveBeenCalled()
    await expect(host.call(headless, 'browser.list', null, { initiator: agent })).resolves.toBe('ok')
    await expect(host.call(headless, 'browser.act', null, { initiator: agent })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(host.activationForPlugin('navide.browser')?.agentMethods).toEqual([])
  })

  it('does not widen to other non-third-party activations: Plans and look-alike ids stay refused', async () => {
    const host = new PluginBackendHost({ createSupervisor: () => fakeSupervisor() })
    hosts.push(host)
    host.register(plans)
    host.register({ ...browser, pluginId: 'acme.browser' })
    expect(host.setAgentMethods('navide.plans', '1.0.0', [])).toBe(false)
    expect(host.setAgentMethods('acme.browser', '1.0.0', ['browser.list'])).toBe(false)
    await expect(host.bindAgentToolWorkspace(
      { ...runtime('acme.browser'), instanceId: null, contributionKey: null, hostWindowId: null },
      workspace,
      workspace,
    )).rejects.toMatchObject({ code: 'INVALID_RUNTIME' })
  })
})
