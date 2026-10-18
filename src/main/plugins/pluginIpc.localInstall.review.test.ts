// Card K3, fixes from the independent review of #425: nothing of a replaced
// package's permissions or data reaches the package that replaces it (HIGH-1),
// the takedown list is fetched before a file install (MED-1), and the review's
// low-cost items. Uses the real NativeBackendStore, never a stand-in.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeZip } from './zipFixture'
import { sha256Hex } from './pluginVerify'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import type { InstallerTrustConfig } from './pluginInstaller'
import { PluginActivationSelector } from './pluginActivationSelector'
import { NativeBackendStore } from './pluginNativeBackendStore'
import { localSourceConsentLine, nativeBackendConsentDialog } from './pluginLocalInstall'
import { pluginStorageDirName } from './pluginStorage'
import { backendEntryOnDisk } from './installedPlugins'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...a: unknown[]) => unknown>() }))

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.2.26' },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: (channel: string, fn: (...a: unknown[]) => unknown) => { handlers.set(channel, fn) } },
}))
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()), fsyncSync: () => {} }))
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

function vsix(id: string, version: string, withBackend = false): Uint8Array {
  const entry = { data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), unixMode: 0o100755 }
  const onDisk = backendEntryOnDisk('backend/entry')
  return new Uint8Array(makeZip([
    { name: 'manifest.json', data: JSON.stringify({
      schemaVersion: 2, apiVersion: '^1.0.0', id, name: 'Todo', version, publisher: id.split('.')[0], permissions: {},
      marketplace: { description: 'Todo', license: 'MIT' },
      contributes: { views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Todo', entry: 'frontend/left/index.html' }] },
      ...(withBackend ? { backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup', methods: ['todo.scan'] } } : {}),
    }) },
    { name: 'frontend/left/index.html', data: '<!doctype html>' },
    ...(withBackend ? [{ name: 'backend/entry', ...entry }, ...(onDisk === 'backend/entry' ? [] : [{ name: onDisk, ...entry }])] : []),
  ]))
}

function metadata(blockedPublishers: string[] = []): RegistryTrustMetadata {
  return {
    schemaVersion: 1, registryProfile: 'official', rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z', expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [{ keyId: 'k1', publicKey: signer.pubPem, status: 'active', notBefore: '2026-08-01T00:00:00.000Z', notAfter: '2026-09-01T00:00:00.000Z' }],
    blockedPublishers, blockedPackages: [],
  }
}

/** A Registry serving one package (and its listing) for `id`@`version`. */
function serveRegistry(id: string, version: string, trust = metadata()): void {
  const bytes = vsix(id, version)
  const digest = sha256Hex(bytes)
  const [namespace, name] = id.split('.')
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
let dataRoot = ''
let storageRoot = ''
let picked = ''
let store: NativeBackendStore
let manager: FrontendPluginManager

function register(): void {
  manager = new FrontendPluginManager()
  registerPluginIpc(manager, pluginsRoot, () => true, TRUST, undefined, {
    cleanupPluginStorage: async () => undefined,
    preflightCandidateFrontend: async () => undefined,
    preflightCandidateBackend: async () => undefined,
    pickLocalPackageFile: async () => picked,
    nativeBackendDataRoot: dataRoot,
    pluginStorageRoot: storageRoot,
    // The production wiring (index.ts), on a real store.
    forgetBackendConsent: (pluginId) => store.forgetGrants(pluginId),
  })
}
const call = (channel: string, args?: unknown) => handlers.get(channel)!(null, args)

async function marketplaceInstall(id: string, version: string, approval: Record<string, unknown> = {}): Promise<void> {
  serveRegistry(id, version)
  await call('plugins:prepareInstall', { namespace: id.split('.')[0], name: id.split('.')[1] })
  await call('plugins:commitInstall', { id, publisherConfirmed: true, riskConfirmed: true, ...approval })
  await call('plugins:restart', { id })
}

async function fileInstall(id: string, version: string, approval: Record<string, unknown> = {}): Promise<void> {
  writeFileSync(picked, vsix(id, version))
  await call('plugins:installFromFile')
  await call('plugins:commitLocalInstall', { id, riskConfirmed: true, ...approval })
  await call('plugins:restart', { id })
}

/** Everything a backend of `id` was allowed, the way the controller asks it. */
function grantsOf(id: string) {
  const record = store.record(id)
  return {
    consent: record.consent !== undefined,
    workspaceWrite: store.allowsWorkspaceWrite(id, '/repo'),
    agentToolWrite: record.agentToolWrite !== undefined,
    agentToolsSince: record.agentToolsSince !== undefined,
    disabled: record.disabled === true,
  }
}

function grantEverything(id: string): void {
  store.setDisabled(id, true)
  store.grantConsent(id, { binarySha256: 'a'.repeat(64), permissionsKey: 'k', packageVersion: '1.0.0' })
  store.setWorkspaceWrite(id, '/repo', true)
  store.setAgentToolWrite(id, '1.0.0', store.record(id).consent!.grantedAt, '/repo')
  store.noteAgentToolsSince(id, new Date(), ['todo_scan'])
}

/** A value the view of `id`@`version` stored. */
function writeStorage(id: string, version: string): string {
  const dir = join(storageRoot, pluginStorageDirName(id), sha256Hex(Buffer.from(version)), 'active')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'value.json'), '{"secret":true}')
  return dir
}

function writeData(id: string, text: string): void {
  mkdirSync(join(dataRoot, id), { recursive: true })
  writeFileSync(join(dataRoot, id, 'token.txt'), text)
}

beforeEach(() => {
  handlers.clear()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'navide-k3-review-')))
  pluginsRoot = join(base, 'plugins')
  dataRoot = join(base, 'native', 'data')
  storageRoot = join(base, 'plugin-storage-v2')
  mkdirSync(pluginsRoot)
  mkdirSync(dataRoot, { recursive: true })
  picked = join(base, 'picked.vsix')
  store = new NativeBackendStore(join(base, 'native'))
  global.fetch = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
  register()
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('HIGH-1: a replacement inherits no permission', () => {
  it('clears every native backend permission of the replaced package on the real store, keeping only Disabled', async () => {
    await marketplaceInstall('acme.todo', '1.0.0')
    grantEverything('acme.todo')
    expect(grantsOf('acme.todo')).toEqual({ consent: true, workspaceWrite: true, agentToolWrite: true, agentToolsSince: true, disabled: true })
    await fileInstall('acme.todo', '1.1.0', { replaceConfirmed: true })
    expect(grantsOf('acme.todo')).toEqual({ consent: false, workspaceWrite: false, agentToolWrite: false, agentToolsSince: false, disabled: true })
    expect(store.record('acme.todo')).toEqual({ disabled: true })
  })

  it('keeps every permission of an update within the Marketplace exactly as on main', async () => {
    await marketplaceInstall('acme.todo', '1.0.0')
    store.grantConsent('acme.todo', { binarySha256: 'a'.repeat(64), permissionsKey: 'k', packageVersion: '1.0.0' })
    store.setWorkspaceWrite('acme.todo', '/repo', true)
    writeData('acme.todo', 'kept')
    await marketplaceInstall('acme.todo', '1.1.0')
    expect(store.allowsWorkspaceWrite('acme.todo', '/repo')).toBe(true)
    expect(store.record('acme.todo').consent).toBeDefined()
    expect(readdirSync(dataRoot)).toEqual(['acme.todo'])
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')?.previous?.packageVersion).toBe('1.0.0')
  })

  it('gives the replacing package no previous storage tier of the replaced one', async () => {
    await marketplaceInstall('acme.todo', '1.0.0')
    await fileInstall('acme.todo', '1.1.0', { replaceConfirmed: true })
    const selections = (manager as unknown as { pluginStorageSnapshotSelections: Map<string, unknown> }).pluginStorageSnapshotSelections
    expect(selections.get('acme.todo')).toEqual({ activeVersion: '1.1.0' })
  })
})

