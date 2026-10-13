/**
 * debugLog.ts
 *
 * Pure helpers behind the Debug modal's backend.log tail: level detection,
 * incremental chunk splitting, and filtering. Kept out of the component so the
 * parts that are easy to get subtly wrong — a poll landing mid-line, the line
 * cap, a level filter meeting a traceback — are directly testable.
 *
 * Log format (see backend/agent_team_backend/applog.py):
 *   [2026-08-06 16:58:42,251] WARNING agent_team_backend.terminals: message
 */

export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

/** Anchored at the start of the line so a level word quoted inside a message —
 *  log lines routinely carry whole command lines and JSON — cannot be mistaken
 *  for the record's own level. */
const HEADER = /^\[[^\]]*\] ([A-Z]+) /

/** The line's own level, or '' for continuation lines (traceback bodies). */
export function logLineLevel(line: string): '' | LogLevel {
  const match = HEADER.exec(line)
  if (!match) return ''
  const level = match[1] as LogLevel
  return LOG_LEVELS.includes(level) ? level : ''
}

export interface ChunkSplit {
  /** Complete lines, newline stripped. */
  lines: string[]
  /** Bytes after the last newline — carry into the next call. */
  partial: string
}

/** Split a freshly read chunk into whole lines, joining the leftover from the
 *  previous read. A poll can land anywhere in the file, so the tail of a chunk
 *  is only a line once the next chunk supplies its newline. */
export function splitLogChunk(partial: string, chunk: string): ChunkSplit {
  const parts = (partial + chunk).split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, partial: rest }
}

/** Append `incoming` to `lines`, keeping at most `max` from the end. */
export function capLines(lines: string[], incoming: string[], max: number): string[] {
  if (incoming.length === 0) return lines
  const next = lines.concat(incoming)
  return next.length > max ? next.slice(next.length - max) : next
}

export interface LogFilter {
  /** Minimum level to show, or 'all' for no level gate. */
  minLevel: 'all' | LogLevel
  /** Case-insensitive substring match; empty means no text gate. */
  text: string
}

/** Filter by minimum level and substring.
 *
 *  Continuation lines carry no level of their own, so a level filter drops
 *  them: keeping them would show traceback bodies under an ERROR filter whose
 *  own header line had already been filtered out. */
export function filterLogLines(lines: string[], filter: LogFilter): string[] {
  const query = filter.text.trim().toLowerCase()
  const floor = filter.minLevel === 'all' ? -1 : LOG_LEVELS.indexOf(filter.minLevel)
  if (floor < 0 && !query) return lines
  return lines.filter((line) => {
    if (floor >= 0) {
      const own = logLineLevel(line)
      if (own === '' || LOG_LEVELS.indexOf(own) < floor) return false
    }
    return !query || line.toLowerCase().includes(query)
  })
}

/** A /ws URL with its `t=` token value masked, for display: the token is the
 *  backend credential, and a screenshot of the Debug window must not leak it. */
export function maskWsUrlToken(url: string): string {
  return url.replace(/([?&]t=)[^&#]*/, '$1••••')
}
