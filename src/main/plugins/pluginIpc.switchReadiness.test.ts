// H1 (0.2.34, approved by the commander 2026-10-29): an installed version
// proves its views report ready right before a switch drains the running one
// (Restart, an update taking effect, Back to), a switch within one source
// carries the SDK view state, and the main window hears when a switch drains
// views and when it has settled. Kept apart from pluginIpc.test.ts so the
// Marketplace suite there stays as it is on main.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { makeZip } from './zipFixture'
import { sha256Hex } from './pluginVerify'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import type { InstallerTrustConfig } from './pluginInstaller'
import { PluginActivationSelector } from './pluginActivationSelector'
import { PluginCapabilityGrantStore } from './pluginCapabilityGrantStore'
import { PluginStorageStore, pluginStorageDirName } from './pluginStorage'

const { handlers, order } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  /** Every check, readiness check and drain of a switch, in call order. */
  order: [] as string[],
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.2.34' },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: (channel: string, fn: (...a: unknown[]) => unknown) => { handlers.set(channel, fn) } },
}))
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()), fsyncSync: () => {} }))
// The signature and Registry trust check of an installed package, recorded.
vi.mock('./pluginInstalledTrust', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pluginInstalledTrust')>()
  return {
    ...actual,
    verifyInstalledRegistryPackage: (...args: Parameters<typeof actual.verifyInstalledRegistryPackage>) => {
      order.push('trust')
      return actual.verifyInstalledRegistryPackage(...args)
    },
  }
})
vi.setConfig({ testTimeout: 30_000 })

import { registerPluginIpc } from './pluginIpc'
import { FrontendPluginManager } from './frontendPluginManager'

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey }
}
const sign = (value: unknown, key: Parameters<typeof edSign>[2]) => edSign(null, Buffer.from(canonicalTrustJson(value)), key).toString('base64')
const root = keypair()
const signer = keypair()
const TRUST: InstallerTrustConfig = { pinnedRegistryRootKey: root.pubPem, now: new Date('2026-08-16T12:00:00.000Z') }
const ID = 'acme.todo'

function vsix(id: string, version: string): Uint8Array {
  return new Uint8Array(makeZip([
    { name: 'manifest.json', data: JSON.stringify({
      schemaVersion: 2, apiVersion: '^1.0.0', id, name: 'Todo', version, publisher: id.split('.')[0], permissions: {},
      marketplace: { description: 'Todo', license: 'MIT' },
      contributes: { views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Todo', entry: 'frontend/left/index.html' }] },
    }) },
    { name: 'frontend/left/index.html', data: '<!doctype html>' },
  ]))
}

function metadata(): RegistryTrustMetadata {
  return {
    schemaVersion: 1, registryProfile: 'official', rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z', expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [{ keyId: 'k1', publicKey: signer.pubPem, status: 'active', notBefore: '2026-08-01T00:00:00.000Z', notAfter: '2026-09-01T00:00:00.000Z' }],
    blockedPublishers: [], blockedPackages: [],
  }
}

function serveRegistry(id: string, version: string): void {
  const bytes = vsix(id, version)
  const digest = sha256Hex(bytes)
  const [namespace, name] = id.split('.')
  const trust = metadata()
  const envelope: RegistryPackageEnvelope = {
    schemaVersion: 1, artifactDigest: digest, packageId: id, version, target: 'universal', publisherId: namespace,
    keyId: 'k1', signedAt: '2026-08-16T11:00:00.000Z',
  }
  const detail = {
    latest_version: version, trust_metadata: trust, trust_metadata_signature: sign(trust, root.privateKey),
    versions: [{ version, package_digest: digest, target: 'universal', registry_envelope: envelope,
      registry_signature: sign(envelope, signer.privateKey), trust_tier: 'signed-verified', yanked: false }],
  }
  global.fetch = vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.endsWith('/download')) {
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), headers: { get: () => digest } }
    }
    if (u.includes('/api/extensions?')) return { ok: true, status: 200, json: async () => ({ items: [{ namespace, name }] }) }
    return { ok: true, status: 200, json: async () => detail }
  }) as unknown as typeof fetch
}

