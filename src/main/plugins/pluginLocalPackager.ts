// Plan W1 (S1b): build a `.vsix` from a plugin folder in the Host, for the
// agent tool plugins_package. The rules and the archive bytes are those of
// `navide-plugin package` (packages/plugin-sdk/bin/navide-plugin.mjs): the
// folder's `artifact-files.json` lists every packaged file, source-only and
// secret files are refused, entries stay inside the frontend/assets/backend
// boundary, and the ZIP is deflated at level 9 with fixed metadata, so the
// same folder yields the same bytes from either tool. Nothing is signed: a
// signature is the publisher's, made with their own key.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, posix, relative } from 'node:path'
import { TextDecoder } from 'node:util'
import { deflateRawSync } from 'node:zlib'
import {
  canonicalArchivePath,
  comparePortableArchivePaths,
  manifestReferencedFiles,
  parseManifestJson,
  parseManifestV2,
  validatePortableArchiveEntries,
  type PluginManifestV2,
} from '../../../packages/plugin-contracts/src/index'

export const CANONICAL_FILE_LIST = 'artifact-files.json'
const SOURCE_ONLY_SEGMENTS = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'tests'])
const SOURCE_ONLY_FILE = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|pyproject\.toml|vite\.config\.[cm]?[jt]s)$/
const SOURCE_ONLY_EXTENSION = /\.(?:py|pyc|pyo|ts|tsx|vue|map)$/
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:key|pem|p12|pfx))$/i
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_TOTAL_BYTES = 200 * 1024 * 1024
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export class LocalPackageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalPackageError'
  }
}

const fail = (message: string): never => {
  throw new LocalPackageError(message)
}

function readNoFollow(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!fstatSync(fd).isFile()) fail(`'${path}' must be a regular file`)
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

