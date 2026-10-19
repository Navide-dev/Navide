// Plan W1: an agent's prefilled local install (S2, plugins_install_file_fill),
// A3 local signatures and the root-signed blocked-digest list. Kept apart
// from the K3/K4 suites, which stay exactly as they are on main: the agent
// path reuses their consent and commit, so only what it adds is tested here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeZip } from './zipFixture'
import { sha256Hex } from './pluginVerify'
import { canonicalTrustJson } from './pluginRegistryTrust'
import type { InstallerTrustConfig } from './pluginInstaller'
import { publisherKeyId, type LocalInstallTrustMetadata } from './pluginLocalInstallTrust'
import { localTrustRecordPath } from './pluginLocalInstall'
import { readLocalTrustRecord } from './pluginLocalTrust'
import { backendEntryOnDisk } from './installedPlugins'

const { handlers, packaged } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  packaged: { value: false },
}))

vi.mock('electron', () => ({
  app: { get isPackaged() { return packaged.value }, getVersion: () => '0.2.26' },
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

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey }
}
const signCanonical = (value: unknown, key: Parameters<typeof edSign>[2]): string =>
  edSign(null, Buffer.from(canonicalTrustJson(value), 'utf8'), key).toString('base64')

const registryRoot = keypair()
const vetted = keypair()
const revoked = keypair()
const TRUST_CONFIG: InstallerTrustConfig = { pinnedRegistryRootKey: registryRoot.pubPem, now: new Date('2026-10-20T12:00:00.000Z') }

function manifestFor(id: string, version = '1.0.0', withBackend = false): Record<string, unknown> {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id,
    name: 'Todo Scout',
    version,
    publisher: id.split('.')[0],
    permissions: {},
    marketplace: { description: 'Local test package', license: 'MIT' },
    contributes: { views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Todo', entry: 'frontend/left/index.html' }] },
    ...(withBackend ? { backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup', methods: ['todo.scan'] } } : {}),
  }
}

function vsix(id = 'acme.todo', version = '1.0.0', html = '<!doctype html>'): Uint8Array {
  return new Uint8Array(makeZip([
    { name: 'manifest.json', data: JSON.stringify(manifestFor(id, version)) },
    { name: 'frontend/left/index.html', data: html },
  ]))
}

function localTrust(overrides: Partial<LocalInstallTrustMetadata> = {}): LocalInstallTrustMetadata {
  return {
    schemaVersion: 1,
    kind: 'local-install-trust',
    registryProfile: 'official',
    generatedAt: '2026-10-20T10:00:00Z',
    expiresAt: '2026-10-21T10:00:00Z',
    blockedDigests: [],
    publisherKeys: [
      { publisherId: 'acme', keyId: publisherKeyId(vetted.pubPem), publicKey: vetted.pubPem, status: 'active', revokedAt: null },
      { publisherId: 'acme', keyId: publisherKeyId(revoked.pubPem), publicKey: revoked.pubPem, status: 'revoked', revokedAt: '2026-10-19T00:00:00Z' },
    ],
    ...overrides,
  }
}

/** The Registry as the Host sees it: only the local install trust document. */
function serve(doc: LocalInstallTrustMetadata | null): void {
  global.fetch = vi.fn(async (url: unknown) => {
    if (doc && String(url).endsWith('/api/trust/local-install')) {
      return { ok: true, status: 200, json: async () => ({ local_trust_metadata: doc, local_trust_metadata_signature: signCanonical(doc, registryRoot.privateKey) }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const signFile = (bytes: Uint8Array, key: typeof vetted): string =>
  edSign(null, Buffer.from(sha256Hex(bytes), 'ascii'), key.privateKey).toString('base64')

let base = ''
let pluginsRoot = ''
let picked = ''

function register(extra: Record<string, unknown> = {}): FrontendPluginManager {
  const manager = new FrontendPluginManager()
  registerPluginIpc(manager, pluginsRoot, () => true, TRUST_CONFIG, undefined, {
    cleanupPluginStorage: async () => undefined,
    preflightCandidateFrontend: async () => undefined,
    preflightCandidateBackend: async () => undefined,
    pickLocalPackageFile: async () => picked,
    pickDeveloperFolder: async () => null,
    ...extra,
  })
  return manager
}

const call = (channel: string, args?: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} is not registered`)
  return handler(null, args)
}

type Prepared = { id: string; digest: string; source: string; localSignature: Record<string, unknown>; scan: unknown; localScan: string }

beforeEach(() => {
  handlers.clear()
  packaged.value = false
  base = realpathSync(mkdtempSync(join(tmpdir(), 'navide-agent-file-')))
  pluginsRoot = join(base, 'plugins')
  mkdirSync(pluginsRoot)
  picked = join(base, 'todo-scout.vsix')
  serve(localTrust())
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('plugins_install_file_fill: an agent prefills, the user approves', () => {
  it('installs nothing before approval, then exactly the bytes whose digest the card showed', async () => {
    const manager = register()
    const bytes = vsix()
    writeFileSync(picked, bytes)
    const prepared = await call('plugins:prepareAgentFileInstall', { path: picked }) as Prepared
    expect(prepared).toMatchObject({ id: 'acme.todo', digest: sha256Hex(bytes), source: 'local-unsigned' })
    expect(manager.listInstalledPackages()).toEqual([])
    expect(call('plugins:listInstalled')).toEqual([])
    // The file changes on disk after the card: the held bytes are what installs.
    writeFileSync(picked, vsix('acme.todo', '1.0.0', '<!doctype html><p>changed</p>'))
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, expectedDigest: prepared.digest })
    await call('plugins:restart', { id: 'acme.todo' })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.todo', packageVersion: '1.0.0', source: 'local-unsigned' }])
    const record = readLocalTrustRecord(localTrustRecordPath(pluginsRoot, 'acme.todo'))
    expect(record.signer).toBeNull()
  })

  it('still needs the user\'s consent, and refuses a file that is not the one approved', async () => {
    register()
    writeFileSync(picked, vsix())
    const prepared = await call('plugins:prepareAgentFileInstall', { path: picked }) as Prepared
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo', expectedDigest: prepared.digest })).rejects.toThrow(/consent is required/)
    // Another prepare of the same id since the card (here the user's own pick) replaces the held bytes.
    writeFileSync(picked, vsix('acme.todo', '1.0.0', '<p>other</p>'))
    await call('plugins:installFromFile')
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, expectedDigest: prepared.digest }))
      .rejects.toThrow(/not the one that was approved/)
    expect(call('plugins:listInstalled')).toEqual([])
  })

  it('takes only an absolute path to a regular file or a folder', async () => {
    register()
    await expect(call('plugins:prepareAgentFileInstall', { path: 'todo-scout.vsix' })).rejects.toThrow(/absolute path/)
    await expect(call('plugins:prepareAgentFileInstall', {})).rejects.toThrow(/absolute path/)
    await expect(call('plugins:prepareAgentFileInstall', { path: join(base, 'missing.vsix') })).rejects.toThrow()
  })

  it('takes a folder only with Developer Mode on, through the K4 consent', async () => {
    packaged.value = true
    register()
    const dir = join(base, 'dev-todo')
    mkdirSync(join(dir, 'frontend', 'left'), { recursive: true })
    mkdirSync(join(dir, 'backend'), { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifestFor('acme.devtodo', '0.1.0', true)))
    writeFileSync(join(dir, 'frontend', 'left', 'index.html'), '<!doctype html>')
    writeFileSync(join(dir, backendEntryOnDisk('backend/entry')), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    chmodSync(join(dir, backendEntryOnDisk('backend/entry')), 0o755)
    await expect(call('plugins:prepareAgentFileInstall', { path: dir })).rejects.toThrow(/DEVELOPER_MODE_OFF/)
    await call('plugins:setDeveloperMode', { enabled: true })
    const prepared = await call('plugins:prepareAgentFileInstall', { path: dir }) as Prepared
    expect(prepared).toMatchObject({ id: 'acme.devtodo', source: 'developer-unpacked' })
    expect(call('plugins:listInstalled')).toEqual([])
    await call('plugins:commitFolderLoad', { id: 'acme.devtodo', riskConfirmed: true })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.devtodo', source: 'developer-unpacked' }])
  })
})

describe('digest takedown', () => {
  it('refuses a file whose digest is on the root-signed blocked list, from the user and from an agent', async () => {
    const bytes = vsix()
    serve(localTrust({ blockedDigests: [sha256Hex(bytes)] }))
    register()
    writeFileSync(picked, bytes)
    await expect(call('plugins:installFromFile')).rejects.toThrow(/DIGEST_BLOCKED/)
    await expect(call('plugins:prepareAgentFileInstall', { path: picked })).rejects.toThrow(/DIGEST_BLOCKED/)
    // A one-byte change is another file; the takedown names bytes, not an id.
    writeFileSync(picked, vsix('acme.todo', '1.0.0', '<p>x</p>'))
    await expect(call('plugins:installFromFile')).resolves.toMatchObject({ id: 'acme.todo' })
  })

  it('ignores a blocked list the pinned root did not sign', async () => {
    const bytes = vsix()
    const doc = localTrust({ blockedDigests: [sha256Hex(bytes)] })
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ local_trust_metadata: doc, local_trust_metadata_signature: signCanonical(doc, vetted.privateKey) }),
    })) as unknown as typeof fetch
    register()
    writeFileSync(picked, bytes)
    await expect(call('plugins:installFromFile')).resolves.toMatchObject({ id: 'acme.todo' })
  })
})

describe('A3: a local file signed by a vetted publisher', () => {
  async function install(bytes: Uint8Array, signature: string | null): Promise<Prepared> {
    writeFileSync(picked, bytes)
    if (signature !== null) writeFileSync(`${picked}.sig`, `${signature}\n`)
    const prepared = await call('plugins:installFromFile') as Prepared
    await call('plugins:commitLocalInstall', { id: prepared.id, riskConfirmed: true })
    await call('plugins:restart', { id: prepared.id })
    return prepared
  }

  it('signed: shown as signed by that publisher, and kept as evidence in the consent record', async () => {
    register()
    const bytes = vsix()
    const prepared = await install(bytes, signFile(bytes, vetted))
    expect(prepared.localSignature).toEqual({ state: 'verified', publisherId: 'acme', keyId: publisherKeyId(vetted.pubPem) })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.todo', source: 'local-unsigned', localSignature: 'verified' }])
    expect(readLocalTrustRecord(localTrustRecordPath(pluginsRoot, 'acme.todo')).signer).toMatchObject({
      publisherId: 'acme', keyId: publisherKeyId(vetted.pubPem), artifactDigest: sha256Hex(bytes),
    })
  })

  it('unsigned: no signature, no signed label', async () => {
    register()
    const prepared = await install(vsix(), null)
    expect(prepared.localSignature).toEqual({ state: 'none' })
    const [row] = call('plugins:listInstalled') as Array<Record<string, unknown>>
    expect(row.localSignature).toBeUndefined()
  })

  it('signature no longer valid: a revoked key at install, or a key the Registry revokes later', async () => {
    register()
    const bytes = vsix()
    const atInstall = await install(bytes, signFile(bytes, revoked))
    expect(atInstall.localSignature).toMatchObject({ state: 'revoked', publisherId: 'acme' })
    expect(readLocalTrustRecord(localTrustRecordPath(pluginsRoot, 'acme.todo')).signer).toBeNull()

    handlers.clear()
    rmSync(pluginsRoot, { recursive: true, force: true })
    mkdirSync(pluginsRoot)
    serve(localTrust())
    register()
    await install(bytes, signFile(bytes, vetted))
    expect(call('plugins:listInstalled')).toMatchObject([{ localSignature: 'verified' }])
    // The Registry revokes the key: the next document lists it as revoked.
    serve(localTrust({
      generatedAt: '2026-10-20T11:00:00Z',
      publisherKeys: localTrust().publisherKeys.map((key) => ({ ...key, status: 'revoked' as const, revokedAt: '2026-10-20T10:30:00Z' })),
    }))
    writeFileSync(picked, vsix('acme.other'))
    await call('plugins:installFromFile')
    expect((call('plugins:listInstalled') as Array<Record<string, unknown>>).find((row) => row.id === 'acme.todo'))
      .toMatchObject({ localSignature: 'revoked' })
  })

  it('a signature by another publisher is not a signed label', async () => {
    register()
    const bytes = vsix('other.todo')
    const prepared = await install(bytes, signFile(bytes, vetted))
    expect(prepared.localSignature).toEqual({ state: 'unverifiable', publisherId: 'other' })
  })
})

describe('the static scan of a local file', () => {
  it('says the scan is unavailable without a scanner, and shows the shared scanner\'s report with one', async () => {
    register()
    writeFileSync(picked, vsix())
    expect(await call('plugins:installFromFile')).toMatchObject({ scan: null, localScan: 'unavailable' })
    handlers.clear()
    const report = { schemaVersion: 1 }
    const scanLocalPackage = vi.fn((_input: { files: Map<string, Uint8Array>; artifactDigest: string; target: string }) => report)
    register({ scanLocalPackage })
    expect(await call('plugins:installFromFile')).toMatchObject({ scan: report, localScan: 'ran' })
    const input = scanLocalPackage.mock.calls[0][0]
    expect([...input.files.keys()].sort()).toEqual(['frontend/left/index.html', 'manifest.json'])
    expect(input).toMatchObject({ artifactDigest: sha256Hex(vsix()), target: 'universal' })
  })

  it('a scanner failure never blocks the install', async () => {
    register({ scanLocalPackage: () => { throw new Error('boom') } })
    writeFileSync(picked, vsix())
    expect(await call('plugins:installFromFile')).toMatchObject({ id: 'acme.todo', scan: null })
  })
})
