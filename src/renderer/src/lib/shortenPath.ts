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

/**
 * Shorten a single token that has no path segments to drop (a URL, a server
 * name, an id) by cutting its middle: `https://mcp.ex…com/mcp`. Both ends stay,
 * because the scheme or host and the last part are what people recognise. A
 * token that already fits is returned unchanged; the caller keeps the full
 * text in a tooltip.
 */
export function shortenMiddle(text: string, max = 40): string {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}
