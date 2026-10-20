import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  readRegistryReceiptChannel,
  registryReceiptFromEvidence,
  verifyInstalledRegistryPackage,
  type InstalledRegistryTrustContext,
} from './pluginInstalledTrust'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import { defaultReceiptSwapDeps, swapRegistryReceipt } from './pluginReceiptPromotion'
import { PLUGIN_QUARANTINE_DIR, PLUGIN_STAGING_DIR } from './pluginInstallPaths'
import { sha256Hex } from './pluginVerify'
import { makeZip } from './zipFixture'

const rootKey = generateKeyPairSync('ed25519')
const signerKey = generateKeyPairSync('ed25519')
const now = new Date('2026-08-16T12:00:00.000Z')
const signed = (value: unknown, key = signerKey.privateKey) =>
  sign(null, Buffer.from(canonicalTrustJson(value)), key).toString('base64')

const manifest = JSON.stringify({
  schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.demo', name: 'Demo', version: '1.0.0', publisher: 'acme', permissions: {},
  marketplace: { description: 'Demo', license: 'MIT' },
  contributes: { views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Demo', entry: 'frontend/index.html' }] },
})
const archive = new Uint8Array(makeZip([
  { name: 'manifest.json', data: manifest },
  { name: 'frontend/index.html', data: '<!doctype html>' },
]))
const digest = sha256Hex(archive)
const base: RegistryPackageEnvelope = {
  schemaVersion: 1, artifactDigest: digest, packageId: 'acme.demo', version: '1.0.0', target: 'universal',
  publisherId: 'acme', keyId: 'registry-test', signedAt: '2026-08-16T11:00:00.000Z',
}
const testplaceEnvelope: RegistryPackageEnvelope = { ...base, channel: 'testplace', expiresAt: '2026-11-14T11:00:00.000Z' }
const stableEnvelope: RegistryPackageEnvelope = { ...base, signedAt: '2026-08-16T11:30:00.000Z' }
const metadata: RegistryTrustMetadata = {
  schemaVersion: 1, registryProfile: 'official', rootFingerprint: `sha256:${'1'.repeat(64)}`,
  generatedAt: '2026-08-16T10:00:00.000Z', expiresAt: '2026-08-17T10:00:00.000Z',
  signers: [{
    keyId: 'registry-test', publicKey: signerKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    status: 'active', notBefore: '2026-08-01T00:00:00.000Z', notAfter: '2026-09-01T00:00:00.000Z',
  }],
  blockedPublishers: [], blockedPackages: [],
}
const trust: InstalledRegistryTrustContext = {
  pinnedRootKey: rootKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  snapshot: { schemaVersion: 1, metadata, metadataSignature: signed(metadata, rootKey.privateKey) },
  now,
}
const receiptFor = (envelope: RegistryPackageEnvelope, overrides: Partial<{ artifactDigest: string }> = {}) =>
  registryReceiptFromEvidence({
    packageId: 'acme.demo', version: '1.0.0', publisherId: 'acme', target: 'universal',
    artifactDigest: overrides.artifactDigest ?? digest, envelope, envelopeSignature: signed(envelope),
  })

describe('swapRegistryReceipt (promoted Testplace build)', () => {
  let root: string
  let dir: string
  const verify = (staged: string) => verifyInstalledRegistryPackage(staged, 'acme.demo', trust)
  const receipt = () => JSON.parse(readFileSync(join(dir, REGISTRY_RECEIPT_NAME), 'utf8'))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-receipt-swap-'))
    dir = join(root, 'acme.demo', '1.0.0', 'universal', 'package')
    mkdirSync(join(dir, 'frontend'), { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), manifest)
    writeFileSync(join(dir, 'frontend', 'index.html'), '<!doctype html>')
    writeFileSync(join(dir, REGISTRY_ARTIFACT_NAME), archive)
    writeFileSync(join(dir, REGISTRY_RECEIPT_NAME), JSON.stringify(receiptFor(testplaceEnvelope)))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('swaps in the stable envelope for the same artifact, leaving nothing behind', () => {
    expect(readRegistryReceiptChannel(dir)).toBe('testplace')
    swapRegistryReceipt(root, dir, 'acme.demo', receiptFor(stableEnvelope), verify)
    expect(receipt().envelope).toEqual(stableEnvelope)
    expect(readRegistryReceiptChannel(dir)).toBeUndefined()
    expect(readFileSync(join(dir, REGISTRY_ARTIFACT_NAME))).toEqual(Buffer.from(archive))
    expect(verify(dir)).toEqual({ action: 'allow', artifactDigest: digest, target: 'universal' })
    for (const scratch of [PLUGIN_STAGING_DIR, PLUGIN_QUARANTINE_DIR]) {
      expect(existsSync(join(root, scratch)) ? readdirSync(join(root, scratch)) : []).toEqual([])
    }
  })

  it('refuses another digest and changes nothing', () => {
    const other = { ...stableEnvelope, artifactDigest: 'b'.repeat(64) }
    const before = readFileSync(join(dir, REGISTRY_RECEIPT_NAME), 'utf8')
    expect(() => swapRegistryReceipt(root, dir, 'acme.demo', receiptFor(other, { artifactDigest: 'b'.repeat(64) }), verify))
      .toThrow(/artifactDigest differs/)
    expect(() => swapRegistryReceipt(root, dir, 'acme.demo', receiptFor(other), verify)).toThrow(/installed artifact/)
    expect(readFileSync(join(dir, REGISTRY_RECEIPT_NAME), 'utf8')).toBe(before)
  })

  it('refuses a receipt that does not verify (a bad signature) and changes nothing', () => {
    const before = readFileSync(join(dir, REGISTRY_RECEIPT_NAME), 'utf8')
    const forged = { ...receiptFor(stableEnvelope), envelopeSignature: signed(testplaceEnvelope) }
    expect(() => swapRegistryReceipt(root, dir, 'acme.demo', forged, verify)).toThrow(/did not verify/)
    expect(readFileSync(join(dir, REGISTRY_RECEIPT_NAME), 'utf8')).toBe(before)
    expect(readdirSync(join(root, PLUGIN_STAGING_DIR))).toEqual([])
  })

  it('rolls back when the swap fails halfway', () => {
    const before = readFileSync(join(dir, REGISTRY_RECEIPT_NAME), 'utf8')
    let renames = 0
    const failing = {
      ...defaultReceiptSwapDeps,
      rename: (from: string, to: string) => {
        renames += 1
        // The second rename (staged copy into place) fails.
        if (renames === 2) throw new Error('disk full')
        defaultReceiptSwapDeps.rename(from, to)
      },
    }
    expect(() => swapRegistryReceipt(root, dir, 'acme.demo', receiptFor(stableEnvelope), verify, failing)).toThrow('disk full')
    expect(readFileSync(join(dir, REGISTRY_RECEIPT_NAME), 'utf8')).toBe(before)
    expect(verify(dir)).toMatchObject({ action: 'allow' })
    expect(readdirSync(join(root, PLUGIN_STAGING_DIR))).toEqual([])
    expect(readdirSync(join(root, PLUGIN_QUARANTINE_DIR))).toEqual([])
  })
})
