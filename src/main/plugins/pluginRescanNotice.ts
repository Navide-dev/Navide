import { createHash } from 'node:crypto'
import { canonicalContractJson } from '../../shared/pluginDisclosure'
import { diffScan, type ScanItem, type ScanReport } from '../../shared/pluginDisclosureScan'
import { scanReport } from './marketplaceQuery'
import { selectPluginArtifact } from './pluginTarget'

/** A rescan of an installed version that found new items (D6, D-f). */
export interface RescanFinding {
  /** sha256 of the canonical new report: a rescan is noticed once. */
  digest: string
  added: ScanItem[]
}

/**
 * What a rescan of the installed version added, compared with the scan
 * verified at install (`installed`), from the version rows the periodic
 * update check already fetched: no request of its own. Notice only: it
 * decides nothing. Null without a baseline, without this Host's artifact,
 * with a malformed report, or when nothing was added.
 */
export function rescanFinding(
  installed: ScanReport | null,
  rows: ReadonlyArray<{ version?: unknown; target?: unknown; yanked?: unknown; scan?: unknown }>,
  installedVersion: string,
  hostTarget: string,
): RescanFinding | null {
  if (!installed) return null
  const artifacts = rows
    .filter((row) => row.version === installedVersion && row.yanked !== true && typeof row.target === 'string')
    .map((row) => ({ version: installedVersion, target: row.target as string, scan: row.scan }))
  let current: ScanReport | null
  try {
    current = scanReport(selectPluginArtifact(artifacts, hostTarget).scan)
  } catch {
    return null
  }
  if (!current) return null
  const digest = createHash('sha256').update(canonicalContractJson(current), 'utf8').digest('hex')
  if (digest === createHash('sha256').update(canonicalContractJson(installed), 'utf8').digest('hex')) return null
  const { added } = diffScan(installed, current)
  return added.length > 0 ? { digest, added } : null
}
