// Where a package installed from a file is trusted from (DX report A1, card
// K3). A Registry package carries a Host receipt and is verified against the
// Registry root; a local package carries none and is verified against the
// user's consent record (`pluginLocalTrust.ts`). This module decides which of
// the two applies to an installed package directory, so every load, restart
// and backend spawn makes the same choice.
//
// A directory holding Registry evidence always takes the Registry path,
// unchanged; a local decision is only ever made for a directory with no
// receipt and a consent record naming its exact id and version.

import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { REGISTRY_RECEIPT_NAME, type InstalledTrustDecision } from './pluginInstalledTrust'
import { readLocalTrustRecord, verifyLocalPackage, type PluginLocalTrustContext } from './pluginLocalTrust'
import { parseManifestJson } from './pluginManifest'

/** Consent records live beside, never inside, the plugins root: every child
 * of the root is scanned as a package, and a file inside a package would
 * itself change the content the record covers. */
export const PLUGIN_LOCAL_TRUST_DIR = 'plugin-local-trust'

export type LocalRecordRole = 'active' | 'candidate'

export function localTrustRecordPath(pluginsRoot: string, pluginId: string, role: LocalRecordRole = 'active'): string {
  return join(dirname(pluginsRoot), PLUGIN_LOCAL_TRUST_DIR, role === 'active' ? `${pluginId}.json` : `${pluginId}.candidate.json`)
}

/** The consent record covering `pluginId`@`version`, active first. */
export function localTrustRecordFor(pluginsRoot: string, pluginId: string, version: string): string | null {
  for (const role of ['active', 'candidate'] as const) {
    const path = localTrustRecordPath(pluginsRoot, pluginId, role)
    try {
      const record = readLocalTrustRecord(path)
      if (record.id === pluginId && record.version === version) return path
    } catch {
      // No record, or one verification will refuse anyway.
    }
  }
  return null
}

/** True when the installed package directory is a local install: no Registry
 * receipt, and a consent record for its manifest's id and version. */
export function isLocalInstalledPackage(pluginsRoot: string, packageDir: string, pluginId: string): boolean {
  return localRecordForDir(pluginsRoot, packageDir, pluginId) !== null
}

function localRecordForDir(pluginsRoot: string, packageDir: string, pluginId: string): string | null {
  if (existsSync(join(packageDir, REGISTRY_RECEIPT_NAME))) return null
  let version: unknown
  try {
    version = parseManifestJson(readFileSync(join(packageDir, 'manifest.json'), 'utf8')).version
  } catch {
    return null
  }
  return typeof version === 'string' ? localTrustRecordFor(pluginsRoot, pluginId, version) : null
}

/**
 * The local-install decision for an installed package directory, in the
 * shape the Registry verifier returns, or null when the directory is not a
 * local install (the caller then verifies it as a Registry package, as on
 * main). A taken-down local package is refused like a quarantined one, with
 * the takedown reason.
 */
export function verifyLocalInstalledPackage(
  pluginsRoot: string,
  packageDir: string,
  pluginId: string,
  trust: PluginLocalTrustContext,
): InstalledTrustDecision | null {
  const recordPath = localRecordForDir(pluginsRoot, packageDir, pluginId)
  if (recordPath === null) return null
  const decision = verifyLocalPackage(packageDir, pluginId, recordPath, trust)
  if (decision.action !== 'allow') return { action: 'quarantine', reason: `${decision.code}: ${decision.reason}` }
  // Immutable layout: <root>/<id>/<version>/<target>/package.
  return { action: 'allow', artifactDigest: decision.contentDigest, target: basename(dirname(packageDir)) }
}

/** Make the candidate's consent record the active one, at the moment the
 * candidate becomes the active package. */
export function promoteLocalCandidateRecord(pluginsRoot: string, pluginId: string): void {
  const candidate = localTrustRecordPath(pluginsRoot, pluginId, 'candidate')
  if (existsSync(candidate)) renameSync(candidate, localTrustRecordPath(pluginsRoot, pluginId, 'active'))
}

/** Drop the consent records of one plugin (removal, or a Registry install
 * replacing a local one). */
export function forgetLocalTrustRecords(pluginsRoot: string, pluginId: string, roles: readonly LocalRecordRole[] = ['active', 'candidate']): void {
  for (const role of roles) rmSync(localTrustRecordPath(pluginsRoot, pluginId, role), { force: true })
}
