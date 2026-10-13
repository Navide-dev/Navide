import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginBackendHost } from './pluginBackendHost'
import { resolveBackendSandbox, sandboxedSpawnProcess, createHostSandboxProbe, SANDBOX_EXEC_PATH } from './pluginBackendSandbox'
import {
  createHostWatchdogDeps,
  DEFAULT_BACKEND_RESOURCE_LIMITS,
  sandboxIdentity,
  watchBackendResources,
} from './pluginBackendResourceWatchdog'
import { NativeBackendStore } from './pluginNativeBackendStore'
import { ThirdPartyBackendController, thirdPartyBackendLaunchSpec } from './pluginThirdPartyBackends'

/**
 * A backend that double-forks and setsid()s so its grandchild is reparented
 * to launchd must still be counted by the watchdog and killed by every stop
 * path. macOS only: on Linux the bubblewrap pid namespace dies with the child.
 */
const FIXTURE = fileURLToPath(new URL('./test-fixtures/double-fork-backend.c', import.meta.url))
const canRun = process.platform === 'darwin' &&
  existsSync(SANDBOX_EXEC_PATH) &&
  spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0

const MiB = 1024 * 1024
const roots: string[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function parentOf(pid: number): number | null {
  const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' })
  const value = Number(result.stdout.trim())
  return result.status === 0 && Number.isInteger(value) ? value : null
}

async function waitFor<T>(read: () => T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function makePackage() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'backend-escape-')))
  roots.push(root)
  const packageDir = join(root, 'package')
  mkdirSync(join(packageDir, 'backend'), { recursive: true })
  const entryFile = join(packageDir, 'backend', 'acme-df')
  const compiled = spawnSync('cc', ['-O0', '-o', entryFile, FIXTURE], { encoding: 'utf8' })
  if (compiled.status !== 0) throw new Error(compiled.stderr)
  writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.df', name: 'Double Fork', version: '1.0.0', publisher: 'acme',
    permissions: {}, marketplace: { description: 'Escape fixture.', license: 'MIT' },
    backend: { entry: 'backend/acme-df', protocolVersion: 1, activation: 'startup', methods: ['df.ping'] },
  }))
  return { root, packageDir, entryFile }
}

async function readEscapee(dataDir: string): Promise<number> {
  const pid = await waitFor(() => {
    try {
      return Number(readFileSync(join(dataDir, 'grandchild.pid'), 'utf8').trim()) || null
    } catch {
      return null
    }
  })
  // The intermediate process has exited, so the grandchild now belongs to launchd.
  await waitFor(() => parentOf(pid) === 1)
  return pid
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const pidFile = join(root, 'data', 'acme.df', 'grandchild.pid')
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    } catch {
      // Already dead, which is what the tests require.
    }
    rmSync(root, { recursive: true, force: true })
  }
})

