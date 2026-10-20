// Root-signed trust for packages installed from a local file (plan W1: A3 and
// the digest takedown list). The Registry serves it at
// GET /api/trust/local-install as a document of its own, signed by the same
// pinned root as the Registry trust metadata. That metadata is checked field
// for field by every released Navide, so nothing is added to it; this
// document carries what only a local install needs:
//
// - `blockedDigests`: SHA-256 of `.vsix` files Navide has taken down, each as
//   `{digest, reason}` (decision d5; a Registry before it sent bare strings,
//   read as having no reason). A file whose bytes match is refused, whatever
//   id it claims; an installed copy is graded by the reason
//   (`pluginDigestBlock.ts`).
// - `publisherKeys`: the Ed25519 keys of vetted publishers. A `.vsix` with a
//   `<file>.sig` beside it, signed (`navide-plugin sign`) by the active key of
//   the publisher its id names, is shown as signed by a vetted publisher. A
//   key the Registry revoked is listed with status `revoked`, so a signature by
//   it is shown as no longer valid instead of as unsigned.
//
// A signature is evidence of who built the file, not a review: the version
// itself is not reviewed by Navide.

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalTrustJson } from './pluginRegistryTrust'
import { assertExactTrustFields, parseHostTrustJsonObject, readHostTrustJsonObject, requireTrustObject } from './pluginTrustJson'

export const LOCAL_INSTALL_TRUST_SNAPSHOT_NAME = '.navide-local-install-trust.json'
export const LOCAL_INSTALL_TRUST_PATH = '/api/trust/local-install'
/** The sidecar `navide-plugin sign` writes beside the package. */
export const LOCAL_SIGNATURE_SUFFIX = '.sig'

export interface LocalPublisherKey {
  publisherId: string
  /** `sha256:` + hex SHA-256 of the key's SPKI DER. */
  keyId: string
  /** SPKI PEM. */
  publicKey: string
  status: 'active' | 'revoked'
  revokedAt: string | null
}

/** Why Navide blocked a digest (decision d5). */
export type LocalBlockReason = 'security' | 'admin' | 'qualification-revoked' | 'developer-withdrawn'
const BLOCK_REASONS: readonly LocalBlockReason[] = ['security', 'admin', 'qualification-revoked', 'developer-withdrawn']

/** One `blockedDigests` entry as signed: a bare digest (no reason) or
 * `{digest, reason}`. Kept as received, since the root signed these bytes. */
export type LocalBlockedDigestEntry = string | { digest: string; reason: string }

export interface LocalInstallTrustMetadata {
  schemaVersion: 1
  kind: 'local-install-trust'
  registryProfile: 'official' | 'self-hosted-dev'
  generatedAt: string
  expiresAt: string
  blockedDigests: LocalBlockedDigestEntry[]
  publisherKeys: LocalPublisherKey[]
}

export interface LocalInstallTrustSnapshot {
  schemaVersion: 1
  metadata: LocalInstallTrustMetadata
  metadataSignature: string
}

