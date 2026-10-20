// Plugin install / update / remove orchestration for the main process.
//
// The security-critical chain (download → digest → signature → capability
// scope → zip-slip-guarded unpack) is delegated to the pure, unit-tested
// `pluginVerify` + `pluginPackage` + `installedPlugins` modules; this file is
// the thin I/O shell that wires them to the network and the filesystem. Every
// side-effecting dependency (network download, fs writes) is injectable so the
// whole flow can be driven in tests without a real registry or disk.
//
// Install is split into prepare → commit so the UI can interpose a trust
// confirmation (sensitive `fs`/`aiCli`/`shell` capabilities) AFTER verification but
// BEFORE anything is written to disk.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  isDigestBlocked,
  localSignatureDecision,
  type LocalInstallTrustMetadata,
  type LocalSignatureDecision,
} from './pluginLocalInstallTrust'
import { dirname, extname, join } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'
import { isWindows } from '../../shared/osplat'
import { canonicalArchivePath, portableArchiveCollisionKey } from './pluginPathPolicy'
import {
  verifyPackage,
  assertSafeArchiveEntries,
  assertOfficialPublisher,
  isOfficialPluginId,
  resolveOfficialPublisherKey,
  sha256Hex,
  PluginVerifyError,
  TRUST_SIGNED,
  type TrustTier,
} from './pluginVerify'
import {
  RegistryTrustError,
  verifyRegistryDisclosure,
  verifyRegistryPackageTrust,
  verifyRegistryTrustMetadata,
  type RegistryAuthority,
  type RegistryPackageEnvelope,
  type RegistryTrustMetadata,
} from './pluginRegistryTrust'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
  assertRegistryTrustSnapshotDoesNotRollback,
  registryReceiptFromEvidence,
  writeRegistryTrustSnapshot,
  type RegistryInstallReceipt,
  type RegistryTrustSnapshot,
} from './pluginInstalledTrust'
import { readZipEntries, readManifestFromEntries, type ZipEntry } from './pluginPackage'
import {
  parseInstalledManifest,
  assertManifestFiles,
  isManifestV2,
  manifestCapabilities,
  manifestToDescriptor,
  backendEntryOnDisk,
  OFFICIAL_RECEIPT_NAME,
  type InstalledManifest,
  type OfficialReceipt,
} from './installedPlugins'
import { compareSemver } from './pluginManifestV2'
import {
  canonicalContractJson,
  computeDisclosure,
  type DisclosureManifestInput,
  type ManifestDisclosure,
} from '../../shared/pluginDisclosure'
import type { ScanReport } from '../../shared/pluginDisclosureScan'
import type { LocalPluginSource } from '../../shared/pluginSource'
import type { PluginLaunchDescriptor } from './frontendPluginManager'
import { UNIVERSAL_PLUGIN_TARGET, currentPluginHostTarget } from './pluginTarget'
import {
  PLUGIN_QUARANTINE_DIR,
  PLUGIN_QUARANTINE_MARKER,
  PLUGIN_STAGING_DIR,
} from './pluginInstallPaths'
import { immutablePluginPackageDir, PluginActivationSelector } from './pluginActivationSelector'

/** What a caller must supply to install a specific marketplace version. The
 *  trusted `expectedDigest` and (optional) signature material come from the
 *  registry's extension-detail API, fetched by the caller before installing. */
export interface InstallRequest {
  registryUrl: string
  namespace: string
  name: string
  version: string
  /** sha256 hex from the version's `package_digest` (trusted metadata). */
  expectedDigest: string
  /** Detached base64 Ed25519 signature, when available (else omitted). */
  signature?: string | null
  /** Publisher PEM public key, when available (else omitted). */
  publicKey?: string | null
  /** Trust tier the registry recorded (`signed-verified`/`unsigned`). */
  claimedTrustTier?: string | null
  /** Registry-selected artifact target bound into the signed envelope. */
  target?: string | null
  /** Registry-owned signing evidence for Manifest v2 packages. */
  registryEnvelope?: RegistryPackageEnvelope | null
  registrySignature?: string | null
  trustMetadata?: RegistryTrustMetadata | null
  trustMetadataSignature?: string | null
  /** Registry-signed disclosure (contract 3.5): the version row's
   * `disclosure`, `disclosure_envelope` and `disclosure_signature`, as
   * received. All absent for a version published before the Registry signed
   * disclosures; that version installs as before. */
  disclosure?: unknown
  disclosureEnvelope?: unknown
  disclosureSignature?: unknown
  /** The version row's `scan` (contract 3.8), bound by `scanDigest`. */
  scan?: unknown
  /** Install provenance selected by the Host, never inferred from schemaVersion. */
  provenance: 'official-registry' | 'developer-local-unpacked'
}