let base = ''
let pluginsRoot = ''
let storageRoot = ''
let picked = ''
let manager: FrontendPluginManager
let storage: PluginStorageStore
let preflight: ReturnType<typeof vi.fn>
let carry: ReturnType<typeof vi.fn>
let switching: Array<{ pluginId: string; toVersion: string; phase: 'start' | 'end' }>
let switchingThrows = false

function register(): void {
  manager = new FrontendPluginManager()
  registerPluginIpc(manager, pluginsRoot, () => true, TRUST, undefined, {
    cleanupPluginStorage: async () => undefined,
    preflightCandidateFrontend: preflight,
    preflightCandidateBackend: async () => undefined,
    pickLocalPackageFile: async () => picked,
    pluginStorageRoot: storageRoot,
    // The production wiring (index.ts), on a real store.
    carryPluginViewState: carry,
    onPackageSwitching: (notice) => {
      order.push(`switching ${notice.phase}`)
      switching.push(notice)
      if (switchingThrows) throw new Error('window gone')
    },
  })
}
const call = (channel: string, args?: unknown) => handlers.get(channel)!(null, args)

async function stageMarketplace(id: string, version: string, approval: Record<string, unknown> = {}): Promise<void> {
  serveRegistry(id, version)
  await call('plugins:prepareInstall', { namespace: id.split('.')[0], name: id.split('.')[1] })
  await call('plugins:commitInstall', { id, publisherConfirmed: true, riskConfirmed: true, ...approval })
}

async function marketplaceInstall(id: string, version: string, approval: Record<string, unknown> = {}): Promise<void> {
  await stageMarketplace(id, version, approval)
  await call('plugins:restart', { id })
}

async function fileInstall(id: string, version: string, approval: Record<string, unknown> = {}): Promise<void> {
  writeFileSync(picked, vsix(id, version))
  await call('plugins:installFromFile')
  await call('plugins:commitLocalInstall', { id, riskConfirmed: true, ...approval })
  await call('plugins:restart', { id })
}

/** The version the manager runs now. */
const activeVersion = () => manager.listInstalledPackages().find((pkg) => pkg.id === ID)?.packageVersion

/** Record the selector and grant checks and the drain, beside the trust checks. */
function recordSwitchSteps(): void {
  // The selector's own reads inside a journal write are not checks.
  let journaling = 0
  const read = PluginActivationSelector.prototype.read
  vi.spyOn(PluginActivationSelector.prototype, 'read').mockImplementation(function (this: PluginActivationSelector, id: string) {
    if (journaling === 0) order.push('selector')
    return read.call(this, id)
  })
  const grant = PluginCapabilityGrantStore.prototype.get
  vi.spyOn(PluginCapabilityGrantStore.prototype, 'get').mockImplementation(function (this: PluginCapabilityGrantStore, ...args: Parameters<typeof grant>) {
    order.push('grant')
    return grant.apply(this, args)
  })
  for (const name of ['beginActivation', 'beginRollback'] as const) {
    const original = PluginActivationSelector.prototype[name] as (...a: unknown[]) => unknown
    vi.spyOn(PluginActivationSelector.prototype, name).mockImplementation(function (this: PluginActivationSelector, ...args: unknown[]) {
      order.push(name)
      journaling += 1
      try {
        return original.apply(this, args)
      } finally {
        journaling -= 1
      }
    } as never)
  }
  const drain = manager.beginPackageRestart.bind(manager)
  vi.spyOn(manager, 'beginPackageRestart').mockImplementation(async (...args) => {
    order.push('drain')
    return drain(...args)
  })
  preflight.mockImplementation(async () => { order.push('preflight') })
  order.length = 0
}

const viewStateSet = (packageVersion: string, key: string, value: string, workspaceId: string | null = null) =>
  storage.execute({
    address: 'storage.set',
    args: { scope: workspaceId === null ? 'plugin' : 'workspace', key, value },
    partition: { pluginId: ID, workspaceId, key },
    snapshot: { pluginId: ID, tier: 'active', packageVersion },
  })
