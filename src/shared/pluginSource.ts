/**
 * Where an installed Navide plugin came from and what review it passed
 * (DX report F0, card K1). Shared by the main process and the renderer.
 *
 * `PluginSource` is carried in its own `source` field next to the legacy
 * `provenance` field, never in place of it. Older App releases parse
 * `provenance` with a closed three-value vocabulary (the Registry receipt is
 * exact-field checked and refuses any other value), so `provenance` keeps its
 * legacy value wherever it is written today and new vocabulary lives only in
 * fields an older release does not read.
 */

/** Source and review state, one value per installed package. */
export type PluginSource =
  /** Marketplace stable release: reviewed and Registry-signed. */
  | 'marketplace'
  /** Marketplace pre-release: reviewed and Registry-signed. */
  | 'prerelease'
  /** Invited test build: automated scan only, expires. */
  | 'testplace'
  /** Local file signed by a vetted publisher; this version is not reviewed. */
  | 'local-signed'
  /** Local file with no signature and no review. */
  | 'local-unsigned'
  /** Developer folder loaded in place; contents may change at any time. */
  | 'developer-unpacked'
  /** Shipped inside the Navide app. */
  | 'factory-bundled'

export const PLUGIN_SOURCES: readonly PluginSource[] = [
  'marketplace',
  'prerelease',
  'testplace',
  'local-signed',
  'local-unsigned',
  'developer-unpacked',
  'factory-bundled',
]

/** The closed provenance vocabulary every released App understands. */
export type LegacyPluginProvenance = 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'

/** Sources whose trust comes from a user's consent to a content digest
 * (`pluginLocalTrust.ts`), not from the Registry root key. */
export type LocalPluginSource = Extract<PluginSource, 'local-signed' | 'local-unsigned'>

/** Read a legacy provenance value as a source. A Registry install is a
 * pre-release when its version carries a SemVer pre-release suffix. */
export function pluginSourceFromLegacyProvenance(
  provenance: LegacyPluginProvenance | undefined,
  isPrerelease: boolean
): PluginSource | undefined {
  switch (provenance) {
    case 'official-registry':
      return isPrerelease ? 'prerelease' : 'marketplace'
    case 'developer-local-unpacked':
      return 'developer-unpacked'
    case 'factory-bundled':
      return 'factory-bundled'
    default:
      return undefined
  }
}
