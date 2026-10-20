// Card K3 (DX report A1): installing a `.vsix` the user picked from a file.
// Kept apart from pluginIpc.test.ts so the Marketplace suite there stays
// exactly as it is on main; this file adds the Host dialog to its Electron
// stand-in and drives the local path end to end.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeZip, type ZipFile } from './zipFixture'
import { sha256Hex } from './pluginVerify'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import { REGISTRY_TRUST_SNAPSHOT_NAME } from './pluginInstalledTrust'
import type { InstallerTrustConfig } from './pluginInstaller'
import { backendEntryOnDisk, scanInstalledPlugins, type PluginActivationCatalogEntry } from './installedPlugins'
import { PluginCapabilityGrantStore } from './pluginCapabilityGrantStore'
import { PluginActivationSelector } from './pluginActivationSelector'
import { localTrustRecordPath } from './pluginLocalInstall'
import { verifyInstalledBackendSpawnTrust } from './pluginBackendSpawnTrust'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.2.26' },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  fsyncSync: () => {},
}))

vi.setConfig({ testTimeout: 30_000 })

import { registerPluginIpc } from './pluginIpc'
import { FrontendPluginManager } from './frontendPluginManager'

function keypair(): { pubPem: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey }
}

function signCanonical(value: unknown, privateKey: Parameters<typeof edSign>[2]): string {
  return edSign(null, Buffer.from(canonicalTrustJson(value), 'utf8'), privateKey).toString('base64')
}

const registryRoot = keypair()
const registrySigner = keypair()
const FIXED_NOW = new Date('2026-08-16T12:00:00.000Z')
const TRUST_CONFIG: InstallerTrustConfig = { pinnedRegistryRootKey: registryRoot.pubPem, now: FIXED_NOW }
const BACKEND_ENTRY_ON_DISK = backendEntryOnDisk('backend/entry')

function manifestJson(id: string, version: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id,
    name: 'Todo Scout',
    version,
    publisher: id.split('.')[0],
    permissions: {},
    marketplace: { description: 'Local test package', license: 'MIT' },
    contributes: {
      views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Todo', entry: 'frontend/left/index.html' }],
    },
    ...extra,
  })
}

/** A view package; `withBackend` adds a native backend like todo-scout's. */
function vsix(id = 'acme.todo', version = '1.0.0', options: { withBackend?: boolean; html?: string; extraFiles?: ZipFile[] } = {}): Uint8Array {
  const entry = { data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), unixMode: 0o100755 }
  return new Uint8Array(makeZip([
    {
      name: 'manifest.json',
      data: manifestJson(id, version, options.withBackend
        ? { backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup', methods: ['todo.scan'] } }
        : {}),
    },
    { name: 'frontend/left/index.html', data: options.html ?? '<!doctype html>' },
    ...(options.withBackend
      ? [
          { name: 'backend/entry', ...entry },
          ...(BACKEND_ENTRY_ON_DISK === 'backend/entry' ? [] : [{ name: BACKEND_ENTRY_ON_DISK, ...entry }]),
        ]
      : []),
    ...(options.extraFiles ?? []),
  ]))
}

/** One deflated entry whose central directory claims a small size: the
 * inflate cap, not the size field, has to stop it. */
function zipBomb(): Uint8Array {
  const name = Buffer.from('manifest.json')
  const data = deflateRawSync(Buffer.alloc(60 * 1024 * 1024, 0x20))
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }
  const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0), u32(data.length), u32(1024), u16(name.length), u16(0), name, data])
  const central = Buffer.concat([u32(0x02014b50), u16(0x0314), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0), u32(data.length), u32(1024), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0o100644 << 16), u32(0), name])
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0)])
  return new Uint8Array(Buffer.concat([local, central, eocd]))
}

function trustMetadata(blocked: Partial<Pick<RegistryTrustMetadata, 'blockedPublishers' | 'blockedPackages'>> = {}): RegistryTrustMetadata {
  return {
    schemaVersion: 1,
    registryProfile: 'official',
    rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z',
    expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [{
      keyId: 'registry-test-1',
      publicKey: registrySigner.pubPem,
      status: 'active',
      notBefore: '2026-08-01T00:00:00.000Z',
      notAfter: '2026-09-01T00:00:00.000Z',
    }],
    blockedPublishers: blocked.blockedPublishers ?? [],
    blockedPackages: blocked.blockedPackages ?? [],
  }
}