const viewStateGet = (packageVersion: string, key: string, workspaceId: string | null = null) =>
  storage.execute({
    address: 'storage.get',
    args: { scope: workspaceId === null ? 'plugin' : 'workspace', key },
    partition: { pluginId: ID, workspaceId, key },
    snapshot: { pluginId: ID, tier: 'active', packageVersion },
  })

/** Every file under `dir` with its bytes, keyed by its path below `dir`. */
function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else files[relative(dir, path)] = readFileSync(path, 'utf8')
    }
  }
  if (existsSync(dir)) walk(dir)
  return files
}

beforeEach(() => {
  handlers.clear()
  order.length = 0
  base = realpathSync(mkdtempSync(join(tmpdir(), 'navide-switch-readiness-')))
  pluginsRoot = join(base, 'plugins')
  storageRoot = join(base, 'plugin-storage-v2')
  picked = join(base, 'picked.vsix')
  mkdirSync(pluginsRoot)
  mkdirSync(storageRoot)
  storage = new PluginStorageStore(storageRoot)
  preflight = vi.fn(async () => undefined)
  carry = vi.fn((pluginId: string, fromVersion: string, toVersion: string) =>
    storage.carryViewState(pluginId, fromVersion, toVersion))
  switching = []
  switchingThrows = false
  register()
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(base, { recursive: true, force: true })
})

describe('H1: the readiness check runs after every existing check and before the drain', () => {
  it('Restart: the selector, trust and grant checks keep their order; then the check, then the drain', async () => {
    await marketplaceInstall(ID, '1.0.0')
    await stageMarketplace(ID, '1.1.0')
    recordSwitchSteps()
    await call('plugins:restart', { id: ID })
    const drainAt = order.indexOf('drain')
    // As on main up to the readiness check: the handler's and restart's own
    // selector reads, the candidate's trust, the active package's grant.
    expect(order.slice(0, order.indexOf('preflight'))).toEqual(['selector', 'selector', 'trust', 'grant'])
    expect(order.slice(order.indexOf('preflight'), drainAt + 1))
      .toEqual(['preflight', 'switching start', 'beginActivation', 'drain'])
    // The cutover re-check after the drain is unchanged.
    expect(order.slice(drainAt + 1, drainAt + 3)).toEqual(['selector', 'trust'])
    expect(order.filter((step) => step === 'preflight')).toHaveLength(1)
    expect(order.at(-1)).toBe('switching end')
    expect(activeVersion()).toBe('1.1.0')
  })

  it('Back to: the selector read and the previous version\'s trust check keep their order; then the check, then the drain', async () => {
    await marketplaceInstall(ID, '1.0.0')
    await marketplaceInstall(ID, '1.1.0')
    recordSwitchSteps()
    await call('plugins:rollback', { id: ID })
    const drainAt = order.indexOf('drain')
    expect(order.slice(0, order.indexOf('preflight'))).toEqual(['selector', 'trust'])
    expect(order.slice(order.indexOf('preflight'), drainAt + 1))
      .toEqual(['preflight', 'switching start', 'beginRollback', 'drain'])
    // verifyPrevious at the cutover is unchanged.
    expect(order.slice(drainAt + 1, drainAt + 2)).toEqual(['trust'])
    expect(order.at(-1)).toBe('switching end')
    expect(activeVersion()).toBe('1.0.0')
  })

  it('checks the version about to run, never its backend', async () => {
    await marketplaceInstall(ID, '1.0.0')
    await stageMarketplace(ID, '1.1.0')
    preflight.mockClear()
    await call('plugins:restart', { id: ID })
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(preflight.mock.calls[0]![0]).toMatchObject({ id: ID, packageVersion: '1.1.0' })
    preflight.mockClear()
    await call('plugins:rollback', { id: ID })
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(preflight.mock.calls[0]![0]).toMatchObject({ id: ID, packageVersion: '1.0.0' })
  })
})

