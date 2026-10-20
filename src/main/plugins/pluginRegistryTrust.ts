import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { assertExactTrustFields, requireTrustObject } from './pluginTrustJson'
import { assertPluginTargetCompatible, currentPluginHostTarget } from './pluginTarget'
import { isValidManifestV2PluginId } from './pluginManifestV2'
import { canonicalContractJson, type ManifestDisclosure } from '../../shared/pluginDisclosure'
import { DISCLOSURE_ENVELOPE_FIELDS, type ScanReport } from '../../shared/pluginDisclosureScan'

export type RegistryAuthority = 'official' | 'self-hosted'

export type RegistrySignerStatus = 'active' | 'rotating' | 'expired' | 'revoked'

export interface RegistryPackageEnvelope {
  schemaVersion: 1
  artifactDigest: string
  packageId: string
  version: string
  target: string
  publisherId: string
  keyId: string
  signedAt: string
  /** Present only on a testplace version, together with expiresAt; stable
   * and pre-release envelopes keep the 8 fields above. */
  channel?: string
  expiresAt?: string
}

/** Release channels this App can install. Anything else is refused. */
const REGISTRY_RELEASE_CHANNELS: ReadonlySet<string> = new Set(['stable', 'pre-release', 'testplace'])

/** The Registry-signed disclosure envelope (contract section 3.5). It is
 * separate from the 8-field package envelope, which stays unchanged so that
 * released Apps keep verifying new versions. */
export interface RegistryDisclosureEnvelope {
  schemaVersion: 1
  artifactDigest: string
  packageId: string
  version: string
  target: string
  keyId: string
  signedAt: string
  disclosureDigest: string
  /** SHA-256 of the Registry's scan report (contract 3.8), or null when the
   * version has none. */
  scanDigest: string | null
}

export interface RegistrySignerTrust {
  keyId: string
  publicKey: string
  status: RegistrySignerStatus
  notBefore: string
  notAfter: string
}

export interface RegistryBlockedPackage {
  packageId: string
  version?: string
}

export interface RegistryTrustMetadata {
  schemaVersion: 1
  registryProfile: 'official' | 'self-hosted-dev'
  /** Informational identity only. The Host never turns this response value
   * into a trust root; signature verification still uses pinnedRootKey. */
  rootFingerprint: string
  generatedAt: string
  expiresAt: string
  signers: RegistrySignerTrust[]
  blockedPublishers: string[]
  blockedPackages: RegistryBlockedPackage[]
}

export type RegistryTrustErrorCode =
  | 'TRUST_METADATA_INVALID'
  | 'SIGNATURE_REQUIRED'
  | 'REGISTRY_SIGNATURE_INVALID'
  | 'IDENTITY_MISMATCH'
  | 'SIGNER_UNKNOWN'
  | 'SIGNER_REVOKED'
  | 'SIGNER_INVALID'
  | 'PUBLISHER_BLOCKED'
  | 'PACKAGE_BLOCKED'
  | 'DISCLOSURE_INVALID'
  | 'DISCLOSURE_MISMATCH'
  | 'CHANNEL_UNSUPPORTED'
  | 'TESTPLACE_EXPIRED'
  /** Its developer (or Navide) took a test build back; its testers learn it
   *  from the tester detail, never from public metadata (S8 T-MED-1). */
  | 'TESTPLACE_WITHDRAWN'

