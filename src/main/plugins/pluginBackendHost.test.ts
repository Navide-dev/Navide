import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKEND_RESTART_BUDGET_SPENT_MESSAGE,
  PluginBackendHost,
  canonicalBackendPackageDir,
  type PluginBackendHostOptions,
} from './pluginBackendHost'
import type {
  BackendPluginLaunchSpec,
  PluginBackendSupervisorOptions,
} from './pluginBackendSupervisor'
import { BackendPluginError, PluginBackendSupervisor } from './pluginBackendSupervisor'
import { createProductionPlansBridgeDispatcher, createTestPlansFilesystemPort } from './plansBridge'
import {
  MAX_BACKEND_CALLS_PER_INSTANCE,
  MAX_BACKEND_CHILDREN,
  MAX_BACKEND_SUBSCRIPTIONS_PER_INSTANCE,
  MAX_BACKEND_TIMEOUT_MS,
} from './pluginBackendLimits'
import { BACKEND_CRASH_WINDOW_MS, BACKEND_RESTART_DELAYS_MS } from './pluginThirdPartyBackends'

const fixture = fileURLToPath(new URL('./test-fixtures/backend-wire-child.mjs', import.meta.url))
const packagedFixture = join(process.cwd(), 'dist-test-fixtures/plans/backend/navide-plans')
const packagedGoFixture = join(process.cwd(), 'dist-test-fixtures/plans/backend/navide-plans-go')
const packagedFixtureEnabled = process.env.NAVIDE_TEST_PACKAGED_PLANS === '1'
if (packagedFixtureEnabled && (!existsSync(packagedFixture) || !existsSync(packagedGoFixture))) {
  throw new Error(
    `NAVIDE_TEST_PACKAGED_PLANS=1 requires packaged fixtures at ${packagedFixture} and ${packagedGoFixture}; run pnpm run build:plans:fixture first.`,
  )
}
const packagedBackendEnvironment: Record<string, string> = {}
for (const key of ['TMPDIR', 'TEMP', 'TMP'] as const) {
  const value = process.env[key]
  if (typeof value === 'string' && value.length > 0) packagedBackendEnvironment[key] = value
}
const activation: BackendPluginLaunchSpec = {
  pluginId: 'navide.plans',
  packageVersion: '0.1.92',
  packageDir: process.cwd(),
  entryFile: fixture,
  protocolVersion: 1,
  activation: 'startup',
  approvedMethods: ['fixture.delay', 'fixture.echo', 'fixture.emit', 'fixture.exit', 'plans.resolve_root'],
  approvedEvents: ['fixture.changed', 'plans.changed'],
  approvedBridgePorts: ['filesystem'],
}

const runtime = {
  pluginId: activation.pluginId,
  packageVersion: activation.packageVersion,
  workspaceId: 'workspace-1',
  instanceId: 'view-1',
  contributionKey: 'navide.plans.window',
  hostWindowId: 'window-1',
  initiator: { kind: 'user', id: 'user-1' },
} as const

function makeHost(entryFile = fixture): PluginBackendHost {
  const options: PluginBackendSupervisorOptions = {
    // PyInstaller --onefile needs a writable temp directory for extraction;
    // keep the test launcher aligned with the Host's minimal environment.
    environment: { ...packagedBackendEnvironment, NAVIDE_FIXTURE: 'backend-wire' },
    bridgeDispatcher: createProductionPlansBridgeDispatcher({ filesystem: createTestPlansFilesystemPort() }),
    spawnProcess: (nextEntryFile, spawnOptions) =>
      spawn(nextEntryFile === fixture ? process.execPath : nextEntryFile, nextEntryFile === fixture ? [nextEntryFile] : [], {
        ...spawnOptions,
        env: spawnOptions.env,
      }) as ChildProcessWithoutNullStreams,
  }
  const hostOptions: PluginBackendHostOptions = {
    createSupervisor: (nextActivation) => {
      return new PluginBackendSupervisor({ ...nextActivation, entryFile }, options)
    },
    resolvePlanRoot: async ({ workspacePath }) => workspacePath,
  }
  return new PluginBackendHost(hostOptions)
}