function writeTrustSnapshot(pluginsRoot: string, metadata: RegistryTrustMetadata): void {
  mkdirSync(pluginsRoot, { recursive: true })
  writeFileSync(join(pluginsRoot, REGISTRY_TRUST_SNAPSHOT_NAME), JSON.stringify({
    schemaVersion: 1,
    metadata,
    metadataSignature: signCanonical(metadata, registryRoot.privateKey),
  }))
}

/** Registry detail + download for a Marketplace install of the same id. */
function installRegistryFetch(id: string, version: string): void {
  const bytes = vsix(id, version)
  const digest = sha256Hex(bytes)
  const envelope: RegistryPackageEnvelope = {
    schemaVersion: 1,
    artifactDigest: digest,
    packageId: id,
    version,
    target: 'universal',
    publisherId: id.split('.')[0],
    keyId: 'registry-test-1',
    signedAt: '2026-08-16T11:00:00.000Z',
  }
  const metadata = trustMetadata()
  const detail = {
    latest_version: version,
    trust_metadata: metadata,
    trust_metadata_signature: signCanonical(metadata, registryRoot.privateKey),
    versions: [{
      version,
      package_digest: digest,
      target: 'universal',
      registry_envelope: envelope,
      registry_signature: signCanonical(envelope, registrySigner.privateKey),
      trust_tier: 'signed-verified',
      yanked: false,
    }],
  }
  global.fetch = vi.fn(async (url: unknown) => {
    if (String(url).endsWith('/download')) {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      return { ok: true, status: 200, arrayBuffer: async () => ab, headers: { get: (h: string) => (h.toLowerCase() === 'x-package-digest' ? digest : null) } }
    }
    return { ok: true, status: 200, json: async () => detail }
  }) as unknown as typeof fetch
}

let base = ''
let pluginsRoot = ''
let picked = ''
let pick: ReturnType<typeof vi.fn>
let forgetBackendConsent: ReturnType<typeof vi.fn>
let activations: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }>

function register(authorize: () => boolean = () => true, extra: Record<string, unknown> = {}): FrontendPluginManager {
  const manager = new FrontendPluginManager()
  registerPluginIpc(manager, pluginsRoot, authorize, TRUST_CONFIG, undefined, {
    cleanupPluginStorage: async () => undefined,
    preflightCandidateFrontend: async () => undefined,
    preflightCandidateBackend: async () => undefined,
    onActivationChange: (change) => activations.push(change),
    pickLocalPackageFile: pick,
    forgetBackendConsent,
    ...extra,
  })
  return manager
}

