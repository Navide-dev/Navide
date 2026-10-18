// End-to-end coverage for the `plugins:prepareInstall` IPC handler, focused on
// the wire → verifier hand-off: the registry detail API speaks snake_case
// (`public_key` at the detail top level, `signature` on each version row) and
// `prepareInstall` takes camelCase (`publicKey`, `signature`). This proves the
// mapping is wired so a validly-signed package actually reaches
// `signed-verified`, a tampered/rotated signature hard-blocks, and missing
// material remains `unsigned` only on the legacy v1 compatibility path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto'
import { backendCallAddress } from './pluginActivity'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { sha256Hex } from './pluginVerify'
import { registryRootFingerprint } from './pluginRegistryRootApproval'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
  readRegistryTrustSnapshot,
  registryReceiptFromEvidence,
  discoverInstalledRegistryPackageIds,
  verifyInstalledRegistryPackage,
  type InstalledTrustDecision,
} from './pluginInstalledTrust'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import { defaultInstallerDeps, type InstallerTrustConfig } from './pluginInstaller'
import { backendEntryOnDisk, type PluginActivationCatalogEntry } from './installedPlugins'
import { projectBackendPluginActivationCatalog } from './pluginBackendActivationCatalog'
import { makeZip } from './zipFixture'
import { canonicalContractJson, computeDisclosure } from '../../shared/pluginDisclosure'
import { readZipEntries } from './pluginPackage'
import { PluginInstallScanStore } from './pluginInstallScanStore'
import { PluginCapabilityGrantStore } from './pluginCapabilityGrantStore'
import { PluginPackStore } from './pluginPackStore'
import { PluginDisabledStore } from './pluginDisabledStore'
import { PluginDisableSourceStore } from './pluginDisableSource'
import { PluginPublisherTrustStore } from './pluginPublisherTrust'
import { PluginPrereleaseStore } from './pluginPrereleaseStore'
import { immutablePluginPackageDir, PluginActivationSelector } from './pluginActivationSelector'

const { handlers, browserWindowFromWebContents } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  browserWindowFromWebContents: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.2.13' },
  BrowserWindow: { fromWebContents: browserWindowFromWebContents },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

// The install/commit/restart flows here fsync ~20 times per test. None of these
// tests can observe durability, and a real flush is the one filesystem call
// whose latency spikes on a contended CI disk: on the shared Windows runner a
// burst of slow flushes pushed a 150ms test past the 5s timeout. Only the flush
// is stubbed; the O_RDWR open/close around it still run, so the Windows
// handle-mode behaviour in fsSync stays covered.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  fsyncSync: () => {},
}))

// With the flush stubbed, the lifecycle tests still make up to ~235 real
// mutating filesystem calls each (mkdir, write, rename, rm, open/close), with
// no timers, spawns or other waits: <=650ms locally, <=503ms on a green
// Windows run. On a stalled Windows runner disk those calls have run at up to
// ~62ms each (97 calls took 6038ms), which puts the heaviest test near 15s.
// A hung transaction still fails at 30s.
vi.setConfig({ testTimeout: 30_000 })

import { app as electronApp } from 'electron'
import {
  MARKETPLACE_ICON_MAX_BYTES,
  OFFICIAL_MARKETPLACE_URL,
  declaredForActivity,
  isTrustedPluginManagementSender,
  registerPluginIpc,
  resolveConfiguredMarketplace,
} from './pluginIpc'
import { FrontendPluginManager } from './frontendPluginManager'

function buildPkg(
  packageId = 'acme.demo',
  publisherId = 'acme',
  permissions: Record<string, unknown> = {},
  version = '1.0.0',
  manifestExtra: Record<string, unknown> = {}
): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    ...manifestExtra,
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: packageId,
    name: 'Demo',
    version,
    publisher: publisherId,
    permissions,
    marketplace: { description: 'Demo frontend', license: 'MIT' },
    contributes: {
      views: [
        {
          id: 'left',
          kind: 'custom',
          location: 'left',
          title: 'Demo',
          entry: 'frontend/left/index.html',
        },
      ],
    },
  })
  const zip = makeZip([
    { name: 'manifest.json', data: manifest },
    { name: 'frontend/left/index.html', data: '<!doctype html>' },
  ])
  const bytes = new Uint8Array(zip)
  return { bytes, digest: sha256Hex(bytes) }
}

function buildReservedPkg(): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'navide.spoof',
    name: 'Spoof',
    version: '1.0.0',
    publisher: 'navide',
    permissions: {},
    marketplace: { description: 'Reserved namespace spoof', license: 'MIT' },
    contributes: {
      views: [
        {
          id: 'left',
          kind: 'custom',
          location: 'left',
          title: 'Spoof',
          entry: 'frontend/left/index.html',
        },
      ],
    },
  })
  const bytes = new Uint8Array(
    makeZip([
      { name: 'manifest.json', data: manifest },
      { name: 'frontend/left/index.html', data: '<!doctype html>' },
    ])
  )
  return { bytes, digest: sha256Hex(bytes) }
}

// The manifest names its backend entry in wire form (`backend/entry`); on
// disk the Host looks for the platform's executable beside it, which on a
// Windows host is `backend/entry.exe`. The fixture ships both so the
// installer's wire check and the on-disk check pass on whichever host runs it.
const BACKEND_ENTRY_ON_DISK = backendEntryOnDisk('backend/entry')

function buildBackendPkg(
  version = '1.0.0',
  backendFields: Record<string, unknown> = {}
): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.demo',
    name: 'Demo',
    version,
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'Demo backend', license: 'MIT' },
    backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup', ...backendFields },
  })
  const entry = { data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), unixMode: 0o100755 }
  const zip = makeZip([
    { name: 'manifest.json', data: manifest },
    { name: 'backend/entry', ...entry },
    ...(BACKEND_ENTRY_ON_DISK === 'backend/entry' ? [] : [{ name: BACKEND_ENTRY_ON_DISK, ...entry }]),
  ])
  const bytes = new Uint8Array(zip)
  return { bytes, digest: sha256Hex(bytes) }
}

function buildLegacyPkg(requires: string[] = [], version = '1.0.0'): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    id: 'acme.demo',
    version,
    publisher: 'acme',
    requires,
    entry: 'dist/main.js',
  })
  const bytes = new Uint8Array(
    makeZip([
      { name: 'manifest.json', data: manifest },
      { name: 'dist/main.js', data: 'console.log("demo")' },
    ])
  )
  return { bytes, digest: sha256Hex(bytes) }
}

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
const TRUST_CONFIG: InstallerTrustConfig = {
  pinnedRegistryRootKey: registryRoot.pubPem,
  now: FIXED_NOW,
}

/** Test-only stand-ins for the Host-owned restricted preflight adapters. */
const TEST_PREFLIGHT_OPTIONS = {
  preflightCandidateFrontend: async () => undefined,
  preflightCandidateBackend: async () => undefined,
}

/** Detail JSON as the central-signing registry serialises it. */
interface WireDetail {
  latest_version: string | null
  trust_metadata: RegistryTrustMetadata
  trust_metadata_signature: string
  versions: Array<{
    version: string
    package_digest: string
    target: string
    registry_envelope: RegistryPackageEnvelope
    registry_signature: string | null
    trust_tier: string
    yanked: boolean
  }>
}

function signedDetail(
  digest: string,
  packageId = 'acme.demo',
  publisherId = 'acme',
  version = '1.0.0'
): WireDetail {
  const registryEnvelope: RegistryPackageEnvelope = {
    schemaVersion: 1,
    artifactDigest: digest,
    packageId,
    version,
    target: 'universal',
    publisherId,
    keyId: 'registry-test-1',
    signedAt: '2026-08-16T11:00:00.000Z',
  }
  const trustMetadata: RegistryTrustMetadata = {
    schemaVersion: 1,
    registryProfile: 'official',
    rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z',
    expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [
      {
        keyId: 'registry-test-1',
        publicKey: registrySigner.pubPem,
        status: 'active',
        notBefore: '2026-08-01T00:00:00.000Z',
        notAfter: '2026-09-01T00:00:00.000Z',
      },
    ],
    blockedPublishers: [],
    blockedPackages: [],
  }
  return {
    latest_version: version,
    trust_metadata: trustMetadata,
    trust_metadata_signature: signCanonical(trustMetadata, registryRoot.privateKey),
    versions: [
      {
        version,
        package_digest: digest,
        target: 'universal',
        registry_envelope: registryEnvelope,
        registry_signature: signCanonical(registryEnvelope, registrySigner.privateKey),
        trust_tier: 'signed-verified',
        yanked: false,
      },
    ],
  }
}

/** A fetch that serves the detail endpoint and the package download from a
 *  single fixed package + detail body, routing by URL suffix. */
function installFetch(detail: WireDetail, bytes: Uint8Array, digest: string): void {
  global.fetch = vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.endsWith('/download')) {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return ab
        },
        headers: { get: (h: string) => (h.toLowerCase() === 'x-package-digest' ? digest : null) },
      }
    }
    return { ok: true, status: 200, async json() { return detail } }
  }) as unknown as typeof fetch
}

function register(
  pluginsRoot = '/plugins',
  manager = new FrontendPluginManager()
): (...a: unknown[]) => unknown {
  registerPluginIpc(manager, pluginsRoot, () => true, TRUST_CONFIG, undefined, {
    cleanupPluginStorage: async () => undefined,
    ...TEST_PREFLIGHT_OPTIONS,
  })
  const handler = handlers.get('plugins:prepareInstall')
  if (!handler) throw new Error('prepareInstall handler not registered')
  return handler
}

async function installRegistryEvidence(
  root: string,
  bytes: Uint8Array,
  digest: string,
  detail = signedDetail(digest),
  namespace = 'acme',
  name = 'demo'
): Promise<void> {
  installFetch(detail, bytes, digest)
  const manager = new FrontendPluginManager()
  registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
    ...TEST_PREFLIGHT_OPTIONS,
  })
  const prepareHandler = handlers.get('plugins:prepareInstall')
  const commitHandler = handlers.get('plugins:commitInstall')
  const restartHandler = handlers.get('plugins:restart')
  if (!prepareHandler || !commitHandler || !restartHandler) throw new Error('install handlers not registered')
  await prepareHandler(null, { namespace, name })
  await commitHandler(null, { id: `${namespace}.${name}`, publisherConfirmed: true })
  await restartHandler(null, { id: `${namespace}.${name}` })
  expect(discoverInstalledRegistryPackageIds(root)).toContain(`${namespace}.${name}`)
  manager.removeInstalledPlugin(`${namespace}.${name}`)
  handlers.clear()
}

function writeExpiredTrustSnapshot(root: string): void {
  const detail = signedDetail('0'.repeat(64))
  const metadata: RegistryTrustMetadata = {
    ...detail.trust_metadata,
    generatedAt: '2026-08-14T10:00:00.000Z',
    expiresAt: '2026-08-15T10:00:00.000Z',
  }
  writeFileSync(
    join(root, '.navide-registry-trust.json'),
    JSON.stringify({
      schemaVersion: 1,
      metadata,
      metadataSignature: signCanonical(metadata, registryRoot.privateKey),
    })
  )
}

describe('plugin management sender authorization', () => {
  beforeEach(() => {
    handlers.clear()
    browserWindowFromWebContents.mockReset()
  })

  it('accepts only a live trusted Host top-level window', () => {
    const sender = {}
    const trustedWindow = { isDestroyed: () => false, webContents: sender }
    const trustedWindows = new Set([trustedWindow])
    browserWindowFromWebContents.mockReturnValue(trustedWindow)

    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(true)

    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: {} } } as never,
        trustedWindows as never
      )
    ).toBe(false)

    const pluginSender = {}
    browserWindowFromWebContents.mockReturnValue(trustedWindow)
    expect(
      isTrustedPluginManagementSender(
        { sender: pluginSender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(false)

    browserWindowFromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(false)

    browserWindowFromWebContents.mockReturnValue({ isDestroyed: () => true, webContents: sender })
    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(false)

    browserWindowFromWebContents.mockReturnValue(null)
    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(false)
  })

  it('projects sanitized manifest icons without exposing Host file paths', () => {
    const resolveContributionIcon = vi.fn((iconFile: string) =>
      iconFile.endsWith('primary.png')
        ? { url: 'data:image/png;base64,AAAA', monochrome: true }
        : null
    )
    const manager = {
      listContributionCatalog: () => [
        {
          pluginId: 'acme.tools',
          packageVersion: '1.2.3',
          contributionKey: 'acme.tools.secondary',
          title: 'Secondary',
          iconFile: null,
          kind: 'custom',
          location: 'right',
          manifestOrder: 0,
        },
        {
          pluginId: 'acme.tools',
          packageVersion: '1.2.3',
          contributionKey: 'acme.tools.primary',
          title: 'Primary',
          iconFile: '/plugins/acme.tools/icons/primary.png',
          kind: 'custom',
          location: 'left',
          manifestOrder: 1,
        },
      ],
      listInstalledPackages: () => [],
    } as unknown as FrontendPluginManager
    registerPluginIpc(manager, '/plugins', () => true, undefined, undefined, {
      resolveContributionIcon,
    })

    const handler = handlers.get('plugins:listContributions')
    if (!handler) throw new Error('contribution catalog handler not registered')
    const projected = handler(null) as Array<Record<string, unknown>>
    expect(projected).toEqual([
      {
        pluginId: 'acme.tools',
        packageVersion: '1.2.3',
        contributionKey: 'acme.tools.secondary',
        title: 'Secondary',
        icon: null,
        iconMonochrome: false,
        kind: 'custom',
        location: 'right',
        manifestOrder: 0,
      },
      {
        pluginId: 'acme.tools',
        packageVersion: '1.2.3',
        contributionKey: 'acme.tools.primary',
        title: 'Primary',
        icon: 'data:image/png;base64,AAAA',
        iconMonochrome: true,
        kind: 'custom',
        location: 'left',
        manifestOrder: 1,
      },
    ])
    expect(resolveContributionIcon).toHaveBeenCalledOnce()
    expect(resolveContributionIcon).toHaveBeenCalledWith(
      '/plugins/acme.tools/icons/primary.png'
    )
    expect(projected[1]).not.toHaveProperty('iconFile')
  })

  it('rejects unauthorized senders on every plugins channel before side effects', async () => {
    const manager = {
      listDescriptors: vi.fn(),
      listInstalledPackages: vi.fn(),
      registerDescriptor: vi.fn(),
      registerInstalledPackage: vi.fn(),
      removeInstalledPlugin: vi.fn(),
    } as unknown as FrontendPluginManager
    const authorize = vi.fn(() => false)
    const fetchBefore = global.fetch
    global.fetch = vi.fn() as unknown as typeof fetch
    registerPluginIpc(manager, '/plugins', authorize)

    const calls: Array<[string, unknown]> = [
      ['plugins:listInstalled', undefined],
      ['plugins:listContributions', undefined],
      ['plugins:marketplaceSearch', 'demo'],
      ['plugins:prepareInstall', { namespace: 'acme', name: 'demo' }],
      ['plugins:commitInstall', { id: 'acme.demo', confirmed: true }],
      ['plugins:remove', { id: 'acme.demo' }],
      ['plugins:setDisabled', { id: 'acme.demo', disabled: true }],
    ]
    try {
      for (const [channel, args] of calls) {
        const handler = handlers.get(channel)
        if (!handler) throw new Error(`${channel} handler not registered`)
        await expect(
          Promise.resolve().then(() => handler({ unauthorized: true }, args))
        ).rejects.toThrow(/unauthorized plugin management request/)
      }
      expect(authorize).toHaveBeenCalledTimes(calls.length)
      expect(global.fetch).not.toHaveBeenCalled()
      expect(manager.listDescriptors).not.toHaveBeenCalled()
      expect(manager.listInstalledPackages).not.toHaveBeenCalled()
      expect(manager.registerDescriptor).not.toHaveBeenCalled()
      expect(manager.registerInstalledPackage).not.toHaveBeenCalled()
      expect(manager.removeInstalledPlugin).not.toHaveBeenCalled()
    } finally {
      global.fetch = fetchBefore
    }
  })
})