export interface InstallerTrustConfig {
  /** Host-owned root pin. It is never accepted from a package or registry response. */
  pinnedRegistryRootKey: string | null
  /** Host-derived authority. Registry response metadata cannot upgrade this. */
  registryAuthority?: RegistryAuthority
  /** Normalized App-pinned Official Registry URL, when configured. */
  officialRegistryUrl?: string
  now?: Date
  /** Host-derived exact target used for Registry artifact compatibility. */
  expectedTarget?: string
}

const DEFAULT_INSTALLER_TRUST: InstallerTrustConfig = {
  pinnedRegistryRootKey: null,
  registryAuthority: 'self-hosted',
}

const HOST_OWNED_ARCHIVE_NAMES = new Set([
  OFFICIAL_RECEIPT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
  '.navide-backend-activation.json',
  PLUGIN_QUARANTINE_MARKER,
].map((name) => portableArchiveCollisionKey(name)!))

export { PLUGIN_QUARANTINE_DIR, PLUGIN_STAGING_DIR } from './pluginInstallPaths'

/** A downloaded, verified package ready to commit to disk. */
export interface PreparedInstall {
  id: string
  version: string
  publisherId: string
  manifest: InstalledManifest
  entries: ZipEntry[]
  trustTier: TrustTier
  sensitive: string[]
  /** True when the verified package contains a declared backend executable. */
  containsBackendExecutable: boolean
  /** True when the plugin declares a sensitive capability or contains native
   *  backend code and the UI must obtain confirmation before commit. */
  requiresConfirmation: boolean
  /** True only for a `navide.` package that passed the Host-authorized
   *  Official Registry gate (or the legacy v1 publisher pin). Drives trusted
   *  registration without treating a self-hosted Registry as first-party. */
  official: boolean
  /** Verified sha256 hex digest of the package bytes (receipt material). */
  digest: string
  /** Detached signature over the digest, when present (receipt material). */
  signature: string | null
  /** Host-generated Registry evidence retained for every Registry v1/v2
   * package. Never feed this envelope signature into the legacy digest receipt. */
  registryEvidence?: {
    artifact: Uint8Array
    receipt: RegistryInstallReceipt
    trustSnapshot: RegistryTrustSnapshot
  }
  provenance: 'official-registry' | 'developer-local-unpacked'
  /** The Registry-signed disclosure, verified against the package's own
   * manifest; null when the version carries none. */
  disclosure?: ManifestDisclosure | null
  /** The Registry-signed scan report (contract 3.8); null when the version
   * has none. Informational: it never decides the install. */
  scan?: ScanReport | null
  /** Set only by prepareLocalInstall: a package the user picked from a file,
   * trusted by the user's consent to its content and never by the Registry. */
  source?: LocalPluginSource
  /** The Host target a local package is staged under; Registry packages take
   * theirs from the signed receipt instead. */
  localTarget?: string
  /** False when no root-signed takedown list was available, so the package
   * could not be checked against it (MED-1 on #425). */
  takedownChecked?: boolean
  /** Set only by prepareLocalInstall: what the `<file>.sig` beside the file
   * shows against the vetted publisher keys (A3). */
  localSignature?: LocalSignatureDecision
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

/** Injectable side-effects (network + filesystem) so the flow is testable. */
export interface InstallerDeps {
  /** Fetch a package blob + the registry's `X-Package-Digest` header. */
  download(url: string): Promise<{ bytes: Uint8Array; digestHeader: string | null }>
  mkdirp(dir: string): void
  writeFile(path: string, data: Uint8Array): void
  readFile(path: string): Uint8Array | null
  /** Atomic Host-owned Registry trust snapshot persistence. */
  writeRegistryTrustSnapshot?: typeof writeRegistryTrustSnapshot
  /** Apply a controlled mode after writing the declared backend executable. */
  chmod(path: string, mode: number): void
  rmrf(dir: string): void
  /** Atomic directory move used by the production install transaction. */
  rename?(from: string, to: string): void
  pathExists?(path: string): boolean
  /** Durably flush a directory after package staging or a directory rename. */
  syncDirectory?(path: string): void
}

/** Default deps: global `fetch` (Electron main / Node 18+) + `node:fs`. */
export const defaultInstallerDeps: InstallerDeps = {
  async download(url) {
    const res = await fetch(url)
    if (!res.ok) throw new InstallError(`download failed: HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { bytes, digestHeader: res.headers.get('x-package-digest') }
  },
  mkdirp(dir) {
    mkdirSync(dir, { recursive: true })
  },
  writeFile(path, data) {
    writeFileSync(path, data)
    fsyncFileSync(path)
  },
  readFile(path) {
    try {
      return new Uint8Array(readFileSync(path))
    } catch {
      return null
    }
  },
  writeRegistryTrustSnapshot,
  chmod(path, mode) {
    chmodSync(path, mode)
  },
  rmrf(dir) {
    rmSync(dir, { recursive: true, force: true })
  },
  rename(from, to) {
    renameSync(from, to)
  },
  pathExists(path) {
    return existsSync(path)
  },
  syncDirectory(path) {
    syncDirectorySync(path)
  },
}

function downloadUrl(req: InstallRequest): string {
  const base = req.registryUrl.replace(/\/+$/, '')
  const url = `${base}/api/extensions/${req.namespace}/${req.name}/${req.version}/download`
  // A platform build is one of several artifacts of its version; a universal
  // version has exactly one, which the Registry serves without a target.
  return req.target && req.target !== UNIVERSAL_PLUGIN_TARGET
    ? `${url}?target=${encodeURIComponent(req.target)}`
    : url
}

function canonicalEntryPath(entry: ZipEntry): string {
  const path = canonicalArchivePath(
    entry.path,
    entry.type === 'directory' ? 'directory' : 'regular'
  )
  if (path === null) throw new InstallError(`unsafe archive entry path: ${entry.path}`)
  return path
}

function startsWithExecutableShebang(data: Uint8Array): boolean {
  const offset = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0
  return data[offset] === 0x23 && data[offset + 1] === 0x21
}

/** Validate the narrow Issue 02 POSIX executable contract. Exact binary
 * format and OS/architecture validation remain owned by Issue 27.
 *
 * The archive entry looked up is the one `backendEntryOnDisk` will run after
 * install — on Windows a bare manifest entry names the `.exe` beside it — so
 * a package that loads once installed is also one that installs. */
function assertBackendExecutable(
  manifest: InstalledManifest,
  entries: readonly ZipEntry[]
): string | undefined {
  if (!isManifestV2(manifest) || !manifest.backend) return undefined
  const backendPath = backendEntryOnDisk(manifest.backend.entry)
  const entry = entries.find(
    (candidate) =>
      candidate.type === 'regular' && canonicalEntryPath(candidate) === backendPath
  )
  if (!entry) {
    throw new InstallError(`backend entry is missing or not a regular file: ${backendPath}`)
  }
  if (entry.data.length === 0) {
    throw new InstallError(`backend entry is empty: ${backendPath}`)
  }
  // A zip built on Windows carries no unix mode, and the exec bit means
  // nothing to CreateProcess anyway: there the `.exe` extension the manifest
  // contract leaves as the only option is the executability check, the same
  // rule installedPlugins applies to the file on disk.
  const executable = isWindows()
    ? extname(backendPath).toLowerCase() === '.exe'
    : entry.executable
  if (!executable) {
    throw new InstallError(`backend entry is not marked executable: ${backendPath}`)
  }
  if (startsWithExecutableShebang(entry.data)) {
    throw new InstallError(
      `backend entry must be a packaged executable, not a raw script: ${backendPath}`
    )
  }
  return backendPath
}

/**
 * Download + fully verify a package WITHOUT writing anything. Runs the digest,
 * signature, and capability-scope checks, cross-checks the identity, and reads
 * the manifest. Throws on any verification failure. On success returns the
 * decoded entries and the trust facts the UI gates on.
 */
export async function prepareInstall(
  req: InstallRequest,
  deps: InstallerDeps = defaultInstallerDeps,
  trust: InstallerTrustConfig = DEFAULT_INSTALLER_TRUST
): Promise<PreparedInstall> {
  const { bytes, digestHeader } = await deps.download(downloadUrl(req))

  // The download's advertised digest, when present, must match the trusted
  // metadata digest — a mismatch means the blob was swapped mid-flight.
  if (digestHeader && digestHeader !== req.expectedDigest) {
    throw new InstallError(
      `download digest header ${digestHeader} does not match expected ${req.expectedDigest}`
    )
  }

  // Validate every archive path before reading the manifest or any later install step.
  const entries = readZipEntries(bytes)
  assertSafeArchiveEntries(entries)
  const rawManifest = readManifestFromEntries(entries)
  const manifest = parseInstalledManifest(rawManifest)
  assertManifestFiles(
    manifest,
    entries
      .filter((entry) => entry.type === 'regular')
      .map((entry) => canonicalEntryPath(entry))
  )
  const backendEntry = assertBackendExecutable(manifest, entries)
  const expectedId = `${req.namespace}.${req.name}`
  if (manifest.id !== expectedId) {
    throw new InstallError(
      `package identity ${manifest.id} does not match requested ${expectedId}`
    )
  }
  if (manifest.version !== req.version) {
    throw new InstallError(
      `package version ${manifest.version} does not match requested ${req.version}`
    )
  }

  const v2 = isManifestV2(manifest)
  const provenance = req.provenance
  if (provenance !== 'official-registry' && provenance !== 'developer-local-unpacked') {
    throw new InstallError(`plugin '${manifest.id}' is missing explicit install provenance`)
  }
  const publisherId = v2 ? manifest.publisher : manifest.publisher ?? manifest.id.split('.')[0]
  if (provenance === 'official-registry' && (!manifest.publisher || manifest.publisher !== manifest.id.split('.')[0])) {
    throw new InstallError(`Registry package '${manifest.id}' has no valid publisher identity`)
  }
  const packageVerification = verifyPackage({
    bytes,
    expectedDigest: req.expectedDigest,
    // Publisher keys and signatures are a legacy v1 compatibility path. A v2
    // package cannot self-supply the key that establishes its own trust.
    signature: v2 ? null : req.signature,
    publicKey: v2 ? null : req.publicKey,
    claimedTrustTier: req.claimedTrustTier,
    requires: manifestCapabilities(manifest),
  })
  let trustTier = packageVerification.trustTier
  let registryEvidence: PreparedInstall['registryEvidence']
  let official = false
  let disclosure: ManifestDisclosure | null = null
  let scan: ScanReport | null = null

  if (provenance === 'official-registry') {
    if (!req.registryEnvelope || !req.trustMetadata || !req.target) {
      throw new PluginVerifyError(
        'SIGNATURE_REQUIRED',
        `plugin '${manifest.id}' is missing registry signing evidence`
      )
    }
    const envelopeSignature = req.registrySignature
    const trustMetadataSignature = req.trustMetadataSignature
    if (!envelopeSignature || !trustMetadataSignature) {
      throw new PluginVerifyError(
        'SIGNATURE_REQUIRED',
        `plugin '${manifest.id}' is missing Registry signatures`
      )
    }
    verifyRegistryPackageTrust({
      envelope: req.registryEnvelope,
      envelopeSignature,
      trustMetadata: req.trustMetadata,
      trustMetadataSignature,
      pinnedRootKey: trust.pinnedRegistryRootKey,
      expected: {
        artifactDigest: packageVerification.digest,
        packageId: manifest.id,
        version: manifest.version,
        target: req.target,
        publisherId,
      },
      expectedHostTarget: trust.expectedTarget ?? currentPluginHostTarget(),
      now: trust.now,
    })
    // Contract 3.5: the signed disclosure must be what this package's own
    // manifest discloses. A version without one installs as before.
    const signed = verifyRegistryDisclosure({
      disclosure: req.disclosure,
      disclosureEnvelope: req.disclosureEnvelope,
      disclosureSignature: req.disclosureSignature,
      scan: req.scan,
      packageEnvelope: req.registryEnvelope,
      trustMetadata: req.trustMetadata,
    })
    if (signed !== null) {
      const signedDisclosure = signed.disclosure
      if (!v2) {
        throw new RegistryTrustError(
          'DISCLOSURE_INVALID',
          `plugin '${manifest.id}' is a Manifest v1 package but the Registry sent a disclosure; the install was refused`
        )
      }
      let recomputed: string | null
      try {
        recomputed = canonicalContractJson(computeDisclosure(manifest as unknown as DisclosureManifestInput))
      } catch {
        recomputed = null
      }
      if (recomputed !== canonicalContractJson(signedDisclosure)) {
        throw new RegistryTrustError(
          'DISCLOSURE_MISMATCH',
          `plugin '${manifest.id}' ${manifest.version}: what the Marketplace disclosed about this package does not match the permissions in the package itself; the install was refused`
        )
      }
      disclosure = signedDisclosure
      scan = signed.scan
    }
    const requestedRegistryUrl = new URL(req.registryUrl).toString().replace(/\/+$/, '')
    const officialRegistryUrl = trust.officialRegistryUrl
      ? new URL(trust.officialRegistryUrl).toString().replace(/\/+$/, '')
      : null
    official =
      isOfficialPluginId(manifest.id) &&
      trust.registryAuthority === 'official' &&
      officialRegistryUrl !== null &&
      requestedRegistryUrl === officialRegistryUrl &&
      req.trustMetadata.registryProfile === 'official'
    if (isOfficialPluginId(manifest.id) && !official) {
      throw new PluginVerifyError(
        'NOT_OFFICIAL',
        `plugin '${manifest.id}' claims the official 'navide.' namespace but the Host did not authorize the Official Registry`
      )
    }
    trustTier = TRUST_SIGNED
    registryEvidence = {
      artifact: bytes,
      receipt: registryReceiptFromEvidence({
        packageId: manifest.id,
        version: manifest.version,
        publisherId,
        target: req.target,
        artifactDigest: packageVerification.digest,
        envelope: req.registryEnvelope,
        envelopeSignature,
        registryAuthority: trust.registryAuthority ?? 'self-hosted',
      }),
      trustSnapshot: {
        schemaVersion: 1,
        metadata: req.trustMetadata,
        metadataSignature: trustMetadataSignature,
      },
    }
  }

  if (provenance === 'official-registry' && trustTier !== TRUST_SIGNED) {
    throw new PluginVerifyError(
      'SIGNATURE_REQUIRED',
      `plugin '${manifest.id}' is unsigned; Registry installs require a verified Registry signature`
    )
  }

  // The v2 Registry envelope binds publisherId to packageId before this point.
  // Keep the publisher-key check only for the bounded v1 compatibility path.
  if (provenance !== 'official-registry' && !v2) {
    assertOfficialPublisher(manifest.id, req.publicKey, trustTier, resolveOfficialPublisherKey())
    official = isOfficialPluginId(manifest.id)
  }

  return {
    id: manifest.id,
    version: manifest.version,
    publisherId,
    manifest,
    entries,
    trustTier,
    sensitive: packageVerification.sensitive,
    containsBackendExecutable: backendEntry !== undefined,
    requiresConfirmation:
      packageVerification.sensitive.length > 0 || backendEntry !== undefined,
    official,
    digest: packageVerification.digest,
    signature: v2 ? req.registrySignature ?? null : req.signature ?? null,
    registryEvidence,
    provenance,
    disclosure,
    scan,
  }
}

export interface LocalInstallTrust {
  /** The Host-owned root pin the takedown list must be signed by. */
  pinnedRegistryRootKey: string | null
  /** The last Registry trust metadata this Host stored, if any. */
  trustSnapshot: RegistryTrustSnapshot | null
  /** Host-derived exact target a native backend must have been built for. */
  expectedTarget?: string
  /** The root-verified local install trust (blocked digests, vetted
   * publisher keys), or null when none was available. */
  localInstallTrust?: LocalInstallTrustMetadata | null
  /** The `<file>.sig` read beside the file, or null when there is none. */
  signature?: string | null
}

/** The takedown list, when the pinned root signed it. An expired list still
 * applies: a takedown does not lapse because the Host went offline. */
function signedTakedownList(trust: LocalInstallTrust): RegistryTrustMetadata | null {
  const snapshot = trust.trustSnapshot
  if (!snapshot) return null
  try {
    // Checked as of its own generation time, so expiry is not a reason to
    // ignore it; shape and the root signature are still verified.
    verifyRegistryTrustMetadata(
      snapshot.metadata,
      snapshot.metadataSignature,
      trust.pinnedRegistryRootKey,
      new Date(snapshot.metadata.generatedAt),
    )
    return snapshot.metadata
  } catch {
    return null
  }
}

/**
 * Verify a `.vsix` the user picked from a file (DX report A1, card K3)
 * WITHOUT writing anything. `bytes` is the one copy read right after the file
 * dialog; every later step uses it, never the path. The archive goes through
 * the same zip checks, manifest schema and backend executable rules as a
 * Registry install. What it does not get is Registry evidence: there is no
 * review, so the user's consent is always required. It is labelled
 * `local-signed` only when a vetted publisher's active key signed exactly
 * these bytes (A3, `localSignature`); a file on the root-signed
 * blocked-digest list is refused.
 */
export function prepareLocalInstall(bytes: Uint8Array, trust: LocalInstallTrust): PreparedInstall {
  const entries = readZipEntries(bytes)
  assertSafeArchiveEntries(entries)
  const manifest = parseInstalledManifest(readManifestFromEntries(entries))
  assertManifestFiles(
    manifest,
    entries
      .filter((entry) => entry.type === 'regular')
      .map((entry) => canonicalEntryPath(entry))
  )
  if (!isManifestV2(manifest)) {
    throw new InstallError(`plugin '${manifest.id}' is a Manifest v1 package; only Manifest v2 installs from a file`)
  }
  if (isOfficialPluginId(manifest.id)) {
    throw new PluginVerifyError(
      'NOT_OFFICIAL',
      `plugin '${manifest.id}' claims the official 'navide.' namespace; it cannot be installed from a file`
    )
  }
  // The same identity rule a Registry package meets, so the publisher a
  // takedown names cannot be dodged by a mismatched namespace.
  if (manifest.publisher !== manifest.id.split('.')[0]) {
    throw new InstallError(`plugin '${manifest.id}' has no valid publisher identity`)
  }
  const backendEntry = assertBackendExecutable(manifest, entries)
  const takedown = signedTakedownList(trust)
  if (takedown?.blockedPublishers.includes(manifest.publisher)) {
    throw new InstallError(`publisher '${manifest.publisher}' was taken down by Navide; '${manifest.id}' cannot be installed`)
  }
  if (takedown?.blockedPackages.some((blocked) =>
    blocked.packageId === manifest.id && (blocked.version === undefined || blocked.version === manifest.version))) {
    throw new InstallError(`plugin '${manifest.id}' ${manifest.version} was taken down by Navide and cannot be installed`)
  }
  const digest = sha256Hex(bytes)
  if (isDigestBlocked(trust.localInstallTrust ?? null, digest)) {
    throw new InstallError(`DIGEST_BLOCKED: this file of '${manifest.id}' was taken down by Navide and cannot be installed`)
  }
  const localSignature = localSignatureDecision(trust.localInstallTrust ?? null, manifest.id, digest, trust.signature ?? null)
  const packageVerification = verifyPackage({
    bytes,
    expectedDigest: digest,
    signature: null,
    publicKey: null,
    requires: manifestCapabilities(manifest),
  })
  return {
    id: manifest.id,
    version: manifest.version,
    publisherId: manifest.publisher,
    manifest,
    entries,
    trustTier: packageVerification.trustTier,
    sensitive: packageVerification.sensitive,
    containsBackendExecutable: backendEntry !== undefined,
    // Unreviewed code always asks, whatever it declares.
    requiresConfirmation: true,
    official: false,
    digest,
    signature: null,
    provenance: 'developer-local-unpacked',
    disclosure: computeDisclosure(manifest as unknown as DisclosureManifestInput),
    scan: null,
    // The storage class stays `local-unsigned` (data hand-over, set-aside and
    // replacement rules are those of any local file); `localSignature` is
    // what decides the `local-signed` label.
    source: 'local-unsigned',
    localSignature,
    // A native executable is built for one platform; without a backend the
    // package is the same everywhere.
    localTarget: backendEntry !== undefined ? trust.expectedTarget ?? currentPluginHostTarget() : UNIVERSAL_PLUGIN_TARGET,
    takedownChecked: takedown !== null,
  }
}

/**
 * Write a prepared, verified package into `<pluginsRoot>/<id>/`, replacing any
 * previous install of the same id (so update reuses this path). The archive is
 * revalidated before the existing directory is removed. Returns the frontend
 * launch descriptor when the package contributes views; backend-only packages
 * return undefined and are discovered through the activation catalog.
 */
export interface InstallTransaction {
  descriptor: PluginLaunchDescriptor | undefined
  rollback(): void
  finalize(): void
}

function writePreparedPackage(
  prepared: PreparedInstall,
  targetDir: string,
  backendEntry: string | undefined,
  safeEntries: readonly { entry: ZipEntry; path: string }[],
  deps: InstallerDeps
): void {
  for (const { entry, path } of safeEntries) {
    const target = join(targetDir, path)
    if (entry.type === 'directory') {
      deps.mkdirp(target)
    } else if (entry.type === 'regular') {
      deps.mkdirp(dirname(target))
      deps.writeFile(target, entry.data)
      if (path === backendEntry) deps.chmod(target, 0o700)
    } else {
      throw new InstallError(`archive entry is not a regular file: ${entry.path}`)
    }
  }
  if (prepared.registryEvidence) {
    deps.mkdirp(targetDir)
    deps.writeFile(join(targetDir, REGISTRY_ARTIFACT_NAME), prepared.registryEvidence.artifact)
    deps.writeFile(
      join(targetDir, REGISTRY_RECEIPT_NAME),
      new TextEncoder().encode(JSON.stringify(prepared.registryEvidence.receipt, null, 2))
    )
  } else if (prepared.official && prepared.signature) {
    const receipt: OfficialReceipt = {
      id: prepared.id,
      version: prepared.version,
      digest: prepared.digest,
      signature: prepared.signature,
    }
    deps.mkdirp(targetDir)
    deps.writeFile(
      join(targetDir, OFFICIAL_RECEIPT_NAME),
      new TextEncoder().encode(JSON.stringify(receipt, null, 2))
    )
  }
}

export interface StagedInstall {
  /** Immutable Host-owned candidate directory. It is not a scan root and is
   * never registered as a production descriptor by this operation. */
  candidateDir: string
  target: string
  descriptor: PluginLaunchDescriptor | undefined
}

/** Write a verified package beside, never over, the current active package.
 * Candidate discovery/activation is intentionally a separate Host lifecycle
 * decision: staging does not revoke instances, change grants, or expose routes. */
export function stageInstallCandidate(
  prepared: PreparedInstall,
  pluginsRoot: string,
  deps: InstallerDeps = defaultInstallerDeps,
): StagedInstall {
  if (!deps.rename || !deps.pathExists) {
    throw new InstallError('immutable candidate staging requires atomic directory rename support')
  }
  assertSafeArchiveEntries(prepared.entries)
  const safeEntries = prepared.entries.map((entry) => ({
    entry,
    path: canonicalEntryPath(entry),
  }))
  const smuggledHostFile = safeEntries.find(({ path }) => {
    const collisionKey = portableArchiveCollisionKey(path)
    return collisionKey !== null && HOST_OWNED_ARCHIVE_NAMES.has(collisionKey)
  })
  if (smuggledHostFile) throw new InstallError(`package must not contain ${smuggledHostFile.path}`)
  const backendEntry = assertBackendExecutable(prepared.manifest, prepared.entries)
  // Only a local package may stage without Registry target evidence; it has
  // no receipt, and its trust is the user's consent recorded after staging.
  const target = prepared.registryEvidence?.receipt.target ??
    (prepared.source !== undefined && prepared.registryEvidence === undefined ? prepared.localTarget : undefined)
  if (!target) {
    throw new InstallError('immutable candidate staging requires Registry target evidence')
  }
  const candidateDir = immutablePluginPackageDir(pluginsRoot, prepared.id, prepared.version, target)
  if (deps.pathExists(candidateDir)) {
    const selector = new PluginActivationSelector(pluginsRoot)
    let referenced = false
    try {
      const record = selector.read(prepared.id)
      referenced = [record?.active, record?.previous, record?.candidate].some((selection) =>
        selection?.packageVersion === prepared.version &&
        selection.target === target,
      )
    } catch {
      // A corrupt record is a recovery boundary: never relocate bytes that it
      // may still reference, and do not infer a replacement candidate.
      throw new InstallError(`immutable candidate cannot be reconciled while ${prepared.id} lifecycle is unreadable`)
    }
    if (referenced) {
      throw new InstallError(`immutable candidate already exists for ${prepared.id}@${prepared.version}`)
    }
    // An immutable package without any durable lifecycle reference is never
    // auto-adopted: it may have survived an interrupted stage before consent
    // was recorded. Preserve it as forensic quarantine evidence, then allow a
    // fresh verified candidate to stage beside it.
    const quarantineRoot = join(pluginsRoot, PLUGIN_QUARANTINE_DIR)
    const quarantinePath = join(quarantineRoot, `${prepared.id}.unreferenced.${randomUUID()}`)
    try {
      deps.mkdirp(quarantineRoot)
      deps.rename(candidateDir, quarantinePath)
    } catch (error) {
      throw new InstallError(
        `immutable candidate could not be quarantined: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const stagingRoot = join(pluginsRoot, PLUGIN_STAGING_DIR)
  const stagingDir = join(stagingRoot, `${prepared.id}.${randomUUID()}`)
  const trustSnapshotPath = join(pluginsRoot, REGISTRY_TRUST_SNAPSHOT_NAME)
  if (prepared.registryEvidence) {
    assertRegistryTrustSnapshotDoesNotRollback(
      deps.readFile(trustSnapshotPath),
      prepared.registryEvidence.trustSnapshot,
    )
  }
  try {
    deps.mkdirp(stagingRoot)
    writePreparedPackage(prepared, stagingDir, backendEntry, safeEntries, deps)
    deps.syncDirectory?.(stagingDir)
    deps.mkdirp(dirname(candidateDir))
    deps.rename(stagingDir, candidateDir)
    deps.syncDirectory?.(dirname(candidateDir))
    if (prepared.registryEvidence) {
      const writeTrustSnapshot = deps.writeRegistryTrustSnapshot ?? writeRegistryTrustSnapshot
      writeTrustSnapshot(pluginsRoot, prepared.registryEvidence.trustSnapshot)
    }
  } catch (error) {
    // A package that never reached its immutable candidate location is only a
    // transient write; leave active/previous packages and any committed
    // candidate untouched. Ticket 29 owns recovery for interrupted writes.
    deps.rmrf(stagingDir)
    throw error
  }
  return {
    candidateDir,
    target,
    descriptor:
      isManifestV2(prepared.manifest) && prepared.manifest.contributes === undefined
        ? undefined
        : manifestToDescriptor(prepared.manifest, candidateDir),
  }
}

export function commitInstallTransaction(
  prepared: PreparedInstall,
  pluginsRoot: string,
  deps: InstallerDeps = defaultInstallerDeps
): InstallTransaction {
  const dir = join(pluginsRoot, prepared.id)
  assertSafeArchiveEntries(prepared.entries)
  const safeEntries = prepared.entries.map((entry) => ({
    entry,
    path: canonicalEntryPath(entry),
  }))
  const smuggledHostFile = safeEntries.find(({ path }) => {
    const collisionKey = portableArchiveCollisionKey(path)
    return collisionKey !== null && HOST_OWNED_ARCHIVE_NAMES.has(collisionKey)
  })
  if (smuggledHostFile) {
    throw new InstallError(`package must not contain ${smuggledHostFile.path}`)
  }
  const backendEntry = assertBackendExecutable(prepared.manifest, prepared.entries)
  const descriptor =
    isManifestV2(prepared.manifest) && prepared.manifest.contributes === undefined
      ? undefined
      : manifestToDescriptor(prepared.manifest, dir)
  const trustSnapshotPath = join(pluginsRoot, REGISTRY_TRUST_SNAPSHOT_NAME)
  if (prepared.registryEvidence) {
    assertRegistryTrustSnapshotDoesNotRollback(
      deps.readFile(trustSnapshotPath),
      prepared.registryEvidence.trustSnapshot
    )
  }
  const previousSnapshot = deps.readFile(trustSnapshotPath)
  const atomic = deps.rename !== undefined && deps.pathExists !== undefined
  const stagingRoot = join(pluginsRoot, PLUGIN_STAGING_DIR)
  const stagingDir = join(stagingRoot, `${prepared.id}.${randomUUID()}`)
  const quarantineRoot = join(pluginsRoot, PLUGIN_QUARANTINE_DIR)
  const previousDirExists = atomic && deps.pathExists!(dir)
  const backupDir = previousDirExists
    ? join(quarantineRoot, `${prepared.id}.previous`)
    : undefined
  let previousDirMoved = false
  let committed = false
  let rolledBack = false
  let finalized = false

  const restoreSnapshot = (): void => {
    if (!prepared.registryEvidence) return
    const currentSnapshot = deps.readFile(trustSnapshotPath)
    const unchanged =
      (currentSnapshot === null && previousSnapshot === null) ||
      (currentSnapshot !== null &&
        previousSnapshot !== null &&
        Buffer.from(currentSnapshot).equals(Buffer.from(previousSnapshot)))
    if (unchanged) return
    if (previousSnapshot) deps.writeFile(trustSnapshotPath, previousSnapshot)
    else deps.rmrf(trustSnapshotPath)
  }
  const quarantinePath = (path: string, label: string): void => {
    if (!atomic || !deps.rename || !deps.pathExists || !deps.pathExists(path)) return
    const target = join(quarantineRoot, `${prepared.id}.${label}.${randomUUID()}`)
    try {
      deps.mkdirp(quarantineRoot)
      deps.rename(path, target)
    } catch {
      // Preserve the failed package if the forensic move itself fails. The
      // marker keeps it out of every activation and Registry-refresh scan.
      try {
        deps.writeFile(
          join(path, PLUGIN_QUARANTINE_MARKER),
          new TextEncoder().encode(JSON.stringify({ label, packageId: prepared.id }))
        )
      } catch {
        // The original failure remains authoritative; do not delete evidence.
      }
    }
  }

  try {
    const targetDir = atomic ? stagingDir : dir
    if (atomic) deps.mkdirp(stagingRoot)
    else deps.rmrf(dir)
    writePreparedPackage(prepared, targetDir, backendEntry, safeEntries, deps)

    if (atomic) {
      if (previousDirExists && backupDir) {
        deps.mkdirp(quarantineRoot)
        if (deps.pathExists!(backupDir)) deps.rmrf(backupDir)
        deps.rename!(dir, backupDir)
        previousDirMoved = true
      }
      deps.rename!(stagingDir, dir)
      committed = true
    }
    if (prepared.registryEvidence) {
      const writeTrustSnapshot = deps.writeRegistryTrustSnapshot ?? writeRegistryTrustSnapshot
      writeTrustSnapshot(pluginsRoot, prepared.registryEvidence.trustSnapshot)
    }
  } catch (error) {
    if (atomic) {
      if (committed) quarantinePath(dir, 'failed')
      quarantinePath(stagingDir, 'staging-failed')
      if (previousDirMoved && backupDir && deps.pathExists!(backupDir) && !deps.pathExists!(dir)) {
        deps.rename!(backupDir, dir)
      }
      restoreSnapshot()
    } else {
      deps.rmrf(dir)
    }
    throw error
  }

  return {
    descriptor,
    rollback: (): void => {
      if (rolledBack || finalized) return
      rolledBack = true
      if (atomic) {
        if (committed) quarantinePath(dir, 'failed')
        quarantinePath(stagingDir, 'staging-failed')
        if (backupDir && deps.pathExists!(backupDir) && !deps.pathExists!(dir)) {
          deps.rename!(backupDir, dir)
        }
      } else {
        deps.rmrf(dir)
      }
      restoreSnapshot()
    },
    finalize: (): void => {
      if (rolledBack || finalized) return
      finalized = true
      // Keep one explicitly named normal previous package for bounded recovery.
      // Rejected packages use different forensic labels and remain untouched;
      // neither category is in the scan path.
    },
  }
}

/** Commit a verified package immediately. IPC uses commitInstallTransaction so
 * post-write verification, manager registration, and consent persistence can
 * finish before finalize(). */
export function commitInstall(
  prepared: PreparedInstall,
  pluginsRoot: string,
  deps: InstallerDeps = defaultInstallerDeps
): PluginLaunchDescriptor | undefined {
  const transaction = commitInstallTransaction(prepared, pluginsRoot, deps)
  transaction.finalize()
  return transaction.descriptor
}

/** Remove an installed plugin's directory. Idempotent. */
export function removePlugin(
  pluginsRoot: string,
  id: string,
  deps: InstallerDeps = defaultInstallerDeps
): void {
  deps.rmrf(join(pluginsRoot, id))
}

/**
 * Whether `latestVersion` is a strictly-newer semver than `installedVersion`.
 * Used to surface an update in the Extensions view. Non-semver inputs return
 * false (no false-positive update prompts).
 */
export function isUpdateAvailable(installedVersion: string, latestVersion: string | null): boolean {
  if (!latestVersion) return false
  const comparison = compareSemver(installedVersion, latestVersion)
  return comparison !== null && comparison < 0
}