const HEX_DIGEST = /^[0-9a-f]{64}$/
const KEY_ID = /^sha256:[0-9a-f]{64}$/
const PUBLISHER_ID = /^[a-z0-9][a-z0-9-]*$/

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** The exact wire shape; any unknown or missing field is refused. */
export function assertLocalInstallTrustMetadataShape(
  value: unknown,
  label = 'local install trust metadata',
): asserts value is LocalInstallTrustMetadata {
  const metadata = requireTrustObject(value, label)
  assertExactTrustFields(metadata, label, [
    'schemaVersion', 'kind', 'registryProfile', 'generatedAt', 'expiresAt', 'blockedDigests', 'publisherKeys',
  ])
  if (metadata.schemaVersion !== 1) throw new Error(`${label} schemaVersion is unsupported`)
  if (metadata.kind !== 'local-install-trust') throw new Error(`${label}.kind is invalid`)
  if (metadata.registryProfile !== 'official' && metadata.registryProfile !== 'self-hosted-dev') {
    throw new Error(`${label}.registryProfile is invalid`)
  }
  if (!isTimestamp(metadata.generatedAt) || !isTimestamp(metadata.expiresAt)) {
    throw new Error(`${label} timestamps are invalid`)
  }
  if (!Array.isArray(metadata.blockedDigests)) throw new Error(`${label}.blockedDigests must be an array`)
  metadata.blockedDigests.forEach((entry, index) => {
    if (typeof entry === 'string') {
      if (!HEX_DIGEST.test(entry)) throw new Error(`${label}.blockedDigests must be lowercase SHA-256 hex digests`)
      return
    }
    const item = requireTrustObject(entry, `${label}.blockedDigests[${index}]`)
    assertExactTrustFields(item, `${label}.blockedDigests[${index}]`, ['digest', 'reason'])
    if (typeof item.digest !== 'string' || !HEX_DIGEST.test(item.digest)) {
      throw new Error(`${label}.blockedDigests must be lowercase SHA-256 hex digests`)
    }
    // A reason this release does not know is read as none (warned about),
    // so a newer Registry never makes the whole list unreadable.
    if (typeof item.reason !== 'string') throw new Error(`${label}.blockedDigests[${index}].reason must be a string`)
  })
  if (!Array.isArray(metadata.publisherKeys)) throw new Error(`${label}.publisherKeys must be an array`)
  metadata.publisherKeys.forEach((entry, index) => {
    const key = requireTrustObject(entry, `${label}.publisherKeys[${index}]`)
    assertExactTrustFields(key, `${label}.publisherKeys[${index}]`, ['publisherId', 'keyId', 'publicKey', 'status', 'revokedAt'])
    if (typeof key.publisherId !== 'string' || !PUBLISHER_ID.test(key.publisherId)) {
      throw new Error(`${label}.publisherKeys[${index}].publisherId is invalid`)
    }
    if (typeof key.keyId !== 'string' || !KEY_ID.test(key.keyId)) {
      throw new Error(`${label}.publisherKeys[${index}].keyId is invalid`)
    }
    if (typeof key.publicKey !== 'string') throw new Error(`${label}.publisherKeys[${index}].publicKey must be a string`)
    if (key.status !== 'active' && key.status !== 'revoked') {
      throw new Error(`${label}.publisherKeys[${index}].status is invalid`)
    }
    if (key.revokedAt !== null && !isTimestamp(key.revokedAt)) {
      throw new Error(`${label}.publisherKeys[${index}].revokedAt is invalid`)
    }
  })
}

