// "Newer wins" between an installed Official Registry copy of a first-party
// plugin and the copy the App bundles: the installed copy is superseded only
// when it is older by semver; a tie or a newer installed copy still wins.

import { describe, it, expect, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PLUGIN_API_VERSION } from '../../../packages/plugin-contracts/src/apiVersion'
import { FrontendPluginManager } from './frontendPluginManager'
import { PluginActivationSelector } from './pluginActivationSelector'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  registryReceiptFromEvidence,
  type InstalledRegistryTrustContext,
} from './pluginInstalledTrust'
import {
  canonicalTrustJson,
  type RegistryPackageEnvelope,
  type RegistryTrustMetadata,
} from './pluginRegistryTrust'
import { sha256Hex } from './pluginVerify'
import { makeZip } from './zipFixture'

const PLUGIN_ID = 'navide.git'
const TARGET = 'universal'
const NOW = new Date('2026-08-16T12:00:00.000Z')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'navide-bundled-precedence-'))
  roots.push(root)
  return root
}

function manifestFor(pluginId: string, version: string, apiVersion = '^1.0.0'): string {
  return JSON.stringify({
    schemaVersion: 2,
    apiVersion,
    id: pluginId,
    name: 'Precedence',
    version,
    publisher: pluginId.split('.')[0],
    permissions: {},
    marketplace: { description: 'Precedence test plugin', license: 'MIT' },
    contributes: {
      views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Precedence', entry: 'frontend/index.html' }],
    },
  })
}

/** An installed, Registry-verified package selected by the durable lifecycle
 *  record, with an Official Registry trust context (reserved ids need it). */
function installRegistryPackage(root: string, pluginId: string, version: string, apiVersion?: string): InstalledRegistryTrustContext {
  const packageDir = join(root, pluginId, version, TARGET, 'package')
  mkdirSync(join(packageDir, 'frontend'), { recursive: true })
  const manifest = manifestFor(pluginId, version, apiVersion)
  const archive = new Uint8Array(makeZip([
    { name: 'manifest.json', data: manifest },
    { name: 'frontend/index.html', data: '<!doctype html>' },
  ]))
  writeFileSync(join(packageDir, 'manifest.json'), manifest)
  writeFileSync(join(packageDir, 'frontend', 'index.html'), '<!doctype html>')
  writeFileSync(join(packageDir, REGISTRY_ARTIFACT_NAME), archive)

  const rootKey = generateKeyPairSync('ed25519')
  const signerKey = generateKeyPairSync('ed25519')
  const rootPem = rootKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const signerPem = signerKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const signed = (value: unknown, key = signerKey.privateKey): string =>
    edSign(null, Buffer.from(canonicalTrustJson(value)), key).toString('base64')
  const artifactDigest = sha256Hex(archive)
  const publisherId = pluginId.split('.')[0]
  const envelope: RegistryPackageEnvelope = {
    schemaVersion: 1,
    artifactDigest,
    packageId: pluginId,
    version,
    target: TARGET,
    publisherId,
    keyId: 'precedence-test',
    signedAt: '2026-08-16T11:00:00.000Z',
  }
  const metadata: RegistryTrustMetadata = {
    schemaVersion: 1,
    registryProfile: 'official',
    rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z',
    expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [{
      keyId: 'precedence-test',
      publicKey: signerPem,
      status: 'active',
      notBefore: '2026-08-01T00:00:00.000Z',
      notAfter: '2026-09-01T00:00:00.000Z',
    }],
    blockedPublishers: [],
    blockedPackages: [],
  }
  writeFileSync(
    join(packageDir, REGISTRY_RECEIPT_NAME),
    JSON.stringify(registryReceiptFromEvidence({
      packageId: pluginId,
      version,
      publisherId,
      target: TARGET,
      artifactDigest,
      envelope,
      envelopeSignature: signed(envelope),
      registryAuthority: 'official',
    })),
  )
  const selector = new PluginActivationSelector(root)
  selector.stageCandidate(pluginId, { packageVersion: version, target: TARGET, artifactDigest })
  selector.activateCandidate(pluginId)
  return {
    pinnedRootKey: rootPem,
    snapshot: { schemaVersion: 1, metadata, metadataSignature: signed(metadata, rootKey.privateKey) },
    expectedTarget: TARGET,
    now: NOW,
    registryAuthority: 'official',
    officialRegistryUrl: 'https://server.navide.dev/registry',
  }
}

