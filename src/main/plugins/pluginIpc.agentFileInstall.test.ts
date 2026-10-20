// Plan W1: an agent's prefilled local install (S2, plugins_install_file_fill),
// A3 local signatures and the root-signed blocked-digest list. Kept apart
// from the K3/K4 suites, which stay exactly as they are on main: the agent
// path reuses their consent and commit, so only what it adds is tested here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
    expiresAt: '2099-01-01T10:00:00Z',
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

let query: (q: unknown) => Promise<unknown>

function register(extra: Record<string, unknown> = {}): FrontendPluginManager {
  const manager = new FrontendPluginManager()
  vi.spyOn(manager, 'setMarketplaceQueryHandler').mockImplementation((handler) => {
    query = handler
  })
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

/** What the backend does for plugins_install_file_fill: stage, then the
 * main window prepares the staged copy for the consent dialog. */
async function stage(path: string): Promise<{ ok: boolean; result?: { report: Record<string, unknown> & { stagingId?: string; digest: string } }; error?: string; error_code?: string }> {
  return await query({ kind: 'localStage', path }) as never
}
async function prepareStaged(path: string): Promise<Prepared> {
  const staged = await stage(path)
  if (!staged.ok || !staged.result?.report.stagingId) throw new Error(staged.error ?? JSON.stringify(staged.result?.report.errors))
  return await call('plugins:prepareAgentFileInstall', { stagingId: staged.result.report.stagingId }) as Prepared
}

type Prepared = { id: string; digest: string; source: string; localSignature: Record<string, unknown>; scan: unknown; localScan: string }

beforeEach(() => {
  handlers.clear()
  packaged.value = false
  base = realpathSync(mkdtempSync(join(tmpdir(), 'navide-agent-file-')))
  // Navide's data folder is the plugins root's parent; packages live outside it.
  pluginsRoot = join(base, 'userData', 'plugins')
  mkdirSync(pluginsRoot, { recursive: true })
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
    const staged = await stage(picked)
    expect(staged.result?.report).toMatchObject({ valid: true, id: 'acme.todo', version: '1.0.0', digest: sha256Hex(bytes) })
    // The file changes on disk after the agent's request: the staged bytes are what the card and the install use.
    writeFileSync(picked, vsix('acme.todo', '1.0.0', '<!doctype html><p>changed</p>'))
    const prepared = await call('plugins:prepareAgentFileInstall', { stagingId: staged.result!.report.stagingId }) as Prepared
    expect(prepared).toMatchObject({ id: 'acme.todo', digest: sha256Hex(bytes), source: 'local-unsigned' })
    expect(manager.listInstalledPackages()).toEqual([])
    expect(call('plugins:listInstalled')).toEqual([])
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, expectedDigest: prepared.digest })
    await call('plugins:restart', { id: 'acme.todo' })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.todo', packageVersion: '1.0.0', source: 'local-unsigned' }])
    const record = readLocalTrustRecord(localTrustRecordPath(pluginsRoot, 'acme.todo'))
    expect(record.signer).toBeNull()
  })

  it('still needs the user\'s consent, and refuses a file that is not the one approved', async () => {
    register()
    writeFileSync(picked, vsix())
    const prepared = await prepareStaged(picked)
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo', expectedDigest: prepared.digest })).rejects.toThrow(/consent is required/)
    // Another prepare of the same id since the card (here the user's own pick) replaces the held bytes.
    writeFileSync(picked, vsix('acme.todo', '1.0.0', '<p>other</p>'))
    await call('plugins:installFromFile')
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, expectedDigest: prepared.digest }))
      .rejects.toThrow(/not the one that was approved/)
    expect(call('plugins:listInstalled')).toEqual([])
  })

  it('never reads Navide\'s own data folder', async () => {
    register()
    expect(await stage(join(base, 'userData', 'plugins'))).toMatchObject({ ok: false, error: expect.stringMatching(/own data folder/) })
  })

  it('takes only an absolute path to a regular file or a folder; the window names only a staged copy', async () => {
    register()
    expect(await stage('todo-scout.vsix')).toMatchObject({ ok: false, error: expect.stringMatching(/absolute/) })
    expect(await stage(join(base, 'missing.vsix'))).toMatchObject({ ok: false })
    // The main window cannot name a path, only a stagingId the Host made.
    writeFileSync(picked, vsix())
    await expect(call('plugins:prepareAgentFileInstall', { path: picked })).rejects.toThrow(/staged package/)
    await expect(call('plugins:prepareAgentFileInstall', { stagingId: 'f'.repeat(32) })).rejects.toThrow(/staged package/)
  })

  it('stages nothing for a package a local install refuses, and says why', async () => {
    register()
    writeFileSync(picked, vsix('navide.todo'))
    const staged = await stage(picked)
    expect(staged.result?.report).toMatchObject({ valid: false })
    expect(staged.result?.report.stagingId).toBeUndefined()
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
    expect(await stage(dir)).toMatchObject({ ok: false, error: expect.stringMatching(/DEVELOPER_MODE_OFF/) })
    await call('plugins:setDeveloperMode', { enabled: true })
    const prepared = await prepareStaged(dir)
    expect(prepared).toMatchObject({ id: 'acme.devtodo', source: 'developer-unpacked' })
    expect(call('plugins:listInstalled')).toEqual([])
    await call('plugins:commitFolderLoad', { id: 'acme.devtodo', riskConfirmed: true })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.devtodo', source: 'developer-unpacked' }])
  })
})