function verifyEd25519(message: Buffer, signature: string, publicKey: string): boolean {
  try {
    return cryptoVerify(null, message, createPublicKey(publicKey), Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

/** Shape plus the pinned root's signature. Freshness is not required: the
 * document can only refuse a file or withdraw a "signed" label, and an
 * expired one the root signed still says what the Registry last said. */
export function verifyLocalInstallTrustMetadata(
  metadata: unknown,
  signature: unknown,
  pinnedRootKey: string | null,
): asserts metadata is LocalInstallTrustMetadata {
  assertLocalInstallTrustMetadataShape(metadata)
  if (!pinnedRootKey) throw new Error('no pinned registry root is configured')
  if (typeof signature !== 'string' || !signature) throw new Error('local install trust metadata is unsigned')
  if (!verifyEd25519(Buffer.from(canonicalTrustJson(metadata), 'utf8'), signature, pinnedRootKey)) {
    throw new Error('local install trust metadata signature failed verification against the pinned root')
  }
}

function parseSnapshot(raw: Record<string, unknown>): LocalInstallTrustSnapshot {
  assertExactTrustFields(raw, 'local install trust snapshot', ['schemaVersion', 'metadata', 'metadataSignature'])
  if (raw.schemaVersion !== 1) throw new Error('local install trust snapshot schemaVersion is unsupported')
  assertLocalInstallTrustMetadataShape(raw.metadata)
  if (typeof raw.metadataSignature !== 'string') throw new Error('local install trust snapshot is unsigned')
  return raw as unknown as LocalInstallTrustSnapshot
}

/** The stored snapshot, verified against the pinned root, or null. */
export function readLocalInstallTrust(pluginsRoot: string, pinnedRootKey: string | null): LocalInstallTrustMetadata | null {
  try {
    const snapshot = parseSnapshot(readHostTrustJsonObject(join(pluginsRoot, LOCAL_INSTALL_TRUST_SNAPSHOT_NAME), LOCAL_INSTALL_TRUST_SNAPSHOT_NAME))
    verifyLocalInstallTrustMetadata(snapshot.metadata, snapshot.metadataSignature, pinnedRootKey)
    return snapshot.metadata
  } catch {
    return null
  }
}

/** Store a root-verified document; an older one never replaces a newer one. */
export function writeLocalInstallTrust(
  pluginsRoot: string,
  metadata: unknown,
  signature: unknown,
  pinnedRootKey: string | null,
): void {
  verifyLocalInstallTrustMetadata(metadata, signature, pinnedRootKey)
  const path = join(pluginsRoot, LOCAL_INSTALL_TRUST_SNAPSHOT_NAME)
  try {
    const existing = parseSnapshot(parseHostTrustJsonObject(readFileSync(path, 'utf8'), LOCAL_INSTALL_TRUST_SNAPSHOT_NAME))
    if (Date.parse(existing.metadata.generatedAt) > Date.parse(metadata.generatedAt)) {
      throw new Error('refusing to replace local install trust metadata with an older document')
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('older document')) throw error
    // No snapshot yet, or a malformed one a root-verified document repairs.
  }
  mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp`
  const snapshot: LocalInstallTrustSnapshot = { schemaVersion: 1, metadata, metadataSignature: signature as string }
  writeFileSync(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
  renameSync(temporary, path)
}

/** The block on a file with this SHA-256: `{reason}` (null when the list
 * names none or one this release does not know), or null when not blocked. */
export function digestBlock(
  trust: LocalInstallTrustMetadata | null,
  digest: string,
): { reason: LocalBlockReason | null } | null {
  if (trust === null) return null
  for (const entry of trust.blockedDigests) {
    if (typeof entry === 'string') {
      if (entry === digest) return { reason: null }
    } else if (entry.digest === digest) {
      const reason = BLOCK_REASONS.find((known) => known === entry.reason)
      return { reason: reason ?? null }
    }
  }
  return null
}

/** Whether Navide has taken down a file with this SHA-256. */
export function isDigestBlocked(trust: LocalInstallTrustMetadata | null, digest: string): boolean {
  return digestBlock(trust, digest) !== null
}

/** What a local signature shows:
 * - `none`: no signature beside the file.
 * - `verified`: the active key of a vetted publisher signed exactly this file.
 * - `revoked`: a key the Registry has since revoked signed it ("signature no
 *   longer valid").
 * - `unverifiable`: a signature that matches no vetted key of the publisher the
 *   id names, does not verify, or could not be checked (no root-signed list). */
export type LocalSignatureState = 'none' | 'verified' | 'revoked' | 'unverifiable'

/** Signer evidence kept in the local trust record, so the label can be
 * checked again against a later list (a key revoked after install). */
export interface LocalSignerEvidence {
  publisherId: string
  keyId: string
  artifactDigest: string
  signature: string
}

export type LocalSignatureDecision =
  | { state: 'none' }
  | { state: 'unverifiable'; publisherId: string }
  | { state: 'verified' | 'revoked'; publisherId: string; keyId: string; signer: LocalSignerEvidence }

/** Check a `navide-plugin sign` signature (Ed25519 over the ASCII hex
 * SHA-256 of the whole file) against the keys of the publisher the id names. */
export function localSignatureDecision(
  trust: LocalInstallTrustMetadata | null,
  packageId: string,
  artifactDigest: string,
  signature: string | null,
): LocalSignatureDecision {
  if (signature === null) return { state: 'none' }
  const publisherId = packageId.split('.')[0]
  const text = signature.trim()
  if (!trust || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return { state: 'unverifiable', publisherId }
  const message = Buffer.from(artifactDigest, 'ascii')
  const keys = trust.publisherKeys.filter((key) => key.publisherId === publisherId)
  // An active key wins over a revoked one that also verifies (a re-signed file).
  for (const status of ['active', 'revoked'] as const) {
    for (const key of keys.filter((candidate) => candidate.status === status)) {
      if (!verifyEd25519(message, text, key.publicKey)) continue
      return {
        state: status === 'active' ? 'verified' : 'revoked',
        publisherId,
        keyId: key.keyId,
        signer: { publisherId, keyId: key.keyId, artifactDigest, signature: text },
      }
    }
  }
  return { state: 'unverifiable', publisherId }
}

/** Re-check recorded signer evidence against the current list (load time):
 * `verified` while that key is still active, `revoked` once it is revoked or
 * no longer listed, and `verified` when no list is available, since the
 * record already holds the install-time check. */
export function recordedSignatureState(
  trust: LocalInstallTrustMetadata | null,
  packageId: string,
  signer: LocalSignerEvidence,
): 'verified' | 'revoked' {
  if (signer.publisherId !== packageId.split('.')[0]) return 'revoked'
  if (!trust) return 'verified'
  const decision = localSignatureDecision(trust, packageId, signer.artifactDigest, signer.signature)
  return decision.state === 'verified' && decision.keyId === signer.keyId ? 'verified' : 'revoked'
}

/** `sha256:` key id of an SPKI PEM, as the Registry computes it. */
export function publisherKeyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return `sha256:${createHash('sha256').update(der).digest('hex')}`
}