export class RegistryTrustError extends Error {
  constructor(
    readonly code: RegistryTrustErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'RegistryTrustError'
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

/** Validate the exact wire shape before a Registry envelope becomes Host
 * evidence. This is also used for retained receipt files. */
export function assertRegistryPackageEnvelopeShape(
  value: unknown,
  label = 'registry envelope'
): asserts value is RegistryPackageEnvelope {
  const envelope = requireTrustObject(value, label)
  assertExactTrustFields(
    envelope,
    label,
    [
      'schemaVersion',
      'artifactDigest',
      'packageId',
      'version',
      'target',
      'publisherId',
      'keyId',
      'signedAt',
    ],
    ['channel', 'expiresAt']
  )
  if (envelope.schemaVersion !== 1) throw new Error(`${label} schemaVersion is unsupported`)
  for (const field of [
    'artifactDigest',
    'packageId',
    'version',
    'target',
    'publisherId',
    'keyId',
    'signedAt',
  ]) {
    requiredString(envelope[field], `${label}.${field}`)
  }
  for (const field of ['channel', 'expiresAt']) {
    if (envelope[field] !== undefined) requiredString(envelope[field], `${label}.${field}`)
  }
  if (!isValidManifestV2PluginId(envelope.packageId)) {
    throw new Error(`${label}.packageId is invalid`)
  }
}

/** Validate the exact root-signed metadata shape. Unknown nested fields are
 * rejected as well as unknown top-level fields. */
export function assertRegistryTrustMetadataShape(
  value: unknown,
  label = 'registry trust metadata'
): asserts value is RegistryTrustMetadata {
  const metadata = requireTrustObject(value, label)
  assertExactTrustFields(metadata, label, [
    'schemaVersion',
    'registryProfile',
    'rootFingerprint',
    'generatedAt',
    'expiresAt',
    'signers',
    'blockedPublishers',
    'blockedPackages',
  ])
  if (metadata.schemaVersion !== 1) throw new Error(`${label} schemaVersion is unsupported`)
  if (metadata.registryProfile !== 'official' && metadata.registryProfile !== 'self-hosted-dev') {
    throw new Error(`${label}.registryProfile is invalid`)
  }
  if (
    typeof metadata.rootFingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(metadata.rootFingerprint)
  ) {
    throw new Error(`${label}.rootFingerprint is invalid`)
  }
  requiredString(metadata.generatedAt, `${label}.generatedAt`)
  requiredString(metadata.expiresAt, `${label}.expiresAt`)
  if (!Array.isArray(metadata.signers)) throw new Error(`${label}.signers must be an array`)
  metadata.signers.forEach((value, index) => {
    const signer = requireTrustObject(value, `${label}.signers[${index}]`)
    assertExactTrustFields(signer, `${label}.signers[${index}]`, [
      'keyId',
      'publicKey',
      'status',
      'notBefore',
      'notAfter',
    ])
    requiredString(signer.keyId, `${label}.signers[${index}].keyId`)
    requiredString(signer.publicKey, `${label}.signers[${index}].publicKey`)
    if (!['active', 'rotating', 'expired', 'revoked'].includes(String(signer.status))) {
      throw new Error(`${label}.signers[${index}].status is invalid`)
    }
    requiredString(signer.notBefore, `${label}.signers[${index}].notBefore`)
    requiredString(signer.notAfter, `${label}.signers[${index}].notAfter`)
  })
  if (!Array.isArray(metadata.blockedPublishers)) {
    throw new Error(`${label}.blockedPublishers must be an array`)
  }
  metadata.blockedPublishers.forEach((value, index) =>
    requiredString(value, `${label}.blockedPublishers[${index}]`)
  )
  if (!Array.isArray(metadata.blockedPackages)) {
    throw new Error(`${label}.blockedPackages must be an array`)
  }
  metadata.blockedPackages.forEach((value, index) => {
    const blocked = requireTrustObject(value, `${label}.blockedPackages[${index}]`)
    assertExactTrustFields(blocked, `${label}.blockedPackages[${index}]`, ['packageId'], ['version'])
    requiredString(blocked.packageId, `${label}.blockedPackages[${index}].packageId`)
    if (!isValidManifestV2PluginId(blocked.packageId)) {
      throw new Error(`${label}.blockedPackages[${index}].packageId is invalid`)
    }
    if (blocked.version !== undefined) {
      requiredString(blocked.version, `${label}.blockedPackages[${index}].version`)
    }
  })
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareCanonicalKeys(left, right))
        .map(([key, item]) => [key, canonicalValue(item)])
    )
  }
  return value
}

function compareCanonicalKeys(left: string, right: string): number {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0)!)
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0)!)
  const comparedLength = Math.min(leftCodePoints.length, rightCodePoints.length)

  for (let index = 0; index < comparedLength; index += 1) {
    const leftCodePoint = leftCodePoints[index]
    const rightCodePoint = rightCodePoints[index]
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1
  }

  if (leftCodePoints.length === rightCodePoints.length) return 0
  return leftCodePoints.length < rightCodePoints.length ? -1 : 1
}

