// Minimal, dependency-free reader for the `.vsix`-style plugin package (a ZIP
// archive with a root `manifest.json` + assets — see marketplace FORMAT.md).
// PURE logic: only `node:zlib` (a runtime builtin) is imported, so it is
// unit-testable and electron-free. Supports the two compression methods a
// packer emits — stored (0) and deflate (8) — which is all `registry/package.py`
// produces.
//
// The reader is intentionally small: it walks the End-Of-Central-Directory
// record → central directory → each local file header, and hands back decoded
// entries. Archive path/type defence is applied by `assertSafeArchiveEntries`
// from `pluginVerify` before manifest parsing or writing, so policy lives in
// one place.

import { inflateRawSync } from 'node:zlib'
import { TextDecoder } from 'node:util'
import { parseManifestJson } from './pluginManifest'
import { canonicalArchivePath } from './pluginPathPolicy'
import { assertSafeArchiveEntries } from './pluginVerify'

export type ZipEntryKind = 'file' | 'directory'
export type ZipEntryType = 'regular' | 'directory' | 'symlink' | 'special'

export interface ZipEntry {
  /** Archive-relative path exactly as stored (unvalidated). */
  path: string
  /** Decompressed file bytes. */
  data: Buffer
  /** Whether the archive entry represents a file or directory. */
  kind: ZipEntryKind
  /** Unix/DOS type classification retained for extraction preflight. */
  type: ZipEntryType
  /** True only for a regular Unix entry with at least one execute bit set. */
  executable: boolean
}

export class PluginPackageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginPackageError'
  }
}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Zip-bomb defence: cap the decompressed output of a single entry and of the
 *  whole archive so a small deflate stream cannot inflate to exhaust memory. */