describe('PluginBackendHost', () => {
  const hosts: PluginBackendHost[] = []

  afterEach(async () => {
    delete (globalThis as unknown as { nav?: unknown }).nav
    await Promise.all(hosts.splice(0).map((host) => host.close()))
  })

  it('routes a bound view through the matching package version', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    await expect(host.call('view-1', 'fixture.echo', {
      value: 42,
      runtime: { workspaceId: 'forged' },
    })).resolves.toEqual({
      arguments: {
        value: 42,
        runtime: { workspaceId: 'forged' },
      },
      runtime,
    })
  })

  it('creates an independent supervisor and root binding for each view', async () => {
    const supervisors: Array<{
      clientFor: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
    }> = []
    const createSupervisor = vi.fn((
      _activation: BackendPluginLaunchSpec,
      _options: PluginBackendSupervisorOptions,
    ) => {
      const client = {
        call: vi.fn(async () => null as never),
        subscribe: vi.fn(() => ({
          acknowledged: Promise.resolve(),
          settled: Promise.resolve({ reason: 'cancelled' as const }),
          dispose: vi.fn(),
        })),
      }
      const supervisor = {
        start: vi.fn(async () => ({
          value: null,
          serverInfo: { name: 'controlled', version: '1.0.0' },
        })),
        clientFor: vi.fn(() => client),
        close: vi.fn(async () => undefined),
      }
      supervisors.push(supervisor)
      return supervisor as unknown as PluginBackendSupervisor
    })
    const host = new PluginBackendHost({
      createSupervisor,
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())
    host.bindView({ ...runtime, instanceId: 'view-2', hostWindowId: 'window-2' }, activation.packageDir, process.cwd())

    await expect(host.call('view-1', 'fixture.echo', null)).resolves.toBeNull()
    await expect(host.call('view-2', 'fixture.echo', null)).resolves.toBeNull()
    expect(createSupervisor).toHaveBeenCalledTimes(2)
    expect(supervisors[0]).not.toBe(supervisors[1])
    const firstOptions = createSupervisor.mock.calls[0]?.[1]
    const secondOptions = createSupervisor.mock.calls[1]?.[1]
    expect(firstOptions?.authorizedPlanRoot)
      .not.toBe(secondOptions?.authorizedPlanRoot)
  })

  it('forwards a child failure with the Host-bound runtime identity', async () => {
    const onBackendFailure = vi.fn()
    let notifyFailure: ((error: BackendPluginError) => void) | undefined
    const supervisor = {
      start: vi.fn(async () => ({
        value: null,
        serverInfo: { name: 'controlled', version: '1.0.0' },
      })),
      clientFor: vi.fn(() => ({ call: vi.fn(async () => null as never), subscribe: vi.fn() })),
      close: vi.fn(async () => undefined),
    }
    const host = new PluginBackendHost({
      onBackendFailure,
      createSupervisor: vi.fn((
        _activation: BackendPluginLaunchSpec,
        options: PluginBackendSupervisorOptions,
      ) => {
        notifyFailure = options.onFailure
        return supervisor as unknown as PluginBackendSupervisor
      }),
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(host)
    host.register(activation)

    await expect(host.bindView(runtime, activation.packageDir, process.cwd())).resolves.toBeUndefined()
    const error = new BackendPluginError('BACKEND_UNAVAILABLE')
    notifyFailure?.(error)

    expect(onBackendFailure).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: runtime.pluginId,
      packageVersion: runtime.packageVersion,
      instanceId: runtime.instanceId,
    }), error)
  })

  it('forwards host-only diagnostics and original cause without leaking OS paths to caller', async () => {
    const onStderr = vi.fn()
    const onBackendFailure = vi.fn()
    const spawnError = new Error('spawn /secret/path/plans ENOENT')
    const host = new PluginBackendHost({
      onStderr,
      onBackendFailure,
      createSupervisor: (_act, options) => {
        return new PluginBackendSupervisor(_act, {
          ...options,
          spawnProcess: () => {
            throw spawnError
          },
        })
      },
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(host)
    host.register(activation)

    await expect(host.bindView(runtime, activation.packageDir, process.cwd())).resolves.toBeUndefined()
    const callPromise = host.call(runtime.instanceId, 'fixture.echo', null)
    await expect(callPromise).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
    })
    const error = await callPromise.catch((err) => err)
    expect(String(error)).not.toContain('/secret/path/plans')
    expect(onStderr).toHaveBeenCalledWith(expect.stringContaining('/secret/path/plans ENOENT'))
    expect(onBackendFailure).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: runtime.instanceId }),
      expect.objectContaining({
        code: 'BACKEND_UNAVAILABLE',
        message: 'Backend plugin is unavailable.',
        cause: spawnError,
      }),
    )
  })

  it('caps bound child process slots and releases a failed root binding', async () => {
    const createSupervisor = vi.fn(() => ({
      start: vi.fn(async () => ({
        value: null,
        serverInfo: { name: 'controlled', version: '1.0.0' },
      })),
      clientFor: vi.fn(() => ({ call: vi.fn(async () => null as never), subscribe: vi.fn() })),
      close: vi.fn(async () => undefined),
    }) as unknown as PluginBackendSupervisor)
    const resolvePlanRoot = vi.fn(async () => tmpdir())
    const host = new PluginBackendHost({ createSupervisor, resolvePlanRoot })
    hosts.push(host)
    host.register(activation)
    await expect(host.bindView(runtime, activation.packageDir, process.cwd()))
      .rejects.toMatchObject({ code: 'INVALID_RUNTIME' })

    const cappedHost = new PluginBackendHost({
      createSupervisor,
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(cappedHost)
    cappedHost.register(activation)
    for (let index = 0; index < MAX_BACKEND_CHILDREN; index += 1) {
      cappedHost.bindView({
        ...runtime,
        instanceId: `view-${index}`,
        hostWindowId: `window-${index}`,
      }, activation.packageDir, process.cwd())
    }
    expect(() => cappedHost.bindView({
      ...runtime,
      instanceId: 'view-over-cap',
      hostWindowId: 'window-over-cap',
    }, activation.packageDir, process.cwd())).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_LIMIT' }),
    )
  })

  it('reports the child slot it can no longer reclaim after a failed close', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const closeError = new Error('child did not exit')
    let created = 0
    const createSupervisor = vi.fn(() => {
      const failing = created++ === 0
      return {
        start: vi.fn(async () => ({
          value: null,
          serverInfo: { name: 'controlled', version: '1.0.0' },
        })),
        clientFor: vi.fn(() => ({ call: vi.fn(async () => null as never), subscribe: vi.fn() })),
        close: vi.fn(async () => {
          if (failing) throw closeError
        }),
      } as unknown as PluginBackendSupervisor
    })
    const host = new PluginBackendHost({
      createSupervisor,
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(host)
    host.register(activation)
    await host.bindView(runtime, activation.packageDir, process.cwd())

    await expect(host.unbindView('view-1')).rejects.toBe(closeError)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('backend child slot retained after a failed close'),
    )

    // A failed close cannot prove the child exited, so its slot stays consumed
    // and the limit it costs says so.
    for (let index = 1; index < MAX_BACKEND_CHILDREN; index += 1) {
      host.bindView({
        ...runtime,
        instanceId: `view-${index}`,
        hostWindowId: `window-${index}`,
      }, activation.packageDir, process.cwd())
    }
    expect(() => host.bindView({
      ...runtime,
      instanceId: 'view-over-cap',
      hostWindowId: 'window-over-cap',
    }, activation.packageDir, process.cwd())).toThrowError(expect.objectContaining({
      code: 'RESOURCE_LIMIT',
      message: expect.stringContaining(
        `1 of ${MAX_BACKEND_CHILDREN} slots are retained by backend children whose close failed`,
      ),
    }))
  })

  it('rejects a filesystem binding without a Host root resolver', async () => {
    const createSupervisor = vi.fn(() => undefined as unknown as PluginBackendSupervisor)
    const host = new PluginBackendHost({ createSupervisor })
    hosts.push(host)
    host.register(activation)

    await expect(host.bindView(runtime, activation.packageDir, process.cwd()))
      .rejects.toMatchObject({ code: 'INVALID_RUNTIME' })
    expect(createSupervisor).not.toHaveBeenCalled()
  })

  it('binds a non-filesystem activation without a Host root resolver', async () => {
    const supervisor = {
      close: vi.fn(async () => undefined),
    } as unknown as PluginBackendSupervisor
    const createSupervisor = vi.fn(() => supervisor)
    const host = new PluginBackendHost({ createSupervisor })
    hosts.push(host)
    const nonFilesystemActivation = { ...activation, approvedBridgePorts: [] }
    host.register(nonFilesystemActivation)

    await expect(host.bindView(runtime, nonFilesystemActivation.packageDir, process.cwd()))
      .resolves.toBeUndefined()
    expect(createSupervisor).toHaveBeenCalledOnce()
  })

  it('allows only explicitly adapted backend methods to use an agent Initiator', async () => {
    const client = {
      call: vi.fn(async () => ({ ok: true }) as never),
      subscribe: vi.fn(),
    }
    const supervisor = {
      start: vi.fn(async () => ({
        value: null,
        serverInfo: { name: 'controlled', version: '1.0.0' },
      })),
      clientFor: vi.fn(() => client),
      close: vi.fn(async () => undefined),
    }
    const host = new PluginBackendHost({
      createSupervisor: vi.fn(() => supervisor as unknown as PluginBackendSupervisor),
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(host)
    host.register({ ...activation, agentMethods: ['fixture.echo'] })
    host.bindView(runtime, activation.packageDir, process.cwd())

    const initiator = { kind: 'agent' as const, source: 'mcp' as const, id: 'agent-1' }
    await expect(host.call('view-1', 'fixture.delay', null, { initiator })).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    })
    await expect(host.call('view-1', 'fixture.echo', null, { initiator })).resolves.toEqual({ ok: true })
    host.bindView({
      ...runtime,
      instanceId: 'agent-view',
      hostWindowId: 'agent-window',
      initiator,
    }, activation.packageDir, process.cwd())
    await expect(host.call('agent-view', 'fixture.delay', null)).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    })
    await expect(host.call('agent-view', 'fixture.echo', null)).resolves.toEqual({ ok: true })
    expect(client.call).toHaveBeenCalledTimes(2)
  })

  it('binds one headless workspace runtime without a BrowserWindow', async () => {
    const supervisor = {
      start: vi.fn(async () => ({
        value: null,
        serverInfo: { name: 'controlled', version: '1.0.0' },
      })),
      clientFor: vi.fn(() => ({
        call: vi.fn(async () => ({ workspace: 'bound' }) as never),
        subscribe: vi.fn(),
      })),
      close: vi.fn(async () => undefined),
    }
    const host = new PluginBackendHost({
      createSupervisor: vi.fn(() => supervisor as unknown as PluginBackendSupervisor),
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(host)
    host.register(activation)

    const instanceId = await host.bindWorkspace({
      ...runtime,
      instanceId: null,
      contributionKey: null,
      hostWindowId: null,
    }, activation.packageDir, process.cwd())

    expect(instanceId).toEqual(expect.any(String))
    await expect(host.call(instanceId, 'fixture.echo', null)).resolves.toEqual({ workspace: 'bound' })
    await host.unbindView(instanceId)
  })

  it('routes the Plans root operation and event through the non-Python fixture', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    let resolveEvent!: (payload: unknown) => void
    const eventReceived = new Promise<unknown>((resolve) => {
      resolveEvent = resolve
    })
    const subscription = await host.subscribe('view-1', 'plans.changed', resolveEvent)
    await subscription.acknowledged

    await expect(host.call('view-1', 'plans.resolve_root', {
      workspace_path: process.cwd(),
    })).resolves.toEqual({ ok: true, root: process.cwd() })
    await expect(eventReceived).resolves.toEqual({ workspace_path: process.cwd() })
  })

  it('rejects unbound views and methods outside the Host allowlist', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    await expect(host.call('other-view', 'fixture.echo', null))
      .rejects.toMatchObject({ code: 'INVALID_RUNTIME' })
    await expect(host.call('view-1', 'fixture.notallowed', null))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('rejects every call and subscription of a generic package before any child spawn', async () => {
    const spawnProcess = vi.fn(() => {
      throw new Error('a generic package with no approved surface must never spawn')
    })
    const startSpies: Array<ReturnType<typeof vi.spyOn>> = []
    const host = new PluginBackendHost({
      createSupervisor: (nextActivation, options) => {
        const supervisor = new PluginBackendSupervisor(nextActivation, { ...options, spawnProcess })
        startSpies.push(vi.spyOn(supervisor, 'start'))
        return supervisor
      },
    })
    hosts.push(host)
    // Mirrors the generic third-party tuple the main process registers.
    const genericActivation: BackendPluginLaunchSpec = {
      ...activation,
      pluginId: 'example.third-party',
      approvedMethods: [],
      approvedEvents: [],
      approvedBridgePorts: [],
    }
    host.register(genericActivation)
    await host.bindView({
      ...runtime,
      pluginId: genericActivation.pluginId,
      contributionKey: 'example.third-party.window',
    }, genericActivation.packageDir, process.cwd())

    await expect(host.call('view-1', 'fixture.echo', null))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(host.subscribe('view-1', 'fixture.changed', vi.fn()))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    expect(startSpies).toHaveLength(1)
    expect(startSpies[0]).toHaveBeenCalledTimes(0)
    expect(spawnProcess).toHaveBeenCalledTimes(0)
  })

  it('requires an exact package version for activation lookup', () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)

    expect(host.activationFor('navide.plans', activation.packageVersion, activation.packageDir)).toBe(activation)
    expect(host.activationFor('navide.plans', '9.9.9', activation.packageDir)).toBeUndefined()
    expect(host.activationFor('navide.plans', activation.packageVersion, join(process.cwd(), '..'))).toBeUndefined()
  })

  it('fails closed for missing, non-directory, and symlinked package roots', () => {
    const host = makeHost()
    hosts.push(host)
    const root = mkdtempSync(join(tmpdir(), 'navide-backend-root-'))
    const symlink = join(root, 'package-link')
    symlinkSync(process.cwd(), symlink)
    try {
      expect(() => host.register({
        ...activation,
        packageDir: join(root, 'missing'),
      })).toThrowError(expect.objectContaining({ code: 'INVALID_ACTIVATION' }))
      expect(() => host.register({
        ...activation,
        packageDir: fixture,
      })).toThrowError(expect.objectContaining({ code: 'INVALID_ACTIVATION' }))
      expect(() => host.register({
        ...activation,
        packageDir: symlink,
      })).toThrowError(expect.objectContaining({ code: 'INVALID_ACTIVATION' }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Fedora Silverblue's /home → var/home, a stow-managed ~/.config, a home on
  // another disk: every plugin lives under a symlinked ancestor there, and the
  // root used to be refused for not equalling its own realpath.
  it('accepts a real package root reached through a symlinked ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-backend-root-'))
    try {
      const real = join(root, 'real-home', 'plugins')
      mkdirSync(join(real, 'pkg'), { recursive: true })
      symlinkSync(join(root, 'real-home'), join(root, 'home-link'))
      const viaLink = join(root, 'home-link', 'plugins', 'pkg')

      const canonical = canonicalBackendPackageDir(viaLink)
      expect(canonical).toBe(realpathSync(join(real, 'pkg')))
      // Same canonical answer whichever spelling reaches it, so descriptor and
      // activation compare equal across the two.
      expect(canonicalBackendPackageDir(join(real, 'pkg'))).toBe(canonical)
      // The root itself being a link is still refused.
      symlinkSync(join(real, 'pkg'), join(real, 'pkg-link'))
      expect(canonicalBackendPackageDir(join(real, 'pkg-link'))).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a timeout above the Host-private bound before child dispatch', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    await expect(host.call('view-1', 'fixture.echo', null, {
      timeoutMs: MAX_BACKEND_TIMEOUT_MS + 1,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('enforces per-view call and subscription limits', async () => {
    const settledSubscriptions: Array<() => void> = []
    const controlledSupervisor = {
      start: vi.fn(async () => ({
        value: null,
        serverInfo: { name: 'controlled', version: '1.0.0' },
      })),
      clientFor: vi.fn(() => ({
        call: vi.fn(async () => null as never),
        subscribe: vi.fn(() => {
          let settle!: () => void
          const settled = new Promise<{ reason: 'cancelled' }>((resolve) => {
            settle = () => resolve({ reason: 'cancelled' })
          })
          settledSubscriptions.push(settle)
          return {
            acknowledged: Promise.resolve(),
            settled,
            dispose: settle,
          }
        }),
      })),
      close: vi.fn(async () => undefined),
    } as unknown as PluginBackendSupervisor
    const host = new PluginBackendHost({
      createSupervisor: () => controlledSupervisor,
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    const calls = Array.from({ length: MAX_BACKEND_CALLS_PER_INSTANCE }, () =>
      host.call('view-1', 'fixture.delay', { milliseconds: 10_000 })
    )
    await expect(host.call('view-1', 'fixture.delay', { milliseconds: 10_000 }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })

    const subscriptions = await Promise.all(
      Array.from({ length: MAX_BACKEND_SUBSCRIPTIONS_PER_INSTANCE }, () =>
        host.subscribe('view-1', 'fixture.changed', () => undefined)
      )
    )
    await expect(host.subscribe('view-1', 'fixture.changed', () => undefined))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })

    for (const subscription of subscriptions) subscription.dispose()
    await Promise.all(calls)
    for (const settle of settledSubscriptions) settle()
  })

  it('cancels an in-flight call when the view is destroyed', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    const pending = host.call('view-1', 'fixture.delay', { milliseconds: 10_000 })
    host.unbindView('view-1')

    await expect(pending).rejects.toMatchObject({ code: 'USER_CANCELLED' })
  })

  it('rejects forged package and view identity at the binding boundary', () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)

    expect(() => host.bindView({ ...runtime, packageVersion: '9.9.9' }, activation.packageDir))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RUNTIME' }))
    expect(() => host.bindView(runtime, join(process.cwd(), '..')))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RUNTIME' }))
    expect(() => host.bindView({ ...runtime, workspaceId: '' }, activation.packageDir))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RUNTIME' }))
  })

  it('settles a view subscription when the Host unbinds the view', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    const subscription = await host.subscribe('view-1', 'fixture.changed', () => undefined)
    await subscription.acknowledged
    host.unbindView('view-1')

    await expect(subscription.settled).resolves.toMatchObject({ reason: 'view-destroyed' })
  })

  it('keeps admission closed when revocation drain fails', async () => {
    const host = makeHost()
    host.register(activation)
    await host.bindView(runtime, activation.packageDir, process.cwd())
    const unbind = vi.spyOn(host, 'unbindView').mockRejectedValueOnce(new Error('drain failed'))
    await expect(host.revokePackageVersion(activation.pluginId, activation.packageVersion))
      .rejects.toThrow('drain failed')
    expect(() => host.bindView({ ...runtime, instanceId: 'new-view' }, activation.packageDir, process.cwd()))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_STOPPING' }))
    unbind.mockRestore()
    await expect(host.revokePackageVersion(activation.pluginId, activation.packageVersion))
      .rejects.toThrow('drain failed')
    await expect(host.close()).rejects.toThrow('drain failed')
  })

  it('revokes one package version and settles its calls and subscriptions', async () => {
    const host = makeHost()
    hosts.push(host)
    host.register(activation)
    host.bindView(runtime, activation.packageDir, process.cwd())

    const subscription = await host.subscribe('view-1', 'fixture.changed', () => undefined)
    await subscription.acknowledged
    const pending = host.call('view-1', 'fixture.delay', { milliseconds: 10_000 })
      .then(() => null, (error: unknown) => error)

    const revocation = host.revokePackageVersion(activation.pluginId, activation.packageVersion)
    await Promise.resolve()
    await expect(host.call('view-1', 'fixture.echo', null)).rejects.toMatchObject({
      code: 'PLUGIN_STOPPING',
    })
    await revocation

    await expect(pending).resolves.toMatchObject({ code: 'PLUGIN_STOPPING' })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'plugin-stopping' })
    expect(host.hasActivation(activation.pluginId, activation.packageVersion)).toBe(false)
    await expect(host.call('view-1', 'fixture.echo', null)).rejects.toMatchObject({
      code: 'INVALID_RUNTIME',
    })
  })
})

