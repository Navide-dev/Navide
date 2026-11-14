// End to end: navide.browser installed from the Official Registry (Navide
// Marketplace) through the real `plugins:*` IPC handlers, installer and trust
// verification, with freshly generated test keys standing in for the Registry
// root and signer. Only Electron, the network and the plugin web view host are
// stubbed. It covers what first-party treatment the installed package gets
// (backend outside the third-party gate with exactly the `web` bridge port,
// agent tools behind the master switch but without consent) and that look-alikes do
// not get it: a third-party `acme.browser`, and `navide.browser` from any
// source other than the Official Registry or the App bundle.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { handlers, web } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  web: { destroyed: [] as string[], cleared: [] as string[] },
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

// The plugin web view registry, recording which plugins lost their views and
// which partitions were cleared (`persist:navide-web:<id>`).
vi.mock('./pluginWebViewHost', () => ({
  setPluginWebViewChangedHook: () => {},
  pluginWebViewRegistry: () => ({
    list: () => [],
    destroyPlugin: (pluginId: string) => { web.destroyed.push(pluginId) },
    clearData: async (pluginId: string) => { web.cleared.push(`persist:navide-web:${pluginId}`) },
  }),
}))

vi.setConfig({ testTimeout: 30_000 })

import { makeZip } from './zipFixture'
import { sha256Hex } from './pluginVerify'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import type { InstallerTrustConfig } from './pluginInstaller'
import { backendEntryOnDisk, type PluginActivationCatalogEntry } from './installedPlugins'
import { PluginCapabilityGrantStore } from './pluginCapabilityGrantStore'
import { PluginDisabledStore } from './pluginDisabledStore'
import { readRegistryTrustSnapshot } from './pluginInstalledTrust'
import { registerPluginIpc } from './pluginIpc'
import { FrontendPluginManager } from './frontendPluginManager'
import { PluginAgentToolsHost } from './pluginAgentToolsHost'
import {
  firstPartyAgentToolSpec,
  firstPartyBackendLaunchSpec,
  isThirdPartyLaunchSpec,
  thirdPartyBackendLaunchSpec,
  type ThirdPartyLaunchSpec,
} from './pluginThirdPartyBackends'
import type { AgentToolsSyncPayload } from '../../shared/pluginAgentTools'

const OFFICIAL_URL = 'https://server.navide.dev/registry'

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
const OFFICIAL_TRUST: InstallerTrustConfig = {
  pinnedRegistryRootKey: registryRoot.pubPem,
  now: FIXED_NOW,
  registryAuthority: 'official',
  officialRegistryUrl: OFFICIAL_URL,
}
const SELF_HOSTED_TRUST: InstallerTrustConfig = { pinnedRegistryRootKey: registryRoot.pubPem, now: FIXED_NOW }
const BACKEND_ENTRY_ON_DISK = backendEntryOnDisk('backend/entry')

const AGENT_TOOLS = [
  {
    name: 'browser_list', method: 'browser.list', risk: 'read', title: 'List browser Spaces',
    description: 'List the Navide Browser Spaces.', timeoutMs: 10_000,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'browser_open', method: 'browser.open', risk: 'write', title: "Open this pane's browser Space",
    description: "Open this pane's own Space.", timeoutMs: 30_000,
    inputSchema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } } },
  },
]

/** A browser-shaped package: views, the `ui` + `web` namespaces and a native
 *  backend with agent tools prefixed by the id's name part. */
function browserPackage(id: string, publisher = id.split('.')[0]!, withAgentTools = true): { bytes: Uint8Array; digest: string } {
  const name = id.split('.')[1]!
  const manifest = JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id,
    name: 'Navide Browser',
    version: '1.0.0',
    publisher,
    permissions: { system: ['ui', 'web'] },
    marketplace: { description: 'Browse the web inside Navide.', license: 'MIT' },
    contributes: {
      views: [{ id: 'window', kind: 'custom', location: 'window', title: 'Navide Browser', entry: 'frontend/window/index.html' }],
    },
    backend: {
      entry: 'backend/entry',
      protocolVersion: 1,
      activation: 'startup',
      methods: ['browser.list', 'browser.open'],
      ...(withAgentTools ? { agentTools: AGENT_TOOLS.map((tool) => ({ ...tool, name: tool.name.replace('browser', name) })) } : {}),
    },
  })
  const entry = { data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), unixMode: 0o100755 }
  const bytes = new Uint8Array(makeZip([
    { name: 'manifest.json', data: manifest },
    { name: 'frontend/window/index.html', data: '<!doctype html>' },
    { name: 'backend/entry', ...entry },
    ...(BACKEND_ENTRY_ON_DISK === 'backend/entry' ? [] : [{ name: BACKEND_ENTRY_ON_DISK, ...entry }]),
  ]))
  return { bytes, digest: sha256Hex(bytes) }
}