const MAX_ENTRY_OUTPUT = 50 * 1024 * 1024 // 50 MB per entry
const MAX_TOTAL_OUTPUT = 200 * 1024 * 1024 // 200 MB per archive

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch (error) {
    throw new PluginPackageError(
      `${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** Locate the End-Of-Central-Directory record by scanning back from the end
 *  (the trailing 22-byte record may be followed by a variable comment). */
function findEocd(buf: Buffer): number {
  const min = 22
  if (buf.length < min) throw new PluginPackageError('not a zip archive (too short)')
  const start = Math.max(0, buf.length - min - 0xffff)
  for (let i = buf.length - min; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  throw new PluginPackageError('not a zip archive (no end-of-central-directory record)')
}

/** Decode every entry in a ZIP buffer. Throws {@link PluginPackageError} on a
 *  malformed archive or an unsupported compression method. */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEocd(buf)
  const entryCount = buf.readUInt16LE(eocd + 10)
  const entriesOnDisk = buf.readUInt16LE(eocd + 8)
  const centralDirectorySize = buf.readUInt32LE(eocd + 12)
  const centralDirectoryOffset = buf.readUInt32LE(eocd + 16)
  if (
    entriesOnDisk === 0xffff ||
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new PluginPackageError('ZIP64 archives are not supported')
  }
  let ptr = centralDirectoryOffset

  const entries: ZipEntry[] = []
  let totalOutput = 0
  for (let i = 0; i < entryCount; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== SIG_CENTRAL) {
      throw new PluginPackageError('corrupt central directory')
    }
    const method = buf.readUInt16LE(ptr + 10)
    const compSize = buf.readUInt32LE(ptr + 20)
    const uncompressedSize = buf.readUInt32LE(ptr + 24)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOffset = buf.readUInt32LE(ptr + 42)
    const versionMadeBy = buf.readUInt16LE(ptr + 4)
    const externalAttributes = buf.readUInt32LE(ptr + 38)
    const centralEnd = ptr + 46 + nameLen + extraLen + commentLen
    if (centralEnd > buf.length) {
      throw new PluginPackageError('central directory entry out of bounds')
    }
    const nameBytes = buf.subarray(ptr + 46, ptr + 46 + nameLen)
    const name = decodeUtf8(nameBytes, 'archive entry name')
    ptr = centralEnd

    const platform = versionMadeBy >>> 8
    // This classifies archive metadata only; extraction never creates symlinks
    // and writes accepted entries as regular files.
    const unixMode = platform === 3 ? externalAttributes >>> 16 : 0
    const unixType = unixMode & 0o170000
    let type: ZipEntryType = 'regular'
    const unixSpecial = unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000
    if (unixSpecial) type = unixType === 0o120000 ? 'symlink' : 'special'
    else if (
      name.endsWith('/') ||
      unixType === 0o040000 ||
      (platform !== 3 && (externalAttributes & 0x10) !== 0)
    ) {
      type = 'directory'
    }

    // Bounds-check the local header before reading it: a malformed central
    // directory could point past the buffer, which would otherwise raise an
    // uncaught RangeError instead of a PluginPackageError.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new PluginPackageError(`corrupt local header for ${name}`)
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    // The Registry's Python zipfile reader refuses an entry whose local name
    // differs from its central name; refuse it here too so both agree.
    if (
      localOffset + 30 + lNameLen > buf.length ||
      !buf.subarray(localOffset + 30, localOffset + 30 + lNameLen).equals(nameBytes)
    ) {
      throw new PluginPackageError(`local header name does not match central directory for ${name}`)
    }
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    if (dataStart > buf.length || compSize > buf.length - dataStart) {
      throw new PluginPackageError(`entry data out of bounds for ${name}`)
    }
    const raw = buf.subarray(dataStart, dataStart + compSize)
    if (uncompressedSize > MAX_ENTRY_OUTPUT) {
      throw new PluginPackageError(
        `entry ${name} exceeds the ${MAX_ENTRY_OUTPUT}-byte limit`
      )
    }

    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) {
      // Cap the inflated size so a zip bomb (tiny deflate → huge output) is
      // refused as a PluginPackageError rather than exhausting memory.
      try {
        data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_OUTPUT })
      } catch (err) {
        throw new PluginPackageError(
          `entry ${name} failed to inflate or exceeds the ${MAX_ENTRY_OUTPUT}-byte limit: ${(err as Error).message}`
        )
      }
    } else throw new PluginPackageError(`unsupported compression method ${method} for ${name}`)

    if (data.length !== uncompressedSize) {
      throw new PluginPackageError(`entry size does not match central directory for ${name}`)
    }

    totalOutput += data.length
    if (totalOutput > MAX_TOTAL_OUTPUT) {
      throw new PluginPackageError(
        `archive decompressed output exceeds the ${MAX_TOTAL_OUTPUT}-byte limit`
      )
    }

    entries.push({
      path: name,
      data,
      kind: type === 'directory' ? 'directory' : 'file',
      type,
      executable: type === 'regular' && (unixMode & 0o111) !== 0,
    })
  }
  // Python's zipfile walks the central directory by size, not by the EOCD
  // entry count, and tolerates data before or after it. Require the walked
  // directory to end exactly at its declared size and at the EOCD record, so
  // the Host never installs a different set of entries than the Registry saw.
  if (ptr !== centralDirectoryOffset + centralDirectorySize || ptr !== eocd) {
    throw new PluginPackageError('central directory does not end at the end-of-central-directory record')
  }
  return entries
}

/** Read and JSON-parse the root `manifest.json` from a package's entries.
 *  Throws {@link PluginPackageError} if absent or not valid JSON. */
export function readManifestFromEntries(entries: ZipEntry[]): Record<string, unknown> {
  assertSafeArchiveEntries(entries)
  const entry = entries.find(
    (e) =>
      e.type === 'regular' && canonicalArchivePath(e.path, 'regular') === 'manifest.json'
  )
  if (!entry) throw new PluginPackageError('package has no manifest.json at its root')
  try {
    return parseManifestJson(decodeUtf8(entry.data, 'manifest.json'))
  } catch (err) {
    if (err instanceof PluginPackageError) throw err
    throw new PluginPackageError(`manifest.json is not valid JSON: ${(err as Error).message}`)
  }
}