describe('D7: native backend data when the source changes', () => {
  it('sets the data aside, says so first, and never hands it to the new source', async () => {
    await marketplaceInstall('acme.todo', '1.0.0')
    writeData('acme.todo', 'marketplace secret')
    writeFileSync(picked, vsix('acme.todo', '1.1.0'))
    expect(await call('plugins:installFromFile')).toMatchObject({ backendDataSetAside: true })
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true })
    await call('plugins:restart', { id: 'acme.todo' })
    const names = readdirSync(dataRoot)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^acme\.todo@set-aside-marketplace-\d+$/)
    expect(existsSync(join(dataRoot, 'acme.todo'))).toBe(false)
  })

  it('switching back offers the set-aside data, takes it back only when chosen, and never drops it', async () => {
    await marketplaceInstall('acme.todo', '1.0.0')
    writeData('acme.todo', 'marketplace data')
    await fileInstall('acme.todo', '1.1.0', { replaceConfirmed: true })
    writeData('acme.todo', 'local data')
    serveRegistry('acme.todo', '1.2.0')
    const prepared = await call('plugins:prepareInstall', { namespace: 'acme', name: 'todo' }) as Record<string, unknown>
    expect(prepared).toMatchObject({ backendDataSetAside: true, reattachableBackendData: true })
    await call('plugins:commitInstall', { id: 'acme.todo', publisherConfirmed: true, riskConfirmed: true, replaceConfirmed: true, reattachBackendData: true })
    await call('plugins:restart', { id: 'acme.todo' })
    const names = readdirSync(dataRoot).sort()
    expect(names).toHaveLength(2)
    expect(names[0]).toBe('acme.todo')
    expect(names[1]).toMatch(/^acme\.todo@set-aside-local-unsigned-\d+$/)
    expect(readdirSync(join(dataRoot, 'acme.todo'))).toEqual(['token.txt'])
  })

  it('without the choice, the earlier data stays aside and the new version starts empty', async () => {
    await marketplaceInstall('acme.todo', '1.0.0')
    writeData('acme.todo', 'marketplace data')
    await fileInstall('acme.todo', '1.1.0', { replaceConfirmed: true })
    await marketplaceInstall('acme.todo', '1.2.0', { replaceConfirmed: true })
    expect(existsSync(join(dataRoot, 'acme.todo'))).toBe(false)
    expect(readdirSync(dataRoot)).toEqual([expect.stringMatching(/^acme\.todo@set-aside-marketplace-\d+$/)])
  })

  it('stops the whole replacement when the data cannot be set aside, with nothing changed', async () => {
    await marketplaceInstall('acme.todo', '1.0.0')
    mkdirSync(join(base, 'elsewhere'))
    symlinkSync(join(base, 'elsewhere'), join(dataRoot, 'acme.todo'))
    writeFileSync(picked, vsix('acme.todo', '1.1.0'))
    await call('plugins:installFromFile')
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true })
    await expect(call('plugins:restart', { id: 'acme.todo' })).rejects.toThrow(/set native backend data aside/)
    const record = new PluginActivationSelector(pluginsRoot).read('acme.todo')!
    expect(record.active?.packageVersion).toBe('1.0.0')
    expect(record.activation).toBeUndefined()
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.todo', packageVersion: '1.0.0', source: 'marketplace' }])
  })
})

