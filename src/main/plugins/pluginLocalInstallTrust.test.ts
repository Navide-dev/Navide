import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LOCAL_INSTALL_TRUST_SNAPSHOT_NAME,
  digestBlock,
  isDigestBlocked,
  localSignatureDecision,
  publisherKeyId,
  readLocalInstallTrust,
  recordedSignatureState,
  verifyLocalInstallTrustMetadata,
  writeLocalInstallTrust,
  type LocalInstallTrustMetadata,
} from './pluginLocalInstallTrust'
import { canonicalTrustJson } from './pluginRegistryTrust'

const pem = (key: ReturnType<typeof generateKeyPairSync>['publicKey']): string =>
  key.export({ type: 'spki', format: 'pem' }).toString()
const root = generateKeyPairSync('ed25519')
const otherRoot = generateKeyPairSync('ed25519')
const activeKey = generateKeyPairSync('ed25519')
const revokedKey = generateKeyPairSync('ed25519')
const strangerKey = generateKeyPairSync('ed25519')
const rootPem = pem(root.publicKey)

const bytes = Buffer.from('a .vsix file')
const digest = createHash('sha256').update(bytes).digest('hex')
const signWith = (key: typeof activeKey, value = digest): string =>
  sign(null, Buffer.from(value, 'ascii'), key.privateKey).toString('base64')

function metadata(overrides: Partial<LocalInstallTrustMetadata> = {}): LocalInstallTrustMetadata {
  return {
    schemaVersion: 1,
    kind: 'local-install-trust',
    registryProfile: 'official',
    generatedAt: '2026-10-20T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    blockedDigests: [],
    publisherKeys: [
      { publisherId: 'acme', keyId: publisherKeyId(pem(activeKey.publicKey)), publicKey: pem(activeKey.publicKey), status: 'active', revokedAt: null },
      { publisherId: 'acme', keyId: publisherKeyId(pem(revokedKey.publicKey)), publicKey: pem(revokedKey.publicKey), status: 'revoked', revokedAt: '2026-10-19T00:00:00Z' },
    ],
    ...overrides,
  }
}
const signRoot = (value: unknown, key = root): string =>
  sign(null, Buffer.from(canonicalTrustJson(value), 'utf8'), key.privateKey).toString('base64')

describe('local install trust metadata', () => {
  let pluginsRoot: string
  beforeEach(() => {
    pluginsRoot = mkdtempSync(join(tmpdir(), 'local-install-trust-'))
  })
  afterEach(() => rmSync(pluginsRoot, { recursive: true, force: true }))

  it('accepts only the exact root-signed shape', () => {
    const doc = metadata()
    expect(() => verifyLocalInstallTrustMetadata(doc, signRoot(doc), rootPem)).not.toThrow()
    expect(() => verifyLocalInstallTrustMetadata(doc, signRoot(doc, otherRoot), rootPem)).toThrow(/pinned root/)
    expect(() => verifyLocalInstallTrustMetadata(doc, '', rootPem)).toThrow(/unsigned/)
    expect(() => verifyLocalInstallTrustMetadata(doc, signRoot(doc), null)).toThrow(/no pinned/)
    const extra = { ...doc, signers: [] }
    expect(() => verifyLocalInstallTrustMetadata(extra, signRoot(extra), rootPem)).toThrow()
    // The Registry trust metadata, signed by the same root, is not this document.
    const registryShape = { schemaVersion: 1, registryProfile: 'official', generatedAt: doc.generatedAt }
    expect(() => verifyLocalInstallTrustMetadata(registryShape, signRoot(registryShape), rootPem)).toThrow()
    const badDigest = metadata({ blockedDigests: ['ABC'] })
    expect(() => verifyLocalInstallTrustMetadata(badDigest, signRoot(badDigest), rootPem)).toThrow(/blockedDigests/)
  })

  it('stores a verified document and never rolls back to an older one', () => {
    const newer = metadata({ generatedAt: '2026-10-20T06:00:00Z', blockedDigests: [digest] })
    writeLocalInstallTrust(pluginsRoot, newer, signRoot(newer), rootPem)
    expect(readLocalInstallTrust(pluginsRoot, rootPem)?.blockedDigests).toEqual([digest])
    const older = metadata()
    expect(() => writeLocalInstallTrust(pluginsRoot, older, signRoot(older), rootPem)).toThrow(/older/)
    expect(readLocalInstallTrust(pluginsRoot, rootPem)?.generatedAt).toBe('2026-10-20T06:00:00Z')
    // Another root (a forged file on disk) reads as no document at all.
    expect(readLocalInstallTrust(pluginsRoot, pem(otherRoot.publicKey))).toBeNull()
  })

  it('reads a tampered snapshot as no document', () => {
    const doc = metadata({ blockedDigests: [digest] })
    writeLocalInstallTrust(pluginsRoot, doc, signRoot(doc), rootPem)
    const path = join(pluginsRoot, LOCAL_INSTALL_TRUST_SNAPSHOT_NAME)
    writeFileSync(path, readFileSync(path, 'utf8').replace(digest, '0'.repeat(64)))
    expect(readLocalInstallTrust(pluginsRoot, rootPem)).toBeNull()
  })

  it('blocks a listed digest', () => {
    expect(isDigestBlocked(metadata({ blockedDigests: [digest] }), digest)).toBe(true)
    expect(isDigestBlocked(metadata(), digest)).toBe(false)
    expect(isDigestBlocked(null, digest)).toBe(false)
  })

  // Decision d5: the Registry now lists `{digest, reason}`; a bare string
  // from an older Registry reads as a block with no reason.
  it('reads both the {digest, reason} and the bare-string shapes, signed as received', () => {
    const other = 'b'.repeat(64)
    const doc = metadata({ blockedDigests: [{ digest, reason: 'security' }, other] })
    writeLocalInstallTrust(pluginsRoot, doc, signRoot(doc), rootPem)
    const stored = readLocalInstallTrust(pluginsRoot, rootPem)
    expect(stored?.blockedDigests).toEqual([{ digest, reason: 'security' }, other])
    expect(digestBlock(stored, digest)).toEqual({ reason: 'security' })
    expect(digestBlock(stored, other)).toEqual({ reason: null })
    expect(digestBlock(stored, 'c'.repeat(64))).toBeNull()
    expect(isDigestBlocked(stored, digest)).toBe(true)
    for (const reason of ['admin', 'qualification-revoked', 'developer-withdrawn', 'testplace-withdrawn'] as const) {
      expect(digestBlock(metadata({ blockedDigests: [{ digest, reason }] }), digest)).toEqual({ reason })
    }
  })

  // 0.2.28 compatibility: an App that does not know `testplace-withdrawn`
  // (0.2.27 and older) still verifies and stores the whole document, reads
  // that entry as a block with no reason (warned about, never disabled), and
  // grades every other entry as before.
  it('a document carrying testplace-withdrawn stays readable to a release that does not know it', () => {
    const other = 'b'.repeat(64)
    const doc = metadata({ blockedDigests: [{ digest, reason: 'testplace-withdrawn' }, { digest: other, reason: 'security' }] })
    writeLocalInstallTrust(pluginsRoot, doc, signRoot(doc), rootPem)
    const stored = readLocalInstallTrust(pluginsRoot, rootPem)
    expect(stored?.blockedDigests).toEqual(doc.blockedDigests)
    expect(digestBlock(stored, other)).toEqual({ reason: 'security' })
    // An older release's view: the same entry under a reason it has no name for.
    const older = metadata({ blockedDigests: [{ digest, reason: 'not-yet-known' }, { digest: other, reason: 'security' }] })
    expect(digestBlock(older, digest)).toEqual({ reason: null })
    expect(digestBlock(older, other)).toEqual({ reason: 'security' })
  })

  it('reads a reason it does not know as none, and refuses a malformed entry', () => {
    const future = metadata({ blockedDigests: [{ digest, reason: 'court-order' }] })
    expect(() => verifyLocalInstallTrustMetadata(future, signRoot(future), rootPem)).not.toThrow()
    expect(digestBlock(future, digest)).toEqual({ reason: null })
    for (const entry of [
      { digest: digest.toUpperCase(), reason: 'admin' },
      { digest, reason: 'admin', note: 'x' },
      { digest },
      { digest, reason: 3 },
    ]) {
      const bad = metadata({ blockedDigests: [entry as never] })
      expect(() => verifyLocalInstallTrustMetadata(bad, signRoot(bad), rootPem)).toThrow(/blockedDigests/)
    }
  })
})

