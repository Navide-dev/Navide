import { extname } from 'node:path'
import { isWindows } from '../../shared/osplat'
import { manifestReferencedFiles as publicManifestReferencedFiles } from '../../../packages/plugin-contracts/src/index'
import { InstalledPluginError } from './pluginManifestErrors'
import { parseManifestJson } from './pluginManifestJson'
import { parseManifestV1, type LegacyInstalledManifest } from './pluginManifestV1'
import { parseManifestV2, type PluginManifestV2, type PluginManifestV2View } from './pluginManifestV2'
import {
  legacyCapabilityPolicy,
  manifestV2CapabilityPolicy,
  type PluginCapabilityPolicy,
} from './pluginPermissions'

export type { LegacyInstalledManifest } from './pluginManifestV1'
export type {
  PluginManifestV2,
  PluginManifestV2Permissions,
  PluginManifestV2View,
} from './pluginManifestV2'
export { InstalledPluginError } from './pluginManifestErrors'
export { parseManifestJson } from './pluginManifestJson'

export type InstalledManifest = PluginManifestV2 | LegacyInstalledManifest

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Dispatch only; format-specific validation lives in pluginManifestV1/V2. */
export function parseInstalledManifest(raw: unknown): InstalledManifest {
  if (!isObject(raw)) throw new InstalledPluginError('manifest must be a JSON object')
  if (
    Object.prototype.hasOwnProperty.call(raw, 'schemaVersion') ||
    Object.prototype.hasOwnProperty.call(raw, 'permissions') ||
    Object.prototype.hasOwnProperty.call(raw, 'marketplace')
  ) {
    return parseManifestV2(raw)
  }
  return parseManifestV1(raw)
}

export function isManifestV2(manifest: InstalledManifest): manifest is PluginManifestV2 {
  return manifest.schemaVersion === 2
}

/** Whether the package has a view (a web page that can reach the network,
 * R2 MED-6 on #436). A v2 package without `contributes` (backend or agent
 * tools only, an extension pack) has none; a v1 package is a frontend. */
export function manifestHasViews(manifest: InstalledManifest): boolean {
  return !isManifestV2(manifest) || (manifest.contributes?.views.length ?? 0) > 0
}

/** Namespace projection retained for legacy broker/install callers. */
export function manifestCapabilities(manifest: InstalledManifest): string[] {
  if (!isManifestV2(manifest)) return manifest.requires
  return [
    ...(manifest.permissions.system ?? []),
    ...(manifest.permissions.shell ? ['shell'] : []),
  ]
}

export function manifestCapabilityPolicy(manifest: InstalledManifest): PluginCapabilityPolicy {
  return isManifestV2(manifest)
    ? manifestV2CapabilityPolicy(manifest.permissions)
    : legacyCapabilityPolicy(manifest.requires)
}

export function manifestReferencedFiles(manifest: InstalledManifest): string[] {
  if (!isManifestV2(manifest)) return []
  return publicManifestReferencedFiles(manifest)
}

/**
 * The file a manifest's `backend.entry` names on this platform.
 *
 * A package ships one manifest for every platform, so the entry is written
 * without an extension (`backend/navide-plans`); on Windows the packaged
 * executable beside it is `navide-plans.exe`, and a bare name resolves to
 * that the way a PATH lookup would.
 */
export function backendEntryOnDisk(entry: string): string {
  if (!isWindows() || extname(entry) !== '') return entry
  return `${entry}.exe`
}

/** `manifestReferencedFiles`, each as the path this platform will read. */
function manifestReferencedFilesOnDisk(manifest: InstalledManifest): string[] {
  return manifestReferencedFiles(manifest).map((referenced) =>
    isManifestV2(manifest) && referenced === manifest.backend?.entry
      ? backendEntryOnDisk(referenced)
      : referenced
  )
}

export function assertManifestFiles(manifest: InstalledManifest, availablePaths: Iterable<string>): void {
  const available = new Set(availablePaths)
  for (const path of manifestReferencedFilesOnDisk(manifest)) {
    if (!available.has(path)) {
      throw new InstalledPluginError(`manifest referenced file is missing: ${path}`)
    }
  }
}