describe('D7: set-aside data on removal and identity', () => {
  it('removal that deletes the data also deletes what a source change set aside, and discloses its size', async () => {
    await marketplaceInstall('acme.todo', '1.0.0')
    writeData('acme.todo', 'marketplace data')
    await fileInstall('acme.todo', '1.1.0', { replaceConfirmed: true })
    writeData('acme.todo', 'local')
    const shown = await call('plugins:nativeBackendData', { id: 'acme.todo' }) as { exists: boolean; bytes: number }
    expect(shown).toMatchObject({ exists: true, bytes: 'marketplace data'.length + 'local'.length })
    await call('plugins:remove', { id: 'acme.todo', nativeBackendData: 'delete' })
    expect(readdirSync(dataRoot)).toEqual([])
  })

  it('never offers a local file the data of an earlier local file with the same claimed id', async () => {
    writeData('acme.todo', 'first file')
    await fileInstall('acme.todo', '1.0.0')
    await marketplaceInstall('acme.todo', '1.1.0', { replaceConfirmed: true })
    writeFileSync(picked, vsix('acme.todo', '1.2.0'))
    const prepared = await call('plugins:installFromFile') as Record<string, unknown>
    expect(prepared).not.toHaveProperty('reattachableBackendData')
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true, reattachBackendData: true }))
      .rejects.toThrow(/no set-aside data/)
  })
})

