// Testplace in the Host (plan mcp-navide-0-2-27 W5b, DX report §9.5 and D3):
// joining, listing and leaving with the user's Navide Cloud account, a test
// build installed through the unchanged verify / consent / commit path, and
// an expired build that is stopped with its data kept, then kept on request.
// Kept apart from pluginIpc.test.ts so the Marketplace suite there stays as
// it is on main.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeZip } from './zipFixture'
import { sha256Hex } from './pluginVerify'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import type { InstallerTrustConfig } from './pluginInstaller'
import type { PluginActivationCatalogEntry } from './installedPlugins'
import { writeRegistryTrustSnapshot } from './pluginInstalledTrust'

const { handlers, registry } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  registry: {
    fetch: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
    download: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  },
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.2.27' },
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

// The Host's developer account: the token stays inside it, so a test only
// sees the paths and bodies it is asked for.
vi.mock('./developerAccount', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./developerAccount')>()),
  developerRegistryFetch: (...args: unknown[]) => registry.fetch(...args),
  developerRegistryDownload: (...args: unknown[]) => registry.download(...args),
}))

vi.setConfig({ testTimeout: 30_000 })

import { registerPluginIpc } from './pluginIpc'
import { FrontendPluginManager } from './frontendPluginManager'

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey }
}
const signCanonical = (value: unknown, key: Parameters<typeof edSign>[2]): string =>
  edSign(null, Buffer.from(canonicalTrustJson(value), 'utf8'), key).toString('base64')

const root = keypair()
const signer = keypair()
const INSTALL_AT = new Date('2026-08-16T12:00:00.000Z')
const EXPIRES_AT = '2026-08-16T13:00:00.000Z'
const AFTER_EXPIRY = new Date('2026-08-16T14:00:00.000Z')
const config = (now: Date): InstallerTrustConfig => ({ pinnedRegistryRootKey: root.pubPem, now })

function metadata(blocked: RegistryTrustMetadata['blockedPackages'] = []): RegistryTrustMetadata {
  return {
    schemaVersion: 1, registryProfile: 'self-hosted-dev', rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z', expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [{ keyId: 'k1', publicKey: signer.pubPem, status: 'active', notBefore: '2026-08-01T00:00:00.000Z', notAfter: '2026-09-01T00:00:00.000Z' }],
    blockedPublishers: [], blockedPackages: blocked,
  }
}

const ID = 'acme.beta'
const bytes = new Uint8Array(makeZip([
  {
    name: 'manifest.json',
    data: JSON.stringify({
      schemaVersion: 2, apiVersion: '^1.0.0', id: ID, name: 'Beta', version: '0.3.0', publisher: 'acme', permissions: {},
      marketplace: { description: 'Test build', license: 'MIT' },
      contributes: { views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Beta', entry: 'frontend/left/index.html' }] },
    }),
  },
  { name: 'frontend/left/index.html', data: '<!doctype html>' },
]))
const digest = sha256Hex(bytes)
const envelope: RegistryPackageEnvelope = {
  schemaVersion: 1, artifactDigest: digest, packageId: ID, version: '0.3.0', target: 'universal',
  publisherId: 'acme', keyId: 'k1', signedAt: '2026-08-16T11:00:00.000Z', channel: 'testplace', expiresAt: EXPIRES_AT,
}
const testplaceDetail = {
  namespace: 'acme', name: 'beta', identity: 'acme.beta', display_name: 'Beta', description: null, publisher: 'acme',
  trust_metadata: metadata(), trust_metadata_signature: signCanonical(metadata(), root.privateKey),
  versions: [{
    version: '0.3.0', package_digest: digest, target: 'universal', registry_envelope: envelope,
    registry_signature: signCanonical(envelope, signer.privateKey), trust_tier: 'signed-verified', yanked: false,
    channel: 'testplace', expires_at: EXPIRES_AT, promotion_status: null,
  }],
}

let base = ''
let pluginsRoot = ''
let activations: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }>
let controller: ReturnType<typeof registerPluginIpc>

