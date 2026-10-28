/** Candidates are untrusted presentation input. They confer no
 * filesystem authority; only selection in the Host picker can open a target. */
export interface FilePickerRequest {
  query: string
  candidates: string[]
  line?: number
  sessionId?: string
}

/** Terminal file references preserve the existing :line[:column], (line),
 * [line] and #line suffix forms, plus a :start-end range whose end is only
 * reported. Parsing never resolves filesystem authority. */
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

export function validFilePickerRequest(value: unknown): value is FilePickerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const args = value as Record<string, unknown>
  if (Object.keys(args).some(key => !['query', 'candidates', 'line', 'sessionId'].includes(key))) return false
  if (typeof args.query !== 'string' || !Array.isArray(args.candidates) || !args.candidates.every(path => typeof path === 'string')) return false
  if (args.line !== undefined && (!Number.isInteger(args.line) || Number(args.line) < 1)) return false
  if (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !args.sessionId)) return false
  return true
}