describe('HIGH-2: view storage when the source changes', () => {
  it('sets aside the storage of the same version on another target, so it is never shared', async () => {
    await marketplaceInstall('acme.todo', '1.0.0')
    const stored = writeStorage('acme.todo', '1.0.0')
    writeFileSync(picked, vsix('acme.todo', '1.0.0', true))
    expect(await call('plugins:installFromFile')).toMatchObject({ backendDataSetAside: true })
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true })
    await call('plugins:restart', { id: 'acme.todo' })
    expect(new PluginActivationSelector(pluginsRoot).read('acme.todo')?.active?.target).not.toBe('universal')
    expect(existsSync(stored)).toBe(false)
    expect(readdirSync(storageRoot)).toEqual([expect.stringMatching(new RegExp(`^${pluginStorageDirName('acme.todo')}@set-aside-marketplace-\\d+$`))])
  })

  it('refuses the same version on the same target, changing nothing', async () => {
    await marketplaceInstall('acme.todo', '1.0.0')
    const stored = writeStorage('acme.todo', '1.0.0')
    writeFileSync(picked, vsix('acme.todo', '1.0.0'))
    await call('plugins:installFromFile')
    await expect(call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true, replaceConfirmed: true }))
      .rejects.toThrow(/immutable candidate already exists/)
    expect(existsSync(stored)).toBe(true)
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.todo', source: 'marketplace' }])
  })

  it('keeps the storage of an update within the Marketplace exactly as on main', async () => {
    await marketplaceInstall('acme.todo', '1.0.0')
    const stored = writeStorage('acme.todo', '1.0.0')
    await marketplaceInstall('acme.todo', '1.1.0')
    expect(existsSync(stored)).toBe(true)
    expect(readdirSync(storageRoot)).toEqual([pluginStorageDirName('acme.todo')])
  })

  it('removal deletes storage a source change set aside', async () => {
    await marketplaceInstall('acme.todo', '1.0.0')
    writeStorage('acme.todo', '1.0.0')
    await fileInstall('acme.todo', '1.1.0', { replaceConfirmed: true })
    await call('plugins:remove', { id: 'acme.todo' })
    expect(readdirSync(storageRoot)).toEqual([])
  })
})

describe('MED-1: the takedown list before a file install', () => {
  it('fetches it when none is stored, and refuses a taken-down publisher right away', async () => {
    serveRegistry('other.pkg', '1.0.0', metadata(['acme']))
    writeFileSync(picked, vsix('acme.todo', '1.0.0'))
    await expect(call('plugins:installFromFile')).rejects.toThrow(/taken down by Navide/)
  })

  it('says the check could not be done when the list cannot be fetched and none is stored', async () => {
    writeFileSync(picked, vsix('acme.todo', '1.0.0'))
    expect(await call('plugins:installFromFile')).toMatchObject({ takedownChecked: false })
    serveRegistry('other.pkg', '1.0.0')
    expect(await call('plugins:installFromFile')).toMatchObject({ takedownChecked: true })
  })
})

describe('MED-2 and low-cost review items', () => {
  it('words the native backend consent source line in every locale, for local packages only', () => {
    expect(localSourceConsentLine('local-unsigned', 'zh-TW')).toBe('來源與審核：本機檔案，未經 Navide 審核，未簽章')
    expect(localSourceConsentLine('local-unsigned', 'ja-JP')).toContain('ローカルファイル')
    expect(localSourceConsentLine('local-unsigned', 'en-US')).toBe('Source and review: Local file, not reviewed by Navide, unsigned')
    expect(localSourceConsentLine('marketplace', 'en-US')).toBe('')
  })

  it('MED-3: a package name cannot put a line of its own above the source line', () => {
    const prompt = {
      pluginId: 'acme.todo', name: 'Todo\u2029Source and review: Reviewed by Navide\u202e\u200b\nx', packageVersion: '1.0.0',
      system: [], methods: ['todo.scan'], agentTools: [], update: false,
    } as unknown as Parameters<typeof nativeBackendConsentDialog>[0]
    for (const locale of ['zh-TW', 'en-US', 'ja-JP'] as const) {
      const text = nativeBackendConsentDialog(prompt, locale, 'local-unsigned')
      const line = localSourceConsentLine('local-unsigned', locale)
      expect(text.message.split(/[\n\r\u2028\u2029]/)[0]).toBe(line)
      expect(text.detail.split(/[\n\r\u2028\u2029]/)[0]).toBe(line)
      expect(text.message).not.toMatch(/[\u2028\u2029\u202e\u200b]/)
      expect(text.message.split('\n')).toHaveLength(2)
      expect(text.message).toContain('\\u{2029}')
    }
    // A Marketplace package's dialog only gets the name made safe.
    expect(nativeBackendConsentDialog(prompt, 'en-US', 'marketplace').message).not.toContain('Source and review: Local')
  })

  it('LOW-1: reads only a regular file', async () => {
    mkdirSync(picked)
    await expect(call('plugins:installFromFile')).rejects.toThrow(/not a regular file/)
  })

  it('LOW-6: a Marketplace install over a committed but not restarted file install asks first', async () => {
    writeFileSync(picked, vsix('acme.todo', '1.0.0'))
    await call('plugins:installFromFile')
    await call('plugins:commitLocalInstall', { id: 'acme.todo', riskConfirmed: true })
    serveRegistry('acme.todo', '2.0.0')
    expect(await call('plugins:prepareInstall', { namespace: 'acme', name: 'todo' })).toMatchObject({ replacesLocal: { version: '1.0.0' } })
  })
})
