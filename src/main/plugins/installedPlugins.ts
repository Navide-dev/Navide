// Loader for locally-installed plugins. Manifest parsing and permission policy
// live in the format-specific modules behind `pluginManifest.ts`; this module
// keeps the compatibility exports plus descriptor/receipt/scan I/O.
// PURE parsing/validation plus a thin `node:fs` scan shell (no `electron`
// import), so the whole module is unit-testable.
//
// An installed plugin lives at `<root>/<id>/` and contains:
//   * `manifest.json` — the same strict manifest the backend host validates.
//   * every built frontend/backend asset referenced by the manifest.
// This loader covers third-party installs; bundled builtin directories are
// validated through the same `loadPluginDir` path.

import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { TextDecoder } from 'node:util'
import { extname, join } from 'node:path'
import { isWindows } from '../../shared/osplat'
import { verifyEd25519 } from './pluginVerify'
import {
  assertManifestFiles,
  backendEntryOnDisk,
  isManifestV2,
  manifestCapabilityPolicy,
  manifestCapabilities,
  manifestReferencedFiles,
  parseInstalledManifest,
  parseManifestJson,
  type InstalledManifest,
  type PluginManifestV2,
} from './pluginManifest'
import { isValidManifestV2PluginId } from './pluginManifestV2'
import type { PluginLaunchDescriptor, PluginViewLaunchDescriptor } from './frontendPluginManager'
import {
  PLUGIN_ACTIVATION_DIR,
  PLUGIN_QUARANTINE_DIR,
  PLUGIN_QUARANTINE_MARKER,
  PLUGIN_STAGING_DIR,
} from './pluginInstallPaths'
import { PluginActivationSelector } from './pluginActivationSelector'
import { copyManifestPermissionsSummary, type ManifestPermissionsSummary } from '../../shared/executionPolicy'

