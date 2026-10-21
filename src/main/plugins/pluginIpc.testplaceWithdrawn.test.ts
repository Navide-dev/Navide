// 0.2.28: a Testplace build its developer or Navide took back reaches a
// tester who is offline or signed out through the root-signed local-install
// document (`blockedDigests`, reason `testplace-withdrawn`), matched by the
// digest the install receipt names. The tester sees a label and one notice
// and chooses to keep using, disable or remove it; nothing is disabled for
// it. Fixture copied from pluginIpc.testplace.test.ts, which stays as it is.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeZip } from './zipFixture'
import { sha256Hex } from './pluginVerify'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import type { InstallerTrustConfig } from './pluginInstaller'
import type { LocalInstallTrustMetadata } from './pluginLocalInstallTrust'
import type { DigestBlockChoice, DigestBlockPrompt } from './pluginDigestBlock'

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
const EXPIRES_AT = '2026-11-14T13:00:00.000Z'
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
/** What the signed-in tester detail's withdrawal list answers (the 15-minute fast path). */
let withdrawnAnswer: { status: number; body: unknown }
const prompt = vi.fn<(ask: DigestBlockPrompt) => Promise<DigestBlockChoice>>()

function register() {
  handlers.clear()
  const manager = new FrontendPluginManager()
  const controller = registerPluginIpc(manager, pluginsRoot, () => true, config(INSTALL_AT), undefined, {
    cleanupPluginStorage: async () => undefined,
    preflightCandidateFrontend: async () => undefined,
    preflightCandidateBackend: async () => undefined,
    testplaceWithdrawalTimeoutMs: 50,
    promptDigestBlock: prompt,
  })
  return { manager, controller }
}

