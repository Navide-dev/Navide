// Local trust record for plugins installed from a file or folder (DX report
// F0, card K1). A Registry install is trusted because the Registry root key
// signed it; a local install is trusted only because the user consented to an
// exact content digest at a point in time. Load-time verification compares
// every file in the installed copy against that record.
//
// Threat level: the record lives in userData. Anyone who can write userData
// can forge it, exactly as they can forge a Registry receipt's surroundings.
// It is not stronger than the Registry path and must never be described as
// "verified".
//
// The record is stored outside the package directory, at a path the caller
// chooses, so the package copy holds author files only and every extra file
// counts as modified content.

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LocalPluginSource } from '../../shared/pluginSource'
import type { RegistryTrustSnapshot } from './pluginInstalledTrust'
import { parseInstalledManifest, parseManifestJson, type InstalledManifest } from './pluginManifest'
import { verifyRegistryTrustMetadata } from './pluginRegistryTrust'
import { assertExactTrustFields, readHostTrustJsonObject, requireTrustObject } from './pluginTrustJson'
import { isOfficialPluginId, sha256Hex } from './pluginVerify'

const LOCAL_TRUST_RECORD_LABEL = 'local trust record'

export interface PluginLocalTrustRecord {
  schemaVersion: 1
  id: string
  version: string
  /** sha256 hex over the sorted `path\0fileDigest\n` lines of `fileDigests`. */
  contentDigest: string
  /** Every regular file in the installed package copy: relative POSIX path
   * to sha256 hex of its bytes. */
  fileDigests: Record<string, string>
  /** ISO-8601 time the user consented to this digest. */
  consentedAt: string
  /** How the package arrived: a `.vsix` file or a developer folder. */
  source: 'file' | 'folder'
  /** Publisher signature evidence. Always null until `local-signed` (A3). */
  signer: null
}

/** Stable refusal codes; tests and UI key off these, never the message text. */
export type PluginLocalTrustErrorCode =
  | 'LOCAL_TRUST_RECORD_INVALID'
  | 'LOCAL_IDENTITY_MISMATCH'
  | 'LOCAL_CONTENT_MODIFIED'
  | 'LOCAL_RESERVED_ID'

/** Takedown codes: the package verified but Navide has blocked it. */
export type PluginLocalBlockedCode = 'LOCAL_PUBLISHER_BLOCKED' | 'LOCAL_PACKAGE_BLOCKED'

export type PluginLocalTrustDecision =
  | {
      action: 'allow'
      source: LocalPluginSource
      contentDigest: string
      /** False when no root-signed trust metadata was available, so the
       * takedown list could not be checked. */
      blocklistChecked: boolean
    }
  | { action: 'quarantine'; code: PluginLocalTrustErrorCode; reason: string }
  | { action: 'blocked'; code: PluginLocalBlockedCode; reason: string }

/** The Registry trust a local install consults for the takedown list only.
 * `InstalledRegistryTrustContext` satisfies it, so callers pass the same
 * object they pass to the Registry verifier. */
export interface PluginLocalTrustContext {
  pinnedRootKey: string | null
  snapshot: RegistryTrustSnapshot | null
  now?: Date
}

class LocalTrustError extends Error {
  constructor(
    readonly code: PluginLocalTrustErrorCode,
    message: string
  ) {
    super(message)
  }
}

function readManifest(packageDir: string): InstalledManifest {
  return parseInstalledManifest(parseManifestJson(readFileSync(join(packageDir, 'manifest.json'), 'utf8')))
}

/** Every regular file under `packageDir`, sorted, as relative POSIX paths.
 * A symlink or any other entry type is refused. */
function hashPackageFiles(packageDir: string): Record<string, string> {
  const digests: Array<[string, string]> = []
  const visit = (relative: string): void => {
    const entries = readdirSync(join(packageDir, relative), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      const stat = lstatSync(join(packageDir, child))
      if (stat.isSymbolicLink()) throw new Error(`installed package contains symlink: ${child}`)
      if (stat.isDirectory()) visit(child)
      else if (stat.isFile()) digests.push([child, sha256Hex(readFileSync(join(packageDir, child)))])
      else throw new Error(`installed package contains unsafe entry: ${child}`)
    }
  }
  visit('')
  digests.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(digests)
}

function digestOfFiles(fileDigests: Record<string, string>): string {
  const lines = Object.keys(fileDigests)
    .sort()
    .map((path) => `${path}\0${fileDigests[path]}\n`)
    .join('')
  return createHash('sha256').update(lines, 'utf8').digest('hex')
}

function parseRecord(path: string): PluginLocalTrustRecord {
  const raw = readHostTrustJsonObject(path, LOCAL_TRUST_RECORD_LABEL)
  assertExactTrustFields(raw, LOCAL_TRUST_RECORD_LABEL, [
    'schemaVersion',
    'id',
    'version',
    'contentDigest',
    'fileDigests',
    'consentedAt',
    'source',
    'signer',
  ])
  const files = requireTrustObject(raw.fileDigests, `${LOCAL_TRUST_RECORD_LABEL}.fileDigests`)
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.id !== 'string' ||
    typeof raw.version !== 'string' ||
    typeof raw.contentDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(raw.contentDigest) ||
    typeof raw.consentedAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.consentedAt)) ||
    (raw.source !== 'file' && raw.source !== 'folder') ||
    raw.signer !== null ||
    Object.values(files).some((digest) => typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))
  ) {
    throw new Error(`malformed ${LOCAL_TRUST_RECORD_LABEL}`)
  }
  const record = raw as unknown as PluginLocalTrustRecord
  if (digestOfFiles(record.fileDigests) !== record.contentDigest) {
    throw new Error(`${LOCAL_TRUST_RECORD_LABEL} content digest does not match its file list`)
  }
  return record
}