/** Registry detail + download for one package, signed by the test Registry. */
function serveRegistry(id: string, pkg: { bytes: Uint8Array; digest: string }, publisherId = id.split('.')[0]!): void {
  const envelope: RegistryPackageEnvelope = {
    schemaVersion: 1,
    artifactDigest: pkg.digest,
    packageId: id,
    version: '1.0.0',
    target: 'universal',
    publisherId,
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
    latest_version: '1.0.0',
    trust_metadata: metadata,
    trust_metadata_signature: signCanonical(metadata, registryRoot.privateKey),
    versions: [{
      version: '1.0.0',
      package_digest: pkg.digest,
      target: 'universal',
      registry_envelope: envelope,
      registry_signature: signCanonical(envelope, registrySigner.privateKey),
      trust_tier: 'signed-verified',
      yanked: false,
    }],
  }
  global.fetch = vi.fn(async (url: unknown) => {
    if (String(url).endsWith('/download')) {
      const ab = pkg.bytes.buffer.slice(pkg.bytes.byteOffset, pkg.bytes.byteOffset + pkg.bytes.byteLength)
      return { ok: true, status: 200, arrayBuffer: async () => ab, headers: { get: (h: string) => (h.toLowerCase() === 'x-package-digest' ? pkg.digest : null) } }
    }
    return { ok: true, status: 200, json: async () => detail }
  }) as unknown as typeof fetch
}

let root = ''
let manager: FrontendPluginManager
let activations: Map<string, PluginActivationCatalogEntry>
let previousUrl: string | undefined

function register(trust: InstallerTrustConfig = OFFICIAL_TRUST, extra: Record<string, unknown> = {}): void {
  manager = new FrontendPluginManager()
  // The Host installs this resolver before its first package load.
  manager.setDisabledPluginResolver((id) => new PluginDisabledStore(root).has(id))
  registerPluginIpc(manager, root, () => true, trust, undefined, {
    cleanupPluginStorage: async () => undefined,
    preflightCandidateFrontend: async () => undefined,
    preflightCandidateBackend: async () => undefined,
    onActivationChange: ({ pluginId, activation }: { pluginId: string; activation?: PluginActivationCatalogEntry }) => {
      activations.delete(pluginId)
      if (activation) activations.set(pluginId, activation)
    },
    ...extra,
  })
}

