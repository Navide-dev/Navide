// D-b: prepareInstall verifies the Registry-signed disclosure envelope and
// recomputes the disclosure from the downloaded package's own manifest
// (contract section 3.5). A version without a disclosure envelope installs
// exactly as before.
import { describe, it, expect } from 'vitest'
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto'
import { prepareInstall, type InstallerDeps, type InstallerTrustConfig } from './pluginInstaller'
import { sha256Hex } from './pluginVerify'
import {
  assertRegistryPackageEnvelopeShape,
  canonicalTrustJson,
  type RegistryDisclosureEnvelope,
  type RegistryPackageEnvelope,
  type RegistryTrustMetadata,
} from './pluginRegistryTrust'
import { makeZip } from './zipFixture'
import { canonicalContractJson, computeDisclosure, type ManifestDisclosure } from '../../shared/pluginDisclosure'
import { DISCLOSURE_ENVELOPE_FIELDS, type ScanReport } from '../../shared/pluginDisclosureScan'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCAN_FIXTURE = JSON.parse(readFileSync(
  join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/scan-cases.json'), 'utf8'))
const scanFor = (digest: string): ScanReport => ({
  ...(SCAN_FIXTURE.cases.find((c: { name: string }) => c.name === SCAN_FIXTURE.scanDigestCase).scan as ScanReport),
  artifactDigest: digest,
  target: 'universal',
})

const root = generateKeyPairSync('ed25519')
const signer = generateKeyPairSync('ed25519')
const otherSigner = generateKeyPairSync('ed25519')
const NOW = new Date('2026-08-16T12:00:00.000Z')
const pem = (key: KeyObject): string => key.export({ type: 'spki', format: 'pem' }).toString()
const TRUST: InstallerTrustConfig = { pinnedRegistryRootKey: pem(root.publicKey), now: NOW }

function manifestV2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.demo',
    name: 'Demo',
    version: '1.0.0',
    publisher: 'acme',
    permissions: { system: ['fs'], scopes: { fs: { root: 'workspace', read: ['README.md'] } } },
    marketplace: { description: 'Demo view', license: 'MIT' },
    contributes: {
      views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Demo', entry: 'frontend/left/index.html' }],
    },
    ...overrides,
  }
}

function v2Pkg(manifest = manifestV2()): { bytes: Uint8Array; digest: string } {
  const zip = new Uint8Array(makeZip([
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: 'frontend/left/index.html', data: '<!doctype html>' },
  ]))
  return { bytes: zip, digest: sha256Hex(zip) }
}

const signCanonical = (value: unknown, key: KeyObject): string =>
  edSign(null, Buffer.from(canonicalTrustJson(value)), key).toString('base64')

const disclosureDigest = (disclosure: unknown): string =>
  createHash('sha256').update(canonicalContractJson(disclosure), 'utf8').digest('hex')

function request(
  digest: string,
  disclosureManifest: Record<string, unknown> | null = manifestV2(),
  scan: ScanReport | null = null
) {
  const envelope: RegistryPackageEnvelope = {
    schemaVersion: 1,
    artifactDigest: digest,
    packageId: 'acme.demo',
    version: '1.0.0',
    target: 'universal',
    publisherId: 'acme',
    keyId: 'registry-2026',
    signedAt: '2026-08-16T11:00:00.000Z',
  }
  const trustMetadata: RegistryTrustMetadata = {
    schemaVersion: 1,
    registryProfile: 'official',
    rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z',
    expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [{
      keyId: 'registry-2026',
      publicKey: pem(signer.publicKey),
      status: 'active',
      notBefore: '2026-08-01T00:00:00.000Z',
      notAfter: '2026-09-01T00:00:00.000Z',
    }],
    blockedPublishers: [],
    blockedPackages: [],
  }
  let disclosure: ManifestDisclosure | null = null
  let disclosureEnvelope: RegistryDisclosureEnvelope | null = null
  let disclosureSignature: string | null = null
  if (disclosureManifest) {
    disclosure = computeDisclosure(disclosureManifest as never)
    disclosureEnvelope = {
      schemaVersion: 1,
      artifactDigest: digest,
      packageId: 'acme.demo',
      version: '1.0.0',
      target: 'universal',
      keyId: 'registry-2026',
      signedAt: envelope.signedAt,
      disclosureDigest: disclosureDigest(disclosure),
      scanDigest: scan === null ? null : disclosureDigest(scan),
    }
    disclosureSignature = signCanonical(disclosureEnvelope, signer.privateKey)
  }
  return {
    registryUrl: 'http://localhost:8787',
    namespace: 'acme',
    name: 'demo',
    version: '1.0.0',
    provenance: 'official-registry' as const,
    expectedDigest: digest,
    target: 'universal',
    registryEnvelope: envelope,
    registrySignature: signCanonical(envelope, signer.privateKey),
    trustMetadata,
    trustMetadataSignature: signCanonical(trustMetadata, root.privateKey),
    disclosure: disclosure as unknown,
    disclosureEnvelope: disclosureEnvelope as unknown,
    disclosureSignature: disclosureSignature as unknown,
    scan: (disclosureManifest ? scan : null) as unknown,
  }
}

