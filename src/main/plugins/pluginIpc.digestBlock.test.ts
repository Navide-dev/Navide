// Decision d5 (W6): a local install whose `.vsix` digest Navide blocks after
// it was installed. The record keeps the file's digest, and every revalidation
// (startup and each trust refresh) grades the block by its reason.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeZip } from './zipFixture'
import { sha256Hex } from './pluginVerify'
import { canonicalTrustJson } from './pluginRegistryTrust'
import type { InstallerTrustConfig } from './pluginInstaller'
import { publisherKeyId, type LocalInstallTrustMetadata } from './pluginLocalInstallTrust'
import { localTrustRecordPath } from './pluginLocalInstall'
import { readLocalTrustRecord } from './pluginLocalTrust'
import type { DigestBlockChoice, DigestBlockPrompt } from './pluginDigestBlock'

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

import { registerPluginIpc, type PluginTrustRefreshController } from './pluginIpc'
import { FrontendPluginManager } from './frontendPluginManager'
import { PluginDisabledStore } from './pluginDisabledStore'

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey }
}
const signCanonical = (value: unknown, key: Parameters<typeof edSign>[2]): string =>
  edSign(null, Buffer.from(canonicalTrustJson(value), 'utf8'), key).toString('base64')

const registryRoot = keypair()
const vetted = keypair()
const TRUST_CONFIG: InstallerTrustConfig = { pinnedRegistryRootKey: registryRoot.pubPem, now: new Date('2026-10-20T12:00:00.000Z') }

function manifestFor(id: string, version = '1.0.0'): Record<string, unknown> {
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

let base = ''
let pluginsRoot = ''
let picked = ''
const prompt = vi.fn<(ask: DigestBlockPrompt) => Promise<DigestBlockChoice>>()

function register(): PluginTrustRefreshController {
  const manager = new FrontendPluginManager()
  manager.setDisabledPluginResolver((id) => new PluginDisabledStore(pluginsRoot).has(id))
  return registerPluginIpc(manager, pluginsRoot, () => true, TRUST_CONFIG, undefined, {
    cleanupPluginStorage: async () => undefined,
    preflightCandidateFrontend: async () => undefined,
    preflightCandidateBackend: async () => undefined,
    pickLocalPackageFile: async () => picked,
    pickDeveloperFolder: async () => null,
    promptDigestBlock: prompt,
  })
}

const call = (channel: string, args?: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} is not registered`)
  return handler(null, args)
}
const row = () => (call('plugins:listInstalled') as Array<Record<string, unknown>>).find((item) => item.id === 'acme.todo')

const bytes = vsix()
const digest = sha256Hex(bytes)

async function install(): Promise<void> {
  writeFileSync(picked, bytes)
  const prepared = await call('plugins:installFromFile') as { id: string }
  await call('plugins:commitLocalInstall', { id: prepared.id, riskConfirmed: true })
  await call('plugins:restart', { id: prepared.id })
}
const blockAs = (entry: LocalInstallTrustMetadata['blockedDigests'][number]): void =>
  serve(localTrust({ generatedAt: '2026-10-20T11:00:00Z', blockedDigests: [entry] }))

beforeEach(() => {
  handlers.clear()
  packaged.value = false
  prompt.mockReset()
  prompt.mockResolvedValue('keep')
  base = realpathSync(mkdtempSync(join(tmpdir(), 'navide-digest-block-')))
  pluginsRoot = join(base, 'userData', 'plugins')
  mkdirSync(pluginsRoot, { recursive: true })
  picked = join(base, 'todo-scout.vsix')
  serve(localTrust())
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('decision d5: an installed local file Navide blocks later', () => {
  it('records the digest of the .vsix it was installed from', async () => {
    register()
    await install()
    expect(readLocalTrustRecord(localTrustRecordPath(pluginsRoot, 'acme.todo')).artifactDigest).toBe(digest)
    expect(row()).not.toHaveProperty('digestBlock')
    expect(row()).not.toHaveProperty('disabled')
  })

  it('admin: warns once, keeps running and keeps the label', async () => {
    const controller = register()
    await install()
    blockAs({ digest, reason: 'admin' })
    expect(await controller.revalidateLocalInstalls()).toEqual({ quarantined: [] })
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    expect(prompt).toHaveBeenCalledWith({ pluginId: 'acme.todo', version: '1.0.0', reason: 'admin', action: 'warn' })
    expect(row()).toMatchObject({ digestBlock: { reason: 'admin' }, disabled: false })
    await controller.revalidateLocalInstalls()
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('qualification-revoked: the user disables it, and may enable it again', async () => {
    const controller = register()
    await install()
    prompt.mockResolvedValue('disable')
    blockAs({ digest, reason: 'qualification-revoked' })
    await controller.revalidateLocalInstalls()
    await vi.waitFor(() => expect(row()).toMatchObject({ disabled: true, digestBlock: { reason: 'qualification-revoked' } }))
    // Once the disable has finished draining, the switch turns it back on.
    await vi.waitFor(async () => {
      await expect(call('plugins:setDisabled', { id: 'acme.todo', disabled: false })).resolves.toMatchObject({ disabled: false })
    })
    expect(row()).toMatchObject({ disabled: false })
  })

  it('a bare digest from an older Registry warns as having no reason, and the user may remove it', async () => {
    const controller = register()
    await install()
    prompt.mockResolvedValue('remove')
    blockAs(digest)
    await controller.revalidateLocalInstalls()
    await vi.waitFor(() => expect(row()).toBeUndefined())
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ reason: null, action: 'warn' }))
  })

  it('security: quarantined at once, told why, and never enabled again', async () => {
    const controller = register()
    await install()
    blockAs({ digest, reason: 'security' })
    expect(await controller.revalidateLocalInstalls()).toEqual({ quarantined: ['acme.todo'] })
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ reason: 'security', action: 'disable' })))
    expect(row()).toBeUndefined()
    await expect(call('plugins:setDisabled', { id: 'acme.todo', disabled: false })).rejects.toThrow()
  })

  it('security on a copy the load already quarantined: still told, and removable', async () => {
    let controller = register()
    await install()
    blockAs({ digest, reason: 'security' })
    await controller.revalidateLocalInstalls()
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    // A restart: the load quarantines it; the notice was already shown.
    handlers.clear()
    controller = register()
    expect(row()).toBeUndefined()
    await controller.revalidateLocalInstalls()
    expect(prompt).toHaveBeenCalledTimes(1)
    await call('plugins:remove', { id: 'acme.todo' })
  })

  it('developer-withdrawn: only labelled, still running', async () => {
    const controller = register()
    await install()
    blockAs({ digest, reason: 'developer-withdrawn' })
    expect(await controller.revalidateLocalInstalls()).toEqual({ quarantined: [] })
    expect(prompt).not.toHaveBeenCalled()
    expect(row()).toMatchObject({ digestBlock: { reason: 'developer-withdrawn' }, disabled: false })
  })
})