describe('MED-5: staged copies live as long as their request', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps every staged copy, the fifth and later included, so no earlier card fails', async () => {
    register()
    const ids: string[] = []
    for (let n = 0; n < 7; n += 1) {
      const path = join(base, `todo-${n}.vsix`)
      writeFileSync(path, vsix(`acme.todo${n}`))
      const staged = await stage(path)
      ids.push(staged.result!.report.stagingId!)
    }
    for (const [n, stagingId] of ids.entries()) {
      await expect(call('plugins:prepareAgentFileInstall', { stagingId })).resolves.toMatchObject({ id: `acme.todo${n}` })
    }
  })

  it('says a copy expired once its request has, never just "gone"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'))
    register()
    writeFileSync(picked, vsix())
    const kept = (await stage(picked)).result!.report.stagingId!
    const late = (await stage(picked)).result!.report.stagingId!
    // Still there for the whole life of the request (15 minutes).
    vi.setSystemTime(new Date('2026-10-20T10:14:59Z'))
    await expect(call('plugins:prepareAgentFileInstall', { stagingId: kept })).resolves.toMatchObject({ id: 'acme.todo' })
    vi.setSystemTime(new Date('2026-10-20T10:17:00Z'))
    await expect(call('plugins:prepareAgentFileInstall', { stagingId: late })).rejects.toThrow(/^AGENT_STAGING_EXPIRED/)
  })

  const stagingDir = (): string => join(base, 'userData', 'plugin-staging', 'agent-file')
  const stagedFiles = (): string[] => (existsSync(stagingDir()) ? readdirSync(stagingDir()) : [])

  it('keeps the copy on disk, not in memory, and refuses it once its bytes changed there', async () => {
    register()
    writeFileSync(picked, vsix())
    const stagingId = (await stage(picked)).result!.report.stagingId!
    expect(stagedFiles()).toEqual([`${sha256Hex(vsix())}.vsix`])
    writeFileSync(join(stagingDir(), `${sha256Hex(vsix())}.vsix`), vsix('acme.todo', '1.0.0', '<p>swapped</p>'))
    await expect(call('plugins:prepareAgentFileInstall', { stagingId })).rejects.toThrow(/^STAGING_DIGEST_MISMATCH/)
    expect(stagedFiles()).toEqual([])
    expect(call('plugins:listInstalled')).toEqual([])
  })

  it('R1: a staging folder that cannot be made fails only the agent request, which says why', async () => {
    // A file where the folder belongs: mkdir fails as it would without permission.
    writeFileSync(join(base, 'userData', 'plugin-staging'), 'in the way')
    expect(() => register()).not.toThrow()
    // Every other Navide plugin IPC works as before.
    expect(call('plugins:listInstalled')).toEqual([])
    writeFileSync(picked, vsix())
    await expect(call('plugins:installFromFile')).resolves.toMatchObject({ id: 'acme.todo' })
    // The agent's request reports the failure instead of staging nothing silently.
    const staged = await stage(picked)
    expect(staged).toMatchObject({ ok: false })
    expect(staged.error).toMatch(/plugin-staging/)
    expect(staged.result?.report.stagingId).toBeUndefined()
  })

  it('LOW-2: clears what an earlier run left as soon as the Host starts', () => {
    mkdirSync(stagingDir(), { recursive: true })
    writeFileSync(join(stagingDir(), `${'e'.repeat(64)}.vsix`), 'orphan')
    register()
    expect(stagedFiles()).toEqual([])
  })

  it('deletes the copy once the user decides, and once its request expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'))
    register()
    writeFileSync(picked, vsix())
    const approved = (await stage(picked)).result!.report.stagingId!
    const rejected = (await stage(picked)).result!.report.stagingId!
    const expired = (await stage(picked)).result!.report.stagingId!
    // Three requests for the same file share one staged copy.
    expect(stagedFiles()).toEqual([`${sha256Hex(vsix())}.vsix`])
    await call('plugins:prepareAgentFileInstall', { stagingId: approved })
    await call('plugins:discardAgentStaged', { stagingId: rejected })
    expect(stagedFiles()).toEqual([`${sha256Hex(vsix())}.vsix`])
    vi.setSystemTime(new Date('2026-10-20T10:17:00Z'))
    await expect(call('plugins:prepareAgentFileInstall', { stagingId: expired })).rejects.toThrow(/^AGENT_STAGING_EXPIRED/)
    expect(stagedFiles()).toEqual([])
  })
})

