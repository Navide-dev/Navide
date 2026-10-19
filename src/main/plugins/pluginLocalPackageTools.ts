// Plan W1 (S1, S1b): the read-only check and the local build behind the agent
// tools plugins_validate_package and plugins_package. Both run in the Host and
// install nothing. A check applies the same archive, manifest, takedown and
// signature rules a local install applies (prepareLocalInstall), after the
// SDK's packaging rules for a folder (pluginLocalPackager), and reports every
// refusal as an error instead of throwing.

import { lstatSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { computeDisclosure, type DisclosureManifestInput, type DisclosureRiskLevel, type ManifestDisclosure } from '../../shared/pluginDisclosure'
import { cardRiskLevel, type ScanReport } from '../../shared/pluginDisclosureScan'
import { isManifestV2 } from './pluginManifest'
import { canonicalArchivePath } from './pluginPathPolicy'
import { prepareLocalInstall, type LocalInstallTrust } from './pluginInstaller'
import { buildFolderPackage, defaultPackageFileName, type FolderPackage } from './pluginLocalPackager'
import type { LocalSignatureState } from './pluginLocalInstallTrust'
import { sha256Hex } from './pluginVerify'
import type { LocalPackageScanner } from './pluginIpc'

export interface LocalPackageReport {
  /** The file checked or written, or the folder checked. */
  path: string
  packageKind: 'file' | 'folder'
  valid: boolean
  /** Every refusal, in the words a local install would use. */
  errors: string[]
  id: string | null
  version: string | null
  target: string | null
  /** SHA-256 of the `.vsix` bytes (for a folder, of the archive it builds). */
  digest: string | null
  /** A3 for a file with a `<file>.sig` beside it; a folder is never signed. */
  signature: LocalSignatureState
  disclosure: ManifestDisclosure | null
  risk: DisclosureRiskLevel | null
  /** The shared static scan, or null when no scanner is available. */
  scan: ScanReport | null
}

export interface LocalPackageToolDeps {
  /** Trust inputs of a local install (takedown list, local install trust); the
   * signature is filled in per file. */
  trust: () => LocalInstallTrust
  /** The `<file>.sig` beside a file, or null. */
  readSignature: (path: string) => string | null
  scan?: LocalPackageScanner
  /** Folders the Host keeps its own data in; a package is never written there. */
  protectedRoots: readonly string[]
  /** Extra Host checks a local install applies (engine range, packs). */
  assertInstallable?: (pkg: { id: string; version: string; manifest: unknown }) => void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function report(
  path: string,
  packageKind: LocalPackageReport['packageKind'],
  bytes: Uint8Array,
  signature: string | null,
  target: string | null,
  deps: LocalPackageToolDeps,
): Promise<LocalPackageReport> {
  const base: LocalPackageReport = {
    path, packageKind, valid: false, errors: [], id: null, version: null, target, digest: sha256Hex(bytes),
    signature: signature === null ? 'none' : 'unverifiable', disclosure: null, risk: null, scan: null,
  }
  try {
    const pkg = prepareLocalInstall(bytes, { ...deps.trust(), signature })
    deps.assertInstallable?.({ id: pkg.id, version: pkg.version, manifest: pkg.manifest })
    const disclosure = isManifestV2(pkg.manifest)
      ? computeDisclosure(pkg.manifest as unknown as DisclosureManifestInput)
      : null
    let scan: ScanReport | null = null
    if (deps.scan) {
      try {
        const files = new Map(pkg.entries.flatMap((entry) => {
          const archivePath = entry.type === 'regular' ? canonicalArchivePath(entry.path, 'regular') : null
          return archivePath === null ? [] : [[archivePath, new Uint8Array(entry.data)] as const]
        }))
        scan = await deps.scan({ files, artifactDigest: pkg.digest, target: pkg.localTarget ?? 'universal', manifest: pkg.manifest })
      } catch {
        scan = null
      }
    }
    return {
      ...base,
      valid: true,
      id: pkg.id,
      version: pkg.version,
      target: target ?? pkg.localTarget ?? null,
      signature: pkg.localSignature?.state ?? 'none',
      disclosure,
      risk: disclosure ? cardRiskLevel(disclosure, scan) : null,
      scan,
    }
  } catch (error) {
    return { ...base, errors: [message(error)] }
  }
}

async function folderReport(
  path: string,
  target: string | undefined,
  deps: LocalPackageToolDeps,
): Promise<{ report: LocalPackageReport; built: FolderPackage | null }> {
  let built: FolderPackage
  try {
    built = buildFolderPackage(path, target)
  } catch (error) {
    return {
      report: {
        path, packageKind: 'folder', valid: false, errors: [message(error)], id: null, version: null,
        target: target ?? null, digest: null, signature: 'none', disclosure: null, risk: null, scan: null,
      },
      built: null,
    }
  }
  return { report: await report(path, 'folder', built.bytes, null, built.target, deps), built }
}

/** plugins_validate_package: check a `.vsix` or a plugin folder. Read-only. */
export async function validateLocalPackage(path: string, deps: LocalPackageToolDeps): Promise<LocalPackageReport> {
  if (!isAbsolute(path)) throw new Error('path must be absolute')
  const stat = statSync(path)
  if (stat.isDirectory()) return (await folderReport(path, undefined, deps)).report
  if (!stat.isFile()) throw new Error('path is not a regular file or a folder')
  return report(path, 'file', new Uint8Array(readFileSync(path)), deps.readSignature(path), null, deps)
}

function insideAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    let resolvedRoot: string
    try {
      resolvedRoot = realpathSync(root)
    } catch {
      resolvedRoot = root
    }
    const rel = relative(resolvedRoot, path)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

/** Where plugins_package writes: `out`, or the SDK's file name beside the
 * folder. Only a `.vsix` path, in an existing folder outside Navide's own
 * data, never through a symlink and never over anything but a regular file. */
export function packageOutputPath(folder: string, built: FolderPackage, out: string | undefined, protectedRoots: readonly string[]): string {
  const target = out ?? join(dirname(folder), defaultPackageFileName(built.manifest, built.target))
  if (!isAbsolute(target)) throw new Error('out must be an absolute path')
  if (!target.endsWith('.vsix')) throw new Error('out must name a .vsix file')
  const parent = realpathSync(dirname(target))
  if (!statSync(parent).isDirectory()) throw new Error('the folder for out does not exist')
  const resolved = join(parent, basename(target))
  if (insideAny(resolved, protectedRoots)) throw new Error("a package cannot be written into Navide's own data folder")
  try {
    const existing = lstatSync(resolved)
    if (!existing.isFile()) throw new Error('out exists and is not a regular file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return resolved
}

/** plugins_package: build a `.vsix` from a folder and write it. The report
 * describes the written file; nothing is written when the folder fails. */
export async function packageLocalFolder(
  folder: string,
  options: { target?: string; out?: string },
  deps: LocalPackageToolDeps,
): Promise<LocalPackageReport> {
  if (!isAbsolute(folder)) throw new Error('path must be absolute')
  if (!statSync(folder).isDirectory()) throw new Error('path must be a plugin folder')
  const { report: checked, built } = await folderReport(folder, options.target, deps)
  if (!checked.valid || !built) return checked
  const output = packageOutputPath(folder, built, options.out, deps.protectedRoots)
  const temporary = `${output}.${randomUUID()}.tmp`
  writeFileSync(temporary, built.bytes, { mode: 0o644, flag: 'wx' })
  renameSync(temporary, output)
  return { ...checked, path: output, packageKind: 'file' }
}
