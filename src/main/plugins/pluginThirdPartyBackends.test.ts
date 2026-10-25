import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendPluginError } from './pluginBackendSupervisor'
import { PlansBridgeError, type PlansBridgeContext, type PlansFilesystemPort } from './plansBridge'
import { SANDBOX_EXEC_PATH, type BackendSandboxProbe } from './pluginBackendSandbox'
import { NativeBackendStore } from './pluginNativeBackendStore'
import { OwnerOnlyJsonPersistence } from './ownerOnlyJsonPersistence'
import { isWindows } from '../../shared/osplat'
import {
  stdoutPendingOf,
  BACKEND_RESTART_DELAYS_MS,
  backendPermissionsKey,
  agentToolsDigest,
  consentedAgentMethods,
  readInstalledManifestV2,
  nativeBackendConsentText,
  ThirdPartyBackendController,
  thirdPartyBackendLaunchSpec,
  type NativeBackendConsentPrompt,
  type ThirdPartyLaunchSpec,
} from './pluginThirdPartyBackends'
import type { PluginActivationCatalogEntry } from './installedPlugins'
import {
  DEFAULT_BACKEND_RESOURCE_LIMITS,
  defaultStdoutPendingThreshold,
  watchBackendResources,
  type BackendResourceWatch,
  type ResourceNotifyMode,
  type ResourceViolation,
} from './pluginBackendResourceWatchdog'

const DARWIN: BackendSandboxProbe = { platform: 'darwin', sandboxExec: () => SANDBOX_EXEC_PATH, bubblewrap: () => null }

function manifest(overrides: { system?: string[]; shell?: string; methods?: string[] } = {}) {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.indexer',
    name: 'Indexer',
    version: '1.0.0',
    publisher: 'acme',
    permissions: {
      ...(overrides.system ? { system: overrides.system } : {}),
      ...(overrides.shell ? { shell: overrides.shell } : {}),
    },
    marketplace: { description: 'Index files.', license: 'MIT' },
    contributes: {
      views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Indexer', entry: 'frontend/left/index.html' }],
    },
    backend: {
      entry: 'backend/acme-indexer',
      protocolVersion: 1,
      activation: 'startup',
      methods: overrides.methods ?? ['files.search'],
      events: ['files.indexProgress'],
    },
  }
}

let root = ''
let packageDir = ''
let store: NativeBackendStore

function writePackage(options: Parameters<typeof manifest>[0] = {}, binary = 'binary-v1'): ThirdPartyLaunchSpec {
  mkdirSync(join(packageDir, 'backend'), { recursive: true })
  writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify(manifest(options)))
  writeFileSync(join(packageDir, 'backend', 'acme-indexer'), binary, { mode: 0o700 })
  const activation: PluginActivationCatalogEntry = {
    pluginId: 'acme.indexer',
    packageVersion: '1.0.0',
    packageDir,
    views: [],
    backend: { entryFile: join(packageDir, 'backend', 'acme-indexer'), protocolVersion: 1, activation: 'startup' },
  }
  const spec = thirdPartyBackendLaunchSpec(activation)
  if (!spec) throw new Error('no spec')
  return spec
}

function controller(options: Partial<ConstructorParameters<typeof ThirdPartyBackendController>[0]> = {}) {
  const spawnImpl = vi.fn(() => ({ pid: undefined, once: vi.fn() }))
  const instance = new ThirdPartyBackendController({
    store,
    dataRoot: join(root, 'data'),
    probe: DARWIN,
    spawnImpl: spawnImpl as never,
    watchResources: () => ({ dispose: vi.fn(), sample: async () => null, terminate: async (item: ResourceViolation) => item, keepRunning: () => 0 }),
    killSandbox: vi.fn(),
    sweepEscapees: vi.fn(async () => []),
    ...options,
  })
  return { instance, spawnImpl }
}

const allow = vi.fn(async (_prompt: NativeBackendConsentPrompt) => true)
const deny = vi.fn(async (_prompt: NativeBackendConsentPrompt) => false)

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'third-party-backend-')))
  packageDir = join(root, 'plugins', 'acme.indexer', '1.0.0')
  store = new NativeBackendStore(join(root, 'store'))
  allow.mockClear()
  deny.mockClear()
  store.setEnabled(true)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function refusal(promise: Promise<unknown>): Promise<BackendPluginError> {
  const error = await promise.then(() => null, (value: unknown) => value)
  expect(error).toBeInstanceOf(BackendPluginError)
  expect((error as BackendPluginError).code).toBe('BACKEND_UNAVAILABLE')
  return error as BackendPluginError
}

// These suites drive the macOS/Linux admission path with a mocked sandbox
// probe and real package directories under the host's temp directory. On a
// Windows host those paths are not POSIX paths and admission is refused
// before any of it (covered by the 'Windows (unsupported in v1)' suite).
const POSIX_SANDBOX_SKIPPED = isWindows()

describe('thirdPartyBackendLaunchSpec', () => {
  it('projects the manifest allowlists, the fs bridge port and no agent methods', () => {
    const spec = writePackage({ system: ['fs'] })
    expect(spec).toMatchObject({
      approvedMethods: ['files.search'],
      agentMethods: [],
      approvedEvents: ['files.indexProgress'],
      approvedBridgePorts: ['filesystem'],
      thirdParty: { name: 'Indexer', system: ['fs'] },
    })
    expect(writePackage({}).approvedBridgePorts).toEqual([])
  })

  it('projects the Host shell broker port for shell: allowlist only (DB5)', () => {
    expect(writePackage({ system: ['fs'], shell: 'allowlist' })).toMatchObject({
      approvedBridgePorts: ['filesystem', 'shell'],
      agentMethods: [],
      thirdParty: { system: ['fs'], shell: 'allowlist' },
    })
    expect(writePackage({ shell: 'allowlist' }).approvedBridgePorts).toEqual(['shell'])
    expect(writePackage({ shell: 'full' }).approvedBridgePorts).toEqual([])
  })

  it('projects the agents ports only for the namespaces the manifest declares', () => {
    expect(writePackage({ system: ['agents'] }).approvedBridgePorts).toEqual(['agents'])
    expect(writePackage({ system: ['fs', 'agents', 'agentMessages'] }).approvedBridgePorts)
      .toEqual(['filesystem', 'agents', 'agent-message-bodies'])
  })

  it('keeps the projection and consent key of a package without shell exactly as before', () => {
    const spec = writePackage({ system: ['fs'] })
    expect(spec.approvedBridgePorts).toEqual(['filesystem'])
    expect(spec.thirdParty).not.toHaveProperty('shell')
    expect(backendPermissionsKey(spec)).toBe(
      '{"system":["fs"],"shell":null,"methods":["files.search"],"events":["files.indexProgress"]}',
    )
  })

  it('never projects a backend that declares no methods', () => {
    writePackage()
    const raw = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8'))
    delete raw.backend.methods
    writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify(raw))
    expect(thirdPartyBackendLaunchSpec({
      pluginId: 'acme.indexer', packageVersion: '1.0.0', packageDir, views: [],
      backend: { entryFile: join(packageDir, 'backend', 'acme-indexer'), protocolVersion: 1, activation: 'startup' },
    })).toBeNull()
  })
})