export function canonicalTrustJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function verifyCanonicalSignature(value: unknown, signature: string, publicKey: string): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalTrustJson(value), 'utf8'),
      createPublicKey(publicKey),
      Buffer.from(signature, 'base64')
    )
  } catch {
    return false
  }
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new RegistryTrustError('TRUST_METADATA_INVALID', `${field} is not a valid timestamp`)
  }
  return parsed
}

export interface VerifyRegistryPackageTrustInput {
  envelope: RegistryPackageEnvelope
  envelopeSignature: string | null | undefined
  trustMetadata: RegistryTrustMetadata
  trustMetadataSignature: string | null | undefined
  pinnedRootKey: string | null
  expected: Pick<
    RegistryPackageEnvelope,
    'artifactDigest' | 'packageId' | 'version' | 'target' | 'publisherId'
  >
  /** Host-derived target; the Registry response cannot choose this value. */
  expectedHostTarget?: string
  now?: Date
  /** D3: the user chose to keep using this expired testplace artifact. Only
   * the expiry check is skipped; it runs after every other check, so a
   * blocked package or a bad signature is still refused. */
  allowExpiredTestplace?: boolean
}

export interface VerifiedRegistryPackageTrust {
  publisherId: string
  keyId: string
  /** Set when an expired testplace artifact was allowed (allowExpiredTestplace). */
  expired?: true
}

export function verifyRegistryTrustMetadata(
  metadata: RegistryTrustMetadata,
  metadataSignature: string | null | undefined,
  pinnedRootKey: string | null,
  nowValue: Date = new Date()
): void {
  try {
    assertRegistryTrustMetadataShape(metadata)
  } catch (error) {
    throw new RegistryTrustError(
      'TRUST_METADATA_INVALID',
      error instanceof Error ? error.message : String(error)
    )
  }
  if (!pinnedRootKey) {
    throw new RegistryTrustError('TRUST_METADATA_INVALID', 'no pinned registry root is configured')
  }
  if (!metadataSignature) {
    throw new RegistryTrustError(
      'TRUST_METADATA_INVALID',
      'root-signed registry trust metadata is required'
    )
  }
  if (!verifyCanonicalSignature(metadata, metadataSignature, pinnedRootKey)) {
    throw new RegistryTrustError(
      'TRUST_METADATA_INVALID',
      'registry trust metadata signature failed verification against the pinned root'
    )
  }
  const now = nowValue.getTime()
  const generatedAt = timestamp(metadata.generatedAt, 'trust metadata generatedAt')
  const expiresAt = timestamp(metadata.expiresAt, 'trust metadata expiresAt')
  if (generatedAt > now || expiresAt < now || expiresAt <= generatedAt) {
    throw new RegistryTrustError('TRUST_METADATA_INVALID', 'registry trust metadata is expired')
  }
  if (
    metadata.schemaVersion !== 1 ||
    !['official', 'self-hosted-dev'].includes(metadata.registryProfile) ||
    !/^sha256:[0-9a-f]{64}$/.test(metadata.rootFingerprint)
  ) {
    throw new RegistryTrustError(
      'TRUST_METADATA_INVALID',
      'registry trust profile or informational root fingerprint is invalid'
    )
  }
}