describe('digest takedown', () => {
  it('refuses a file whose digest is on the root-signed blocked list, from the user and from an agent', async () => {
    const bytes = vsix()
    serve(localTrust({ blockedDigests: [sha256Hex(bytes)] }))
    register()
    writeFileSync(picked, bytes)
    await expect(call('plugins:installFromFile')).rejects.toThrow(/DIGEST_BLOCKED/)
    const staged = await stage(picked)
    expect(staged.result?.report).toMatchObject({ valid: false, errors: [expect.stringMatching(/DIGEST_BLOCKED/)] })
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

  it('a local file row carries the SHA-256 it was installed from and when (DX 9.4 A1)', async () => {
    register()
    const bytes = vsix()
    await install(bytes, null)
    const [row] = call('plugins:listInstalled') as Array<Record<string, unknown>>
    const record = readLocalTrustRecord(localTrustRecordPath(pluginsRoot, 'acme.todo'))
    expect(row.localInstall).toEqual({
      fileDigest: sha256Hex(bytes),
      contentDigest: record.contentDigest,
      installedAt: record.consentedAt,
    })
  })

  it('signature no longer valid: a revoked key at install, or a key the Registry revokes later', async () => {
    register()
    const bytes = vsix()
    const atInstall = await install(bytes, signFile(bytes, revoked))
    expect(atInstall.localSignature).toMatchObject({ state: 'revoked', publisherId: 'acme' })
    expect(readLocalTrustRecord(localTrustRecordPath(pluginsRoot, 'acme.todo')).signer).toBeNull()

    handlers.clear()
    rmSync(join(base, 'userData'), { recursive: true, force: true })
    mkdirSync(pluginsRoot, { recursive: true })
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