describe('first-party backend restart after a child failure', () => {
  const hosts: PluginBackendHost[] = []

  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(hosts.splice(0).map((host) => host.close()))
  })

  async function bindFailingView(): Promise<{
    host: PluginBackendHost
    restart: ReturnType<typeof vi.fn>
    fail: () => void
  }> {
    let notifyFailure: ((error: BackendPluginError) => void) | undefined
    const restart = vi.fn(async () => ({ serverInfo: { name: 'controlled', version: '1.0.0' } }))
    const supervisor = {
      start: vi.fn(async () => ({ serverInfo: { name: 'controlled', version: '1.0.0' } })),
      restart,
      clientFor: vi.fn(() => ({ call: vi.fn(async () => null as never), subscribe: vi.fn() })),
      close: vi.fn(async () => undefined),
    }
    const host = new PluginBackendHost({
      createSupervisor: (_activation, options) => {
        notifyFailure = options.onFailure
        return supervisor as unknown as PluginBackendSupervisor
      },
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(host)
    host.register(activation)
    await host.bindView(runtime, activation.packageDir, process.cwd())
    return {
      host,
      restart,
      fail: () => notifyFailure?.(new BackendPluginError('BACKEND_UNAVAILABLE')),
    }
  }

  it('restarts a failed child after the shared backoff delay', async () => {
    vi.useFakeTimers()
    const { restart, fail } = await bindFailingView()

    fail()
    await vi.advanceTimersByTimeAsync(BACKEND_RESTART_DELAYS_MS[0] - 1)
    expect(restart).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('stops restarting once the failure budget is spent', async () => {
    vi.useFakeTimers()
    const { restart, fail } = await bindFailingView()

    for (const [index, delay] of BACKEND_RESTART_DELAYS_MS.entries()) {
      fail()
      await vi.advanceTimersByTimeAsync(delay)
      expect(restart).toHaveBeenCalledTimes(index + 1)
    }
    fail()
    await vi.advanceTimersByTimeAsync(BACKEND_CRASH_WINDOW_MS)
    expect(restart).toHaveBeenCalledTimes(BACKEND_RESTART_DELAYS_MS.length)
  })

  it('does not restart a child whose view was unbound before the delay elapsed', async () => {
    vi.useFakeTimers()
    const { host, restart, fail } = await bindFailingView()

    fail()
    await host.unbindView(runtime.instanceId)
    await vi.advanceTimersByTimeAsync(BACKEND_RESTART_DELAYS_MS[0])
    expect(restart).not.toHaveBeenCalled()
  })

  it('does not restart a child after the Host started closing', async () => {
    vi.useFakeTimers()
    const { host, restart, fail } = await bindFailingView()

    fail()
    await host.close()
    await vi.advanceTimersByTimeAsync(BACKEND_RESTART_DELAYS_MS[0])
    expect(restart).not.toHaveBeenCalled()
  })

  it('leaves a failed restart to the next failure report', async () => {
    vi.useFakeTimers()
    const { restart, fail } = await bindFailingView()
    restart.mockRejectedValueOnce(new BackendPluginError('BACKEND_UNAVAILABLE'))

    fail()
    await vi.advanceTimersByTimeAsync(BACKEND_RESTART_DELAYS_MS[0])
    expect(restart).toHaveBeenCalledTimes(1)
    fail()
    await vi.advanceTimersByTimeAsync(BACKEND_RESTART_DELAYS_MS[1])
    expect(restart).toHaveBeenCalledTimes(2)
  })

  async function bindFailingViews(
    instanceIds: string[],
    options: Pick<PluginBackendHostOptions, 'onBackendFailure' | 'onBackendRestarted' | 'onBackendUnbound'> = {},
  ): Promise<{
    host: PluginBackendHost
    views: Map<string, { restart: ReturnType<typeof vi.fn>; fail: (error?: BackendPluginError) => void }>
  }> {
    const views = new Map<
      string,
      { restart: ReturnType<typeof vi.fn>; fail: (error?: BackendPluginError) => void }
    >()
    let binding = ''
    const host = new PluginBackendHost({
      ...options,
      createSupervisor: (_activation, supervisorOptions) => {
        const restart = vi.fn(async () => ({ serverInfo: { name: 'controlled', version: '1.0.0' } }))
        views.set(binding, {
          restart,
          fail: (error = new BackendPluginError('BACKEND_UNAVAILABLE')) => supervisorOptions.onFailure?.(error),
        })
        return {
          start: vi.fn(async () => ({ serverInfo: { name: 'controlled', version: '1.0.0' } })),
          restart,
          clientFor: vi.fn(() => ({ call: vi.fn(async () => null as never), subscribe: vi.fn() })),
          close: vi.fn(async () => undefined),
        } as unknown as PluginBackendSupervisor
      },
      resolvePlanRoot: async ({ workspacePath }) => workspacePath,
    })
    hosts.push(host)
    host.register(activation)
    for (const instanceId of instanceIds) {
      binding = instanceId
      await host.bindView(
        { ...runtime, instanceId, hostWindowId: `window-${instanceId}` },
        activation.packageDir,
        process.cwd(),
      )
    }
    return { host, views }
  }

  it('keeps a separate restart budget for each view', async () => {
    vi.useFakeTimers()
    const { views } = await bindFailingViews(['view-1', 'view-2'])
    const first = views.get('view-1')!
    const second = views.get('view-2')!

    for (const delay of BACKEND_RESTART_DELAYS_MS) {
      first.fail()
      await vi.advanceTimersByTimeAsync(delay)
    }
    first.fail()
    await vi.advanceTimersByTimeAsync(BACKEND_CRASH_WINDOW_MS / 2)
    expect(first.restart).toHaveBeenCalledTimes(BACKEND_RESTART_DELAYS_MS.length)

    second.fail()
    await vi.advanceTimersByTimeAsync(BACKEND_RESTART_DELAYS_MS[0])
    expect(second.restart).toHaveBeenCalledTimes(1)
  })

  it('reports a child that came back after an automatic restart', async () => {
    vi.useFakeTimers()
    const onBackendRestarted = vi.fn()
    const { views } = await bindFailingViews(['view-1'], { onBackendRestarted })

    views.get('view-1')!.fail()
    await vi.advanceTimersByTimeAsync(BACKEND_RESTART_DELAYS_MS[0])

    expect(onBackendRestarted).toHaveBeenCalledTimes(1)
    expect(onBackendRestarted).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: runtime.pluginId,
      packageVersion: runtime.packageVersion,
      instanceId: 'view-1',
    }))
  })

  it('reports a view once when it is unbound', async () => {
    const onBackendUnbound = vi.fn()
    const { host } = await bindFailingViews(['view-1', 'view-2'], { onBackendUnbound })

    await host.unbindView('view-1')
    await host.unbindView('view-1')

    expect(onBackendUnbound).toHaveBeenCalledTimes(1)
    expect(onBackendUnbound).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: runtime.pluginId,
      packageVersion: runtime.packageVersion,
      instanceId: 'view-1',
    }))
  })

  it('does not report a restart that failed', async () => {
    vi.useFakeTimers()
    const onBackendRestarted = vi.fn()
    const { views } = await bindFailingViews(['view-1'], { onBackendRestarted })
    const view = views.get('view-1')!
    view.restart.mockRejectedValueOnce(new BackendPluginError('BACKEND_UNAVAILABLE'))

    view.fail()
    await vi.advanceTimersByTimeAsync(BACKEND_RESTART_DELAYS_MS[0])

    expect(view.restart).toHaveBeenCalledTimes(1)
    expect(onBackendRestarted).not.toHaveBeenCalled()
  })

  it('does not report a restart that finished after the view was unbound or the Host closed', async () => {
    vi.useFakeTimers()
    const onBackendRestarted = vi.fn()
    const { host, views } = await bindFailingViews(['view-1', 'view-2'], { onBackendRestarted })
    const finish: Array<() => void> = []
    for (const view of views.values()) {
      view.restart.mockImplementationOnce(() => new Promise((resolve) => {
        finish.push(() => resolve({ serverInfo: { name: 'controlled', version: '1.0.0' } }))
      }))
      view.fail()
    }
    await vi.advanceTimersByTimeAsync(BACKEND_RESTART_DELAYS_MS[0])
    expect(finish).toHaveLength(2)

    await host.unbindView('view-1')
    finish[0]()
    await vi.advanceTimersByTimeAsync(0)
    const closing = host.close()
    finish[1]()
    await closing
    await vi.advanceTimersByTimeAsync(0)

    expect(onBackendRestarted).not.toHaveBeenCalled()
  })

  it('forgets a view\'s failures once the view is unbound', async () => {
    vi.useFakeTimers()
    const { host, views } = await bindFailingViews(['view-1'])
    const failures = (host as unknown as { firstPartyFailures: Map<string, number[]> }).firstPartyFailures

    views.get('view-1')!.fail()
    expect(failures.has('view-1')).toBe(true)
    await host.unbindView('view-1')
    expect(failures.size).toBe(0)
  })

  it('reports a spent restart budget to the failure observer', async () => {
    vi.useFakeTimers()
    const onBackendFailure = vi.fn()
    const { views } = await bindFailingViews(['view-1'], { onBackendFailure })
    const view = views.get('view-1')!
    const cause = new Error('child exited with code 1')
    const failure = new BackendPluginError('BACKEND_UNAVAILABLE', undefined, { cause })

    for (const delay of BACKEND_RESTART_DELAYS_MS) {
      view.fail(failure)
      await vi.advanceTimersByTimeAsync(delay)
    }
    for (const [, error] of onBackendFailure.mock.calls) expect(error).toBe(failure)
    view.fail(failure)

    expect(onBackendFailure).toHaveBeenCalledTimes(BACKEND_RESTART_DELAYS_MS.length + 1)
    const [reportedRuntime, reported] = onBackendFailure.mock.calls.at(-1)!
    expect(reportedRuntime).toMatchObject({ instanceId: 'view-1' })
    expect(reported).toBeInstanceOf(BackendPluginError)
    expect(reported).toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
      message: BACKEND_RESTART_BUDGET_SPENT_MESSAGE,
      cause,
    })
  })
})