const call = (channel: string, args?: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} is not registered`)
  return handler(null, args)
}
const row = () => (call('plugins:listInstalled') as Array<Record<string, unknown>>).find((item) => item.id === ID)

async function installTestBuild(): Promise<void> {
  await call('plugins:prepareInstall', { namespace: 'acme', name: 'beta', testplace: true })
  await call('plugins:commitInstall', { id: ID, publisherConfirmed: true, riskConfirmed: true })
  await call('plugins:restart', { id: ID })
}

function localTrust(blockedDigests: LocalInstallTrustMetadata['blockedDigests']): LocalInstallTrustMetadata {
  return {
    schemaVersion: 1, kind: 'local-install-trust', registryProfile: 'self-hosted-dev',
    generatedAt: '2026-08-16T11:30:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', blockedDigests, publisherKeys: [],
  }
}
/** The public Registry, as the trust refresh sees it: only the local-install document. */
function serve(doc: LocalInstallTrustMetadata | null): void {
  global.fetch = vi.fn(async (url: unknown) => {
    if (doc && String(url).endsWith('/api/trust/local-install')) {
      return { ok: true, status: 200, json: async () => ({ local_trust_metadata: doc, local_trust_metadata_signature: signCanonical(doc, root.privateKey) }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'navide-testplace-withdrawn-')))
  pluginsRoot = join(base, 'plugins')
  mkdirSync(pluginsRoot)
  prompt.mockReset()
  prompt.mockResolvedValue('keep')
  withdrawnAnswer = { status: 200, body: { withdrawn: [] } }
  registry.fetch = vi.fn(async (path: string) => {
    if (path === '/api/testplace') return { status: 200, body: { items: [testplaceDetail] } }
    if (path === '/api/testplace/acme/beta') return { status: 200, body: testplaceDetail }
    if (path === '/api/testplace/acme/beta/withdrawn') return withdrawnAnswer
    return { status: 404, body: { detail: { code: 'NOT_FOUND', message: path } } }
  })
  registry.download = vi.fn(async () => ({ status: 200, body: Buffer.from(bytes), digest }))
  serve(null)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('a withdrawn Testplace build (0.2.28)', () => {
  it('is labelled, told once with three choices, and keeps running', async () => {
    const { manager, controller } = register()
    await installTestBuild()
    expect(row()).not.toHaveProperty('digestBlock')
    serve(localTrust([{ digest, reason: 'testplace-withdrawn' }]))
    expect(await controller.revalidateLocalInstalls()).toEqual({ quarantined: [] })
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    expect(prompt).toHaveBeenCalledWith({
      pluginId: ID, version: '0.3.0', reason: 'testplace-withdrawn', action: 'warn', testBuild: true,
    })
    expect(row()).toMatchObject({ source: 'testplace', digestBlock: { reason: 'testplace-withdrawn' }, disabled: false })
    expect(manager.listInstalledPackages().some((pkg) => pkg.id === ID)).toBe(true)
    // Told once per digest, across later refreshes and a restart.
    await controller.revalidateLocalInstalls()
    expect(prompt).toHaveBeenCalledTimes(1)
    const restarted = register()
    await restarted.controller.revalidateLocalInstalls()
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('the tester may disable it, and enable it again', async () => {
    const { controller } = register()
    await installTestBuild()
    prompt.mockResolvedValue('disable')
    serve(localTrust([{ digest, reason: 'testplace-withdrawn' }]))
    await controller.revalidateLocalInstalls()
    await vi.waitFor(() => expect(row()).toMatchObject({ disabled: true, digestBlock: { reason: 'testplace-withdrawn' } }))
    await vi.waitFor(async () => {
      await expect(call('plugins:setDisabled', { id: ID, disabled: false })).resolves.toMatchObject({ disabled: false })
    })
  })

  it('the tester may remove it', async () => {
    const { controller } = register()
    await installTestBuild()
    prompt.mockResolvedValue('remove')
    serve(localTrust([{ digest, reason: 'testplace-withdrawn' }]))
    await controller.revalidateLocalInstalls()
    await vi.waitFor(() => expect(row()).toBeUndefined())
  })

  it('other reasons and other digests leave a Registry install exactly as before', async () => {
    const { manager, controller } = register()
    await installTestBuild()
    const lists: LocalInstallTrustMetadata['blockedDigests'][] = [
      [{ digest, reason: 'security' }, { digest: 'e'.repeat(64), reason: 'testplace-withdrawn' }],
      [{ digest, reason: 'admin' }],
      [digest],
    ]
    for (const [index, entries] of lists.entries()) {
      serve({ ...localTrust(entries), generatedAt: `2026-08-16T11:3${index}:00.000Z` })
      expect(await controller.revalidateLocalInstalls()).toEqual({ quarantined: [] })
      expect(row()).not.toHaveProperty('digestBlock')
      expect(manager.listInstalledPackages().some((pkg) => pkg.id === ID)).toBe(true)
    }
    expect(prompt).not.toHaveBeenCalled()
  })

  // User, 10-21 (06:53): the signed-in fast path is kept only for learning of
  // it sooner; it never stops the build either.
  it('signed in: the fast path labels it and asks once, and never disables it', async () => {
    const { manager, controller } = register()
    await installTestBuild()
    withdrawnAnswer = { status: 200, body: { withdrawn: [{ version: '0.3.0', target: 'universal' }] } }
    // The public trust metadata is unreachable; the refresh falls back to the cached copy.
    await expect(controller.refreshRegistryTrust()).rejects.toThrow()
    expect(await controller.revalidateLocalInstalls()).toEqual({ quarantined: [] })
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    expect(prompt).toHaveBeenCalledWith({
      pluginId: ID, version: '0.3.0', reason: 'testplace-withdrawn', action: 'warn', testBuild: true,
    })
    expect(manager.listInstalledPackages().some((pkg) => pkg.id === ID)).toBe(true)
    expect(row()).toMatchObject({ digestBlock: { reason: 'testplace-withdrawn' }, disabled: false })
    expect(await call('plugins:expiredTestplace')).toEqual([])
  })

  it('told through both paths, the tester is still asked only once for that digest', async () => {
    const { controller } = register()
    await installTestBuild()
    withdrawnAnswer = { status: 200, body: { withdrawn: [{ version: '0.3.0', target: 'universal' }] } }
    await expect(controller.refreshRegistryTrust()).rejects.toThrow()
    await controller.revalidateLocalInstalls()
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    // The signed document now lists the same digest too.
    serve(localTrust([{ digest, reason: 'testplace-withdrawn' }]))
    await expect(controller.refreshRegistryTrust()).rejects.toThrow()
    await controller.revalidateLocalInstalls()
    expect(row()).toMatchObject({ digestBlock: { reason: 'testplace-withdrawn' }, disabled: false })
    const restarted = register()
    await restarted.controller.revalidateLocalInstalls()
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('the fast path finding nothing withdrawn leaves the build unlabelled', async () => {
    const { controller } = register()
    await installTestBuild()
    await expect(controller.refreshRegistryTrust()).rejects.toThrow()
    await controller.revalidateLocalInstalls()
    expect(prompt).not.toHaveBeenCalled()
    expect(row()).not.toHaveProperty('digestBlock')
  })

  // Review #551 round 3 LOW: a build the tester disabled is not loaded, but
  // it has not expired, so it is not listed with the expired builds.
  it('a withdrawn build the tester disabled is not listed as expired', async () => {
    const { controller } = register()
    await installTestBuild()
    prompt.mockResolvedValue('disable')
    withdrawnAnswer = { status: 200, body: { withdrawn: [{ version: '0.3.0', target: 'universal' }] } }
    await expect(controller.refreshRegistryTrust()).rejects.toThrow()
    await controller.revalidateLocalInstalls()
    await vi.waitFor(() => expect(row()).toMatchObject({ disabled: true, digestBlock: { reason: 'testplace-withdrawn' } }))
    // Next start: a disabled build is not loaded.
    const restarted = register()
    expect(restarted.manager.listInstalledPackages().some((pkg) => pkg.id === ID)).toBe(false)
    expect(await call('plugins:expiredTestplace')).toEqual([])
  })
})

