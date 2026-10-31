/** Shared with fs.queryFiles: a picker search is the same backend query. */
export const MAX_EXCLUDES = 64
export const MAX_EXCLUDE_CHARS = 256

/** Candidates are untrusted presentation input. They confer no
 * filesystem authority; only selection in the Host picker can open a target. */
export interface FilePickerRequest {
  query: string
  candidates: string[]
  line?: number
  sessionId?: string
  /** Locations the caller parsed itself. When set they replace `candidates`,
   * and the Host parses nothing. As untrusted as candidates are. */
  targets?: FilePickerTarget[]
  /** How the picker searches. Without it the Host uses its own default. */
  search?: FilePickerSearch
}

export interface FilePickerTarget {
  path: string
  line?: number
}

export interface FilePickerSearch {
  matchOn?: 'name' | 'path'
  mode?: 'substring' | 'subsequence' | 'glob'
  exclude?: string[]
  respectGitignore?: boolean
  includeHidden?: boolean
}

/** Terminal file references preserve the existing :line[:column], (line),
 * [line] and #line suffix forms, plus a :start-end range whose end is only
 * reported. Parsing never resolves filesystem authority.
 * @deprecated Kept for string candidates; a caller should send `targets`. */
export function splitFilePickerCandidate(raw: string): { path: string; line?: number; endLine?: number } {
  const match = /(?::([\d]+)(?:[.:]([\d]+))?|[(\[]([\d]+)(?:[,:]([\d]+))?[)\]]|#([\d]+)(?::([\d]+))?|:([\d]+)-([\d]+))$/.exec(raw)
  if (!match || match.index === undefined) return { path: raw }
  const line = Number(match[1] ?? match[3] ?? match[5] ?? match[7])
  const endLine = Number(match[8])
  return {
    path: raw.slice(0, match.index),
    ...(line > 0 ? { line } : {}),
    ...(line > 0 && endLine >= line ? { endLine } : {}),
  }
}

function validTarget(value: unknown): value is FilePickerTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const target = value as Record<string, unknown>
  if (Object.keys(target).some(key => !['path', 'line'].includes(key))) return false
  if (typeof target.path !== 'string' || !target.path) return false
  return target.line === undefined || (Number.isInteger(target.line) && Number(target.line) >= 1)
}

function validSearch(value: unknown): value is FilePickerSearch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const search = value as Record<string, unknown>
  if (Object.keys(search).some(key => !['matchOn', 'mode', 'exclude', 'respectGitignore', 'includeHidden'].includes(key))) return false
  if (search.matchOn !== undefined && search.matchOn !== 'name' && search.matchOn !== 'path') return false
  if (search.mode !== undefined && !['substring', 'subsequence', 'glob'].includes(search.mode as string)) return false
  if (search.exclude !== undefined && !(
    Array.isArray(search.exclude) && search.exclude.length <= MAX_EXCLUDES &&
    search.exclude.every(item => typeof item === 'string' && item.length <= MAX_EXCLUDE_CHARS)
  )) return false
  return ['respectGitignore', 'includeHidden'].every(key => search[key] === undefined || typeof search[key] === 'boolean')
}

export function validFilePickerRequest(value: unknown): value is FilePickerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const args = value as Record<string, unknown>
  if (Object.keys(args).some(key => !['query', 'candidates', 'line', 'sessionId', 'targets', 'search'].includes(key))) return false
  if (args.targets !== undefined && !(Array.isArray(args.targets) && args.targets.every(validTarget))) return false
  if (args.search !== undefined && !validSearch(args.search)) return false
  if (typeof args.query !== 'string' || !Array.isArray(args.candidates) || !args.candidates.every(path => typeof path === 'string')) return false
  if (args.line !== undefined && (!Number.isInteger(args.line) || Number(args.line) < 1)) return false
  if (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !args.sessionId)) return false
  return true
}
