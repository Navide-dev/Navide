import { generateKeyPairSync, sign } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
  assertRegistryTrustSnapshotDoesNotRollback,
  discoverInstalledRegistryPackageIds,
  readRegistryTrustSnapshot,
  registryReceiptFromEvidence,
  verifyInstalledPackage,
  verifyInstalledRegistryPackage,
  type InstalledRegistryTrustContext,
} from './pluginInstalledTrust'
import { createLocalTrustRecord, writeLocalTrustRecord } from './pluginLocalTrust'
import {
  canonicalTrustJson,
  type RegistryPackageEnvelope,
  type RegistryTrustMetadata,
} from './pluginRegistryTrust'
import { sha256Hex } from './pluginVerify'
import { makeZip } from './zipFixture'

// readdir order is filesystem- and runtime-dependent. Pin a deliberately
// reversed order for one directory so the verifier's own ordering is observed.
const readdirOrder = vi.hoisted(() => ({ reverseFor: undefined as string | undefined }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: ((path: Parameters<typeof actual.readdirSync>[0], ...rest: unknown[]) => {
      const entries = (actual.readdirSync as (...args: unknown[]) => unknown[])(path, ...rest)
      if (path !== readdirOrder.reverseFor) return entries
      const name = (entry: unknown): string =>
        typeof entry === 'string' ? entry : (entry as { name: string }).name
      return [...entries].sort((a, b) => (name(a) < name(b) ? -1 : 1)).reverse()
    }) as typeof actual.readdirSync,
  }
})

const rootKey = generateKeyPairSync('ed25519')
const signerKey = generateKeyPairSync('ed25519')
const rootPem = rootKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const signerPem = signerKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const now = new Date('2026-08-16T12:00:00.000Z')

function signed(value: unknown, privateKey = signerKey.privateKey): string {
  return sign(null, Buffer.from(canonicalTrustJson(value)), privateKey).toString('base64')
}

