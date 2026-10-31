import { parsePathLine, workspaceRelativePath, type PathLine } from './pathLine'
import { rankWorkspaceFiles, type WorkspaceFileRow } from './quickOpen'

/** Enough candidates that ranking sees the good ones; a query narrows them fast. */
const QUERY_LIMIT = 200
const SHOWN_LIMIT = 20

export interface WorkspaceFileSource {
  query(request: { query: string; matchOn: 'name' | 'path'; mode: 'substring' | 'subsequence'; limit: number }): Promise<WorkspaceFileRow[]>
  isFile(path: string): Promise<boolean>
}

const BUSY_RETRIES = 4
const BUSY_WAIT_MS = 150

/** The Host runs one query per plugin and answers `busy` to the rest. Without
 * retrying, the query for the last keystroke would be the one lost. */
export async function retryWhileBusy<T extends { error?: string | undefined }>(
  send: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let answer = await send()
  for (let attempt = 0; attempt < BUSY_RETRIES && answer.error === 'busy'; attempt++) {
    await wait(BUSY_WAIT_MS)
    answer = await send()
  }
  return answer
}

/** Workspace files for a Quick Open query, ranked. Exact text first; a loose
 * subsequence pass only when that found too little. */
export async function searchWorkspaceFiles(source: WorkspaceFileSource, query: string): Promise<WorkspaceFileRow[]> {
  const exact = await source.query({ query, matchOn: 'path', mode: 'substring', limit: QUERY_LIMIT })
  const rows = exact.length >= SHOWN_LIMIT
    ? exact
    : [...exact, ...await source.query({ query, matchOn: 'path', mode: 'subsequence', limit: QUERY_LIMIT })]
  const seen = new Set<string>()
  const unique = rows.filter((row) => !seen.has(row.path) && seen.add(row.path))
  return rankWorkspaceFiles(query, unique).slice(0, SHOWN_LIMIT)
}

/** Resolve what a terminal link names to one workspace file. Null means this
 * plugin cannot tell: outside the workspace, nothing there, or several files
 * fit. The Host picker then asks the user, as it owns anything past that. */
export async function resolveWorkspaceFileLink(
  source: WorkspaceFileSource,
  candidates: readonly string[],
  workspacePath: string,
): Promise<PathLine | null> {
  for (const candidate of candidates) {
    const { path, ...location } = parsePathLine(candidate)
    const relative = workspaceRelativePath(path, workspacePath)
    if (!relative) continue
    if (await source.isFile(relative)) return { path: relative, ...location }
    const tail = `/${relative.toLowerCase()}`
    const rows = (await source.query({ query: relative, matchOn: 'path', mode: 'substring', limit: 2 }))
      .filter((row) => `/${row.path.toLowerCase()}`.endsWith(tail))
    if (rows.length === 1) return { path: rows[0].path, ...location }
    if (rows.length > 1) return null
  }
  return null
}