/** An App-bundled factory package directory (no Registry evidence). */
function writeFactoryPackage(root: string, pluginId: string, version: string): string {
  const dir = join(root, 'factory', pluginId)
  mkdirSync(join(dir, 'frontend'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), manifestFor(pluginId, version))
  writeFileSync(join(dir, 'frontend', 'index.html'), '<!doctype html>')
  return dir
}

function storageSelections(mgr: FrontendPluginManager): Map<string, { activeVersion: string }> {
  return (mgr as unknown as {
    pluginStorageSnapshotSelections: Map<string, { activeVersion: string }>
  }).pluginStorageSnapshotSelections
}

describe('installed Registry copy vs App-bundled copy of a first-party plugin', () => {
  it('supersedes an older installed copy so the bundled copy loads', () => {
    const plugins = tempRoot()
    const factoryRoot = tempRoot()
    const trust = installRegistryPackage(plugins, PLUGIN_ID, '0.2.32')
    const mgr = new FrontendPluginManager()
    mgr.setBundledPluginVersions({ [PLUGIN_ID]: '1.0.0' })

    const result = mgr.loadInstalledPlugins(plugins, { provenance: 'official-registry', trust })

    expect(result.errors).toEqual([])
    expect(result.loaded).toEqual([])
    expect(result.activationCatalog.some((entry) => entry.pluginId === PLUGIN_ID)).toBe(false)
    expect(mgr.getDescriptor(PLUGIN_ID)).toBeUndefined()
    expect(mgr.supersededInstalledPackageVersion(PLUGIN_ID)).toBe('0.2.32')

    const factory = mgr.loadFactoryPlugin(writeFactoryPackage(factoryRoot, PLUGIN_ID, '1.0.0'), PLUGIN_ID)
    expect(factory).toMatchObject({ loaded: true, pluginId: PLUGIN_ID, packageVersion: '1.0.0' })
    expect(mgr.getDescriptor(PLUGIN_ID)?.packageVersion).toBe('1.0.0')
  })

  it.each([
    ['newer', '1.1.0'],
    ['equal (a tie)', '1.0.0'],
  ])('keeps an installed copy that is %s', (_label, installedVersion) => {
    const plugins = tempRoot()
    const factoryRoot = tempRoot()
    const trust = installRegistryPackage(plugins, PLUGIN_ID, installedVersion)
    const mgr = new FrontendPluginManager()
    mgr.setBundledPluginVersions({ [PLUGIN_ID]: '1.0.0' })

    const result = mgr.loadInstalledPlugins(plugins, { provenance: 'official-registry', trust })

    expect(result.errors).toEqual([])
    expect(result.loaded).toEqual([PLUGIN_ID])
    expect(result.activationCatalog.some((entry) => entry.pluginId === PLUGIN_ID)).toBe(true)
    expect(mgr.supersededInstalledPackageVersion(PLUGIN_ID)).toBeUndefined()
    expect(mgr.loadFactoryPlugin(writeFactoryPackage(factoryRoot, PLUGIN_ID, '1.0.0'), PLUGIN_ID)).toEqual({
      loaded: false,
      reason: 'installed package is active',
    })
    expect(mgr.getDescriptor(PLUGIN_ID)?.packageVersion).toBe(installedVersion)
  })

  it('keeps the installed copy when no bundled version is set', () => {
    const plugins = tempRoot()
    const trust = installRegistryPackage(plugins, PLUGIN_ID, '0.2.32')
    const mgr = new FrontendPluginManager()

    const result = mgr.loadInstalledPlugins(plugins, { provenance: 'official-registry', trust })

    expect(result.loaded).toEqual([PLUGIN_ID])
    expect(mgr.supersededInstalledPackageVersion(PLUGIN_ID)).toBeUndefined()
    expect(mgr.getDescriptor(PLUGIN_ID)?.packageVersion).toBe('0.2.32')
  })

  it('does not project the superseded storage selection, but still projects other ids', () => {
    const plugins = tempRoot()
    const trust = installRegistryPackage(plugins, PLUGIN_ID, '0.2.32')
    const other = new PluginActivationSelector(plugins)
    other.stageCandidate('acme.storage', { packageVersion: '2.0.0', target: TARGET, artifactDigest: '22'.repeat(32) })
    other.activateCandidate('acme.storage')
    const mgr = new FrontendPluginManager()
    mgr.setBundledPluginVersions({ [PLUGIN_ID]: '1.0.0' })
    mgr.loadInstalledPlugins(plugins, { provenance: 'official-registry', trust }, new Set([PLUGIN_ID]))

    mgr.projectPluginStorageSnapshotSelections(plugins)

    expect(storageSelections(mgr).has(PLUGIN_ID)).toBe(false)
    expect(storageSelections(mgr).get('acme.storage')).toEqual({ activeVersion: '2.0.0' })
    // The durable record is untouched: superseding is decided every load.
    expect(new PluginActivationSelector(plugins).read(PLUGIN_ID)?.active?.packageVersion).toBe('0.2.32')
  })

  it('leaves the bundled copy in place when the superseded copy later fails trust', () => {
    const plugins = tempRoot()
    const factoryRoot = tempRoot()
    const trust = installRegistryPackage(plugins, PLUGIN_ID, '0.2.32')
    const mgr = new FrontendPluginManager()
    mgr.setBundledPluginVersions({ [PLUGIN_ID]: '1.0.0' })
    mgr.loadInstalledPlugins(plugins, { provenance: 'official-registry', trust })
    expect(mgr.loadFactoryPlugin(writeFactoryPackage(factoryRoot, PLUGIN_ID, '1.0.0'), PLUGIN_ID).loaded).toBe(true)
    writeFileSync(
      join(plugins, PLUGIN_ID, '0.2.32', TARGET, 'package', REGISTRY_ARTIFACT_NAME),
      'tampered retained artifact',
    )

    const decisions = mgr.refreshInstalledPluginTrust(plugins, trust)

    expect(decisions.filter((decision) => decision.pluginId === PLUGIN_ID)).toEqual([])
    expect(mgr.getDescriptor(PLUGIN_ID)?.packageVersion).toBe('1.0.0')
    expect(mgr.listInstalledPackages()).toMatchObject([{ id: PLUGIN_ID, provenance: 'factory-bundled' }])
  })
})

