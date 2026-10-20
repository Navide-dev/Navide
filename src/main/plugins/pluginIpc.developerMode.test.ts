// Card K4 (DX report A2 + D6): the Developer Mode switch, loading a Navide
// plugin from a developer folder, and the self-hosted Registry overrides a
// packaged build honors only while the switch is on. Kept apart from
// pluginIpc.test.ts so the Marketplace suite there stays as it is on main.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeZip } from './zipFixture'
import { sha256Hex } from './pluginVerify'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import type { InstallerTrustConfig } from './pluginInstaller'
import { backendEntryOnDisk, type PluginActivationCatalogEntry } from './installedPlugins'
import { PluginCapabilityGrantStore } from './pluginCapabilityGrantStore'
import { developerFolderBackendDigest, PluginDeveloperModeStore } from './pluginDeveloperModeStore'
import { PluginDeveloperFolderMetaStore } from './pluginDeveloperFolderMeta'

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

import { registerPluginIpc, resolveConfiguredMarketplace, setMarketplaceOverridesAllowed, OFFICIAL_MARKETPLACE_URL } from './pluginIpc'
import { FrontendPluginManager } from './frontendPluginManager'

function keypair(): { pubPem: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey }
}
const signCanonical = (value: unknown, key: Parameters<typeof edSign>[2]): string =>
  edSign(null, Buffer.from(canonicalTrustJson(value), 'utf8'), key).toString('base64')

const registryRoot = keypair()
const registrySigner = keypair()
const TRUST_CONFIG: InstallerTrustConfig = { pinnedRegistryRootKey: registryRoot.pubPem, now: new Date('2026-08-16T12:00:00.000Z') }
const BACKEND_ENTRY = backendEntryOnDisk('backend/entry')