export function verifyRegistryPackageTrust(
  input: VerifyRegistryPackageTrustInput
): VerifiedRegistryPackageTrust {
  try {
    assertRegistryPackageEnvelopeShape(input.envelope)
  } catch (error) {
    throw new RegistryTrustError(
      'TRUST_METADATA_INVALID',
      error instanceof Error ? error.message : String(error)
    )
  }
  const now = (input.now ?? new Date()).getTime()
  verifyRegistryTrustMetadata(
    input.trustMetadata,
    input.trustMetadataSignature,
    input.pinnedRootKey,
    input.now
  )

  for (const field of [
    'artifactDigest',
    'packageId',
    'version',
    'target',
    'publisherId',
  ] as const) {
    if (input.envelope[field] !== input.expected[field]) {
      throw new RegistryTrustError(
        'IDENTITY_MISMATCH',
        `registry envelope ${field} does not match the requested package`
      )
    }
  }

  if (input.envelope.schemaVersion !== 1) {
    throw new RegistryTrustError('TRUST_METADATA_INVALID', 'unsupported registry trust schema')
  }
  const channel = input.envelope.channel
  if (channel !== undefined && !REGISTRY_RELEASE_CHANNELS.has(channel)) {
    throw new RegistryTrustError('CHANNEL_UNSUPPORTED', `unknown release channel '${channel}'`)
  }
  if ((channel === 'testplace') !== (input.envelope.expiresAt !== undefined)) {
    throw new RegistryTrustError(
      'CHANNEL_UNSUPPORTED',
      'a registry envelope carries expiresAt exactly when its channel is testplace'
    )
  }
  const expiresAt =
    input.envelope.expiresAt === undefined
      ? null
      : timestamp(input.envelope.expiresAt, 'registry envelope expiresAt')
  assertPluginTargetCompatible(
    input.envelope.target,
    input.expectedHostTarget ?? currentPluginHostTarget()
  )
  if (!input.envelopeSignature) {
    throw new RegistryTrustError('SIGNATURE_REQUIRED', 'registry package signature is required')
  }

  const signer = input.trustMetadata.signers.find(
    (candidate) => candidate.keyId === input.envelope.keyId
  )
  if (!signer) {
    throw new RegistryTrustError(
      'SIGNER_UNKNOWN',
      `unknown registry signer '${input.envelope.keyId}'`
    )
  }
  if (signer.status === 'revoked') {
    throw new RegistryTrustError(
      'SIGNER_REVOKED',
      `registry signer '${signer.keyId}' is revoked`
    )
  }

  const signedAt = timestamp(input.envelope.signedAt, 'registry envelope signedAt')
  const notBefore = timestamp(signer.notBefore, 'registry signer notBefore')
  const notAfter = timestamp(signer.notAfter, 'registry signer notAfter')
  if (signer.status === 'expired' && signedAt > notAfter) {
    throw new RegistryTrustError(
      'SIGNER_INVALID',
      `expired signer '${signer.keyId}' cannot sign a new artifact`
    )
  }
  if (signedAt < notBefore || signedAt > notAfter || signedAt > now) {
    throw new RegistryTrustError(
      'SIGNER_INVALID',
      `registry signer '${signer.keyId}' signature is outside its validity window`
    )
  }

  if (input.trustMetadata.blockedPublishers.includes(input.envelope.publisherId)) {
    throw new RegistryTrustError(
      'PUBLISHER_BLOCKED',
      `publisher '${input.envelope.publisherId}' is blocked`
    )
  }
  if (
    input.trustMetadata.blockedPackages.some(
      (blocked) =>
        blocked.packageId === input.envelope.packageId &&
        (blocked.version === undefined || blocked.version === input.envelope.version)
    )
  ) {
    throw new RegistryTrustError(
      'PACKAGE_BLOCKED',
      `package '${input.envelope.packageId}@${input.envelope.version}' is blocked`
    )
  }

  if (!verifyCanonicalSignature(input.envelope, input.envelopeSignature, signer.publicKey)) {
    throw new RegistryTrustError(
      'REGISTRY_SIGNATURE_INVALID',
      'registry signature failed verification against the authorized signer'
    )
  }
  // Checked after the signature, so only a Registry-signed expiry counts.
  if (expiresAt !== null && expiresAt <= now) {
    if (input.allowExpiredTestplace === true) {
      return { publisherId: input.envelope.publisherId, keyId: signer.keyId, expired: true }
    }
    throw new RegistryTrustError(
      'TESTPLACE_EXPIRED',
      `testplace version '${input.envelope.packageId}@${input.envelope.version}' expired at ${input.envelope.expiresAt}`
    )
  }

  return { publisherId: input.envelope.publisherId, keyId: signer.keyId }
}

export interface VerifyRegistryDisclosureInput {
  /** Wire values from the Registry version row; all three or none. */
  disclosure: unknown
  disclosureEnvelope: unknown
  disclosureSignature: unknown
  /** The version row's `scan`: bound by the envelope's `scanDigest`. */
  scan: unknown
  /** The package envelope and trust metadata, both already verified by
   * verifyRegistryPackageTrust. */
  packageEnvelope: RegistryPackageEnvelope
  trustMetadata: RegistryTrustMetadata
}

export interface VerifiedRegistryDisclosure {
  disclosure: ManifestDisclosure
  /** The signed scan report, or null when the envelope's scanDigest is null. */
  scan: ScanReport | null
}