function decode(bytes: Buffer, label: string): string {
  try {
    return UTF8.decode(bytes)
  } catch (error) {
    return fail(`${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export interface FolderPackageFile {
  path: string
  bytes: Buffer
  executable: boolean
}

export interface FolderPackage {
  manifest: PluginManifestV2
  target: string
  files: FolderPackageFile[]
  bytes: Buffer
}

/** The Host's own target, `<platform>-<arch>`, which a native backend is
 * built for (the SDK's rule: a backend package is packaged on its target). */
export function hostBuildTarget(): string {
  return `${process.platform}-${process.arch}`
}

function artifactTarget(manifest: PluginManifestV2, target: string): string {
  if (manifest.backend) {
    if (target !== hostBuildTarget()) {
      fail(`backend package target '${target}' must match the build host target '${hostBuildTarget()}'`)
    }
    return target
  }
  if (target !== 'universal') fail(`frontend-only package target must be 'universal', received '${target}'`)
  return target
}

function backendEntryForTarget(entry: string, target: string): string {
  return target.startsWith('win32-') && posix.extname(entry) === '' ? `${entry}.exe` : entry
}

function backendMatchesTarget(bytes: Buffer, target: string): boolean {
  const [platform, architecture] = target.split('-', 2)
  if (platform === 'linux') {
    if (bytes.length < 20 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return false
    const machine = bytes[5] === 1 ? bytes.readUInt16LE(18) : bytes[5] === 2 ? bytes.readUInt16BE(18) : -1
    return bytes[4] === 2 && ((architecture === 'x64' && machine === 62) || (architecture === 'arm64' && machine === 183))
  }
  if (platform === 'win32') {
    if (bytes.length < 0x40 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') return false
    const offset = bytes.readUInt32LE(0x3c)
    if (offset + 6 > bytes.length || bytes.subarray(offset, offset + 4).toString('ascii') !== 'PE\0\0') return false
    const machine = bytes.readUInt16LE(offset + 4)
    return (architecture === 'x64' && machine === 0x8664) || (architecture === 'arm64' && machine === 0xaa64)
  }
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf) return false
  const cpuType = bytes.readUInt32LE(4)
  return (architecture === 'x64' && cpuType === 0x01000007) || (architecture === 'arm64' && cpuType === 0x0100000c)
}

function parseFileList(directory: string): string[] {
  let parsed: unknown
  try {
    parsed = parseManifestJson(decode(readNoFollow(join(directory, CANONICAL_FILE_LIST)), CANONICAL_FILE_LIST))
  } catch (error) {
    return fail(`${CANONICAL_FILE_LIST} must be a JSON object with a files array: ${error instanceof Error ? error.message : String(error)}`)
  }
  const list = parsed as { files?: unknown } | null
  if (!list || typeof list !== 'object' || Array.isArray(list) || Object.keys(list).length !== 1 || !Array.isArray(list.files)) {
    fail(`${CANONICAL_FILE_LIST} must contain only a files array`)
  }
  const paths = (list as { files: unknown[] }).files
  if (paths.length === 0 || paths.some((path) => typeof path !== 'string')) {
    fail(`${CANONICAL_FILE_LIST}.files must be a nonempty string array`)
  }
  return paths as string[]
}

function assertNoSymlinkPath(root: string, path: string): void {
  let candidate = root
  const segments = path.split('/')
  for (const [index, segment] of segments.entries()) {
    candidate = join(candidate, segment)
    let stat
    try {
      stat = lstatSync(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(`package entry '${path}' does not exist`)
      throw error
    }
    if (stat.isSymbolicLink()) fail(`package entry '${path}' contains a symlink`)
    if (index < segments.length - 1 && !stat.isDirectory()) fail(`package entry '${path}' has a non-directory ancestor`)
  }
}

function collectFiles(directory: string, paths: string[], root: string): Array<{ path: string; bytes: Buffer }> {
  const files: Array<{ path: string; bytes: Buffer }> = []
  let totalSize = 0
  for (const path of paths) {
    if (canonicalArchivePath(path, 'regular') === null) fail(`package entry '${path}' is not a safe package-relative path`)
    if (path.split('/').some((segment) => SOURCE_ONLY_SEGMENTS.has(segment))) fail(`package entry '${path}' is source-only build input`)
    if (SOURCE_ONLY_FILE.test(path) || SOURCE_ONLY_EXTENSION.test(path) || SECRET_FILE.test(path)) {
      fail(`package entry '${path}' is source-only or secret material`)
    }
    const fullPath = join(directory, path)
    assertNoSymlinkPath(root, path)
    const stat = lstatSync(fullPath)
    if (!stat.isFile()) fail(`package entry '${path}' must be a regular file`)
    const inside = relative(root, realpathSync(fullPath))
    if (inside.startsWith('..') || isAbsolute(inside)) fail(`package entry '${fullPath}' resolves outside the package root`)
    if (stat.size > MAX_FILE_BYTES) fail(`package entry '${path}' exceeds the 50 MiB size limit`)
    totalSize += stat.size
    if (totalSize > MAX_TOTAL_BYTES) fail('package entries exceed the 200 MiB size limit')
    files.push({ path, bytes: readNoFollow(fullPath) })
  }
  return files
}

function validateFiles(manifest: PluginManifestV2, files: Array<{ path: string; bytes: Buffer }>, target: string, root: string): void {
  const paths = new Set(files.map((file) => file.path))
  if (!paths.has('manifest.json')) fail('package must contain manifest.json at its root')
  const declaredTargetSchemas = new Set(
    (manifest.contributes?.views ?? [])
      .map((view) => (view as { targetSchema?: unknown }).targetSchema)
      .filter((path): path is string => typeof path === 'string' && path.length > 0),
  )
  for (const path of paths) {
    if (path === 'manifest.json' || path === 'README.md') continue
    if (path.startsWith('frontend/') || path.startsWith('assets/') || path.startsWith('backend/')) continue
    if (declaredTargetSchemas.has(path)) continue
    fail(`package entry '${path}' is outside the frontend/assets/backend package boundary`)
  }
  const backendEntry = manifest.backend ? backendEntryForTarget(manifest.backend.entry, target) : null
  for (const path of manifestReferencedFiles(manifest)) {
    const referenced = path === manifest.backend?.entry ? backendEntry : path
    if (referenced !== null && !paths.has(referenced)) fail(`manifest references '${referenced}', but that file does not exist`)
  }
  const backendEntries = [...paths].filter((path) => path.startsWith('backend/'))
  const frontendEntries = [...paths].filter((path) => path.startsWith('frontend/'))
  if (backendEntry) {
    if (backendEntries.length !== 1 || backendEntries[0] !== backendEntry) {
      fail('backend package must contain exactly its declared self-contained backend executable')
    }
    const backend = files.find((file) => file.path === backendEntry)
    const backendStat = lstatSync(join(root, backendEntry))
    if (!backendStat.isFile() || (process.platform !== 'win32' && (backendStat.mode & 0o111) === 0)) {
      fail(`backend entry '${backendEntry}' must be marked executable`)
    }
    if (!backend || backend.bytes.subarray(0, 2).equals(Buffer.from('#!')) || !backendMatchesTarget(backend.bytes, target)) {
      fail(`backend entry '${backendEntry}' does not match declared target ${target}`)
    }
  } else if (backendEntries.length !== 0) {
    fail('frontend-only package must not contain backend entries')
  }
  if (!manifest.contributes && frontendEntries.length !== 0) fail('backend-only package must not contain frontend entries')
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value, 0)
  return buffer
}
const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

/** The SDK's deterministic ZIP: deflate level 9, fixed time and modes. */
function makeZip(files: FolderPackageFile[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const checksum = crc32(file.bytes)
    const deflated = deflateRawSync(file.bytes, { level: 9 })
    const header = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(0x21), u16(0), u32(checksum),
      u32(deflated.length), u32(file.bytes.length), u16(name.length), u16(0), name, deflated,
    ])
    local.push(header)
    central.push(Buffer.concat([
      u32(0x02014b50), u16(0x0314), u16(20), u16(0x0800), u16(8), u16(0x21), u16(0), u32(checksum),
      u32(deflated.length), u32(file.bytes.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32((file.executable ? 0o100755 : 0o100644) << 16), u32(offset), name,
    ]))
    offset += header.length
  }
  const centralBytes = Buffer.concat(central)
  const localBytes = Buffer.concat(local)
  return Buffer.concat([
    localBytes, centralBytes, u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBytes.length), u32(localBytes.length), u16(0),
  ])
}

/** Validate a plugin folder with the SDK's packaging rules and build its
 * archive in memory. Throws LocalPackageError with the SDK's wording. */
export function buildFolderPackage(directory: string, target?: string): FolderPackage {
  if (!lstatSync(directory).isDirectory()) fail(`package directory '${directory}' is not a directory`)
  const root = realpathSync(directory)
  const manifestStat = lstatSync(join(directory, 'manifest.json'))
  if (!manifestStat.isFile()) fail('manifest.json must be a regular file')
  const manifest = parseManifestV2(parseManifestJson(decode(readNoFollow(join(directory, 'manifest.json')), 'manifest.json')))
  const resolvedTarget = artifactTarget(manifest, target ?? (manifest.backend ? hostBuildTarget() : 'universal'))
  const collected = collectFiles(directory, parseFileList(directory), root).sort((left, right) =>
    comparePortableArchivePaths(left.path, right.path),
  )
  const issue = validatePortableArchiveEntries(collected.map((file) => ({ path: file.path, type: 'regular' as const })))
  if (issue) {
    if (issue.kind === 'unsafe-path') fail(`package entry '${issue.path}' is not a safe package-relative path`)
    if (issue.kind === 'duplicate') fail(`portable archive collision: '${issue.path}' duplicates another entry`)
    fail(`portable archive collision: '${issue.path}' is a regular-file ancestor`)
  }
  validateFiles(manifest, collected, resolvedTarget, root)
  const files = collected.map((file) => ({
    ...file,
    executable: manifest.backend !== undefined && backendEntryForTarget(manifest.backend.entry, resolvedTarget) === file.path,
  }))
  return { manifest, target: resolvedTarget, files, bytes: makeZip(files) }
}

/** The SDK's default file name for a package. */
export function defaultPackageFileName(manifest: PluginManifestV2, target: string): string {
  return `${manifest.id}-${manifest.version}-${target}.vsix`
}