function manifest(id: string, permissions: Record<string, unknown> = {}, withBackend = true): Record<string, unknown> {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id,
    name: 'Dev Todo',
    version: '0.1.0',
    publisher: id.split('.')[0],
    permissions,
    marketplace: { description: 'Developer folder', license: 'MIT' },
    contributes: { views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Todo', entry: 'frontend/left/index.html' }] },
    ...(withBackend ? { backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup', methods: ['todo.scan'] } } : {}),
  }
}

function writeFolder(dir: string, data: Record<string, unknown> = manifest('acme.devtodo')): void {
  mkdirSync(join(dir, 'frontend', 'left'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(data))
  writeFileSync(join(dir, 'frontend', 'left', 'index.html'), '<!doctype html>')
  if (data.backend) {
    mkdirSync(join(dir, 'backend'), { recursive: true })
    writeFileSync(join(dir, BACKEND_ENTRY), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    chmodSync(join(dir, BACKEND_ENTRY), 0o755)
  }
}

let base = ''
let pluginsRoot = ''
let folder = ''
let activations: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }>
let pickFolder: ReturnType<typeof vi.fn>
let dataRoot = ''
/** G1: folder watches the Host opened, fired by hand instead of the file system. */
let watches: Array<{ dir: string; onChange: () => void; onError?: (error: Error) => void; closed: boolean }>
let folderEvents: Array<Record<string, unknown>>
const openWatches = () => watches.filter((entry) => !entry.closed)
const fireChange = () => { for (const entry of openWatches()) entry.onChange() }

function register(authorize: () => boolean = () => true, manager = new FrontendPluginManager()) {
  const controller = registerPluginIpc(manager, pluginsRoot, authorize, TRUST_CONFIG, undefined, {
    cleanupPluginStorage: async () => undefined,
    preflightCandidateFrontend: async () => undefined,
    preflightCandidateBackend: async () => undefined,
    onActivationChange: (change) => activations.push(change),
    pickDeveloperFolder: pickFolder,
    nativeBackendDataRoot: dataRoot,
    watchDeveloperFolder: (dir: string, onChange: () => void, onError?: (error: Error) => void) => {
      const entry = { dir, onChange, onError, closed: false }
      watches.push(entry)
      return { close: () => { entry.closed = true } }
    },
    onDeveloperFolderEvent: (event: Record<string, unknown>) => folderEvents.push(event),
  })
  return { manager, controller }
}

const call = (channel: string, args?: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} is not registered`)
  return handler(null, args)
}

/** A Marketplace install of `id` 0.1.0 from a self-hosted test Registry. */
async function marketplaceInstall(id: string, version = '0.1.0'): Promise<void> {
  const bytes = new Uint8Array(makeZip([
    { name: 'manifest.json', data: JSON.stringify({ ...manifest(id, {}, false), version }) },
    { name: 'frontend/left/index.html', data: '<!doctype html>' },
  ]))
  const digest = sha256Hex(bytes)
  const [namespace, name] = id.split('.')
  const envelope: RegistryPackageEnvelope = {
    schemaVersion: 1, artifactDigest: digest, packageId: id, version, target: 'universal',
    publisherId: namespace, keyId: 'k1', signedAt: '2026-08-16T11:00:00.000Z',
  }
  const metadata: RegistryTrustMetadata = {
    schemaVersion: 1, registryProfile: 'self-hosted-dev', rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z', expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [{ keyId: 'k1', publicKey: registrySigner.pubPem, status: 'active', notBefore: '2026-08-01T00:00:00.000Z', notAfter: '2026-09-01T00:00:00.000Z' }],
    blockedPublishers: [], blockedPackages: [],
  }
  const detail = {
    latest_version: version, trust_metadata: metadata, trust_metadata_signature: signCanonical(metadata, registryRoot.privateKey),
    versions: [{ version, package_digest: digest, target: 'universal', registry_envelope: envelope,
      registry_signature: signCanonical(envelope, registrySigner.privateKey), trust_tier: 'signed-verified', yanked: false }],
  }
  global.fetch = vi.fn(async (url: unknown) => String(url).endsWith('/download')
    ? { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), headers: { get: () => digest } }
    : { ok: true, status: 200, json: async () => detail }) as unknown as typeof fetch
  await call('plugins:prepareInstall', { namespace, name })
  await call('plugins:commitInstall', { id, publisherConfirmed: true, riskConfirmed: true })
  await call('plugins:restart', { id })
}

async function loadFolder(): Promise<void> {
  await call('plugins:loadFromFolder')
  await call('plugins:commitFolderLoad', { id: 'acme.devtodo', riskConfirmed: true })
}

beforeEach(() => {
  handlers.clear()
  packaged.value = false
  setMarketplaceOverridesAllowed(() => true)
  base = realpathSync(mkdtempSync(join(tmpdir(), 'navide-devmode-')))
  pluginsRoot = join(base, 'plugins')
  folder = join(base, 'dev-todo')
  mkdirSync(pluginsRoot)
  writeFolder(folder)
  pickFolder = vi.fn(async () => folder)
  dataRoot = join(base, 'native-data')
  mkdirSync(dataRoot)
  activations = []
  watches = []
  folderEvents = []
  delete process.env['AGENT_TEAM_PLUGIN_DEV']
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  delete process.env['AGENT_TEAM_MARKETPLACE_URL']
  delete process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE']
})

describe('the Developer Mode switch', () => {
  it('is off by default, stored by the main process, and every change is audited', async () => {
    const { manager } = register()
    const audit = vi.spyOn(manager, 'recordDeveloperModeChange')
    expect(call('plugins:developerMode')).toEqual({ enabled: false, folders: [] })
    expect(await call('plugins:setDeveloperMode', { enabled: true })).toMatchObject({ enabled: true })
    expect(new PluginDeveloperModeStore(pluginsRoot).isEnabled()).toBe(true)
    await call('plugins:setDeveloperMode', { enabled: true })
    await call('plugins:setDeveloperMode', { enabled: false })
    expect(audit.mock.calls).toEqual([[true, '0.2.26'], [false, '0.2.26']])
    expect(readFileSync(join(pluginsRoot, '.navide-plugin-developer-mode.json'), 'utf8')).toContain('"enabled":false')
  })

  it('cannot be changed by a plugin frame or any sender the Host does not trust', async () => {
    register(() => false)
    await expect(call('plugins:setDeveloperMode', { enabled: true })).rejects.toThrow(/unauthorized/)
    await expect(call('plugins:loadFromFolder')).rejects.toThrow(/unauthorized/)
    expect(new PluginDeveloperModeStore(pluginsRoot).isEnabled()).toBe(false)
    expect(pickFolder).not.toHaveBeenCalled()
  })

  it('takes only a boolean', async () => {
    register()
    for (const enabled of ['true', 1, null, undefined]) {
      await expect(call('plugins:setDeveloperMode', { enabled })).rejects.toThrow(/invalid Developer Mode switch value/)
    }
  })
})

describe('loading a developer folder', () => {
  it('needs Developer Mode on in a packaged build, and AGENT_TEAM_PLUGIN_DEV does not count there', async () => {
    packaged.value = true
    process.env['AGENT_TEAM_PLUGIN_DEV'] = '1'
    register()
    await expect(call('plugins:loadFromFolder')).rejects.toThrow(/turn on Developer Mode/)
    expect(pickFolder).not.toHaveBeenCalled()
  })

  it('loads a view + native backend folder: the view is granted, the backend is handed to the sandboxed admission', async () => {
    packaged.value = true
    const { manager } = register()
    await call('plugins:setDeveloperMode', { enabled: true })
    const prepared = await call('plugins:loadFromFolder') as Record<string, unknown>
    expect(prepared).toMatchObject({
      id: 'acme.devtodo', source: 'developer-unpacked', folder, requiresRiskConfirmation: true, containsBackendExecutable: true,
    })
    await expect(call('plugins:commitFolderLoad', { id: 'acme.devtodo' })).rejects.toThrow(/consent is required/)
    expect(manager.listInstalledPackages()).toEqual([])
    await call('plugins:commitFolderLoad', { id: 'acme.devtodo', riskConfirmed: true })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.devtodo', source: 'developer-unpacked' }])
    expect(new PluginCapabilityGrantStore(pluginsRoot).get('acme.devtodo', '0.1.0')).toMatchObject({ storage: true })
    const activation = activations.at(-1)?.activation
    expect(activation).toMatchObject({ pluginId: 'acme.devtodo', provenance: 'developer-local-unpacked', packageDir: folder })
    expect(activation?.backend).toBeDefined()
    // The backend consent binds to the folder and its permission set.
    const consents = new PluginDeveloperModeStore(pluginsRoot).folders()
    const digest = developerFolderBackendDigest(consents, { pluginId: 'acme.devtodo', packageDir: folder })
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    writeFileSync(join(folder, 'frontend', 'left', 'index.html'), '<p>edited</p>')
    expect(developerFolderBackendDigest(consents, { pluginId: 'acme.devtodo', packageDir: folder })).toBe(digest)
    expect(developerFolderBackendDigest(consents, { pluginId: 'acme.devtodo', packageDir: join(base, 'elsewhere') })).toBeNull()
  })

  it('reloads after a file edit without asking, and asks again once permissions or the backend change', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    writeFileSync(join(folder, 'frontend', 'left', 'index.html'), '<p>edited</p>')
    expect(await call('plugins:reloadDeveloperPlugin', { id: 'acme.devtodo' })).toEqual({ reloaded: true, requiresConsent: false })

    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest('acme.devtodo', { system: ['fs'] })))
    const reload = await call('plugins:reloadDeveloperPlugin', { id: 'acme.devtodo' }) as Record<string, unknown>
    expect(reload).toMatchObject({ reloaded: false, requiresConsent: true, prepared: { id: 'acme.devtodo' } })
    expect(call('plugins:listInstalled')).toEqual([])
    expect(call('plugins:developerMode')).toMatchObject({ folders: [{ pluginId: 'acme.devtodo', loaded: false }] })
    await call('plugins:commitFolderLoad', { id: 'acme.devtodo', riskConfirmed: true })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.devtodo' }])

    writeFileSync(join(folder, 'manifest.json'), JSON.stringify({
      ...manifest('acme.devtodo', { system: ['fs'] }),
      backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup', methods: ['todo.scan', 'todo.write'] },
    }))
    expect(await call('plugins:reloadDeveloperPlugin', { id: 'acme.devtodo' })).toMatchObject({ requiresConsent: true })
  })

  it('loads consented folders on the next start, but not one whose permissions changed meanwhile', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    handlers.clear()
    const restarted = register()
    await restarted.controller.loadDeveloperFolders()
    expect(restarted.manager.listInstalledPackages()).toMatchObject([{ id: 'acme.devtodo' }])

    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest('acme.devtodo', { shell: 'allowlist' })))
    handlers.clear()
    const again = register()
    await again.controller.loadDeveloperFolders()
    expect(again.manager.listInstalledPackages()).toEqual([])
  })

  it('turning Developer Mode off unloads every developer folder', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    await call('plugins:setDeveloperMode', { enabled: false })
    expect(call('plugins:listInstalled')).toEqual([])
    expect(new PluginCapabilityGrantStore(pluginsRoot).get('acme.devtodo', '0.1.0')).toBeNull()
    expect(activations.at(-1)).toEqual({ pluginId: 'acme.devtodo' })
  })

  it('G3: records who loaded the folder and every load beside the store, whose format stays as on main', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    expect(call('plugins:developerMode')).toMatchObject({
      folders: [{ pluginId: 'acme.devtodo', loadedBy: { kind: 'user' }, autoReload: true, lastLoad: { trigger: 'user-load' } }],
    })
    await call('plugins:reloadDeveloperPlugin', { id: 'acme.devtodo' })
    expect(call('plugins:developerMode')).toMatchObject({
      folders: [{ loadedBy: { kind: 'user' }, lastLoad: { trigger: 'manual-reload' } }],
    })
    await call('plugins:setDeveloperMode', { enabled: false })
    await call('plugins:setDeveloperMode', { enabled: true })
    expect(call('plugins:developerMode')).toMatchObject({ folders: [{ lastLoad: { trigger: 'developer-mode-on' } }] })
    handlers.clear()
    const restarted = register()
    await restarted.controller.loadDeveloperFolders()
    expect(call('plugins:developerMode')).toMatchObject({ folders: [{ loadedBy: { kind: 'user' }, lastLoad: { trigger: 'startup' } }] })

    const store = JSON.parse(readFileSync(join(pluginsRoot, '.navide-plugin-developer-mode.json'), 'utf8')) as { folders: Array<Record<string, unknown>> }
    expect(Object.keys(store.folders[0]!).sort()).toEqual(['consentedAt', 'path', 'permissionsDigest', 'pluginId'])

    await call('plugins:removeDeveloperFolder', { id: 'acme.devtodo' })
    const meta = JSON.parse(readFileSync(join(pluginsRoot, '.navide-plugin-developer-folders-meta.json'), 'utf8')) as { folders: Record<string, unknown> }
    expect(meta.folders).toEqual({})
  })

  it('G3: a folder consented to before the record existed reads as loaded by an unknown party and still loads', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    rmSync(join(pluginsRoot, '.navide-plugin-developer-folders-meta.json'))
    handlers.clear()
    const restarted = register()
    await restarted.controller.loadDeveloperFolders()
    expect(restarted.manager.listInstalledPackages()).toMatchObject([{ id: 'acme.devtodo' }])
    expect(call('plugins:developerMode')).toMatchObject({ folders: [{ loadedBy: { kind: 'unknown' }, lastLoad: { trigger: 'startup' } }] })
  })

  it('review MED-2 on #536: a record that cannot be written never blocks loading a folder', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    mkdirSync(join(pluginsRoot, '.navide-plugin-developer-folders-meta.json'))
    await loadFolder()
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.devtodo' }])
    expect(await call('plugins:reloadDeveloperPlugin', { id: 'acme.devtodo' })).toEqual({ reloaded: true, requiresConsent: false })
    expect(call('plugins:developerMode')).toMatchObject({ folders: [{ loaded: true, loadedBy: { kind: 'unknown' } }] })
  })

  it('turning Developer Mode off also drops a folder chosen but not yet consented to (G4)', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await call('plugins:loadFromFolder')
    await call('plugins:setDeveloperMode', { enabled: false })
    await call('plugins:setDeveloperMode', { enabled: true })
    await expect(call('plugins:commitFolderLoad', { id: 'acme.devtodo', riskConfirmed: true }))
      .rejects.toThrow(/no prepared developer folder/)
    expect(call('plugins:listInstalled')).toEqual([])
    expect(new PluginDeveloperModeStore(pluginsRoot).folders()).toEqual([])
  })

  it('G4: the chosen folder is dropped even when unloading a consented folder throws', async () => {
    const { manager } = register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    const second = join(base, 'dev-other')
    writeFolder(second, manifest('acme.other'))
    pickFolder.mockResolvedValueOnce(second)
    await call('plugins:loadFromFolder')
    vi.spyOn(manager, 'removeInstalledPlugin').mockImplementationOnce(() => { throw new Error('unload failed') })
    await expect(call('plugins:setDeveloperMode', { enabled: false })).rejects.toThrow(/unload failed/)
    await call('plugins:setDeveloperMode', { enabled: true })
    await expect(call('plugins:commitFolderLoad', { id: 'acme.other', riskConfirmed: true }))
      .rejects.toThrow(/no prepared developer folder/)
  })

  it('refuses the navide. namespace and a folder that changed while the dialog was open', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    writeFolder(folder, manifest('navide.spoof'))
    await expect(call('plugins:loadFromFolder')).rejects.toThrow(/reserved plugin id/)
    writeFolder(folder, manifest('acme.devtodo'))
    await call('plugins:loadFromFolder')
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest('acme.devtodo', { system: ['fs'] })))
    await expect(call('plugins:commitFolderLoad', { id: 'acme.devtodo', riskConfirmed: true })).rejects.toThrow(/changed; choose the folder again/)
  })

  it('an install of an id a developer folder holds is refused until the folder is removed', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    const picked = join(base, 'picked.vsix')
    writeFileSync(picked, makeZip([
      { name: 'manifest.json', data: JSON.stringify(manifest('acme.devtodo', {}, false)) },
      { name: 'frontend/left/index.html', data: '<!doctype html>' },
    ]))
    handlers.clear()
    const manager = new FrontendPluginManager()
    manager.loadExplicitDeveloperPlugin(folder, true, { allowBackend: true })
    registerPluginIpc(manager, pluginsRoot, () => true, TRUST_CONFIG, undefined, {
      cleanupPluginStorage: async () => undefined,
      pickLocalPackageFile: async () => picked,
    })
    await expect(call('plugins:installFromFile')).rejects.toThrow(/developer folder; remove that folder/)
  })

  it('takes no data an earlier package of the id kept, keeps its own across reloads, and leaves its own as local', async () => {
    mkdirSync(join(dataRoot, 'acme.devtodo'))
    writeFileSync(join(dataRoot, 'acme.devtodo', 'secret'), 'M-secret')
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    expect(readdirSync(dataRoot)).toEqual([expect.stringMatching(/^acme\.devtodo@set-aside-marketplace-\d+$/)])
    mkdirSync(join(dataRoot, 'acme.devtodo'))
    writeFileSync(join(dataRoot, 'acme.devtodo', 'own'), 'dev')
    await call('plugins:reloadDeveloperPlugin', { id: 'acme.devtodo' })
    expect(readFileSync(join(dataRoot, 'acme.devtodo', 'own'), 'utf8')).toBe('dev')
    await call('plugins:removeDeveloperFolder', { id: 'acme.devtodo' })
    expect(JSON.parse(readFileSync(join(dataRoot, 'acme.devtodo@kept-source.json'), 'utf8'))).toEqual({ schemaVersion: 1, source: 'local-unsigned' })
  })

  it.each(['another developer folder', 'a file install', 'a Marketplace install', 'removal through plugins:remove'])(
    'LOW-11: data a developer folder left is set aside before %s takes the id',
    async (next) => {
      register()
      await call('plugins:setDeveloperMode', { enabled: true })
      await loadFolder()
      mkdirSync(join(dataRoot, 'acme.devtodo'))
      writeFileSync(join(dataRoot, 'acme.devtodo', 'own'), 'D-secret')
      if (next === 'removal through plugins:remove') {
        // The agent's plugins_request_remove goes through this handler too.
        await call('plugins:remove', { id: 'acme.devtodo' })
        expect(JSON.parse(readFileSync(join(dataRoot, 'acme.devtodo@kept-source.json'), 'utf8')))
          .toEqual({ schemaVersion: 1, source: 'local-unsigned' })
        return
      }
      await call('plugins:removeDeveloperFolder', { id: 'acme.devtodo' })
      const setAside = /^acme\.devtodo@set-aside-local-unsigned-\d+$/
      if (next === 'another developer folder') {
        const other = join(base, 'other-dev')
        writeFolder(other)
        pickFolder.mockResolvedValue(other)
        await loadFolder()
      } else if (next === 'a file install') {
        const picked = join(base, 'next.vsix')
        writeFileSync(picked, makeZip([
          { name: 'manifest.json', data: JSON.stringify(manifest('acme.devtodo', {}, false)) },
          { name: 'frontend/left/index.html', data: '<!doctype html>' },
        ]))
        handlers.clear()
        registerPluginIpc(new FrontendPluginManager(), pluginsRoot, () => true, TRUST_CONFIG, undefined, {
          cleanupPluginStorage: async () => undefined,
          preflightCandidateFrontend: async () => undefined,
          pickLocalPackageFile: async () => picked,
          nativeBackendDataRoot: dataRoot,
        })
        await call('plugins:installFromFile')
        await call('plugins:commitLocalInstall', { id: 'acme.devtodo', riskConfirmed: true })
        await call('plugins:restart', { id: 'acme.devtodo' })
      } else {
        await marketplaceInstall('acme.devtodo')
      }
      expect(readdirSync(dataRoot).filter((name) => setAside.test(name))).toHaveLength(1)
      expect(existsSync(join(dataRoot, 'acme.devtodo', 'own'))).toBe(false)
    },
  )

  it('refuses a second folder claiming an id another consented folder holds', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    const other = join(base, 'impostor')
    writeFolder(other)
    pickFolder.mockResolvedValue(other)
    await expect(call('plugins:loadFromFolder')).rejects.toThrow(/another developer folder/)
    expect(new PluginDeveloperModeStore(pluginsRoot).folder('acme.devtodo')?.path).toBe(folder)
  })

  it('an install prepared before a folder took the id cannot commit or restart afterwards', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    const picked = join(base, 'early.vsix')
    writeFileSync(picked, makeZip([
      { name: 'manifest.json', data: JSON.stringify(manifest('acme.devtodo', {}, false)) },
      { name: 'frontend/left/index.html', data: '<!doctype html>' },
    ]))
    handlers.clear()
    const manager = new FrontendPluginManager()
    registerPluginIpc(manager, pluginsRoot, () => true, TRUST_CONFIG, undefined, {
      cleanupPluginStorage: async () => undefined,
      preflightCandidateFrontend: async () => undefined,
      pickLocalPackageFile: async () => picked,
      pickDeveloperFolder: pickFolder,
      nativeBackendDataRoot: dataRoot,
    })
    await call('plugins:installFromFile')
    await loadFolder()
    await expect(call('plugins:commitLocalInstall', { id: 'acme.devtodo', riskConfirmed: true })).rejects.toThrow(/no prepared local install|developer folder/)
    await expect(call('plugins:restart', { id: 'acme.devtodo' })).rejects.toThrow(/developer folder/)
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.devtodo', source: 'developer-unpacked' }])
  })

  it('an install of an id a consented folder holds is refused while Developer Mode is off', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    await call('plugins:setDeveloperMode', { enabled: false })
    const picked = join(base, 'picked2.vsix')
    writeFileSync(picked, makeZip([
      { name: 'manifest.json', data: JSON.stringify(manifest('acme.devtodo', {}, false)) },
      { name: 'frontend/left/index.html', data: '<!doctype html>' },
    ]))
    handlers.clear()
    registerPluginIpc(new FrontendPluginManager(), pluginsRoot, () => true, TRUST_CONFIG, undefined, {
      cleanupPluginStorage: async () => undefined,
      pickLocalPackageFile: async () => picked,
    })
    await expect(call('plugins:installFromFile')).rejects.toThrow(/developer folder; remove that folder/)
  })

  it('removing a developer folder forgets its consent and never touches the folder', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    await call('plugins:removeDeveloperFolder', { id: 'acme.devtodo' })
    expect(call('plugins:developerMode')).toMatchObject({ folders: [] })
    expect(readFileSync(join(folder, 'manifest.json'), 'utf8')).toContain('acme.devtodo')
  })
})

describe('G1: automatic reload on file change', () => {
  type FolderState = { folders: Array<Record<string, unknown> & { lastLoad?: { trigger: string } }> }
  const folderState = () => (call('plugins:developerMode') as FolderState).folders[0]!

  it('watches a loaded folder and reloads it after a file edit, with no consent asked', async () => {
    const { manager } = register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    expect(openWatches().map((entry) => entry.dir)).toEqual([folder])
    writeFileSync(join(folder, 'frontend', 'left', 'index.html'), '<p>edited</p>')
    const load = vi.spyOn(manager, 'loadExplicitDeveloperPlugin')
    fireChange()
    await vi.waitFor(() => expect(folderEvents).toContainEqual({ pluginId: 'acme.devtodo', kind: 'reloaded' }))
    expect(load).toHaveBeenCalledTimes(1)
    expect(folderState()).toMatchObject({ loaded: true, lastLoad: { trigger: 'auto-reload' } })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.devtodo' }])
  })

  it('never applies changed permissions: it unloads and stops at "needs consent", however often files change', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest('acme.devtodo', { system: ['fs'] })))
    fireChange()
    await vi.waitFor(() => expect(folderEvents).toContainEqual({ pluginId: 'acme.devtodo', kind: 'needs-consent' }))
    expect(call('plugins:listInstalled')).toEqual([])
    expect(folderState()).toMatchObject({ loaded: false })
    fireChange()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(call('plugins:listInstalled')).toEqual([])
    // Only the user's consent in the main window loads it again.
    await call('plugins:commitFolderLoad', { id: 'acme.devtodo', riskConfirmed: true })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.devtodo' }])
  })

  it('keeps the running version when the folder cannot be read mid-edit, and loads once it can', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    writeFileSync(join(folder, 'manifest.json'), '{"schemaVersion": 2, "id": ')
    fireChange()
    await vi.waitFor(() => expect(folderEvents.at(-1)).toMatchObject({ pluginId: 'acme.devtodo', kind: 'reload-failed' }))
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.devtodo' }])
    expect(folderState().reloadError).toEqual(expect.any(String))
    writeFolder(folder)
    fireChange()
    await vi.waitFor(() => expect(folderEvents.at(-1)).toEqual({ pluginId: 'acme.devtodo', kind: 'reloaded' }))
    expect(folderState().reloadError).toBeUndefined()
  })

  it('runs one reload at a time and one more for changes made during it', async () => {
    const { manager } = register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    const load = vi.spyOn(manager, 'loadExplicitDeveloperPlugin')
    const entry = openWatches()[0]!
    entry.onChange()
    entry.onChange()
    entry.onChange()
    await vi.waitFor(() => expect(folderEvents.filter((event) => event.kind === 'reloaded')).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('is on by default, can be turned off per folder, and stops with the folder or Developer Mode', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    expect(folderState()).toMatchObject({ autoReload: true })
    expect(await call('plugins:setDeveloperFolderAutoReload', { id: 'acme.devtodo', enabled: false })).toMatchObject({
      folders: [{ autoReload: false }],
    })
    expect(openWatches()).toEqual([])
    await call('plugins:reloadDeveloperPlugin', { id: 'acme.devtodo' })
    expect(openWatches()).toEqual([])

    await call('plugins:setDeveloperFolderAutoReload', { id: 'acme.devtodo', enabled: true })
    expect(openWatches()).toHaveLength(1)
    await call('plugins:setDeveloperMode', { enabled: false })
    expect(openWatches()).toEqual([])
    await call('plugins:setDeveloperMode', { enabled: true })
    expect(openWatches()).toHaveLength(1)
    await call('plugins:removeDeveloperFolder', { id: 'acme.devtodo' })
    expect(openWatches()).toEqual([])
  })

  it('review MED-1 on #543: Developer Mode turned off during an automatic reload leaves the folder unloaded', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    fireChange()
    // The switch goes off while the reload is unloading the old version.
    await call('plugins:setDeveloperMode', { enabled: false })
    await vi.waitFor(() => expect(folderEvents.at(-1)).toMatchObject({ pluginId: 'acme.devtodo', kind: 'reload-failed', running: false }))
    expect(call('plugins:listInstalled')).toEqual([])
    expect(new PluginCapabilityGrantStore(pluginsRoot).get('acme.devtodo', '0.1.0')).toBeNull()
    expect(openWatches()).toEqual([])
    expect(activations.at(-1)).toEqual({ pluginId: 'acme.devtodo' })
  })

  it('review MED-2 on #543: a manual Reload waits for an automatic one; unload and load never interleave', async () => {
    const { manager } = register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    const order: string[] = []
    const remove = manager.removeInstalledPlugin.bind(manager)
    vi.spyOn(manager, 'removeInstalledPlugin').mockImplementation((id: string) => { order.push('unload'); return remove(id) })
    const load = manager.loadExplicitDeveloperPlugin.bind(manager)
    vi.spyOn(manager, 'loadExplicitDeveloperPlugin').mockImplementation((...args) => { order.push('load'); return load(...args) })
    fireChange()
    expect(await call('plugins:reloadDeveloperPlugin', { id: 'acme.devtodo' })).toEqual({ reloaded: true, requiresConsent: false })
    await vi.waitFor(() => expect(folderEvents).toContainEqual({ pluginId: 'acme.devtodo', kind: 'reloaded' }))
    expect(order).toEqual(['unload', 'load', 'unload', 'load'])
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.devtodo' }])
  })

  it('review MED-3 on #543: a folder that fails the full check keeps the old version running, nothing is unloaded', async () => {
    const { manager } = register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    const remove = vi.spyOn(manager, 'removeInstalledPlugin')
    rmSync(join(folder, BACKEND_ENTRY))
    fireChange()
    await vi.waitFor(() => expect(folderEvents.at(-1)).toMatchObject({ pluginId: 'acme.devtodo', kind: 'reload-failed', running: true }))
    expect(remove).not.toHaveBeenCalled()
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.devtodo' }])
  })

  it('review MED-3 on #543: a load that fails after the old version went says nothing is running', async () => {
    const { manager } = register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    vi.spyOn(manager, 'loadExplicitDeveloperPlugin').mockReturnValueOnce({ loaded: false, error: 'registration failed' })
    fireChange()
    await vi.waitFor(() => expect(folderEvents.at(-1)).toMatchObject({ pluginId: 'acme.devtodo', kind: 'reload-failed', running: false }))
    expect(folderEvents).not.toContainEqual({ pluginId: 'acme.devtodo', kind: 'reloaded' })
    expect(call('plugins:listInstalled')).toEqual([])
    expect((call('plugins:developerMode') as { folders: Array<Record<string, unknown>> }).folders[0])
      .toMatchObject({ loaded: false, reloadError: expect.stringMatching(/registration failed/) })
  })

  it('review MED-3 on #543: permissions changed between the check and the load stop at "needs consent", never "reloaded"', async () => {
    const { manager } = register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    const remove = manager.removeInstalledPlugin.bind(manager)
    vi.spyOn(manager, 'removeInstalledPlugin').mockImplementationOnce((id: string) => {
      writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest('acme.devtodo', { system: ['fs'] })))
      return remove(id)
    })
    fireChange()
    await vi.waitFor(() => expect(folderEvents.at(-1)).toEqual({ pluginId: 'acme.devtodo', kind: 'needs-consent' }))
    expect(folderEvents).not.toContainEqual({ pluginId: 'acme.devtodo', kind: 'reloaded' })
    expect(call('plugins:listInstalled')).toEqual([])
    await call('plugins:commitFolderLoad', { id: 'acme.devtodo', riskConfirmed: true })
    expect(call('plugins:listInstalled')).toMatchObject([{ id: 'acme.devtodo' }])
  })

  it('review R2 LOW-1 on #543: a failure while stopping for consent is reported, not only logged', async () => {
    const { manager } = register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest('acme.devtodo', { system: ['fs'] })))
    vi.spyOn(manager, 'removeInstalledPlugin').mockImplementationOnce(() => { throw new Error('unload failed') })
    fireChange()
    await vi.waitFor(() => expect(folderEvents.at(-1)).toMatchObject({ pluginId: 'acme.devtodo', kind: 'reload-failed', error: expect.stringMatching(/unload failed/) }))
    expect((call('plugins:developerMode') as { folders: Array<Record<string, unknown>> }).folders[0])
      .toMatchObject({ reloadError: expect.stringMatching(/unload failed/) })
  })

  it('review LOW-2 on #543: a folder an agent proposed stays attributed to it after a change asks for consent again', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    const agent = { kind: 'agent', callerKind: 'pane', paneName: 'builder', approvedAt: '2026-10-21T01:00:00.000Z' } as const
    new PluginDeveloperFolderMetaStore(pluginsRoot).setLoadedBy('acme.devtodo', folder, agent)
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest('acme.devtodo', { system: ['fs'] })))
    fireChange()
    await vi.waitFor(() => expect(folderEvents.at(-1)).toEqual({ pluginId: 'acme.devtodo', kind: 'needs-consent' }))
    await call('plugins:commitFolderLoad', { id: 'acme.devtodo', riskConfirmed: true })
    expect((call('plugins:developerMode') as { folders: Array<Record<string, unknown>> }).folders[0]).toMatchObject({ loadedBy: agent })
  })

  it('review LOW-3 on #543: a watch that fails is dropped, said on the card, and starts again with the next load', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    openWatches()[0]!.onError!(new Error('EMFILE: too many open files'))
    expect(openWatches()).toEqual([])
    expect((call('plugins:developerMode') as { folders: Array<Record<string, unknown>> }).folders[0])
      .toMatchObject({ reloadError: expect.stringMatching(/EMFILE/) })
    await call('plugins:reloadDeveloperPlugin', { id: 'acme.devtodo' })
    expect(openWatches()).toHaveLength(1)
  })

  it('review R2 LOW-2 on #543: turning Developer Mode off unloads, stops every watch and drops chosen folders, even when an unload throws', async () => {
    const { manager } = register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    const second = join(base, 'dev-other')
    writeFolder(second, manifest('acme.other'))
    pickFolder.mockResolvedValueOnce(second)
    await call('plugins:commitFolderLoad', { id: (await call('plugins:loadFromFolder') as { id: string }).id, riskConfirmed: true })
    const third = join(base, 'dev-third')
    writeFolder(third, manifest('acme.third'))
    pickFolder.mockResolvedValueOnce(third)
    await call('plugins:loadFromFolder')
    openWatches()[0]!.onError!(new Error('EMFILE'))
    expect(openWatches()).toHaveLength(1)
    const remove = manager.removeInstalledPlugin.bind(manager)
    vi.spyOn(manager, 'removeInstalledPlugin').mockImplementation((id: string) => {
      if (id === 'acme.devtodo') throw new Error('unload failed')
      return remove(id)
    })
    await expect(call('plugins:setDeveloperMode', { enabled: false })).rejects.toThrow(/unload failed/)
    expect(openWatches()).toEqual([])
    expect((call('plugins:developerMode') as { folders: Array<Record<string, unknown>> }).folders.every((folder) => folder.reloadError === undefined)).toBe(true)
    vi.mocked(manager.removeInstalledPlugin).mockImplementation(remove)
    await call('plugins:setDeveloperMode', { enabled: true })
    await expect(call('plugins:commitFolderLoad', { id: 'acme.third', riskConfirmed: true }))
      .rejects.toThrow(/no prepared developer folder/)
  })

  it('only the main window turns it on or off', async () => {
    register(() => false)
    await expect(call('plugins:setDeveloperFolderAutoReload', { id: 'acme.devtodo', enabled: false })).rejects.toThrow(/unauthorized/)
  })
})

describe('review of #428', () => {
  function writeTakedown(blockedPublishers: string[]): void {
    const metadata: RegistryTrustMetadata = {
      schemaVersion: 1, registryProfile: 'self-hosted-dev', rootFingerprint: `sha256:${'1'.repeat(64)}`,
      generatedAt: '2026-08-16T10:00:00.000Z', expiresAt: '2026-08-17T10:00:00.000Z',
      signers: [{ keyId: 'k1', publicKey: registrySigner.pubPem, status: 'active', notBefore: '2026-08-01T00:00:00.000Z', notAfter: '2026-09-01T00:00:00.000Z' }],
      blockedPublishers, blockedPackages: [],
    }
    writeFileSync(join(pluginsRoot, '.navide-registry-trust.json'), JSON.stringify({
      schemaVersion: 1, metadata, metadataSignature: signCanonical(metadata, registryRoot.privateKey),
    }))
  }

  it('MED-1: a developer folder of a taken-down publisher is refused at load, and at the next start', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    expect(await call('plugins:loadFromFolder')).toMatchObject({ takedownChecked: false })
    await call('plugins:commitFolderLoad', { id: 'acme.devtodo', riskConfirmed: true })
    writeTakedown(['acme'])
    handlers.clear()
    const restarted = register()
    await restarted.controller.loadDeveloperFolders()
    expect(restarted.manager.listInstalledPackages()).toEqual([])
    expect(call('plugins:developerMode')).toMatchObject({
      folders: [{ pluginId: 'acme.devtodo', loaded: false, unavailable: expect.stringMatching(/^DEVELOPER_FOLDER_TAKEN_DOWN \[acme\.devtodo\]: taken down by Navide/) }],
    })
    await expect(call('plugins:reloadDeveloperPlugin', { id: 'acme.devtodo' })).rejects.toThrow(/taken down by Navide/)
    await call('plugins:removeDeveloperFolder', { id: 'acme.devtodo' })
    await expect(call('plugins:loadFromFolder')).rejects.toThrow(/taken down by Navide/)
  })

  it('LOW-1: removing it through plugins:remove (an agent request too) forgets the folder, which is never touched', async () => {
    register()
    await call('plugins:setDeveloperMode', { enabled: true })
    await loadFolder()
    await call('plugins:remove', { id: 'acme.devtodo' })
    expect(new PluginDeveloperModeStore(pluginsRoot).folders()).toEqual([])
    handlers.clear()
    const restarted = register()
    await restarted.controller.loadDeveloperFolders()
    expect(restarted.manager.listInstalledPackages()).toEqual([])
    expect(readFileSync(join(folder, 'manifest.json'), 'utf8')).toContain('acme.devtodo')
  })
})

describe('LOW-11: only Registry-verified sources hand kept data on (RULE ZERO)', () => {
  it.each(['0.1.0', '0.2.0-beta.1'])('a Marketplace %s reinstall after a removal that kept the data reuses it', async (version) => {
    register()
    await marketplaceInstall('acme.hosted', version)
    mkdirSync(join(dataRoot, 'acme.hosted'))
    writeFileSync(join(dataRoot, 'acme.hosted', 'kept'), 'M')
    await call('plugins:remove', { id: 'acme.hosted' })
    await marketplaceInstall('acme.hosted', version)
    expect(readdirSync(dataRoot)).toEqual(['acme.hosted'])
    expect(readFileSync(join(dataRoot, 'acme.hosted', 'kept'), 'utf8')).toBe('M')
  })
})

describe('D6: self-hosted Registry overrides in a packaged build', () => {
  it('ignores AGENT_TEAM_MARKETPLACE_URL while the switch is off and uses it while on', () => {
    packaged.value = true
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://registry.example.test'
    setMarketplaceOverridesAllowed(() => false)
    expect(resolveConfiguredMarketplace(TRUST_CONFIG).registryUrl).toBe(OFFICIAL_MARKETPLACE_URL)
    setMarketplaceOverridesAllowed(() => true)
    expect(resolveConfiguredMarketplace(TRUST_CONFIG).registryUrl).toBe('https://registry.example.test')
  })

  it('keeps a development build exactly as on main', () => {
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'http://127.0.0.1:9999'
    expect(resolveConfiguredMarketplace(TRUST_CONFIG).registryUrl).toBe('http://127.0.0.1:9999')
  })

  it('names a package installed from a self-hosted Registry instead of letting it vanish', async () => {
    // Installed from a self-hosted Registry (the test trust config's authority).
    const bytes = new Uint8Array(makeZip([
      { name: 'manifest.json', data: JSON.stringify(manifest('acme.hosted', {}, false)) },
      { name: 'frontend/left/index.html', data: '<!doctype html>' },
    ]))
    const digest = sha256Hex(bytes)
    const envelope: RegistryPackageEnvelope = {
      schemaVersion: 1, artifactDigest: digest, packageId: 'acme.hosted', version: '0.1.0', target: 'universal',
      publisherId: 'acme', keyId: 'k1', signedAt: '2026-08-16T11:00:00.000Z',
    }
    const metadata: RegistryTrustMetadata = {
      schemaVersion: 1, registryProfile: 'self-hosted-dev', rootFingerprint: `sha256:${'1'.repeat(64)}`,
      generatedAt: '2026-08-16T10:00:00.000Z', expiresAt: '2026-08-17T10:00:00.000Z',
      signers: [{ keyId: 'k1', publicKey: registrySigner.pubPem, status: 'active', notBefore: '2026-08-01T00:00:00.000Z', notAfter: '2026-09-01T00:00:00.000Z' }],
      blockedPublishers: [], blockedPackages: [],
    }
    const detail = {
      latest_version: '0.1.0', trust_metadata: metadata, trust_metadata_signature: signCanonical(metadata, registryRoot.privateKey),
      versions: [{ version: '0.1.0', package_digest: digest, target: 'universal', registry_envelope: envelope,
        registry_signature: signCanonical(envelope, registrySigner.privateKey), trust_tier: 'signed-verified', yanked: false }],
    }
    global.fetch = vi.fn(async (url: unknown) => String(url).endsWith('/download')
      ? { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), headers: { get: () => digest } }
      : { ok: true, status: 200, json: async () => detail }) as unknown as typeof fetch
    register()
    await call('plugins:prepareInstall', { namespace: 'acme', name: 'hosted' })
    await call('plugins:commitInstall', { id: 'acme.hosted', publisherConfirmed: true, riskConfirmed: true })
    await call('plugins:restart', { id: 'acme.hosted' })
    expect(call('plugins:selfHostedQuarantine')).toEqual([])

    // Next start of a packaged build with the switch off: not loaded, and said so.
    packaged.value = true
    setMarketplaceOverridesAllowed(() => false)
    handlers.clear()
    register()
    expect(call('plugins:selfHostedQuarantine')).toEqual([{ id: 'acme.hosted', version: '0.1.0' }])
    setMarketplaceOverridesAllowed(() => true)
    expect(call('plugins:selfHostedQuarantine')).toEqual([])
  })
})