describe('plugins:remove boundary validation', () => {
  beforeEach(() => handlers.clear())

  it('rejects malformed ids before deleting or changing activation state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-invalid-'))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(join(installedDir, 'keep.txt'), 'keep')
    const manager = new FrontendPluginManager()
    const removeInstalledPlugin = vi.spyOn(manager, 'removeInstalledPlugin')
    const onActivationChange = vi.fn()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      const invalidIds: unknown[] = [
        '',
        '.',
        '..',
        '/',
        '\\',
        '../acme.demo',
        '..\\acme.demo',
        '/tmp/acme.demo',
        'acme.demo/..',
        'acme.%2e',
        '%2e%2e',
        'Acme.demo',
        'acme',
        'acme..demo',
        'acme.demo.',
        null,
        42,
      ]
      for (const id of invalidIds) {
        await expect(removeHandler(null, { id })).rejects.toThrow(/invalid plugin id/)
      }
      await expect(removeHandler(null, null)).rejects.toThrow(/invalid plugin id/)
      expect(existsSync(installedDir)).toBe(true)
      expect(removeInstalledPlugin).not.toHaveBeenCalled()
      expect(onActivationChange).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('forgets the removed plugin\'s activity first-seen rows, and only after a removal succeeds (D-e L4)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-forget-'))
    mkdirSync(join(root, 'acme.demo'), { recursive: true })
    mkdirSync(join(root, 'acme.kept'), { recursive: true })
    const manager = new FrontendPluginManager()
    vi.spyOn(manager, 'preparePluginRemoval').mockImplementation(() => {})
    vi.spyOn(manager, 'removeInstalledPlugin').mockImplementation(() => {})
    const forget = vi.spyOn(manager, 'forgetPluginActivity').mockImplementation(() => {})
    let failCleanup = false
    const cleanupPluginStorage = vi.fn(async () => {
      if (failCleanup) throw new Error('storage busy')
    })
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, { cleanupPluginStorage })
      const removeHandler = handlers.get('plugins:remove')!
      failCleanup = true
      await expect(removeHandler(null, { id: 'acme.kept' })).rejects.toThrow(/storage busy/)
      expect(forget).not.toHaveBeenCalled()
      failCleanup = false
      await expect(removeHandler(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true })
      expect(forget).toHaveBeenCalledExactlyOnceWith('acme.demo')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes a valid direct-child id and clears its activation state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-valid-'))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir, { recursive: true })
    const manager = new FrontendPluginManager()
    const order: string[] = []
    vi.spyOn(manager, 'preparePluginRemoval').mockImplementation(() => {
      order.push('stop')
    })
    const removeInstalledPlugin = vi
      .spyOn(manager, 'removeInstalledPlugin')
      .mockImplementation(() => {
        order.push('remove')
      })
    const cleanupPluginStorage = vi.fn(async () => {
      order.push('cleanup')
    })
    const onActivationChange = vi.fn()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage,
        onActivationChange,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      await expect(removeHandler(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true })
      expect(existsSync(installedDir)).toBe(false)
      expect(removeInstalledPlugin).toHaveBeenCalledWith('acme.demo')
      expect(order).toEqual(['stop', 'cleanup', 'remove'])
      expect(onActivationChange).toHaveBeenCalledWith({ pluginId: 'acme.demo' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records factory removal without restoring its builtin descriptor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-factory-'))
    const manager = new FrontendPluginManager()
    const removeInstalledPlugin = vi
      .spyOn(manager, 'removeInstalledPlugin')
      .mockImplementation(() => undefined)
    const onFactoryPackageRemoved = vi.fn()
    try {
      // The generic factory path; the built-ins themselves are never removed.
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage: vi.fn(async () => undefined),
        factoryPackageIds: ['acme.factory'],
        onFactoryPackageRemoved,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      await expect(removeHandler(null, { id: 'acme.factory' })).resolves.toEqual({ ok: true })
      expect(onFactoryPackageRemoved).toHaveBeenCalledWith('acme.factory')
      expect(removeInstalledPlugin).toHaveBeenCalledWith('acme.factory', {
        restoreBuiltin: false,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores an opted-out factory package through the Host lifecycle callback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-restore-factory-'))
    const manager = new FrontendPluginManager()
    const restoreFactoryPackage = vi.fn(async () => undefined)
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        restoreFactoryPackage,
        listFactoryPackages: () => [
          { id: 'acme.factory', version: '0.1.0', active: false, optedOut: true },
        ],
      })
      const listHandler = handlers.get('plugins:listFactoryPackages')
      const restoreHandler = handlers.get('plugins:restoreFactoryPackage')
      if (!listHandler || !restoreHandler) throw new Error('factory handlers not registered')

      expect(listHandler(null)).toEqual([
        { id: 'acme.factory', version: '0.1.0', active: false, optedOut: true },
      ])
      await expect(restoreHandler(null, { id: 'acme.factory' })).resolves.toEqual({ ok: true })
      expect(restoreFactoryPackage).toHaveBeenCalledWith('acme.factory')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('discloses current and peak in-flight backend calls to an authorized renderer only', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-backend-concurrency-'))
    const manager = new FrontendPluginManager()
    const concurrency = [{ pluginId: 'navide.plans', current: 3, peak: 512, droppedNotifications: 7 }]
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        backendCallConcurrency: () => concurrency,
      })
      const handler = handlers.get('plugins:backendCallConcurrency')
      if (!handler) throw new Error('concurrency handler not registered')
      expect(handler(null)).toEqual(concurrency)

      registerPluginIpc(manager, root, () => false, TRUST_CONFIG, undefined, {
        backendCallConcurrency: () => concurrency,
      })
      expect(() => handlers.get('plugins:backendCallConcurrency')?.(null)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('discloses backend resource usage to an authorized renderer only', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-backend-usage-'))
    const manager = new FrontendPluginManager()
    const usage = {
      children: { current: 2, peak: 40, retained: 0 },
      views: [],
      plugins: [{ pluginId: 'navide.plans', current: 0, peak: 9, droppedNotifications: 0 }],
    }
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, { backendResourceUsage: () => usage })
      const handler = handlers.get('plugins:backendResourceUsage')
      if (!handler) throw new Error('usage handler not registered')
      expect(handler(null)).toEqual(usage)

      registerPluginIpc(manager, root, () => false, TRUST_CONFIG, undefined, { backendResourceUsage: () => usage })
      expect(() => handlers.get('plugins:backendResourceUsage')?.(null)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses uninstall when storage cleanup is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-no-storage-cleanup-'))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir, { recursive: true })
    const manager = new FrontendPluginManager()
    const preparePluginRemoval = vi.spyOn(manager, 'preparePluginRemoval')
    const removeInstalledPlugin = vi.spyOn(manager, 'removeInstalledPlugin')
    const onActivationChange = vi.fn()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      await expect(removeHandler(null, { id: 'acme.demo' })).rejects.toThrow(
        'plugin storage cleanup is unavailable'
      )
      expect(existsSync(installedDir)).toBe(true)
      expect(preparePluginRemoval).not.toHaveBeenCalled()
      expect(removeInstalledPlugin).not.toHaveBeenCalled()
      expect(onActivationChange).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores the approved backend registration after storage cleanup fails', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-remove-backend-')))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir)
    const manager = new FrontendPluginManager()
    manager.registerDescriptor({
      id: 'acme.demo', packageVersion: '1.0.0', packageDir: installedDir,
      requires: [], devUrl: '', entryFile: join(installedDir, 'index.html'),
    })
    const backend = {
      pluginId: 'acme.demo', packageVersion: '1.0.0', packageDir: installedDir,
      entryFile: join(installedDir, 'backend'), protocolVersion: 1 as const,
      activation: 'startup' as const, approvedMethods: ['fixture.echo'], approvedEvents: [],
    }
    manager.registerBackendActivation(backend)
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage: async () => { throw new Error('storage unavailable') },
      })
      await expect(handlers.get('plugins:remove')!(null, { id: 'acme.demo' }))
        .rejects.toThrow('storage unavailable')
      expect(manager.getBackendActivation('acme.demo', '1.0.0')).toEqual(backend)
      expect(existsSync(installedDir)).toBe(true)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('drops the capability grant when package removal fails after storage cleanup', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-remove-grant-')))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir, { recursive: true })
    const grants = new PluginCapabilityGrantStore(root)
    grants.set('acme.demo', {
      packageVersion: '1.0.0',
      system: ['fs', 'ui', 'aiCli'],
      shell: 'allowlist',
      storage: true,
    })
    const manager = new FrontendPluginManager()
    vi.spyOn(manager, 'removeInstalledPlugin').mockImplementation(() => undefined)
    const rmrf = vi.spyOn(defaultInstallerDeps, 'rmrf').mockImplementation(() => {
      throw new Error('test package removal failure')
    })
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage: async () => undefined,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      // Storage is already wiped here, so a package left behind by a failed
      // directory removal must not keep a usable grant.
      await expect(removeHandler(null, { id: 'acme.demo' })).rejects.toThrow(
        'test package removal failure'
      )
      expect(grants.get('acme.demo', '1.0.0')).toBeNull()
      expect(existsSync(installedDir)).toBe(true)
    } finally {
      rmrf.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('makes a reinstall after removal ask for capability consent again', async () => {
    const { bytes, digest } = buildPkg('acme.demo', 'acme', { shell: 'full' })
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-reinstall-consent-'))
    const manager = new FrontendPluginManager()
    const cleanupPluginStorage = vi.fn(async () => undefined)
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage,
        ...TEST_PREFLIGHT_OPTIONS,
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const remove = handlers.get('plugins:remove')!
      const grants = new PluginCapabilityGrantStore(root)

      installFetch(signedDetail(digest), bytes, digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      expect(grants.get('acme.demo', '1.0.0')).toMatchObject({ shell: 'full', highRiskShellConfirmed: true })

      await expect(remove(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true })
      expect(cleanupPluginStorage).toHaveBeenCalledWith('acme.demo')
      expect(grants.get('acme.demo', '1.0.0')).toBeNull()
      expect(new PluginActivationSelector(root).read('acme.demo')).toBeNull()
      expect(existsSync(join(root, 'acme.demo'))).toBe(false)

      // The same version again: nothing from the first install may stand in
      // for the user's answer.
      installFetch(signedDetail(digest), bytes, digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await expect(commit(null, { id: 'acme.demo', publisherConfirmed: true })).rejects.toThrow(
        /capability and backend risk confirmation/
      )
      expect(grants.get('acme.demo', '1.0.0')).toBeNull()
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      expect(grants.get('acme.demo', '1.0.0')).toBeNull()
      await restart(null, { id: 'acme.demo' })
      expect(grants.get('acme.demo', '1.0.0')).toMatchObject({ shell: 'full', highRiskShellConfirmed: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the package installed when storage cleanup fails and permits retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-storage-failure-'))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir, { recursive: true })
    const manager = new FrontendPluginManager()
    const preparePluginRemoval = vi.spyOn(manager, 'preparePluginRemoval')
    const removeInstalledPlugin = vi
      .spyOn(manager, 'removeInstalledPlugin')
      .mockImplementation(() => undefined)
    const cleanupPluginStorage = vi
      .fn<(pluginId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValue(undefined)
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      await expect(removeHandler(null, { id: 'acme.demo' })).rejects.toThrow('storage unavailable')
      expect(existsSync(installedDir)).toBe(true)
      expect(preparePluginRemoval).toHaveBeenCalledWith('acme.demo')
      expect(removeInstalledPlugin).not.toHaveBeenCalled()

      await expect(removeHandler(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true })
      expect(existsSync(installedDir)).toBe(false)
      expect(preparePluginRemoval).toHaveBeenCalledTimes(2)
      expect(removeInstalledPlugin).toHaveBeenCalledWith('acme.demo')
      expect(cleanupPluginStorage).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('plugins:prepareInstall wire → verifier mapping', () => {
  const savedFetch = global.fetch
  const savedMarketplaceUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
  const savedRootApprovalFile = process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE']
  beforeEach(() => handlers.clear())
  afterEach(() => {
    global.fetch = savedFetch
    if (savedMarketplaceUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    else process.env['AGENT_TEAM_MARKETPLACE_URL'] = savedMarketplaceUrl
    if (savedRootApprovalFile === undefined) {
      delete process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE']
    } else {
      process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = savedRootApprovalFile
    }
    vi.restoreAllMocks()
  })

  it('rejects an unapproved custom Registry before making a network request', async () => {
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://registry.acme.test'
    delete process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE']
    global.fetch = vi.fn() as unknown as typeof fetch
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true)
    const handler = handlers.get('plugins:prepareInstall')
    if (!handler) throw new Error('prepareInstall handler not registered')

    await expect(handler(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      /explicit root approval/
    )
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('uses a separately approved custom Registry root instead of response metadata', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    installFetch(detail, bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-custom-registry-'))
    const approvalFile = join(root, 'root-approval.json')
    writeFileSync(
      approvalFile,
      JSON.stringify({
        schemaVersion: 1,
        registryUrl: 'https://registry.acme.test',
        rootPublicKeyPem: registryRoot.pubPem,
        confirmedFingerprint: registryRootFingerprint(registryRoot.pubPem),
      })
    )
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://registry.acme.test'
    process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = approvalFile
    try {
      registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG)
      const handler = handlers.get('plugins:prepareInstall')
      if (!handler) throw new Error('prepareInstall handler not registered')
      await expect(handler(null, { namespace: 'acme', name: 'demo' })).resolves.toMatchObject({
        trustTier: 'signed-verified',
        requiresPublisherTrust: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** Sign the contract 3.5 disclosure envelope onto every version row. */
  function withDisclosure(detail: WireDetail, manifest: Record<string, unknown>, scanBody?: Record<string, unknown>): WireDetail {
    const disclosure = computeDisclosure(manifest as never)
    const rows = detail.versions.map((row) => {
      const scan = scanBody
        ? { ...scanBody, artifactDigest: row.registry_envelope.artifactDigest, target: row.registry_envelope.target }
        : null
      const envelope = {
        schemaVersion: 1,
        artifactDigest: row.registry_envelope.artifactDigest,
        packageId: row.registry_envelope.packageId,
        version: row.registry_envelope.version,
        target: row.registry_envelope.target,
        keyId: row.registry_envelope.keyId,
        signedAt: row.registry_envelope.signedAt,
        disclosureDigest: createHash('sha256').update(canonicalContractJson(disclosure), 'utf8').digest('hex'),
        scanDigest: scan ? createHash('sha256').update(canonicalContractJson(scan), 'utf8').digest('hex') : null,
      }
      return {
        ...row,
        disclosure,
        disclosure_envelope: envelope,
        disclosure_signature: signCanonical(envelope, registrySigner.privateKey),
        scan,
        registry: { review: { status: 'not-required', reviewedAt: null, nativeCodeInspected: null } },
      }
    })
    return { ...detail, versions: rows }
  }

  async function prepareFromApprovedRegistry(detail: WireDetail, bytes: Uint8Array, digest: string): Promise<unknown> {
    installFetch(detail, bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-disclosure-registry-'))
    const approvalFile = join(root, 'root-approval.json')
    writeFileSync(approvalFile, JSON.stringify({
      schemaVersion: 1,
      registryUrl: 'https://registry.acme.test',
      rootPublicKeyPem: registryRoot.pubPem,
      confirmedFingerprint: registryRootFingerprint(registryRoot.pubPem),
    }))
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://registry.acme.test'
    process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = approvalFile
    try {
      registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG)
      const handler = handlers.get('plugins:prepareInstall')
      if (!handler) throw new Error('prepareInstall handler not registered')
      return await handler(null, { namespace: 'acme', name: 'demo' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  const DISCLOSED_PERMISSIONS = { system: ['fs'], scopes: { fs: { root: 'workspace', read: ['README.md'] } } }
  const disclosedManifest = {
    schemaVersion: 2, id: 'acme.demo', version: '1.0.0', publisher: 'acme', permissions: DISCLOSED_PERMISSIONS,
  }

  it('carries the signed disclosure, scan and registry facts through prepareInstall', async () => {
    const { bytes, digest } = buildPkg('acme.demo', 'acme', DISCLOSED_PERMISSIONS)
    await expect(prepareFromApprovedRegistry(withDisclosure(signedDetail(digest), disclosedManifest), bytes, digest))
      .resolves.toMatchObject({
        disclosure: computeDisclosure(disclosedManifest as never),
        scan: null,
        registry: { review: { status: 'not-required' } },
      })
  })

  it('D-f: records the install-time scan, notes a rescan that found new items once, and forgets it on remove', async () => {
    const scanCases = (JSON.parse(readFileSync(join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/scan-cases.json'), 'utf8')) as {
      cases: Array<{ name: string; scan: Record<string, unknown> }>
    }).cases
    const scanNamed = (name: string) => scanCases.find((entry) => entry.name === name)!.scan
    const { bytes, digest } = buildPkg('acme.demo', 'acme', DISCLOSED_PERMISSIONS)
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-rescan-'))
    const manager = new FrontendPluginManager()
    try {
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        cleanupPluginStorage: async () => undefined,
      })
      installFetch(withDisclosure(signedDetail(digest), disclosedManifest, scanNamed('nothing-found')), bytes, digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      const file = join(root, '.navide-install-scans.json')
      expect(JSON.parse(readFileSync(file, 'utf8')).plugins['acme.demo']['1.0.0'].scan.scanner.id).toBe('navide-static-scan')

      // The same answer the update check already fetches; nothing new yet.
      await controller.checkUpdates()
      expect(controller.takeRescanNotices()).toEqual([])

      installFetch(withDisclosure(signedDetail(digest), disclosedManifest, scanNamed('ui-only-runs-git-push-undeclared')), bytes, digest)
      const fetchCount = () => vi.mocked(global.fetch).mock.calls.length
      await controller.checkUpdates()
      const requests = fetchCount()
      const [notice] = controller.takeRescanNotices()
      expect(notice).toMatchObject({ id: 'acme.demo', version: '1.0.0' })
      expect(notice.added.length).toBeGreaterThan(0)
      // No request of its own: one detail fetch per check, as before.
      expect(requests).toBe(1)
      await controller.checkUpdates()
      expect(controller.takeRescanNotices()).toEqual([])
      // A notice no window received is put back for the next publish.
      controller.restoreRescanNotices([notice])
      expect(controller.takeRescanNotices()).toEqual([notice])

      await handlers.get('plugins:remove')!(null, { id: 'acme.demo' })
      expect(JSON.parse(readFileSync(file, 'utf8')).plugins['acme.demo']).toBeUndefined()
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses the install when the signed disclosure does not match the package (DISCLOSURE_MISMATCH)', async () => {
    const { bytes, digest } = buildPkg('acme.demo', 'acme', DISCLOSED_PERMISSIONS)
    const narrower = { ...disclosedManifest, permissions: {} }
    await expect(prepareFromApprovedRegistry(withDisclosure(signedDetail(digest), narrower), bytes, digest))
      .rejects.toMatchObject({ code: 'DISCLOSURE_MISMATCH' })
  })

  it('installs a version without disclosure fields as before', async () => {
    const { bytes, digest } = buildPkg('acme.demo', 'acme', DISCLOSED_PERMISSIONS)
    await expect(prepareFromApprovedRegistry(signedDetail(digest), bytes, digest))
      .resolves.toMatchObject({ trustTier: 'signed-verified', disclosure: null, scan: null, registry: null })
  })

  it('uses an approved self-hosted root for the default local Registry profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-local-registry-'))
    const approvalFile = join(root, 'root-approval.json')
    writeFileSync(
      approvalFile,
      JSON.stringify({
        schemaVersion: 1,
        registryUrl: 'http://localhost:8787',
        rootPublicKeyPem: registryRoot.pubPem,
        confirmedFingerprint: registryRootFingerprint(registryRoot.pubPem),
      })
    )
    delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = approvalFile

    try {
      expect(resolveConfiguredMarketplace()).toMatchObject({
        registryUrl: 'http://localhost:8787',
        trust: { pinnedRegistryRootKey: registryRoot.pubPem },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('loads the Official Registry root from packaged resources, not runtime approval', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-packaged-root-'))
    const resources = join(root, 'resources')
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'official-registry-root.pem'), registryRoot.pubPem)
    const approvalFile = join(root, 'root-approval.json')
    writeFileSync(
      approvalFile,
      JSON.stringify({
        schemaVersion: 1,
        registryUrl: 'https://server.navide.dev/registry',
        rootPublicKeyPem: registrySigner.pubPem,
        confirmedFingerprint: registryRootFingerprint(registrySigner.pubPem),
      })
    )
    const previousResourcesDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'resourcesPath'
    )
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: root,
    })
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
    process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = approvalFile
    try {
      expect(resolveConfiguredMarketplace()).toMatchObject({
        registryUrl: 'https://server.navide.dev/registry',
        trust: {
          pinnedRegistryRootKey: registryRoot.pubPem,
          registryAuthority: 'official',
        },
      })
    } finally {
      if (previousResourcesDescriptor) {
        Object.defineProperty(process, 'resourcesPath', previousResourcesDescriptor)
      } else {
        Reflect.deleteProperty(process, 'resourcesPath')
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('defaults a packaged App to the Official Registry and a dev App to localhost', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-packaged-default-'))
    const resources = join(root, 'resources')
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'official-registry-root.pem'), registryRoot.pubPem)
    const previousResourcesDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'resourcesPath'
    )
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: root,
    })
    delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    delete process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE']
    const mutableApp = electronApp as { isPackaged: boolean }
    try {
      mutableApp.isPackaged = true
      expect(resolveConfiguredMarketplace()).toMatchObject({
        registryUrl: OFFICIAL_MARKETPLACE_URL,
        trust: {
          pinnedRegistryRootKey: registryRoot.pubPem,
          registryAuthority: 'official',
          officialRegistryUrl: 'https://server.navide.dev/registry',
        },
      })
      mutableApp.isPackaged = false
      // The development default is a self-hosted Registry and never inherits
      // the packaged Official root.
      expect(() => resolveConfiguredMarketplace()).toThrow(/root approval file/)
    } finally {
      mutableApp.isPackaged = false
      if (previousResourcesDescriptor) {
        Object.defineProperty(process, 'resourcesPath', previousResourcesDescriptor)
      } else {
        Reflect.deleteProperty(process, 'resourcesPath')
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the Registry path prefix when searching the marketplace', async () => {
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry/'
    const fetchMock = vi.fn(async (_url: unknown) => ({
      ok: true,
      status: 200,
      async json() {
        return { items: [] }
      },
    }))
    global.fetch = fetchMock as unknown as typeof fetch
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG)
    const handler = handlers.get('plugins:marketplaceSearch')
    if (!handler) throw new Error('marketplaceSearch handler not registered')
    await handler(null, 'git')
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://server.navide.dev/registry/api/extensions?q=git'
    )
  })

  it('fetches detail and download under the Registry path prefix', async () => {
    const { bytes, digest } = buildPkg()
    installFetch(signedDetail(digest), bytes, digest)
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
    await register()(null, { namespace: 'acme', name: 'demo' })
    const urls = vi.mocked(global.fetch).mock.calls.map((call) => String(call[0]))
    expect(urls).toEqual([
      'https://server.navide.dev/registry/api/extensions/acme/demo',
      'https://server.navide.dev/registry/api/extensions/acme/demo/1.0.0/download',
    ])
  })

  /** The same version published once per platform: each row signs its target. */
  function perTargetDetail(digest: string, targets: string[]): WireDetail {
    const base = signedDetail(digest)
    const versions = targets.map((target) => {
      const registryEnvelope = { ...base.versions[0].registry_envelope, target }
      return {
        ...base.versions[0],
        target,
        registry_envelope: registryEnvelope,
        registry_signature: signCanonical(registryEnvelope, registrySigner.privateKey),
      }
    })
    return { ...base, versions }
  }

  function registerForHost(expectedTarget: string): (...a: unknown[]) => unknown {
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, {
      ...TRUST_CONFIG,
      expectedTarget,
    })
    const handler = handlers.get('plugins:prepareInstall')
    if (!handler) throw new Error('prepareInstall handler not registered')
    return handler
  }

  it("downloads the Host platform's artifact when a version has several targets", async () => {
    const { bytes, digest } = buildPkg()
    const detail = perTargetDetail(digest, ['darwin-arm64', 'win32-x64'])
    global.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes('/download')) {
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        return { ok: true, status: 200, arrayBuffer: async () => ab, headers: { get: () => digest } }
      }
      return { ok: true, status: 200, json: async () => detail }
    }) as unknown as typeof fetch
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'

    const result = (await registerForHost('win32-x64')(null, { namespace: 'acme', name: 'demo' })) as {
      id: string
    }

    expect(result.id).toBe('acme.demo')
    expect(vi.mocked(global.fetch).mock.calls.map((call) => String(call[0]))).toEqual([
      'https://server.navide.dev/registry/api/extensions/acme/demo',
      'https://server.navide.dev/registry/api/extensions/acme/demo/1.0.0/download?target=win32-x64',
    ])
  })

  it('names the available targets and downloads nothing when none fits the Host', async () => {
    const { digest } = buildPkg()
    const detail = perTargetDetail(digest, ['darwin-arm64', 'linux-x64'])
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => detail })) as unknown as typeof fetch
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'

    await expect(
      registerForHost('win32-x64')(null, { namespace: 'acme', name: 'demo' })
    ).rejects.toThrow(
      "version 1.0.0 has no artifact for host target 'win32-x64' (available: darwin-arm64, linux-x64)"
    )
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('still rejects a row whose signed envelope names another target', async () => {
    const { bytes, digest } = buildPkg()
    const detail = perTargetDetail(digest, ['darwin-arm64'])
    // The row claims the Host target, but the Registry signed darwin-arm64.
    detail.versions[0].target = 'win32-x64'
    global.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes('/download')) {
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        return { ok: true, status: 200, arrayBuffer: async () => ab, headers: { get: () => digest } }
      }
      return { ok: true, status: 200, json: async () => detail }
    }) as unknown as typeof fetch
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'

    await expect(
      registerForHost('win32-x64')(null, { namespace: 'acme', name: 'demo' })
    ).rejects.toThrow(/registry envelope target does not match/)
  })

  it('does not activate a self-hosted reserved package after restart', () => {
    const { bytes, digest } = buildReservedPkg()
    const detail = signedDetail(digest, 'navide.spoof', 'navide')
    const root = mkdtempSync(join(tmpdir(), 'navide-reserved-restart-'))
    const pluginDir = join(root, 'navide.spoof')
    mkdirSync(join(pluginDir, 'frontend', 'left'), { recursive: true })
    writeFileSync(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        apiVersion: '^1.0.0',
        id: 'navide.spoof',
        name: 'Spoof',
        version: '1.0.0',
        publisher: 'navide',
        permissions: {},
        marketplace: { description: 'Reserved namespace spoof', license: 'MIT' },
        contributes: {
          views: [
            {
              id: 'left',
              kind: 'custom',
              location: 'left',
              title: 'Spoof',
              entry: 'frontend/left/index.html',
            },
          ],
        },
      })
    )
    writeFileSync(join(pluginDir, 'frontend', 'left', 'index.html'), '<!doctype html>')
    writeFileSync(join(pluginDir, REGISTRY_ARTIFACT_NAME), bytes)
    writeFileSync(
      join(pluginDir, REGISTRY_RECEIPT_NAME),
      JSON.stringify(
        registryReceiptFromEvidence({
          packageId: 'navide.spoof',
          version: '1.0.0',
          publisherId: 'navide',
          target: 'universal',
          artifactDigest: digest,
          envelope: detail.versions[0].registry_envelope,
          envelopeSignature: detail.versions[0].registry_signature ?? '',
          registryAuthority: 'self-hosted',
        })
      )
    )
    writeFileSync(
      join(root, REGISTRY_TRUST_SNAPSHOT_NAME),
      JSON.stringify({
        schemaVersion: 1,
        metadata: detail.trust_metadata,
        metadataSignature: detail.trust_metadata_signature,
      })
    )
    try {
      const manager = new FrontendPluginManager()
      const loaded = manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          registryAuthority: 'self-hosted',
          officialRegistryUrl: 'https://server.navide.dev/registry',
          now: FIXED_NOW,
        },
      })
      expect(loaded.loaded).toEqual([])
      expect(loaded.activationCatalog).toEqual([])
      expect(loaded.errors.join(' ')).toMatch(/App-authorized Official Registry/)
      expect(manager.listInstalledPackages()).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('(a) verifies the root-authorized Registry envelope → signed-verified', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    installFetch(detail, bytes, digest)
    const res = (await register()(null, { namespace: 'acme', name: 'demo' })) as {
      trustTier: string
    }
    expect(res.trustTier).toBe('signed-verified')
  })

  it('(b) a forged Registry signature hard-blocks without downgrade', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    detail.versions[0].registry_signature = signCanonical(
      { ...detail.versions[0].registry_envelope, artifactDigest: 'deadbeef'.repeat(8) },
      registrySigner.privateKey
    )
    installFetch(detail, bytes, digest)
    await expect(register()(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      /signature/i
    )
  })

  it('(c) missing Registry signing material fails closed for v2', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    detail.versions[0].registry_signature = null
    installFetch(detail, bytes, digest)
    await expect(register()(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      /missing Registry signatures/i
    )
  })

  it('ignores arbitrary publisher key material when the Registry chain is valid', async () => {
    const { bytes, digest } = buildPkg()
    const detail = Object.assign(signedDetail(digest), { public_key: keypair().pubPem })
    Object.assign(detail.versions[0], { signature: 'attacker-controlled' })
    installFetch(detail, bytes, digest)
    const result = (await register()(null, { namespace: 'acme', name: 'demo' })) as {
      trustTier: string
    }
    expect(result.trustTier).toBe('signed-verified')
  })

  it('requires an explicit commit confirmation for a backend package', async () => {
    const { bytes, digest } = buildBackendPkg()
    const detail = signedDetail(digest)
    installFetch(detail, bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-'))
    try {
      const manager = new FrontendPluginManager()
      const prepareHandler = register(root, manager)
      const prepared = (await prepareHandler(null, {
        namespace: 'acme',
        name: 'demo',
      })) as {
        containsBackendExecutable: boolean
        requiresConfirmation: boolean
      }
      expect(prepared.containsBackendExecutable).toBe(true)
      expect(prepared.requiresConfirmation).toBe(true)

      const commitHandler = handlers.get('plugins:commitInstall')
      if (!commitHandler) throw new Error('commitInstall handler not registered')
      await expect(commitHandler(null, { id: 'acme.demo' })).rejects.toThrow(
        /publisher trust confirmation/
      )
      await expect(
        commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).rejects.toThrow(/capability and backend risk confirmation/)
      expect(
        await commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({
        id: 'acme.demo',
        requires: [],
        restartRequired: true,
      })
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal') + '/backend/entry')).toBe(true)

      const restartHandler = handlers.get('plugins:restart')
      if (!restartHandler) throw new Error('restart handler not registered')
      await expect(restartHandler(null, { id: 'acme.demo' })).resolves.toMatchObject({
        id: 'acme.demo',
        packageVersion: '1.0.0',
      })

    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('hands the declared agent tools to the trust dialog, and nothing when none are declared', async () => {
    const write = {
      name: 'demo_set', method: 'demo.set', risk: 'write', title: 'Set', description: 'Set the demo value.',
      timeoutMs: 5000, inputSchema: { type: 'object' },
    }
    const read = { name: 'demo_get', method: 'demo.get', risk: 'read', title: 'Get', description: 'Get it.', inputSchema: { type: 'object' } }
    const withTools = buildBackendPkg('1.0.0', { methods: ['demo.get', 'demo.set'], agentTools: [write, read] })
    installFetch(signedDetail(withTools.digest), withTools.bytes, withTools.digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-agent-tools-'))
    try {
      const prepared = (await register(root, new FrontendPluginManager())(null, { namespace: 'acme', name: 'demo' })) as {
        agentTools?: Array<{ name: string; timeoutMs: number }>
        requiresRiskConfirmation: boolean
      }
      expect(prepared.agentTools).toEqual([
        { ...read, timeoutMs: 30000 },
        write,
      ])
      expect(prepared.requiresRiskConfirmation).toBe(true)

      const plain = buildBackendPkg('1.0.0', { methods: ['demo.get'] })
      installFetch(signedDetail(plain.digest), plain.bytes, plain.digest)
      const without = (await register(root, new FrontendPluginManager())(null, { namespace: 'acme', name: 'demo' })) as object
      expect(without).not.toHaveProperty('agentTools')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses at prepareInstall a package whose agent tools break a contract rule', async () => {
    const bad = buildBackendPkg('1.0.0', {
      methods: ['demo.get'],
      agentTools: [{ name: 'other_get', method: 'demo.get', risk: 'read', title: 'Get', description: 'Get it.', inputSchema: { type: 'object' } }],
    })
    installFetch(signedDetail(bad.digest), bad.bytes, bad.digest)
    await expect(register()(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(/AGENT_TOOL_PREFIX_MISMATCH/)
  })

  it('records full-shell approval only after explicit risk confirmation', async () => {
    const { bytes, digest } = buildPkg('acme.demo', 'acme', { shell: 'full' })
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-full-shell-'))
    try {
      const manager = new FrontendPluginManager()
      const prepareHandler = register(root, manager)
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!commitHandler) throw new Error('commitInstall handler not registered')

      await expect(commitHandler(null, {
        id: 'acme.demo',
        publisherConfirmed: true,
      })).rejects.toThrow(/capability and backend risk confirmation/)

      await commitHandler(null, {
        id: 'acme.demo',
        publisherConfirmed: true,
        riskConfirmed: true,
      })
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')).toBeNull()
      const restartHandler = handlers.get('plugins:restart')
      if (!restartHandler) throw new Error('restart handler not registered')
      await restartHandler(null, { id: 'acme.demo' })
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')).toMatchObject({
        shell: 'full',
        highRiskShellConfirmed: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps B full-shell consent version-bound across rollback and a fresh selector reload', async () => {
    const first = buildPkg('acme.demo', 'acme', { shell: 'full' }, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', { shell: 'full' }, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-full-shell-rollback-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')!

      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })

      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.1')).toMatchObject({
        packageVersion: '1.0.1',
        shell: 'full',
        highRiskShellConfirmed: true,
      })

      await expect(rollback(null, { id: 'acme.demo' })).resolves.toMatchObject({ packageVersion: '1.0.0' })
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0', artifactDigest: first.digest },
        candidate: { packageVersion: '1.0.1', artifactDigest: second.digest },
      })

      const reloaded = new PluginActivationSelector(root)
      expect(reloaded.read('acme.demo')?.candidate).toEqual({
        packageVersion: '1.0.1', target: 'universal', artifactDigest: second.digest,
      })
      await expect(restart(null, { id: 'acme.demo' })).resolves.toMatchObject({ packageVersion: '1.0.1' })
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.1')).toMatchObject({
        packageVersion: '1.0.1',
        shell: 'full',
        highRiskShellConfirmed: true,
      })
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.2')).toBeNull()
      expect(new PluginActivationSelector(root).read('acme.demo')?.active).not.toEqual({
        ...second,
        packageVersion: '1.0.2',
      })
      expect(new PluginActivationSelector(root).read('acme.demo')?.active).not.toEqual({
        ...second,
        artifactDigest: 'c'.repeat(64),
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // User ruling 2026-10-17 (D-d option B): an update asks exactly as on main;
  // the diff is shown, never used to skip the confirmation.
  it('D-d: an update that adds nothing still asks for the risk confirmation, as on main, and reports the diff', async () => {
    const first = buildPkg('acme.demo', 'acme', { shell: 'full' }, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', { shell: 'full' }, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-update-diff-same-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!

      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      const fresh = await prepare(null, { namespace: 'acme', name: 'demo' })
      // A first install has nothing to compare against and asks as before.
      expect(fresh).toMatchObject({ requiresRiskConfirmation: true, disclosureDiff: null })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })

      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      const update = await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      expect(update).toMatchObject({
        requiresPublisherTrust: false,
        requiresRiskConfirmation: true,
        disclosureDiff: {
          from: { id: 'acme.demo', version: '1.0.0' },
          to: { id: 'acme.demo', version: '1.0.1' },
          added: [],
          removed: [],
          widened: false,
        },
      })
      await expect(commit(null, { id: 'acme.demo' })).rejects.toThrow(/risk confirmation/)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await expect(commit(null, { id: 'acme.demo', riskConfirmed: true })).resolves.toMatchObject({ restartRequired: true })
      await restart(null, { id: 'acme.demo' })
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.1')).toMatchObject({
        packageVersion: '1.0.1',
        shell: 'full',
        highRiskShellConfirmed: true,
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('B2: plugins:installedDisclosure answers the active version\'s disclosure, null when there is none', async () => {
    const first = buildPkg('acme.demo', 'acme', { shell: 'allowlist' }, '1.0.0')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-installed-disclosure-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const installedDisclosure = handlers.get('plugins:installedDisclosure')!
      expect(await installedDisclosure(null, { id: 'acme.demo' })).toBeNull()  // not installed
      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      expect(await installedDisclosure(null, { id: 'acme.demo' })).toEqual(computeDisclosure({
        schemaVersion: 2, id: 'acme.demo', version: '1.0.0', publisher: 'acme', permissions: { shell: 'allowlist' },
      } as never))
      await expect(installedDisclosure(null, { id: '../acme.demo' })).rejects.toThrow(/invalid plugin id/)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('D-d: an update that adds a permission still asks, and reports only what changed', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', { shell: 'allowlist' }, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-update-diff-wider-'))
    const manager = new FrontendPluginManager()
    try {
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!

      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })

      // The update badge reads the Registry's listing; no disclosure, no badge.
      const listed = signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1')
      installFetch(listed, second.bytes, second.digest)
      expect(await controller.checkUpdates()).toEqual([
        { id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.0.0', latestVersion: '1.0.1' },
      ])
      const disclosed = (permissions: Record<string, unknown>) => computeDisclosure({
        schemaVersion: 2, id: 'acme.demo', version: '1.0.1', publisher: 'acme', permissions,
      } as never)
      ;(listed.versions[0] as Record<string, unknown>).disclosure = disclosed({ shell: 'allowlist' })
      expect(await controller.checkUpdates()).toMatchObject([{ latestVersion: '1.0.1', permissionChange: 'more' }])
      ;(listed.versions[0] as Record<string, unknown>).disclosure = disclosed({})
      expect(await controller.checkUpdates()).toMatchObject([{ latestVersion: '1.0.1', permissionChange: 'same' }])

      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      const update = await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' }) as {
        requiresRiskConfirmation: boolean
        disclosureDiff: { added: unknown[] }
      }
      expect(update.requiresRiskConfirmation).toBe(true)
      expect(update.disclosureDiff).toMatchObject({ removed: [], widened: true })
      expect(update.disclosureDiff.added).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'shell', key: 'allowlist' }),
      ]))
      await expect(commit(null, { id: 'acme.demo' })).rejects.toThrow(/risk confirmation/)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('D-f: asks the backend for the activity report with the declared items, and checks the answer', async () => {
    const pkg = buildPkg('acme.demo', 'acme', { shell: 'allowlist' }, '1.0.0')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-activity-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      installFetch(signedDetail(pkg.digest, 'acme.demo', 'acme', '1.0.0'), pkg.bytes, pkg.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })

      const fixture = JSON.parse(readFileSync(join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/activity-report.json'), 'utf8')).valid
      const ask = vi.spyOn(manager, 'requestPluginActivityReport').mockResolvedValue(fixture)
      const report = handlers.get('plugins:activityReport')!
      await expect(report(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true, report: fixture })
      expect(ask).toHaveBeenCalledWith({
        plugin_id: 'acme.demo',
        declared: expect.arrayContaining([{ kind: 'shell', key: 'allowlist' }]),
        installedAt: expect.any(Number),
      })

      ask.mockResolvedValue({ ...fixture, schemaVersion: 2 })
      await expect(report(null, { id: 'acme.demo' })).resolves.toEqual({ ok: false, error: 'the activity report was malformed' })
      ask.mockRejectedValue(new Error('Navide Host session is not ready'))
      await expect(report(null, { id: 'acme.demo' })).resolves.toEqual({ ok: false, error: 'Navide Host session is not ready' })
      await expect(report(null, { id: 'acme.other' })).resolves.toMatchObject({ ok: false })
      expect(ask).toHaveBeenCalledTimes(3)

      expect(handlers.get('plugins:installedDisclosures')!(null)).toEqual([
        expect.objectContaining({ id: 'acme.demo', version: '1.0.0', disclosure: expect.objectContaining({ network: 'via-shell' }), scan: null }),
      ])
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // A frontend's calls to its own backend (plugin:backend:call) are recorded
  // in plugin_activity as source "backend", address "backend.<method>" (#374),
  // so each declared method is offered under that address. (Before, #371 left
  // them out: unrecorded, they could only ever read "declared but not used".)
  it('D-f: declares backend methods as backend.<method>, the address their calls are recorded under', () => {
    const disclosure = computeDisclosure({
      schemaVersion: 2, id: 'acme.indexer', version: '1.0.0', publisher: 'acme',
      permissions: { system: ['fs'], shell: 'allowlist' },
      backend: { entry: 'backend/bin', methods: ['index', 'search'], events: [] },
    } as never)
    expect(disclosure.nativeBackend?.methods).toEqual(['index', 'search'])
    const declared = declaredForActivity(disclosure)
    expect(declared.filter((item) => item.kind === 'backendMethod')).toEqual([
      { kind: 'backendMethod', key: 'backend.index' },
      { kind: 'backendMethod', key: 'backend.search' },
    ])
    expect(declared).toEqual(expect.arrayContaining([{ kind: 'system', key: 'fs' }, { kind: 'shell', key: 'allowlist' }]))
  })

  it('D-f: a recorded backend call has exactly the address its declared method is keyed by', () => {
    const disclosure = computeDisclosure({
      schemaVersion: 2, id: 'acme.indexer', version: '1.0.0', publisher: 'acme',
      permissions: { system: ['fs'] },
      backend: { entry: 'backend/bin', methods: ['fs.read', 'index'], events: [] },
    } as never)
    const declared = declaredForActivity(disclosure).filter((item) => item.kind === 'backendMethod').map((item) => item.key)
    // The Host records a call under backendCallAddress(method); the backend
    // matches backendMethod by address == key (contract 5.1).
    expect(declared).toEqual(['fs.read', 'index'].map(backendCallAddress))
    expect(declared).toEqual(['backend.fs.read', 'backend.index'])
  })

  // #373 follow-up (N2): installedAt is when the id was installed since its
  // last removal; updates and rollbacks keep it, and without one the request
  // carries none and still succeeds.
  it('sends installedAt from the fresh install, kept by update and rollback, renewed by a reinstall', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-installed-at-'))
    const manager = new FrontendPluginManager()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        cleanupPluginStorage: async () => undefined,
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const report = handlers.get('plugins:activityReport')!
      const ask = vi.spyOn(manager, 'requestPluginActivityReport').mockResolvedValue(
        JSON.parse(readFileSync(join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/activity-report.json'), 'utf8')).valid,
      )
      const sentInstalledAt = async () => {
        await expect(report(null, { id: 'acme.demo' })).resolves.toMatchObject({ ok: true })
        return (ask.mock.calls.at(-1)![0] as { installedAt?: number }).installedAt
      }
      const install = async (pkg: { bytes: Uint8Array; digest: string }, version: string, at: number) => {
        vi.setSystemTime(at)
        installFetch(signedDetail(pkg.digest, 'acme.demo', 'acme', version), pkg.bytes, pkg.digest)
        await prepare(null, { namespace: 'acme', name: 'demo', version })
        await commit(null, { id: 'acme.demo', publisherConfirmed: true })
        await restart(null, { id: 'acme.demo' })
      }

      await install(first, '1.0.0', 1_000_000)
      expect(await sentInstalledAt()).toBe(1_000_000)
      await install(second, '1.0.1', 2_000_000)
      expect(await sentInstalledAt()).toBe(1_000_000)
      vi.setSystemTime(3_000_000)
      await handlers.get('plugins:rollback')!(null, { id: 'acme.demo' })
      expect(await sentInstalledAt()).toBe(1_000_000)

      await handlers.get('plugins:remove')!(null, { id: 'acme.demo' })
      await install(first, '1.0.0', 4_000_000)
      expect(await sentInstalledAt()).toBe(4_000_000)

      // Installed before this was recorded: no field, and the request succeeds.
      const file = join(root, '.navide-install-scans.json')
      const state = JSON.parse(readFileSync(file, 'utf8'))
      delete state.installedAt['acme.demo']
      writeFileSync(file, JSON.stringify(state))
      expect(await sentInstalledAt()).toBeUndefined()
      expect(ask.mock.calls.at(-1)![0]).not.toHaveProperty('installedAt')
      // A later update does not invent one either.
      await install(second, '1.0.1', 5_000_000)
      expect(await sentInstalledAt()).toBeUndefined()
    } finally {
      vi.useRealTimers()
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Review LOW1 on #380: a fresh install's time is recorded when the
  // candidate becomes active, not when it is staged.
  it('records installedAt only once a fresh install is activated', async () => {
    const pkg = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-installed-at-activate-'))
    const manager = new FrontendPluginManager()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      installFetch(signedDetail(pkg.digest, 'acme.demo', 'acme', '1.0.0'), pkg.bytes, pkg.digest)
      vi.setSystemTime(1_000_000)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
      expect(new PluginInstallScanStore(root).installedAt('acme.demo')).toBeNull()
      vi.setSystemTime(2_000_000)
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      expect(new PluginInstallScanStore(root).installedAt('acme.demo')).toBe(2_000_000)
    } finally {
      vi.useRealTimers()
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('D-f: the activity IPC refuses an unauthorized sender', async () => {
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => false, TRUST_CONFIG)
    await expect(Promise.resolve().then(() => handlers.get('plugins:activityReport')!(null, { id: 'acme.demo' }))).rejects.toThrow()
    expect(() => handlers.get('plugins:installedDisclosures')!(null)).toThrow()
  })

  it('lists a Marketplace install with its legacy provenance unchanged and a marketplace source', async () => {
    const stable = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    installFetch(signedDetail(stable.digest, 'acme.demo', 'acme', '1.0.0'), stable.bytes, stable.digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-source-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      expect(handlers.get('plugins:listInstalled')!(null)).toMatchObject([
        { id: 'acme.demo', provenance: 'official-registry', source: 'marketplace' },
      ])
      // The view contribution payload gains only `source`; every other field
      // is the projection main sends.
      const catalog = manager.listContributionCatalog()
      expect(catalog.length).toBeGreaterThan(0)
      expect(await handlers.get('plugins:listContributions')!(null)).toEqual(
        catalog.map(({ iconFile: _iconFile, ...entry }) => ({
          ...entry,
          icon: null,
          iconMonochrome: false,
          source: 'marketplace',
        }))
      )
      // The Registry-signed envelope's channel decides the source, so a
      // testplace version is never shown as a reviewed Marketplace release.
      const selection = new PluginActivationSelector(root).read('acme.demo')?.active
      const packageDir = selection
        ? new PluginActivationSelector(root).packageDir('acme.demo', selection)
        : join(root, 'acme.demo')
      const receiptPath = join(packageDir, REGISTRY_RECEIPT_NAME)
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { envelope: Record<string, unknown> }
      receipt.envelope.channel = 'testplace'
      receipt.envelope.expiresAt = '2027-01-01T00:00:00.000Z'
      writeFileSync(receiptPath, JSON.stringify(receipt))
      expect(handlers.get('plugins:listInstalled')!(null)).toMatchObject([
        { id: 'acme.demo', provenance: 'official-registry', source: 'testplace' },
      ])
      expect(await handlers.get('plugins:listContributions')!(null)).toEqual(
        expect.arrayContaining([expect.objectContaining({ pluginId: 'acme.demo', source: 'testplace' })])
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stages an immutable replacement without touching the active runtime until restart', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-lifecycle-'))
    const manager = new FrontendPluginManager()
    const activationChanges: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => activationChanges.push(change),
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const list = handlers.get('plugins:listInstalled')!
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      activationChanges.length = 0

      const revoke = vi.spyOn(manager, 'revokePackageVersion')
      const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(
        signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'),
        second.bytes,
        second.digest,
      )
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await expect(commit(null, { id: 'acme.demo', publisherConfirmed: true })).resolves.toEqual({
        id: 'acme.demo',
        requires: [],
        restartRequired: true,
      })

      expect(revoke).not.toHaveBeenCalled()
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.0')
      expect(activationChanges).toEqual([])
      expect(list(null)).toMatchObject([{
        id: 'acme.demo',
        packageVersion: '1.0.0',
        pendingCandidateVersion: '1.0.1',
      }])
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'))).toBe(true)
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.1', 'universal'))).toBe(true)
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0', artifactDigest: first.digest },
        candidate: { packageVersion: '1.0.1', artifactDigest: second.digest },
      })

      await expect(restart(null, { id: 'acme.demo' })).resolves.toMatchObject({
        id: 'acme.demo',
        packageVersion: '1.0.1',
        restoredInstances: 0,
      })
      expect(revoke).toHaveBeenCalledWith('acme.demo', '1.0.0')
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.1')
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.1', artifactDigest: second.digest },
        previous: { packageVersion: '1.0.0', artifactDigest: first.digest },
      })
      expect(activationChanges).toHaveLength(1)
      expect(activationChanges[0]).toMatchObject({
        pluginId: 'acme.demo',
        activation: { packageVersion: '1.0.1', artifactDigest: second.digest },
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('activates an update over a v0.2.9 mutable v2 install and retains its rollback grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-legacy-v2-upgrade-'))
    const manager = new FrontendPluginManager()
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const firstDetail = signedDetail(first.digest)
    const legacyDir = join(root, 'acme.demo')
    try {
      for (const entry of readZipEntries(first.bytes)) {
        if (entry.kind !== 'file') continue
        const output = join(legacyDir, entry.path)
        mkdirSync(join(output, '..'), { recursive: true })
        writeFileSync(output, entry.data)
      }
      writeFileSync(join(legacyDir, REGISTRY_ARTIFACT_NAME), first.bytes)
      writeFileSync(join(legacyDir, REGISTRY_RECEIPT_NAME), JSON.stringify(registryReceiptFromEvidence({
        packageId: 'acme.demo', version: '1.0.0', publisherId: 'acme', target: 'universal',
        artifactDigest: first.digest,
        envelope: firstDetail.versions[0]!.registry_envelope,
        envelopeSignature: firstDetail.versions[0]!.registry_signature!,
        registryAuthority: 'self-hosted',
      })))
      writeFileSync(join(root, REGISTRY_TRUST_SNAPSHOT_NAME), JSON.stringify({
        schemaVersion: 1,
        metadata: firstDetail.trust_metadata,
        metadataSignature: firstDetail.trust_metadata_signature,
      }))
      new PluginCapabilityGrantStore(root).set('acme.demo', {
        packageVersion: '1.0.0', system: [], storage: true,
      })
      expect(manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          registryAuthority: 'self-hosted',
          now: FIXED_NOW,
        },
      }).loaded).toContain('acme.demo')
      expect(new PluginActivationSelector(root).read('acme.demo')).toBeNull()

      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
      // Review MED-1 on #380: an update over a legacy layout is not a fresh install.
      expect(new PluginInstallScanStore(root).installedAt('acme.demo')).toBeNull()
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.0')
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        candidate: { packageVersion: '1.0.1' },
      })
      writeFileSync(join(legacyDir, 'frontend', 'left', 'index.html'), '<tampered>')
      await expect(handlers.get('plugins:restart')!(null, { id: 'acme.demo' }))
        .rejects.toThrow(/legacy active package cannot be verified/)
      expect(new PluginActivationSelector(root).read('acme.demo')?.active).toBeUndefined()
      writeFileSync(join(legacyDir, 'frontend', 'left', 'index.html'), '<!doctype html>')

      await expect(handlers.get('plugins:restart')!(null, { id: 'acme.demo' })).resolves.toMatchObject({
        packageVersion: '1.0.1',
      })
      expect(new PluginInstallScanStore(root).installedAt('acme.demo')).toBeNull()
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.1' },
        previous: { packageVersion: '1.0.0', artifactDigest: first.digest },
        previousGrant: { packageVersion: '1.0.0' },
      })
      await expect(handlers.get('plugins:rollback')!(null, { id: 'acme.demo' })).resolves.toMatchObject({
        packageVersion: '1.0.0',
      })
      expect(manager.getDescriptor('acme.demo')?.packageDir).toBe(legacyDir)
      const reloaded = new FrontendPluginManager()
      expect(reloaded.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          registryAuthority: 'self-hosted',
          now: FIXED_NOW,
        },
      }).loaded).toContain('acme.demo')
      expect(reloaded.getDescriptor('acme.demo')?.packageDir).toBe(legacyDir)
      await reloaded.closeBackendPlugins()
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** Lay out a v0.2.9-shaped install: mutable `<root>/<id>`, no selector record. */
  function writeV029Install(root: string, pkg: { bytes: Uint8Array; digest: string }): void {
    const detail = signedDetail(pkg.digest)
    const legacyDir = join(root, 'acme.demo')
    for (const entry of readZipEntries(pkg.bytes)) {
      if (entry.kind !== 'file') continue
      const output = join(legacyDir, entry.path)
      mkdirSync(join(output, '..'), { recursive: true })
      writeFileSync(output, entry.data, entry.executable ? { mode: 0o755 } : undefined)
    }
    writeFileSync(join(legacyDir, REGISTRY_ARTIFACT_NAME), pkg.bytes)
    writeFileSync(join(legacyDir, REGISTRY_RECEIPT_NAME), JSON.stringify(registryReceiptFromEvidence({
      packageId: 'acme.demo', version: '1.0.0', publisherId: 'acme', target: 'universal',
      artifactDigest: pkg.digest,
      envelope: detail.versions[0]!.registry_envelope,
      envelopeSignature: detail.versions[0]!.registry_signature!,
      registryAuthority: 'self-hosted',
    })))
    writeFileSync(join(root, REGISTRY_TRUST_SNAPSHOT_NAME), JSON.stringify({
      schemaVersion: 1,
      metadata: detail.trust_metadata,
      metadataSignature: detail.trust_metadata_signature,
    }))
    new PluginCapabilityGrantStore(root).set('acme.demo', {
      packageVersion: '1.0.0', system: [], storage: true,
    })
  }

  /** The Host's cold-start/activation-change backend registration (index.ts). */
  function registerActivationBackend(manager: FrontendPluginManager, activation?: PluginActivationCatalogEntry): void {
    if (!activation?.backend || manager.hasBackendActivation(activation.pluginId, activation.packageVersion)) return
    manager.registerBackendActivation({
      pluginId: activation.pluginId,
      packageVersion: activation.packageVersion,
      packageDir: activation.packageDir,
      entryFile: activation.backend.entryFile,
      protocolVersion: activation.backend.protocolVersion,
      activation: activation.backend.activation,
      approvedMethods: [],
      approvedEvents: [],
      approvedBridgePorts: [],
    })
  }

  it('activates an update over a v0.2.9 mutable backend-only install and drains its old backend', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-plugin-legacy-backend-upgrade-')))
    const manager = new FrontendPluginManager()
    const first = buildBackendPkg('1.0.0')
    try {
      writeV029Install(root, first)
      const loaded = manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          registryAuthority: 'self-hosted',
          now: FIXED_NOW,
        },
      })
      expect(loaded.errors).toEqual([])
      expect(loaded.activationCatalog.map((entry) => entry.pluginId)).toContain('acme.demo')
      for (const activation of loaded.activationCatalog) registerActivationBackend(manager, activation)
      expect(manager.getDescriptor('acme.demo')).toBeUndefined()
      expect(manager.hasBackendActivation('acme.demo', '1.0.0')).toBe(true)

      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: ({ activation }) => registerActivationBackend(manager, activation),
      })
      const second = buildBackendPkg('1.0.1')
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      // Review MED-1 on #380: an update over a backend-only legacy install is not fresh.
      expect(new PluginInstallScanStore(root).installedAt('acme.demo')).toBeNull()

      await expect(handlers.get('plugins:restart')!(null, { id: 'acme.demo' })).resolves.toMatchObject({
        packageVersion: '1.0.1',
      })
      expect(new PluginInstallScanStore(root).installedAt('acme.demo')).toBeNull()
      expect(manager.hasBackendActivation('acme.demo', '1.0.0')).toBe(false)
      expect(manager.hasBackendActivation('acme.demo', '1.0.1')).toBe(true)
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.1' },
        previous: { packageVersion: '1.0.0', artifactDigest: first.digest, layout: 'legacy-mutable' },
        previousGrant: { packageVersion: '1.0.0' },
      })
      expect(new PluginActivationSelector(root).read('acme.demo')?.candidate).toBeUndefined()
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('discards a staged candidate over an unverifiable v0.2.9 install without removing the plugin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-legacy-discard-'))
    const manager = new FrontendPluginManager()
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const legacyDir = join(root, 'acme.demo')
    try {
      writeV029Install(root, first)
      expect(manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          registryAuthority: 'self-hosted',
          now: FIXED_NOW,
        },
      }).loaded).toContain('acme.demo')
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      writeFileSync(join(legacyDir, 'frontend', 'left', 'index.html'), '<tampered>')
      await expect(handlers.get('plugins:restart')!(null, { id: 'acme.demo' }))
        .rejects.toThrow(/legacy active package cannot be verified/)

      const third = buildPkg('acme.demo', 'acme', {}, '1.0.2')
      installFetch(signedDetail(third.digest, 'acme.demo', 'acme', '1.0.2'), third.bytes, third.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.2' })
      await expect(commit(null, { id: 'acme.demo', publisherConfirmed: true })).rejects.toThrow(/already has a staged candidate/)

      const discard = handlers.get('plugins:discardCandidate')
      expect(discard).toBeTypeOf('function')
      await expect(discard!(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true })
      // Review LOW1 on #380: a staged, then discarded, candidate records nothing.
      expect(new PluginInstallScanStore(root).installedAt('acme.demo')).toBeNull()
      expect(new PluginActivationSelector(root).read('acme.demo')).toBeNull()
      expect(manager.getDescriptor('acme.demo')).toMatchObject({ packageVersion: '1.0.0', packageDir: legacyDir })
      await expect(handlers.get('plugins:restart')!(null, { id: 'acme.demo' })).rejects.toThrow(/no staged candidate/)
      await expect(discard!(null, { id: 'acme.demo' })).rejects.toThrow(/no staged candidate/)

      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.2' })
      await expect(commit(null, { id: 'acme.demo', publisherConfirmed: true })).resolves.toMatchObject({
        restartRequired: true,
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores the factory-bundled package when a promoted update fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-update-'))
    const factoryDir = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-bundle-'))
    const manager = new FrontendPluginManager()
    const activationChanges: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      for (const entry of readZipEntries(buildPkg('acme.demo', 'acme', {}, '1.0.0').bytes)) {
        if (entry.kind !== 'file') continue
        const output = join(factoryDir, entry.path)
        mkdirSync(join(output, '..'), { recursive: true })
        writeFileSync(output, entry.data)
      }
      expect(manager.loadFactoryPlugin(factoryDir, 'acme.demo')).toMatchObject({ loaded: true })
      const factoryGrant = { packageVersion: '1.0.0', system: [], storage: true as const }
      new PluginCapabilityGrantStore(root).set('acme.demo', factoryGrant)

      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => activationChanges.push(change),
      })
      const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
      vi.spyOn(manager, 'restorePackageRestart').mockRejectedValueOnce(new Error('injected placement failure'))

      await expect(handlers.get('plugins:restart')!(null, { id: 'acme.demo' }))
        .rejects.toThrow('injected placement failure')
      expect(manager.getDescriptor('acme.demo')).toMatchObject({ packageVersion: '1.0.0', packageDir: factoryDir })
      expect(manager.listInstalledPackages()).toMatchObject([{ id: 'acme.demo', provenance: 'factory-bundled' }])
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')).toEqual(factoryGrant)
      expect(activationChanges.at(-1)).toMatchObject({
        pluginId: 'acme.demo',
        activation: { packageVersion: '1.0.0', provenance: 'factory-bundled' },
      })
      const selection = new PluginActivationSelector(root).read('acme.demo')
      expect(selection?.active).toBeUndefined()
      expect(selection?.activation).toBeUndefined()
      expect(selection?.candidate).toMatchObject({ packageVersion: '1.0.1' })
      expect((manager as unknown as { restartingPluginIds: Set<string> }).restartingPluginIds.has('acme.demo')).toBe(false)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
      rmSync(factoryDir, { recursive: true, force: true })
    }
  })

  it.each([true, false])('rolls a package that replaced a factory package back to the factory package (factory loads: %s)', async (factoryLoads) => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-rollback-'))
    const factoryDir = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-bundle-'))
    const manager = new FrontendPluginManager()
    const activationChanges: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      for (const entry of readZipEntries(buildPkg('acme.demo', 'acme', {}, '1.0.0').bytes)) {
        if (entry.kind !== 'file') continue
        const output = join(factoryDir, entry.path)
        mkdirSync(join(output, '..'), { recursive: true })
        writeFileSync(output, entry.data)
      }
      const grants = new PluginCapabilityGrantStore(root)
      const factoryGrant = { packageVersion: '1.0.0', system: [], storage: true as const }
      expect(manager.loadFactoryPlugin(factoryDir, 'acme.demo')).toMatchObject({ loaded: true })
      grants.set('acme.demo', factoryGrant)

      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => activationChanges.push(change),
        factoryPackageIds: ['acme.demo'],
        loadFactoryPackage: (pluginId) => {
          if (!factoryLoads) return { loaded: false, reason: 'injected factory failure' }
          const restored = manager.loadFactoryPlugin(factoryDir, pluginId)
          if (restored.loaded) grants.set(pluginId, factoryGrant)
          return restored
        },
      })
      const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      const secondSelection = { packageVersion: '1.0.1', target: 'universal', artifactDigest: second.digest }
      const secondGrant = { packageVersion: '1.0.1', system: [], storage: true }
      const secondDir = join(root, 'acme.demo', '1.0.1', 'universal', 'package')
      expect(new PluginActivationSelector(root).read('acme.demo')).toEqual({
        schemaVersion: 1,
        pluginId: 'acme.demo',
        active: secondSelection,
        activeGrant: secondGrant,
      })

      // The Extensions row offers exactly the rollback the handler accepts.
      expect(handlers.get('plugins:listInstalled')!(null)).toMatchObject([
        { id: 'acme.demo', rollbackKind: 'factory' },
      ])
      const rollback = handlers.get('plugins:rollback')!(null, { id: 'acme.demo' })
      if (!factoryLoads) {
        await expect(rollback).rejects.toThrow('injected factory failure')
        expect(manager.getDescriptor('acme.demo')).toMatchObject({ packageVersion: '1.0.1', packageDir: secondDir })
        expect(grants.get('acme.demo', '1.0.1')).toEqual(secondGrant)
        expect(new PluginActivationSelector(root).read('acme.demo')).toEqual({
          schemaVersion: 1,
          pluginId: 'acme.demo',
          active: secondSelection,
          activeGrant: secondGrant,
        })
        return
      }
      await expect(rollback).resolves.toMatchObject({ id: 'acme.demo', packageVersion: '1.0.0' })
      expect(manager.getDescriptor('acme.demo')).toMatchObject({ packageVersion: '1.0.0', packageDir: factoryDir })
      expect(manager.listInstalledPackages()).toMatchObject([{ id: 'acme.demo', provenance: 'factory-bundled' }])
      expect(grants.get('acme.demo', '1.0.0')).toEqual(factoryGrant)
      expect(activationChanges.at(-1)).toMatchObject({
        pluginId: 'acme.demo',
        activation: { packageVersion: '1.0.0', provenance: 'factory-bundled' },
      })
      // The displaced package bytes are retained as the next candidate.
      expect(new PluginActivationSelector(root).read('acme.demo')).toEqual({
        schemaVersion: 1,
        pluginId: 'acme.demo',
        candidate: secondSelection,
        candidateGrant: secondGrant,
      })
      expect(existsSync(join(secondDir, 'manifest.json'))).toBe(true)
      // A staged candidate is the one shape the handler refuses, so the row
      // stops offering a rollback rather than showing a button that throws.
      expect(handlers.get('plugins:listInstalled')!(null)).toMatchObject([
        { id: 'acme.demo', pendingCandidateVersion: '1.0.1' },
      ])
      expect((handlers.get('plugins:listInstalled')!(null) as Array<{ rollbackKind?: string }>)[0].rollbackKind)
        .toBeUndefined()
      await expect(handlers.get('plugins:rollback')!(null, { id: 'acme.demo' }))
        .rejects.toThrow('has no completed activation to roll back')
      expect((manager as unknown as { restartingPluginIds: Set<string> }).restartingPluginIds.has('acme.demo')).toBe(false)

      await expect(handlers.get('plugins:restart')!(null, { id: 'acme.demo' }))
        .resolves.toMatchObject({ packageVersion: '1.0.1' })
      expect(manager.getDescriptor('acme.demo')).toMatchObject({ packageVersion: '1.0.1', packageDir: secondDir })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
      rmSync(factoryDir, { recursive: true, force: true })
    }
  })

  it('neither offers nor starts a factory rollback the Host already refuses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-rollback-refused-'))
    const manager = new FrontendPluginManager()
    const loadFactoryPackage = vi.fn(() => ({ loaded: false as const, reason: 'unreachable' }))
    const beginPackageRestart = vi.spyOn(manager, 'beginPackageRestart')
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        factoryPackageIds: ['acme.demo'],
        factoryRollbackRefusal: (pluginId) =>
          pluginId === 'acme.demo' ? 'bundled acme.demo is pinned to legacy recovery' : undefined,
        loadFactoryPackage,
      })
      const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      beginPackageRestart.mockClear()

      const [row] = handlers.get('plugins:listInstalled')!(null) as Array<Record<string, unknown>>
      expect(row).toMatchObject({ id: 'acme.demo' })
      expect(row.rollbackKind).toBeUndefined()
      // Refused before the open views are drained, not after.
      await expect(handlers.get('plugins:rollback')!(null, { id: 'acme.demo' }))
        .rejects.toThrow('bundled acme.demo is pinned to legacy recovery')
      expect(beginPackageRestart).not.toHaveBeenCalled()
      expect(loadFactoryPackage).not.toHaveBeenCalled()
      expect(new PluginActivationSelector(root).read('acme.demo')?.active?.packageVersion).toBe('1.0.1')
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-selects the displaced package when the factory load throws mid-rollback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-rollback-throw-'))
    const factoryDir = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-bundle-throw-'))
    const manager = new FrontendPluginManager()
    const activationChanges: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      for (const entry of readZipEntries(buildPkg('acme.demo', 'acme', {}, '1.0.0').bytes)) {
        if (entry.kind !== 'file') continue
        const output = join(factoryDir, entry.path)
        mkdirSync(join(output, '..'), { recursive: true })
        writeFileSync(output, entry.data)
      }
      const grants = new PluginCapabilityGrantStore(root)
      const factoryGrant = { packageVersion: '1.0.0', system: [], storage: true as const }
      expect(manager.loadFactoryPlugin(factoryDir, 'acme.demo')).toMatchObject({ loaded: true })
      grants.set('acme.demo', factoryGrant)

      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => activationChanges.push(change),
        factoryPackageIds: ['acme.demo'],
        // A guard that refuses (legacy-pinned Git) or a bundle that cannot be
        // read throws rather than reporting `loaded: false`.
        loadFactoryPackage: () => {
          throw new Error('injected factory crash')
        },
      })
      const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      const secondSelection = { packageVersion: '1.0.1', target: 'universal', artifactDigest: second.digest }
      const secondGrant = { packageVersion: '1.0.1', system: [], storage: true }
      const secondDir = join(root, 'acme.demo', '1.0.1', 'universal', 'package')

      await expect(handlers.get('plugins:rollback')!(null, { id: 'acme.demo' }))
        .rejects.toThrow('injected factory crash')

      // The displaced package is selected, granted and registered again, and the
      // row stops offering a rollback only because it is offering one that works.
      expect(new PluginActivationSelector(root).read('acme.demo')).toEqual({
        schemaVersion: 1,
        pluginId: 'acme.demo',
        active: secondSelection,
        activeGrant: secondGrant,
      })
      expect(grants.get('acme.demo', '1.0.1')).toEqual(secondGrant)
      expect(manager.getDescriptor('acme.demo')).toMatchObject({
        packageVersion: '1.0.1',
        packageDir: secondDir,
      })
      expect(activationChanges.at(-1)).toMatchObject({
        pluginId: 'acme.demo',
        activation: { packageVersion: '1.0.1', provenance: 'official-registry' },
      })
      expect(handlers.get('plugins:listInstalled')!(null)).toMatchObject([
        { id: 'acme.demo', rollbackKind: 'factory' },
      ])
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
      rmSync(factoryDir, { recursive: true, force: true })
    }
  })

  it('leaves a factory rollback journal that cold start recovers to the displaced package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-rollback-crash-'))
    const factoryDir = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-bundle-crash-'))
    const manager = new FrontendPluginManager()
    try {
      for (const entry of readZipEntries(buildPkg('acme.demo', 'acme', {}, '1.0.0').bytes)) {
        if (entry.kind !== 'file') continue
        const output = join(factoryDir, entry.path)
        mkdirSync(join(output, '..'), { recursive: true })
        writeFileSync(output, entry.data)
      }
      expect(manager.loadFactoryPlugin(factoryDir, 'acme.demo')).toMatchObject({ loaded: true })
      new PluginCapabilityGrantStore(root).set('acme.demo', { packageVersion: '1.0.0', system: [], storage: true })
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        factoryPackageIds: ['acme.demo'],
        loadFactoryPackage: () => {
          throw new Error('process died while loading the factory package')
        },
      })
      const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      const secondSelection = { packageVersion: '1.0.1', target: 'universal', artifactDigest: second.digest }
      const secondGrant = { packageVersion: '1.0.1', system: [], storage: true }
      // A dead process runs none of its in-process recovery.
      vi.spyOn(PluginActivationSelector.prototype, 'recoverInterruptedActivation').mockImplementationOnce(() => {
        throw new Error('process is gone')
      })

      await expect(handlers.get('plugins:rollback')!(null, { id: 'acme.demo' })).rejects.toThrow()

      // What the next start finds on disk says a factory rollback was in flight.
      const onDisk = new PluginActivationSelector(root)
      expect(onDisk.read('acme.demo')).toEqual({
        schemaVersion: 1,
        pluginId: 'acme.demo',
        active: secondSelection,
        activeGrant: secondGrant,
        activation: { kind: 'factory-rollback', phase: 'prepared' },
      })
      vi.restoreAllMocks()
      expect(onDisk.recoverInterruptedActivation('acme.demo')).toEqual({
        schemaVersion: 1,
        pluginId: 'acme.demo',
        active: secondSelection,
        activeGrant: secondGrant,
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
      rmSync(factoryDir, { recursive: true, force: true })
    }
  })

  it('offers no rollback for a retained package with no grant to restore', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-rollback-no-grant-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })

      // The schema allows `previous` without `previousGrant` and the handler
      // refuses that shape, so the row must not offer it either.
      const selectorFile = join(root, '.navide-lifecycle', 'acme.demo.json')
      const record = JSON.parse(readFileSync(selectorFile, 'utf8'))
      expect(record.previousGrant).toBeTruthy()
      delete record.previousGrant
      writeFileSync(selectorFile, JSON.stringify(record))

      expect((handlers.get('plugins:listInstalled')!(null) as Array<{ rollbackKind?: string }>)[0].rollbackKind)
        .toBeUndefined()
      await expect(handlers.get('plugins:rollback')!(null, { id: 'acme.demo' }))
        .rejects.toThrow('previous package is unavailable for rollback')
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports both causes when the displaced package can no longer be read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-rollback-unreadable-'))
    const factoryDir = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-unreadable-'))
    const manager = new FrontendPluginManager()
    const activationChanges: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      for (const entry of readZipEntries(buildPkg('acme.demo', 'acme', {}, '1.0.0').bytes)) {
        if (entry.kind !== 'file') continue
        const output = join(factoryDir, entry.path)
        mkdirSync(join(output, '..'), { recursive: true })
        writeFileSync(output, entry.data)
      }
      const grants = new PluginCapabilityGrantStore(root)
      expect(manager.loadFactoryPlugin(factoryDir, 'acme.demo')).toMatchObject({ loaded: true })
      grants.set('acme.demo', { packageVersion: '1.0.0', system: [], storage: true as const })

      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => activationChanges.push(change),
        factoryPackageIds: ['acme.demo'],
        loadFactoryPackage: () => ({ loaded: false as const, reason: 'injected factory failure' }),
      })
      const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })

      // Nothing can re-register a package whose manifest is gone.
      rmSync(join(root, 'acme.demo', '1.0.1', 'universal', 'package', 'manifest.json'), { force: true })
      const rejection = await Promise.resolve(
        handlers.get('plugins:rollback')!(null, { id: 'acme.demo' }),
      ).catch((error: unknown) => error)
      expect(rejection).toBeInstanceOf(AggregateError)
      const causes = (rejection as AggregateError).errors.map((error) => String(error))
      expect(causes.join(' | ')).toContain('injected factory failure')
      expect(causes.join(' | ')).toContain('displaced package is no longer readable')
      // IPC carries only the message, so it has to name both causes itself.
      expect((rejection as AggregateError).message).toContain('injected factory failure')
      expect((rejection as AggregateError).message).toContain('displaced package is no longer readable')
      // The renderer is told the id carries no activation rather than being left
      // with contributions that no longer resolve.
      expect(activationChanges.at(-1)).toEqual({ pluginId: 'acme.demo' })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
      rmSync(factoryDir, { recursive: true, force: true })
    }
  })

  it('rolls a promoted candidate back to the verified previous package when placement restoration fails', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-restart-rollback-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!

      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })

      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      vi.spyOn(manager, 'restorePackageRestart').mockRejectedValueOnce(new Error('injected placement failure'))

      await expect(restart(null, { id: 'acme.demo' })).rejects.toThrow('injected placement failure')
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.0')
      expect(new PluginActivationSelector(root).read('acme.demo')).toEqual({
        schemaVersion: 1,
        pluginId: 'acme.demo',
        activeGrant: { packageVersion: '1.0.0', system: [], storage: true },
        active: { packageVersion: '1.0.0', target: 'universal', artifactDigest: first.digest },
        candidate: { packageVersion: '1.0.1', target: 'universal', artifactDigest: second.digest },
        candidateGrant: { packageVersion: '1.0.1', system: [], storage: true },
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-verifies and restarts only the retained previous package on explicit rollback', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-explicit-rollback-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')
      if (!rollback) throw new Error('rollback handler not registered')

      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })

      expect(handlers.get('plugins:listInstalled')!(null)).toMatchObject([
        { id: 'acme.demo', rollbackKind: 'previous', rollbackToVersion: '1.0.0' },
      ])
      await expect(rollback(null, { id: 'acme.demo' })).resolves.toMatchObject({
        id: 'acme.demo',
        packageVersion: '1.0.0',
      })
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.0')
      expect(new PluginActivationSelector(root).read('acme.demo')).toEqual({
        schemaVersion: 1,
        pluginId: 'acme.demo',
        activeGrant: { packageVersion: '1.0.0', system: [], storage: true },
        active: { packageVersion: '1.0.0', target: 'universal', artifactDigest: first.digest },
        candidate: { packageVersion: '1.0.1', target: 'universal', artifactDigest: second.digest },
        candidateGrant: { packageVersion: '1.0.1', system: [], storage: true },
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('drains a backend-only active version before promoting an explicit rollback', async () => {
    const first = buildBackendPkg('1.0.0')
    const second = buildBackendPkg('1.0.1')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-plugin-backend-rollback-drain-')))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: ({ activation }) => {
          if (!activation?.backend) return
          const packageDirectories = (manager as unknown as {
            installedPackageDirectories: Map<string, string>
          }).installedPackageDirectories
          expect(packageDirectories.get(activation.pluginId)).toBe(activation.packageDir)
          manager.registerBackendActivation({
            pluginId: activation.pluginId,
            packageVersion: activation.packageVersion,
            packageDir: activation.packageDir,
            entryFile: activation.backend.entryFile,
            protocolVersion: activation.backend.protocolVersion,
            activation: activation.backend.activation,
            approvedMethods: [],
            approvedEvents: [],
            approvedBridgePorts: [],
          })
        },
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')
      if (!rollback) throw new Error('rollback handler not registered')

      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      expect(manager.hasBackendActivation('acme.demo', '1.0.0')).toBe(true)
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      expect(manager.hasBackendActivation('acme.demo', '1.0.1')).toBe(true)

      const revoke = vi.spyOn(manager, 'revokePackageVersion')
      await expect(rollback(null, { id: 'acme.demo' })).resolves.toMatchObject({ packageVersion: '1.0.0' })
      expect(revoke).toHaveBeenCalledWith('acme.demo', '1.0.1')
      expect(manager.hasBackendActivation('acme.demo', '1.0.0')).toBe(true)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('releases the frontend restart barrier when rolling back to a backend-only package', async () => {
    const first = buildBackendPkg('1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-backend-only-rollback-barrier-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')!
      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.1')

      await expect(rollback(null, { id: 'acme.demo' })).resolves.toMatchObject({ packageVersion: '1.0.0' })
      expect(manager.getDescriptor('acme.demo')).toBeUndefined()
      expect((manager as unknown as { restartingPluginIds: Set<string> }).restartingPluginIds.has('acme.demo')).toBe(false)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('activates a backend-only update over a package with a frontend', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildBackendPkg('1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-frontend-to-backend-only-update-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })

      await expect(restart(null, { id: 'acme.demo' })).resolves.toMatchObject({ packageVersion: '1.0.1' })
      expect(manager.getDescriptor('acme.demo')).toBeUndefined()
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.1' },
        previous: { packageVersion: '1.0.0' },
      })
      expect((manager as unknown as { restartingPluginIds: Set<string> }).restartingPluginIds.has('acme.demo')).toBe(false)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('completes a rollback to a backend-only package while a view of the current version is open', async () => {
    const first = buildBackendPkg('1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-backend-only-rollback-open-view-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')!
      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })

      // Stand in for one open detached-window view of 1.0.1 captured by the drain.
      const hostWindow = { isDestroyed: () => false, close: vi.fn() }
      vi.spyOn(manager as unknown as { snapshotPackageRestart: () => unknown }, 'snapshotPackageRestart')
        .mockReturnValueOnce([{
          pluginId: 'acme.demo', packageVersion: '1.0.1', contributionKey: 'acme.demo.left',
          hostWindow, bounds: 'fill', query: '', closeHostOnHide: true, mirrorTitle: false,
          initiallyVisible: true, contributionRegistered: true, carrier: 'native',
        }])

      await expect(rollback(null, { id: 'acme.demo' })).resolves.toMatchObject({ packageVersion: '1.0.0' })
      expect(hostWindow.close).toHaveBeenCalled()
      expect(new PluginActivationSelector(root).read('acme.demo')?.activation).toBeUndefined()
      expect(manager.getDescriptor('acme.demo')).toBeUndefined()
      expect((manager as unknown as { restartingPluginIds: Set<string> }).restartingPluginIds.has('acme.demo')).toBe(false)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('releases the frontend barrier while retaining a promoted rollback journal after failure', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-rollback-post-promotion-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')!
      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      vi.spyOn(manager, 'setPluginStorageSnapshotSelection').mockImplementationOnce(() => {
        throw new Error('injected post-promotion failure')
      })
      await expect(rollback(null, { id: 'acme.demo' })).rejects.toThrow('injected post-promotion failure')
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0' },
        candidate: { packageVersion: '1.0.1' },
        activation: { kind: 'rollback', phase: 'promoted' },
      })
      expect((manager as unknown as { restartingPluginIds: Set<string> }).restartingPluginIds.has('acme.demo')).toBe(false)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves a promoted rollback journal for cold recovery when placement restoration fails', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-rollback-recovery-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')
      if (!rollback) throw new Error('rollback handler not registered')

      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      vi.spyOn(manager, 'restorePackageRestart').mockRejectedValueOnce(new Error('injected rollback restore failure'))

      await expect(rollback(null, { id: 'acme.demo' })).rejects.toThrow('injected rollback restore failure')
      const selector = new PluginActivationSelector(root)
      expect(selector.read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0' },
        candidate: { packageVersion: '1.0.1' },
        activation: { kind: 'rollback', phase: 'promoted' },
      })
      expect(new PluginActivationSelector(root).recoverInterruptedActivation('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0' },
        candidate: { packageVersion: '1.0.1' },
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['factory', 'previous'] as const)(
    'remounts the displaced version views when a %s rollback fails before selecting its target',
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), `navide-plugin-rollback-remount-${kind}-`))
      const factoryDir = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-remount-'))
      const manager = new FrontendPluginManager()
      try {
        const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
        const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
        if (kind === 'factory') {
          for (const entry of readZipEntries(first.bytes)) {
            if (entry.kind !== 'file') continue
            const output = join(factoryDir, entry.path)
            mkdirSync(join(output, '..'), { recursive: true })
            writeFileSync(output, entry.data)
          }
          expect(manager.loadFactoryPlugin(factoryDir, 'acme.demo')).toMatchObject({ loaded: true })
          new PluginCapabilityGrantStore(root).set('acme.demo', { packageVersion: '1.0.0', system: [], storage: true })
        }
        registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
          ...TEST_PREFLIGHT_OPTIONS,
          ...(kind === 'factory'
            ? {
                factoryPackageIds: ['acme.demo'],
                loadFactoryPackage: () => ({ loaded: false as const, reason: 'injected factory failure' }),
              }
            : {}),
        })
        const prepare = handlers.get('plugins:prepareInstall')!
        const commit = handlers.get('plugins:commitInstall')!
        const restart = handlers.get('plugins:restart')!
        if (kind === 'previous') {
          installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
          await prepare(null, { namespace: 'acme', name: 'demo' })
          await commit(null, { id: 'acme.demo', publisherConfirmed: true })
          await restart(null, { id: 'acme.demo' })
        }
        installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
        await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
        await commit(null, { id: 'acme.demo', publisherConfirmed: true })
        await restart(null, { id: 'acme.demo' })
        if (kind === 'previous') {
          vi.spyOn(PluginActivationSelector.prototype, 'activatePrevious').mockImplementationOnce(() => {
            throw new Error('injected selection failure')
          })
        }

        // Views resolve their grant the way the App wires it.
        manager.setCapabilityGrantResolver((pluginId, packageVersion) =>
          new PluginCapabilityGrantStore(root).get(pluginId, packageVersion))
        // One open view of 1.0.1 captured by the drain.
        const hostWindow = { isDestroyed: () => false, close: vi.fn() }
        const internals = manager as unknown as {
          snapshotPackageRestart: () => unknown
          mountView: (...args: unknown[]) => unknown
          waitForBackendBinding: () => Promise<void>
          waitForPluginReady: () => Promise<void>
          contributionInstances: Map<string, unknown>
          restartingPluginIds: Set<string>
        }
        vi.spyOn(internals, 'snapshotPackageRestart').mockReturnValueOnce([{
          pluginId: 'acme.demo', packageVersion: '1.0.1', contributionKey: 'acme.demo.left',
          hostWindow, bounds: 'fill', query: '', closeHostOnHide: false, mirrorTitle: false,
          initiallyVisible: true, contributionRegistered: true, carrier: 'native',
        }])
        const handle = { instanceId: 'restored-instance' }
        const mountView = vi.spyOn(internals, 'mountView').mockReturnValue(handle)
        vi.spyOn(internals, 'waitForBackendBinding').mockResolvedValue(undefined)
        vi.spyOn(internals, 'waitForPluginReady').mockResolvedValue(undefined)

        await expect(handlers.get('plugins:rollback')!(null, { id: 'acme.demo' }))
          .rejects.toThrow(kind === 'factory' ? 'injected factory failure' : 'injected selection failure')
        expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.1')
        expect(mountView).toHaveBeenCalledTimes(1)
        expect(mountView.mock.calls[0][0]).toBe(hostWindow)
        expect(mountView.mock.calls[0][1]).toMatchObject({ packageVersion: '1.0.1' })
        expect([...internals.contributionInstances.values()]).toContain(handle)
        expect(hostWindow.close).not.toHaveBeenCalled()
        expect(internals.restartingPluginIds.has('acme.demo')).toBe(false)
        expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
          active: { packageVersion: '1.0.1' },
        })
      } finally {
        await manager.closeBackendPlugins()
        rmSync(root, { recursive: true, force: true })
        rmSync(factoryDir, { recursive: true, force: true })
      }
    },
  )

  it('names both causes when the displaced views cannot be remounted after a failed rollback', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-rollback-remount-fails-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      vi.spyOn(PluginActivationSelector.prototype, 'activatePrevious').mockImplementationOnce(() => {
        throw new Error('injected selection failure')
      })
      vi.spyOn(manager, 'restorePackageRestart').mockRejectedValueOnce(new Error('injected remount failure'))

      const rejection = await Promise.resolve(
        handlers.get('plugins:rollback')!(null, { id: 'acme.demo' }),
      ).catch((error: unknown) => error)
      expect(rejection).toBeInstanceOf(AggregateError)
      expect((rejection as AggregateError).message).toContain('injected selection failure')
      expect((rejection as AggregateError).message).toContain('injected remount failure')
      expect((manager as unknown as { restartingPluginIds: Set<string> }).restartingPluginIds.has('acme.demo')).toBe(false)
      expect(new PluginActivationSelector(root).read('acme.demo')?.active?.packageVersion).toBe('1.0.1')
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists the confirmed Manifest v2 grant only after a successful commit and removes it on uninstall', async () => {
    const { bytes, digest } = buildPkg('acme.demo', 'acme', {
      system: ['fs', 'ui'],
      shell: 'allowlist',
    })
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-capability-grant-install-'))
    try {
      const manager = new FrontendPluginManager()
      const prepareHandler = register(root, manager)
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      const grants = new PluginCapabilityGrantStore(root)
      expect(grants.get('acme.demo', '1.0.0')).toBeNull()

      const commitHandler = handlers.get('plugins:commitInstall')
      const removeHandler = handlers.get('plugins:remove')
      if (!commitHandler || !removeHandler) throw new Error('plugin lifecycle handlers not registered')
      expect(
        await commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: ['fs', 'ui', 'shell'], restartRequired: true })
      expect(grants.get('acme.demo', '1.0.0')).toBeNull()
      const restartHandler = handlers.get('plugins:restart')
      if (!restartHandler) throw new Error('restart handler not registered')
      await restartHandler(null, { id: 'acme.demo' })
      expect(grants.get('acme.demo', '1.0.0')).toEqual({
        packageVersion: '1.0.0',
        system: ['fs', 'ui'],
        shell: 'allowlist',
        storage: true,
      })
      const listHandler = handlers.get('plugins:listInstalled')
      if (!listHandler) throw new Error('installed inventory handler not registered')
      expect(listHandler(null)).toMatchObject([{
        id: 'acme.demo',
        packageVersion: '1.0.0',
        manifestPermissions: { system: ['fs', 'ui'], shell: 'allowlist' },
        packageVersionGrant: {
          packageVersion: '1.0.0',
          system: ['fs', 'ui'],
          shell: 'allowlist',
          storage: true,
        },
      }])

      await removeHandler(null, { id: 'acme.demo' })
      expect(grants.get('acme.demo', '1.0.0')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires publisher consent for a Registry v1 package even with legacy non-sensitive requires', async () => {
    const { bytes, digest } = buildLegacyPkg(['git'])
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-v1-publisher-consent-'))
    try {
      const manager = new FrontendPluginManager()
      const prepareHandler = register(root, manager)
      const prepared = (await prepareHandler(null, {
        namespace: 'acme',
        name: 'demo',
      })) as { requiresPublisherTrust: boolean; requiresConfirmation: boolean }
      expect(prepared.requiresPublisherTrust).toBe(true)
      expect(prepared.requiresConfirmation).toBe(false)
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!commitHandler) throw new Error('commitInstall handler not registered')
      await expect(commitHandler(null, { id: 'acme.demo' })).rejects.toThrow(/publisher trust confirmation/)
      await expect(
        commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).resolves.toEqual({ id: 'acme.demo', requires: ['git'] })
      // Legacy v1 has no activation to stage: the package installs immediately
      // through the mutable path, with no restart step.
      expect(manager.listInstalledPackages()).toEqual([
        expect.objectContaining({ id: 'acme.demo', requires: ['git'] }),
      ])
      expect(manager.listInstalledPackages()[0]?.packageVersion).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('projects only a verified same-session backend activation', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-same-session-activation-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage: async () => undefined,
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: ({ pluginId, activation }) => {
          active.delete(pluginId)
          if (activation) active.set(pluginId, activation)
        },
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      expect(
        await commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: [], restartRequired: true })
      const restartHandler = handlers.get('plugins:restart')
      if (!restartHandler) throw new Error('restart handler not registered')
      await restartHandler(null, { id: 'acme.demo' })

      expect(
        projectBackendPluginActivationCatalog([...active.values()])
      ).toMatchObject({
        schemaVersion: 1,
        packages: [
          {
            pluginId: 'acme.demo',
            packageVersion: '1.0.0',
            packageDir: immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'),
            artifactDigest: digest,
            backend: {
              // The active package lives in its immutable target directory, and
              // the entry keeps the platform's on-disk name.
              entryFile: join(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'), BACKEND_ENTRY_ON_DISK),
              protocolVersion: 1,
              activation: 'startup',
            },
          },
        ],
      })

      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')
      await expect(removeHandler(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true })
      expect(projectBackendPluginActivationCatalog([...active.values()])).toEqual({
        schemaVersion: 1,
        packages: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears the prior activation before adding a replacement backend activation', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-same-session-replace-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => changes.push(change),
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      expect(
        await commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: [], restartRequired: true })
      const restartHandler = handlers.get('plugins:restart')
      if (!restartHandler) throw new Error('restart handler not registered')
      await restartHandler(null, { id: 'acme.demo' })
      changes.length = 0

      const replacement = buildBackendPkg('1.0.1')
      installFetch(
        signedDetail(replacement.digest, 'acme.demo', 'acme', '1.0.1'),
        replacement.bytes,
        replacement.digest,
      )
      await prepareHandler(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      expect(
        await commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: [], restartRequired: true })

      expect(changes).toEqual([])
      await restartHandler(null, { id: 'acme.demo' })
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({
        pluginId: 'acme.demo',
        activation: { packageVersion: '1.0.1', artifactDigest: replacement.digest },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores a factory backend when its first Registry replacement fails', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-factory-rollback-')))
    const factoryDir = join(root, 'factory')
    const pluginsDir = join(root, 'installed')
    mkdirSync(factoryDir)
    mkdirSync(pluginsDir)
    writeFileSync(join(factoryDir, 'index.html'), '<!doctype html>')
    writeFileSync(join(factoryDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.demo', name: 'Demo', version: '1.0.0',
      publisher: 'acme', permissions: {},
      marketplace: { description: 'Demo frontend', license: 'MIT' },
      contributes: { views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Demo', entry: 'index.html' }] },
    }))
    const manager = new FrontendPluginManager()
    expect(manager.loadFactoryPlugin(factoryDir, 'acme.demo')).toMatchObject({ loaded: true })
    const backend = {
      pluginId: 'acme.demo', packageVersion: '1.0.0', packageDir: factoryDir,
      entryFile: join(factoryDir, 'backend'), protocolVersion: 1 as const,
      activation: 'startup' as const, approvedMethods: ['fixture.echo'], approvedEvents: [],
    }
    manager.registerBackendActivation(backend)
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    try {
      registerPluginIpc(manager, pluginsDir, () => true, TRUST_CONFIG)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo' })
      vi.spyOn(defaultInstallerDeps, 'writeFile').mockImplementation(() => { throw new Error('write failed') })
      await expect(handlers.get('plugins:commitInstall')!(null, {
        id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true,
      })).rejects.toThrow('write failed')
      expect(manager.listInstalledPackages()[0].provenance).toBe('factory-bundled')
      expect(manager.getBackendActivation('acme.demo', '1.0.0')).toEqual(backend)
      expect(manager.getDescriptor('acme.demo')?.packageDir).toBe(factoryDir)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores an approved backend that has no installed-package summary after a failed install', async () => {
    const { bytes, digest } = buildBackendPkg()
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-install-backend-only-')))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      // A descriptor and an approved backend without an installed-package
      // summary: the shape the developer Plans v2 registration leaves behind.
      const packageDir = join(root, 'acme.demo')
      mkdirSync(packageDir, { recursive: true })
      manager.registerDescriptor({
        id: 'acme.demo', packageVersion: '1.0.0', packageDir,
        requires: [], devUrl: '', entryFile: join(packageDir, 'index.html'),
      })
      const backend = {
        pluginId: 'acme.demo', packageVersion: '1.0.0', packageDir,
        entryFile: join(packageDir, BACKEND_ENTRY_ON_DISK), protocolVersion: 1 as const,
        activation: 'startup' as const, approvedMethods: ['fixture.echo'], approvedEvents: [],
      }
      manager.registerBackendActivation(backend)
      expect(manager.listInstalledPackages()).toEqual([])

      installFetch(signedDetail(digest), bytes, digest)
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      vi.spyOn(defaultInstallerDeps, 'writeFile').mockImplementation(() => {
        throw new Error('test package write failure')
      })

      await expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).rejects.toThrow('test package write failure')
      expect(manager.hasBackendActivation('acme.demo', '1.0.0')).toBe(true)
      expect(manager.getBackendActivation('acme.demo', '1.0.0')).toEqual(backend)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['commit', 'remove'] as const)('rejects concurrent %s while preserving install rollback', async (operation) => {
    const original = buildBackendPkg()
    installFetch(signedDetail(original.digest), original.bytes, original.digest)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-install-concurrent-')))
    const manager = new FrontendPluginManager()
    const active = new Map<string, PluginActivationCatalogEntry>()
    let failVerification = false
    let release!: () => void
    let hold: Promise<void> | null = null
    let running: Promise<unknown> | undefined
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        cleanupPluginStorage: async () => undefined,
        onActivationChange: ({ pluginId, activation }) => {
          active.delete(pluginId)
          if (activation) active.set(pluginId, activation)
        },
        verifyCommittedInstall: () => ({ action: 'allow', artifactDigest: original.digest }),
        // Holds the commit open inside its transaction so a competing call can
        // be observed; the injected failure then exercises the rollback path.
        preflightCandidateBackend: async () => {
          if (hold) await hold
          if (failVerification) throw new Error('injected verification failure')
        },
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const args = { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true }
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, args)
      await restart(null, { id: 'acme.demo' })
      const descriptor = {
        id: 'acme.demo', packageVersion: '1.0.0', packageDir: join(root, 'acme.demo'),
        requires: [], devUrl: '', entryFile: join(root, 'acme.demo', 'index.html'),
      }
      manager.registerDescriptor(descriptor)
      const backend = {
        pluginId: 'acme.demo', packageVersion: '1.0.0', packageDir: descriptor.packageDir,
        entryFile: join(descriptor.packageDir, BACKEND_ENTRY_ON_DISK), protocolVersion: 1 as const,
        activation: 'startup' as const, approvedMethods: ['fixture.echo'], approvedEvents: [],
      }
      manager.registerBackendActivation(backend)
      const grant = new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')
      const replacement = buildBackendPkg('1.0.1')
      installFetch(signedDetail(replacement.digest, 'acme.demo', 'acme', '1.0.1'), replacement.bytes, replacement.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      hold = new Promise<void>((resolve) => { release = resolve })
      failVerification = true
      running = Promise.resolve(commit(null, args)).catch((error: unknown) => error)
      const competing = operation === 'commit'
        ? commit(null, args)
        : handlers.get('plugins:remove')!(null, { id: 'acme.demo' })
      await expect(competing).rejects.toThrow(/transaction already in progress/)
      release()
      expect(await running).toMatchObject({ message: 'injected verification failure' })
      expect(manager.getDescriptor('acme.demo')).toEqual(descriptor)
      expect(manager.getBackendActivation('acme.demo', '1.0.0')).toEqual(backend)
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')).toEqual(grant)
      expect(active.get('acme.demo')?.artifactDigest).toBe(original.digest)
      await expect(commit(null, args)).rejects.toThrow(/no prepared install/)
      failVerification = false
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await expect(commit(null, args)).resolves.toMatchObject({ id: 'acme.demo' })
    } finally {
      release?.()
      await running
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retains a new prepare during a transaction and allows another plugin to install', async () => {
    const pkg = buildPkg()
    installFetch(signedDetail(pkg.digest), pkg.bytes, pkg.digest)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-install-new-prepare-')))
    const manager = new FrontendPluginManager()
    let release!: () => void
    let hold: Promise<void> | null = null
    let running: Promise<unknown> | undefined
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        preflightCandidateFrontend: async (descriptor) => {
          if (descriptor.id === 'acme.demo' && hold) await hold
        },
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const args = { id: 'acme.demo', publisherConfirmed: true }
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, args)
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      const replacement = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(replacement.digest, 'acme.demo', 'acme', '1.0.1'), replacement.bytes, replacement.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      hold = new Promise<void>((resolve) => { release = resolve })
      running = Promise.resolve(commit(null, args))
      // A prepare arriving while the transaction is open is retained rather
      // than rejected, and another package's commit is not blocked by it.
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      const other = buildPkg('acme.other')
      installFetch(signedDetail(other.digest, 'acme.other'), other.bytes, other.digest)
      await prepare(null, { namespace: 'acme', name: 'other' })
      await expect(commit(null, { id: 'acme.other', publisherConfirmed: true }))
        .resolves.toMatchObject({ id: 'acme.other' })
      release()
      await running
      // The staged candidate is promoted before the next version can stage
      // beside it; the same version cannot be staged twice while referenced.
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      const final = buildPkg('acme.demo', 'acme', {}, '1.0.2')
      installFetch(signedDetail(final.digest, 'acme.demo', 'acme', '1.0.2'), final.bytes, final.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.2' })
      await expect(commit(null, args)).resolves.toMatchObject({ id: 'acme.demo' })
    } finally {
      release?.()
      await running
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects install during removal and releases the transaction after cleanup failure', async () => {
    const pkg = buildPkg()
    installFetch(signedDetail(pkg.digest), pkg.bytes, pkg.digest)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-remove-concurrent-install-')))
    const manager = new FrontendPluginManager()
    let rejectCleanup!: (error: Error) => void
    const cleanup = new Promise<void>((_resolve, reject) => { rejectCleanup = reject })
    let running: Promise<unknown> | undefined
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        cleanupPluginStorage: () => cleanup,
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const args = { id: 'acme.demo', publisherConfirmed: true }
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, args)
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      const replacement = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(replacement.digest, 'acme.demo', 'acme', '1.0.1'), replacement.bytes, replacement.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      running = Promise.resolve(handlers.get('plugins:remove')!(null, { id: 'acme.demo' }))
        .catch((error: unknown) => error)
      await expect(commit(null, args)).rejects.toThrow(/transaction already in progress/)
      rejectCleanup(new Error('cleanup unavailable'))
      expect(await running).toMatchObject({ message: 'cleanup unavailable' })
      await expect(commit(null, args)).resolves.toMatchObject({ id: 'acme.demo' })
    } finally {
      rejectCleanup(new Error('cleanup unavailable'))
      await running
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores a factory backend when its first Registry replacement fails', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-factory-rollback-')))
    const factoryDir = join(root, 'factory')
    const pluginsDir = join(root, 'installed')
    mkdirSync(factoryDir)
    mkdirSync(pluginsDir)
    writeFileSync(join(factoryDir, 'index.html'), '<!doctype html>')
    writeFileSync(join(factoryDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.demo', name: 'Demo', version: '1.0.0',
      publisher: 'acme', permissions: {},
      marketplace: { description: 'Demo frontend', license: 'MIT' },
      contributes: { views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Demo', entry: 'index.html' }] },
    }))
    const manager = new FrontendPluginManager()
    expect(manager.loadFactoryPlugin(factoryDir, 'acme.demo')).toMatchObject({ loaded: true })
    const backend = {
      pluginId: 'acme.demo', packageVersion: '1.0.0', packageDir: factoryDir,
      entryFile: join(factoryDir, 'backend'), protocolVersion: 1 as const,
      activation: 'startup' as const, approvedMethods: ['fixture.echo'], approvedEvents: [],
    }
    manager.registerBackendActivation(backend)
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    try {
      registerPluginIpc(manager, pluginsDir, () => true, TRUST_CONFIG)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo' })
      vi.spyOn(defaultInstallerDeps, 'writeFile').mockImplementation(() => { throw new Error('write failed') })
      await expect(handlers.get('plugins:commitInstall')!(null, {
        id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true,
      })).rejects.toThrow('write failed')
      expect(manager.listInstalledPackages()[0].provenance).toBe('factory-bundled')
      expect(manager.getBackendActivation('acme.demo', '1.0.0')).toEqual(backend)
      expect(manager.getDescriptor('acme.demo')?.packageDir).toBe(factoryDir)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores the previous install when post-commit verification throws after a replacement starts', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-post-commit-failure-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    let failVerification = false
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: ({ pluginId, activation }) => {
          active.delete(pluginId)
          if (activation) active.set(pluginId, activation)
        },
        verifyCommittedInstall: () => {
          if (failVerification) throw new Error('test post-commit verification failure')
          return { action: 'allow', artifactDigest: digest }
        },
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      const restartHandler = handlers.get('plugins:restart')
      if (!prepareHandler || !commitHandler || !restartHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      await expect(commitHandler(null, {
        id: 'acme.demo',
        publisherConfirmed: true,
        riskConfirmed: true,
      })).resolves.toMatchObject({ id: 'acme.demo' })
      await restartHandler(null, { id: 'acme.demo' })
      expect(active.has('acme.demo')).toBe(true)

      const replacement = buildBackendPkg('1.0.1')
      installFetch(signedDetail(replacement.digest, 'acme.demo', 'acme', '1.0.1'), replacement.bytes, replacement.digest)
      await prepareHandler(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      failVerification = true

      await expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).rejects.toThrow(/test post-commit verification failure/)
      expect(manager.listInstalledPackages()).toEqual([
        {
          id: 'acme.demo',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'official-registry',
        },
      ])
      expect(active.has('acme.demo')).toBe(true)
      expect(projectBackendPluginActivationCatalog([...active.values()]).packages).toEqual([
        expect.objectContaining({
          pluginId: 'acme.demo',
          packageDir: immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'),
          artifactDigest: digest,
        }),
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The Registry install path is Manifest v2 only: legacy v1 packages carry no
  // activation to stage, so the v2 frontend-only replacement is the case the
  // immutable lifecycle can exercise.
  it('clears a prior backend activation when replaced by a v2 frontend-only package', async () => {
    const backend = buildBackendPkg()
    installFetch(signedDetail(backend.digest), backend.bytes, backend.digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-same-session-downgrade-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => {
          changes.push(change)
          active.delete(change.pluginId)
          if (change.activation) active.set(change.pluginId, change.activation)
        },
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      const restartHandler = handlers.get('plugins:restart')
      if (!prepareHandler || !commitHandler || !restartHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      await commitHandler(null, {
        id: 'acme.demo',
        publisherConfirmed: true,
        riskConfirmed: true,
      })
      await restartHandler(null, { id: 'acme.demo' })
      expect(active.get('acme.demo')?.backend).toBeDefined()
      changes.length = 0

      const replacement = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(replacement.digest, 'acme.demo', 'acme', '1.0.1'), replacement.bytes, replacement.digest)
      await prepareHandler(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await expect(commitHandler(null, { id: 'acme.demo' })).resolves.toMatchObject({ id: 'acme.demo' })
      await restartHandler(null, { id: 'acme.demo' })

      expect(changes).toEqual([expect.objectContaining({ pluginId: 'acme.demo' })])
      expect(active.get('acme.demo')?.backend).toBeUndefined()
      expect(projectBackendPluginActivationCatalog([...active.values()])).toEqual({
        schemaVersion: 1,
        packages: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('installs a legacy v1 replacement immediately and clears its staged selection', async () => {
    const backend = buildBackendPkg()
    installFetch(signedDetail(backend.digest), backend.bytes, backend.digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-legacy-downgrade-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => {
          changes.push(change)
          active.delete(change.pluginId)
          if (change.activation) active.set(change.pluginId, change.activation)
        },
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      const restartHandler = handlers.get('plugins:restart')
      if (!prepareHandler || !commitHandler || !restartHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      await commitHandler(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restartHandler(null, { id: 'acme.demo' })
      expect(active.get('acme.demo')?.backend).toBeDefined()
      expect(new PluginActivationSelector(root).read('acme.demo')).not.toBeNull()
      changes.length = 0

      const legacy = buildLegacyPkg()
      installFetch(signedDetail(legacy.digest), legacy.bytes, legacy.digest)
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })

      // Manifest v1 carries no activation to stage, so the commit installs the
      // mutable package and clears the prior backend activation in one step.
      await expect(
        commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).resolves.toEqual({ id: 'acme.demo', requires: [] })
      expect(changes).toEqual([{ pluginId: 'acme.demo' }])
      expect(active.has('acme.demo')).toBe(false)
      expect(projectBackendPluginActivationCatalog([...active.values()])).toEqual({
        schemaVersion: 1,
        packages: [],
      })
      expect(manager.listInstalledPackages()).toEqual([
        expect.objectContaining({ id: 'acme.demo', requires: [] }),
      ])
      expect(manager.listInstalledPackages()[0]?.packageVersion).toBeUndefined()
      // The v1 write replaced `<root>/acme.demo`, so the record that pointed at
      // the promoted v2 candidate must not survive.
      expect(new PluginActivationSelector(root).read('acme.demo')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the active package selected when candidate verification fails', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-candidate-verification-failure-'))
    let rejectCandidate = false
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        verifyCommittedInstall: (pluginDir): InstalledTrustDecision => {
          const candidate = pluginDir.includes(`1.0.1${sep}`)
          if (rejectCandidate && candidate) {
            return { action: 'quarantine', reason: 'candidate verification failure' }
          }
          return {
            action: 'allow',
            artifactDigest: candidate ? second.digest : first.digest,
          }
        },
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })

      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      rejectCandidate = true
      await expect(commit(null, { id: 'acme.demo', publisherConfirmed: true }))
        .rejects.toThrow(/staged candidate quarantined/)
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.0')
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0', artifactDigest: first.digest },
      })
      expect(new PluginActivationSelector(root).read('acme.demo')?.candidate).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not project a quarantined same-session backend activation', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-same-session-quarantine-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: ({ pluginId, activation }) => {
          active.delete(pluginId)
          if (activation) active.set(pluginId, activation)
        },
        verifyCommittedInstall: () => ({
          action: 'quarantine',
          reason: 'test quarantine',
        }),
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      await expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).rejects.toThrow(/staged candidate quarantined/)
      expect(projectBackendPluginActivationCatalog([...active.values()])).toEqual({
        schemaVersion: 1,
        packages: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('carries Official Registry authority through post-commit verification', async () => {
    const { bytes, digest } = buildPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-official-post-commit-'))
    const previousUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, {
        ...TRUST_CONFIG,
        registryAuthority: 'official',
        officialRegistryUrl: 'https://server.navide.dev/registry',
      }, undefined, { ...TEST_PREFLIGHT_OPTIONS })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')
      const prepared = (await prepareHandler(null, { namespace: 'acme', name: 'demo' })) as {
        requiresPublisherTrust: boolean
      }
      expect(prepared.requiresPublisherTrust).toBe(true)
      expect(
        await commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).toEqual({ id: 'acme.demo', requires: [], restartRequired: true })
      const restartHandler = handlers.get('plugins:restart')
      if (!restartHandler) throw new Error('restart handler not registered')
      await restartHandler(null, { id: 'acme.demo' })
      expect(manager.listInstalledPackages()).toEqual([
        {
          id: 'acme.demo',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'official-registry',
        },
      ])
    } finally {
      if (previousUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
      else process.env['AGENT_TEAM_MARKETPLACE_URL'] = previousUrl
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not require publisher consent for an authorized first-party identity', async () => {
    const { bytes, digest } = buildReservedPkg()
    const detail = signedDetail(digest, 'navide.spoof', 'navide')
    installFetch(detail, bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-official-publisher-trust-'))
    const previousUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, {
        ...TRUST_CONFIG,
        registryAuthority: 'official',
        officialRegistryUrl: 'https://server.navide.dev/registry',
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      if (!prepareHandler) throw new Error('prepareInstall handler not registered')
      const prepared = (await prepareHandler(null, {
        namespace: 'navide',
        name: 'spoof',
      })) as { requiresPublisherTrust: boolean }
      expect(prepared.requiresPublisherTrust).toBe(false)
    } finally {
      if (previousUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
      else process.env['AGENT_TEAM_MARKETPLACE_URL'] = previousUrl
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-verifies committed files before registration and quarantines tampering', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-post-commit-'))
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(
        manager,
        root,
        () => true,
        TRUST_CONFIG,
        undefined,
        {
          ...TEST_PREFLIGHT_OPTIONS,
          verifyCommittedInstall: (pluginDir, pluginId, trust) => {
            writeFileSync(join(pluginDir, 'backend', 'entry'), 'tampered after commit')
            return verifyInstalledRegistryPackage(pluginDir, pluginId, {
              pinnedRootKey: trust.pinnedRegistryRootKey,
              snapshot: readRegistryTrustSnapshot(root),
              now: trust.now,
            })
          },
        }
      )
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })

      await expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).rejects.toThrow(/installed package file was modified/)
      expect(manager.listInstalledPackages()).toEqual([])
      expect(existsSync(join(root, 'acme.demo', '.navide-package.zip'))).toBe(false)
      expect(existsSync(join(root, '.navide-quarantine'))).toBe(false)
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not resurrect a package when trust expires after prepare', async () => {
    const { bytes, digest } = buildPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-expired-after-prepare-'))
    const installTrust: InstallerTrustConfig = { ...TRUST_CONFIG, now: new Date(FIXED_NOW) }
    try {
      const manager = new FrontendPluginManager()
      const controller = registerPluginIpc(manager, root, () => true, installTrust)
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      installTrust.now = new Date('2026-08-18T12:00:00.000Z')
      await expect(
        commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).rejects.toThrow(/expired/)
      expect(manager.listInstalledPackages()).toEqual([])
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'))).toBe(true)
      expect(new PluginActivationSelector(root).read('acme.demo')?.candidate).toBeUndefined()

      await expect(controller.refreshRegistryTrust()).rejects.toThrow(/expired/)
      expect(manager.listInstalledPackages()).toEqual([])
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an expired-cache package inactive until online refresh restores it', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-'))
    try {
      await installRegistryEvidence(root, bytes, digest)
      writeExpiredTrustSnapshot(root)
      const manager = new FrontendPluginManager()
      const expiredLoad = manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      expect(expiredLoad.activationCatalog).toEqual([])
      expect(manager.listInstalledPackages()).toEqual([])

      const detail = signedDetail(digest)
      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        async json() {
          return detail
        },
      })) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed.decisions).toEqual([
        { pluginId: 'acme.demo', action: 'allow', artifactDigest: digest },
      ])
      expect(refreshed.activationCatalog).toHaveLength(1)
      expect(manager.listInstalledPackages()).toEqual([
        {
          id: 'acme.demo',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'official-registry',
        },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves an expired-cache package quarantined when trust refresh fails', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-fail-'))
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      expect(manager.listInstalledPackages()).toEqual([
        {
          id: 'acme.demo',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'official-registry',
        },
      ])
      writeExpiredTrustSnapshot(root)
      global.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      await expect(controller.refreshRegistryTrust()).rejects.toThrow(/HTTP 503/)
      expect(manager.listInstalledPackages()).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an active package while a still-valid cached snapshot survives refresh failure', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-cache-'))
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      global.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      await expect(controller.refreshRegistryTrust()).rejects.toThrow(/HTTP 503/)
      expect(manager.listInstalledPackages()).toEqual([
        {
          id: 'acme.demo',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'official-registry',
        },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips an expired HTTP 200 candidate and accepts the next valid candidate', async () => {
    const first = buildPkg()
    const second = buildPkg('beta.other', 'beta')
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-invalid-candidate-'))
    try {
      await installRegistryEvidence(root, first.bytes, first.digest)
      await installRegistryEvidence(
        root,
        second.bytes,
        second.digest,
        signedDetail(second.digest, 'beta.other', 'beta'),
        'beta',
        'other'
      )
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      const validFirst = signedDetail(first.digest)
      const expiredMetadata: RegistryTrustMetadata = {
        ...validFirst.trust_metadata,
        generatedAt: '2026-08-14T10:00:00.000Z',
        expiresAt: '2026-08-15T10:00:00.000Z',
      }
      const expiredFirst: WireDetail = {
        ...validFirst,
        trust_metadata: expiredMetadata,
        trust_metadata_signature: signCanonical(expiredMetadata, registryRoot.privateKey),
      }
      const validSecond = signedDetail(second.digest, 'beta.other', 'beta')
      global.fetch = vi.fn(async (url: unknown) => {
        if (String(url).includes('/api/extensions/acme/demo')) {
          return { ok: true, status: 200, async json() { return expiredFirst } }
        }
        return { ok: true, status: 200, async json() { return validSecond } }
      }) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      const refreshed = await controller.refreshRegistryTrust()
      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(refreshed.decisions).toEqual([
        { pluginId: 'acme.demo', action: 'allow', artifactDigest: first.digest },
        { pluginId: 'beta.other', action: 'allow', artifactDigest: second.digest },
      ])
      expect(readRegistryTrustSnapshot(root)?.metadata).toEqual(validSecond.trust_metadata)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('continues trust metadata refresh when the first installed package detail is missing', async () => {
    const first = buildPkg()
    const second = buildPkg('beta.other', 'beta')
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-candidates-'))
    try {
      await installRegistryEvidence(root, first.bytes, first.digest)
      await installRegistryEvidence(
        root,
        second.bytes,
        second.digest,
        signedDetail(second.digest, 'beta.other', 'beta'),
        'beta',
        'other'
      )
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      const detail = signedDetail(second.digest, 'beta.other', 'beta')
      global.fetch = vi.fn(async (url: unknown) => {
        if (String(url).includes('/api/extensions/acme/demo')) {
          return { ok: false, status: 404 }
        }
        return { ok: true, status: 200, async json() { return detail } }
      }) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      const refreshed = await controller.refreshRegistryTrust()
      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(refreshed.decisions).toEqual([
        { pluginId: 'acme.demo', action: 'allow', artifactDigest: first.digest },
        { pluginId: 'beta.other', action: 'allow', artifactDigest: second.digest },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('quarantines an active Registry package whose directory disappeared without a network candidate', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-missing-dir-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      rmSync(join(root, 'acme.demo'), { recursive: true, force: true })
      global.fetch = vi.fn() as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed.decisions).toMatchObject([
        {
          pluginId: 'acme.demo',
          action: 'quarantine',
          reason: expect.stringMatching(/missing/),
        },
      ])
      expect(global.fetch).not.toHaveBeenCalled()
      expect(manager.listInstalledPackages()).toEqual([])
      expect(changes).toEqual([{ pluginId: 'acme.demo' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('quarantines an active Registry package with a malformed manifest before refresh', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-malformed-manifest-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      writeFileSync(
        join(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'), 'manifest.json'),
        '{malformed',
      )
      global.fetch = vi.fn() as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed.decisions).toMatchObject([
        {
          pluginId: 'acme.demo',
          action: 'quarantine',
          reason: expect.stringMatching(/malformed/),
        },
      ])
      expect(global.fetch).not.toHaveBeenCalled()
      expect(manager.listInstalledPackages()).toEqual([])
      expect(changes).toEqual([{ pluginId: 'acme.demo' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reconciles active Registry state even when there are zero safe candidates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-zero-candidates-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      const manager = new FrontendPluginManager()
      manager.registerInstalledPackage({
        id: 'acme.orphan',
        requires: [],
        provenance: 'official-registry',
      })
      global.fetch = vi.fn() as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed).toMatchObject({
        decisions: [
          {
            pluginId: 'acme.orphan',
            action: 'quarantine',
          },
        ],
        activationCatalog: [],
      })
      expect(global.fetch).not.toHaveBeenCalled()
      expect(manager.listInstalledPackages()).toEqual([])
      expect(changes).toEqual([{ pluginId: 'acme.orphan' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a valid active Registry package after trust refresh', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-valid-active-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      const detail = signedDetail(digest)
      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        async json() {
          return detail
        },
      })) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed.decisions).toEqual([
        { pluginId: 'acme.demo', action: 'allow', artifactDigest: digest },
      ])
      expect(manager.listInstalledPackages()).toEqual([
        {
          id: 'acme.demo',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'official-registry',
        },
      ])
      expect(changes).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('plugins:marketplaceDetail / plugins:checkUpdates', () => {
  const savedFetch = global.fetch
  const savedMarketplaceUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
  beforeEach(() => {
    handlers.clear()
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
  })
  afterEach(() => {
    global.fetch = savedFetch
    if (savedMarketplaceUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    else process.env['AGENT_TEAM_MARKETPLACE_URL'] = savedMarketplaceUrl
    vi.restoreAllMocks()
  })

  function respond(routes: Record<string, { status?: number; body?: unknown } | Error>) {
    const fetchMock = vi.fn(async (url: unknown) => {
      const route = routes[String(url)]
      if (route instanceof Error) throw route
      if (!route) return { ok: false, status: 404, async json() { return {} } }
      const status = route.status ?? 200
      return { ok: status < 400, status, async json() { return route.body } }
    })
    global.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  const BASE = 'https://server.navide.dev/registry/api/extensions'

  it('returns display fields plus the raw README and never forwards trust material', async () => {
    respond({
      [`${BASE}/acme/demo`]: {
        body: {
          namespace: 'acme',
          name: 'demo',
          identity: 'acme.demo',
          display_name: 'Demo',
          description: 'd',
          categories: ['tools'],
          latest_version: '1.1.0',
          updated_at: '2026-09-01T00:00:00Z',
          download_count: 3,
          rating_average: 4,
          rating_count: 1,
          featured: false,
          publisher: 'acme',
          trust_metadata: { secret: true },
          trust_metadata_signature: 'sig',
          versions: [
            {
              version: '1.1.0',
              published_at: '2026-09-01T00:00:00Z',
              target: 'universal',
              yanked: false,
              trust_tier: 'signed-verified',
              capabilities: ['fs'],
              sensitive_capabilities: ['fs'],
              download_count: 3,
              registry_envelope: { a: 1 },
              registry_signature: 'x',
              package_digest: 'd',
              disclosure: { schemaVersion: 1, plugin: { id: 'acme.demo' } },
              disclosure_envelope: { a: 2 },
              disclosure_signature: 'y',
              scan: { schemaVersion: 1 },
              registry: { publisher: { verifiedDomain: 'acme.example' } },
            },
          ],
        },
      },
      [`${BASE}/acme/demo/readme`]: { body: { version: '1.1.0', markdown: '# Demo' } },
    })
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG)
    const detail = (await handlers.get('plugins:marketplaceDetail')!(null, {
      namespace: 'acme',
      name: 'demo',
    })) as Record<string, unknown> & { versions: Array<Record<string, unknown>> }
    expect(detail.readme).toBe('# Demo')
    expect(detail.publisher).toBe('acme')
    expect(detail).not.toHaveProperty('trust_metadata')
    expect(detail).not.toHaveProperty('trust_metadata_signature')
    expect(detail.versions[0]).not.toHaveProperty('registry_envelope')
    expect(detail.versions[0]).not.toHaveProperty('registry_signature')
    // Contract 3.5: display data is carried; the signed envelopes stay main-side.
    expect(detail.versions[0]).not.toHaveProperty('disclosure_envelope')
    expect(detail.versions[0]).not.toHaveProperty('disclosure_signature')
    expect(detail.versions[0].disclosure).toEqual({ schemaVersion: 1, plugin: { id: 'acme.demo' } })
    expect(detail.versions[0].scan).toEqual({ schemaVersion: 1 })
    expect(detail.versions[0].registry).toEqual({ publisher: { verifiedDomain: 'acme.example' } })
    expect(detail.versions[0].capabilities).toEqual(['fs'])
    expect(detail.versions[0].installable).toBe(true)
    expect(detail.latest_installable_version).toBe('1.1.0')
    expect(detail.host_target).toBe(`${process.platform}-${process.arch}`)
  })

  it('tolerates a Registry without the README endpoint and rejects bad identifiers', async () => {
    respond({
      [`${BASE}/acme/demo`]: { body: { namespace: 'acme', name: 'demo', versions: [] } },
    })
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG)
    const handler = handlers.get('plugins:marketplaceDetail')!
    const detail = (await handler(null, { namespace: 'acme', name: 'demo' })) as { readme: unknown }
    expect(detail.readme).toBeNull()
    await expect(handler(null, { namespace: '', name: 'demo' })).rejects.toThrow(/invalid/)
    await expect(handler(null, { namespace: 'acme', name: 7 })).rejects.toThrow(/invalid/)
  })

  it('reports only strictly newer Registry versions of official-registry packages', async () => {
    const row = (version: string, target = 'universal', yanked = false) => ({ version, target, yanked })
    const host = `${process.platform}-${process.arch}`
    const other = host === 'win32-x64' ? 'linux-x64' : 'win32-x64'
    const fetchMock = respond({
      [`${BASE}/acme/old`]: { body: { versions: [row('1.2.0'), row('1.0.0')] } },
      [`${BASE}/acme/current`]: { body: { versions: [row('1.0.0')] } },
      [`${BASE}/acme/offline`]: new Error('network down'),
      // A newer release published only for another platform is not an update
      // here; the newest release for this Host is.
      [`${BASE}/acme/split`]: {
        body: {
          latest_version: '3.0.0',
          versions: [row('3.0.0', other), row('2.5.0', 'universal', true), row('2.0.0', host), row('1.0.0')],
        },
      },
      [`${BASE}/acme/elsewhere`]: { body: { latest_version: '9.0.0', versions: [row('9.0.0', other)] } },
    })
    const manager = {
      listInstalledPackages: () => [
        { id: 'acme.old', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.current', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.offline', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.split', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.elsewhere', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.local', requires: [], packageVersion: '0.1.0', provenance: 'developer-local-unpacked' },
      ],
    } as unknown as FrontendPluginManager
    registerPluginIpc(manager, '/plugins', () => true, TRUST_CONFIG)
    // acme.offline did not answer: the check rejects naming it (a deliberate
    // change, so an unreachable Registry no longer reads as "no updates"),
    // and the updates found for the others are still kept.
    await expect(handlers.get('plugins:checkUpdates')!(null)).rejects.toThrow(/acme\.offline \(network down\)/)
    expect(await handlers.get('plugins:pendingUpdates')!(null)).toEqual([
      { id: 'acme.old', namespace: 'acme', name: 'old', installedVersion: '1.0.0', latestVersion: '1.2.0' },
      { id: 'acme.split', namespace: 'acme', name: 'split', installedVersion: '1.0.0', latestVersion: '2.0.0' },
    ])
    // Developer-local packages are never looked up in the Registry.
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain(`${BASE}/acme/local`)
  })

  it('exposes the check on the refresh controller and caches it for pendingUpdates', async () => {
    respond({
      [`${BASE}/acme/old`]: { body: { versions: [{ version: '1.2.0', target: 'universal', yanked: false }] } },
    })
    const manager = {
      listInstalledPackages: () => [
        { id: 'acme.old', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ],
    } as unknown as FrontendPluginManager
    const controller = registerPluginIpc(manager, '/plugins', () => true, TRUST_CONFIG)
    expect(await handlers.get('plugins:pendingUpdates')!(null)).toEqual([])
    const updates = await controller.checkUpdates()
    expect(updates).toHaveLength(1)
    // The cached answer needs no network round trip.
    respond({})
    expect(await handlers.get('plugins:pendingUpdates')!(null)).toEqual(updates)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('keeps the last known updates when the Registry is unreachable', async () => {
    respond({
      [`${BASE}/acme/old`]: { body: { versions: [{ version: '1.2.0', target: 'universal', yanked: false }] } },
    })
    const manager = {
      listInstalledPackages: () => [
        { id: 'acme.old', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ],
    } as unknown as FrontendPluginManager
    const controller = registerPluginIpc(manager, '/plugins', () => true, TRUST_CONFIG)
    const found = await controller.checkUpdates()
    expect(found).toHaveLength(1)

    respond({ [`${BASE}/acme/old`]: { status: 503 } })
    await expect(controller.checkUpdates()).rejects.toThrow(/acme\.old \(HTTP 503\)/)
    expect(await handlers.get('plugins:pendingUpdates')!(null)).toEqual(found)

    respond({ [`${BASE}/acme/old`]: new Error('network down') })
    await expect(handlers.get('plugins:checkUpdates')!(null)).rejects.toThrow(/acme\.old \(network down\)/)
    expect(await handlers.get('plugins:pendingUpdates')!(null)).toEqual(found)
  })

  it('updates the packages that answered and keeps the last answer for the ones that failed', async () => {
    const row = (version: string) => ({ version, target: 'universal', yanked: false })
    respond({
      [`${BASE}/acme/a`]: { body: { versions: [row('1.2.0')] } },
      [`${BASE}/acme/b`]: { body: { versions: [row('2.1.0')] } },
    })
    const manager = {
      listInstalledPackages: () => [
        { id: 'acme.a', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.b', requires: [], packageVersion: '2.0.0', provenance: 'official-registry' },
      ],
    } as unknown as FrontendPluginManager
    const controller = registerPluginIpc(manager, '/plugins', () => true, TRUST_CONFIG)
    await controller.checkUpdates()

    respond({
      [`${BASE}/acme/a`]: { body: { versions: [row('1.3.0')] } },
      [`${BASE}/acme/b`]: { status: 500 },
    })
    const expected = [
      { id: 'acme.a', namespace: 'acme', name: 'a', installedVersion: '1.0.0', latestVersion: '1.3.0' },
      { id: 'acme.b', namespace: 'acme', name: 'b', installedVersion: '2.0.0', latestVersion: '2.1.0' },
    ]
    const failure = controller.checkUpdates()
    await expect(failure).rejects.toThrow(/acme\.b \(HTTP 500\)/)
    await expect(failure).rejects.not.toThrow(/acme\.a/)
    expect(await handlers.get('plugins:pendingUpdates')!(null)).toEqual(expected)
  })

  it('rejects unauthorized senders before any network request', async () => {
    const fetchMock = respond({})
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => false, TRUST_CONFIG)
    for (const channel of ['plugins:marketplaceDetail', 'plugins:checkUpdates', 'plugins:pendingUpdates']) {
      await expect(
        Promise.resolve().then(() => handlers.get(channel)!(null, { namespace: 'a', name: 'b' }))
      ).rejects.toThrow(/unauthorized/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards only a known sort to the search endpoint', async () => {
    const host = `${process.platform}-${process.arch}`
    const fetchMock = respond({})
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          items: [
            { identity: 'a.universal', latest_targets: ['universal'] },
            { identity: 'a.host', latest_targets: [host] },
            { identity: 'a.other', latest_targets: ['plan9-mips'] },
            { identity: 'a.legacy' },
          ],
        }
      },
    }))
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG)
    const search = handlers.get('plugins:marketplaceSearch')!
    const result = (await search(null, undefined, 'downloads')) as {
      items: Array<{ identity: string; installable: boolean }>
    }
    // Compatibility is decided main-side with the install rule; a Registry
    // without per-target data stays installable.
    expect(result.items.map((i) => [i.identity, i.installable])).toEqual([
      ['a.universal', true],
      ['a.host', true],
      ['a.other', false],
      ['a.legacy', true],
    ])
    await search(null, undefined, 'evil&x=1')
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      `${BASE}?sort=downloads`,
      BASE,
    ])
  })
})

describe('Marketplace discovery (Phase 1)', () => {
  const savedFetch = global.fetch
  const savedMarketplaceUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
  beforeEach(() => {
    handlers.clear()
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
  })
  afterEach(() => {
    global.fetch = savedFetch
    if (savedMarketplaceUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    else process.env['AGENT_TEAM_MARKETPLACE_URL'] = savedMarketplaceUrl
    vi.restoreAllMocks()
  })

  const ROOT = 'https://server.navide.dev/registry'

  function jsonFetch(body: unknown, status = 200) {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => ({
      ok: status < 400,
      status,
      async json() {
        return body
      },
    }))
    global.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  function bytesFetch(bytes: Uint8Array, contentLength?: number) {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => ({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'content-length' && contentLength !== undefined ? String(contentLength) : null,
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      },
    }))
    global.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  const registerAll = (): void => {
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG, undefined, {
      appVersion: () => '0.2.13',
    })
  }

  it('computes compatibility main-side and keeps only https links', async () => {
    jsonFetch({
      items: [
        { identity: 'a.old', engines_navide: '^0.1.0', repository: 'https://x.test/r', license: 'MIT' },
        { identity: 'a.new', engines_navide: '>=0.3.0', repository: 'javascript:alert(1)' },
        { identity: 'a.none', homepage: 'http://plain.test' },
      ],
      total: 3,
    })
    registerAll()
    const result = (await handlers.get('plugins:marketplaceSearch')!(null)) as {
      items: Array<Record<string, unknown>>
    }
    const byId = Object.fromEntries(result.items.map((item) => [item.identity, item]))
    expect(byId['a.old']).toMatchObject({ compatible: true, min_navide_version: '0.1.0', app_version: '0.2.13' })
    expect(byId['a.old']).toMatchObject({ repository: 'https://x.test/r', license: 'MIT' })
    expect(byId['a.new']).toMatchObject({ compatible: false, min_navide_version: '0.3.0', repository: null })
    expect(byId['a.none']).toMatchObject({ compatible: null, homepage: null, license: null, icon_path: null })
  })

  it('keeps a listing disclosure only when it is well formed and names that item (D1 list card)', async () => {
    const disclosed = (id: string, version: string) => computeDisclosure({
      schemaVersion: 2, id, version, publisher: id.split('.')[0], permissions: { shell: 'allowlist' },
    } as never)
    jsonFetch({
      items: [
        { identity: 'a.ok', namespace: 'a', name: 'ok', latest_version: '1.0.0', disclosure: disclosed('a.ok', '1.0.0'), scan: null },
        { identity: 'a.other', namespace: 'a', name: 'other', latest_version: '1.0.0', disclosure: disclosed('evil.x', '1.0.0') },
        { identity: 'a.bad', namespace: 'a', name: 'bad', latest_version: '1.0.0', disclosure: { plugin: 'IGNORE' }, scan: { x: 1 } },
        { identity: 'a.none', namespace: 'a', name: 'none', latest_version: '1.0.0' },
      ],
      total: 4,
    })
    registerAll()
    const result = (await handlers.get('plugins:marketplaceSearch')!(null)) as {
      items: Array<Record<string, unknown>>
    }
    const byId = Object.fromEntries(result.items.map((item) => [item.identity, item]))
    expect(byId['a.ok']).toMatchObject({ disclosure: disclosed('a.ok', '1.0.0'), scan: null })
    for (const id of ['a.other', 'a.bad', 'a.none']) expect(byId[id]).toMatchObject({ disclosure: null, scan: null })
  })

  it('D-f: the list risk is the highest platform level and says when platforms differ', async () => {
    const ui = computeDisclosure({ schemaVersion: 2, id: 'a.multi', version: '1.0.0', publisher: 'a', permissions: { system: ['ui'] } } as never)
    jsonFetch({
      items: [
        { identity: 'a.multi', namespace: 'a', name: 'multi', latest_version: '1.0.0', disclosure: ui, scan: null,
          risk_by_target: { 'darwin-arm64': 'low', 'linux-x64': 'high' } },
        { identity: 'a.same', namespace: 'a', name: 'same', latest_version: '1.0.0',
          disclosure: { ...ui, plugin: { ...ui.plugin, id: 'a.same' } }, scan: null, risk_by_target: { universal: 'low' } },
        { identity: 'a.bad', namespace: 'a', name: 'bad', latest_version: '1.0.0',
          disclosure: { ...ui, plugin: { ...ui.plugin, id: 'a.bad' } }, scan: null, risk_by_target: { x: 'IGNORE' } },
        // A Registry newer than this App: unknown fields are ignored.
        { identity: 'a.future', namespace: 'a', name: 'future', latest_version: '1.0.0', future_field: { x: 1 },
          disclosure: { ...ui, plugin: { ...ui.plugin, id: 'a.future' } }, scan: null },
      ],
      total: 4,
    })
    registerAll()
    const result = (await handlers.get('plugins:marketplaceSearch')!(null)) as {
      items: Array<Record<string, unknown>>
    }
    const byId = Object.fromEntries(result.items.map((item) => [item.identity, item]))
    expect(byId['a.multi'].listRisk).toEqual({ level: 'high', variesByPlatform: true })
    expect(byId['a.same'].listRisk).toEqual({ level: 'low', variesByPlatform: false })
    // A malformed map is dropped; the level still comes from the disclosure.
    expect(byId['a.bad'].listRisk).toEqual({ level: 'low', variesByPlatform: false })
    expect(byId['a.future'].listRisk).toEqual({ level: 'low', variesByPlatform: false })
    expect(byId['a.future'].disclosure).toEqual({ ...ui, plugin: { ...ui.plugin, id: 'a.future' } })
  })

  it('forwards category, paging and the hide-incompatible filter', async () => {
    const fetchMock = jsonFetch({ items: [], total: 0 })
    registerAll()
    const search = handlers.get('plugins:marketplaceSearch')!
    await search(null, 'git', 'downloads', { category: 'version-control', offset: 40, limit: 20, hideIncompatible: true })
    await search(null, undefined, undefined, { category: 'Bad Slug&x=1', offset: -5, limit: 1000 })
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      `${ROOT}/api/extensions?q=git&sort=downloads&category=version-control&offset=40&limit=20&navide_version=0.2.13&compatible_only=true`,
      `${ROOT}/api/extensions?limit=100`,
    ])
  })

  it('lists the closed categories and tolerates a Registry without them', async () => {
    jsonFetch({ items: [{ slug: 'ai', label: 'AI', count: 2 }, { slug: 'BAD SLUG', label: 'x', count: 1 }] })
    registerAll()
    expect(await handlers.get('plugins:marketplaceCategories')!(null)).toEqual([
      { slug: 'ai', label: 'AI', count: 2 },
    ])
    jsonFetch({}, 404)
    expect(await handlers.get('plugins:marketplaceCategories')!(null)).toEqual([])
  })

  it('returns a raster icon as a data URL, fetched without redirects', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const fetchMock = bytesFetch(png)
    registerAll()
    const icon = await handlers.get('plugins:marketplaceIcon')!(null, {
      namespace: 'acme',
      name: 'demo',
      version: '1.0.0',
      path: 'assets/icon.png',
    })
    expect(icon).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${ROOT}/extensions/acme/demo/1.0.0/assets/assets/icon.png`
    )
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ redirect: 'error' })
  })

  it('refuses SVG, oversized and unsafe-path icons', async () => {
    registerAll()
    const icon = handlers.get('plugins:marketplaceIcon')!
    bytesFetch(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))
    expect(await icon(null, { namespace: 'acme', name: 'demo', version: '1.0.0', path: 'icon.svg' })).toBeNull()
    const big = new Uint8Array(MARKETPLACE_ICON_MAX_BYTES + 1)
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    bytesFetch(big)
    expect(await icon(null, { namespace: 'acme', name: 'demo', version: '1.0.0', path: 'big.png' })).toBeNull()
    const declaredBig = bytesFetch(new Uint8Array([0x89, 0x50]), MARKETPLACE_ICON_MAX_BYTES + 1)
    expect(await icon(null, { namespace: 'acme', name: 'demo', version: '1.0.0', path: 'decl.png' })).toBeNull()
    expect(declaredBig).toHaveBeenCalledTimes(1)
    const unsafe = bytesFetch(new Uint8Array([0x89]))
    for (const path of ['../secret.png', 'a/../../b.png', '/abs.png', 'a\\b.png', 'x?.png']) {
      expect(await icon(null, { namespace: 'acme', name: 'demo', version: '1.0.0', path })).toBeNull()
    }
    expect(await icon(null, { namespace: 'acme', name: 'demo', version: 'latest', path: 'i.png' })).toBeNull()
    expect(unsafe).not.toHaveBeenCalled()
  })

  function streamFetch(chunks: Uint8Array[], contentLength?: number) {
    const pulled: number[] = []
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[pulled.length]
        if (!next) {
          controller.close()
          return
        }
        pulled.push(next.byteLength)
        controller.enqueue(next)
      },
      cancel() {
        cancelled = true
      },
    })
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => ({
      ok: true,
      status: 200,
      body,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'content-length' && contentLength !== undefined ? String(contentLength) : null,
      },
      async arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error('the icon body must be streamed, not buffered whole')
      },
    }))
    global.fetch = fetchMock as unknown as typeof fetch
    return { pulled, isCancelled: () => cancelled }
  }

  it('stops reading a chunked icon body as soon as it passes the cap', async () => {
    registerAll()
    const chunk = new Uint8Array(64 * 1024)
    chunk.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // 40 chunks (2.5 MiB) with no Content-Length.
    const stream = streamFetch(Array.from({ length: 40 }, () => chunk))
    const icon = await handlers.get('plugins:marketplaceIcon')!(null, {
      namespace: 'acme',
      name: 'demo',
      version: '1.0.0',
      path: 'chunked.png',
    })
    expect(icon).toBeNull()
    // Cap/chunk (4) plus the chunk that crosses it, plus one the stream queues
    // ahead of the reader: 6 of the 40.
    expect(stream.pulled.length).toBeLessThanOrEqual(Math.ceil(MARKETPLACE_ICON_MAX_BYTES / chunk.byteLength) + 2)
    expect(stream.isCancelled()).toBe(true)
  })

  it('assembles a small chunked icon', async () => {
    registerAll()
    const head = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const tail = new Uint8Array([0x0d, 0x0a, 0x1a, 0x0a, 9])
    streamFetch([head, tail])
    const icon = await handlers.get('plugins:marketplaceIcon')!(null, {
      namespace: 'acme',
      name: 'demo',
      version: '1.0.0',
      path: 'small.png',
    })
    expect(icon).toBe(`data:image/png;base64,${Buffer.from([...head, ...tail]).toString('base64')}`)
  })

  it('reads the changelog as text', async () => {
    const fetchMock = jsonFetch({ version: '1.0.0', markdown: '# 1.0.0' })
    registerAll()
    expect(await handlers.get('plugins:marketplaceChangelog')!(null, { namespace: 'acme', name: 'demo' })).toBe(
      '# 1.0.0'
    )
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${ROOT}/api/extensions/acme/demo/changelog`)
  })

  it('marks per-version compatibility and the newest compatible version in the detail', async () => {
    jsonFetch({
      namespace: 'acme',
      name: 'demo',
      latest_version: '2.0.0',
      engines_navide: '>=0.3.0',
      has_changelog: true,
      repository: 'https://x.test/r',
      versions: [
        { version: '2.0.0', target: 'universal', yanked: false, engines_navide: '>=0.3.0' },
        { version: '1.0.0', target: 'universal', yanked: false, engines_navide: '^0.1.0' },
      ],
    })
    registerAll()
    const detail = (await handlers.get('plugins:marketplaceDetail')!(null, { namespace: 'acme', name: 'demo' })) as
      Record<string, unknown> & { versions: Array<Record<string, unknown>> }
    expect(detail).toMatchObject({
      compatible: false,
      min_navide_version: '0.3.0',
      app_version: '0.2.13',
      latest_installable_version: '2.0.0',
      latest_compatible_version: '1.0.0',
      has_changelog: true,
      repository: 'https://x.test/r',
    })
    expect(detail.versions.map((v) => [v.version, v.compatible])).toEqual([
      ['2.0.0', false],
      ['1.0.0', true],
    ])
  })

  it('refuses an incompatible version before downloading it', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    const row = detail.versions[0] as WireDetail['versions'][number] & { engines_navide?: string }
    row.engines_navide = '>=0.3.0'
    installFetch(detail, bytes, digest)
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG, undefined, {
      appVersion: () => '0.2.13',
      ...TEST_PREFLIGHT_OPTIONS,
    })
    await expect(handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      'requires Navide 0.3.0 or newer; this is Navide 0.2.13'
    )
    const urls = vi.mocked(global.fetch).mock.calls.map((call) => String(call[0]))
    expect(urls.some((u) => u.endsWith('/download'))).toBe(false)
  })

  it('refuses a verified package whose own manifest needs a newer Navide', async () => {
    const { bytes, digest } = buildPkg('acme.demo', 'acme', {}, '1.0.0', { engines: { navide: '>=9.0.0' } })
    installFetch(signedDetail(digest), bytes, digest)
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG, undefined, {
      appVersion: () => '0.2.13',
      ...TEST_PREFLIGHT_OPTIONS,
    })
    await expect(handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      'requires Navide 9.0.0 or newer'
    )
    // Nothing is held for commit.
    await expect(
      handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
    ).rejects.toThrow()
  })

  it('never offers an update this Navide release cannot run', async () => {
    const manager = new FrontendPluginManager()
    vi.spyOn(manager, 'listInstalledPackages').mockReturnValue([
      { id: 'acme.demo', provenance: 'official-registry', packageVersion: '1.0.0' },
    ] as unknown as ReturnType<FrontendPluginManager['listInstalledPackages']>)
    jsonFetch({
      versions: [
        { version: '2.0.0', target: 'universal', yanked: false, engines_navide: '>=0.3.0' },
        { version: '1.1.0', target: 'universal', yanked: false, engines_navide: '^0.1.0' },
      ],
    })
    registerPluginIpc(manager, '/plugins', () => true, TRUST_CONFIG, undefined, { appVersion: () => '0.2.13' })
    const updates = (await handlers.get('plugins:checkUpdates')!(null)) as Array<{ latestVersion: string }>
    expect(updates.map((u) => u.latestVersion)).toEqual(['1.1.0'])
  })
})

describe('Pre-release channel (Phase 4)', () => {
  const savedFetch = global.fetch
  const savedMarketplaceUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
  let root = ''
  beforeEach(() => {
    handlers.clear()
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
    root = mkdtempSync(join(tmpdir(), 'navide-prerelease-ipc-'))
  })
  afterEach(() => {
    global.fetch = savedFetch
    if (savedMarketplaceUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    else process.env['AGENT_TEAM_MARKETPLACE_URL'] = savedMarketplaceUrl
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const VERSIONS = [
    { version: '1.3.1-beta.2', target: 'universal', yanked: false },
    { version: '1.3.0', target: 'universal', yanked: false },
    { version: '1.2.0', target: 'universal', yanked: false },
  ]

  function serve(versions: unknown[]) {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return { namespace: 'acme', name: 'demo', latest_version: '1.3.0', versions }
      },
    })) as unknown as typeof fetch
  }

  function registerWith(installedVersion: string, extra: Record<string, unknown> = {}) {
    const manager = new FrontendPluginManager()
    vi.spyOn(manager, 'listInstalledPackages').mockReturnValue([
      { id: 'acme.demo', requires: [], provenance: 'official-registry', packageVersion: installedVersion, ...extra },
    ] as unknown as ReturnType<FrontendPluginManager['listInstalledPackages']>)
    registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, { appVersion: () => '0.2.13' })
  }

  const updates = async () =>
    ((await handlers.get('plugins:checkUpdates')!(null)) as Array<{ latestVersion: string }>).map(
      (u) => u.latestVersion
    )
  const setPrerelease = (id: unknown, enabled: unknown) =>
    handlers.get('plugins:setPrerelease')!(null, { id, enabled })

  it('never offers a pre-release to a stable user', async () => {
    serve(VERSIONS)
    registerWith('1.2.0')
    expect(await updates()).toEqual(['1.3.0'])
  })

  it('offers the newest pre-release once the extension opts in', async () => {
    serve(VERSIONS)
    registerWith('1.2.0')
    await setPrerelease('acme.demo', true)
    expect(await updates()).toEqual(['1.3.1-beta.2'])
  })

  it('does not downgrade a pre-release install when the switch is turned off again', async () => {
    serve(VERSIONS)
    registerWith('1.3.1-beta.2')
    await setPrerelease('acme.demo', true)
    expect(await updates()).toEqual([])
    await setPrerelease('acme.demo', false)
    // 1.3.0 is older than the installed 1.3.1-beta.2: nothing is offered…
    expect(await updates()).toEqual([])
    // …until a stable release newer than the installed pre-release exists.
    serve([{ version: '1.3.1', target: 'universal', yanked: false }, ...VERSIONS])
    expect(await updates()).toEqual(['1.3.1'])
  })

  it('makes the detail install candidate follow the switch and labels each channel', async () => {
    serve(VERSIONS)
    registerWith('1.2.0')
    const detail = async () =>
      (await handlers.get('plugins:marketplaceDetail')!(null, { namespace: 'acme', name: 'demo' })) as Record<
        string,
        unknown
      > & { versions: Array<{ version: string; channel: string }> }
    const stable = await detail()
    expect(stable.latest_installable_version).toBe('1.3.0')
    expect(stable.gets_prereleases).toBe(false)
    expect(stable.versions.map((v) => [v.version, v.channel])).toEqual([
      ['1.3.1-beta.2', 'pre-release'],
      ['1.3.0', 'stable'],
      ['1.2.0', 'stable'],
    ])
    await setPrerelease('acme.demo', true)
    const optedIn = await detail()
    expect(optedIn.latest_installable_version).toBe('1.3.1-beta.2')
    expect(optedIn.gets_prereleases).toBe(true)
  })

  it('reports the switch and the engine label in the installed inventory', async () => {
    registerWith('1.2.0', { enginesNavide: '>=0.3.0' })
    await setPrerelease('acme.demo', true)
    const rows = (await handlers.get('plugins:listInstalled')!(null)) as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({
      id: 'acme.demo',
      getsPrereleases: true,
      minNavideVersion: '0.3.0',
      engineCompatible: false,
    })
  })

  // K5 RULE ZERO: the renderer's "Install pre-release" only calls the existing
  // switch and installs an explicit version, so with the switch off the main
  // process answers exactly as on main.
  it('keeps the switch-off candidates and the per-extension scope unchanged (K5)', async () => {
    serve([{ version: '0.1.0-alpha.1', target: 'universal', yanked: false }])
    registerWith('1.2.0')
    const detail = async (name: string) =>
      (await handlers.get('plugins:marketplaceDetail')!(null, { namespace: 'acme', name })) as Record<string, unknown>
    // A Navide plugin with only a pre-release has no switch-off candidate.
    expect(await detail('other')).toMatchObject({ latest_installable_version: null, gets_prereleases: false })
    // Build metadata does not make a version a pre-release.
    serve([{ version: '1.3.0+build.7', target: 'universal', yanked: false }])
    expect(await detail('other')).toMatchObject({ latest_installable_version: '1.3.0+build.7' })
    // Turning one switch on leaves every other Navide plugin off.
    serve(VERSIONS)
    expect(await setPrerelease('acme.demo', true)).toEqual({ id: 'acme.demo', enabled: true })
    expect(await detail('other')).toMatchObject({ latest_installable_version: '1.3.0', gets_prereleases: false })
    expect(await detail('demo')).toMatchObject({ latest_installable_version: '1.3.1-beta.2', gets_prereleases: true })
  })

  it('validates the switch arguments', async () => {
    registerWith('1.2.0')
    await expect(setPrerelease('../evil', true)).rejects.toThrow('invalid plugin id')
    await expect(setPrerelease('acme.demo', 'yes')).rejects.toThrow('invalid pre-release setting')
  })
})

describe('Extension Pack (Phase 5)', () => {
  const savedFetch = global.fetch
  const savedMarketplaceUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
  let root = ''
  beforeEach(() => {
    handlers.clear()
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
    root = mkdtempSync(join(tmpdir(), 'navide-pack-ipc-'))
  })
  afterEach(() => {
    global.fetch = savedFetch
    if (savedMarketplaceUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    else process.env['AGENT_TEAM_MARKETPLACE_URL'] = savedMarketplaceUrl
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const API = 'https://server.navide.dev/registry/api/extensions'

  function buildPackPkg(members: string[], extra: Record<string, unknown> = {}): { bytes: Uint8Array; digest: string } {
    const manifest = JSON.stringify({
      schemaVersion: 2,
      apiVersion: '^1.0.0',
      id: 'acme.pack',
      name: 'Pack',
      version: '1.0.0',
      publisher: 'acme',
      permissions: {},
      marketplace: { description: 'A pack', license: 'MIT' },
      extensionPack: members,
      ...extra,
    })
    const bytes = new Uint8Array(makeZip([{ name: 'manifest.json', data: manifest }]))
    return { bytes, digest: sha256Hex(bytes) }
  }

  const row = (version: string, extra: Record<string, unknown> = {}) => ({
    version,
    target: 'universal',
    yanked: false,
    capabilities: ['fs', 'ui'],
    sensitive_capabilities: ['fs'],
    ...extra,
  })

  /** Serve the pack (signed detail + download) and member listings. */
  function servePack(
    pack: { bytes: Uint8Array; digest: string },
    members: Record<string, Record<string, unknown> | 404>
  ) {
    const detail = signedDetail(pack.digest, 'acme.pack')
    global.fetch = vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.endsWith('/download')) {
        const ab = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength)
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            return ab
          },
          headers: { get: (h: string) => (h.toLowerCase() === 'x-package-digest' ? pack.digest : null) },
        }
      }
      if (u === `${API}/acme/pack`) return { ok: true, status: 200, async json() { return { ...detail, display_name: 'Pack' } } }
      const id = u.slice(API.length + 1).replace('/', '.')
      const member = members[id]
      if (member === undefined || member === 404) return { ok: false, status: 404, async json() { return {} } }
      return { ok: true, status: 200, async json() { return member } }
    }) as unknown as typeof fetch
  }

  function setup(installed: string[] = []) {
    const manager = new FrontendPluginManager()
    const current = [...installed]
    vi.spyOn(manager, 'listInstalledPackages').mockImplementation(
      () =>
        current.map((id) => ({ id, requires: [], provenance: 'official-registry' })) as unknown as ReturnType<
          FrontendPluginManager['listInstalledPackages']
        >
    )
    vi.spyOn(manager, 'removeInstalledPlugin').mockImplementation((id: string) => {
      current.splice(current.indexOf(id), 1)
    })
    registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
      appVersion: () => '0.2.13',
      cleanupPluginStorage: async () => undefined,
      ...TEST_PREFLIGHT_OPTIONS,
    })
    return current
  }

  it('verifies the pack and resolves every member without installing anything', async () => {
    const pack = buildPackPkg(['acme.ready', 'acme.have', 'acme.gone', 'acme.inner', 'acme.newer', 'acme.other-os'])
    servePack(pack, {
      'acme.ready': { display_name: 'Ready', versions: [row('1.2.0')] },
      'acme.have': { versions: [row('1.0.0')] },
      'acme.gone': 404,
      'acme.inner': { extension_pack: ['acme.x'], versions: [row('1.0.0', { capabilities: [] })] },
      'acme.newer': { versions: [row('2.0.0', { engines_navide: '>=0.3.0' })] },
      'acme.other-os': { versions: [row('1.0.0', { target: 'plan9-mips' })] },
    })
    setup(['acme.have'])
    const result = (await handlers.get('plugins:preparePack')!(null, { namespace: 'acme', name: 'pack' })) as {
      id: string
      version: string
      members: Array<{ id: string; status: string; version: string | null; sensitive_capabilities: string[] }>
    }
    expect(result.id).toBe('acme.pack')
    expect(result.members.map((m) => [m.id, m.status])).toEqual([
      ['acme.ready', 'ready'],
      ['acme.have', 'installed'],
      ['acme.gone', 'missing'],
      ['acme.inner', 'nested'],
      ['acme.newer', 'incompatible'],
      ['acme.other-os', 'unavailable'],
    ])
    expect(result.members[0]).toMatchObject({ version: '1.2.0', sensitive_capabilities: ['fs'] })
    // Nothing was staged for commit: the pack package is never installed.
    await expect(handlers.get('plugins:commitInstall')!(null, { id: 'acme.pack' })).rejects.toThrow()
  })

  it('refuses to install a pack package directly', async () => {
    const pack = buildPackPkg(['acme.ready'])
    servePack(pack, {})
    setup()
    await expect(
      handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'pack' })
    ).rejects.toThrow('acme.pack is an extension pack')
  })

  it('rejects a pack whose verified manifest asks for permissions', async () => {
    // The manifest contract refuses it, so the verified package never parses.
    const pack = buildPackPkg(['acme.ready'], { permissions: { system: ['fs'] } })
    servePack(pack, {})
    setup()
    await expect(
      handlers.get('plugins:preparePack')!(null, { namespace: 'acme', name: 'pack' })
    ).rejects.toThrow(/pack must not request permissions/)
  })

  it('refuses preparePack for an ordinary extension', async () => {
    const { bytes, digest } = buildPkg('acme.pack')
    servePack({ bytes, digest }, {})
    setup()
    await expect(
      handlers.get('plugins:preparePack')!(null, { namespace: 'acme', name: 'pack' })
    ).rejects.toThrow('acme.pack is not an extension pack')
  })

  it('records only the members this pack installed, and forgets the pack on removal', async () => {
    const pack = buildPackPkg(['acme.a', 'acme.b', 'acme.c'])
    servePack(pack, {
      'acme.a': { versions: [row('1.0.0')] },
      'acme.b': { versions: [row('1.0.0')] },
      'acme.c': { versions: [row('1.0.0')] },
    })
    const installed = setup(['acme.b'])
    await handlers.get('plugins:preparePack')!(null, { namespace: 'acme', name: 'pack' })
    // The user confirmed acme.a and skipped acme.c.
    installed.push('acme.a')
    const finished = (await handlers.get('plugins:finishPack')!(null, { id: 'acme.pack' })) as {
      recorded: boolean
      pack: { installedByPack: string[] }
    }
    expect(finished.recorded).toBe(true)
    expect(finished.pack.installedByPack).toEqual(['acme.a'])
    expect(await handlers.get('plugins:listPacks')!(null)).toEqual([
      {
        id: 'acme.pack',
        displayName: 'Pack',
        version: '1.0.0',
        members: ['acme.a', 'acme.b', 'acme.c'],
        installedByPack: ['acme.a'],
      },
    ])
    // A member removed on its own is no longer offered for removal.
    installed.splice(installed.indexOf('acme.a'), 1)
    expect(((await handlers.get('plugins:listPacks')!(null)) as Array<{ installedByPack: string[] }>)[0].installedByPack).toEqual([])
    expect(await handlers.get('plugins:removePack')!(null, { id: 'acme.pack' })).toEqual({ removed: true })
    expect(await handlers.get('plugins:listPacks')!(null)).toEqual([])
  })

  // Pack A installed acme.x; pack B, installed later, lists acme.x too.
  function twoPacksSharingX(): void {
    const store = new PluginPackStore(root)
    store.put({ id: 'acme.a', version: '1.0.0', members: ['acme.x', 'acme.y'], installedByPack: ['acme.x', 'acme.y'] })
    store.put({ id: 'acme.b', version: '1.0.0', members: ['acme.x', 'acme.z'], installedByPack: ['acme.z'] })
    for (const id of ['acme.x', 'acme.y', 'acme.z']) mkdirSync(join(root, id))
  }

  it('does not offer a member that another installed pack also uses', async () => {
    twoPacksSharingX()
    setup(['acme.x', 'acme.y', 'acme.z'])
    const listed = (await handlers.get('plugins:listPacks')!(null)) as Array<{ id: string; installedByPack: string[] }>
    expect(listed.map((pack) => [pack.id, pack.installedByPack])).toEqual([
      ['acme.a', ['acme.y']],
      ['acme.b', ['acme.z']],
    ])
  })

  it('refuses to remove a shared member with the pack, and removes nothing', async () => {
    twoPacksSharingX()
    const installed = setup(['acme.x', 'acme.y', 'acme.z'])
    await expect(
      handlers.get('plugins:removePack')!(null, { id: 'acme.a', members: ['acme.y', 'acme.x'] })
    ).rejects.toThrow('acme.x is not removable with acme.a')
    expect(installed).toEqual(['acme.x', 'acme.y', 'acme.z'])
    expect(existsSync(join(root, 'acme.y'))).toBe(true)
    expect(new PluginPackStore(root).get('acme.a')).not.toBeNull()
  })

  it('removes the chosen pack-only members together with the pack', async () => {
    twoPacksSharingX()
    const installed = setup(['acme.x', 'acme.y', 'acme.z'])
    expect(await handlers.get('plugins:removePack')!(null, { id: 'acme.a', members: ['acme.y'] })).toEqual({
      removed: true,
    })
    expect(installed).toEqual(['acme.x', 'acme.z'])
    expect(existsSync(join(root, 'acme.y'))).toBe(false)
    expect(new PluginPackStore(root).get('acme.a')).toBeNull()
    // With pack A gone, acme.x is no longer offered by pack B either (B did not install it).
    const listed = (await handlers.get('plugins:listPacks')!(null)) as Array<{ id: string; installedByPack: string[] }>
    expect(listed).toEqual([expect.objectContaining({ id: 'acme.b', installedByPack: ['acme.z'] })])
  })

  it('records nothing when no member ended up installed', async () => {
    const pack = buildPackPkg(['acme.a'])
    servePack(pack, { 'acme.a': { versions: [row('1.0.0')] } })
    setup()
    await handlers.get('plugins:preparePack')!(null, { namespace: 'acme', name: 'pack' })
    expect(await handlers.get('plugins:finishPack')!(null, { id: 'acme.pack' })).toEqual({ recorded: false })
    expect(await handlers.get('plugins:listPacks')!(null)).toEqual([])
    await expect(handlers.get('plugins:finishPack')!(null, { id: 'acme.pack' })).rejects.toThrow(
      'no extension pack install in progress'
    )
  })

  it('bounds the member lookup', async () => {
    setup()
    await expect(
      handlers.get('plugins:marketplacePackMembers')!(null, { members: Array.from({ length: 21 }, (_, i) => `acme.m${i}`) })
    ).rejects.toThrow('invalid extension pack members')
  })
})

