import { createHash } from 'node:crypto'
import { canonicalArchivePath } from './pluginPathPolicy'
import { readManifestFromEntries, readZipEntries } from './pluginPackage'
import {
  verifyRegistryPackageTrust,
  type RegistryPackageEnvelope,
  type RegistryTrustMetadata,
} from './pluginRegistryTrust'

// A first-party plugin the App installer takes from the official Registry
// instead of building it here (navide.git, which lives in its own
// repository). scripts/stage-official-plugin-artifacts.mjs runs this at build
// time; it repeats the checks the App makes before it installs a Registry
// package, so the installer only ever carries a copy the Registry signed.

/** The part of `GET /api/extensions/<namespace>/<name>` this reads. */
export interface RegistryExtensionDetail {
  trust_metadata: RegistryTrustMetadata
  trust_metadata_signature: string
  versions: Array<{
    version: string
    target: string
    package_digest: string
    registry_envelope: RegistryPackageEnvelope
    registry_signature: string
    yanked: boolean
  }>
}

export class OfficialArtifactMissingError extends Error {}

/** The Registry row of `id`@`version` for `target`; throws, naming the
 *  versions the Registry does list, when it has no installable one. */
export function selectOfficialVersion(
  detail: RegistryExtensionDetail,
  id: string,
  version: string,
  target: string,
  registryUrl: string,
): RegistryExtensionDetail['versions'][number] {
  const row = detail.versions.find((candidate) =>
    candidate.version === version && candidate.target === target && !candidate.yanked)
  if (row) return row
  const listed = [...new Set(detail.versions.filter((candidate) => !candidate.yanked).map((candidate) => candidate.version))]
  throw new OfficialArtifactMissingError(
    `${id} ${version} (${target}) is not on the Registry at ${registryUrl}; ` +
      `it lists ${listed.length ? listed.join(', ') : 'no versions'}. ` +
      `Publish ${id} ${version} to the Marketplace before building the App installer.`,
  )
}

export interface VerifiedOfficialArtifact {
  /** The package files, by canonical archive path; `executable` keeps a
   *  packaged backend's execute bit. */
  files: Array<{ path: string; data: Uint8Array; executable: boolean }>
  digest: string
}

/** Checks one downloaded package the way the App checks a Registry install:
 *  digest, Registry envelope and root-signed trust metadata against the
 *  pinned root key, archive paths, and the manifest's identity. */
export function verifyOfficialArtifact(input: {
  id: string
  version: string
  target: string
  registryUrl: string
  detail: RegistryExtensionDetail
  bytes: Uint8Array
  rootKeyPem: string
  hostTarget: string
  now?: Date
}): VerifiedOfficialArtifact {
  const row = selectOfficialVersion(input.detail, input.id, input.version, input.target, input.registryUrl)
  const digest = createHash('sha256').update(input.bytes).digest('hex')
  if (digest !== row.package_digest) {
    throw new Error(`${input.id} ${input.version}: package digest ${digest} does not match the Registry's ${row.package_digest}`)
  }
  const entries = readZipEntries(input.bytes)
  const manifest = readManifestFromEntries(entries)
  // First-party ids are published by the publisher their namespace names.
  const publisherId = input.id.split('.')[0]
  if (manifest.id !== input.id || manifest.version !== input.version || manifest.publisher !== publisherId) {
    throw new Error(
      `${input.id} ${input.version}: the package manifest names ${String(manifest.id)} ${String(manifest.version)} ` +
        `by ${String(manifest.publisher)}`,
    )
  }
  // The installer carries released versions only: no pre-release or
  // Testplace build, and no envelope that expires.
  const envelope = row.registry_envelope
  if ((envelope.channel !== undefined && envelope.channel !== 'stable') || envelope.expiresAt !== undefined) {
    throw new Error(`${input.id} ${input.version}: the Registry lists it on the ${String(envelope.channel)} channel, not stable`)
  }
  verifyRegistryPackageTrust({
    envelope: row.registry_envelope,
    envelopeSignature: row.registry_signature,
    trustMetadata: input.detail.trust_metadata,
    trustMetadataSignature: input.detail.trust_metadata_signature,
    pinnedRootKey: input.rootKeyPem,
    expected: {
      artifactDigest: digest,
      packageId: input.id,
      version: input.version,
      target: input.target,
      publisherId,
    },
    expectedHostTarget: input.hostTarget,
    now: input.now,
  })
  const files = entries.filter((entry) => entry.type === 'regular').map((entry) => {
    const path = canonicalArchivePath(entry.path, 'regular')
    if (path === null) throw new Error(`${input.id} ${input.version}: unsafe archive entry path ${entry.path}`)
    return { path, data: new Uint8Array(entry.data), executable: entry.executable }
  })
  return { files, digest }
}
