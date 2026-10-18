// Supply-chain verification for plugin installs — PURE logic, electron-free, so
// it can be unit-tested under Vitest's node environment (only `node:crypto` is
// imported, a runtime builtin available in any environment).
//
// The verification chain a marketplace package must pass before it is unpacked:
//   1. digest      — sha256 of the downloaded bytes MUST equal the registry's
//                    `X-Package-Digest` header (integrity / anti-tamper).
//   2. signature   — when a detached Ed25519 signature + publisher public key
//                    are available, it MUST verify over the digest; a *failed*
//                    verification blocks the install. Unsigned packages are not
//                    blocked (their trust tier is surfaced to the user instead).
//   3. capabilities— every declared `requires` namespace MUST be a known
//                    declared capability namespace; an unknown namespace is a scope-escalation and
//                    is rejected (namespace over-reach).
// Zip-slip path-traversal defence lives here too (`assertSafeEntryPath`) and is
// applied by the unpack shell before any bytes hit disk.
//
// Mirrors the registry's own chain: `signing.py` signs/verifies a base64
// Ed25519 signature over the ascii-encoded sha256 *hex* digest; `trust.py`
// flags `fs`/`aiCli`/`shell` as sensitive for v2; `terminal` remains sensitive
// only for the legacy compatibility path. Kept in sync deliberately.

import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto'
import {
  validatePortableArchiveEntries,
  type PortableArchiveEntry,
} from './pluginPathPolicy'

/** Capability namespaces the host can authorize. Mirror of the backend
 *  `manifest.KNOWN_CAPABILITIES` for the current runtime contract. */
export const KNOWN_CAPABILITIES: readonly string[] = [
  'fs',
  'ui',
  'aiCli',
  'shell',
  // Legacy v1 namespaces remain parseable only through the compatibility path.
  'git',
  'terminal',
  'search',
  'chat',
  'issues',
  'plans',
]

/** Capabilities that grant filesystem / brokered process / shell reach and
 *  warrant a second confirmation before install. Mirror of the registry. */
export const SENSITIVE_CAPABILITIES: readonly string[] = ['fs', 'aiCli', 'shell', 'terminal']

export const TRUST_SIGNED = 'signed-verified'
export const TRUST_UNSIGNED = 'unsigned'
export type TrustTier = typeof TRUST_SIGNED | typeof TRUST_UNSIGNED

/** Machine-readable reason an install was refused; the UI maps these to copy. */
export type VerifyErrorCode =
  | 'DIGEST_MISMATCH'
  | 'SIGNATURE_REQUIRED'
  | 'SIGNATURE_INVALID'
  | 'CAP_UNKNOWN'
  | 'ZIP_SLIP'
  | 'ZIP_DUPLICATE'
  | 'ZIP_ENTRY_TYPE'
  | 'NOT_OFFICIAL'

export class PluginVerifyError extends Error {
  constructor(
    readonly code: VerifyErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PluginVerifyError'
  }
}

/** sha256 of `bytes` as a lowercase hex string (matches the registry digest). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Verify a detached base64 Ed25519 `signature` over the ascii-encoded hex
 * `digest`, using a PEM SubjectPublicKeyInfo `publicKey`. Returns false (never
 * throws) on any malformed input — the caller decides whether false blocks.
 * This is the exact inverse of the registry's `Ed25519SignatureVerifier`.
 */
export function verifyEd25519(
  digest: string,
  signature: string | null | undefined,
  publicKey: string | null | undefined
): boolean {
  if (!signature || !publicKey) return false
  try {
    const key = createPublicKey(publicKey)
    const sig = Buffer.from(signature, 'base64')
    // Ed25519: algorithm arg must be null; message is the ascii hex digest.
    return cryptoVerify(null, Buffer.from(digest, 'ascii'), key, sig)
  } catch {
    return false
  }
}

// ── Official publisher trust (the `navide.` namespace) ──────────────────────
//
// Ids under `navide.` (e.g. `navide.mini-ide`) name plugins the host treats as
// first-party: they may replace core surfaces like the editor. Installing one
// therefore requires MORE than a valid publisher signature — the signing key
// must equal the PINNED official publisher key. Fail-closed: with no pinned
// key configured, no `navide.` package can be installed at all.
//
// Pinned key sources, in precedence order:
//   1. `AGENT_TEAM_OFFICIAL_PLUGIN_KEY` env (PEM) — dev/test override.
//   2. `OFFICIAL_PUBLISHER_KEY_PEM` build-time constant below.

/** Publisher namespace prefix reserved for first-party plugins. */
export const OFFICIAL_PLUGIN_PREFIX = 'navide.'