describe.runIf(canRun)('escaped grandchild: resource watchdog (macOS, live)', () => {
  async function launch(mode: string) {
    const { root, packageDir, entryFile } = makePackage()
    const dataDir = join(root, 'data', 'acme.df')
    mkdirSync(join(dataDir, 'tmp'), { recursive: true })
    const paths = { packageDir, dataDir: realpathSync(dataDir), entryFile }
    const resolved = resolveBackendSandbox(paths, createHostSandboxProbe('darwin'))
    if (!resolved.available) throw new Error(resolved.reason)
    const child = sandboxedSpawnProcess(resolved, paths)(entryFile, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', GRANDCHILD_MODE: mode },
    })
    const grandchild = await readEscapee(paths.dataDir)
    return { child, grandchild, identity: sandboxIdentity(packageDir, paths.dataDir), dataDir: paths.dataDir }
  }

  it('counts the escapee\'s memory and kills it', async () => {
    const { child, grandchild, identity, dataDir } = await launch('memory')
    try {
      const limits = { ...DEFAULT_BACKEND_RESOURCE_LIMITS, maxRssBytes: 48 * MiB, rssStrikes: 1, dataSampleEvery: 1000 }
      // Without the sandbox identity the root alone is idle: nothing to report.
      const blind = watchBackendResources(child.pid!, dataDir, () => undefined, limits, createHostWatchdogDeps())
      expect(await blind.sample()).toBeNull()
      blind.dispose()

      const watch = watchBackendResources(child.pid!, dataDir, () => undefined, limits, createHostWatchdogDeps(), identity)
      expect(await watch.sample()).toBe('memory')
      await waitFor(() => !alive(grandchild))
    } finally {
      child.kill('SIGKILL')
    }
  }, 30_000)

  it('counts the escapee\'s CPU and kills it', async () => {
    const { child, grandchild, identity, dataDir } = await launch('cpu')
    try {
      const limits = {
        // The spinner only gets its fair share of a loaded machine: 0.12 of a
        // core with 80 busy processes on 10 cores, which a 0.2 limit missed in
        // every window. 0.02 holds until ~500 runnable processes on 10 cores.
        // Two-second windows keep one 10ms `ps` tick on the idle root (0.005)
        // well under it, and the blind watch below proves the root alone never
        // reaches it - only the escapee's CPU does.
        ...DEFAULT_BACKEND_RESOURCE_LIMITS, maxCpuCores: 0.02, cpuKillAfterMs: 0, dataSampleEvery: 1000,
        // Only this test samples: the watch's own timer must not take the
        // violation (and dispose the watch) between two of the test's samples.
        sampleIntervalMs: 60 * 60_000,
      }
      const blind = watchBackendResources(child.pid!, dataDir, () => undefined, limits, createHostWatchdogDeps())
      const watch = watchBackendResources(child.pid!, dataDir, () => undefined, limits, createHostWatchdogDeps(), identity)
      expect(await blind.sample()).toBeNull()
      expect(await watch.sample()).toBeNull()
      let violation: string | null = null
      for (let window = 0; window < 5 && violation === null; window += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        // Without the sandbox identity the same window is idle: nothing to report.
        expect(await blind.sample()).toBeNull()
        violation = await watch.sample()
      }
      blind.dispose()
      expect(violation).toBe('cpu')
      await waitFor(() => !alive(grandchild))
    } finally {
      child.kill('SIGKILL')
    }
  }, 30_000)
})

describe.runIf(canRun)('escaped grandchild: every stop path (macOS, live)', () => {
  async function bound(thirdPartyIdleMs?: number) {
    const { root, packageDir, entryFile } = makePackage()
    const store = new NativeBackendStore(join(root, 'store'))
    store.setEnabled(true)
    let host!: PluginBackendHost
    const controller = new ThirdPartyBackendController({
      store,
      dataRoot: join(root, 'data'),
      promptConsent: async () => true,
      stopBackends: (pluginId) => host.stopThirdPartyBackends(pluginId),
    })
    host = new PluginBackendHost({
      admitThirdParty: (activation, workspacePath) => controller.admit(activation as never, workspacePath),
      ...(thirdPartyIdleMs ? { thirdPartyIdleMs } : {}),
    })
    const spec = thirdPartyBackendLaunchSpec({
      pluginId: 'acme.df', packageVersion: '1.0.0', packageDir, views: [],
      backend: { entryFile, protocolVersion: 1, activation: 'startup' },
    })!
    host.register(spec)
    await host.bindView({
      pluginId: 'acme.df', packageVersion: '1.0.0', workspaceId: 'ws', instanceId: 'view-1',
      contributionKey: 'acme.df.view', hostWindowId: 'w', initiator: { kind: 'user', id: 'u' },
    }, packageDir, root)
    await expect(host.call('view-1', 'df.ping', null)).resolves.toEqual({ pong: true })
    const grandchild = await readEscapee(realpathSync(controller.dataDirFor('acme.df')))
    return { host, controller, grandchild }
  }

  it('the global kill switch kills the escapee', async () => {
    const { host, controller, grandchild } = await bound()
    try {
      expect(alive(grandchild)).toBe(true)
      await controller.setEnabled(false)
      await waitFor(() => !alive(grandchild))
    } finally {
      await host.close()
    }
  }, 30_000)

  it('the per-plugin disable switch kills the escapee', async () => {
    const { host, controller, grandchild } = await bound()
    try {
      await controller.setDisabled('acme.df', true)
      await waitFor(() => !alive(grandchild))
    } finally {
      await host.close()
    }
  }, 30_000)

  it('the idle stop kills the escapee', async () => {
    const { host, grandchild } = await bound(300)
    try {
      await waitFor(() => !alive(grandchild))
    } finally {
      await host.close()
    }
  }, 30_000)

  it('Host shutdown (app quit) kills the escapee', async () => {
    const { host, grandchild } = await bound()
    expect(alive(grandchild)).toBe(true)
    await host.close()
    // SIGKILL is sent before close() settles; launchd reaps it right after.
    await waitFor(() => !alive(grandchild), 2_000)
  }, 30_000)
})