function register(now = INSTALL_AT) {
  handlers.clear()
  const manager = new FrontendPluginManager()
  controller = registerPluginIpc(manager, pluginsRoot, () => true, config(now), undefined, {
    cleanupPluginStorage: async () => undefined,
    preflightCandidateFrontend: async () => undefined,
    preflightCandidateBackend: async () => undefined,
    onActivationChange: (change) => activations.push(change),
  })
  return manager
}

const call = (channel: string, args?: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} is not registered`)
  return handler(null, args)
}

async function installTestBuild(): Promise<void> {
  await call('plugins:prepareInstall', { namespace: 'acme', name: 'beta', testplace: true })
  await call('plugins:commitInstall', { id: ID, publisherConfirmed: true, riskConfirmed: true })
  await call('plugins:restart', { id: ID })
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'navide-testplace-')))
  pluginsRoot = join(base, 'plugins')
  mkdirSync(pluginsRoot)
  activations = []
  registry.fetch = vi.fn(async (path: string, init?: { method?: string; json?: { token?: string } }) => {
    if (path === '/api/testplace/join') {
      return init?.json?.token?.startsWith('tpc_')
        ? { status: 200, body: { namespace: 'acme', name: 'beta', identity: 'acme.beta' } }
        : { status: 404, body: { detail: { code: 'NOT_FOUND', message: 'invite or code not found' } } }
    }
    if (path === '/api/testplace') return { status: 200, body: { items: [testplaceDetail] } }
    if (path === '/api/testplace/acme/beta') return { status: 200, body: testplaceDetail }
    if (path === '/api/testplace/acme/beta/leave') return { status: 204, body: null }
    return { status: 404, body: { detail: { code: 'NOT_FOUND', message: path } } }
  })
  registry.download = vi.fn(async () => ({ status: 200, body: Buffer.from(bytes), digest }))
  // The public Registry must never be asked for a test build.
  global.fetch = vi.fn(async () => { throw new Error('public Registry called') }) as unknown as typeof fetch
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('Testplace join, list and leave', () => {
  it('records how the user joined, lists it, and forgets it on leave', async () => {
    register()
    await expect(call('plugins:testplaceJoin', { code: 'nothing here' })).rejects.toThrow(/TESTPLACE_ERROR \[BAD_CODE\]/)
    await expect(call('plugins:testplaceJoin', { code: 'tpi_unknown' })).rejects.toThrow(/TESTPLACE_ERROR \[NOT_FOUND\]/)
    // A pasted invitation message still yields its code.
    expect(await call('plugins:testplaceJoin', { code: 'Join my test: tpc_abc123 thanks!' })).toEqual({ id: ID })
    expect(registry.fetch).toHaveBeenCalledWith('/api/testplace/join', { method: 'POST', json: { token: 'tpc_abc123' } }, 'account')
    const listed = (await call('plugins:testplaceList')) as Array<Record<string, unknown>>
    expect(listed).toEqual([expect.objectContaining({
      id: ID, via: 'code', versions: [{ version: '0.3.0', target: 'universal', expiresAt: EXPIRES_AT, installable: true, compatible: null }],
    })])
    await call('plugins:testplaceLeave', { id: ID })
    expect(((await call('plugins:testplaceList')) as Array<{ via: unknown }>)[0].via).toBeNull()
    // Nothing the user's account holds is ever written into the App's own record.
    expect(readFileSync(join(pluginsRoot, '.navide-testplace.json'), 'utf8')).not.toMatch(/token|tpc_|tpi_/)
  })
})

describe('installing a Testplace build', () => {
  it("fetches with the user's account and runs the same verified install", async () => {
    register()
    await call('plugins:testplaceJoin', { code: 'tpc_abc123' })
    const prepared = (await call('plugins:prepareInstall', { namespace: 'acme', name: 'beta', testplace: true })) as Record<string, unknown>
    expect(prepared).toMatchObject({ id: ID, version: '0.3.0', source: 'testplace', expiresAt: EXPIRES_AT, testplaceVia: 'code' })
    expect(registry.download).toHaveBeenCalledWith('/api/testplace/acme/beta/0.3.0/download', 'account')
    expect(global.fetch).not.toHaveBeenCalled()
    await call('plugins:commitInstall', { id: ID, publisherConfirmed: true, riskConfirmed: true })
    await call('plugins:restart', { id: ID })
    const installed = (call('plugins:listInstalled') as Array<Record<string, unknown>>).find((row) => row.id === ID)
    expect(installed).toMatchObject({ source: 'testplace', expiresAt: EXPIRES_AT, testplaceVia: 'code' })
    // The chrome mark above its view reads the same signed expiry.
    const views = (call('plugins:listContributions') as Array<Record<string, unknown>>).filter((row) => row.pluginId === ID)
    expect(views.length).toBeGreaterThan(0)
    for (const view of views) expect(view).toMatchObject({ source: 'testplace', expiresAt: EXPIRES_AT, testplaceVia: 'code' })
  })

  it('refuses a swapped package whatever the account fetched', async () => {
    register()
    registry.download.mockResolvedValue({ status: 200, body: Buffer.from(bytes), digest: 'f'.repeat(64) })
    await expect(call('plugins:prepareInstall', { namespace: 'acme', name: 'beta', testplace: true })).rejects.toThrow(/digest/)
  })
})

describe('an expired Testplace build (D3)', () => {
  it('is stopped with its files kept, listed, and loaded again once the user keeps it', async () => {
    register()
    await installTestBuild()
    // Next start, after the signed expiry: not loaded, and said so.
    const manager = register(AFTER_EXPIRY)
    expect(manager.listInstalledPackages().some((pkg) => pkg.id === ID)).toBe(false)
    expect(existsSync(join(pluginsRoot, ID))).toBe(true)
    expect(call('plugins:expiredTestplace')).toEqual([
      { id: ID, version: '0.3.0', expiresAt: EXPIRES_AT, artifactDigest: digest, canKeep: true },
    ])
    expect(call('plugins:keepExpiredTestplace', { id: ID })).toEqual({ ok: true })
    expect(manager.listInstalledPackages().some((pkg) => pkg.id === ID)).toBe(true)
    expect(activations.some((change) => change.pluginId === ID && change.activation)).toBe(true)
    expect(call('plugins:expiredTestplace')).toEqual([])
    // Kept for this digest across a restart too: it verifies, so it is not listed as stopped.
    const restarted = register(AFTER_EXPIRY)
    expect(call('plugins:expiredTestplace')).toEqual([])
    const loaded = restarted.loadInstalledPlugins(pluginsRoot, {
      provenance: 'official-registry',
      trust: {
        pinnedRootKey: root.pubPem,
        snapshot: JSON.parse(readFileSync(join(pluginsRoot, '.navide-registry-trust.json'), 'utf8')),
        now: AFTER_EXPIRY,
        keepsExpiredTestplace: (id, artifactDigest) => id === ID && artifactDigest === digest,
      },
    }, new Set([ID]))
    expect(loaded.activationCatalog.map((entry) => entry.pluginId)).toEqual([ID])
    // Without the user's choice the same start loads nothing.
    const refused = register(AFTER_EXPIRY).loadInstalledPlugins(pluginsRoot, {
      provenance: 'official-registry',
      trust: {
        pinnedRootKey: root.pubPem,
        snapshot: JSON.parse(readFileSync(join(pluginsRoot, '.navide-registry-trust.json'), 'utf8')),
        now: AFTER_EXPIRY,
      },
    }, new Set([ID]))
    expect(refused.activationCatalog).toEqual([])
  })

  it('is never kept once it was taken down', async () => {
    register()
    await installTestBuild()
    const blocked = metadata([{ packageId: ID, version: '0.3.0' }])
    writeRegistryTrustSnapshot(pluginsRoot, {
      schemaVersion: 1, metadata: { ...blocked, generatedAt: '2026-08-16T13:30:00.000Z' },
      metadataSignature: signCanonical({ ...blocked, generatedAt: '2026-08-16T13:30:00.000Z' }, root.privateKey),
    })
    register(AFTER_EXPIRY)
    // A takedown is not an expiry: it is not offered as an expired build at all.
    expect(call('plugins:expiredTestplace')).toEqual([])
    expect(() => call('plugins:keepExpiredTestplace', { id: ID })).toThrow(/not an expired Testplace build/)
  })

  it('forgets the choice when the plugin is removed', async () => {
    register()
    await installTestBuild()
    register(AFTER_EXPIRY)
    call('plugins:keepExpiredTestplace', { id: ID })
    expect(readFileSync(join(pluginsRoot, '.navide-testplace.json'), 'utf8')).toContain(digest)
    await call('plugins:remove', { id: ID })
    expect(readFileSync(join(pluginsRoot, '.navide-testplace.json'), 'utf8')).not.toContain(ID)
  })
})

describe('a promoted Testplace build (same digest, no reinstall)', () => {
  const stable: RegistryPackageEnvelope = {
    schemaVersion: 1, artifactDigest: digest, packageId: ID, version: '0.3.0', target: 'universal',
    publisherId: 'acme', keyId: 'k1', signedAt: '2026-08-16T11:30:00.000Z',
  }
  function publicListing(row: Partial<{ package_digest: string; registry_envelope: RegistryPackageEnvelope }> = {}) {
    const detail = {
      trust_metadata: metadata(), trust_metadata_signature: signCanonical(metadata(), root.privateKey),
      versions: [{
        version: '0.3.0', target: 'universal', package_digest: digest, yanked: false,
        registry_envelope: stable, registry_signature: signCanonical(stable, signer.privateKey), ...row,
      }],
    }
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => detail })) as unknown as typeof fetch
  }
  const receipt = () => {
    const dir = join(pluginsRoot, ID, '0.3.0', 'universal', 'package')
    return JSON.parse(readFileSync(join(dir, '.navide-registry-receipt.json'), 'utf8')) as { envelope: RegistryPackageEnvelope }
  }

  it('takes the stable receipt in place and keeps the grant; the source reads marketplace', async () => {
    register()
    await installTestBuild()
    const before = (call('plugins:listInstalled') as Array<Record<string, unknown>>).find((row) => row.id === ID)!
    publicListing()
    expect(await call('plugins:adoptTestplaceRelease', { id: ID })).toEqual({ adopted: true })
    expect(receipt().envelope).toEqual(stable)
    const after = (call('plugins:listInstalled') as Array<Record<string, unknown>>).find((row) => row.id === ID)!
    expect(after.source).toBe('marketplace')
    expect(after.expiresAt).toBeUndefined()
    expect(after.packageVersion).toBe('0.3.0')
    expect(after.packageVersionGrant).toEqual(before.packageVersionGrant)
    // Nothing was downloaded.
    expect(registry.download).toHaveBeenCalledTimes(1)
    // Once adopted there is nothing left to adopt.
    expect(await call('plugins:adoptTestplaceRelease', { id: ID })).toEqual({ adopted: false })
  })

  it('adopts nothing when the public version is another artifact', async () => {
    register()
    await installTestBuild()
    const other = { ...stable, artifactDigest: 'f'.repeat(64) }
    publicListing({ package_digest: 'f'.repeat(64), registry_envelope: other })
    expect(await call('plugins:adoptTestplaceRelease', { id: ID })).toEqual({ adopted: false })
    expect(receipt().envelope).toEqual(envelope)
  })

  it('brings an expired build back on the next trust refresh once it was promoted', async () => {
    register()
    await installTestBuild()
    register(AFTER_EXPIRY)
    expect(call('plugins:expiredTestplace')).toHaveLength(1)
    publicListing()
    const refreshed = await controller.refreshRegistryTrust()
    expect(refreshed.activationCatalog.map((entry) => entry.pluginId)).toEqual([ID])
    expect(receipt().envelope).toEqual(stable)
    expect(call('plugins:expiredTestplace')).toEqual([])
  })
})