describe('A3: a local file signed by a vetted publisher', () => {
  it('verified: the active key of the publisher the id names signed this file', () => {
    const decision = localSignatureDecision(metadata(), 'acme.todo', digest, signWith(activeKey))
    expect(decision.state).toBe('verified')
    expect(decision).toMatchObject({ publisherId: 'acme', keyId: publisherKeyId(pem(activeKey.publicKey)) })
  })

  it('unsigned: no signature beside the file', () => {
    expect(localSignatureDecision(metadata(), 'acme.todo', digest, null)).toEqual({ state: 'none' })
  })

  it('revoked: a key the Registry revoked is a signature no longer valid', () => {
    expect(localSignatureDecision(metadata(), 'acme.todo', digest, signWith(revokedKey)).state).toBe('revoked')
  })

  it('unverifiable: another publisher, another file, an unknown key, or no list', () => {
    expect(localSignatureDecision(metadata(), 'other.todo', digest, signWith(activeKey)).state).toBe('unverifiable')
    expect(localSignatureDecision(metadata(), 'acme.todo', digest, signWith(activeKey, '0'.repeat(64))).state).toBe('unverifiable')
    expect(localSignatureDecision(metadata(), 'acme.todo', digest, signWith(strangerKey)).state).toBe('unverifiable')
    expect(localSignatureDecision(null, 'acme.todo', digest, signWith(activeKey)).state).toBe('unverifiable')
    expect(localSignatureDecision(metadata(), 'acme.todo', digest, 'not base64!').state).toBe('unverifiable')
  })

  it('shows a recorded signature as no longer valid once its key is revoked', () => {
    const decision = localSignatureDecision(metadata(), 'acme.todo', digest, signWith(activeKey))
    if (decision.state !== 'verified') throw new Error('expected a verified signature')
    expect(recordedSignatureState(metadata(), 'acme.todo', decision.signer)).toBe('verified')
    const revokedLater = metadata({
      publisherKeys: metadata().publisherKeys.map((key) => ({ ...key, status: 'revoked' as const, revokedAt: '2026-10-20T01:00:00Z' })),
    })
    expect(recordedSignatureState(revokedLater, 'acme.todo', decision.signer)).toBe('revoked')
    expect(recordedSignatureState(metadata({ publisherKeys: [] }), 'acme.todo', decision.signer)).toBe('revoked')
    // Without a list the install-time check stands.
    expect(recordedSignatureState(null, 'acme.todo', decision.signer)).toBe('verified')
    // Evidence copied onto another publisher's id never counts.
    expect(recordedSignatureState(metadata(), 'other.todo', decision.signer)).toBe('revoked')
  })
})