/** Read and validate a stored record. Throws on any malformation. */
export function readLocalTrustRecord(path: string): PluginLocalTrustRecord {
  return parseRecord(path)
}

/**
 * Build the record for a package copy the user is consenting to now. Call it
 * on the copy already placed in the plugin root, never on the path the user
 * picked, so later verification compares the same bytes.
 */
export function createLocalTrustRecord(
  packageDir: string,
  consent: { source: 'file' | 'folder'; consentedAt: string }
): PluginLocalTrustRecord {
  const manifest = readManifest(packageDir)
  if (isOfficialPluginId(manifest.id)) {
    throw new Error(`plugin '${manifest.id}' claims the official 'navide.' namespace; only the Official Registry can install it`)
  }
  const fileDigests = hashPackageFiles(packageDir)
  return {
    schemaVersion: 1,
    id: manifest.id,
    version: manifest.version,
    contentDigest: digestOfFiles(fileDigests),
    fileDigests,
    consentedAt: consent.consentedAt,
    source: consent.source,
    signer: null,
  }
}

/** Persist a record atomically, owner-only. */
export function writeLocalTrustRecord(path: string, record: PluginLocalTrustRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 })
  renameSync(temporary, path)
}

/** The takedown list from root-signed metadata, or null when there is none.
 * Freshness is not required: an expired list that the pinned root signed is
 * still evidence of a takedown, and applying it can only disable more. */
function rootSignedTakedownList(
  trust: PluginLocalTrustContext
): Pick<RegistryTrustSnapshot['metadata'], 'blockedPublishers' | 'blockedPackages'> | null {
  if (!trust.snapshot) return null
  const { metadata, metadataSignature } = trust.snapshot
  try {
    const generatedAt = new Date(Date.parse(metadata.generatedAt))
    verifyRegistryTrustMetadata(metadata, metadataSignature, trust.pinnedRootKey, generatedAt)
    return metadata
  } catch {
    return null
  }
}

/**
 * Fail-closed load-time verifier for a locally installed package. The Registry
 * authority rule does not apply here, so a local install and a Marketplace
 * install never quarantine each other; the `navide.` namespace rule and the
 * Registry takedown list do apply.
 */
export function verifyLocalPackage(
  packageDir: string,
  expectedPackageId: string,
  recordPath: string,
  trust: PluginLocalTrustContext,
  source: LocalPluginSource = 'local-unsigned'
): PluginLocalTrustDecision {
  try {
    if (isOfficialPluginId(expectedPackageId)) {
      throw new LocalTrustError(
        'LOCAL_RESERVED_ID',
        `plugin '${expectedPackageId}' claims the official 'navide.' namespace; only the Official Registry can install it`
      )
    }
    let record: PluginLocalTrustRecord
    try {
      record = parseRecord(recordPath)
    } catch (error) {
      throw new LocalTrustError(
        'LOCAL_TRUST_RECORD_INVALID',
        error instanceof Error ? error.message : String(error)
      )
    }
    let manifest: InstalledManifest
    try {
      manifest = readManifest(packageDir)
    } catch (error) {
      throw new LocalTrustError(
        'LOCAL_CONTENT_MODIFIED',
        error instanceof Error ? error.message : String(error)
      )
    }
    if (isOfficialPluginId(manifest.id)) {
      throw new LocalTrustError(
        'LOCAL_RESERVED_ID',
        `plugin '${manifest.id}' claims the official 'navide.' namespace; only the Official Registry can install it`
      )
    }
    if (
      record.id !== expectedPackageId ||
      manifest.id !== expectedPackageId ||
      record.version !== manifest.version
    ) {
      throw new LocalTrustError(
        'LOCAL_IDENTITY_MISMATCH',
        'local trust record identity does not match the installed package'
      )
    }
    let installed: Record<string, string>
    try {
      installed = hashPackageFiles(packageDir)
    } catch (error) {
      throw new LocalTrustError(
        'LOCAL_CONTENT_MODIFIED',
        error instanceof Error ? error.message : String(error)
      )
    }
    if (digestOfFiles(installed) !== record.contentDigest) {
      throw new LocalTrustError(
        'LOCAL_CONTENT_MODIFIED',
        'installed package content does not match what the user consented to'
      )
    }

    const takedown = rootSignedTakedownList(trust)
    if (takedown) {
      // A Manifest v1 file may declare a publisher other than its id
      // namespace, and nothing local vouches for either, so both are checked.
      const publisherIds = [manifest.id.split('.')[0], ...(manifest.publisher ? [manifest.publisher] : [])]
      const blockedPublisher = publisherIds.find((publisherId) =>
        takedown.blockedPublishers.includes(publisherId)
      )
      if (blockedPublisher !== undefined) {
        return {
          action: 'blocked',
          code: 'LOCAL_PUBLISHER_BLOCKED',
          reason: `taken down by Navide: publisher '${blockedPublisher}' is blocked`,
        }
      }
      if (
        takedown.blockedPackages.some(
          (blocked) =>
            blocked.packageId === manifest.id &&
            (blocked.version === undefined || blocked.version === manifest.version)
        )
      ) {
        return {
          action: 'blocked',
          code: 'LOCAL_PACKAGE_BLOCKED',
          reason: `taken down by Navide: package '${manifest.id}@${manifest.version}' is blocked`,
        }
      }
    }
    return {
      action: 'allow',
      source,
      contentDigest: record.contentDigest,
      blocklistChecked: takedown !== null,
    }
  } catch (error) {
    if (error instanceof LocalTrustError) {
      return { action: 'quarantine', code: error.code, reason: error.message }
    }
    return {
      action: 'quarantine',
      code: 'LOCAL_CONTENT_MODIFIED',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