describe('H1: a view that never reports ready at the switch', () => {
  it('Restart: the old version keeps running, nothing is drained, the update stays staged', async () => {
    await marketplaceInstall(ID, '1.0.0')
    await stageMarketplace(ID, '1.1.0')
    const drain = vi.spyOn(manager, 'beginPackageRestart')
    const revoke = vi.spyOn(manager, 'revokePackageVersion')
    preflight.mockRejectedValueOnce(new Error('plugin view did not report ready'))
    await expect(call('plugins:restart', { id: ID })).rejects.toThrow(/did not report ready/)
    expect(drain).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    expect(activeVersion()).toBe('1.0.0')
    const selected = new PluginActivationSelector(pluginsRoot).read(ID)
    expect(selected?.active?.packageVersion).toBe('1.0.0')
    expect(selected?.candidate?.packageVersion).toBe('1.1.0')
    expect(selected?.activation).toBeUndefined()
    // Nothing drained, so nothing was announced as switching.
    expect(switching).toEqual([])
    // The next attempt switches as usual.
    await call('plugins:restart', { id: ID })
    expect(activeVersion()).toBe('1.1.0')
  })

  it('Back to: nothing is drained and the running version stays active', async () => {
    await marketplaceInstall(ID, '1.0.0')
    await marketplaceInstall(ID, '1.1.0')
    switching = []
    const drain = vi.spyOn(manager, 'beginPackageRestart')
    const revoke = vi.spyOn(manager, 'revokePackageVersion')
    preflight.mockRejectedValueOnce(new Error('plugin view did not report ready'))
    await expect(call('plugins:rollback', { id: ID })).rejects.toThrow(/did not report ready/)
    expect(drain).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    expect(activeVersion()).toBe('1.1.0')
    const selected = new PluginActivationSelector(pluginsRoot).read(ID)
    expect(selected?.active?.packageVersion).toBe('1.1.0')
    expect(selected?.previous?.packageVersion).toBe('1.0.0')
    expect(selected?.activation).toBeUndefined()
    expect(switching).toEqual([])
  })
})

describe('H1: the switching notice', () => {
  it('says start before the drain and end after the switch settled', async () => {
    await marketplaceInstall(ID, '1.0.0')
    await stageMarketplace(ID, '1.1.0')
    recordSwitchSteps()
    await call('plugins:restart', { id: ID })
    expect(order.indexOf('switching start')).toBeLessThan(order.indexOf('drain'))
    expect(order.at(-1)).toBe('switching end')
    expect(switching).toEqual([
      { pluginId: ID, toVersion: '1.1.0', phase: 'start' },
      { pluginId: ID, toVersion: '1.1.0', phase: 'end' },
    ])
    order.length = 0
    switching = []
    await call('plugins:rollback', { id: ID })
    expect(order.indexOf('switching start')).toBeLessThan(order.indexOf('drain'))
    expect(order.at(-1)).toBe('switching end')
    expect(switching).toEqual([
      { pluginId: ID, toVersion: '1.0.0', phase: 'start' },
      { pluginId: ID, toVersion: '1.0.0', phase: 'end' },
    ])
  })

  it('says end after a switch that failed after the drain, once its recovery settled', async () => {
    await marketplaceInstall(ID, '1.0.0')
    await stageMarketplace(ID, '1.1.0')
    recordSwitchSteps()
    const restore = manager.restorePackageRestart.bind(manager)
    vi.spyOn(manager, 'restorePackageRestart')
      .mockImplementationOnce(async () => { throw new Error('remount failed') })
      .mockImplementation(async (...args) => {
        order.push('restore')
        return restore(...args)
      })
    await expect(call('plugins:restart', { id: ID })).rejects.toThrow(/remount failed/)
    expect(order.indexOf('switching start')).toBeLessThan(order.indexOf('drain'))
    // The recovery remounted the old version before the end was said.
    expect(order.indexOf('restore')).toBeLessThan(order.indexOf('switching end'))
    expect(order.at(-1)).toBe('switching end')
    expect(activeVersion()).toBe('1.0.0')
  })

  it('a throwing listener changes nothing about the switch', async () => {
    await marketplaceInstall(ID, '1.0.0')
    await stageMarketplace(ID, '1.1.0')
    switchingThrows = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(call('plugins:restart', { id: ID })).resolves.toMatchObject({ id: ID, packageVersion: '1.1.0' })
    expect(activeVersion()).toBe('1.1.0')
    await expect(call('plugins:rollback', { id: ID })).resolves.toMatchObject({ id: ID, packageVersion: '1.0.0' })
    expect(activeVersion()).toBe('1.0.0')
    expect(switching.map((notice) => notice.phase)).toEqual(['start', 'end', 'start', 'end'])
    expect(warn.mock.calls.filter(([line]) => String(line).includes('switching notice'))).toHaveLength(4)
  })
})