describe('packaged Plans backend', () => {
  const run = packagedFixtureEnabled ? it : it.skip
  const hosts: PluginBackendHost[] = []

  afterEach(async () => {
    delete (globalThis as unknown as { nav?: unknown }).nav
    await Promise.all(hosts.splice(0).map((host) => host.close()))
  })

  for (const [label, entryFile] of [
    ['Python', packagedFixture],
    ['Go', packagedGoFixture],
  ] as const) {
    run(`${label} completes resolve_root and emits plans.changed from the same child`, async () => {
      const host = makeHost(entryFile)
      hosts.push(host)
      host.register({
        ...activation,
        entryFile,
        approvedMethods: ['plans.resolve_root'],
        approvedEvents: ['plans.changed'],
      })
      host.bindView(runtime, activation.packageDir, process.cwd())

      let resolveEvent!: (payload: unknown) => void
      const eventReceived = new Promise<unknown>((resolve) => {
        resolveEvent = resolve
      })
      const subscription = await host.subscribe('view-1', 'plans.changed', resolveEvent)
      await subscription.acknowledged

      await expect(host.call('view-1', 'plans.resolve_root', {
        workspace_path: process.cwd(),
      })).resolves.toEqual({ ok: true, root: process.cwd() })
      await expect(eventReceived).resolves.toEqual({ workspace_path: process.cwd() })
    })

    run(`${label} settles cancellation, timeout, and child crash without hanging the Host`, async () => {
      const host = makeHost(entryFile)
      hosts.push(host)
      host.register({
        ...activation,
        entryFile,
        approvedMethods: ['fixture.delay', 'fixture.exit'],
        approvedEvents: [],
      })
      host.bindView(runtime, activation.packageDir, process.cwd())

      const controller = new AbortController()
      const cancelled = host.call(
        'view-1',
        'fixture.delay',
        { milliseconds: 10_000 },
        { signal: controller.signal },
      )
      controller.abort()
      await expect(cancelled).rejects.toMatchObject({ code: 'USER_CANCELLED' })

      await expect(host.call('view-1', 'fixture.delay', { milliseconds: 10_000 }, { timeoutMs: 20 }))
        .rejects.toMatchObject({ code: 'TIMEOUT' })
      await expect(host.call('view-1', 'fixture.exit', null))
        .rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    })
  }
})