const call = (channel: string, args?: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} is not registered`)
  return handler(null, args)
}

async function installLocal(bytes: Uint8Array, approval: Record<string, unknown> = {}): Promise<{ id: string }> {
  writeFileSync(picked, bytes)
  const prepared = await call('plugins:installFromFile') as { id: string }
  const committed = await call('plugins:commitLocalInstall', { id: prepared.id, riskConfirmed: true, ...approval }) as { restartRequired: boolean }
  // L1: a first install is already active; an update still waits for Restart.
  if (committed.restartRequired) await call('plugins:restart', { id: prepared.id })
  return prepared
}

beforeEach(() => {
  handlers.clear()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'navide-local-install-')))
  pluginsRoot = join(base, 'plugins')
  mkdirSync(pluginsRoot)
  picked = join(base, 'picked.vsix')
  pick = vi.fn(async () => picked)
  forgetBackendConsent = vi.fn()
  activations = []
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  delete process.env['AGENT_TEAM_PLUGIN_DEV_PATH']
})

describe('plugins:installFromFile', () => {
  it('installs a view + native backend package: the view is granted, the backend waits for its own consent', async () => {
    register()
    writeFileSync(picked, vsix('acme.todo', '1.0.0', { withBackend: true }))
    const prepared = await call('plugins:installFromFile', { path: '/somewhere/else.vsix' }) as Record<string, unknown>
    expect(prepared).toMatchObject({
      id: 'acme.todo',
      version: '1.0.0',
      source: 'local-unsigned',
      trustTier: 'unsigned',
      containsBackendExecutable: true,
      requiresRiskConfirmation: true,
      scan: null,
    })
    expect(prepared).not.toHaveProperty('replaces')
    // Nothing is written before consent.
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')).toBeNull()
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo' })).rejects.toThrow(/consent is required/)
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')).toBeNull()
    // L1: active as soon as it is approved.
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true })).resolves.toMatchObject({ restartRequired: false, activatedVersion: '1.0.0' })
    // A committed prepare is spent: committing again needs the file again.
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true })).rejects.toThrow(/no prepared local install/)
    await call('plugins:restart', { id: 'acme.todo' })

    expect(new PluginCapabilityGrantStore(pluginsRoot).get('acme.todo', '1.0.0')).toMatchObject({ packageVersion: '1.0.0', storage: true })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.todo', source: 'local-unsigned' }])
    expect(call('plugins:listInstalled')).not.toMatchObject([{ provenance: 'official-registry' }])
    const activation = activations.at(-1)?.activation
    expect(activation).toMatchObject({ pluginId: 'acme.todo', source: 'local-unsigned' })
    expect(activation?.provenance).toBeUndefined()
    expect(activation?.backend).toBeDefined()
    // The consent record covers the installed copy, beside the plugins root.
    expect(existsSync(localTrustRecordPath(pluginsRoot, 'acme.todo'))).toBe(true)
    expect(localTrustRecordPath(pluginsRoot, 'acme.todo').startsWith(pluginsRoot)).toBe(false)
    // The installed backend passes the Host spawn-trust seam as a local
    // package, and is refused once one byte of it changes; the native backend
    // consent itself is the unchanged admission gate after this.
    const backendInfo = { pluginId: 'acme.todo', packageVersion: '1.0.0', packageDir: activation!.packageDir }
    const context = { pluginsRoot: () => pluginsRoot, currentRegistryTrust: () => ({ pinnedRootKey: registryRoot.pubPem, snapshot: null, now: FIXED_NOW }) }
    expect(() => verifyInstalledBackendSpawnTrust(backendInfo, context)).not.toThrow()
    writeFileSync(join(activation!.packageDir, 'frontend', 'left', 'index.html'), '<!doctype htmL>')
    expect(() => verifyInstalledBackendSpawnTrust(backendInfo, context)).toThrow(/trust verification failed/)
  })

  it('reloads a local install on the next start and refuses it once its files change', async () => {
      register()
      await installLocal(vsix())
      const trust = { pinnedRootKey: registryRoot.pubPem, snapshot: null, now: FIXED_NOW }
      const restarted = new FrontendPluginManager()
      const load = restarted.loadInstalledPlugins(pluginsRoot, { provenance: 'official-registry', trust })
      expect(load.errors).toEqual([])
      expect(restarted.listInstalledPackages()).toMatchObject([{ id: 'acme.todo', source: 'local-unsigned' }])
      const dir = new PluginActivationSelector(pluginsRoot)
      const record = dir.read('acme.todo')!
      writeFileSync(join(dir.packageDir('acme.todo', record.active!), 'frontend', 'left', 'extra.js'), 'run()')
      const tampered = new FrontendPluginManager().loadInstalledPlugins(pluginsRoot, { provenance: 'official-registry', trust })
      expect(tampered.errors.join('\n')).toMatch(/LOCAL_CONTENT_MODIFIED/)
      expect(tampered.loaded).toEqual([])
  })

  it.each([
    ['a ../ path', () => vsix('acme.todo', '1.0.0', { extraFiles: [{ name: '../escape.js', data: 'x' }] }), /unsafe archive entry/],
    ['a symlink', () => vsix('acme.todo', '1.0.0', { extraFiles: [{ name: 'frontend/link', data: '/etc/passwd', kind: 'symlink' }] }), /regular file or directory/],
    ['a zip bomb', zipBomb, /exceeds the 52428800-byte limit/],
  ])('refuses a package with %s, writing nothing', async (_label, build, message) => {
    register()
    writeFileSync(picked, build())
    await expect(call('plugins:installFromFile')).rejects.toThrow(message)
    expect(existsSync(join(pluginsRoot, 'acme.todo'))).toBe(false)
  })

  it('installs the bytes read right after the dialog, not what the file holds at commit (TOCTOU)', async () => {
    register()
    writeFileSync(picked, vsix('acme.todo', '1.0.0', { html: '<p>the reviewed copy</p>' }))
    await call('plugins:installFromFile')
    writeFileSync(picked, vsix('acme.todo', '1.0.0', { html: '<script>swapped()</script>' }))
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true })
    const selector = new PluginActivationSelector(pluginsRoot)
    // L1: the approved copy is the active one.
    const installed = selector.packageDir('acme.todo', selector.read('acme.todo')!.active!)
    expect(readFileSync(join(installed, 'frontend', 'left', 'index.html'), 'utf8')).toBe('<p>the reviewed copy</p>')
    expect(pick).toHaveBeenCalledTimes(1)
  })

  it('refuses the reserved navide. namespace', async () => {
    register()
    writeFileSync(picked, vsix('navide.git', '9.9.9'))
    await expect(call('plugins:installFromFile')).rejects.toThrow(/official 'navide\.' namespace/)
  })

  it('refuses a taken-down publisher or package id, even from an expired root-signed list', async () => {
    register()
    writeTrustSnapshot(pluginsRoot, { ...trustMetadata({ blockedPublishers: ['acme'] }), expiresAt: '2026-08-16T11:00:00.000Z' })
    writeFileSync(picked, vsix())
    await expect(call('plugins:installFromFile')).rejects.toThrow(/taken down by Navide/)
    writeTrustSnapshot(pluginsRoot, trustMetadata({ blockedPackages: [{ packageId: 'acme.todo' }] }))
    await expect(call('plugins:installFromFile')).rejects.toThrow(/taken down by Navide/)
    // A list the pinned root did not sign is no takedown source.
    const unsigned = trustMetadata({ blockedPublishers: ['acme'] })
    writeFileSync(join(pluginsRoot, REGISTRY_TRUST_SNAPSHOT_NAME), JSON.stringify({
      schemaVersion: 1, metadata: unsigned, metadataSignature: signCanonical(unsigned, keypair().privateKey),
    }))
    await expect(call('plugins:installFromFile')).resolves.toMatchObject({ id: 'acme.todo' })
  })

  it('does not replace an installed package unasked; replacing clears its grant and backend consent, and keeps the file version to go back to (L4)', async () => {
    register()
    await installLocal(vsix('acme.todo', '1.0.0'))
    writeFileSync(picked, vsix('acme.todo', '2.0.0'))
    expect(await call('plugins:installFromFile')).toMatchObject({ replaces: { version: '1.0.0', source: 'local-unsigned' } })
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true })).rejects.toThrow(/requires confirmation/)
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')?.candidate).toBeUndefined()

    await call('plugins:installFromFile')
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true })
    await call('plugins:restart', { id: 'acme.todo' })
    const record = new PluginActivationSelector(pluginsRoot).read('acme.todo')!
    expect(record.active?.packageVersion).toBe('2.0.0')
    // L4 (D7 decided 2026-10-20): the replaced file version is kept as the
    // rollback target, and going back to it asks for consent again.
    expect(record.previous?.packageVersion).toBe('1.0.0')
    expect(new PluginCapabilityGrantStore(pluginsRoot).get('acme.todo', '1.0.0')).toBeNull()
    expect(forgetBackendConsent).toHaveBeenCalledWith('acme.todo')
    expect(call('plugins:listInstalled')).toMatchObject([{
      id: 'acme.todo',
      packageVersion: '2.0.0',
      rollbackKind: 'previous',
      rollbackToVersion: '1.0.0',
      rollbackNeedsConsent: true,
    }])
  })

  it('replaces a Marketplace install only when asked, and keeps none of its consent', async () => {
    register()
    installRegistryFetch('acme.todo', '1.0.0')
    await call('plugins:prepareInstall', { namespace: 'acme', name: 'todo' })
    await call('plugins:commitInstall', { id: 'acme.todo', publisherConfirmed: true, riskConfirmed: true })
    await call('plugins:restart', { id: 'acme.todo' })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.todo', source: 'marketplace' }])

    writeFileSync(picked, vsix('acme.todo', '1.1.0-local'))
    expect(await call('plugins:installFromFile')).toMatchObject({ replaces: { version: '1.0.0', source: 'marketplace' } })
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true })).rejects.toThrow(/requires confirmation/)
    await call('plugins:installFromFile')
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true })
    await call('plugins:restart', { id: 'acme.todo' })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.todo', packageVersion: '1.1.0-local', source: 'local-unsigned' }])
    const record = new PluginActivationSelector(pluginsRoot).read('acme.todo')!
    expect(record.previous).toBeUndefined()
    expect(record.previousGrant).toBeUndefined()
    expect(new PluginCapabilityGrantStore(pluginsRoot).get('acme.todo', '1.0.0')).toBeNull()
    expect(forgetBackendConsent).toHaveBeenCalledWith('acme.todo')

    // Back to the Marketplace version: asked first, and the local record goes.
    installRegistryFetch('acme.todo', '1.2.0')
    expect(await call('plugins:prepareInstall', { namespace: 'acme', name: 'todo' })).toMatchObject({ replacesLocal: { version: '1.1.0-local' } })
    await expect(call('plugins:commitInstall', { id: 'acme.todo', publisherConfirmed: true, riskConfirmed: true })).rejects.toThrow(/requires confirmation/)
    await call('plugins:prepareInstall', { namespace: 'acme', name: 'todo' })
    await call('plugins:commitInstall', { id: 'acme.todo', publisherConfirmed: true, riskConfirmed: true, replaceConfirmed: true })
    await call('plugins:restart', { id: 'acme.todo' })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.todo', packageVersion: '1.2.0', source: 'marketplace' }])
    expect(existsSync(localTrustRecordPath(pluginsRoot, 'acme.todo'))).toBe(false)
  })

  it('never offers a local install an automatic update', async () => {
    register()
    await installLocal(vsix('acme.todo', '1.0.0'))
    global.fetch = vi.fn() as unknown as typeof fetch
    expect(await call('plugins:checkUpdates')).toEqual([])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('removes the consent record with the package', async () => {
    register()
    await installLocal(vsix())
    await call('plugins:remove', { id: 'acme.todo' })
    expect(existsSync(localTrustRecordPath(pluginsRoot, 'acme.todo'))).toBe(false)
    expect(call('plugins:listInstalled')).toEqual([])
  })
})

describe('entry points that must not install from a file', () => {
  it('refuses a plugin frame (any sender the Host does not trust) before any dialog opens', async () => {
    register(() => false)
    await expect(call('plugins:installFromFile')).rejects.toThrow(/unauthorized plugin management request/)
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true })).rejects.toThrow(/unauthorized/)
    expect(pick).not.toHaveBeenCalled()
  })

  it('ignores any path a caller sends and reads only what the Host dialog returns', async () => {
    register()
    pick.mockResolvedValueOnce(null)
    writeFileSync(join(base, 'renderer-named.vsix'), vsix())
    expect(await call('plugins:installFromFile', { path: join(base, 'renderer-named.vsix') })).toBeNull()
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true })).rejects.toThrow(/no prepared local install/)
  })

  it('reads no environment variable: without the Host dialog there is no file install', async () => {
    writeFileSync(join(base, 'env.vsix'), vsix())
    process.env['AGENT_TEAM_PLUGIN_DEV_PATH'] = join(base, 'env.vsix')
    register(() => true, { pickLocalPackageFile: undefined })
    await expect(call('plugins:installFromFile')).rejects.toThrow(/unavailable/)
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')).toBeNull()
  })

  it('cannot commit a Registry prepare as a local install, nor a local prepare as a Registry install', async () => {
    register()
    writeFileSync(picked, vsix())
    await call('plugins:installFromFile')
    await expect(call('plugins:commitInstall', { id: 'acme.todo', riskConfirmed: true })).rejects.toThrow(/no prepared install/)
  })
})

describe('a first install the user did not restart, on the next launch', () => {
  /** The Host after a relaunch: a fresh manager over the same plugins root. */
  function relaunch() {
    handlers.clear()
    const manager = new FrontendPluginManager()
    const controller = registerPluginIpc(manager, pluginsRoot, () => true, TRUST_CONFIG, undefined, {
      cleanupPluginStorage: async () => undefined,
      preflightCandidateFrontend: async () => undefined,
      preflightCandidateBackend: async () => undefined,
      onActivationChange: (change) => activations.push(change),
      pickLocalPackageFile: pick,
      forgetBackendConsent,
    })
    return { manager, controller }
  }

  /** A first install left staged: since L1 that happens only when the
   * activation on approval failed (or the App went away before it ran). */
  async function stageLocal(bytes: Uint8Array): Promise<void> {
    let failOnce = true
    register(() => true, {
      onActivationChange: (change: { pluginId: string; activation?: PluginActivationCatalogEntry }) => {
        if (failOnce && change.activation) {
          failOnce = false
          throw new Error('the App went away before the activation finished')
        }
        activations.push(change)
      },
    })
    writeFileSync(picked, bytes)
    await call('plugins:installFromFile')
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true })
  }

  it('is not reported as a broken package by the startup scan', async () => {
    await stageLocal(vsix())
    const scanned = scanInstalledPlugins(pluginsRoot)
    expect(scanned.filter((entry) => entry.error)).toEqual([])
  })

  it('is activated exactly as Restart would have done it', async () => {
    await stageLocal(vsix('acme.todo', '1.0.0', { withBackend: true }))
    const { controller } = relaunch()
    expect(await controller.activateStagedFirstInstalls()).toEqual([])

    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')).toMatchObject({
      active: { packageVersion: '1.0.0' },
    })
    // Promoted, so nothing is left waiting beside it.
    expect(controller.stagedUpdates()).toEqual([])
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')?.candidate).toBeUndefined()
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.todo', source: 'local-unsigned' }])
    expect(call('plugins:listInstalled')).not.toMatchObject([{ pendingCandidateVersion: '1.0.0' }])
    expect(new PluginCapabilityGrantStore(pluginsRoot).get('acme.todo', '1.0.0')).toMatchObject({ packageVersion: '1.0.0', storage: true })
    expect(activations.at(-1)?.activation).toMatchObject({ pluginId: 'acme.todo', source: 'local-unsigned' })
    // The launch after that loads it like any active package.
    relaunch()
    expect(scanInstalledPlugins(pluginsRoot)).toMatchObject([{ activation: { pluginId: 'acme.todo', packageVersion: '1.0.0' } }])
  })

  it('leaves an update staged next to the active package for the user to restart', async () => {
    register()
    await installLocal(vsix('acme.todo', '1.0.0'))
    writeFileSync(picked, vsix('acme.todo', '1.1.0'))
    await call('plugins:installFromFile')
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true })
    const { controller } = relaunch()

    expect(await controller.activateStagedFirstInstalls()).toEqual([])
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')).toMatchObject({
      active: { packageVersion: '1.0.0' },
      candidate: { packageVersion: '1.1.0' },
    })
    // Disclosed, for the main window to offer "Apply now".
    expect(controller.stagedUpdates()).toEqual([{ pluginId: 'acme.todo', activeVersion: '1.0.0', stagedVersion: '1.1.0' }])
  })

  it('reports a candidate that can no longer be activated and keeps it staged', async () => {
    await stageLocal(vsix())
    const selector = new PluginActivationSelector(pluginsRoot)
    const candidateDir = selector.packageDir('acme.todo', selector.read('acme.todo')!.candidate!)
    writeFileSync(join(candidateDir, 'frontend', 'left', 'index.html'), '<!doctype htmL>')
    const { controller } = relaunch()

    const failures = await controller.activateStagedFirstInstalls()
    expect(failures).toMatchObject([{ pluginId: 'acme.todo', version: '1.0.0' }])
    expect(failures[0]!.reason).toMatch(/quarantined/)
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')).toMatchObject({ candidate: { packageVersion: '1.0.0' } })
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')?.active).toBeUndefined()
  })
})

describe('L1: a first install takes effect when the user approves it', () => {
  it('is active right after the commit, with no Restart and no relaunch', async () => {
    register()
    writeFileSync(picked, vsix('acme.todo', '1.0.0', { withBackend: true }))
    await call('plugins:installFromFile')
    const committed = await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true }) as Record<string, unknown>

    expect(committed).toMatchObject({ id: 'acme.todo', restartRequired: false, activatedVersion: '1.0.0' })
    expect(committed).not.toHaveProperty('activationError')
    const record = new PluginActivationSelector(pluginsRoot).read('acme.todo')
    expect(record?.active?.packageVersion).toBe('1.0.0')
    expect(record?.candidate).toBeUndefined()
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.todo', source: 'local-unsigned' }])
    expect(call('plugins:listInstalled')).not.toMatchObject([{ pendingCandidateVersion: '1.0.0' }])
    expect(new PluginCapabilityGrantStore(pluginsRoot).get('acme.todo', '1.0.0')).toMatchObject({ packageVersion: '1.0.0', storage: true })
    // The backend is registered for the Host's own admission gate, which still
    // asks for the native backend consent before it ever starts.
    expect(activations.at(-1)?.activation).toMatchObject({ pluginId: 'acme.todo', source: 'local-unsigned' })
    expect(activations.at(-1)?.activation?.backend).toBeDefined()
  })

  it('stays staged with Restart and Discard, and says why, when the activation fails', async () => {
    let failOnce = true
    register(() => true, {
      onActivationChange: (change: { pluginId: string; activation?: PluginActivationCatalogEntry }) => {
        if (failOnce && change.activation) {
          failOnce = false
          throw new Error('activation refused for the test')
        }
        activations.push(change)
      },
    })
    writeFileSync(picked, vsix())
    await call('plugins:installFromFile')
    const committed = await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true }) as Record<string, unknown>

    expect(committed).toMatchObject({ id: 'acme.todo', restartRequired: true })
    expect(String(committed.activationError)).toMatch(/activation refused for the test/)
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')).toMatchObject({ candidate: { packageVersion: '1.0.0' } })
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')?.active).toBeUndefined()
    // Restart still works once the cause is gone.
    await call('plugins:restart', { id: 'acme.todo' })
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')?.active?.packageVersion).toBe('1.0.0')
  })

  it('leaves an update from a file for Restart', async () => {
    register()
    await installLocal(vsix('acme.todo', '1.0.0'))
    writeFileSync(picked, vsix('acme.todo', '1.1.0'))
    await call('plugins:installFromFile')
    const committed = await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true }) as Record<string, unknown>

    expect(committed).toMatchObject({ restartRequired: true })
    expect(committed).not.toHaveProperty('activatedVersion')
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')).toMatchObject({
      active: { packageVersion: '1.0.0' },
      candidate: { packageVersion: '1.1.0' },
    })
  })
})

describe('L3: every version switch is reported for the record', () => {
  it('reports an update switched by Restart, naming both versions and the source, but not a first install', async () => {
    const onPackageSwitched = vi.fn()
    register(() => true, { onPackageSwitched })
    await installLocal(vsix('acme.todo', '1.0.0'))
    expect(onPackageSwitched).not.toHaveBeenCalled()

    writeFileSync(picked, vsix('acme.todo', '1.1.0'))
    await call('plugins:installFromFile')
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true })
    await call('plugins:restart', { id: 'acme.todo' })

    expect(onPackageSwitched).toHaveBeenCalledTimes(1)
    expect(onPackageSwitched).toHaveBeenCalledWith({
      pluginId: 'acme.todo',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      source: 'local-unsigned',
      at: expect.any(Number),
    })
  })

  it('keeps the switch when reporting it throws', async () => {
    register(() => true, { onPackageSwitched: () => { throw new Error('no window') } })
    await installLocal(vsix('acme.todo', '1.0.0'))
    writeFileSync(picked, vsix('acme.todo', '1.1.0'))
    await call('plugins:installFromFile')
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true })
    await call('plugins:restart', { id: 'acme.todo' })
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')?.active?.packageVersion).toBe('1.1.0')
  })
})

describe('L4: a file update keeps the replaced file version to go back to', () => {
  async function updateFromFile(): Promise<void> {
    register()
    await installLocal(vsix('acme.todo', '1.0.0', { withBackend: true }))
    writeFileSync(picked, vsix('acme.todo', '1.1.0', { withBackend: true }))
    await call('plugins:installFromFile')
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true })
    await call('plugins:restart', { id: 'acme.todo' })
  }

  it('refuses to go back without renewed consent, and changes nothing', async () => {
    await updateFromFile()
    await expect(call('plugins:rollback', { id: 'acme.todo' })).rejects.toThrow(/ROLLBACK_CONSENT_REQUIRED \[acme\.todo\]/)
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')).toMatchObject({
      active: { packageVersion: '1.1.0' },
      previous: { packageVersion: '1.0.0' },
    })
  })

  it('goes back with renewed consent: the kept version runs, its backend asks again, the newer one stays staged', async () => {
    await updateFromFile()
    forgetBackendConsent.mockClear()
    await expect(call('plugins:rollback', { id: 'acme.todo', consentConfirmed: true })).resolves.toMatchObject({
      id: 'acme.todo',
      packageVersion: '1.0.0',
    })
    const record = new PluginActivationSelector(pluginsRoot).read('acme.todo')!
    expect(record.active?.packageVersion).toBe('1.0.0')
    expect(record.candidate?.packageVersion).toBe('1.1.0')
    expect(forgetBackendConsent).toHaveBeenCalledWith('acme.todo')
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.todo', packageVersion: '1.0.0', source: 'local-unsigned' }])
    // The consent records follow the selector: the running version's is active.
    expect(JSON.parse(readFileSync(localTrustRecordPath(pluginsRoot, 'acme.todo'), 'utf8')).version).toBe('1.0.0')
    expect(JSON.parse(readFileSync(localTrustRecordPath(pluginsRoot, 'acme.todo', 'candidate'), 'utf8')).version).toBe('1.1.0')
  })

  it('keeps the way back when a file switch fails and is applied again (review M1)', async () => {
    const version = (role: 'active' | 'candidate' | 'previous') => {
      const path = localTrustRecordPath(pluginsRoot, 'acme.todo', role)
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : null
    }
    let failOnce = true
    register(() => true, {
      onActivationChange: (change: { pluginId: string; activation?: PluginActivationCatalogEntry }) => {
        if (failOnce && change.activation?.packageVersion === '1.1.0') {
          failOnce = false
          throw new Error('the switch failed for the test')
        }
        activations.push(change)
      },
    })
    await installLocal(vsix('acme.todo', '1.0.0'))
    writeFileSync(picked, vsix('acme.todo', '1.1.0'))
    await call('plugins:installFromFile')
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true })
    await expect(call('plugins:restart', { id: 'acme.todo' })).rejects.toThrow(/the switch failed for the test/)

    // Failed: 1.0.0 runs again and the records are as before the switch.
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')).toMatchObject({
      active: { packageVersion: '1.0.0' },
      candidate: { packageVersion: '1.1.0' },
    })
    expect({ a: version('active'), c: version('candidate'), p: version('previous') }).toEqual({ a: '1.0.0', c: '1.1.0', p: null })

    // Applied again: 1.1.0 runs and 1.0.0 is still the kept version.
    await call('plugins:restart', { id: 'acme.todo' })
    expect({ a: version('active'), c: version('candidate'), p: version('previous') }).toEqual({ a: '1.1.0', c: null, p: '1.0.0' })
    expect(call('plugins:listInstalled')).toMatchObject([{ rollbackToVersion: '1.0.0', rollbackNeedsConsent: true }])
    await expect(call('plugins:rollback', { id: 'acme.todo', consentConfirmed: true })).resolves.toMatchObject({ packageVersion: '1.0.0' })
  })

  it('removes every kept consent record with the plugin', async () => {
    await updateFromFile()
    await call('plugins:remove', { id: 'acme.todo' })
    for (const role of ['active', 'candidate', 'previous'] as const) {
      expect(existsSync(localTrustRecordPath(pluginsRoot, 'acme.todo', role))).toBe(false)
    }
  })

  it('still keeps nothing to go back to when a file replaces a Marketplace install (D7)', async () => {
    register()
    installRegistryFetch('acme.todo', '1.0.0')
    await call('plugins:prepareInstall', { namespace: 'acme', name: 'todo' })
    await call('plugins:commitInstall', { id: 'acme.todo', publisherConfirmed: true, riskConfirmed: true })
    writeFileSync(picked, vsix('acme.todo', '1.1.0-local'))
    await call('plugins:installFromFile')
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true })
    await call('plugins:restart', { id: 'acme.todo' })
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')?.previous).toBeUndefined()
  })
})