describe.skipIf(POSIX_SANDBOX_SKIPPED)('admission', () => {
  it('is on by default for a switch the user never set', () => {
    expect(new NativeBackendStore(join(root, 'fresh-store')).isEnabled()).toBe(true)
  })

  it('off means off: no prompt, no spawn, never re-enabled', async () => {
    store.setEnabled(false)
    const spec = writePackage()
    const { instance, spawnImpl } = controller({ promptConsent: allow })
    const error = await refusal(instance.admit(spec))
    expect(error.message).toBe('third-party native backends are turned off')
    expect(allow).not.toHaveBeenCalled()
    expect(store.isEnabled()).toBe(false)
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('never prompts without a prompt handler', async () => {
    const { instance, spawnImpl } = controller()
    await instance.admit(writePackage({}, 'binary-v1'))
    expect((await refusal(instance.admit(writePackage({}, 'binary-v2')))).message).toBe('the native backend has not been allowed')
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('treats the install as consent: a fresh package binds without a prompt, through sandbox-exec', async () => {
    const spec = writePackage({ system: ['fs'] })
    const onConsentGranted = vi.fn()
    const { instance, spawnImpl } = controller({ promptConsent: allow, onConsentGranted })
    const admission = await instance.admit(spec, root)
    expect(allow).not.toHaveBeenCalled()
    expect(onConsentGranted).toHaveBeenCalledWith('acme.indexer')
    expect(store.isEnabled()).toBe(true)
    expect(store.record('acme.indexer').consent?.permissionsKey).toBe(backendPermissionsKey(spec))
    expect(admission.workspaceRoot).toBe(root)
    await admission.beforeSpawn()
    admission.spawnProcess(spec.entryFile, { env: { PATH: '/usr/bin' } })
    expect(spawnImpl).toHaveBeenCalledWith(
      SANDBOX_EXEC_PATH,
      ['-p', expect.stringContaining('(deny default)'), realpathSync(spec.entryFile)],
      expect.objectContaining({ shell: false, env: expect.objectContaining({ HOME: realpathSync(instance.dataDirFor('acme.indexer')) }) }),
    )
    expect(statSync(instance.dataDirFor('acme.indexer')).mode & 0o777).toBe(0o700)

    await instance.admit(spec)
    expect(allow).not.toHaveBeenCalled()
  })

  it('does not ask again in the same session after "Not now" on a changed backend', async () => {
    const { instance } = controller({ promptConsent: deny })
    await instance.admit(writePackage({}, 'binary-v1'))
    const first = store.record('acme.indexer').consent
    const changed = writePackage({}, 'binary-v2')
    await refusal(instance.admit(changed))
    await refusal(instance.admit(changed))
    expect(deny).toHaveBeenCalledTimes(1)
    expect(store.record('acme.indexer').consent).toEqual(first)
    instance.resetFailures('acme.indexer')
    await refusal(instance.admit(changed))
    expect(deny).toHaveBeenCalledTimes(2)
  })

  it('asks before the bind when an update changes the backend binary, and marks it as an update', async () => {
    const { instance } = controller({ promptConsent: allow })
    await instance.admit(writePackage({}, 'binary-v1'))
    expect(allow).not.toHaveBeenCalled()
    const changed = writePackage({}, 'binary-v2')
    expect((await instance.status(changed)).status).toBe('needs-consent')
    expect((await instance.status(changed)).changedSinceConsent).toBe(true)
    await instance.admit(changed)
    expect(allow).toHaveBeenCalledTimes(1)
    expect(allow.mock.calls[0][0]).toMatchObject({ update: true })
  })

  it('binds consent to the whole package: any changed file asks again', async () => {
    const { instance } = controller({ promptConsent: allow })
    const spec = writePackage()
    mkdirSync(join(packageDir, 'frontend'), { recursive: true })
    writeFileSync(join(packageDir, 'frontend', 'index.html'), '<p>v1</p>')
    // An innocuous-looking asset a loader could decode into a library.
    writeFileSync(join(packageDir, 'frontend', 'asset.bin'), Buffer.from('payload-v1'), { mode: 0o644 })
    await instance.admit(spec)
    expect(allow).not.toHaveBeenCalled()
    await instance.admit(spec)
    expect(allow).not.toHaveBeenCalled()

    writeFileSync(join(packageDir, 'frontend', 'asset.bin'), Buffer.from('payload-v2'))
    await instance.admit(spec)
    expect(allow).toHaveBeenCalledTimes(1)

    writeFileSync(join(packageDir, 'frontend', 'index.html'), '<p>v2</p>')
    await instance.admit(spec)
    expect(allow).toHaveBeenCalledTimes(2)

    writeFileSync(join(packageDir, 'frontend', 'script.py'), 'print(1)')
    await instance.admit(spec)
    expect(allow).toHaveBeenCalledTimes(3)

    mkdirSync(join(packageDir, 'frontend', 'payload_4a5f'))
    await instance.admit(spec)
    expect(allow).toHaveBeenCalledTimes(4)

    // Files the Host writes into the package directory do not count.
    writeFileSync(join(packageDir, '.navide-registry-receipt.json'), '{}')
    writeFileSync(join(packageDir, '.navide-receipt.json'), '{}')
    await instance.admit(spec)
    expect(allow).toHaveBeenCalledTimes(4)
  })

  it('re-checks the switches after hashing: a stop during the digest refuses the spawn', async () => {
    for (const flip of [
      (instance: ThirdPartyBackendController) => instance.setDisabled('acme.indexer', true),
      (instance: ThirdPartyBackendController) => instance.setEnabled(false),
    ]) {
      store.setEnabled(true)
      store.setDisabled('acme.indexer', false)
      let flipDuringDigest = false
      let instance!: ThirdPartyBackendController
      const spawnImpl = vi.fn(() => ({ pid: undefined, once: vi.fn() }))
      ;({ instance } = controller({
        spawnImpl: spawnImpl as never,
        digestBackend: async () => {
          if (flipDuringDigest) await flip(instance)
          return 'digest-1'
        },
      }))
      const spec = writePackage()
      // Consent for exactly the digest this test hashes to.
      store.grantConsent('acme.indexer', { binarySha256: 'digest-1', permissionsKey: backendPermissionsKey(spec), packageVersion: '1.0.0' })
      const admission = await instance.preflightAdmission(spec)
      expect(admission).not.toBeNull()
      flipDuringDigest = true
      await refusal(admission!.beforeSpawn())
      expect(await instance.preflightAdmission(spec)).toBeNull()
      expect(spawnImpl).not.toHaveBeenCalled()
    }
  })

  it('sweeps escapees asynchronously before each spawn and the whole sandbox after the child exits', async () => {
    const listeners = new Map<string, () => void>()
    const killSandbox = vi.fn()
    const sweepEscapees = vi.fn(async () => [])
    const { instance } = controller({
      promptConsent: allow,
      killSandbox,
      sweepEscapees,
      spawnImpl: (() => ({ pid: 42, once: (event: string, listener: () => void) => listeners.set(event, listener) })) as never,
    })
    const spec = writePackage()
    const admission = await instance.admit(spec)
    await admission.beforeSpawn()
    expect(sweepEscapees).toHaveBeenCalledWith(expect.objectContaining({
      packageDir: realpathSync(packageDir), names: new Set(['acme-indexer']),
    }))
    admission.spawnProcess(spec.entryFile, {})
    expect(killSandbox).not.toHaveBeenCalled()
    listeners.get('exit')!()
    expect(killSandbox).toHaveBeenCalledWith(42, expect.objectContaining({ packageDir: realpathSync(packageDir) }))
  })

  it('asks again when the declared permissions or methods change', async () => {
    const { instance } = controller({ promptConsent: allow })
    await instance.admit(writePackage({ methods: ['files.search'] }))
    await instance.admit(writePackage({ methods: ['files.search', 'files.delete'] }))
    await instance.admit(writePackage({ methods: ['files.search', 'files.delete'], system: ['fs'] }))
    expect(allow).toHaveBeenCalledTimes(2)
    expect(allow.mock.calls.every(([prompt]) => prompt.update === true)).toBe(true)
  })

  it('refuses a changed binary at respawn time even after admission', async () => {
    const { instance } = controller({ promptConsent: allow })
    const admission = await instance.admit(writePackage({}, 'binary-v1'))
    writeFileSync(join(packageDir, 'backend', 'acme-indexer'), 'tampered')
    await refusal(admission.beforeSpawn())
  })

  it('refuses without prompting when the sandbox is unavailable', async () => {
    const spec = writePackage()
    const { instance } = controller({
      promptConsent: allow,
      probe: { platform: 'linux', sandboxExec: () => null, bubblewrap: () => null },
    })
    const error = await refusal(instance.admit(spec))
    expect(error.message).toContain('bubblewrap')
    expect(allow).not.toHaveBeenCalled()
    expect((await instance.status(spec)).status).toBe('sandbox-unavailable')
    store.setEnabled(false)
    expect((await instance.status(spec)).status).toBe('disabled-globally')
  })

  it('refuses a backend that declares full shell access', async () => {
    const spec = writePackage({ shell: 'full' })
    const { instance } = controller({ promptConsent: allow })
    expect((await refusal(instance.admit(spec))).message).toContain('full shell')
    expect(allow).not.toHaveBeenCalled()
    expect((await instance.status(spec)).status).toBe('shell-not-allowed')
  })

  it('admits a freshly installed backend with shell: allowlist without a prompt (the install disclosed it)', async () => {
    const spec = writePackage({ system: ['fs'], shell: 'allowlist' })
    const { instance, spawnImpl } = controller({ promptConsent: allow })
    const admission = await instance.admit(spec, root)
    expect(allow).not.toHaveBeenCalled()
    expect(store.record('acme.indexer').consent?.permissionsKey).toBe(backendPermissionsKey(spec))
    expect(admission.workspaceRoot).toBe(root)
    admission.spawnProcess(spec.entryFile, {})
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(await instance.status(spec)).toMatchObject({ status: 'ready', shell: 'allowlist' })
    expect(await instance.status(writePackage({ system: ['fs'] }))).not.toHaveProperty('shell')
  })

  it('asks again when an update adds shell, and the prompt marks it as an update', async () => {
    const { instance } = controller({ promptConsent: allow })
    await instance.admit(writePackage({ system: ['fs'] }))
    expect(allow).not.toHaveBeenCalled()
    const withShell = writePackage({ system: ['fs'], shell: 'allowlist' })
    expect((await instance.status(withShell))).toMatchObject({ status: 'needs-consent', changedSinceConsent: true })
    await refusal(instance.admit(withShell, undefined, { prompt: false }))
    await instance.admit(withShell)
    expect(allow).toHaveBeenCalledTimes(1)
    expect(allow).toHaveBeenLastCalledWith(expect.objectContaining({ shell: 'allowlist', update: true }))
    await refusal(instance.admit(writePackage({ system: ['fs'] }), undefined, { prompt: false }))
  })
})

describe('Windows (unsupported in v1)', () => {
  // Host-independent: a Windows spec with Windows paths, as the Host builds it there.
  const root = win32.join('C:\\', 'Users', 'me', 'AppData', 'Roaming', 'Navide')
  const windowsSpec = {
    pluginId: 'acme.indexer',
    packageVersion: '1.0.0',
    packageDir: win32.join(root, 'plugins', 'acme.indexer'),
    entryFile: win32.join(root, 'plugins', 'acme.indexer', 'backend', 'acme-indexer.exe'),
    protocolVersion: 1,
    activation: 'startup',
    approvedMethods: ['files.search'],
    agentMethods: [],
    approvedEvents: [],
    approvedBridgePorts: [],
    thirdParty: { name: 'Indexer', system: [] },
  } as ThirdPartyLaunchSpec
  const WINDOWS: BackendSandboxProbe = { platform: 'win32', sandboxExec: () => null, bubblewrap: () => null }

  it('reports "turned off" while the switch is off, and "not supported" when on - never a sandbox path error', async () => {
    const { instance, spawnImpl } = controller({ promptConsent: allow, probe: WINDOWS, digestBackend: async () => 'digest' })
    store.setEnabled(false)
    expect((await refusal(instance.admit(windowsSpec))).message).toBe('third-party native backends are turned off')
    store.setEnabled(true)
    expect((await refusal(instance.admit(windowsSpec))).message).toBe('third-party backends are not supported on Windows yet')
    expect(allow).not.toHaveBeenCalled()
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(await instance.preflightAdmission(windowsSpec)).toBeNull()
  })
})

// Host-independent: every refusal below happens before any sandbox path work.
describe('kill switches when the decision cannot be saved', () => {
  function failingSaves() {
    return vi.spyOn(OwnerOnlyJsonPersistence.prototype, 'write').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device')
    })
  }

  it('turning the global switch off still stops every child and refuses, and reports the error', async () => {
    const stopBackends = vi.fn(async () => undefined)
    const { instance } = controller({ promptConsent: allow, stopBackends, digestBackend: async () => 'digest' })
    const spec = writePackage()
    const write = failingSaves()
    try {
      await expect(instance.setEnabled(false)).rejects.toThrow('ENOSPC')
      expect(stopBackends).toHaveBeenCalledWith(null)
      expect(store.isEnabled()).toBe(false)
      expect((await refusal(instance.admit(spec))).message).toBe('third-party native backends are turned off')
      expect(await instance.preflightAdmission(spec)).toBeNull()
      expect(allow).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })

  it('disabling one plugin still stops it and refuses, and reports the error', async () => {
    const stopBackends = vi.fn(async () => undefined)
    const { instance } = controller({ promptConsent: allow, stopBackends, digestBackend: async () => 'digest' })
    const spec = writePackage()
    const write = failingSaves()
    try {
      await expect(instance.setDisabled('acme.indexer', true)).rejects.toThrow('ENOSPC')
      expect(stopBackends).toHaveBeenCalledWith('acme.indexer')
      expect(store.record('acme.indexer').disabled).toBe(true)
      expect((await refusal(instance.admit(spec))).message).toBe('the native backend is disabled for this plugin')
      expect(allow).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })

  it('turning things on still takes effect only once saved', async () => {
    store.setEnabled(false)
    const { instance } = controller({ promptConsent: allow })
    const write = failingSaves()
    try {
      await expect(instance.setEnabled(true)).rejects.toThrow('ENOSPC')
      expect(store.isEnabled()).toBe(false)
    } finally {
      write.mockRestore()
    }
  })
})

describe.skipIf(POSIX_SANDBOX_SKIPPED)('kill switches', () => {
  it('turning the global switch off stops every third-party child and blocks respawn', async () => {
    const stopBackends = vi.fn(async () => undefined)
    const { instance } = controller({ promptConsent: allow, stopBackends })
    const admission = await instance.admit(writePackage())
    await instance.setEnabled(false)
    expect(stopBackends).toHaveBeenCalledWith(null)
    await refusal(admission.beforeSpawn())
  })

  it('disabling one plugin stops it and refuses without prompting', async () => {
    const stopBackends = vi.fn(async () => undefined)
    const { instance } = controller({ promptConsent: allow, stopBackends })
    const spec = writePackage()
    const admission = await instance.admit(spec)
    await instance.setDisabled('acme.indexer', true)
    expect(stopBackends).toHaveBeenCalledWith('acme.indexer')
    await refusal(admission.beforeSpawn())
    await refusal(instance.admit(spec))
    expect(allow).not.toHaveBeenCalled()
    expect((await instance.status(spec)).status).toBe('disabled')
    await instance.setDisabled('acme.indexer', false)
    await instance.admit(spec)
  })
})

describe.skipIf(POSIX_SANDBOX_SKIPPED)('crash breaker and resource violations', () => {
  it('restarts with backoff, then stays down until the user allows it again', async () => {
    let now = 0
    const { instance } = controller({ promptConsent: allow, now: () => now })
    const spec = writePackage()
    const admission = await instance.admit(spec)
    expect(BACKEND_RESTART_DELAYS_MS.map(() => admission.noteFailure())).toEqual([...BACKEND_RESTART_DELAYS_MS])
    expect(admission.noteFailure()).toBeNull()
    expect((await instance.status(spec)).status).toBe('stopped-after-crashes')
    await refusal(admission.beforeSpawn())
    await instance.allow(spec)
    expect((await instance.status(spec)).status).toBe('ready')
    now += 1
    expect(admission.noteFailure()).toBe(BACKEND_RESTART_DELAYS_MS[0])
  })

  it('forgets failures outside the crash window', async () => {
    let now = 0
    const { instance } = controller({ promptConsent: allow, now: () => now })
    const admission = await instance.admit(writePackage())
    for (let index = 0; index < 10; index += 1) {
      expect(admission.noteFailure()).toBe(BACKEND_RESTART_DELAYS_MS[0])
      now += 11 * 60_000
    }
  })

  // Plan B watchdog option C (contract 5.2).
  describe('resource notices', () => {
    function realWatch(rss: () => number) {
      const killed: number[] = []
      const deps = {
        listProcesses: async () => [{ pid: 42, ppid: 1, rssBytes: rss(), cpuMs: 0 }],
        dataDirBytes: async () => 0,
        kill: (pid: number) => killed.push(pid),
        now: () => 0,
        setInterval: () => 'handle',
        clearInterval: vi.fn(),
      }
      let watch: BackendResourceWatch | undefined
      const watchResources = (pid: number, dir: string, onViolation: (v: ResourceViolation) => void, notify?: ResourceNotifyMode) => {
        watch = watchBackendResources(pid, dir, onViolation, { ...DEFAULT_BACKEND_RESOURCE_LIMITS, dataSampleEvery: 1 }, deps, undefined, notify)
        return watch
      }
      return { killed, watchResources, sample: () => watch!.sample() }
    }

    async function running(options: Partial<ConstructorParameters<typeof ThirdPartyBackendController>[0]>) {
      const { instance } = controller({ promptConsent: allow, spawnImpl: (() => ({ pid: 42, once: vi.fn() })) as never, ...options })
      const spec = writePackage()
      const admission = await instance.admit(spec)
      admission.spawnProcess(spec.entryFile, {})
      return { instance, spec }
    }

    it('over a threshold: tells the user and records it, but does not stop the backend', async () => {
      const w = realWatch(() => 600 * 1024 * 1024)
      const decisions: unknown[] = []
      const changed = vi.fn()
      const { instance, spec } = await running({
        watchResources: w.watchResources, recordResourceDecision: (row) => decisions.push(row), onResourceNoticesChanged: changed,
      })
      await w.sample()
      await w.sample()
      expect(w.killed).toEqual([])
      expect(instance.resourceNotices()).toEqual([expect.objectContaining({
        pluginId: 'acme.indexer', name: expect.any(String), packageVersion: '1.0.0', item: 'memory', usage: 600 * 1024 * 1024, threshold: 512 * 1024 * 1024,
      })])
      expect(changed).toHaveBeenCalled()
      expect(decisions).toEqual([expect.objectContaining({ plugin_id: 'acme.indexer', item: 'memory', decision: 'notified' })])
      expect((await instance.status(spec)).lastViolation).toBeUndefined()
    })

    it('Stop ends it exactly like the automatic stop did (whole tree killed, lastViolation)', async () => {
      const w = realWatch(() => 600 * 1024 * 1024)
      const decisions: Array<Record<string, unknown>> = []
      const { instance, spec } = await running({ watchResources: w.watchResources, recordResourceDecision: (row) => decisions.push(row as never) })
      await w.sample()
      await w.sample()
      const [notice] = instance.resourceNotices()
      expect(await instance.answerResourceNotice(notice.id, 'terminate')).toBe(true)
      expect(w.killed).toEqual([42])
      expect((await instance.status(spec)).lastViolation).toBe('memory')
      expect(instance.resourceNotices()).toEqual([])
      expect(decisions.map((row) => row.decision)).toEqual(['notified', 'terminate'])
    })

    it('Keep running records the choice, keeps the backend and tells again only at twice the level', async () => {
      let rss = 600 * 1024 * 1024
      const w = realWatch(() => rss)
      const decisions: Array<Record<string, unknown>> = []
      const { instance } = await running({ watchResources: w.watchResources, recordResourceDecision: (row) => decisions.push(row as never) })
      await w.sample()
      await w.sample()
      const [notice] = instance.resourceNotices()
      expect(await instance.answerResourceNotice(notice.id, 'continue')).toBe(true)
      expect(instance.resourceNotices()).toEqual([])
      rss = 1100 * 1024 * 1024
      await w.sample()
      await w.sample()
      expect(instance.resourceNotices()).toEqual([])
      rss = 1300 * 1024 * 1024
      await w.sample()
      await w.sample()
      expect(instance.resourceNotices()).toEqual([expect.objectContaining({ item: 'memory', threshold: 1200 * 1024 * 1024 })])
      expect(w.killed).toEqual([])
      expect(decisions.map((row) => row.decision)).toEqual(['notified', 'continue', 'notified'])
      expect(decisions[1]).toMatchObject({ item: 'memory', usage: 600 * 1024 * 1024, threshold: 512 * 1024 * 1024 })
    })

    it('a failed record never holds up the choice', async () => {
      const w = realWatch(() => 600 * 1024 * 1024)
      const { instance } = await running({ watchResources: w.watchResources, recordResourceDecision: () => { throw new Error('backend down') } })
      await w.sample()
      await w.sample()
      const [notice] = instance.resourceNotices()
      expect(await instance.answerResourceNotice(notice.id, 'terminate')).toBe(true)
      expect(w.killed).toEqual([42])
    })

    it('lists each running backend\'s usage against its thresholds, and forgets it when it exits', async () => {
      const w = realWatch(() => 600 * 1024 * 1024)
      let exit: (() => void) | undefined
      const { instance } = controller({
        promptConsent: allow,
        spawnImpl: (() => ({ pid: 42, once: (_event: string, listener: () => void) => { exit = listener } })) as never,
        watchResources: w.watchResources,
      })
      const spec = writePackage()
      const admission = await instance.admit(spec)
      admission.spawnProcess(spec.entryFile, {})
      await w.sample()
      await w.sample()
      expect(instance.resourceStatus()).toEqual([expect.objectContaining({
        pluginId: 'acme.indexer', name: expect.any(String), packageVersion: '1.0.0',
        usage: expect.objectContaining({ memory: 600 * 1024 * 1024 }), waiting: ['memory'],
      })])
      exit!()
      expect(instance.resourceStatus()).toEqual([])
    })

    it('passes this view\'s pending stdout to the watch, with the default threshold (review M2 on #375)', async () => {
      const seen: Array<ResourceNotifyMode | undefined> = []
      const stdoutPendingBytes = vi.fn(() => 42)
      const { instance } = controller({
        promptConsent: allow,
        spawnImpl: (() => ({ pid: 42, once: vi.fn() })) as never,
        stdoutPendingBytes,
        watchResources: (_pid, _dir, _onViolation, notify) => {
          seen.push(notify)
          return { dispose: vi.fn(), sample: async () => null, terminate: async (item: ResourceViolation) => item, keepRunning: () => 0 }
        },
      })
      const spec = writePackage()
      const admission = await instance.admit(spec, undefined, { instanceId: 'view-1' })
      admission.spawnProcess(spec.entryFile, {})
      expect(seen[0]?.stdoutPending?.bytes()).toBe(42)
      expect(stdoutPendingBytes).toHaveBeenCalledWith('acme.indexer', 'view-1')
      expect(seen[0]?.stdoutPending?.threshold).toBe(defaultStdoutPendingThreshold())
      // Without a view (the install-time preflight) there is nothing to read.
      const preflight = await instance.admit(spec)
      preflight.spawnProcess(spec.entryFile, {})
      expect(seen[1]?.stdoutPending).toBeUndefined()
    })

    // Review MED-1 on #386: each child's watch reads only its own view.
    it('two views: only the one whose child piles up stdout is noticed, and Stop stops only that one', async () => {
      const MiB = 1024 * 1024
      const killed: number[] = []
      const watches: BackendResourceWatch[] = []
      const pending: Record<string, number> = { 'view-1': 0, 'view-2': 300 * MiB }
      let nextPid = 100
      const { instance } = controller({
        promptConsent: allow,
        spawnImpl: (() => ({ pid: nextPid++, once: vi.fn() })) as never,
        stdoutPendingBytes: (_pluginId, instanceId) => pending[instanceId] ?? 0,
        watchResources: (pid, dir, onViolation, notify) => {
          const deps = {
            listProcesses: async () => [{ pid, ppid: 1, rssBytes: MiB, cpuMs: 0 }],
            dataDirBytes: async () => 0,
            kill: (victim: number) => killed.push(victim),
            now: () => 0,
            setInterval: () => 'handle',
            clearInterval: vi.fn(),
          }
          const watch = watchBackendResources(pid, dir, onViolation, { ...DEFAULT_BACKEND_RESOURCE_LIMITS, dataSampleEvery: 1 }, deps, undefined, notify)
          watches.push(watch)
          return watch
        },
      })
      const spec = writePackage()
      for (const instanceId of ['view-1', 'view-2']) {
        const admission = await instance.admit(spec, undefined, { instanceId })
        admission.spawnProcess(spec.entryFile, {})
      }
      for (const watch of watches) await watch.sample()
      const notices = instance.resourceNotices()
      expect(notices).toEqual([expect.objectContaining({ item: 'stdoutPending', usage: 300 * MiB })])
      expect(await instance.answerResourceNotice(notices[0].id, 'terminate')).toBe(true)
      expect(killed).toEqual([101])
    })

    // Review LOW3 on #386: a failing change hook never loses the item.
    it('a throwing change hook is logged; the answer still applies and the item is noticed again later', async () => {
      let rss = 600 * 1024 * 1024
      const w = realWatch(() => rss)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const { instance } = await running({
          watchResources: w.watchResources,
          onResourceNoticesChanged: () => { throw new Error('window gone') },
        })
        await w.sample()
        await w.sample()
        const [notice] = instance.resourceNotices()
        expect(await instance.answerResourceNotice(notice.id, 'continue')).toBe(true)
        rss = 1300 * 1024 * 1024
        await w.sample()
        await w.sample()
        expect(instance.resourceNotices()).toEqual([expect.objectContaining({ item: 'memory', threshold: 1200 * 1024 * 1024 })])
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })

    it('reads pending stdout from the backend usage, and 0 before #375 adds it', () => {
      const usage = (child: Record<string, unknown> | null) => ({
        children: { current: 1, peak: 1, retained: 0 },
        views: [
          { pluginId: 'acme.indexer', instanceId: 'v1', subscriptions: { current: 0, peak: 0 }, child },
          { pluginId: 'acme.indexer', instanceId: 'v2', subscriptions: { current: 0, peak: 0 }, child },
          { pluginId: 'acme.other', instanceId: 'v3', subscriptions: { current: 0, peak: 0 }, child },
        ],
        plugins: [],
      })
      expect(stdoutPendingOf(usage({ stdoutPending: { bytes: 5, peakBytes: 9 } }) as never, 'acme.indexer', 'v2')).toBe(5)
      expect(stdoutPendingOf(usage({ stdoutPending: { bytes: 5, peakBytes: 9 } }) as never, 'acme.indexer', 'v3')).toBe(0)
      expect(stdoutPendingOf(usage({}) as never, 'acme.indexer', 'v1')).toBe(0)
      expect(stdoutPendingOf(usage(null) as never, 'acme.indexer', 'v1')).toBe(0)
      expect(stdoutPendingOf(usage({ stdoutPending: { bytes: 'x' } }) as never, 'acme.indexer', 'v1')).toBe(0)
    })

    it('an unknown or answered notice is refused', async () => {
      const { instance } = await running({})
      expect(await instance.answerResourceNotice('nope', 'terminate')).toBe(false)
    })
  })

  it('reports the resource limit that stopped the child', async () => {
    let report: ((violation: 'memory') => void) | undefined
    const { instance } = controller({
      promptConsent: allow,
      spawnImpl: (() => ({ pid: 42, once: vi.fn() })) as never,
      watchResources: (_pid, _dir, onViolation) => {
        report = onViolation as never
        return { dispose: vi.fn(), sample: async () => null, terminate: async (item: ResourceViolation) => item, keepRunning: () => 0 }
      },
    })
    const spec = writePackage()
    const admission = await instance.admit(spec)
    admission.spawnProcess(spec.entryFile, {})
    report!('memory')
    expect((await instance.status(spec)).lastViolation).toBe('memory')
  })
})

describe.skipIf(POSIX_SANDBOX_SKIPPED)('package bridge', () => {
  function context(root: string): PlansBridgeContext {
    return {
      runtime: {
        pluginId: 'acme.indexer', packageVersion: '1.0.0', workspaceId: 'ws', instanceId: 'i',
        contributionKey: 'k', hostWindowId: 'w', initiator: { kind: 'user', id: 'u' } as never,
      },
      workspacePath: root,
      authorizedPlanRoot: root,
      requestId: 'bridge:1',
      signal: new AbortController().signal,
      emit: vi.fn(),
    }
  }
  const request = (port: string, operation: string) => ({
    id: 'bridge:1', origin: { kind: 'call' as const, requestId: 'r' }, port: port as never, operation, arguments: { rel_path: 'a.txt' },
  })
  function fsPort(): PlansFilesystemPort {
    const handler = vi.fn(async () => ({ ok: true }))
    return new Proxy({}, { get: () => handler }) as PlansFilesystemPort
  }

  it('forwards reads inside the bound workspace and denies other ports', async () => {
    const port = fsPort()
    const { instance } = controller({ promptConsent: allow, filesystemPort: () => port })
    const admission = await instance.admit(writePackage({ system: ['fs'] }), root)
    await expect(admission.bridgeDispatcher.dispatch(request('filesystem', 'read_file'), context(root))).resolves.toEqual({ ok: true })
    for (const [port_, operation] of [['terminal', 'create'], ['spawn', 'transform'], ['agent-messaging', 'send'], ['workspace-storage', 'get']]) {
      await expect(admission.bridgeDispatcher.dispatch(request(port_, operation), context(root)))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    }
    await expect(admission.bridgeDispatcher.dispatch(request('filesystem', 'watch'), context(root)))
      .rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' })
    await expect(admission.bridgeDispatcher.dispatch(request('filesystem', 'read_file'), { ...context(root), authorizedPlanRoot: undefined }))
      .rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
  })

  it('denies the filesystem to a package that did not declare fs', async () => {
    const { instance } = controller({ promptConsent: allow, filesystemPort: fsPort })
    const admission = await instance.admit(writePackage({}), root)
    expect(admission.workspaceRoot).toBeUndefined()
    await expect(admission.bridgeDispatcher.dispatch(request('filesystem', 'read_file'), context(root)))
      .rejects.toBeInstanceOf(PlansBridgeError)
  })

  it('needs a separate per-workspace grant for writes, unchecked by default', async () => {
    const promptWorkspaceWrite = vi.fn(async () => false)
    const { instance } = controller({ promptConsent: allow, filesystemPort: fsPort, promptWorkspaceWrite })
    const admission = await instance.admit(writePackage({ system: ['fs'] }), root)
    await expect(admission.bridgeDispatcher.dispatch(request('filesystem', 'write_file'), context(root)))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(admission.bridgeDispatcher.dispatch(request('filesystem', 'delete'), context(root)))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(promptWorkspaceWrite).toHaveBeenCalledTimes(1)
    expect(store.allowsWorkspaceWrite('acme.indexer', root)).toBe(false)

    promptWorkspaceWrite.mockResolvedValue(true)
    await instance.setWorkspaceWrite('acme.indexer', root, false)
    await expect(admission.bridgeDispatcher.dispatch(request('filesystem', 'write_file'), context(root))).resolves.toEqual({ ok: true })
    expect(store.allowsWorkspaceWrite('acme.indexer', root)).toBe(true)
    const other = join(root, 'other')
    await expect(admission.bridgeDispatcher.dispatch(request('filesystem', 'write_file'), context(other))).resolves.toEqual({ ok: true })
    expect(promptWorkspaceWrite).toHaveBeenCalledTimes(3)
  })

  const shellRequest = (args: unknown) => ({
    id: 'bridge:1', origin: { kind: 'call' as const, requestId: 'r' }, port: 'shell' as never, operation: 'run', arguments: args as never,
  })
  function shellPort(result: unknown = { exitCode: 0, stdout: 'main\n', stderr: '' }) {
    const run = vi.fn(async (_command: string, _context: PlansBridgeContext) => result as never)
    return { port: { run }, run }
  }

  it('lets a read-tool agent call run only read-only VCS commands, and a write-tool call more only with DB3', async () => {
    const { port, run } = shellPort()
    let call: { pluginId: string; risk: 'read' | 'write'; workspaceRoot: string } | undefined
    const { instance } = controller({ promptConsent: allow, shellPort: () => port, agentToolCall: () => call })
    const spec = writePackage({ shell: 'allowlist' })
    const admission = await instance.admit(spec, root)
    const agentContext = { ...context(root), runtime: { ...context(root).runtime, initiator: { kind: 'agent', source: 'mcp', id: 'a-1' } as never } }
    const runAs = (command: string) => admission.bridgeDispatcher.dispatch(shellRequest({ command }), agentContext)
    // Outside an admitted call: refused.
    await expect(runAs('git status')).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    call = { pluginId: 'acme.indexer', risk: 'read', workspaceRoot: root }
    for (const command of ['git status', 'git log --oneline -5', 'git branch --show-current', 'gh pr view 12', 'glab mr list']) {
      await expect(runAs(command)).resolves.toEqual({ exitCode: 0, stdout: 'main\n', stderr: '' })
    }
    for (const command of ['git commit -m x', 'git push', 'git branch new-branch', 'git diff --output=/tmp/x', 'gh pr merge 12', 'gh api repos/x -X POST', 'git -c core.pager=sh log', 'git log $(id)']) {
      await expect(runAs(command)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    }
    // A write tool runs a writing command only with the DB3 answer.
    call = { pluginId: 'acme.indexer', risk: 'write', workspaceRoot: root }
    await expect(runAs('git commit -m x')).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    store.setAgentToolWrite('acme.indexer', '1.0.0', store.record('acme.indexer').consent!.grantedAt, root)
    await expect(runAs('git commit -m x')).resolves.toEqual({ exitCode: 0, stdout: 'main\n', stderr: '' })
    expect(run).toHaveBeenCalledTimes(6)
  })

  it('refuses the shell port to a backend that did not declare shell', async () => {
    const { port, run } = shellPort()
    const { instance } = controller({ promptConsent: allow, filesystemPort: fsPort, shellPort: () => port })
    for (const options of [{}, { system: ['fs'] }]) {
      const admission = await instance.admit(writePackage(options), root)
      await expect(admission.bridgeDispatcher.dispatch(shellRequest({ command: 'git status' }), context(root)))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('runs Host-allowlisted commands through the shell broker and refuses everything else', async () => {
    const { port, run } = shellPort()
    const { instance } = controller({ promptConsent: allow, shellPort: () => port })
    const admission = await instance.admit(writePackage({ shell: 'allowlist' }), root)
    expect(admission.workspaceRoot).toBe(root)

    for (const command of ['git rev-parse HEAD', 'gh pr list --state merged', 'glab mr list']) {
      await expect(admission.bridgeDispatcher.dispatch(shellRequest({ command }), context(root)))
        .resolves.toEqual({ exitCode: 0, stdout: 'main\n', stderr: '' })
    }
    expect(run.mock.calls.map(([command]) => command)).toEqual(['git rev-parse HEAD', 'gh pr list --state merged', 'glab mr list'])
    expect(run.mock.calls[0][1].authorizedPlanRoot).toBe(root)

    run.mockClear()
    for (const command of ['rm -rf /', 'sh -c "git status"', 'git status; rm -rf /', 'curl https://example.com', '/usr/bin/git status', '']) {
      await expect(admission.bridgeDispatcher.dispatch(shellRequest({ command }), context(root)))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    }
    for (const args of [null, 'git status', { command: 1 }, { command: 'git status', cwd: '/' }, { command: 'git status', env: {} }]) {
      await expect(admission.bridgeDispatcher.dispatch(shellRequest(args), context(root)))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(admission.bridgeDispatcher.dispatch({ ...shellRequest({ command: 'git status' }), operation: 'spawn' }, context(root)))
      .rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' })
    await expect(admission.bridgeDispatcher.dispatch(shellRequest({ command: 'git status' }), { ...context(root), authorizedPlanRoot: undefined }))
      .rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
    expect(run).not.toHaveBeenCalled()
  })

  const agentsRequest = (port: string, operation: string, args: unknown = {}) => ({
    id: 'bridge:1', origin: { kind: 'call' as const, requestId: 'r' }, port: port as never, operation, arguments: args as never,
  })

  it('serves agent metadata and message text only for the declared namespace, at the bound workspace', async () => {
    const query = vi.fn(async () => ({ panes: [] }))
    const { instance } = controller({ promptConsent: allow, agentsPort: () => ({ query }) })
    const metadataOnly = await instance.admit(writePackage({ system: ['agents'] }), root)
    expect(metadataOnly.workspaceRoot).toBe(root)
    await expect(metadataOnly.bridgeDispatcher.dispatch(agentsRequest('agents', 'list_panes'), context(root)))
      .resolves.toEqual({ panes: [] })
    expect(query).toHaveBeenCalledWith('list_panes', {}, expect.objectContaining({ authorizedPlanRoot: root }))
    await expect(metadataOnly.bridgeDispatcher.dispatch(agentsRequest('agent-message-bodies', 'read_message', { id: 'm1' }), context(root)))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(metadataOnly.bridgeDispatcher.dispatch(agentsRequest('agents', 'list_messages', { limit: 0 }), context(root)))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(metadataOnly.bridgeDispatcher.dispatch(agentsRequest('agents', 'list_panes'), { ...context(root), authorizedPlanRoot: undefined }))
      .rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })

    const withText = await instance.admit(writePackage({ system: ['agents', 'agentMessages'] }), root)
    await expect(withText.bridgeDispatcher.dispatch(agentsRequest('agent-message-bodies', 'read_message', { id: 'm1' }), context(root)))
      .resolves.toEqual({ panes: [] })
    const none = await instance.admit(writePackage({}), root)
    await expect(none.bridgeDispatcher.dispatch(agentsRequest('agents', 'list_panes'), context(root)))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('gives an agent the agents ports only inside an admitted agent-tool call at that workspace', async () => {
    const query = vi.fn(async () => ({ panes: [] }))
    let call: { pluginId: string; risk: 'read' | 'write'; workspaceRoot: string } | undefined
    const { instance } = controller({ promptConsent: allow, agentsPort: () => ({ query }), agentToolCall: () => call })
    const admission = await instance.admit(writePackage({ system: ['agents'] }), root)
    const agentContext = { ...context(root), runtime: { ...context(root).runtime, initiator: { kind: 'agent', source: 'mcp', id: 'a-1' } as never } }
    const list = () => admission.bridgeDispatcher.dispatch(agentsRequest('agents', 'list_panes'), agentContext)
    await expect(list()).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    call = { pluginId: 'acme.indexer', risk: 'read', workspaceRoot: join(root, 'elsewhere') }
    await expect(list()).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    call = { pluginId: 'acme.indexer', risk: 'read', workspaceRoot: root }
    await expect(list()).resolves.toEqual({ panes: [] })
    expect(query).toHaveBeenCalledOnce()
  })

  it('reports an unavailable shell broker and keeps the filesystem closed to a shell-only package', async () => {
    const { instance } = controller({ promptConsent: allow, filesystemPort: fsPort })
    const admission = await instance.admit(writePackage({ shell: 'allowlist' }), root)
    await expect(admission.bridgeDispatcher.dispatch(shellRequest({ command: 'git status' }), context(root)))
      .rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    await expect(admission.bridgeDispatcher.dispatch(request('filesystem', 'read_file'), context(root)))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
  })
})

describe.skipIf(POSIX_SANDBOX_SKIPPED)('install-time preflight', () => {
  it('needs the full admission for this exact content, never prompts, and runs under the watchdog', async () => {
    const watchResources = vi.fn(() => ({ dispose: vi.fn(), sample: async () => null, terminate: async (item: ResourceViolation) => item, keepRunning: () => 0 }))
    const spawnImpl = vi.fn(() => ({ pid: 7, once: vi.fn() }))
    const { instance } = controller({ promptConsent: allow, watchResources, spawnImpl: spawnImpl as never })
    const spec = writePackage({}, 'binary-v1')

    // No consent yet: staged only, and the user is not asked.
    expect(await instance.preflightAdmission(spec)).toBeNull()
    expect(allow).not.toHaveBeenCalled()

    await instance.allow(spec)
    const admission = await instance.preflightAdmission(spec)
    expect(admission).not.toBeNull()
    admission!.spawnProcess(spec.entryFile, {})
    expect(spawnImpl).toHaveBeenCalledWith(SANDBOX_EXEC_PATH, expect.any(Array), expect.any(Object))
    expect(watchResources).toHaveBeenCalledWith(7, expect.any(String), expect.any(Function), expect.objectContaining({ onExceeded: expect.any(Function) }))

    // A changed binary, a disabled plugin, the switch off, a tripped breaker
    // or no sandbox: never executed.
    expect(await instance.preflightAdmission(writePackage({}, 'binary-v2'))).toBeNull()
    writePackage({}, 'binary-v1')
    await instance.setDisabled('acme.indexer', true)
    expect(await instance.preflightAdmission(spec)).toBeNull()
    await instance.setDisabled('acme.indexer', false)
    store.setEnabled(false)
    expect(await instance.preflightAdmission(spec)).toBeNull()
    store.setEnabled(true)
    const tripped = await instance.admit(spec)
    for (let index = 0; index <= BACKEND_RESTART_DELAYS_MS.length; index += 1) tripped.noteFailure()
    expect(await instance.preflightAdmission(spec)).toBeNull()
    await instance.allow(spec)
    expect(await controller({ probe: { platform: 'win32', sandboxExec: () => null, bubblewrap: () => null } })
      .instance.preflightAdmission(spec)).toBeNull()
    expect(allow).not.toHaveBeenCalled()
  })
})

describe('NativeBackendStore', () => {
  // POSIX permission bits do not exist on Windows; ownerOnlyJsonPersistence
  // accepts any mode there.
  it.skipIf(isWindows())('writes the decision file owner-only', () => {
    store.setEnabled(true)
    expect(statSync(join(root, 'store', 'native-backends.json')).mode & 0o777).toBe(0o600)
  })

  it('persists decisions and reads a corrupt file as nothing allowed', () => {
    store.setEnabled(true)
    store.grantConsent('acme.indexer', { binarySha256: 'a'.repeat(64), permissionsKey: '{}', packageVersion: '1.0.0' })
    store.setWorkspaceWrite('acme.indexer', '/w', true)
    const file = join(root, 'store', 'native-backends.json')
    const reloaded = new NativeBackendStore(join(root, 'store'))
    expect(reloaded.isEnabled()).toBe(true)
    expect(reloaded.record('acme.indexer')).toMatchObject({ workspaceWrite: ['/w'], consent: { packageVersion: '1.0.0' } })
    reloaded.forget('acme.indexer')
    expect(new NativeBackendStore(join(root, 'store')).record('acme.indexer')).toEqual({})

    writeFileSync(file, '{"schemaVersion":1,"enabled":true,"plugins":', { mode: 0o600 })
    expect(new NativeBackendStore(join(root, 'store')).isEnabled()).toBe(false)
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, plugins: { x: { consent: { binarySha256: 'short' } } } }))
    expect(new NativeBackendStore(join(root, 'store')).record('x').consent).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toContain('short')
  })
})

describe('agent tools on the launch spec (plan B1-b)', () => {
  const devmapTools = [
    {
      name: 'indexer_search', method: 'files.search', risk: 'read', title: 'Search', description: 'Search indexed files.',
      inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } },
    },
  ]
  // B1-a teaches the manifest parser `backend.agentTools`; until then the
  // field is read defensively from the parsed manifest, as here.
  function withTools(agentTools: unknown, id = 'acme.indexer') {
    writePackage({ system: ['fs'] })
    const parsed = readInstalledManifestV2(packageDir)
    return thirdPartyBackendLaunchSpec(
      {
        pluginId: id, packageVersion: '1.0.0', packageDir, views: [],
        backend: { entryFile: join(packageDir, 'backend', 'acme-indexer'), protocolVersion: 1, activation: 'startup' },
      },
      { ...parsed, id, backend: { ...parsed.backend!, agentTools } as never },
    )!
  }

  it('is unchanged for a package without agent tools (golden: same spec as main)', () => {
    const spec = writePackage({ system: ['fs'] })
    expect(spec.agentMethods).toEqual([])
    expect(Object.keys(spec.thirdParty).sort()).toEqual(['name', 'system'])
    expect(backendPermissionsKey(spec)).toBe(JSON.stringify({
      system: ['fs'], shell: null, methods: ['files.search'], events: ['files.indexProgress'],
    }))
  })

  it('projects valid declarations with defaults and the disclosure permissions, but no agent methods', () => {
    const spec = withTools(devmapTools)
    expect(spec.agentMethods).toEqual([])
    expect(spec.thirdParty.agentTools).toEqual([{ ...devmapTools[0], timeoutMs: 30_000 }])
    expect(spec.thirdParty.permissions).toEqual({ system: ['fs'], shell: null, scopes: null })
  })

  it('drops every tool of a package whose declaration breaks a contract rule', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // A bad name, an undeclared method, a reserved prefix, or nothing at all.
      expect(withTools([{ ...devmapTools[0], name: 'indexer_search\n' }]).thirdParty.agentTools).toBeUndefined()
      expect(withTools([{ ...devmapTools[0], method: 'files.delete' }]).thirdParty.agentTools).toBeUndefined()
      expect(withTools(devmapTools, 'acme.cli').thirdParty.agentTools).toBeUndefined()
      expect(withTools([]).thirdParty.agentTools).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it('opens agent methods only with the master switch on and a matching consent', () => {
    const spec = withTools(devmapTools)
    expect(consentedAgentMethods(spec, { masterSwitch: false, consentMatches: true })).toEqual([])
    expect(consentedAgentMethods(spec, { masterSwitch: true, consentMatches: false })).toEqual([])
    expect(consentedAgentMethods(spec, { masterSwitch: true, consentMatches: true })).toEqual(['files.search'])
    expect(consentedAgentMethods(writePackage({ system: ['fs'] }), { masterSwitch: true, consentMatches: true })).toEqual([])
  })
})

describe.skipIf(POSIX_SANDBOX_SKIPPED)('agent-tool consent and first-write confirmation', () => {
  it('reports consent for this exact package without prompting', async () => {
    const spec = writePackage({ system: ['fs'] })
    const { instance } = controller({ promptConsent: allow })
    await expect(instance.hasConsent(spec)).resolves.toBe(false)
    await instance.allow(spec)
    await expect(instance.hasConsent(spec)).resolves.toBe(true)
    expect(allow).not.toHaveBeenCalled()
    writePackage({ system: ['fs'] }, 'binary-v2')
    await expect(instance.hasConsent(spec)).resolves.toBe(false)
  })

  it('asks its own DB3 question naming the agent tool, apart from the view grant, once per version and consent', async () => {
    const spec = writePackage({ system: ['fs'] })
    const promptAgentToolWrite = vi.fn(async () => true)
    const promptWorkspaceWrite = vi.fn(async () => true)
    const { instance } = controller({ promptAgentToolWrite, promptWorkspaceWrite })
    const tool = { name: 'indexer_search', title: 'Search' }
    await expect(instance.confirmAgentToolWrite(spec, '/w1', tool)).resolves.toBe(false)
    await instance.allow(spec)
    // The view's "allow file changes" grant is not an answer to the agent question.
    store.setWorkspaceWrite('acme.indexer', '/w1', true)
    await expect(instance.confirmAgentToolWrite(spec, '/w1', tool)).resolves.toBe(true)
    await expect(instance.confirmAgentToolWrite(spec, '/w1', tool)).resolves.toBe(true)
    expect(promptAgentToolWrite).toHaveBeenCalledTimes(1)
    expect(promptAgentToolWrite).toHaveBeenCalledWith({
      pluginId: 'acme.indexer', name: 'Indexer', packageVersion: '1.0.0', workspacePath: '/w1', tool,
    })
    expect(promptWorkspaceWrite).not.toHaveBeenCalled()
    expect(store.record('acme.indexer').agentToolWrite).toMatchObject({ packageVersion: '1.0.0', workspaces: ['/w1'] })

    // An update asks again; so does a new consent; so does a disable.
    await expect(instance.confirmAgentToolWrite({ ...spec, packageVersion: '1.0.1' }, '/w1', tool)).resolves.toBe(true)
    expect(promptAgentToolWrite).toHaveBeenCalledTimes(2)
    await instance.allow(spec)
    expect(store.record('acme.indexer').agentToolWrite).toBeUndefined()
    store.setAgentToolWrite('acme.indexer', '1.0.0', store.record('acme.indexer').consent!.grantedAt, '/w1')
    store.setDisabled('acme.indexer', true)
    expect(store.record('acme.indexer').agentToolWrite).toBeUndefined()
    store.setDisabled('acme.indexer', false)

    promptAgentToolWrite.mockResolvedValue(false)
    await expect(instance.confirmAgentToolWrite(spec, '/w2', tool)).resolves.toBe(false)
    await expect(instance.confirmAgentToolWrite(spec, '/w2', tool)).resolves.toBe(false)
    expect(promptAgentToolWrite).toHaveBeenCalledTimes(3)
  })

  it('counts agent tools as consented only when the consent covers their current set and their DB1 time is recorded', async () => {
    const parsed = (() => {
      writePackage({ system: ['fs'] })
      return readInstalledManifestV2(packageDir)
    })()
    const tools = [{ name: 'indexer_search', method: 'files.search', risk: 'read', title: 'Search', description: 'Search.', inputSchema: { type: 'object', properties: {} } }]
    const make = (agentTools: unknown) => thirdPartyBackendLaunchSpec(
      { pluginId: 'acme.indexer', packageVersion: '1.0.0', packageDir, views: [], backend: { entryFile: join(packageDir, 'backend', 'acme-indexer'), protocolVersion: 1, activation: 'startup' } },
      { ...parsed, backend: { ...parsed.backend!, agentTools } as never },
    )!
    const spec = make(tools)
    const { instance } = controller()
    // A consent from before the package declared tools covers the backend, not the tools.
    const plain = make(undefined)
    await instance.allow(plain)
    await expect(instance.hasConsent(plain)).resolves.toBe(true)
    await expect(instance.hasAgentToolsConsent(plain)).resolves.toBe(false)
    await expect(instance.hasAgentToolsConsent(spec)).resolves.toBe(false)
    // B1-a: the tools' digest is part of the permissions key, and the consent records the DB1 time.
    await instance.allow(spec)
    expect(store.record('acme.indexer').consent!.permissionsKey).toContain(agentToolsDigest(spec.thirdParty.agentTools!))
    await expect(instance.hasAgentToolsConsent(spec)).resolves.toBe(true)
    await expect(instance.hasAgentToolsConsent(make([{ ...tools[0], description: 'Search better.' }]))).resolves.toBe(false)
    // Without its DB1 time the package holds no names, as in the listing.
    store.clearAgentToolsSince('acme.indexer')
    await expect(instance.hasAgentToolsConsent(spec)).resolves.toBe(false)
  })

  it('lets an agent write through the bridge only inside a write-tool call with the DB3 answer, never prompting', async () => {
    const spec = writePackage({ system: ['fs'] })
    const port = { writeFile: vi.fn(async () => ({ ok: true })) } as unknown as PlansFilesystemPort
    const promptWorkspaceWrite = vi.fn(async () => true)
    let call: { pluginId: string; risk: 'read' | 'write'; workspaceRoot: string } | undefined
    const { instance } = controller({ promptWorkspaceWrite, filesystemPort: () => port, agentToolCall: () => call })
    await instance.allow(spec)
    const admission = await instance.admit(spec, undefined)
    const context = {
      runtime: { pluginId: 'acme.indexer', packageVersion: '1.0.0', workspaceId: 'w', instanceId: 'i', contributionKey: 'k', hostWindowId: null, initiator: { kind: 'agent', source: 'mcp', id: 'agent-1' } },
      workspacePath: '/w1', authorizedPlanRoot: '/w1', requestId: 'b', signal: new AbortController().signal, emit: () => undefined,
    } as unknown as PlansBridgeContext
    const request = { id: 'b', origin: { kind: 'call' as const, requestId: 'r' }, port: 'filesystem' as const, operation: 'write_file', arguments: { rel_path: 'a', content: 'x' } as never }
    // Outside a call, inside a read-tool call, or without the DB3 answer: refused.
    await expect(admission.bridgeDispatcher.dispatch(request, context)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    call = { pluginId: 'acme.indexer', risk: 'read', workspaceRoot: '/w1' }
    store.setWorkspaceWrite('acme.indexer', '/w1', true)
    await expect(admission.bridgeDispatcher.dispatch(request, context)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    call = { pluginId: 'acme.indexer', risk: 'write', workspaceRoot: '/w1' }
    await expect(admission.bridgeDispatcher.dispatch(request, context)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    store.setAgentToolWrite('acme.indexer', '1.0.0', store.record('acme.indexer').consent!.grantedAt, '/w1')
    await expect(admission.bridgeDispatcher.dispatch(request, context)).resolves.toEqual({ ok: true })
    expect(promptWorkspaceWrite).not.toHaveBeenCalled()
  })

  it('tells the agent-tool catalog when the first-use dialog grants consent', async () => {
    const spec = writePackage({ system: ['fs'] })
    const onConsentGranted = vi.fn()
    const { instance } = controller({ promptConsent: allow, onConsentGranted })
    await instance.admit(spec, undefined)
    expect(onConsentGranted).toHaveBeenCalledWith('acme.indexer')
  })
})

describe('NativeBackendStore agent-tool switches', () => {
  it('are off by default and leave the file as on main until changed', () => {
    const fresh = new NativeBackendStore(join(root, 'switch-store'))
    expect(fresh.agentToolSwitches()).toEqual({ enabled: false, externalCallers: false })
    fresh.setEnabled(true)
    const file = JSON.parse(readFileSync(join(root, 'switch-store', 'native-backends.json'), 'utf8'))
    expect(file).toEqual({ schemaVersion: 1, enabled: true, plugins: {} })
  })

  it('persist each switch and read a malformed value as off', () => {
    const switches = new NativeBackendStore(join(root, 'switch-store'))
    switches.setAgentToolSwitches({ enabled: true })
    switches.setAgentToolSwitches({ externalCallers: true })
    expect(new NativeBackendStore(join(root, 'switch-store')).agentToolSwitches()).toEqual({ enabled: true, externalCallers: true })
    writeFileSync(join(root, 'switch-store', 'native-backends.json'), JSON.stringify({
      schemaVersion: 1, enabled: false, plugins: {}, agentTools: { enabled: 'yes', externalCallers: 1 },
    }))
    expect(new NativeBackendStore(join(root, 'switch-store')).agentToolSwitches()).toEqual({ enabled: false, externalCallers: false })
  })

  it('turns external clients off with the agent switch, so turning it on never re-enables them silently', () => {
    const switches = new NativeBackendStore(join(root, 'switch-store'))
    switches.setAgentToolSwitches({ enabled: true })
    switches.setAgentToolSwitches({ externalCallers: true })
    switches.setAgentToolSwitches({ enabled: false })
    expect(switches.agentToolSwitches()).toEqual({ enabled: false, externalCallers: false })
    switches.setAgentToolSwitches({ enabled: true })
    expect(switches.agentToolSwitches()).toEqual({ enabled: true, externalCallers: false })
  })

  it('turns a switch off in memory even when the save fails', () => {
    const switches = new NativeBackendStore(join(root, 'switch-store'))
    switches.setAgentToolSwitches({ enabled: true })
    const write = vi.spyOn(OwnerOnlyJsonPersistence.prototype, 'write').mockImplementation(() => {
      throw new Error('disk full')
    })
    try {
      expect(() => switches.setAgentToolSwitches({ enabled: false })).toThrow('disk full')
      expect(switches.agentToolSwitches().enabled).toBe(false)
      expect(() => switches.setAgentToolSwitches({ enabled: true })).toThrow('disk full')
      expect(switches.agentToolSwitches().enabled).toBe(false)
    } finally {
      write.mockRestore()
    }
  })
})

describe('native backend consent text', () => {
  const base = {
    pluginId: 'acme.indexer', name: 'Indexer', packageVersion: '1.0.0', methods: ['files.search'], agentTools: [], update: false,
  }

  // Plan B D-g: localized, with the methods listed.
  it('lists the methods the backend serves, sorted, in every locale', () => {
    const prompt = { ...base, system: [], methods: ['files.search', 'files.index'] }
    expect(nativeBackendConsentText(prompt).detail).toContain('Methods it serves: files.index, files.search.')
    expect(nativeBackendConsentText(prompt, 'zh-TW').detail).toContain('它提供的方法：files.index、files.search。')
    expect(nativeBackendConsentText(prompt, 'ja-JP').detail).toContain('提供するメソッド：files.index、files.search。')
    expect(nativeBackendConsentText({ ...prompt, methods: [] }).detail).toContain('It declares no methods.')
  })

  it.each(['zh-TW', 'ja-JP'] as const)('localizes the whole dialog (%s) and keeps the shell disclosure honest', (locale) => {
    const plain = nativeBackendConsentText({ ...base, system: ['fs'] }, locale)
    const shell = nativeBackendConsentText({ ...base, system: ['fs'], shell: 'allowlist' }, locale)
    for (const text of [plain, shell]) {
      expect(`${text.title}${text.message}${text.detail}${text.buttons.join('')}`).not.toMatch(/[A-Za-z]{4,} [a-z]{3,} [a-z]{3,}/)
      expect(text.detail).toContain('Navide')
    }
    expect(shell.detail).toMatch(/高風險|高リスク/)
    expect(shell.detail).toContain('git push')
    expect(shell.detail).not.toContain(plain.detail.split('\n\n')[0])
    expect(shell.detail).toMatch(/30/)
  })

  it('names the Navide plugins settings page, not the CLI extensions page', () => {
    const { detail, title, buttons } = nativeBackendConsentText({ ...base, system: [] })
    expect(detail).toContain('Settings → Navide Plugins')
    expect(detail).not.toContain('Settings → Extensions')
    expect(title).toBe('Native code')
    expect(buttons).toEqual(['Not now', 'Allow'])
  })

  it('says "no network access" only for a package without shell', () => {
    for (const system of [[], ['fs']] as const) {
      const { message, detail } = nativeBackendConsentText({ ...base, system: [...system] })
      expect(message).toBe('Indexer contains native code that runs on your computer. Allow it to run?')
      expect(detail).toContain('it has no network access')
      expect(detail).not.toMatch(/git|gh|glab|high risk/i)
    }
  })

  it('discloses shell as high risk that can contact network hosts and send workspace data, and never claims no network', () => {
    const { detail } = nativeBackendConsentText({ ...base, system: ['fs'], shell: 'allowlist' })
    expect(detail).not.toMatch(/no network/i)
    expect(detail).toContain('High risk')
    expect(detail).toContain('git, gh and glab')
    expect(detail).toContain('can contact network hosts')
    expect(detail).toContain('send data from this workspace')
    expect(detail).toContain('cannot open network connections itself')
    // Through git a shell package reads and changes workspace files without
    // the file-change grant: the text must not claim otherwise (review M1).
    for (const system of [[], ['fs']] as const) {
      const text = nativeBackendConsentText({ ...base, system: [...system], shell: 'allowlist' }).detail
      expect(text).not.toContain('no access to your files')
      expect(text).not.toContain('Changing files needs your separate permission')
      expect(text).toContain('Through git it can read and change files tracked in this workspace and delete untracked files, without the separate file-change permission.')
      expect(text).toContain('Commands it has already started when you disable it or revoke its permission run to completion (up to about 30 seconds).')
    }
    expect(nativeBackendConsentText({ ...base, system: ['fs'], shell: 'allowlist' }).detail).toContain('It asks to read files in the workspace you open it in.')
    expect(nativeBackendConsentText({ ...base, system: ['fs'] }).detail).not.toContain('run to completion')
    const update = nativeBackendConsentText({ ...base, system: [], shell: 'allowlist', update: true })
    expect(update.message).toBe('Indexer 1.0.0 changed its native code or permissions. Allow it to run?')
    expect(update.detail).not.toMatch(/no network/i)
  })

  it('lists each agent tool with its method, declared claim, timeout and whole input schema, plus count and size', () => {
    const agentTools = [
      { name: 'indexer_find', method: 'files.search', risk: 'read', title: 'Find', description: 'Find files.',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, timeoutMs: 30000 },
      { name: 'indexer_tag', method: 'files.tag', risk: 'write', title: 'Tag', description: 'Tag a file.',
        inputSchema: { type: 'object' }, timeoutMs: 5000 },
    ] as const
    const { detail } = nativeBackendConsentText({ ...base, system: ['fs'], agentTools: [...agentTools] })
    expect(detail).toContain(
      `Agents will be able to call these 2 tools of Indexer (their text and input schemas total ${
        Buffer.byteLength(JSON.stringify(agentTools))} bytes):`,
    )
    expect(detail).toContain('• indexer_find → files.search (declared read-only, times out after 30 s): Find files.')
    expect(detail).toContain('  Input schema: {"type":"object","properties":{"q":{"type":"string"}}}')
    expect(detail).toContain('• indexer_tag → files.tag (declared as changing data, times out after 5 s): Tag a file.')
    expect(detail.indexOf('Agents will be able')).toBeLessThan(detail.indexOf('You can disable it at any time'))
    expect(nativeBackendConsentText({ ...base, system: ['fs'], agentTools: [] }).detail).not.toContain('Agents will')
  })

  // D-g with #346: the agent-tool section is in the dialog's language too.
  it.each([
    ['zh-TW', 'agent 將可以呼叫 Indexer 的這 1 個工具', '• indexer_find → files.search（外掛宣告為唯讀，30 秒後逾時）：Find files.', '  輸入結構描述：{"type":"object"}'],
    ['ja-JP', 'agent は Indexer のこれら 1 個のツールを呼び出せるようになります', '• indexer_find → files.search（プラグインの宣言：読み取り専用、30 秒でタイムアウト）：Find files.', '  入力スキーマ：{"type":"object"}'],
  ] as const)('words the agent tools in the dialog language (%s)', (locale, intro, line, schema) => {
    const tool = {
      name: 'indexer_find', method: 'files.search', risk: 'read' as const, title: 'Find', description: 'Find files.',
      inputSchema: { type: 'object' }, timeoutMs: 30000,
    }
    const { detail } = nativeBackendConsentText({ ...base, system: ['fs'], agentTools: [tool] }, locale)
    expect(detail).toContain(intro)
    expect(detail).toContain(line)
    expect(detail).toContain(schema)
    expect(detail).not.toMatch(/Agents will|Input schema|declared read-only|What these tools return/)
  })

  it('spells out invisible characters in a tool schema instead of showing them raw', () => {
    const tool = {
      name: 'indexer_find', method: 'files.search', risk: 'read' as const, title: 'Find', description: 'Find files.',
      inputSchema: { type: 'object', properties: { 'k\u202ex': { enum: ['a\u200bb', 'v\ufe0f'] } } }, timeoutMs: 30000,
    }
    const { detail } = nativeBackendConsentText({ ...base, system: ['fs'], agentTools: [tool] })
    expect(detail).toContain('  Input schema: {"type":"object","properties":{"k\\u{202e}x":{"enum":["a\\u{200b}b","v\\u{fe0f}"]}}}')
    expect(detail).not.toMatch(/[\u200b\u202e\ufe0f]/)
  })
})

describe('first-write confirmation for a first-party agent tool (navide.browser)', () => {
  function browserSpec(pluginId = 'navide.browser', version = '1.0.0'): ThirdPartyLaunchSpec {
    return {
      pluginId, packageVersion: version, packageDir: '/pkgs/browser', entryFile: '/pkgs/browser/backend/navide-browser',
      protocolVersion: 1, activation: 'startup', approvedMethods: ['browser.act'], agentMethods: [], approvedEvents: [],
      approvedBridgePorts: ['web'], thirdParty: { name: 'Browser', system: ['ui', 'web'] },
    }
  }
  const tool = { name: 'browser_act', title: 'Act' }

  it('asks once per version and workspace without any native-backend consent', async () => {
    const promptAgentToolWrite = vi.fn(async () => true)
    const { instance } = controller({ promptAgentToolWrite })
    store.setEnabled(false)
    await expect(instance.confirmFirstPartyAgentToolWrite(browserSpec(), '/w1', tool)).resolves.toBe(true)
    await expect(instance.confirmFirstPartyAgentToolWrite(browserSpec(), '/w1', tool)).resolves.toBe(true)
    expect(promptAgentToolWrite).toHaveBeenCalledTimes(1)
    expect(store.record('navide.browser').consent).toBeUndefined()
    await expect(instance.confirmFirstPartyAgentToolWrite(browserSpec('navide.browser', '1.0.1'), '/w1', tool)).resolves.toBe(true)
    expect(promptAgentToolWrite).toHaveBeenCalledTimes(2)
    promptAgentToolWrite.mockResolvedValue(false)
    await expect(instance.confirmFirstPartyAgentToolWrite(browserSpec(), '/w2', tool)).resolves.toBe(false)
  })

  it('never answers for a third-party package, and the third-party path still needs consent', async () => {
    const promptAgentToolWrite = vi.fn(async () => true)
    const { instance } = controller({ promptAgentToolWrite })
    await expect(instance.confirmFirstPartyAgentToolWrite(browserSpec('acme.browser'), '/w1', tool)).resolves.toBe(false)
    await expect(instance.confirmAgentToolWrite(browserSpec('acme.browser'), '/w1', tool)).resolves.toBe(false)
    // A first-party write answer is not a consent a third-party path accepts.
    await expect(instance.confirmAgentToolWrite(browserSpec(), '/w1', tool)).resolves.toBe(false)
    expect(promptAgentToolWrite).not.toHaveBeenCalled()
  })
})