function deps(bytes: Uint8Array): { deps: InstallerDeps; writes: Map<string, Uint8Array> } {
  const writes = new Map<string, Uint8Array>()
  return {
    writes,
    deps: {
      async download() { return { bytes, digestHeader: null } },
      mkdirp() {},
      writeFile(path, data) { writes.set(path, data) },
      readFile(path) { return writes.get(path) ?? null },
      writeRegistryTrustSnapshot() {},
      chmod() {},
      rmrf() {},
    },
  }
}

describe('prepareInstall disclosure verification', () => {
  it('accepts a signed disclosure that matches the package manifest and returns it', async () => {
    const { bytes, digest } = v2Pkg()
    const { deps: d, writes } = deps(bytes)
    const prepared = await prepareInstall(request(digest), d, TRUST)
    expect(prepared.disclosure).toEqual(computeDisclosure(manifestV2() as never))
    expect(writes.size).toBe(0)
  })

  it('installs a version without a disclosure envelope exactly as before', async () => {
    const { bytes, digest } = v2Pkg()
    const { deps: d } = deps(bytes)
    const req = request(digest, null)
    const prepared = await prepareInstall(req, d, TRUST)
    expect(prepared.disclosure).toBeNull()
    const legacy = { ...req } as Record<string, unknown>
    delete legacy.disclosure
    delete legacy.disclosureEnvelope
    delete legacy.disclosureSignature
    const fromOldCaller = await prepareInstall(legacy as never, deps(bytes).deps, TRUST)
    expect(fromOldCaller).toMatchObject({ id: 'acme.demo', trustTier: 'signed-verified', disclosure: null })
  })

  it('refuses with DISCLOSURE_MISMATCH when the signed disclosure differs from the package', async () => {
    // The Registry signed a narrower disclosure than the package declares.
    const { bytes, digest } = v2Pkg(manifestV2({ permissions: { system: ['fs', 'aiCli'] } }))
    const { deps: d, writes } = deps(bytes)
    await expect(prepareInstall(request(digest, manifestV2()), d, TRUST))
      .rejects.toMatchObject({ code: 'DISCLOSURE_MISMATCH', message: expect.stringMatching(/refused/) })
    expect(writes.size).toBe(0)
  })

  it('refuses with DISCLOSURE_INVALID when the disclosure no longer matches its signed digest', async () => {
    const { bytes, digest } = v2Pkg()
    const req = request(digest)
    const tampered = JSON.parse(JSON.stringify(req.disclosure))
    tampered.permissions.system = ['ui']
    await expect(prepareInstall({ ...req, disclosure: tampered }, deps(bytes).deps, TRUST))
      .rejects.toMatchObject({ code: 'DISCLOSURE_INVALID' })
  })

  it('refuses with DISCLOSURE_INVALID when the disclosure envelope signature does not verify', async () => {
    const { bytes, digest } = v2Pkg()
    const req = request(digest)
    const forged = signCanonical(req.disclosureEnvelope, otherSigner.privateKey)
    await expect(prepareInstall({ ...req, disclosureSignature: forged }, deps(bytes).deps, TRUST))
      .rejects.toMatchObject({ code: 'DISCLOSURE_INVALID' })
  })

  it.each([
    ['artifactDigest', 'f'.repeat(64)],
    ['packageId', 'acme.other'],
    ['version', '1.0.1'],
    ['target', 'darwin-arm64'],
    ['keyId', 'registry-other'],
  ])('refuses with DISCLOSURE_INVALID when the disclosure envelope %s differs from the package envelope', async (field, value) => {
    const { bytes, digest } = v2Pkg()
    const req = request(digest)
    const envelope = { ...(req.disclosureEnvelope as Record<string, unknown>), [field]: value }
    await expect(prepareInstall({
      ...req,
      disclosureEnvelope: envelope,
      disclosureSignature: signCanonical(envelope, signer.privateKey),
    }, deps(bytes).deps, TRUST)).rejects.toMatchObject({ code: 'DISCLOSURE_INVALID' })
  })

  it.each([
    ['an extra field', (e: Record<string, unknown>) => ({ ...e, extra: 'x' })],
    ['a missing field', (e: Record<string, unknown>) => { const { signedAt: _s, ...rest } = e; return rest }],
    ['the 8-field shape of contract v1 (no scanDigest)', (e: Record<string, unknown>) => { const { scanDigest: _s, ...rest } = e; return rest }],
    ['a malformed scanDigest', (e: Record<string, unknown>) => ({ ...e, scanDigest: 'XYZ' })],
    ['an unsupported schemaVersion', (e: Record<string, unknown>) => ({ ...e, schemaVersion: 2 })],
    ['a malformed digest', (e: Record<string, unknown>) => ({ ...e, disclosureDigest: 'ABC' })],
  ])('refuses with DISCLOSURE_INVALID for a disclosure envelope with %s', async (_label, mutate) => {
    const { bytes, digest } = v2Pkg()
    const req = request(digest)
    const envelope = mutate(req.disclosureEnvelope as Record<string, unknown>)
    await expect(prepareInstall({
      ...req,
      disclosureEnvelope: envelope,
      disclosureSignature: signCanonical(envelope, signer.privateKey),
    }, deps(bytes).deps, TRUST)).rejects.toMatchObject({ code: 'DISCLOSURE_INVALID' })
  })

  it.each([
    ['disclosure', null],
    ['disclosureEnvelope', null],
    ['disclosureSignature', null],
  ])('refuses with DISCLOSURE_INVALID when only %s is missing', async (field, value) => {
    const { bytes, digest } = v2Pkg()
    const req = { ...request(digest), [field]: value }
    await expect(prepareInstall(req, deps(bytes).deps, TRUST))
      .rejects.toMatchObject({ code: 'DISCLOSURE_INVALID' })
  })

  it('accepts a scan report whose digest the disclosure envelope signs, and returns it', async () => {
    const { bytes, digest } = v2Pkg()
    const prepared = await prepareInstall(request(digest, manifestV2(), scanFor(digest)), deps(bytes).deps, TRUST)
    expect(prepared.scan).toEqual(scanFor(digest))
    expect(prepared.disclosure).toEqual(computeDisclosure(manifestV2() as never))
  })

  it('returns a null scan when the envelope carries scanDigest: null', async () => {
    const { bytes, digest } = v2Pkg()
    const prepared = await prepareInstall(request(digest), deps(bytes).deps, TRUST)
    expect(prepared.scan).toBeNull()
  })

  it.each([
    ['a tampered scan report', (req: ReturnType<typeof request>, digest: string) => ({
      ...req, scan: { ...scanFor(digest), network: { hosts: [] } },
    })],
    ['a scan report without a signed scanDigest', (req: ReturnType<typeof request>, digest: string) => ({
      ...request(digest), scan: scanFor(digest),
    })],
    ['a signed scanDigest without its scan report', (req: ReturnType<typeof request>) => ({ ...req, scan: null })],
    ['a scan report of another artifact', (_req: ReturnType<typeof request>, digest: string) => {
      const other = { ...scanFor(digest), artifactDigest: 'e'.repeat(64) }
      const signed = request(digest, manifestV2(), other)
      return signed
    }],
  ])('refuses with DISCLOSURE_INVALID for %s', async (_label, mutate) => {
    const { bytes, digest } = v2Pkg()
    const req = mutate(request(digest, manifestV2(), scanFor(digest)), digest)
    await expect(prepareInstall(req as never, deps(bytes).deps, TRUST))
      .rejects.toMatchObject({ code: 'DISCLOSURE_INVALID' })
  })

  // Review L1 on #354: both envelopes are signed by the same key and no
  // context string tells them apart, so their exact field sets do. Pin both
  // directions.
  it('refuses a signed package envelope presented as the disclosure envelope', async () => {
    const { bytes, digest } = v2Pkg()
    const req = request(digest)
    await expect(prepareInstall({
      ...req,
      disclosureEnvelope: req.registryEnvelope,
      disclosureSignature: req.registrySignature,
    }, deps(bytes).deps, TRUST)).rejects.toMatchObject({ code: 'DISCLOSURE_INVALID' })
  })

  it('refuses a signed disclosure envelope presented as the package envelope', async () => {
    const { bytes, digest } = v2Pkg()
    const req = request(digest)
    await expect(prepareInstall({
      ...req,
      registryEnvelope: req.disclosureEnvelope as never,
      registrySignature: req.disclosureSignature as string,
    }, deps(bytes).deps, TRUST)).rejects.toMatchObject({ code: 'TRUST_METADATA_INVALID' })
    expect(() => assertRegistryPackageEnvelopeShape(req.disclosureEnvelope)).toThrow(/unknown fields disclosureDigest, scanDigest/)
  })

  it('accepts exactly the nine contract fields in the disclosure envelope', () => {
    expect([...DISCLOSURE_ENVELOPE_FIELDS].sort()).toEqual(
      Object.keys(request('a'.repeat(64)).disclosureEnvelope as object).sort()
    )
    expect(DISCLOSURE_ENVELOPE_FIELDS).toHaveLength(9)
  })

  it('leaves the package-envelope checks unchanged: a bad package signature still fails first', async () => {
    const { bytes, digest } = v2Pkg()
    const req = request(digest)
    await expect(prepareInstall({ ...req, registrySignature: req.disclosureSignature as string }, deps(bytes).deps, TRUST))
      .rejects.toMatchObject({ code: 'REGISTRY_SIGNATURE_INVALID' })
  })
})
