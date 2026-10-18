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

import type { LocalPluginSource } from '../../shared/pluginSource'

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
      /** False when no current root-verified trust metadata was available,
       * so the takedown list could not be checked. */
      blocklistChecked: boolean
    }
  | { action: 'quarantine'; code: PluginLocalTrustErrorCode; reason: string }
  | { action: 'blocked'; code: PluginLocalBlockedCode; reason: string }
