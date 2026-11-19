// End to end: a first-party plugin running from the App-bundled copy follows
// the Official Registry through the real `plugins:*` IPC wiring, installer and
// trust verification (P3, 0.2.45). Only Electron and the network are stubbed;
// freshly generated keys stand in for the Registry root and signer.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...a: unknown[]) => unknown>() }))

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.2.45' },
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

vi.mock('./pluginWebViewHost', () => ({
  setPluginWebViewChangedHook: () => {},
  pluginWebViewRegistry: () => ({ list: () => [], destroyPlugin: () => {}, clearData: async () => {} }),
}))

vi.setConfig({ testTimeout: 30_000 })

import { makeZip } from './zipFixture'
import { sha256Hex } from './pluginVerify'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import type { InstallerTrustConfig } from './pluginInstaller'
import type { PluginActivationCatalogEntry } from './installedPlugins'
import { PluginDisabledStore } from './pluginDisabledStore'
import { readRegistryTrustSnapshot } from './pluginInstalledTrust'
import { registerPluginIpc, type PluginTrustRefreshController } from './pluginIpc'
import { FrontendPluginManager } from './frontendPluginManager'

const OFFICIAL_URL = 'https://server.navide.dev/registry'
const PLUGIN_ID = 'navide.browser'

function keypair(): { pubPem: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey }
}
function signCanonical(value: unknown, privateKey: Parameters<typeof edSign>[2]): string {
  return edSign(null, Buffer.from(canonicalTrustJson(value), 'utf8'), privateKey).toString('base64')
}

const registryRoot = keypair()
const registrySigner = keypair()
const OFFICIAL_TRUST: InstallerTrustConfig = {
  pinnedRegistryRootKey: registryRoot.pubPem,
  now: new Date('2026-08-16T12:00:00.000Z'),
  registryAuthority: 'official',
  officialRegistryUrl: OFFICIAL_URL,
}

function manifest(version: string, system: string[]): string {
  return JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: PLUGIN_ID,
    name: 'Navide Browser',
    version,
    publisher: 'navide',
    permissions: { system },
    marketplace: { description: 'Browse the web inside Navide.', license: 'MIT' },
    contributes: {
      views: [{ id: 'window', kind: 'custom', location: 'window', title: 'Navide Browser', entry: 'frontend/window/index.html' }],
    },
  })
}

/** The App-bundled copy, as the installer lays it out. */
function writeFactoryPackage(version: string): string {
  const dir = join(root, 'factory', PLUGIN_ID)
  mkdirSync(join(dir, 'frontend', 'window'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), manifest(version, ['ui']))
  writeFileSync(join(dir, 'frontend', 'window', 'index.html'), '<!doctype html>')
  return dir
}

/** Registry detail + download of one signed version. */
function serveRegistry(version: string, system: string[]): void {
  const bytes = new Uint8Array(makeZip([
    { name: 'manifest.json', data: manifest(version, system) },
    { name: 'frontend/window/index.html', data: '<!doctype html>' },
  ]))
  const digest = sha256Hex(bytes)
  const envelope: RegistryPackageEnvelope = {
    schemaVersion: 1,
    artifactDigest: digest,
    packageId: PLUGIN_ID,
    version,
    target: 'universal',
    publisherId: 'navide',
    keyId: 'registry-test-1',
    signedAt: '2026-08-16T11:00:00.000Z',
  }
  const metadata: RegistryTrustMetadata = {
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
    blockedPublishers: [],
    blockedPackages: [],
  }
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

let root = ''
let manager: FrontendPluginManager
let controller: PluginTrustRefreshController
let activations: Map<string, PluginActivationCatalogEntry>
let previousUrl: string | undefined

/** One App launch: the bundled copy loads because nothing installed wins. */
function launch(bundledVersion = '1.0.0'): void {
  handlers.clear()
  manager = new FrontendPluginManager()
  manager.setDisabledPluginResolver((id) => new PluginDisabledStore(root).has(id))
  manager.setBundledPluginVersions({ [PLUGIN_ID]: bundledVersion })
  manager.loadInstalledPlugins(root, {
    provenance: 'official-registry',
    trust: {
      pinnedRootKey: registryRoot.pubPem,
      snapshot: readRegistryTrustSnapshot(root),
      registryAuthority: 'official',
      officialRegistryUrl: OFFICIAL_URL,
      now: OFFICIAL_TRUST.now,
    },
  })
  if (!manager.getDescriptor(PLUGIN_ID)) {
    expect(manager.loadFactoryPlugin(writeFactoryPackage(bundledVersion), PLUGIN_ID).loaded).toBe(true)
  }
  controller = registerPluginIpc(manager, root, () => true, OFFICIAL_TRUST, undefined, {
    cleanupPluginStorage: async () => undefined,
    preflightCandidateFrontend: async () => undefined,
    preflightCandidateBackend: async () => undefined,
    onActivationChange: ({ pluginId, activation }: { pluginId: string; activation?: PluginActivationCatalogEntry }) => {
      activations.delete(pluginId)
      if (activation) activations.set(pluginId, activation)
    },
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'navide-bundled-refresh-'))
  activations = new Map()
  previousUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
  process.env['AGENT_TEAM_MARKETPLACE_URL'] = OFFICIAL_URL
})

