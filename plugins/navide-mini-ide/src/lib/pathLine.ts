export interface PathLine {
  path: string
  line?: number
  column?: number
  endLine?: number
}

// `#L10-L20`, `#L10C5`, `#10`, `:10-20`, `:10`, `:10:5`, `:10.5`, `(10)`, `(10,5)`, `[10]`.
const SUFFIX = /(?:#L(\d+)(?:C(\d+))?(?:-L?(\d+))?|#(\d+)|:(\d+)-(\d+)|:(\d+)(?:[.:](\d+))?|[([](\d+)(?:[,:](\d+))?[)\]])$/

/** Split a location off a path. A suffix naming line 0 is kept as part of the
 * path, and an end before its start is dropped. */
export function parsePathLine(raw: string): PathLine {
  const text = raw.trim()
  const match = SUFFIX.exec(text)
  if (!match) return { path: text }
  const [, gitLine, gitColumn, gitEnd, hashLine, rangeLine, rangeEnd, colonLine, colonColumn, parenLine, parenColumn] = match
  const line = Number(gitLine ?? hashLine ?? rangeLine ?? colonLine ?? parenLine)
  if (line < 1) return { path: text }
  const column = Number(gitColumn ?? colonColumn ?? parenColumn)
  const endLine = Number(gitEnd ?? rangeEnd)
  return {
    path: text.slice(0, match.index),
    line,
    ...(column > 0 ? { column } : {}),
    ...(endLine >= line ? { endLine } : {}),
  }
}

/** The workspace-relative form of `path`, or null for a path outside it. */
export function workspaceRelativePath(path: string, workspacePath: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const root = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1)
  if (/^(?:\/|[A-Za-z]:\/|~)/.test(normalized) || normalized.split('/').includes('..')) return null
  return normalized
}