describe('H1: view state across a switch within one source', () => {
  it('an update carries the view-state keys and nothing else', async () => {
    await marketplaceInstall(ID, '1.0.0')
    await viewStateSet('1.0.0', 'view-state:left', 'scrolled')
    await viewStateSet('1.0.0', 'view-state:left', 'tab-2', 'ws-1')
    await viewStateSet('1.0.0', 'settings', 'private')
    await marketplaceInstall(ID, '1.1.0')
    expect(carry).toHaveBeenCalledWith(ID, '1.0.0', '1.1.0')
    expect(await viewStateGet('1.1.0', 'view-state:left')).toEqual({ found: true, value: 'scrolled' })
    expect(await viewStateGet('1.1.0', 'view-state:left', 'ws-1')).toEqual({ found: true, value: 'tab-2' })
    expect(await viewStateGet('1.1.0', 'settings')).toEqual({ found: false, value: null })
  })

  it('Back to carries the view state back over the same keys, keeping the rest', async () => {
    await marketplaceInstall(ID, '1.0.0')
    await viewStateSet('1.0.0', 'view-state:left', 'old')
    await viewStateSet('1.0.0', 'settings', 'kept')
    await marketplaceInstall(ID, '1.1.0')
    await viewStateSet('1.1.0', 'view-state:left', 'newer')
    await viewStateSet('1.1.0', 'settings', 'of 1.1.0')
    await call('plugins:rollback', { id: ID })
    expect(carry).toHaveBeenLastCalledWith(ID, '1.1.0', '1.0.0')
    expect(await viewStateGet('1.0.0', 'view-state:left')).toEqual({ found: true, value: 'newer' })
    expect(await viewStateGet('1.0.0', 'settings')).toEqual({ found: true, value: 'kept' })
  })

  it('a failed copy is logged and the switch goes on', async () => {
    await marketplaceInstall(ID, '1.0.0')
    await stageMarketplace(ID, '1.1.0')
    carry.mockRejectedValueOnce(new Error('disk full'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(call('plugins:restart', { id: ID })).resolves.toMatchObject({ packageVersion: '1.1.0' })
    expect(activeVersion()).toBe('1.1.0')
    expect(warn.mock.calls.some(([line]) => String(line).includes('view state of acme.todo was not carried'))).toBe(true)
  })

  it('NEGATIVE: Marketplace to a local file carries nothing and the replaced storage stays exactly as it was', async () => {
    await marketplaceInstall(ID, '1.0.0')
    await viewStateSet('1.0.0', 'view-state:left', 'marketplace view')
    await viewStateSet('1.0.0', 'settings', 'marketplace data')
    const before = tree(join(storageRoot, pluginStorageDirName(ID)))
    await fileInstall(ID, '1.1.0', { replaceConfirmed: true })
    expect(activeVersion()).toBe('1.1.0')
    expect(carry).not.toHaveBeenCalled()
    expect(await viewStateGet('1.1.0', 'view-state:left')).toEqual({ found: false, value: null })
    // Set aside whole and untouched (D7), not handed over.
    const asideName = readdirSync(storageRoot).find((name) => name.startsWith(`${pluginStorageDirName(ID)}@set-aside-marketplace-`))
    expect(asideName).toBeDefined()
    expect(tree(join(storageRoot, asideName!))).toEqual(before)
  })

  it('NEGATIVE: a local file back to the Marketplace carries nothing', async () => {
    await fileInstall(ID, '1.0.0')
    await viewStateSet('1.0.0', 'view-state:left', 'file view')
    await marketplaceInstall(ID, '1.1.0', { replaceConfirmed: true })
    expect(activeVersion()).toBe('1.1.0')
    expect(carry).not.toHaveBeenCalled()
    expect(await viewStateGet('1.1.0', 'view-state:left')).toEqual({ found: false, value: null })
  })
})