afterEach(async () => {
  await manager?.closeBackendPlugins()
  if (previousUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
  else process.env['AGENT_TEAM_MARKETPLACE_URL'] = previousUrl
  rmSync(root, { recursive: true, force: true })
})

describe('a bundled first-party plugin following the Official Registry', () => {
  it('stages a newer version that discloses the same, keeps the bundled copy running, and switches at the next launch', async () => {
    launch()
    serveRegistry('1.1.0', ['ui'])
    await expect(controller.refreshBundledOfficial()).resolves.toEqual([
      { id: PLUGIN_ID, from: '1.0.0', to: '1.1.0', result: 'staged' },
    ])
    // Still the bundled copy this session.
    expect(manager.listInstalledPackages()).toMatchObject([{ id: PLUGIN_ID, provenance: 'factory-bundled', packageVersion: '1.0.0' }])
    // A second pass finds the candidate waiting and does nothing.
    await expect(controller.refreshBundledOfficial()).resolves.toEqual([])

    // Next launch, still offline-safe: the staged first install is promoted.
    global.fetch = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    launch()
    await expect(controller.activateStagedFirstInstalls()).resolves.toEqual([])
    expect(activations.get(PLUGIN_ID)).toMatchObject({ pluginId: PLUGIN_ID, provenance: 'official-registry', packageVersion: '1.1.0' })
    // Every later launch loads the Marketplace copy, not the bundled one.
    launch()
    expect(manager.listInstalledPackages()).toMatchObject([{ id: PLUGIN_ID, provenance: 'official-registry', packageVersion: '1.1.0' }])
  })

  it('offers a version that discloses more as an update instead of installing it', async () => {
    launch()
    serveRegistry('1.1.0', ['ui', 'fs'])
    const [outcome] = await controller.refreshBundledOfficial()
    expect(outcome).toMatchObject({ id: PLUGIN_ID, to: '1.1.0', result: 'needs-approval' })
    expect(await controller.checkUpdates()).toEqual([
      { id: PLUGIN_ID, namespace: 'navide', name: 'browser', installedVersion: '1.0.0', latestVersion: '1.1.0', permissionChange: 'more' },
    ])
    // Nothing was staged: the next launch still runs the bundled copy.
    launch()
    await expect(controller.activateStagedFirstInstalls()).resolves.toEqual([])
    expect(activations.has(PLUGIN_ID)).toBe(false)
    expect(manager.listInstalledPackages()).toMatchObject([{ id: PLUGIN_ID, provenance: 'factory-bundled', packageVersion: '1.0.0' }])
  })

  it('keeps the bundled copy when the Marketplace is unreachable', async () => {
    launch()
    global.fetch = vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND') }) as unknown as typeof fetch
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(controller.refreshBundledOfficial()).resolves.toMatchObject([
      { id: PLUGIN_ID, from: '1.0.0', result: 'failed', reason: 'getaddrinfo ENOTFOUND' },
    ])
    warn.mockRestore()
    launch()
    await expect(controller.activateStagedFirstInstalls()).resolves.toEqual([])
    expect(activations.has(PLUGIN_ID)).toBe(false)
  })

  it('leaves a disabled bundled plugin alone', async () => {
    new PluginDisabledStore(root).add(PLUGIN_ID)
    launch()
    serveRegistry('1.1.0', ['ui'])
    await expect(controller.refreshBundledOfficial()).resolves.toEqual([])
  })
})
