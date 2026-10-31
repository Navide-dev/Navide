export interface WorkspaceFileRow {
  path: string
  name: string
  mtime?: number
}

/** How well `query` fits a file, higher first; 0 for no match. The Host filters
 * and returns path order, so this is the only ranking a search gets. */
export function fileMatchScore(query: string, row: Pick<WorkspaceFileRow, 'path' | 'name'>): number {
  const needle = query.toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '')
  const path = row.path.toLowerCase()
  const name = row.name.toLowerCase()
  if (!needle) return 0
  if (path === needle) return 700
  if (path.endsWith(`/${needle}`)) return 600
  if (name === needle) return 500
  if (name.startsWith(needle)) return 400
  if (name.includes(needle)) return 300
  if (path.includes(needle)) return 200
  return subsequenceScore(needle, name) || subsequenceScore(needle, path) / 2
}

// Below every substring tier. Consecutive characters count for more.
function subsequenceScore(needle: string, target: string): number {
  let found = 0
  let run = 0
  let score = 0
  for (const char of target) {
    if (found === needle.length) break
    if (char === needle[found]) {
      found++
      run++
      score += run
    } else {
      run = 0
    }
  }
  if (found < needle.length) return 0
  return 1 + (99 * score) / (needle.length * (needle.length + 1) / 2) * (needle.length / target.length)
}

/** Best match first; a tie goes to the shorter path, then path order. */
export function rankWorkspaceFiles<T extends Pick<WorkspaceFileRow, 'path' | 'name'>>(query: string, rows: readonly T[]): T[] {
  return rows
    .map((row) => ({ row, score: fileMatchScore(query, row) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.row.path.length - b.row.path.length || a.row.path.localeCompare(b.row.path))
    .map(({ row }) => row)
}