export {
  assertManifestFiles,
  backendEntryOnDisk,
  isManifestV2,
  manifestCapabilityPolicy,
  manifestCapabilities,
  manifestReferencedFiles,
  parseInstalledManifest,
  parseManifestJson,
  InstalledPluginError,
  type InstalledManifest,
  type LegacyInstalledManifest,
  type PluginManifestV2,
  type PluginManifestV2View,
} from './pluginManifest'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function readUtf8File(path: string, label: string): string {
  try {
    return UTF8_DECODER.decode(readFileSync(path))
  } catch (error) {
    throw new Error(
      `${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function assertBackendExecutableOnDisk(manifest: PluginManifestV2, pluginDir: string): void {
  if (!manifest.backend) return
  const path = backendEntryOnDisk(manifest.backend.entry)
  const entryPath = join(pluginDir, path)
  let entry
  try {
    entry = lstatSync(entryPath)
  } catch {
    throw new Error(`backend entry is missing or unsafe: ${path}`)
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`backend entry is not a regular file: ${path}`)
  }
  if (entry.size === 0) throw new Error(`backend entry is empty: ${path}`)
  // Windows has no exec bit: what CreateProcess will run is decided by the
  // extension, so that stands in for the POSIX mode check there. `.exe` is
  // the only one left once the manifest contract has refused script
  // extensions (`.cmd`, `.bat`, ...).
  const executable = isWindows()
    ? extname(path).toLowerCase() === '.exe'
    : (entry.mode & 0o111) !== 0
  if (!executable) {
    throw new Error(`backend entry is not executable: ${path}`)
  }

  const prefix = Buffer.alloc(5)
  const fd = openSync(entryPath, 'r')
  let bytesRead = 0
  try {
    bytesRead = readSync(fd, prefix, 0, prefix.length, 0)
  } finally {
    closeSync(fd)
  }
  const startsWithShebang = bytesRead >= 2 && prefix[0] === 0x23 && prefix[1] === 0x21
  const startsWithBomShebang =
    bytesRead >= 5 &&
    prefix[0] === 0xef &&
    prefix[1] === 0xbb &&
    prefix[2] === 0xbf &&
    prefix[3] === 0x23 &&
    prefix[4] === 0x21
  if (startsWithShebang || startsWithBomShebang) {
    throw new Error(`backend entry must not be a script: ${path}`)
  }
}

function assertManifestFilesOnDisk(manifest: InstalledManifest, pluginDir: string): void {
  try {
    const root = lstatSync(pluginDir)
    if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('invalid plugin root')
  } catch {
    throw new Error(`plugin directory is missing or unsafe: ${pluginDir}`)
  }
  for (const referenced of manifestReferencedFiles(manifest)) {
    const path =
      isManifestV2(manifest) && referenced === manifest.backend?.entry
        ? backendEntryOnDisk(referenced)
        : referenced
    try {
      let current = pluginDir
      const segments = path.split('/')
      for (const [index, segment] of segments.entries()) {
        current = join(current, segment)
        const entry = lstatSync(current)
        if (entry.isSymbolicLink()) throw new Error('symlink entry')
        if (index === segments.length - 1) {
          if (!entry.isFile()) throw new Error('not a regular file')
        } else if (!entry.isDirectory()) {
          throw new Error('invalid package directory')
        }
      }
    } catch {
      throw new Error(`manifest referenced file is missing or unsafe: ${path}`)
    }
  }

  if (isManifestV2(manifest)) assertBackendExecutableOnDisk(manifest, pluginDir)
}

function manifestViewsToDescriptors(
  manifest: PluginManifestV2,
  pluginDir: string
): PluginViewLaunchDescriptor[] {
  return (manifest.contributes?.views ?? []).map((view) => {
    const icon = view.icon ?? manifest.marketplace.icon
    return {
      id: view.id,
      contributionKey: `${manifest.id}.${view.id}`,
      kind: view.kind,
      location: view.location,
      title: view.title,
      ...(icon ? { iconFile: join(pluginDir, icon) } : {}),
      ...(view.detailView ? { detailView: view.detailView } : {}),
      ...(view.targetSchema ? { targetSchema: view.targetSchema } : {}),
      ...(view.receives ? { receives: view.receives } : {}),
      entryFile: join(pluginDir, view.entry),
    }
  })
}

/**
 * Build a launch descriptor from a parsed manifest and its on-disk directory.
 * Installed plugins are prebuilt bundles loaded from a file (never the dev
 * server), so `devUrl` is empty.
 */
export function manifestToDescriptor(
  manifest: InstalledManifest,
  pluginDir: string,
  query = ''
): PluginLaunchDescriptor {
  if (isManifestV2(manifest)) {
    const launchViews = manifestViewsToDescriptors(manifest, pluginDir)
    if (launchViews.length === 0) {
      throw new Error(`manifest ${manifest.id} has no frontend custom view contribution`)
    }
    return {
      id: manifest.id,
      packageVersion: manifest.version,
      packageDir: pluginDir,
      requires: manifestCapabilities(manifest),
      capabilityPolicy: manifestCapabilityPolicy(manifest),
      devUrl: '',
      entryFile: launchViews[0].entryFile,
      query,
      views: launchViews,
    }
  }
  return {
    id: manifest.id,
    packageDir: pluginDir,
    requires: manifest.requires,
    capabilityPolicy: manifestCapabilityPolicy(manifest),
    devUrl: '',
    entryFile: join(pluginDir, manifest.entry),
    query,
  }
}

export interface PluginBackendActivation {
  entryFile: string
  protocolVersion: 1
  activation: 'startup'
}

export interface PluginActivationCatalogEntry {
  pluginId: string
  packageVersion: string
  packageDir: string
  views: PluginViewLaunchDescriptor[]
  backend?: PluginBackendActivation
  provenance?: 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'
  artifactDigest?: string
}

/** Derive every runtime contribution atomically from one validated v2 package. */
export function manifestToActivation(
  manifest: PluginManifestV2,
  pluginDir: string
): PluginActivationCatalogEntry {
  const views = manifestViewsToDescriptors(manifest, pluginDir)
  return {
    pluginId: manifest.id,
    packageVersion: manifest.version,
    packageDir: pluginDir,
    views,
    backend: manifest.backend
      ? {
          entryFile: join(pluginDir, backendEntryOnDisk(manifest.backend.entry)),
          protocolVersion: manifest.backend.protocolVersion,
          activation: manifest.backend.activation,
        }
      : undefined,
  }
}

/** Aggregate validated package activations without allowing duplicate active ids. */
export function buildActivationCatalog(
  entries: Iterable<PluginActivationCatalogEntry>
): PluginActivationCatalogEntry[] {
  const versions = new Map<string, string>()
  const catalog: PluginActivationCatalogEntry[] = []
  for (const entry of entries) {
    const activeVersion = versions.get(entry.pluginId)
    if (activeVersion !== undefined) {
      if (activeVersion !== entry.packageVersion) {
        throw new Error(
          `plugin ${entry.pluginId} has multiple active versions: ${activeVersion} and ${entry.packageVersion}`
        )
      }
      throw new Error(`plugin ${entry.pluginId}@${entry.packageVersion} appears more than once`)
    }
    versions.set(entry.pluginId, entry.packageVersion)
    catalog.push(entry)
  }
  return catalog
}

// ── Official install receipt ────────────────────────────────────────────────

// How install-time verification reaches load-time: when `commitInstall` writes
// an official (`navide.`) package it also writes `.navide-receipt.json` into
// the plugin dir, recording the package digest and its Ed25519 signature. At
// load time the loader re-verifies that signature against the CURRENT pinned
// official key — so a `navide.` dir with a missing/forged receipt, or a pin
// that has since changed/been removed, is refused (fail-closed). The receipt is
// evidence carried forward, not a trusted flag: nothing trusts a bare
// `official: true` boolean.

/** Receipt filename written by commitInstall into an official plugin's dir. */
export const OFFICIAL_RECEIPT_NAME = '.navide-receipt.json'

export interface OfficialReceipt {
  id: string
  version: string
  /** sha256 hex digest of the installed package bytes. */
  digest: string
  /** Detached base64 Ed25519 signature over the digest (official key). */
  signature: string
}

/**
 * Decide whether an installed `navide.` plugin dir may register: read its
 * receipt, check it names this plugin id, and re-verify the recorded package
 * signature against the pinned official key. Returns `ok: false` with a reason
 * on ANY failure (no receipt, malformed, id mismatch, no pinned key, bad
 * signature) — the caller must then refuse to register the descriptor.
 */
export function verifyOfficialInstall(
  pluginDir: string,
  pluginId: string,
  pinnedKey: string | null
): { ok: true } | { ok: false; reason: string } {
  if (!pinnedKey) {
    return { ok: false, reason: 'no pinned official publisher key configured' }
  }
  let receipt: Partial<OfficialReceipt>
  try {
    receipt = JSON.parse(readFileSync(join(pluginDir, OFFICIAL_RECEIPT_NAME), 'utf8'))
  } catch {
    return { ok: false, reason: `missing or unreadable ${OFFICIAL_RECEIPT_NAME}` }
  }
  if (
    typeof receipt !== 'object' ||
    receipt === null ||
    typeof receipt.digest !== 'string' ||
    typeof receipt.signature !== 'string' ||
    receipt.id !== pluginId
  ) {
    return { ok: false, reason: `malformed ${OFFICIAL_RECEIPT_NAME}` }
  }
  if (!verifyEd25519(receipt.digest, receipt.signature, pinnedKey)) {
    return {
      ok: false,
      reason: 'install receipt signature failed verification against the pinned official key',
    }
  }
  return { ok: true }
}

export interface ScannedPlugin {
  /** The plugin's on-disk directory. */
  dir: string
  /** Validated manifest version, including legacy manifests whose launch
   *  descriptor intentionally remains plugin-id keyed. */
  manifestVersion?: string
  /** Package-level inventory data derived from the validated manifest. */
  packageSummary?: InstalledPluginPackageSummary
  /** The parsed descriptor, when the manifest was valid. */
  descriptor?: PluginLaunchDescriptor
  /** Atomic v2 frontend/backend contributions from this validated package. */
  activation?: PluginActivationCatalogEntry
  /** The parse/validation error message, when the directory was rejected. */
  error?: string
}

export interface InstalledPluginPackageSummary {
  id: string
  requires: string[]
  packageVersion?: string
  manifestPermissions?: ManifestPermissionsSummary
  provenance?: 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'
  warning?: string
  /** The v2 manifest's `engines.navide`, verbatim, when it declares one. */
  enginesNavide?: string
}

export function manifestToInstalledPackageSummary(
  manifest: InstalledManifest,
  provenance?: InstalledPluginPackageSummary['provenance']
): InstalledPluginPackageSummary {
  return {
    id: manifest.id,
    requires: manifestCapabilities(manifest),
    ...(isManifestV2(manifest)
      ? {
          packageVersion: manifest.version,
          manifestPermissions: copyManifestPermissionsSummary({
            system: manifest.permissions.system ?? [],
            ...(manifest.permissions.shell ? { shell: manifest.permissions.shell } : {}),
            ...(manifest.permissions.scopes ? { scopes: manifest.permissions.scopes } : {}),
          }),
          ...(manifest.engines ? { enginesNavide: manifest.engines.navide } : {}),
        }
      : {}),
    ...(provenance ? { provenance } : {}),
  }
}

/**
 * Read one plugin directory: parse + validate its `manifest.json`, verify all
 * Manifest v2 referenced files are safe regular files, and derive a launch
 * descriptor. Any failure is returned as an `error` instead of thrown.
 */
export function loadPluginDir(dir: string): ScannedPlugin {
  try {
    const raw = parseManifestJson(readUtf8File(join(dir, 'manifest.json'), 'manifest.json'))
    const manifest = parseInstalledManifest(raw)
    if (isManifestV2(manifest)) {
      assertManifestFilesOnDisk(manifest, dir)
      const activation = manifestToActivation(manifest, dir)
      const descriptor = manifest.contributes ? manifestToDescriptor(manifest, dir) : undefined
      return {
        dir,
        manifestVersion: manifest.version,
        packageSummary: manifestToInstalledPackageSummary(manifest),
        descriptor,
        activation,
      }
    }
    return {
      dir,
      manifestVersion: manifest.version,
      packageSummary: manifestToInstalledPackageSummary(manifest),
      descriptor: manifestToDescriptor(manifest, dir),
    }
  } catch (error) {
    return { dir, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Scan an installed-plugins root, returning one {@link ScannedPlugin} per
 * immediate sub-directory. A directory with a missing/invalid manifest or
 * unsafe referenced file is reported with an `error` rather than throwing, so
 * one bad plugin never blocks the rest. A non-existent root yields an empty
 * list.
 */
export function scanInstalledPlugins(root: string): ScannedPlugin[] {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const lifecycleSelector = new PluginActivationSelector(root)
  // This scanner intentionally does not reconcile an interrupted selector.
  // Cold recovery must re-verify its exact package against current Registry
  // trust before changing the durable active pointer; that asynchronous trust
  // boundary belongs to the installed-package lifecycle coordinator.
  const out: ScannedPlugin[] = []
  for (const name of names) {
    if (
      name === PLUGIN_ACTIVATION_DIR ||
      name === PLUGIN_QUARANTINE_DIR ||
      name === PLUGIN_STAGING_DIR
    ) continue
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      if (existsSync(join(dir, PLUGIN_QUARANTINE_MARKER))) continue
    } catch {
      continue
    }
    try {
      // Legacy package directories are named by the unpacker, not necessarily
      // by the manifest id. Only a valid manifest-v2 id can have a durable
      // lifecycle record, so an arbitrary legacy directory must not be
      // mistaken for a corrupt selector merely because its directory name is
      // not an id.
      const selected = isValidManifestV2PluginId(name)
        ? lifecycleSelector.read(name)?.active
        : undefined
      out.push(selected ? loadPluginDir(lifecycleSelector.packageDir(name, selected)) : loadPluginDir(dir))
    } catch {
      // A lifecycle selector that exists but cannot be validated may still
      // reference retained package/storage state. Do not guess a legacy root
      // package or a semver fallback while that recovery pointer is unreadable.
      out.push({ dir, error: 'plugin lifecycle selector is unreadable' })
    }
  }
  return out
}
