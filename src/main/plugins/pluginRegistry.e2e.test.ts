// End-to-end: a real Marketplace Registry (marketplace/registry, started here
// on loopback with freshly generated keys) driven through the App's real
// `plugins:*` IPC handlers, installer and trust verification. Only Electron
// (app/ipcMain/BrowserWindow) and the hidden-window frontend preflight are
// stubbed; every network call goes to the Registry this file starts.
//
// The Registry cannot host on Windows (its key files are checked for POSIX
// owner-only modes), so the suite is skipped there. Elsewhere it skips only
// when marketplace/registry/.venv is missing, unless NAVIDE_REGISTRY_E2E_REQUIRED=1
// (set by ci.yml's frontend job on macOS and Linux), which makes that a failure.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.2.24' },
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

import { registerPluginIpc, type PluginTrustRefreshController } from './pluginIpc'
import { FrontendPluginManager } from './frontendPluginManager'
import { PluginCapabilityGrantStore } from './pluginCapabilityGrantStore'
import { immutablePluginPackageDir, PluginActivationSelector } from './pluginActivationSelector'
import { registryRootFingerprint } from './pluginRegistryRootApproval'

// Generous: the Registry is a separate Python process on a shared runner.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const REGISTRY_DIR = resolve(__dirname, '../../../marketplace/registry')
const REGISTRY_PYTHON = join(REGISTRY_DIR, '.venv', 'bin', 'python')
const IS_WINDOWS = process.platform === 'win32'
const REGISTRY_AVAILABLE = !IS_WINDOWS && existsSync(REGISTRY_PYTHON)
const PUBLISHER = 'e2etest'
const NAME = 'probe'
const ID = `${PUBLISHER}.${NAME}`

// Only a job that installs the Registry env opts in to failing without it;
// every other run (release gates included) skips.
if (!IS_WINDOWS && !REGISTRY_AVAILABLE) {
  if (process.env.NAVIDE_REGISTRY_E2E_REQUIRED === '1') {
    throw new Error(`Registry Python env missing at ${REGISTRY_PYTHON}; NAVIDE_REGISTRY_E2E_REQUIRED=1 needs uv --project marketplace/registry sync --locked`)
  }
  console.warn(`[pluginRegistry.e2e] skipped: no Registry env at ${REGISTRY_PYTHON} (run uv --project marketplace/registry sync --locked)`)
}

/** Recursively list every path under `dir` (empty when it does not exist). */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (current: string, rel: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      out.push(relPath)
      if (entry.isDirectory()) walk(join(current, entry.name), relPath)
    }
  }
  walk(dir, '')
  return out.sort()
}

function findFiles(dir: string, match: (path: string) => boolean): string[] {
  return tree(dir).map((rel) => join(dir, rel)).filter((path) => statSync(path).isFile() && match(path))
}

