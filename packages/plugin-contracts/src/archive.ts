/** Canonical portable archive path and collision policy for plugin packages. */

export type ArchivePathKind = 'regular' | 'directory'

export const MAX_ARCHIVE_PATH_LENGTH = 1024

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|(?:com|lpt)[1-9\u00b9\u00b2\u00b3])$/i

/** Whether Windows treats a path segment as a device: a reserved name on its
 *  own or before any extension or stream (`CON`, `nul.txt`, `com1 .js`,
 *  `aux:x`), any case, with trailing spaces and dots ignored. */
export function isWindowsReservedName(segment: string): boolean {
  return WINDOWS_RESERVED_NAME.test(segment.split(/[.:]/, 1)[0].replace(/[ .]+$/, ''))
}

function canonicalRelativePath(path: string): string | null {
  if (
    path.length === 0 ||
    path.length > MAX_ARCHIVE_PATH_LENGTH ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.includes('\\') ||
    /^[a-zA-Z]:/.test(path)
  ) {
    return null
  }

  const segments = path.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return null
  }
  return path
}

/** Return a safe Manifest v2 package-relative file path, or null. */
export function canonicalPackagePath(path: string): string | null {
  const canonical = canonicalRelativePath(path)
  return canonical !== null && /^[A-Za-z0-9._/-]+$/.test(canonical) ? canonical : null
}

/** Return a safe Manifest v2 package-relative HTML path, or null. */
export function canonicalHtmlPath(path: string): string | null {
  const canonical = canonicalPackagePath(path)
  return canonical !== null && canonical.endsWith('.html') ? canonical : null
}

/**
 * Return the canonical archive key, or null when the entry is unsafe.
 * Directory entries may use the ZIP-conventional single trailing slash.
 */
export function canonicalArchivePath(path: string, kind: ArchivePathKind): string | null {
  let candidate = path
  if (kind === 'directory' && candidate.endsWith('/')) candidate = candidate.slice(0, -1)
  return canonicalRelativePath(candidate)
}

/**
 * Return the key used to detect aliases on case-insensitive filesystems.
 * The original canonical path remains the archive entry name.
 */
export function portableArchiveCollisionKey(path: string): string | null {
  const segments = path.split('/').map((segment) =>
    segment.normalize('NFC').toLowerCase().replace(/[. ]+$/g, '')
  )
  if (segments.some((segment) => segment.length === 0)) return null
  return segments.join('/')
}

/** Compare archive paths independently of the process locale. */
export function comparePortableArchivePaths(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export type PortableArchiveEntry = {
  path: string
  type: ArchivePathKind
}

export type PortableArchiveValidationIssue =
  | { kind: 'unsafe-path'; path: string }
  | { kind: 'duplicate'; path: string }
  | { kind: 'regular-file-ancestor'; path: string }

/**
 * Validate the path policy shared by the SDK packager and Host archive reader.
 * A null result means every entry has a unique portable extraction identity.
 */
export function validatePortableArchiveEntries(
  entries: readonly PortableArchiveEntry[]
): PortableArchiveValidationIssue | null {
  const seen = new Set<string>()
  const regularPaths = new Set<string>()
  const ancestorPaths = new Set<string>()

  for (const entry of entries) {
    const canonical = canonicalArchivePath(entry.path, entry.type)
    if (canonical === null) return { kind: 'unsafe-path', path: entry.path }

    const collisionKey = portableArchiveCollisionKey(canonical)
    if (collisionKey === null) return { kind: 'unsafe-path', path: entry.path }
    if (seen.has(collisionKey)) return { kind: 'duplicate', path: entry.path }
    seen.add(collisionKey)

    if (entry.type === 'regular') regularPaths.add(collisionKey)
    const segments = collisionKey.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      ancestorPaths.add(segments.slice(0, index).join('/'))
    }
  }

  for (const path of regularPaths) {
    if (ancestorPaths.has(path)) return { kind: 'regular-file-ancestor', path }
  }
  return null
}