const HEX_DIGEST = /^[0-9a-f]{64}$/

const sha256Canonical = (value: unknown): string =>
  createHash('sha256').update(canonicalContractJson(value), 'utf8').digest('hex')

/** Verify the disclosure envelope of an already verified package envelope
 * (contract 3.5, D-b step 2). Returns the signed disclosure and scan report,
 * or null when the version carries no disclosure envelope at all (published
 * before D-a). The caller still compares the disclosure with the one
 * recomputed from the package; the scan cannot be recomputed and is trusted
 * only through the Registry signature over its digest. */
export function verifyRegistryDisclosure(
  input: VerifyRegistryDisclosureInput
): VerifiedRegistryDisclosure | null {
  const present = [input.disclosure, input.disclosureEnvelope, input.disclosureSignature].filter(
    (value) => value !== null && value !== undefined
  ).length
  if (present === 0) return null
  const invalid = (reason: string): RegistryTrustError =>
    new RegistryTrustError('DISCLOSURE_INVALID', `registry disclosure ${reason}; the install was refused`)
  if (present !== 3) throw invalid('is incomplete (disclosure, envelope and signature must come together)')

  let envelope: RegistryDisclosureEnvelope
  try {
    const value = requireTrustObject(input.disclosureEnvelope, 'registry disclosure envelope')
    assertExactTrustFields(value, 'registry disclosure envelope', DISCLOSURE_ENVELOPE_FIELDS)
    if (value.schemaVersion !== 1) throw new Error('registry disclosure envelope schemaVersion is unsupported')
    for (const field of DISCLOSURE_ENVELOPE_FIELDS.slice(1)) {
      if (field === 'scanDigest' && value[field] === null) continue
      requiredString(value[field], `registry disclosure envelope.${field}`)
    }
    if (!HEX_DIGEST.test(value.disclosureDigest as string)) {
      throw new Error('registry disclosure envelope.disclosureDigest is invalid')
    }
    if (value.scanDigest !== null && !HEX_DIGEST.test(value.scanDigest as string)) {
      throw new Error('registry disclosure envelope.scanDigest is invalid')
    }
    envelope = value as unknown as RegistryDisclosureEnvelope
  } catch (error) {
    throw invalid(`envelope is malformed (${error instanceof Error ? error.message : String(error)})`)
  }
  for (const field of ['artifactDigest', 'packageId', 'version', 'target', 'keyId'] as const) {
    if (envelope[field] !== input.packageEnvelope[field]) {
      throw invalid(`envelope ${field} does not match the package envelope`)
    }
  }
  const signer = input.trustMetadata.signers.find((candidate) => candidate.keyId === envelope.keyId)
  if (
    !signer ||
    typeof input.disclosureSignature !== 'string' ||
    !verifyCanonicalSignature(envelope, input.disclosureSignature, signer.publicKey)
  ) {
    throw invalid('signature failed verification against the package signer')
  }
  if (typeof input.disclosure !== 'object' || Array.isArray(input.disclosure)) {
    throw invalid('is not an object')
  }
  let spelling: string
  try {
    spelling = canonicalContractJson(input.disclosure)
  } catch {
    throw invalid('has no canonical spelling')
  }
  if (createHash('sha256').update(spelling, 'utf8').digest('hex') !== envelope.disclosureDigest) {
    throw invalid('does not match its signed digest')
  }
  const scan = input.scan ?? null
  if (envelope.scanDigest === null) {
    if (scan !== null) throw invalid('carries a scan report its envelope does not sign')
    return { disclosure: input.disclosure as ManifestDisclosure, scan: null }
  }
  if (typeof scan !== 'object' || scan === null || Array.isArray(scan)) {
    throw invalid('envelope signs a scan report that is missing')
  }
  let scanSpelling: string
  try {
    scanSpelling = sha256Canonical(scan)
  } catch {
    throw invalid('scan report has no canonical spelling')
  }
  if (scanSpelling !== envelope.scanDigest) throw invalid('scan report does not match its signed digest')
  const report = scan as Record<string, unknown>
  if (report.artifactDigest !== envelope.artifactDigest || report.target !== envelope.target) {
    throw invalid('scan report describes another artifact')
  }
  return { disclosure: input.disclosure as ManifestDisclosure, scan: scan as ScanReport }
}