describe('installed Registry package on a newer plugin API major', () => {
  it('stays in the inventory with the reason and contributes nothing', () => {
    const plugins = tempRoot()
    const trust = installRegistryPackage(plugins, 'acme.future', '2.0.0', '^2.0.0')
    const mgr = new FrontendPluginManager()

    const result = mgr.loadInstalledPlugins(plugins, { provenance: 'official-registry', trust })

    expect(result.loaded).toEqual([])
    expect(result.activationCatalog).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('requires plugin API ^2.0.0')])
    expect(mgr.getDescriptor('acme.future')).toBeUndefined()
    expect(mgr.listInstalledPackages()).toMatchObject([{
      id: 'acme.future',
      warning: `acme.future 2.0.0 requires plugin API ^2.0.0; this Navide provides ${PLUGIN_API_VERSION}`,
    }])
  })

  it('leaves a first-party id to its bundled copy', () => {
    const plugins = tempRoot()
    const factoryRoot = tempRoot()
    const trust = installRegistryPackage(plugins, PLUGIN_ID, '2.0.0', '^2.0.0')
    const mgr = new FrontendPluginManager()
    mgr.setBundledPluginVersions({ [PLUGIN_ID]: '1.0.0' })

    const result = mgr.loadInstalledPlugins(plugins, { provenance: 'official-registry', trust })

    expect(result.loaded).toEqual([])
    expect(mgr.supersededInstalledPackageVersion(PLUGIN_ID)).toBe('2.0.0')
    expect(mgr.loadFactoryPlugin(writeFactoryPackage(factoryRoot, PLUGIN_ID, '1.0.0'), PLUGIN_ID))
      .toMatchObject({ loaded: true, packageVersion: '1.0.0' })
  })

  it.each(['^1.0.0', '~1.0.0', '1.0.0', '^1.9.0', '^0.1.0'])('changes nothing for %s', (apiVersion) => {
    const plugins = tempRoot()
    const trust = installRegistryPackage(plugins, 'acme.today', '1.0.0', apiVersion)
    const mgr = new FrontendPluginManager()

    const result = mgr.loadInstalledPlugins(plugins, { provenance: 'official-registry', trust })

    expect(result).toMatchObject({ loaded: ['acme.today'], errors: [] })
    expect(result.activationCatalog.some((entry) => entry.pluginId === 'acme.today')).toBe(true)
    expect(mgr.getDescriptor('acme.today')?.packageVersion).toBe('1.0.0')
    expect(mgr.listInstalledPackages()[0].warning).toBeUndefined()
  })
})