/**
 * Build-time pinned official publisher public key (PEM SubjectPublicKeyInfo,
 * Ed25519). An empty pin means every `navide.` install is refused
 * (fail-closed); it never means "skip the check".
 *
 * The matching private key is NOT in this repo — it lives beside the macOS
 * signing assets in `~/navide-signing/plugin_publisher.key` (0600) and must be
 * backed up with them. Losing it means no further official plugin package can
 * be published under this pin; rotating it requires shipping a new app build,
 * since the pin is a build-time constant.
 *
 * SHA256 of the SPKI DER:
 * c7c56410028133b00fd6056493186ab6c4badc497a42635626b82b0ea163bca8
 */
export const OFFICIAL_PUBLISHER_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAXhRZlYmlpSq1O0YEg1aRFfIsJKa3021/wYtO6sbRd4k=
-----END PUBLIC KEY-----
`

/** True when `id` claims the official first-party namespace. */
export function isOfficialPluginId(id: string): boolean {
  return id.startsWith(OFFICIAL_PLUGIN_PREFIX)
}

/** Card K4 (D6): a packaged build never takes the official key from the
 * environment, Developer Mode or not; the Host turns the override off at
 * startup. A key that signs `navide.` packages is not a developer setting. */
let officialKeyOverrideAllowed = true

export function disableOfficialKeyOverride(): void {
  officialKeyOverrideAllowed = false
}

/** Resolve the effective pinned official key (env override → build constant),
 *  or null when neither is configured. */
export function resolveOfficialPublisherKey(
  env: Record<string, string | undefined> = process.env
): string | null {
  const override = officialKeyOverrideAllowed ? env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']?.trim() : undefined
  const pem = override || OFFICIAL_PUBLISHER_KEY_PEM
  return pem ? pem : null
}

/** Compare two PEM public keys by their DER (SPKI) bytes, so incidental
 *  whitespace/encoding differences never matter. False on any malformed key. */
export function publicKeysEqual(a: string, b: string): boolean {
  try {
    const da = createPublicKey(a).export({ type: 'spki', format: 'der' })
    const db = createPublicKey(b).export({ type: 'spki', format: 'der' })
    return da.length === db.length && timingSafeEqual(da, db)
  } catch {
    return false
  }
}

/**
 * Enforce the official-namespace policy for an install. No-op for third-party
 * ids. For a `navide.` id, throws `NOT_OFFICIAL` unless the package earned
 * `signed-verified` AND its publisher key equals the pinned official key.
 * A missing pinned key also throws (fail-closed).
 */
export function assertOfficialPublisher(
  id: string,
  publicKey: string | null | undefined,
  trustTier: TrustTier,
  pinnedKey: string | null
): void {
  if (!isOfficialPluginId(id)) return
  if (!pinnedKey) {
    throw new PluginVerifyError(
      'NOT_OFFICIAL',
      `no pinned official publisher key is configured; refusing official-namespace plugin '${id}'`
    )
  }
  if (trustTier !== TRUST_SIGNED || !publicKey || !publicKeysEqual(publicKey, pinnedKey)) {
    throw new PluginVerifyError(
      'NOT_OFFICIAL',
      `plugin '${id}' claims the official 'navide.' namespace but is not signed by the pinned official publisher key`
    )
  }
}

/** Subset of declared capabilities flagged sensitive. */
export function sensitiveCapabilities(requires: readonly string[]): string[] {
  return requires.filter((c) => SENSITIVE_CAPABILITIES.includes(c))
}

/**
 * Reject a `requires` list that names a namespace the host cannot authorize.
 * A third-party manifest asking for an unknown capability is treated as scope
 * over-reach and refused (`CAP_UNKNOWN`).
 */
export function assertKnownCapabilities(requires: readonly string[]): void {
  for (const cap of requires) {
    if (!KNOWN_CAPABILITIES.includes(cap)) {
      throw new PluginVerifyError(
        'CAP_UNKNOWN',
        `manifest requires unknown capability '${cap}' (known: ${KNOWN_CAPABILITIES.join(', ')})`
      )
    }
  }
}

/**
 * Reject a legacy manifest entry path that could escape the extraction root.
 * Keep this permissive for v1 compatibility; canonical archive validation is
 * performed separately by {@link assertSafeArchiveEntries}.
 */
export function assertSafeEntryPath(name: string): void {
  const bad =
    name.length === 0 ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    name.includes('\\') ||
    /^[a-zA-Z]:/.test(name) ||
    name.split('/').some((segment) => segment === '..')
  if (bad) {
    throw new PluginVerifyError('ZIP_SLIP', `unsafe archive entry path: ${name}`)
  }
}

/** Validate every decoded archive entry before manifest parsing or extraction. */
export function assertSafeArchiveEntries(
  entries: readonly { path: string; type?: 'regular' | 'directory' | 'symlink' | 'special' }[]
): void {
  for (const entry of entries) {
    if (entry.type !== undefined && entry.type !== 'regular' && entry.type !== 'directory') {
      throw new PluginVerifyError(
        'ZIP_ENTRY_TYPE',
        `archive entry is not a regular file or directory: ${entry.path}`
      )
    }
  }

  const portableEntries: PortableArchiveEntry[] = entries.map((entry) => ({
    path: entry.path,
    type: entry.type === 'directory' ? 'directory' : 'regular',
  }))
  const issue = validatePortableArchiveEntries(portableEntries)
  if (!issue) return
  if (issue.kind === 'unsafe-path') {
    throw new PluginVerifyError('ZIP_SLIP', `unsafe archive entry path: ${issue.path}`)
  }
  if (issue.kind === 'duplicate') {
    throw new PluginVerifyError('ZIP_DUPLICATE', `duplicate archive entry path: ${issue.path}`)
  }
  throw new PluginVerifyError(
    'ZIP_DUPLICATE',
    `archive path collides with regular file ancestor: ${issue.path}`
  )
}

/**
 * Enforce the registry-transport policy before any marketplace fetch. In
 * production plaintext `http:` is refused (a MITM could swap the package bytes
 * or the trusted digest metadata); only `https:` is allowed. Loopback hosts
 * (`localhost`/`127.0.0.1`/`::1`) are the sole `http:` exception so a locally
 * run dev registry keeps working. Outside production any `http:` is allowed.
 * Throws on a malformed URL or a disallowed scheme/host — the caller must not
 * fetch when this throws.
 */
export function assertRegistryUrlAllowed(url: string, isProduction: boolean): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`invalid marketplace registry URL: ${url}`)
  }
  if (parsed.protocol === 'https:') return
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
    if (loopback) return
    if (!isProduction) return
    throw new Error(
      `refusing plaintext http marketplace registry URL in production (use https): ${url}`
    )
  }
  throw new Error(`unsupported marketplace registry URL scheme (${parsed.protocol}): ${url}`)
}

export interface VerifyPackageInput {
  /** The raw downloaded package (`.vsix`) bytes. */
  bytes: Uint8Array
  /** The registry's `X-Package-Digest` response header (sha256 hex). */
  expectedDigest: string
  /** Detached base64 Ed25519 signature, when the caller has it (else null). */
  signature?: string | null
  /** Publisher PEM public key, when available (else null). */
  publicKey?: string | null
  /** Trust tier the registry claims for this version. DISPLAY HINT ONLY — it is
   *  never allowed to upgrade the effective trust tier (fail-closed); a lying
   *  registry cannot mint `signed-verified` without a valid client-side sig. */
  claimedTrustTier?: string | null
  /** The manifest's declared capability namespaces. */
  requires?: readonly string[]
}

export interface VerifyPackageResult {
  /** The computed (and now trusted) sha256 hex digest. */
  digest: string
  /** Effective trust tier after verification. */
  trustTier: TrustTier
  /** Declared sensitive capabilities the UI must warn about before install. */
  sensitive: string[]
}

/**
 * Run the full pre-unpack verification chain. Throws {@link PluginVerifyError}
 * on the first failure; on success returns the trusted digest, effective trust
 * tier, and the sensitive-capability set the UI should gate on.
 *
 * Policy:
 *   - digest mismatch                     → always blocks (`DIGEST_MISMATCH`).
 *   - signature + key present, verify OK  → `signed-verified`.
 *   - signature + key present, verify BAD → blocks (`SIGNATURE_INVALID`).
 *   - no signature material               → not blocked; ALWAYS `unsigned`
 *     regardless of any registry claim (fail-closed; the registry cannot
 *     upgrade trust).
 *   - unknown capability in `requires`    → blocks (`CAP_UNKNOWN`).
 */
export function verifyPackage(input: VerifyPackageInput): VerifyPackageResult {
  const requires = input.requires ?? []
  assertKnownCapabilities(requires)

  const digest = sha256Hex(input.bytes)
  if (digest !== input.expectedDigest) {
    throw new PluginVerifyError(
      'DIGEST_MISMATCH',
      `package digest ${digest} does not match expected ${input.expectedDigest}`
    )
  }

  // Trust is fail-closed: `signed-verified` is earned ONLY by a client-side
  // Ed25519 verification that passes here. The registry's `claimedTrustTier` is
  // never allowed to upgrade trust — a compromised/lying registry claiming
  // `signed-verified` gets `unsigned` all the same. It may be surfaced as a
  // display hint by the caller, but it is not consulted for the effective tier.
  let trustTier: TrustTier = TRUST_UNSIGNED
  const hasMaterial = Boolean(input.signature && input.publicKey)
  if (hasMaterial) {
    if (!verifyEd25519(digest, input.signature, input.publicKey)) {
      throw new PluginVerifyError(
        'SIGNATURE_INVALID',
        'package signature failed Ed25519 verification against the publisher key'
      )
    }
    trustTier = TRUST_SIGNED
  }

  return { digest, trustTier, sensitive: sensitiveCapabilities(requires) }
}
