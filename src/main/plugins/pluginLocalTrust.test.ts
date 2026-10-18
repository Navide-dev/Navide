import { generateKeyPairSync, sign } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLocalTrustRecord,
  readLocalTrustRecord,
  verifyLocalPackage,
  writeLocalTrustRecord,
  type PluginLocalTrustContext,
} from './pluginLocalTrust'
import { canonicalTrustJson, type RegistryTrustMetadata } from './pluginRegistryTrust'

const rootKey = generateKeyPairSync('ed25519')
const otherRootKey = generateKeyPairSync('ed25519')
const rootPem = rootKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const now = new Date('2026-08-16T12:00:00.000Z')

function manifestFor(id: string, publisher: string): string {
  return JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id,
    name: 'Local',
    version: '1.0.0',
    publisher,
    permissions: {},
    marketplace: { description: 'Local', license: 'MIT' },
    contributes: {
      views: [
        { id: 'main', kind: 'custom', location: 'main', title: 'Local', entry: 'frontend/index.html' },
      ],
    },
  })
}

describe('local trust record', () => {
  let root: string
  let packageDir: string
  let recordPath: string
  let metadata: RegistryTrustMetadata

  function writePackage(dir: string, id: string, publisher: string): void {
    mkdirSync(join(dir, 'frontend'), { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), manifestFor(id, publisher))
    writeFileSync(join(dir, 'frontend', 'index.html'), '<!doctype html>')
  }

  function consent(dir = packageDir, path = recordPath): void {
    writeLocalTrustRecord(
      path,
      createLocalTrustRecord(dir, { source: 'file', consentedAt: '2026-08-16T11:30:00.000Z' })
    )
  }

  function context(current: RegistryTrustMetadata | null = metadata, key = rootKey.privateKey): PluginLocalTrustContext {
    return {
      pinnedRootKey: rootPem,
      snapshot: current
        ? {
            schemaVersion: 1,
            metadata: current,
            metadataSignature: sign(null, Buffer.from(canonicalTrustJson(current)), key).toString('base64'),
          }
        : null,
      now,
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-local-trust-'))
    packageDir = join(root, 'acme.local')
    recordPath = join(root, 'records', 'acme.local.json')
    writePackage(packageDir, 'acme.local', 'acme')
    metadata = {
      schemaVersion: 1,
      registryProfile: 'official',
      rootFingerprint: `sha256:${'1'.repeat(64)}`,
      generatedAt: '2026-08-16T10:00:00.000Z',
      expiresAt: '2026-08-17T10:00:00.000Z',
      signers: [],
      blockedPublishers: [],
      blockedPackages: [],
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('records every installed file and the consent time, owner-only', () => {
    consent()
    const record = readLocalTrustRecord(recordPath)
    expect(record).toMatchObject({
      schemaVersion: 1,
      id: 'acme.local',
      version: '1.0.0',
      consentedAt: '2026-08-16T11:30:00.000Z',
      source: 'file',
      signer: null,
    })
    expect(Object.keys(record.fileDigests)).toEqual(['frontend/index.html', 'manifest.json'])
    expect(record.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== 'win32') expect(statSync(recordPath).mode & 0o777).toBe(0o600)
  })

  it('allows the consented content and reports that the takedown list was checked', () => {
    consent()
    expect(verifyLocalPackage(packageDir, 'acme.local', recordPath, context())).toEqual({
      action: 'allow',
      source: 'local-unsigned',
      contentDigest: readLocalTrustRecord(recordPath).contentDigest,
      blocklistChecked: true,
    })
  })

  it('refuses a package where one byte of one file changed after consent', () => {
    consent()
    writeFileSync(join(packageDir, 'frontend', 'index.html'), '<!doctype htmL>')
    expect(verifyLocalPackage(packageDir, 'acme.local', recordPath, context())).toMatchObject({
      action: 'quarantine',
      code: 'LOCAL_CONTENT_MODIFIED',
    })
  })

  it('refuses an added file, a removed file, and a symlink as modified content', () => {
    consent()
    writeFileSync(join(packageDir, 'frontend', 'extra.js'), 'run()')
    expect(verifyLocalPackage(packageDir, 'acme.local', recordPath, context())).toMatchObject({
      code: 'LOCAL_CONTENT_MODIFIED',
    })
    unlinkSync(join(packageDir, 'frontend', 'extra.js'))
    unlinkSync(join(packageDir, 'frontend', 'index.html'))
    expect(verifyLocalPackage(packageDir, 'acme.local', recordPath, context())).toMatchObject({
      code: 'LOCAL_CONTENT_MODIFIED',
    })
    symlinkSync(join(packageDir, 'manifest.json'), join(packageDir, 'frontend', 'index.html'))
    expect(verifyLocalPackage(packageDir, 'acme.local', recordPath, context())).toMatchObject({
      code: 'LOCAL_CONTENT_MODIFIED',
    })
  })

  it('verifies the installed copy, not the folder the user picked', () => {
    const picked = join(root, 'picked')
    writePackage(picked, 'acme.local', 'acme')
    consent()
    writeFileSync(join(picked, 'frontend', 'index.html'), 'changed at the source')
    expect(verifyLocalPackage(packageDir, 'acme.local', recordPath, context())).toMatchObject({ action: 'allow' })
  })

  it('refuses the reserved navide. namespace even with a record on disk', () => {
    const officialDir = join(root, 'navide.foo')
    const officialRecord = join(root, 'records', 'navide.foo.json')
    writePackage(officialDir, 'acme.local', 'acme')
    consent(officialDir, officialRecord)
    writeFileSync(join(officialDir, 'manifest.json'), manifestFor('navide.foo', 'navide'))
    expect(verifyLocalPackage(officialDir, 'navide.foo', officialRecord, context())).toMatchObject({
      action: 'quarantine',
      code: 'LOCAL_RESERVED_ID',
    })
  })

  it('refuses to create a record for the reserved navide. namespace', () => {
    const officialDir = join(root, 'navide.foo')
    writePackage(officialDir, 'navide.foo', 'navide')
    expect(() =>
      createLocalTrustRecord(officialDir, { source: 'file', consentedAt: '2026-08-16T11:30:00.000Z' })
    ).toThrow(/navide\./)
  })

  it('disables a package whose manifest publisher Navide has taken down', () => {
    consent()
    const decision = verifyLocalPackage(
      packageDir,
      'acme.local',
      recordPath,
      context({ ...metadata, blockedPublishers: ['acme'] })
    )
    expect(decision).toMatchObject({ action: 'blocked', code: 'LOCAL_PUBLISHER_BLOCKED' })
    expect(decision.action === 'blocked' && decision.reason).toMatch(/taken down by Navide/)
  })

  it('disables a taken-down publisher named by either the id namespace or the declared publisher', () => {
    // A Manifest v1 file may declare a publisher that differs from its id
    // namespace (v2 refuses that at parse time); neither spelling may slip
    // past a publisher takedown.
    const mismatchedDir = join(root, 'acme.mismatched')
    const mismatchedRecord = join(root, 'records', 'acme.mismatched.json')
    mkdirSync(mismatchedDir, { recursive: true })
    writeFileSync(
      join(mismatchedDir, 'manifest.json'),
      JSON.stringify({ id: 'acme.mismatched', version: '1.0.0', publisher: 'other', requires: [], entry: 'index.html' })
    )
    writeFileSync(join(mismatchedDir, 'index.html'), '<!doctype html>')
    consent(mismatchedDir, mismatchedRecord)
    for (const blocked of ['acme', 'other']) {
      expect(
        verifyLocalPackage(
          mismatchedDir,
          'acme.mismatched',
          mismatchedRecord,
          context({ ...metadata, blockedPublishers: [blocked] })
        )
      ).toMatchObject({ action: 'blocked', code: 'LOCAL_PUBLISHER_BLOCKED' })
    }
  })

  it('disables a taken-down package id, for every version or only the listed one', () => {
    consent()
    expect(
      verifyLocalPackage(packageDir, 'acme.local', recordPath, context({
        ...metadata,
        blockedPackages: [{ packageId: 'acme.local' }],
      }))
    ).toMatchObject({ action: 'blocked', code: 'LOCAL_PACKAGE_BLOCKED' })
    expect(
      verifyLocalPackage(packageDir, 'acme.local', recordPath, context({
        ...metadata,
        blockedPackages: [{ packageId: 'acme.local', version: '1.0.0' }],
      }))
    ).toMatchObject({ action: 'blocked', code: 'LOCAL_PACKAGE_BLOCKED' })
    expect(
      verifyLocalPackage(packageDir, 'acme.local', recordPath, context({
        ...metadata,
        blockedPackages: [{ packageId: 'acme.local', version: '2.0.0' }],
      }))
    ).toMatchObject({ action: 'allow' })
  })

  it('still applies a root-signed takedown list after it has expired', () => {
    consent()
    expect(
      verifyLocalPackage(packageDir, 'acme.local', recordPath, {
        ...context({ ...metadata, blockedPublishers: ['acme'] }),
        now: new Date('2026-09-30T00:00:00.000Z'),
      })
    ).toMatchObject({ action: 'blocked', code: 'LOCAL_PUBLISHER_BLOCKED' })
  })

  it('allows without a takedown check when no root-signed list is available, and says so', () => {
    consent()
    expect(verifyLocalPackage(packageDir, 'acme.local', recordPath, context(null))).toMatchObject({
      action: 'allow',
      blocklistChecked: false,
    })
    // A list the pinned root did not sign is not a takedown source either way.
    expect(
      verifyLocalPackage(
        packageDir,
        'acme.local',
        recordPath,
        context({ ...metadata, blockedPublishers: ['acme'] }, otherRootKey.privateKey)
      )
    ).toMatchObject({ action: 'allow', blocklistChecked: false })
  })

  it('refuses a record that names another package or version', () => {
    consent()
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    writeFileSync(recordPath, JSON.stringify({ ...record, version: '0.9.0' }))
    expect(verifyLocalPackage(packageDir, 'acme.local', recordPath, context())).toMatchObject({
      code: 'LOCAL_IDENTITY_MISMATCH',
    })
    writeFileSync(recordPath, JSON.stringify(record))
    expect(verifyLocalPackage(packageDir, 'acme.other', recordPath, context())).toMatchObject({
      code: 'LOCAL_IDENTITY_MISMATCH',
    })
  })

  it('refuses a missing, malformed, or internally inconsistent record', () => {
    expect(verifyLocalPackage(packageDir, 'acme.local', recordPath, context())).toMatchObject({
      code: 'LOCAL_TRUST_RECORD_INVALID',
    })
    consent()
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    writeFileSync(recordPath, JSON.stringify({ ...record, trusted: true }))
    expect(verifyLocalPackage(packageDir, 'acme.local', recordPath, context())).toMatchObject({
      code: 'LOCAL_TRUST_RECORD_INVALID',
    })
    writeFileSync(recordPath, JSON.stringify({ ...record, contentDigest: '0'.repeat(64) }))
    expect(verifyLocalPackage(packageDir, 'acme.local', recordPath, context())).toMatchObject({
      code: 'LOCAL_TRUST_RECORD_INVALID',
    })
    writeFileSync(recordPath, JSON.stringify({ ...record, signer: { keyId: 'x' } }))
    expect(verifyLocalPackage(packageDir, 'acme.local', recordPath, context())).toMatchObject({
      code: 'LOCAL_TRUST_RECORD_INVALID',
    })
  })
})
