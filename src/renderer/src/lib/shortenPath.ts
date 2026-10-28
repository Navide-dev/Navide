/**
 * Shorten a filesystem path for display by dropping whole segments from its
 * middle: `/private/var/…/T/navide/analyzer.json`. The head (root and first
 * folder) and as much of the tail as fits are kept, because the file name and
 * its parent are the part people recognise. A path that already fits is
 * returned unchanged; the caller keeps the full path in a tooltip.
 */
export function shortenPath(path: string, max = 64): string {
  if (path.length <= max) return path
  const sep = path.includes('/') ? '/' : '\\'
  const parts = path.split(sep)
  // An absolute POSIX path starts with an empty segment; keep it with the first folder.
  const headCount = parts[0] === '' ? 2 : 1
  if (parts.length <= headCount + 1) return path
  const head = parts.slice(0, headCount).join(sep)
  const tail: string[] = [parts[parts.length - 1]]
  for (let i = parts.length - 2; i >= headCount; i--) {
    const next = [parts[i], ...tail].join(sep)
    if (head.length + 3 + next.length > max) break
    tail.unshift(parts[i])
  }
  if (tail.length >= parts.length - headCount) return path
  return `${head}${sep}…${sep}${tail.join(sep)}`
}