describe('plugins:listInstalled scope disclosure', () => {
  it('passes declared filesystem scopes through to the renderer inventory', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-scope-inventory-'))
    try {
      const manager = new FrontendPluginManager()
      register(root, manager)
      manager.registerInstalledPackage({
        id: 'acme.notes',
        requires: ['fs'],
        packageVersion: '1.0.0',
        manifestPermissions: {
          system: ['fs'],
          scopes: { fs: { read: ['.acme/notes'], write: ['.acme/notes'] } },
        },
      })
      const listHandler = handlers.get('plugins:listInstalled')
      if (!listHandler) throw new Error('installed inventory handler not registered')
      expect(listHandler(null)).toMatchObject([{
        id: 'acme.notes',
        manifestPermissions: {
          system: ['fs'],
          scopes: { fs: { read: ['.acme/notes'], write: ['.acme/notes'] } },
        },
      }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// B2-a: the backend's read-only Marketplace tools are answered by the same
// functions the Marketplace page's IPC handlers run.
describe('marketplace.query answered from the Marketplace page functions', () => {
  const savedFetch = global.fetch
  const savedMarketplaceUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
  beforeEach(() => {
    handlers.clear()
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
  })
  afterEach(() => {
    global.fetch = savedFetch
    if (savedMarketplaceUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    else process.env['AGENT_TEAM_MARKETPLACE_URL'] = savedMarketplaceUrl
    vi.restoreAllMocks()
  })

  function registerWithQuery(manager: FrontendPluginManager): (query: unknown) => Promise<unknown> {
    const install = vi.spyOn(manager, 'setMarketplaceQueryHandler')
    registerPluginIpc(manager, '/plugins', () => true, TRUST_CONFIG, undefined, { appVersion: () => '0.2.13' })
    const handler = install.mock.calls[0]?.[0]
    if (!handler) throw new Error('marketplace query handler not installed')
    return handler
  }

  it('searches through the same Registry request the Marketplace page sends', async () => {
    const fetchMock = vi.fn(async (_url: unknown) => ({
      ok: true,
      status: 200,
      async json() {
        return { items: [{ namespace: 'acme', name: 'demo', latest_version: '1.0.0', trust_tier: 'signed-verified' }], total: 1 }
      },
    }))
    global.fetch = fetchMock as unknown as typeof fetch
    const query = registerWithQuery(new FrontendPluginManager())
    const page = handlers.get('plugins:marketplaceSearch')!

    await page(null, 'git', undefined, { limit: 20 })
    const answer = await query({ kind: 'search', text: 'git', limit: 20 })

    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls).toEqual([
      'https://server.navide.dev/registry/api/extensions?q=git&limit=20',
      'https://server.navide.dev/registry/api/extensions?q=git&limit=20',
    ])
    expect(answer).toEqual({
      ok: true,
      result: { kind: 'search', nextCursor: null, items: [expect.objectContaining({ id: 'acme.demo', signed: true, risk: null })] },
    })
  })

  it('reports a Registry 404 on detail as NOT_FOUND, while the page still gets the same error text', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, async json() { return {} } })) as unknown as typeof fetch
    const query = registerWithQuery(new FrontendPluginManager())
    await expect(handlers.get('plugins:marketplaceDetail')!(null, { namespace: 'acme', name: 'none' }))
      .rejects.toThrow('marketplace detail failed: HTTP 404')
    expect(await query({ kind: 'detail', id: 'acme.none' })).toEqual({
      ok: false, error: 'marketplace detail failed: HTTP 404', error_code: 'NOT_FOUND',
    })
  })

  it('lists the same inventory as the Extensions page, with the native backend flag', async () => {
    const manager = new FrontendPluginManager()
    const query = registerWithQuery(manager)
    manager.registerInstalledPackage({ id: 'acme.notes', requires: ['fs'], packageVersion: '1.0.0', hasBackend: true })
    manager.registerInstalledPackage({ id: 'acme.plain', requires: [], packageVersion: '2.0.0' })

    const page = (handlers.get('plugins:listInstalled')!(null) as Array<{ id: string }>).map((row) => row.id)
    const answer = await query({ kind: 'installed' }) as { ok: true; result: { items: Array<Record<string, unknown>> } }

    expect(answer.result.items.map((item) => item.id)).toEqual(page)
    expect(answer.result.items).toEqual(expect.arrayContaining([
      { id: 'acme.notes', version: '1.0.0', enabled: true, quarantined: false, hasBackend: true, agentTools: [] },
      { id: 'acme.plain', version: '2.0.0', enabled: true, quarantined: false, hasBackend: false, agentTools: [] },
    ]))
  })
})

describe('plugins:setDisabled', () => {
  const coldStartSource = (root: string) => ({
    provenance: 'official-registry' as const,
    trust: {
      pinnedRootKey: registryRoot.pubPem,
      snapshot: readRegistryTrustSnapshot(root),
      registryAuthority: 'self-hosted' as const,
      now: FIXED_NOW,
    },
  })

  async function installVersion(version: string, pkg = buildPkg('acme.demo', 'acme', {}, version)): Promise<void> {
    installFetch(signedDetail(pkg.digest, 'acme.demo', 'acme', version), pkg.bytes, pkg.digest)
    await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version })
    await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
    await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
  }

  function setup(prefix: string) {
    const root = mkdtempSync(join(tmpdir(), prefix))
    const manager = new FrontendPluginManager()
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    // The Host installs this resolver before its first package load.
    manager.setDisabledPluginResolver((id) => new PluginDisabledStore(root).has(id))
    registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
      ...TEST_PREFLIGHT_OPTIONS,
      cleanupPluginStorage: async () => undefined,
      onActivationChange: (change) => changes.push(change),
    })
    return { root, manager, changes, setDisabled: handlers.get('plugins:setDisabled')!, list: handlers.get('plugins:listInstalled')! }
  }

  it('disables a package without removing its files, grant or selection, and enables it with the same grant', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const { root, manager, changes, setDisabled, list } = setup('navide-plugin-disable-')
    try {
      await installVersion('1.0.0', first)
      const grant = new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')
      expect(grant).not.toBeNull()
      expect(list(null)).toMatchObject([{ id: 'acme.demo', disabled: false }])
      changes.length = 0

      await expect(setDisabled(null, { id: 'acme.demo', disabled: true }))
        .resolves.toEqual({ id: 'acme.demo', disabled: true })
      expect(manager.getDescriptor('acme.demo')).toBeUndefined()
      expect(manager.listContributionCatalog().some((entry) => entry.pluginId === 'acme.demo')).toBe(false)
      expect(changes).toEqual([{ pluginId: 'acme.demo' }])
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')).toEqual(grant)
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'))).toBe(true)
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0', artifactDigest: first.digest },
      })
      expect(list(null)).toMatchObject([{ id: 'acme.demo', packageVersion: '1.0.0', disabled: true }])
      changes.length = 0

      await expect(setDisabled(null, { id: 'acme.demo', disabled: false }))
        .resolves.toEqual({ id: 'acme.demo', disabled: false })
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.0')
      expect(manager.listContributionCatalog().some((entry) => entry.pluginId === 'acme.demo')).toBe(true)
      expect(changes).toMatchObject([{
        pluginId: 'acme.demo',
        activation: { packageVersion: '1.0.0', artifactDigest: first.digest },
      }])
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')).toEqual(grant)
      expect(list(null)).toMatchObject([{ id: 'acme.demo', disabled: false }])
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // B2-c option B: who disabled a package decides whether an agent may enable it.
  it('lets an agent enable only what an agent disabled; the user\'s switch and its answers stay as on main', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-disable-source-'))
    const manager = new FrontendPluginManager()
    manager.setDisabledPluginResolver((id) => new PluginDisabledStore(root).has(id))
    let agentAction: ((request: unknown) => Promise<unknown>) | null = null
    vi.spyOn(manager, 'setPluginAgentActionHandler').mockImplementation((handler) => { agentAction = handler })
    const notices: unknown[] = []
    registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
      ...TEST_PREFLIGHT_OPTIONS,
      cleanupPluginStorage: async () => undefined,
      onPluginAgentAction: (notice) => notices.push(notice),
    })
    const setDisabled = handlers.get('plugins:setDisabled')!
    const requester = { paneId: 'p-41', paneName: 'dev', workspace: '/w', callerKind: 'pane' }
    const agent = (action: 'disable' | 'enable') =>
      agentAction!({ request_id: 'pa:1', action, plugin_id: 'acme.demo', requester })
    const sourceFile = join(root, '.navide-disabled-source.json')
    try {
      await installVersion('1.0.0')
      // The user's own switch: same answers as on main; recorded as the user.
      await expect(setDisabled(null, { id: 'acme.demo', disabled: true })).resolves.toEqual({ id: 'acme.demo', disabled: true })
      expect(JSON.parse(readFileSync(sourceFile, 'utf8')).sources['acme.demo']).toMatchObject({ by: 'user', agent: null })
      // The user disabled it: an agent's enable changes nothing and asks for approval.
      await expect(agent('enable')).resolves.toMatchObject({
        ok: false, error_code: 'APPROVAL_REQUIRED', pluginVersion: '1.0.0', disabled: { by: 'user' },
      })
      expect(new PluginDisabledStore(root).has('acme.demo')).toBe(true)
      expect(notices).toEqual([])
      await expect(setDisabled(null, { id: 'acme.demo', disabled: false })).resolves.toEqual({ id: 'acme.demo', disabled: false })
      expect(JSON.parse(readFileSync(sourceFile, 'utf8')).sources['acme.demo']).toBeUndefined()

      // An agent disabled it: the agent may enable it again at once.
      await expect(agent('disable')).resolves.toMatchObject({ ok: true, disabled: true, changed: true })
      expect(JSON.parse(readFileSync(sourceFile, 'utf8')).sources['acme.demo']).toMatchObject({
        by: 'agent', agent: { callerKind: 'pane', paneId: 'p-41', paneName: 'dev' },
      })
      await expect(agent('enable')).resolves.toMatchObject({ ok: true, disabled: false, changed: true })
      expect(new PluginDisabledStore(root).has('acme.demo')).toBe(false)
      expect(notices).toHaveLength(2)

      // Disabled before sources were recorded (no entry): read as the user.
      new PluginDisabledStore(root).add('acme.demo')
      rmSync(sourceFile, { force: true })
      await expect(agent('enable')).resolves.toMatchObject({ ok: false, error_code: 'APPROVAL_REQUIRED', disabled: { by: 'user', at: null } })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Review of #385 (MED-1): an agent's entry must never outlive the disable it describes.
  it('trusts an agent\'s entry only while the Disabled list is as it left it, and forgets it on removal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-disable-source-fail-'))
    const manager = new FrontendPluginManager()
    manager.setDisabledPluginResolver((id) => new PluginDisabledStore(root).has(id))
    let agentAction: ((request: unknown) => Promise<unknown>) | null = null
    vi.spyOn(manager, 'setPluginAgentActionHandler').mockImplementation((handler) => { agentAction = handler })
    registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
      ...TEST_PREFLIGHT_OPTIONS,
      cleanupPluginStorage: async () => undefined,
    })
    const setDisabled = handlers.get('plugins:setDisabled')!
    const requester = { paneId: 'p-41', paneName: 'dev', workspace: '/w', callerKind: 'pane' }
    const agent = (action: 'disable' | 'enable') =>
      agentAction!({ request_id: 'pa:1', action, plugin_id: 'acme.demo', requester })
    const sourceFile = join(root, '.navide-disabled-source.json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await installVersion('1.0.0')
      await expect(agent('disable')).resolves.toMatchObject({ ok: true, changed: true })
      // The user's switch works, but neither write of who did it lands: the
      // agent's entry is left behind in the file.
      const set = vi.spyOn(PluginDisableSourceStore.prototype, 'set').mockImplementation(() => { throw new Error('disk full') })
      const remove = vi.spyOn(PluginDisableSourceStore.prototype, 'remove').mockImplementation(() => { throw new Error('disk full') })
      await expect(setDisabled(null, { id: 'acme.demo', disabled: false })).resolves.toEqual({ id: 'acme.demo', disabled: false })
      await expect(setDisabled(null, { id: 'acme.demo', disabled: true })).resolves.toEqual({ id: 'acme.demo', disabled: true })
      expect(JSON.parse(readFileSync(sourceFile, 'utf8')).sources['acme.demo']).toMatchObject({ by: 'agent' })
      await expect(agent('enable')).resolves.toMatchObject({ ok: false, error_code: 'APPROVAL_REQUIRED', disabled: { by: 'user' } })
      expect(new PluginDisabledStore(root).has('acme.demo')).toBe(true)
      set.mockRestore()
      remove.mockRestore()
      await setDisabled(null, { id: 'acme.demo', disabled: false })

      // An older Navide (which does not know the source file) enables and
      // disables it again: the agent's entry is left, but the list changed.
      await expect(agent('disable')).resolves.toMatchObject({ ok: true, changed: true })
      new PluginDisabledStore(root).remove('acme.demo')
      new PluginDisabledStore(root).add('acme.demo')
      expect(JSON.parse(readFileSync(sourceFile, 'utf8')).sources['acme.demo']).toMatchObject({ by: 'agent' })
      await expect(agent('enable')).resolves.toMatchObject({ ok: false, error_code: 'APPROVAL_REQUIRED', disabled: { by: 'user', at: null } })
      expect(new PluginDisabledStore(root).has('acme.demo')).toBe(true)
      await setDisabled(null, { id: 'acme.demo', disabled: false })

      // The ordinary path still works: what an agent disabled, it enables at once.
      await expect(agent('disable')).resolves.toMatchObject({ ok: true, changed: true })
      await expect(agent('enable')).resolves.toMatchObject({ ok: true, disabled: false, changed: true })

      // Removing the package drops its entry, so a reinstall starts with none.
      await agent('disable')
      expect(JSON.parse(readFileSync(sourceFile, 'utf8')).sources['acme.demo']).toMatchObject({ by: 'agent' })
      await expect(handlers.get('plugins:remove')!(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true })
      expect(JSON.parse(readFileSync(sourceFile, 'utf8')).sources['acme.demo']).toBeUndefined()
      await installVersion('1.0.0')
      expect(JSON.parse(readFileSync(sourceFile, 'utf8')).sources['acme.demo']).toBeUndefined()

      // LOW-1: an agent's disable of a package the user disabled changes
      // nothing, so the user's entry stays and an agent still cannot enable it.
      await setDisabled(null, { id: 'acme.demo', disabled: true })
      await expect(agent('disable')).resolves.toMatchObject({ ok: true, changed: false })
      expect(JSON.parse(readFileSync(sourceFile, 'utf8')).sources['acme.demo']).toMatchObject({ by: 'user' })
      await expect(agent('enable')).resolves.toMatchObject({ ok: false, error_code: 'APPROVAL_REQUIRED', disabled: { by: 'user' } })
    } finally {
      warn.mockRestore()
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a disabled package unloaded on a cold start while still verifying it', async () => {
    const { root, manager, setDisabled } = setup('navide-plugin-disable-cold-')
    try {
      await installVersion('1.0.0')
      await setDisabled(null, { id: 'acme.demo', disabled: true })

      const reloaded = new FrontendPluginManager()
      reloaded.setDisabledPluginResolver((id) => new PluginDisabledStore(root).has(id))
      const loaded = reloaded.loadInstalledPlugins(root, coldStartSource(root))
      expect(loaded.errors).toEqual([])
      expect(loaded.loaded).not.toContain('acme.demo')
      expect(loaded.activationCatalog.map((entry) => entry.pluginId)).not.toContain('acme.demo')
      expect(reloaded.getDescriptor('acme.demo')).toBeUndefined()
      expect(reloaded.listInstalledPackages()).toMatchObject([{ id: 'acme.demo', packageVersion: '1.0.0' }])

      // A disabled package is not exempt from integrity verification.
      writeFileSync(
        join(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'), REGISTRY_ARTIFACT_NAME),
        'tampered',
      )
      const tampered = new FrontendPluginManager()
      tampered.setDisabledPluginResolver((id) => new PluginDisabledStore(root).has(id))
      const quarantined = tampered.loadInstalledPlugins(root, coldStartSource(root))
      expect(quarantined.errors.join(' ')).toMatch(/quarantined/)
      expect(tampered.listInstalledPackages()).toEqual([])
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a disabled package disabled through an update and a rollback', async () => {
    const { root, manager, changes, setDisabled, list } = setup('navide-plugin-disable-update-')
    try {
      await installVersion('1.0.0')
      await setDisabled(null, { id: 'acme.demo', disabled: true })
      changes.length = 0

      await installVersion('1.0.1')
      expect(manager.getDescriptor('acme.demo')).toBeUndefined()
      expect(changes.every((change) => change.activation === undefined)).toBe(true)
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.1' },
        previous: { packageVersion: '1.0.0' },
      })
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.1')).not.toBeNull()
      expect(list(null)).toMatchObject([{
        id: 'acme.demo',
        packageVersion: '1.0.1',
        disabled: true,
        rollbackKind: 'previous',
        rollbackToVersion: '1.0.0',
      }])

      await expect(handlers.get('plugins:rollback')!(null, { id: 'acme.demo' }))
        .resolves.toMatchObject({ id: 'acme.demo', packageVersion: '1.0.0' })
      expect(manager.getDescriptor('acme.demo')).toBeUndefined()
      expect(changes.every((change) => change.activation === undefined)).toBe(true)
      expect(list(null)).toMatchObject([{ id: 'acme.demo', packageVersion: '1.0.0', disabled: true }])

      await setDisabled(null, { id: 'acme.demo', disabled: false })
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.0')
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes a disabled package and forgets that it was disabled', async () => {
    const { root, manager, setDisabled, list } = setup('navide-plugin-disable-remove-')
    try {
      await installVersion('1.0.0')
      await setDisabled(null, { id: 'acme.demo', disabled: true })
      await expect(handlers.get('plugins:remove')!(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true })
      expect(list(null)).toEqual([])
      expect(new PluginDisabledStore(root).has('acme.demo')).toBe(false)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses first-party ids, packages that are not installed and malformed requests', async () => {
    const { root, manager, setDisabled } = setup('navide-plugin-disable-refuse-')
    try {
      // A `navide.` id that is not one of the three built-ins stays refused.
      await expect(setDisabled(null, { id: 'navide.other', disabled: true })).rejects.toThrow(/first-party/)
      // A built-in needs the Host side of the switch, which this setup lacks.
      await expect(setDisabled(null, { id: 'navide.git', disabled: true })).rejects.toThrow(/unavailable/)
      await expect(setDisabled(null, { id: 'acme.missing', disabled: true })).rejects.toThrow(/not an installed/)
      await expect(setDisabled(null, { id: 'acme.demo', disabled: 'yes' })).rejects.toThrow(/invalid/)
      await expect(setDisabled(null, { id: '../escape', disabled: true })).rejects.toThrow(/invalid plugin id/)
      expect(new PluginDisabledStore(root).has('navide.git')).toBe(false)
      expect(new PluginDisabledStore(root).has('acme.missing')).toBe(false)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('plugins:remove native backend data choice', () => {
  // The sandboxed native backend keeps its private data in
  // <nativeBackendDataRoot>/<pluginId>/. The remove dialog asks whether to
  // keep it; a caller that does not say keeps it, exactly as before.
  function setup(prefix: string) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    const root = join(base, 'plugins')
    const dataRoot = join(base, 'plugin-native-backends', 'data')
    mkdirSync(join(root, 'acme.demo'), { recursive: true })
    const dataDir = join(dataRoot, 'acme.demo')
    mkdirSync(join(dataDir, 'tmp'), { recursive: true })
    writeFileSync(join(dataDir, 'state.db'), 'x'.repeat(42))
    mkdirSync(join(dataRoot, 'acme.other'), { recursive: true })
    const manager = new FrontendPluginManager()
    vi.spyOn(manager, 'removeInstalledPlugin').mockImplementation(() => undefined)
    registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
      cleanupPluginStorage: async () => undefined,
      nativeBackendDataRoot: dataRoot,
    })
    const remove = handlers.get('plugins:remove')
    const inspect = handlers.get('plugins:nativeBackendData')
    if (!remove || !inspect) throw new Error('handlers not registered')
    return { base, root, dataRoot, dataDir, remove, inspect }
  }

  it('reports the size and location of the backend data before removal', async () => {
    const { base, dataDir, inspect } = setup('navide-native-data-inspect-')
    try {
      await expect(inspect(null, { id: 'acme.demo' })).resolves.toEqual({ exists: true, bytes: 42, path: dataDir })
      await expect(inspect(null, { id: 'acme.none' })).resolves.toMatchObject({ exists: false, bytes: 0 })
      await expect(inspect(null, { id: '../outside' })).rejects.toThrow(/invalid plugin id/)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('deletes the backend data directory when the user chose delete', async () => {
    const { base, dataRoot, dataDir, remove } = setup('navide-native-data-delete-')
    try {
      await expect(remove(null, { id: 'acme.demo', nativeBackendData: 'delete' })).resolves.toEqual({ ok: true })
      expect(existsSync(dataDir)).toBe(false)
      expect(existsSync(join(dataRoot, 'acme.other'))).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('keeps the backend data directory when the user chose keep', async () => {
    const { base, root, dataDir, remove } = setup('navide-native-data-keep-')
    try {
      await expect(remove(null, { id: 'acme.demo', nativeBackendData: 'keep' })).resolves.toEqual({ ok: true })
      expect(existsSync(join(root, 'acme.demo'))).toBe(false)
      expect(existsSync(join(dataDir, 'state.db'))).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('keeps the backend data directory when the caller does not choose (compatibility)', async () => {
    const { base, root, dataDir, remove } = setup('navide-native-data-omitted-')
    try {
      await expect(remove(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true })
      expect(existsSync(join(root, 'acme.demo'))).toBe(false)
      expect(existsSync(join(dataDir, 'state.db'))).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('refuses an unknown choice before removing anything', async () => {
    const { base, root, dataDir, remove } = setup('navide-native-data-bad-choice-')
    try {
      await expect(remove(null, { id: 'acme.demo', nativeBackendData: 'wipe' })).rejects.toThrow(/invalid native backend data choice/)
      expect(existsSync(join(root, 'acme.demo'))).toBe(true)
      expect(existsSync(dataDir)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('refuses a symlinked data directory and keeps the package and the link target', async () => {
    const { base, root, dataDir, remove } = setup('navide-native-data-symlink-')
    try {
      rmSync(dataDir, { recursive: true, force: true })
      const workspace = join(base, 'workspace')
      mkdirSync(workspace)
      writeFileSync(join(workspace, 'project.txt'), 'user file')
      symlinkSync(workspace, dataDir)
      await expect(remove(null, { id: 'acme.demo', nativeBackendData: 'delete' })).rejects.toThrow(/symbolic link/)
      expect(existsSync(join(workspace, 'project.txt'))).toBe(true)
      expect(existsSync(join(root, 'acme.demo'))).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('keeps publisher trust and the pre-release opt-in after removal', async () => {
    const { base, root, remove } = setup('navide-native-data-kept-prefs-')
    try {
      // registerPluginIpc reads both stores from these files on every call.
      new PluginPublisherTrustStore(join(root, '.navide-publisher-trust.json')).trust('acme', 'acme.demo')
      new PluginPrereleaseStore(root).set('acme.demo', true)
      await expect(remove(null, { id: 'acme.demo', nativeBackendData: 'delete' })).resolves.toEqual({ ok: true })
      expect(new PluginPublisherTrustStore(join(root, '.navide-publisher-trust.json')).isTrusted('acme', 'acme.demo')).toBe(true)
      expect(new PluginPrereleaseStore(root).has('acme.demo')).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('built-in Plans, Git and Mini-IDE: disabled, never removed', () => {
  const BUILTINS = ['navide.plans', 'navide.git', 'navide.mini-ide'] as const

  function setup(prefix: string, hostSwitch?: (id: string, disabled: boolean) => Promise<void> | void) {
    const root = mkdtempSync(join(tmpdir(), prefix))
    const manager = new FrontendPluginManager()
    manager.setDisabledPluginResolver((id) => new PluginDisabledStore(root).has(id))
    const cleanupPluginStorage = vi.fn(async () => undefined)
    const onFactoryPackageRemoved = vi.fn()
    const restoreFactoryPackage = vi.fn(async () => undefined)
    registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
      cleanupPluginStorage,
      factoryPackageIds: ['navide.git', 'navide.mini-ide'],
      onFactoryPackageRemoved,
      restoreFactoryPackage,
      ...(hostSwitch ? { setBuiltinDisabled: hostSwitch } : {}),
    })
    return { root, manager, cleanupPluginStorage, onFactoryPackageRemoved, restoreFactoryPackage }
  }

  it('refuses to remove or restore any built-in, keeping its files, storage and grant', async () => {
    const { root, cleanupPluginStorage, onFactoryPackageRemoved, restoreFactoryPackage } = setup('navide-builtin-remove-')
    try {
      for (const id of BUILTINS) {
        mkdirSync(join(root, id), { recursive: true })
        new PluginCapabilityGrantStore(root).set(id, { packageVersion: '1.0.0', system: [], storage: true })
        await expect(handlers.get('plugins:remove')!(null, { id })).rejects.toThrow(/cannot be removed/)
        await expect(handlers.get('plugins:remove')!(null, { id, nativeBackendData: 'delete' }))
          .rejects.toThrow(/cannot be removed/)
        await expect(handlers.get('plugins:restoreFactoryPackage')!(null, { id })).rejects.toThrow(/cannot be removed/)
        expect(existsSync(join(root, id))).toBe(true)
        expect(new PluginCapabilityGrantStore(root).get(id, '1.0.0')).not.toBeNull()
      }
      expect(cleanupPluginStorage).not.toHaveBeenCalled()
      expect(onFactoryPackageRemoved).not.toHaveBeenCalled()
      expect(restoreFactoryPackage).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('disables and enables each built-in through the Host, durably, without touching storage or grants', async () => {
    const calls: Array<[string, boolean]> = []
    const { root, manager, cleanupPluginStorage } = setup('navide-builtin-disable-', (id, disabled) => {
      calls.push([id, disabled])
    })
    try {
      for (const id of BUILTINS) {
        new PluginCapabilityGrantStore(root).set(id, { packageVersion: '1.0.0', system: [], storage: true })
        await expect(handlers.get('plugins:setDisabled')!(null, { id, disabled: true }))
          .resolves.toEqual({ id, disabled: true })
        // As a restart sees it: a fresh store over the same root.
        expect(new PluginDisabledStore(root).has(id)).toBe(true)
        expect(manager.isBuiltinPluginDisabled(id)).toBe(true)
        // A second Disable is a no-op.
        await handlers.get('plugins:setDisabled')!(null, { id, disabled: true })
      }
      expect(handlers.get('plugins:disabledBuiltins')!(null)).toEqual([...BUILTINS].sort())
      for (const id of BUILTINS) {
        await expect(handlers.get('plugins:setDisabled')!(null, { id, disabled: false }))
          .resolves.toEqual({ id, disabled: false })
        expect(new PluginDisabledStore(root).has(id)).toBe(false)
        expect(new PluginCapabilityGrantStore(root).get(id, '1.0.0')).not.toBeNull()
      }
      expect(calls).toEqual([...BUILTINS.map((id) => [id, true]), ...BUILTINS.map((id) => [id, false])])
      expect(cleanupPluginStorage).not.toHaveBeenCalled()
      expect(handlers.get('plugins:disabledBuiltins')!(null)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed for the built-ins when the store and its backup are unreadable, until a one-click reset', async () => {
    const calls: Array<[string, boolean]> = []
    const { root, manager } = setup('navide-builtin-unreadable-', (id, disabled) => { calls.push([id, disabled]) })
    const reset = vi.fn()
    // Re-register with the reset hook (setup registers without it).
    registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
      cleanupPluginStorage: vi.fn(async () => undefined),
      setBuiltinDisabled: (id, disabled) => { calls.push([id, disabled]) },
      onBuiltinSwitchReset: reset,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      writeFileSync(join(root, '.navide-disabled-plugins.json'), '{torn')
      writeFileSync(join(root, '.navide-disabled-plugins.json.bak'), '{torn too')
      expect(handlers.get('plugins:disabledStoreStatus')!(null)).toEqual({ status: 'unreadable' })
      expect(handlers.get('plugins:disabledBuiltins')!(null)).toEqual([...BUILTINS].sort())
      expect(manager.isBuiltinPluginDisabled('navide.plans')).toBe(true)
      // Enabling cannot silently rewrite the damaged store.
      await expect(handlers.get('plugins:setDisabled')!(null, { id: 'navide.git', disabled: false }))
        .rejects.toThrow(/unreadable/)
      expect(readFileSync(join(root, '.navide-disabled-plugins.json'), 'utf8')).toBe('{torn')

      await expect(handlers.get('plugins:resetDisabledStore')!(null)).resolves.toEqual({ status: 'ok' })
      expect(handlers.get('plugins:disabledBuiltins')!(null)).toEqual([])
      expect(reset).toHaveBeenCalledTimes(1)
      // The Host finishes enabling each built-in the reset brought back (Git's forced legacy registration).
      expect(reset).toHaveBeenCalledWith([...BUILTINS])
      expect(calls).toEqual([])
    } finally {
      warn.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs the built-in switch and the reset inside the Host hold, so a store check cannot interleave', async () => {
    const { root, manager } = setup('navide-builtin-hold-')
    const events: string[] = []
    const hold = async <T>(task: () => Promise<T>): Promise<T> => {
      events.push('hold')
      try { return await task() } finally { events.push('release') }
    }
    registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
      cleanupPluginStorage: vi.fn(async () => undefined),
      setBuiltinDisabled: (id, disabled) => { events.push(`switch ${id} ${disabled}`) },
      onBuiltinSwitchReset: () => { events.push('reset') },
      holdBuiltinSwitch: hold,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await handlers.get('plugins:setDisabled')!(null, { id: 'navide.plans', disabled: true })
      writeFileSync(join(root, '.navide-disabled-plugins.json'), '{torn')
      writeFileSync(join(root, '.navide-disabled-plugins.json.bak'), '{torn too')
      await expect(handlers.get('plugins:resetDisabledStore')!(null)).resolves.toEqual({ status: 'ok' })
      expect(events).toEqual(['hold', 'switch navide.plans true', 'release', 'hold', 'reset', 'release'])
    } finally {
      warn.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stays disabled when the Host cannot enable it', async () => {
    const { root } = setup('navide-builtin-enable-fail-', (_id, disabled) => {
      if (!disabled) throw new Error('bundled package missing')
    })
    try {
      await handlers.get('plugins:setDisabled')!(null, { id: 'navide.git', disabled: true })
      await expect(handlers.get('plugins:setDisabled')!(null, { id: 'navide.git', disabled: false }))
        .rejects.toThrow(/bundled package missing/)
      expect(new PluginDisabledStore(root).has('navide.git')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
