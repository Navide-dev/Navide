import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginBackendHost } from './pluginBackendHost'
import type {
  BackendPluginLaunchSpec,
  PluginBackendSupervisor,
  PluginBackendSupervisorOptions,
} from './pluginBackendSupervisor'

// Bundled plugin backends are PyInstaller onefile binaries like the core
// backend, so they too unpack under the data dir instead of the OS temp
// directory, one directory per plugin (VM retest 2026-11-08: navide.plans kept
// one _MEI* per instance in /tmp).

const activation: BackendPluginLaunchSpec = {
  pluginId: 'navide.plans',
  packageVersion: '1.1.3',
  packageDir: process.cwd(),
  entryFile: join(process.cwd(), 'navide-plans'),
  protocolVersion: 1,
  activation: 'startup',
  approvedMethods: ['fixture.echo'],
  approvedEvents: [],
  approvedBridgePorts: [],
}

function runtimeFor(instanceId: string) {
  return {
    pluginId: activation.pluginId,
    packageVersion: activation.packageVersion,
    workspaceId: 'workspace-1',
    instanceId,
    contributionKey: 'navide.plans.window',
    hostWindowId: `window-${instanceId}`,
    initiator: { kind: 'user', id: 'user-1' },
  } as const
}

const made: string[] = []
const hosts: PluginBackendHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()))
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(resolver?: (pluginId: string) => string | null) {
  const environments: Array<Readonly<Record<string, string>>> = []
  const createSupervisor = vi.fn((_activation: BackendPluginLaunchSpec, options: PluginBackendSupervisorOptions) => {
    environments.push(options.environment)
    return {
      start: vi.fn(async () => ({ value: null, serverInfo: { name: 'controlled', version: '1.0.0' } })),
      clientFor: vi.fn(() => ({ call: vi.fn(async () => null as never), subscribe: vi.fn() })),
      close: vi.fn(async () => undefined),
    } as unknown as PluginBackendSupervisor
  })
  const host = new PluginBackendHost({ environment: { TMPDIR: '/os/tmp/' }, createSupervisor })
  if (resolver) host.setPluginTmpDir(resolver)
  hosts.push(host)
  host.register(activation)
  return { host, environments }
}

function scratchTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'navide-plugin-tmpdir-'))
  made.push(root)
  return join(root, 'backend-tmp', 'plugins')
}

describe('PluginBackendHost plugin temp directory', () => {
  it('points every temp variable of the child at the plugin directory', async () => {
    const root = scratchTmpRoot()
    const { host, environments } = setup((pluginId) => join(root, pluginId))
    await host.bindView(runtimeFor('view-1'), activation.packageDir, process.cwd())

    const dir = join(root, 'navide.plans')
    expect(environments[0]).toEqual({ TMPDIR: dir, TMP: dir, TEMP: dir })
    expect(existsSync(dir)).toBe(true)
  })

  it('leaves the Host environment alone without a resolver', async () => {
    const { host, environments } = setup()
    await host.bindView(runtimeFor('view-1'), activation.packageDir, process.cwd())

    expect(environments[0]).toEqual({ TMPDIR: '/os/tmp/' })
  })

  it('sweeps leftover extractions only while no other instance of the plugin can run', async () => {
    const root = scratchTmpRoot()
    const dir = join(root, 'navide.plans')
    const { host } = setup((pluginId) => join(root, pluginId))

    mkdirSync(join(dir, '_MEI0000dead'), { recursive: true })
    await host.bindView(runtimeFor('view-1'), activation.packageDir, process.cwd())
    expect(existsSync(join(dir, '_MEI0000dead'))).toBe(false)

    // view-1's child is running and reading its own extraction.
    mkdirSync(join(dir, '_MEI0000live'))
    await host.bindView(runtimeFor('view-2'), activation.packageDir, process.cwd())
    expect(existsSync(join(dir, '_MEI0000live'))).toBe(true)

    await host.unbindView('view-1')
    await host.unbindView('view-2')
    await host.bindView(runtimeFor('view-3'), activation.packageDir, process.cwd())
    expect(existsSync(join(dir, '_MEI0000live'))).toBe(false)
  })
})