describe.skipIf(!REGISTRY_AVAILABLE)('real Registry → App install pipeline', () => {
  let work: string
  let dataDir: string
  let registry: ChildProcess | undefined
  let registryPid: number | undefined
  let registryUrl: string
  let approvalFile: string
  let publisherToken: string
  const registryLog: string[] = []
  const managers: FrontendPluginManager[] = []

  /** Run Registry CLI commands in one interpreter (each Python start costs
   *  seconds on a loaded runner). */
  function cli(commands: string[][]): void {
    const code = [
      'import json, sys',
      'from registry.cli import main',
      'for argv in json.loads(sys.argv[1]):',
      '    if main(argv) != 0: sys.exit(1)',
    ].join('\n')
    execFileSync(REGISTRY_PYTHON, ['-c', code, JSON.stringify(commands)], {
      cwd: REGISTRY_DIR,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', NAVIDE_PLUGIN_CONFIG_DIR: join(work, 'cli-config') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  const PERMISSIONS: Record<string, Record<string, unknown>> = {
    '0.1.0': { system: ['fs'], scopes: { fs: { root: 'workspace', read: ['README.md'] } } },
    // 0.1.1 adds a shell permission, which must trigger a fresh consent.
    '0.1.1': { system: ['fs'], scopes: { fs: { root: 'workspace', read: ['README.md'] } }, shell: 'allowlist' },
  }
  const vsixPath = (version: string): string => join(work, `${ID}-${version}.vsix`)

  /** Generate publisher keys, then pack and sign both versions with the
   *  Registry's own tooling. */
  function buildPackages(): void {
    const commands: string[][] = [['keygen', '--out-dir', join(work, 'keys'), '--name', PUBLISHER]]
    for (const version of Object.keys(PERMISSIONS)) {
      const src = join(work, `src-${version}`)
      mkdirSync(join(src, 'frontend', 'main'), { recursive: true })
      writeFileSync(join(src, 'manifest.json'), JSON.stringify({
        schemaVersion: 2,
        apiVersion: '^1.0.0',
        id: ID,
        name: 'Registry E2E Probe',
        version,
        publisher: PUBLISHER,
        permissions: PERMISSIONS[version],
        marketplace: { description: 'End-to-end install probe', license: 'MIT' },
        contributes: {
          views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Probe', entry: 'frontend/main/index.html' }],
        },
      }, null, 2))
      writeFileSync(join(src, 'frontend', 'main', 'index.html'), `<!doctype html><title>probe ${version}</title>`)
      writeFileSync(join(src, 'artifact-files.json'), JSON.stringify({ files: ['manifest.json', 'frontend/main/index.html'] }))
      commands.push(['pack', src, '--out', vsixPath(version)])
      commands.push(['sign', vsixPath(version), '--key', join(work, 'keys', `${PUBLISHER}.key`), '--out', `${vsixPath(version)}.sig`])
    }
    cli(commands)
  }

  /** Publish a packed, publisher-signed version through the Registry API (the
   *  same request `navide-plugin publish` sends). */
  async function publish(version: string): Promise<void> {
    const body = new FormData()
    body.append('package', new Blob([readFileSync(vsixPath(version))], { type: 'application/zip' }), `${ID}-${version}.vsix`)
    const signature = readFileSync(`${vsixPath(version)}.sig`, 'utf8').trim()
    const res = await fetch(
      `${registryUrl}/api/publish?target=universal&signature=${encodeURIComponent(signature)}`,
      { method: 'POST', body, headers: { authorization: `Bearer ${publisherToken}` } }
    )
    expect(res.status, await res.clone().text()).toBe(201)
    expect(await res.json()).toMatchObject({ review_status: 'approved' })
  }

  async function startRegistry(): Promise<void> {
    const adminToken = createHash('sha256').update(`admin-${Math.random()}`).digest('hex')
    registry = spawn(REGISTRY_PYTHON, ['-m', 'uvicorn', 'registry.app:app', '--host', '127.0.0.1', '--port', '0'], {
      cwd: REGISTRY_DIR,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        REGISTRY_DATA_DIR: dataDir,
        REGISTRY_ADMIN_TOKEN: adminToken,
        REGISTRY_TRUST_PROFILE: 'self-hosted-dev',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    registryPid = registry.pid
    registryUrl = await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error(`Registry did not start:\n${registryLog.join('')}`)), 45_000)
      const onData = (chunk: Buffer): void => {
        registryLog.push(chunk.toString())
        const match = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/.exec(registryLog.join(''))
        if (match) {
          clearTimeout(timer)
          resolveUrl(match[1])
        }
      }
      registry!.stdout!.on('data', onData)
      registry!.stderr!.on('data', onData)
      registry!.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Registry exited (${code}):\n${registryLog.join('')}`))
      })
    })

    buildPackages()
    publisherToken = createHash('sha256').update(`publisher-${Math.random()}`).digest('hex')
    const res = await fetch(`${registryUrl}/api/publishers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({
        name: PUBLISHER,
        public_key: readFileSync(join(work, 'keys', `${PUBLISHER}.pub`), 'utf8'),
        token: publisherToken,
      }),
    })
    expect(res.status).toBe(201)

    // The operator's out-of-band root approval, from the root the Registry
    // generated for itself on first start.
    const rootPublicKeyPem = createPublicKey(readFileSync(join(dataDir, 'trust', 'root.pem'), 'utf8'))
      .export({ type: 'spki', format: 'pem' })
      .toString()
    approvalFile = join(work, 'registry-root-approval.json')
    writeFileSync(approvalFile, JSON.stringify({
      schemaVersion: 1,
      registryUrl,
      rootPublicKeyPem,
      confirmedFingerprint: registryRootFingerprint(rootPublicKeyPem),
    }))
    vi.stubEnv('AGENT_TEAM_MARKETPLACE_URL', registryUrl)
    vi.stubEnv('AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE', approvalFile)
  }

  async function stopRegistry(): Promise<void> {
    if (!registry || registryPid === undefined) return
    if (registry.exitCode === null && registry.signalCode === null) {
      const exited = new Promise<void>((done) => registry!.once('exit', () => done()))
      process.kill(registryPid)
      await exited
    }
    registry = undefined
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'navide-registry-e2e-'))
    dataDir = join(work, 'registry-data')
    mkdirSync(dataDir, { mode: 0o700 })
    try {
      await startRegistry()
    } catch (error) {
      await stopRegistry()
      throw error
    }
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    for (const manager of managers) await manager.closeBackendPlugins()
    await stopRegistry()
    if (work) rmSync(work, { recursive: true, force: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** A fresh Host: its own plugins root, manager and IPC handler set. Trust
   *  comes from the Host's own resolution (URL override + approval file). */
  function host(label: string): {
    root: string
    manager: FrontendPluginManager
    controller: PluginTrustRefreshController
    call: (channel: string, args?: unknown) => Promise<any>
  } {
    const root = join(work, `plugins-${label}`)
    mkdirSync(root)
    const manager = new FrontendPluginManager()
    managers.push(manager)
    handlers.clear()
    const controller = registerPluginIpc(manager, root, () => true, undefined, undefined, {
      cleanupPluginStorage: async () => undefined,
      preflightCandidateFrontend: async () => undefined,
      preflightCandidateBackend: async () => undefined,
    })
    const bound = new Map(handlers)
    const call = async (channel: string, args?: unknown): Promise<any> => {
      const handler = bound.get(channel)
      if (!handler) throw new Error(`${channel} not registered`)
      return handler(null, args)
    }
    return { root, manager, controller, call }
  }

  async function installFresh(label: string, version = '0.1.0') {
    const h = host(label)
    await h.call('plugins:prepareInstall', { namespace: PUBLISHER, name: NAME, version })
    await h.call('plugins:commitInstall', { id: ID, publisherConfirmed: true, riskConfirmed: true })
    await h.call('plugins:restart', { id: ID })
    expect(new PluginActivationSelector(h.root).read(ID)?.active?.packageVersion).toBe(version)
    return h
  }

  // Shared lifecycle Host for scenarios 2–6.
  let main: ReturnType<typeof host>

  it('(1) publish → search finds it', async () => {
    await publish('0.1.0')
    main = host('main')
    const result = await main.call('plugins:marketplaceSearch', 'Registry E2E Probe')
    const items = (result.items ?? result) as Array<{ identity?: string }>
    expect(items.map((item) => item.identity)).toContain(ID)
  })

  it('(2) prepareInstall verifies root/signature/digest, reports fs sensitive; cancel writes nothing', async () => {
    const before = tree(main.root)
    const prepared = await main.call('plugins:prepareInstall', { namespace: PUBLISHER, name: NAME })
    expect(prepared).toMatchObject({
      id: ID,
      version: '0.1.0',
      trustTier: 'signed-verified',
      sensitive: ['fs'],
      requiresConfirmation: true,
      requiresRiskConfirmation: true,
      requiresPublisherTrust: true,
      containsBackendExecutable: false,
    })
    // The user cancels the consent dialog: no commit follows.
    expect(tree(main.root)).toEqual(before)
    expect(new PluginActivationSelector(main.root).read(ID)).toBeNull()
    // Committing without consent is refused and also writes nothing.
    await expect(main.call('plugins:commitInstall', { id: ID })).rejects.toThrow(/publisher trust confirmation/)
    expect(tree(main.root)).toEqual(before)
  })

  it('(3) commitInstall + restart grants exactly the installed version', async () => {
    await main.call('plugins:prepareInstall', { namespace: PUBLISHER, name: NAME })
    await expect(main.call('plugins:commitInstall', { id: ID, publisherConfirmed: true }))
      .rejects.toThrow(/risk confirmation/)
    await main.call('plugins:prepareInstall', { namespace: PUBLISHER, name: NAME })
    await expect(main.call('plugins:commitInstall', { id: ID, publisherConfirmed: true, riskConfirmed: true }))
      .resolves.toMatchObject({ id: ID, restartRequired: true })
    // Staged only: no grant until the candidate is activated.
    expect(new PluginCapabilityGrantStore(main.root).get(ID, '0.1.0')).toBeNull()
    await expect(main.call('plugins:restart', { id: ID })).resolves.toMatchObject({ id: ID, packageVersion: '0.1.0' })
    expect(new PluginCapabilityGrantStore(main.root).get(ID, '0.1.0')).toMatchObject({
      packageVersion: '0.1.0',
      system: ['fs'],
    })
    expect(new PluginCapabilityGrantStore(main.root).get(ID, '0.1.1')).toBeNull()
    expect(existsSync(immutablePluginPackageDir(main.root, ID, '0.1.0', 'universal'))).toBe(true)
    expect(main.manager.listInstalledPackages().map((pkg) => pkg.id)).toContain(ID)
  })

  it('(4) update to 0.1.1 is detected; its new shell permission needs new consent before it runs', async () => {
    await publish('0.1.1')
    await expect(main.controller.checkUpdates()).resolves.toEqual([
      { id: ID, namespace: PUBLISHER, name: NAME, installedVersion: '0.1.0', latestVersion: '0.1.1' },
    ])
    const prepared = await main.call('plugins:prepareInstall', { namespace: PUBLISHER, name: NAME, version: '0.1.1' })
    expect(prepared).toMatchObject({ version: '0.1.1', requiresPublisherTrust: false, requiresRiskConfirmation: true })
    expect(prepared.sensitive).toEqual(expect.arrayContaining(['fs', 'shell']))
    // Publisher trust is remembered, the new risk consent is not.
    await expect(main.call('plugins:commitInstall', { id: ID })).rejects.toThrow(/risk confirmation/)
    expect(new PluginCapabilityGrantStore(main.root).get(ID, '0.1.1')).toBeNull()
    expect(new PluginActivationSelector(main.root).read(ID)?.candidate).toBeFalsy()

    await main.call('plugins:prepareInstall', { namespace: PUBLISHER, name: NAME, version: '0.1.1' })
    await main.call('plugins:commitInstall', { id: ID, riskConfirmed: true })
    // Consented but not running yet: 0.1.0 stays active with its own grant.
    const staged = new PluginActivationSelector(main.root).read(ID)
    expect(staged?.active?.packageVersion).toBe('0.1.0')
    expect(staged?.candidate?.packageVersion).toBe('0.1.1')
    expect(new PluginCapabilityGrantStore(main.root).get(ID, '0.1.1')).toBeNull()
    expect(new PluginCapabilityGrantStore(main.root).get(ID, '0.1.0')?.shell).toBeUndefined()

    await expect(main.call('plugins:restart', { id: ID })).resolves.toMatchObject({ packageVersion: '0.1.1' })
    expect(new PluginActivationSelector(main.root).read(ID)?.active?.packageVersion).toBe('0.1.1')
    expect(new PluginCapabilityGrantStore(main.root).get(ID, '0.1.1')).toMatchObject({
      packageVersion: '0.1.1',
      system: ['fs'],
      shell: 'allowlist',
    })
  })

  it('(5) rollback returns to 0.1.0 with its own grant', async () => {
    await expect(main.call('plugins:rollback', { id: ID })).resolves.toMatchObject({ packageVersion: '0.1.0' })
    expect(new PluginActivationSelector(main.root).read(ID)?.active?.packageVersion).toBe('0.1.0')
    const grant = new PluginCapabilityGrantStore(main.root).get(ID, '0.1.0')
    expect(grant).toMatchObject({ packageVersion: '0.1.0', system: ['fs'] })
    expect(grant?.shell).toBeUndefined()
  })

  it('(6) remove deletes the package directories and unregisters the plugin', async () => {
    await expect(main.call('plugins:remove', { id: ID })).resolves.toEqual({ ok: true })
    expect(existsSync(immutablePluginPackageDir(main.root, ID, '0.1.0', 'universal'))).toBe(false)
    expect(existsSync(immutablePluginPackageDir(main.root, ID, '0.1.1', 'universal'))).toBe(false)
    expect(existsSync(join(main.root, ID))).toBe(false)
    expect(new PluginActivationSelector(main.root).read(ID)).toBeNull()
    expect(main.manager.listInstalledPackages().map((pkg) => pkg.id)).not.toContain(ID)
  })

  it('(7) a stored blob that no longer matches its digest → DIGEST_MISMATCH, nothing written', async () => {
    const detail = (await (await fetch(`${registryUrl}/api/extensions/${PUBLISHER}/${NAME}`)).json()) as {
      versions: Array<{ version: string; package_digest: string }>
    }
    const digest = detail.versions.find((row) => row.version === '0.1.0')!.package_digest
    const [blob] = findFiles(join(dataDir, 'packages'), (path) =>
      createHash('sha256').update(readFileSync(path)).digest('hex') === digest)
    expect(blob).toBeDefined()
    const original = readFileSync(blob)
    const h = host('digest')
    const before = tree(h.root)
    try {
      const corrupted = Buffer.from(original)
      corrupted[corrupted.length - 1] ^= 0xff
      writeFileSync(blob, corrupted)
      await expect(h.call('plugins:prepareInstall', { namespace: PUBLISHER, name: NAME, version: '0.1.0' }))
        .rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    } finally {
      writeFileSync(blob, original)
    }
    await expect(h.call('plugins:commitInstall', { id: ID, publisherConfirmed: true, riskConfirmed: true }))
      .rejects.toThrow(/no prepared install/)
    expect(tree(h.root)).toEqual(before)
  })

  it('(8) a missing or invalid Registry signature is rejected', async () => {
    const h = host('signature')
    const before = tree(h.root)
    const realFetch = globalThis.fetch
    const tamper = (mutate: (row: Record<string, unknown>) => void): void => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const response = await realFetch(input, init)
        if (!String(input).endsWith(`/api/extensions/${PUBLISHER}/${NAME}`)) return response
        const body = (await response.json()) as { versions: Array<Record<string, unknown>> }
        for (const row of body.versions) mutate(row)
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      })
    }

    tamper((row) => { row.registry_signature = null })
    await expect(h.call('plugins:prepareInstall', { namespace: PUBLISHER, name: NAME, version: '0.1.0' }))
      .rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' })
    vi.restoreAllMocks()

    tamper((row) => {
      const signature = Buffer.from(String(row.registry_signature), 'base64')
      signature[0] ^= 0xff
      row.registry_signature = signature.toString('base64')
    })
    await expect(h.call('plugins:prepareInstall', { namespace: PUBLISHER, name: NAME, version: '0.1.0' }))
      .rejects.toThrow(/signature/i)
    vi.restoreAllMocks()
    expect(tree(h.root)).toEqual(before)
  })

  it('(9) a tampered installed file is quarantined at the next verification', async () => {
    const h = await installFresh('tamper')
    const entry = join(immutablePluginPackageDir(h.root, ID, '0.1.0', 'universal'), 'frontend', 'main', 'index.html')
    writeFileSync(entry, '<!doctype html><script>tampered()</script>')
    const { decisions } = await h.controller.refreshRegistryTrust()
    expect(decisions).toContainEqual(expect.objectContaining({ pluginId: ID, action: 'quarantine' }))
    expect(h.manager.listInstalledPackages().map((pkg) => pkg.id)).not.toContain(ID)
  })

  it('(10) trust metadata older than 24 hours is quarantined', async () => {
    const h = await installFresh('expired')
    expect((await h.controller.refreshRegistryTrust()).decisions)
      .toContainEqual(expect.objectContaining({ pluginId: ID, action: 'allow' }))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    await expect(h.controller.refreshRegistryTrust()).rejects.toThrow(/expire/i)
    expect(h.manager.listInstalledPackages().map((pkg) => pkg.id)).not.toContain(ID)
  })
})