const call = (channel: string, args?: unknown): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} is not registered`)
  return Promise.resolve(handler(null, args))
}

/** prepare → commit (the user's install consent) → restart, as the Marketplace page does. */
async function installFromRegistry(id: string, pkg = browserPackage(id)): Promise<PluginActivationCatalogEntry> {
  serveRegistry(id, pkg)
  const [namespace, name] = id.split('.')
  await call('plugins:prepareInstall', { namespace, name })
  await call('plugins:commitInstall', { id, publisherConfirmed: true, riskConfirmed: true })
  await call('plugins:restart', { id })
  const activation = activations.get(id)
  if (!activation) throw new Error(`${id} was not activated`)
  return activation
}

/** The agent-tool host as the Host wires it, with the DB8 master switch off
 *  and no per-version consent for anything. */
function agentToolsHost(firstParty: ThirdPartyLaunchSpec[], thirdParty: ThirdPartyLaunchSpec[], hasConsent = vi.fn(async () => false)) {
  const sent: AgentToolsSyncPayload[] = []
  const methods = new Map<string, string[]>()
  let switches = { enabled: false, externalCallers: false }
  const host = new PluginAgentToolsHost({
    switches: () => ({ ...switches }),
    setSwitches: (change) => { switches = { ...switches, ...change } },
    listPackages: () => thirdParty,
    listFirstPartyPackages: () => firstParty,
    isDisabled: () => false,
    hasConsent,
    agentToolSince: () => null,
    setAgentMethods: (pluginId, version, list) => { methods.set(`${pluginId}@${version}`, list) },
    confirmWrite: async () => true,
    send: async (payload) => { sent.push(payload); return 'delivered' },
  })
  return { host, sent, methods, hasConsent }
}

const PANE = { kind: 'pane' as const, paneId: 'p-1', workspace: '/ws' }
const notStopping = () => false

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'navide-browser-registry-'))
  activations = new Map()
  handlers.clear()
  web.destroyed.length = 0
  web.cleared.length = 0
  previousUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
  process.env['AGENT_TEAM_MARKETPLACE_URL'] = OFFICIAL_URL
})

afterEach(async () => {
  await manager?.closeBackendPlugins()
  if (previousUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
  else process.env['AGENT_TEAM_MARKETPLACE_URL'] = previousUrl
  rmSync(root, { recursive: true, force: true })
})

describe('(a) navide.browser installed from the Official Registry', () => {
  it('takes the first-party backend path: no third-party gate, bridge ports exactly [web]', async () => {
    register()
    const activation = await installFromRegistry('navide.browser')
    expect(activation).toMatchObject({ pluginId: 'navide.browser', provenance: 'official-registry' })

    const spec = firstPartyBackendLaunchSpec(activation)
    expect(spec).not.toBeNull()
    // No thirdParty part: the global switch, per-version consent and the OS
    // sandbox of the third-party admission gate never apply.
    expect(spec).not.toHaveProperty('thirdParty')
    expect(isThirdPartyLaunchSpec(spec!)).toBe(false)
    expect(spec!.approvedBridgePorts).toEqual(['web'])
    expect(spec!.agentMethods).toEqual([])
  })

  it('gets its web grant through the normal install consent', async () => {
    register()
    await installFromRegistry('navide.browser')
    expect(new PluginCapabilityGrantStore(root).get('navide.browser', '1.0.0')?.system).toEqual(['ui', 'web'])
    const listed = (await call('plugins:listInstalled')) as Array<Record<string, unknown>>
    expect(listed.find((pkg) => pkg.id === 'navide.browser')).toMatchObject({
      provenance: 'official-registry',
      packageVersionGrant: { system: ['ui', 'web'] },
    })
  })
})

describe('(b) agent tools of a registry-installed navide.browser', () => {
  it('are served with the DB8 master switch off: it covers third-party packages only', async () => {
    register()
    const activation = await installFromRegistry('navide.browser')
    const { host, sent, methods, hasConsent } = agentToolsHost([firstPartyAgentToolSpec(activation)!], [])
    await host.refresh()
    expect(sent.at(-1)).toMatchObject({ enabled: true, externalCallers: false })
    expect(methods.get('navide.browser@1.0.0')).toEqual(['browser.list', 'browser.open'])
    await expect(host.admit({ pluginId: 'navide.browser', toolName: 'browser_list', pluginVersion: '1.0.0', caller: PANE }, notStopping))
      .resolves.toMatchObject({ ok: true, tool: { name: 'browser_list' } })
    expect(hasConsent).not.toHaveBeenCalled()
  })

  it('are served with the DB8 master switch on, without per-version consent', async () => {
    register()
    const activation = await installFromRegistry('navide.browser')
    const catalog = firstPartyAgentToolSpec(activation)
    expect(catalog).not.toBeNull()
    const { host, sent, methods, hasConsent } = agentToolsHost([catalog!], [])
    await host.setSwitches({ enabled: true })
    expect(sent.at(-1)).toMatchObject({ enabled: true, externalCallers: false })
    expect(sent.at(-1)!.tools.map((tool) => [tool.pluginId, tool.name, tool.state])).toEqual([
      ['navide.browser', 'browser_list', 'available'],
      ['navide.browser', 'browser_open', 'available'],
    ])
    expect(methods.get('navide.browser@1.0.0')).toEqual(['browser.list', 'browser.open'])
    await expect(host.admit({ pluginId: 'navide.browser', toolName: 'browser_list', pluginVersion: '1.0.0', caller: PANE }, notStopping))
      .resolves.toMatchObject({ ok: true, tool: { name: 'browser_list' } })
    expect(hasConsent).not.toHaveBeenCalled()
    // External-content wrapping and pane taint of every result happen in the
    // core backend whatever the package (test_plugin_agent_tools_proxy.py,
    // test_a_first_party_browser_tool_is_still_wrapped_as_external_content_and_taints);
    // the catalog entry says what that label shows.
    expect(sent.at(-1)!.tools[0]!.permissions).toEqual({ system: ['ui', 'web'], shell: null, scopes: null })
  })
})

describe('(c) look-alikes do not get first-party treatment', () => {
  it('acme.browser from the Registry goes the third-party path: switch and consent required, no web port', async () => {
    register()
    const activation = await installFromRegistry('acme.browser')
    expect(firstPartyBackendLaunchSpec(activation)).toBeNull()
    expect(firstPartyAgentToolSpec(activation)).toBeNull()
    const spec = thirdPartyBackendLaunchSpec(activation)
    expect(spec).not.toBeNull()
    expect(isThirdPartyLaunchSpec(spec!)).toBe(true)
    expect(spec!.approvedBridgePorts).not.toContain('web')

    const { host, sent } = agentToolsHost([], [spec!])
    await host.refresh()
    expect(sent).toEqual([])
    const acmeCall = { pluginId: 'acme.browser', toolName: 'acme_list', pluginVersion: '1.0.0', caller: PANE }
    await expect(host.admit(acmeCall, notStopping)).resolves.toEqual({ ok: false, reason: 'master-switch-off' })
    await host.setSwitches({ enabled: true })
    await expect(host.admit(acmeCall, notStopping)).resolves.toEqual({ ok: false, reason: 'consent-required' })
  })

  it('acme.browser offered as a first-party agent-tool entry is ignored', async () => {
    register()
    const activation = await installFromRegistry('acme.browser')
    const impostor = { ...thirdPartyBackendLaunchSpec(activation)!, approvedBridgePorts: ['web' as const] }
    const { host, sent } = agentToolsHost([impostor], [])
    await host.refresh()
    expect(sent).toEqual([])
  })

  it('refuses navide.browser from a local file', async () => {
    const picked = join(root, 'picked.vsix')
    writeFileSync(picked, browserPackage('navide.browser').bytes)
    register(OFFICIAL_TRUST, { pickLocalPackageFile: vi.fn(async () => picked) })
    await expect(call('plugins:installFromFile')).rejects.toThrow(/official 'navide\.' namespace/)
    expect(activations.has('navide.browser')).toBe(false)
  })

  it('refuses navide.browser from a Registry the Host did not authorize as the Official Registry', async () => {
    register(SELF_HOSTED_TRUST)
    serveRegistry('navide.browser', browserPackage('navide.browser'))
    await expect(call('plugins:prepareInstall', { namespace: 'navide', name: 'browser' }))
      .rejects.toThrow(/did not authorize the Official Registry/)
    expect(activations.has('navide.browser')).toBe(false)
  })

  it('refuses navide.browser signed for another publisher', async () => {
    register()
    serveRegistry('navide.browser', browserPackage('navide.browser', 'acme'), 'acme')
    await expect(call('plugins:prepareInstall', { namespace: 'navide', name: 'browser' }))
      .rejects.toThrow(/publisher must match id/)
    expect(activations.has('navide.browser')).toBe(false)
  })

  it('never treats a navide.browser activation from neither the Official Registry nor the App bundle as first-party', async () => {
    register()
    const installed = await installFromRegistry('navide.browser')
    const { provenance: _provenance, ...bare } = installed
    for (const activation of [
      bare,
      { ...bare, provenance: 'developer-local-unpacked' as const },
      { ...bare, source: 'local-unsigned' as const },
      { ...bare, provenance: 'factory-bundled' as const, source: 'local-signed' as const },
    ]) {
      expect(firstPartyBackendLaunchSpec(activation)).toBeNull()
      expect(firstPartyAgentToolSpec(activation)).toBeNull()
    }
  })

  it('treats the App-bundled navide.browser as first-party, like a registry install', async () => {
    register()
    const installed = await installFromRegistry('navide.browser')
    const bundled = { ...installed, provenance: 'factory-bundled' as const }
    const spec = firstPartyBackendLaunchSpec(bundled)
    expect(spec).not.toBeNull()
    expect(isThirdPartyLaunchSpec(spec!)).toBe(false)
    expect(spec!.approvedBridgePorts).toEqual(['web'])
    expect(firstPartyAgentToolSpec(bundled)).not.toBeNull()
  })
})

describe('a registry-installed navide.browser keeps the built-in rules, as Git and Mini-IDE do', () => {
  /** The Host's built-in switch (applyBuiltinSwitch in main) over the real manager. */
  const builtinSwitch = {
    setBuiltinDisabled: async (id: string, disabled: boolean) => {
      if (disabled) await manager.suspendBuiltinPlugin(id)
      else manager.resumeBuiltinPlugin(id)
    },
  }

  it('is disabled with the built-in switch: its backend stops and Enable starts it again', async () => {
    register(OFFICIAL_TRUST, builtinSwitch)
    const installed = await installFromRegistry('navide.browser')
    manager.registerBuiltinBackendActivation(firstPartyBackendLaunchSpec(installed)!)
    expect(manager.hasBackendActivation('navide.browser', '1.0.0')).toBe(true)
    expect(manager.canDisablePlugin('navide.browser')).toBe(false)

    await expect(call('plugins:setDisabled', { id: 'navide.browser', disabled: true }))
      .resolves.toEqual({ id: 'navide.browser', disabled: true })
    expect(manager.isBuiltinPluginDisabled('navide.browser')).toBe(true)
    expect(manager.hasBackendActivation('navide.browser', '1.0.0')).toBe(false)
    expect(manager.listDisabledBuiltinPlugins()).toEqual(['navide.browser'])

    await expect(call('plugins:setDisabled', { id: 'navide.browser', disabled: false }))
      .resolves.toEqual({ id: 'navide.browser', disabled: false })
    expect(manager.isBuiltinPluginDisabled('navide.browser')).toBe(false)
    expect(manager.hasBackendActivation('navide.browser', '1.0.0')).toBe(true)
  })

  it('stays disabled across a restart of the App, and its backend waits for Enable', async () => {
    register(OFFICIAL_TRUST, builtinSwitch)
    await installFromRegistry('navide.browser')
    await call('plugins:setDisabled', { id: 'navide.browser', disabled: true })
    const coldStart = new FrontendPluginManager()
    coldStart.setDisabledPluginResolver((id) => new PluginDisabledStore(root).has(id))
    const loaded = coldStart.loadInstalledPlugins(root, {
      provenance: 'official-registry',
      trust: {
        pinnedRootKey: registryRoot.pubPem,
        snapshot: readRegistryTrustSnapshot(root),
        registryAuthority: 'official',
        officialRegistryUrl: OFFICIAL_URL,
        now: FIXED_NOW,
      },
    })
    expect(loaded.errors).toEqual([])
    const activation = loaded.activationCatalog.find((entry) => entry.pluginId === 'navide.browser')
    expect(activation).toBeDefined()
    expect(coldStart.isBuiltinPluginDisabled('navide.browser')).toBe(true)
    // As main's startup loop registers it: kept, not started.
    coldStart.registerBuiltinBackendActivation(firstPartyBackendLaunchSpec(activation!)!)
    expect(coldStart.hasBackendActivation('navide.browser', '1.0.0')).toBe(false)
    await coldStart.closeBackendPlugins()
  })

  it('cannot be removed: its files and browser partition stay', async () => {
    register(OFFICIAL_TRUST, builtinSwitch)
    await installFromRegistry('navide.browser')
    await expect(call('plugins:remove', { id: 'navide.browser' })).rejects.toThrow(/cannot be removed/)
    expect(web.cleared).toEqual([])
    expect(manager.listInstalledPackages().some((pkg) => pkg.id === 'navide.browser')).toBe(true)
  })
})

describe('reserved navide.* rules stay as on main for everything else', () => {
  it('the bundled Plans, Git and Mini-IDE still cannot be removed or switched by the installed-package rule', async () => {
    register()
    for (const id of ['navide.plans', 'navide.git', 'navide.mini-ide']) {
      await expect(call('plugins:remove', { id })).rejects.toThrow(/cannot be removed/)
      expect(manager.canDisablePlugin(id)).toBe(false)
    }
  })

  it('a registry-installed reserved package that is not on the first-party list can be neither removed nor disabled', async () => {
    register()
    await installFromRegistry('navide.spoof')
    await expect(call('plugins:remove', { id: 'navide.spoof' })).rejects.toThrow(/cannot be removed/)
    await expect(call('plugins:setDisabled', { id: 'navide.spoof', disabled: true })).rejects.toThrow(/cannot be disabled/)
    expect(manager.canDisablePlugin('navide.spoof')).toBe(false)
  })

  it('a registry-installed navide.plans keeps its rules: not removable, not an installed-package switch', async () => {
    register()
    // `plans_` is a reserved agent-tool prefix: this package declares none.
    await installFromRegistry('navide.plans', browserPackage('navide.plans', 'navide', false))
    await expect(call('plugins:remove', { id: 'navide.plans' })).rejects.toThrow(/cannot be removed/)
    expect(manager.canDisablePlugin('navide.plans')).toBe(false)
  })
})