describe('verifyInstalledRegistryPackage', () => {
  let root: string
  let pluginDir: string
  let archive: Uint8Array
  let envelope: RegistryPackageEnvelope
  let metadata: RegistryTrustMetadata

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-installed-trust-'))
    pluginDir = join(root, 'acme.demo')
    mkdirSync(join(pluginDir, 'frontend'), { recursive: true })
    const manifest = JSON.stringify({
      schemaVersion: 2,
      apiVersion: '^1.0.0',
      id: 'acme.demo',
      name: 'Demo',
      version: '1.0.0',
      publisher: 'acme',
      permissions: {},
      marketplace: { description: 'Demo', license: 'MIT' },
      contributes: {
        views: [
          {
            id: 'main',
            kind: 'custom',
            location: 'main',
            title: 'Demo',
            entry: 'frontend/index.html',
          },
        ],
      },
    })
    archive = new Uint8Array(
      makeZip([
        { name: 'manifest.json', data: manifest },
        { name: 'frontend/index.html', data: '<!doctype html>' },
      ])
    )
    envelope = {
      schemaVersion: 1,
      artifactDigest: sha256Hex(archive),
      packageId: 'acme.demo',
      version: '1.0.0',
      target: 'universal',
      publisherId: 'acme',
      keyId: 'registry-test',
      signedAt: '2026-08-16T11:00:00.000Z',
    }
    metadata = {
      schemaVersion: 1,
      registryProfile: 'official',
      rootFingerprint: `sha256:${'1'.repeat(64)}`,
      generatedAt: '2026-08-16T10:00:00.000Z',
      expiresAt: '2026-08-17T10:00:00.000Z',
      signers: [
        {
          keyId: 'registry-test',
          publicKey: signerPem,
          status: 'active',
          notBefore: '2026-08-01T00:00:00.000Z',
          notAfter: '2026-09-01T00:00:00.000Z',
        },
      ],
      blockedPublishers: [],
      blockedPackages: [],
    }
    writeFileSync(join(pluginDir, 'manifest.json'), manifest)
    writeFileSync(join(pluginDir, 'frontend', 'index.html'), '<!doctype html>')
    writeFileSync(join(pluginDir, REGISTRY_ARTIFACT_NAME), archive)
    writeFileSync(
      join(pluginDir, REGISTRY_RECEIPT_NAME),
      JSON.stringify(
        registryReceiptFromEvidence({
          packageId: 'acme.demo',
          version: '1.0.0',
          publisherId: 'acme',
          target: 'universal',
          artifactDigest: sha256Hex(archive),
          envelope,
          envelopeSignature: signed(envelope),
        })
      )
    )
  })

  afterEach(() => {
    readdirOrder.reverseFor = undefined
    rmSync(root, { recursive: true, force: true })
  })

  function context(current = metadata): InstalledRegistryTrustContext {
    return {
      pinnedRootKey: rootPem,
      snapshot: {
        schemaVersion: 1,
        metadata: current,
        metadataSignature: signed(current, rootKey.privateKey),
      },
      now,
    }
  }

  it('allows activation only after archive, envelope, identity, and extracted content verify', () => {
    expect(verifyInstalledRegistryPackage(pluginDir, 'acme.demo', context())).toEqual({
      action: 'allow',
      artifactDigest: sha256Hex(archive),
      target: 'universal',
    })
  })

  it('revalidates a retained Registry v1 package after restart', () => {
    const legacyDir = join(root, 'acme.legacy')
    mkdirSync(legacyDir, { recursive: true })
    const legacyManifest = JSON.stringify({
      id: 'acme.legacy',
      version: '1.0.0',
      publisher: 'acme',
      requires: ['git'],
      entry: 'index.html',
    })
    const legacyArchive = new Uint8Array(
      makeZip([
        { name: 'manifest.json', data: legacyManifest },
        { name: 'index.html', data: '<!doctype html>' },
      ])
    )
    const legacyEnvelope: RegistryPackageEnvelope = {
      ...envelope,
      packageId: 'acme.legacy',
      publisherId: 'acme',
      artifactDigest: sha256Hex(legacyArchive),
    }
    writeFileSync(join(legacyDir, 'manifest.json'), legacyManifest)
    writeFileSync(join(legacyDir, 'index.html'), '<!doctype html>')
    writeFileSync(join(legacyDir, REGISTRY_ARTIFACT_NAME), legacyArchive)
    writeFileSync(
      join(legacyDir, REGISTRY_RECEIPT_NAME),
      JSON.stringify(
        registryReceiptFromEvidence({
          packageId: 'acme.legacy',
          version: '1.0.0',
          publisherId: 'acme',
          target: 'universal',
          artifactDigest: sha256Hex(legacyArchive),
          envelope: legacyEnvelope,
          envelopeSignature: signed(legacyEnvelope),
        })
      )
    )

    expect(verifyInstalledRegistryPackage(legacyDir, 'acme.legacy', context())).toMatchObject({
      action: 'allow',
    })
    writeFileSync(join(legacyDir, REGISTRY_ARTIFACT_NAME), Buffer.from('tampered artifact'))
    expect(verifyInstalledRegistryPackage(legacyDir, 'acme.legacy', context()).action).toBe('quarantine')
    writeFileSync(join(legacyDir, REGISTRY_ARTIFACT_NAME), legacyArchive)
    writeFileSync(join(legacyDir, 'manifest.json'), legacyManifest.replace('acme.legacy', 'acme.other'))
    expect(verifyInstalledRegistryPackage(legacyDir, 'acme.legacy', context()).action).toBe('quarantine')
    writeFileSync(join(legacyDir, 'manifest.json'), legacyManifest)
    expect(
      verifyInstalledRegistryPackage(
        legacyDir,
        'acme.legacy',
        context({ ...metadata, blockedPublishers: ['acme'] })
      ).action
    ).toBe('quarantine')
  })

  it('quarantines an installed package whose extracted content changed', () => {
    writeFileSync(join(pluginDir, 'frontend', 'index.html'), 'tampered')
    expect(verifyInstalledRegistryPackage(pluginDir, 'acme.demo', context())).toMatchObject({
      action: 'quarantine',
      reason: expect.stringMatching(/modified/),
    })
  })

  it('names the first invalid entry by name regardless of readdir order', () => {
    symlinkSync('manifest.json', join(pluginDir, 'z-link'))
    symlinkSync('manifest.json', join(pluginDir, 'a-link'))
    readdirOrder.reverseFor = pluginDir
    expect(verifyInstalledRegistryPackage(pluginDir, 'acme.demo', context())).toEqual({
      action: 'quarantine',
      reason: 'installed package contains symlink: a-link',
    })
  })

  it('uses current root-signed blocklist metadata instead of install-time trust', () => {
    const blocked = { ...metadata, blockedPublishers: ['acme'] }
    expect(verifyInstalledRegistryPackage(pluginDir, 'acme.demo', context(blocked))).toMatchObject({
      action: 'quarantine',
      reason: expect.stringMatching(/blocked/),
    })
  })

  it('fails closed when current trust metadata is unavailable', () => {
    expect(
      verifyInstalledRegistryPackage(pluginDir, 'acme.demo', {
        pinnedRootKey: rootPem,
        snapshot: null,
        now,
      })
    ).toMatchObject({ action: 'quarantine', reason: expect.stringMatching(/unavailable/) })
  })

  it('quarantines a self-hosted receipt under an Official Registry Host config', () => {
    expect(
      verifyInstalledRegistryPackage(
        pluginDir,
        'acme.demo',
        {
          ...context(),
          registryAuthority: 'official',
          officialRegistryUrl: 'https://server.navide.dev/registry',
        }
      )
    ).toMatchObject({
      action: 'quarantine',
      reason: expect.stringMatching(/authority/),
    })
  })

  it('quarantines a receipt with duplicate package identity keys', () => {
    const receiptPath = join(pluginDir, REGISTRY_RECEIPT_NAME)
    const receipt = readFileSync(receiptPath, 'utf8')
    writeFileSync(receiptPath, receipt.replace('"packageId":"acme.demo"', '"packageId":"acme.demo","packageId":"acme.demo"'))

    expect(verifyInstalledRegistryPackage(pluginDir, 'acme.demo', context())).toMatchObject({
      action: 'quarantine',
      reason: expect.stringMatching(/malformed|duplicate JSON object key/),
    })
  })

  it('rejects a retained snapshot with duplicate generatedAt keys', () => {
    const snapshot = context().snapshot
    if (!snapshot) throw new Error('test snapshot missing')
    const metadata = JSON.stringify(snapshot.metadata)
    const duplicateMetadata = metadata.replace(
      '"generatedAt":"2026-08-16T10:00:00.000Z"',
      '"generatedAt":"2026-08-16T10:00:00.000Z","generatedAt":"2026-08-16T10:00:00.000Z"'
    )
    writeFileSync(
      join(root, REGISTRY_TRUST_SNAPSHOT_NAME),
      `{"schemaVersion":1,"metadata":${duplicateMetadata},"metadataSignature":${JSON.stringify(snapshot.metadataSignature)}}`
    )

    expect(readRegistryTrustSnapshot(root)).toBeNull()
  })

  it('treats a malformed retained snapshot as repairable during anti-rollback checks', () => {
    const snapshot = context().snapshot
    if (!snapshot) throw new Error('test snapshot missing')
    const metadata = JSON.stringify(snapshot.metadata).replace(
      '"generatedAt":"2026-08-16T10:00:00.000Z"',
      '"generatedAt":"2026-08-16T10:00:00.000Z","generatedAt":"2026-08-16T10:00:00.000Z"'
    )
    const next = {
      ...snapshot,
      metadata: { ...snapshot.metadata, generatedAt: '2026-08-16T11:00:00.000Z' },
    }
    expect(() =>
      assertRegistryTrustSnapshotDoesNotRollback(
        new TextEncoder().encode(
          `{"schemaVersion":1,"metadata":${metadata},"metadataSignature":${JSON.stringify(snapshot.metadataSignature)}}`
        ),
        next
      )
    ).not.toThrow()
  })

  it('discovers a package only when its directory, manifest, and retained artifact agree', () => {
    expect(discoverInstalledRegistryPackageIds(root)).toEqual(['acme.demo'])
  })

  it('discovers retained immutable target-specific package directories', () => {
    const canonical = join(root, 'acme.demo', '1.0.0', 'universal', 'package')
    const temporary = join(root, 'candidate-package')
    renameSync(pluginDir, temporary)
    mkdirSync(join(root, 'acme.demo', '1.0.0', 'universal'), { recursive: true })
    renameSync(temporary, canonical)
    expect(discoverInstalledRegistryPackageIds(root)).toEqual(['acme.demo'])
  })

  it('does not discover a package with a malformed installed manifest', () => {
    writeFileSync(join(pluginDir, 'manifest.json'), '{not-json')
    expect(discoverInstalledRegistryPackageIds(root)).toEqual([])
  })

  it('does not discover a package whose installed manifest identity differs from its directory', () => {
    const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8')) as {
      id: string
    }
    manifest.id = 'other.package'
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifest))
    expect(discoverInstalledRegistryPackageIds(root)).toEqual([])
  })

  it('does not discover a package after its directory is missing', () => {
    rmSync(pluginDir, { recursive: true, force: true })
    expect(discoverInstalledRegistryPackageIds(root)).toEqual([])
  })

  describe('with a local install beside the Marketplace install', () => {
    let localDir: string
    let recordPath: string

    beforeEach(() => {
      localDir = join(root, 'acme.local')
      recordPath = join(root, 'local-trust-records', 'acme.local.json')
      mkdirSync(join(localDir, 'frontend'), { recursive: true })
      writeFileSync(
        join(localDir, 'manifest.json'),
        readFileSync(join(pluginDir, 'manifest.json'), 'utf8').replace('"acme.demo"', '"acme.local"')
      )
      writeFileSync(join(localDir, 'frontend', 'index.html'), '<!doctype html>')
      writeLocalTrustRecord(
        recordPath,
        createLocalTrustRecord(localDir, { source: 'file', consentedAt: '2026-08-16T11:30:00.000Z' })
      )
    })

    const local = (trust: InstalledRegistryTrustContext) =>
      ({ source: 'local-unsigned', recordPath, trust }) as const

    it('gives a Marketplace package exactly the decision main gives it', () => {
      const officialAuthority: InstalledRegistryTrustContext = {
        ...context(),
        registryAuthority: 'official',
        officialRegistryUrl: 'https://server.navide.dev/registry',
      }
      const contexts: InstalledRegistryTrustContext[] = [
        context(),
        context({ ...metadata, blockedPublishers: ['acme'] }),
        officialAuthority,
        { pinnedRootKey: rootPem, snapshot: null, now },
      ]
      for (const trust of contexts) {
        expect(
          verifyInstalledPackage(pluginDir, 'acme.demo', { provenance: 'official-registry', trust })
        ).toEqual(verifyInstalledRegistryPackage(pluginDir, 'acme.demo', trust))
      }
      expect(
        verifyInstalledPackage(pluginDir, 'acme.demo', { provenance: 'official-registry', trust: context() })
      ).toEqual({ action: 'allow', artifactDigest: sha256Hex(archive), target: 'universal' })
      expect(
        verifyInstalledPackage(pluginDir, 'acme.demo', {
          provenance: 'official-registry',
          trust: officialAuthority,
        })
      ).toEqual({
        action: 'quarantine',
        reason: 'Registry authority does not match the current Host configuration',
      })
    })

    it('loads both side by side without quarantining either', () => {
      expect(
        verifyInstalledPackage(pluginDir, 'acme.demo', { provenance: 'official-registry', trust: context() })
      ).toMatchObject({ action: 'allow' })
      expect(verifyInstalledPackage(localDir, 'acme.local', local(context()))).toMatchObject({
        action: 'allow',
        source: 'local-unsigned',
      })
    })

    it('does not apply the Registry authority rule to a local install', () => {
      expect(
        verifyInstalledPackage(localDir, 'acme.local', local({
          ...context(),
          registryAuthority: 'official',
          officialRegistryUrl: 'https://server.navide.dev/registry',
        }))
      ).toMatchObject({ action: 'allow', blocklistChecked: true })
    })

    it('applies the Registry takedown list to a local install', () => {
      expect(
        verifyInstalledPackage(localDir, 'acme.local', local(context({ ...metadata, blockedPublishers: ['acme'] })))
      ).toMatchObject({ action: 'blocked', code: 'LOCAL_PUBLISHER_BLOCKED' })
    })

    it('is never loaded or discovered by the Registry path an older App runs', () => {
      expect(verifyInstalledRegistryPackage(localDir, 'acme.local', context())).toMatchObject({
        action: 'quarantine',
      })
      expect(discoverInstalledRegistryPackageIds(root)).toEqual(['acme.demo'])
    })
  })

  it('keeps the legacy provenance value in every Registry receipt, which older Apps require', () => {
    expect(
      registryReceiptFromEvidence({
        packageId: 'acme.demo',
        version: '1.0.0',
        publisherId: 'acme',
        target: 'universal',
        artifactDigest: sha256Hex(archive),
        envelope,
        envelopeSignature: signed(envelope),
      }).provenance
    ).toBe('official-registry')
    // The receipt parser is exact: a new source value written here would
    // quarantine the package in every App that reads it.
    const receiptPath = join(pluginDir, REGISTRY_RECEIPT_NAME)
    writeFileSync(
      receiptPath,
      readFileSync(receiptPath, 'utf8').replace('"provenance":"official-registry"', '"provenance":"marketplace"')
    )
    expect(verifyInstalledRegistryPackage(pluginDir, 'acme.demo', context())).toEqual({
      action: 'quarantine',
      reason: `malformed ${REGISTRY_RECEIPT_NAME}`,
    })
  })
})
