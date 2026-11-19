import type { DisclosureDiff, ManifestDisclosure } from '../../shared/pluginDisclosure'

/** A first-party plugin running from the copy the App installer bundles. */
export interface BundledOfficialCandidate {
  id: string
  /** The bundled copy's version. */
  version: string
  /** The bundled copy's disclosure; null when its manifest cannot be read. */
  disclosure: ManifestDisclosure | null
  hasViews: boolean | undefined
}

/** What the Host verified about the newer Marketplace version, before
 *  anything is written. */
export interface PreparedBundledUpdate {
  /** navide. id, official Registry authority, URL and trust profile. */
  official: boolean
  disclosure: ManifestDisclosure | null
  hasViews: boolean | undefined
}

export type BundledRefreshOutcome =
  | { id: string; from: string; result: 'up-to-date' }
  | { id: string; from: string; to: string; result: 'staged' }
  /** Verified and newer, but it discloses something the bundled copy does
   *  not: left for the user's own update flow. */
  | { id: string; from: string; to: string; result: 'needs-approval'; reason: string }
  | { id: string; from: string; to?: string; result: 'failed'; reason: string }

export interface BundledOfficialRefreshDeps {
  /** Bundled first-party copies now running, minus disabled ids and ids with
   *  a staged candidate or an install in progress. */
  candidates(): BundledOfficialCandidate[]
  /** Only the official Navide Marketplace updates bundled plugins. */
  marketplaceIsOfficial(): boolean
  /** Newest stable, installable version listed for `id`, or null. */
  newestVersion(id: string): Promise<string | null>
  isNewer(from: string, to: string): boolean
  /** Download and verify the version (digest, signature, trust metadata,
   *  disclosure signature, engines) and hold it; nothing is written. */
  prepare(id: string, version: string): Promise<PreparedBundledUpdate>
  diff(from: ManifestDisclosure, to: ManifestDisclosure): DisclosureDiff
  /** Stage the held version; the next launch switches to it. */
  commit(id: string): Promise<void>
  /** Drop the held version. */
  discard(id: string): void
  warn(message: string): void
}

/** Why the prepared version cannot replace the bundled one unasked, or null
 *  when it discloses exactly what the bundled copy does. The user consented
 *  to the bundled copy's disclosure by installing the App; anything beyond it
 *  goes through the ordinary update consent (disclose, don't restrict). */
export function bundledUpdateNeedsApproval(
  bundled: BundledOfficialCandidate,
  prepared: PreparedBundledUpdate,
  diff: BundledOfficialRefreshDeps['diff'],
): string | null {
  if (!bundled.disclosure || !prepared.disclosure) return 'the disclosures could not be compared'
  let changes: DisclosureDiff
  try {
    changes = diff(bundled.disclosure, prepared.disclosure)
  } catch {
    return 'the disclosures could not be compared'
  }
  if (changes.added.length > 0 || changes.removed.length > 0 || changes.to.risk !== changes.from.risk || changes.widened) {
    return 'the new version discloses something different'
  }
  if (bundled.hasViews === undefined || prepared.hasViews !== bundled.hasViews) {
    return 'the views change, or could not be compared'
  }
  return null
}

/**
 * For each bundled first-party plugin, stage a newer official Marketplace
 * version for the next launch when it verifies and discloses exactly what
 * the bundled copy does. Offline, unreachable, unverifiable or not official:
 * nothing is written and the bundled copy keeps serving. The running copy is
 * never replaced mid-session.
 */
export async function refreshBundledOfficialPlugins(deps: BundledOfficialRefreshDeps): Promise<BundledRefreshOutcome[]> {
  if (!deps.marketplaceIsOfficial()) return []
  const outcomes: BundledRefreshOutcome[] = []
  for (const bundled of deps.candidates()) {
    const from = bundled.version
    let to: string | null = null
    let held = false
    try {
      to = await deps.newestVersion(bundled.id)
      if (to === null || !deps.isNewer(from, to)) {
        outcomes.push({ id: bundled.id, from, result: 'up-to-date' })
        continue
      }
      const prepared = await deps.prepare(bundled.id, to)
      held = true
      if (!prepared.official) {
        deps.discard(bundled.id)
        held = false
        outcomes.push({ id: bundled.id, from, to, result: 'failed', reason: 'the Marketplace version is not an official package' })
        continue
      }
      const reason = bundledUpdateNeedsApproval(bundled, prepared, deps.diff)
      if (reason !== null) {
        deps.discard(bundled.id)
        held = false
        outcomes.push({ id: bundled.id, from, to, result: 'needs-approval', reason })
        continue
      }
      held = false
      await deps.commit(bundled.id)
      outcomes.push({ id: bundled.id, from, to, result: 'staged' })
    } catch (error) {
      if (held) deps.discard(bundled.id)
      const reason = error instanceof Error ? error.message : String(error)
      deps.warn(`[plugins] bundled ${bundled.id} ${from}: Marketplace refresh failed, keeping the bundled copy: ${reason}`)
      outcomes.push({ id: bundled.id, from, ...(to ? { to } : {}), result: 'failed', reason })
    }
  }
  return outcomes
}
