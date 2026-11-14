/**
 * planHistory.ts
 *
 * Pure helpers for the plan history panel (plan-doc-interactivity Phase C).
 * The backend writes stage-transition snapshots to
 * `.agent-team/plans/.history/<plan-stem>/<YYYYMMDDTHHMMSS>_<stage>.html`;
 * this module maps plan paths to their history directory, parses snapshot
 * filenames, and computes a lightweight summary diff between two plan
 * documents (meta-level changes plus line add/remove counts — no HTML diff
 * engine).
 */
import { parseHtmlPlanMeta } from './usePlanHtml'
import { parsePlanMeta } from './usePlanFile'
import type { PlanMeta } from './planModel'

/**
 * History directory for a plan: `<its own dir>/.history/<stem>`.
 *
 * Derived from the plan's directory rather than a fixed prefix, so a document
 * belonging to a nested plan root keeps its snapshots beside itself — two roots
 * holding a same-named plan would otherwise share one history directory and
 * show each other's snapshots.
 */
export function planHistoryDirRelPath(planRelPath: string): string {
  const cut = planRelPath.lastIndexOf('/')
  const dir = cut === -1 ? '.agent-team/plans' : planRelPath.slice(0, cut)
  const name = planRelPath.slice(cut + 1)
  const stem = name.replace(/\.plan\.md$/, '').replace(/\.html$/, '')
  return `${dir}/.history/${stem}`
}

export interface PlanSnapshotName {
  /** Raw `YYYYMMDDTHHMMSS` timestamp — sortable lexicographically. */
  ts: string
  stage: string
  date: Date
}

const SNAPSHOT_NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})_([a-z-]+)\.(?:html|plan\.md)$/

/** Parse a `<YYYYMMDDTHHMMSS>_<stage>.(html|plan.md)` snapshot filename; null if not one. */
export function parseSnapshotName(name: string): PlanSnapshotName | null {
  const m = SNAPSHOT_NAME_RE.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s, stage] = m
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const min = Number(mi)
  const sec = Number(s)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) {
    return null
  }
  return {
    ts: `${y}${mo}${d}T${h}${mi}${s}`,
    stage,
    date: new Date(Number(y), month - 1, day, hour, min, sec),
  }
}

export interface PlanDiffSummary {
  stageFrom: string | null
  stageTo: string | null
  todoChanges: Array<{ id: string; from: string; to: string }>
  todosAdded: number
  todosRemoved: number
  /** New review-note count minus old (signed). */
  notesDelta: number
  linesAdded: number
  linesRemoved: number
}

/**
 * Parse plan meta from either format: an HTML `plan-meta` island or a `.plan.md`
 * YAML frontmatter. Detection is by content (HTML island first, markdown
 * fallback), so the diff works for both formats without a path hint.
 */
function parseAnyPlanMeta(content: string): PlanMeta | null {
  const html = parseHtmlPlanMeta(content)
  if (html) return { ...html.meta, format: 'html' } as PlanMeta
  return parsePlanMeta(content)
}

/**
 * Summary diff between two plan documents: stage/todo/note changes come from
 * the plan-meta blocks (null-safe when either side has none); line counts use
 * a simple per-line multiset comparison. Both HTML and markdown plans are
 * supported — meta is extracted via the unified `parseAnyPlanMeta`.
 */
export function diffPlanContents(oldContent: string, newContent: string): PlanDiffSummary {
  const oldMeta = parseAnyPlanMeta(oldContent)
  const newMeta = parseAnyPlanMeta(newContent)

  const oldTodos = new Map((oldMeta?.todos ?? []).map((todo) => [todo.id, todo.status]))
  const newTodos = new Map((newMeta?.todos ?? []).map((todo) => [todo.id, todo.status]))
  const todoChanges: Array<{ id: string; from: string; to: string }> = []
  let todosAdded = 0
  for (const [id, to] of newTodos) {
    const from = oldTodos.get(id)
    if (from === undefined) todosAdded++
    else if (from !== to) todoChanges.push({ id, from, to })
  }
  let todosRemoved = 0
  for (const id of oldTodos.keys()) {
    if (!newTodos.has(id)) todosRemoved++
  }

  // Line multiset: added = new lines without a matching old occurrence,
  // removed = old occurrences left unconsumed.
  const counts = new Map<string, number>()
  for (const line of oldContent.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  let linesAdded = 0
  for (const line of newContent.split('\n')) {
    const remaining = counts.get(line) ?? 0
    if (remaining > 0) counts.set(line, remaining - 1)
    else linesAdded++
  }
  let linesRemoved = 0
  for (const remaining of counts.values()) linesRemoved += remaining

  return {
    stageFrom: oldMeta?.stage ?? null,
    stageTo: newMeta?.stage ?? null,
    todoChanges,
    todosAdded,
    todosRemoved,
    notesDelta: (newMeta?.reviewNotes.length ?? 0) - (oldMeta?.reviewNotes.length ?? 0),
    linesAdded,
    linesRemoved,
  }
}

// ── Text diff between two versions ─────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/**
 * The reader-visible text of a plan, one line per block: for HTML the markup
 * is dropped (the plan-meta island, scripts and styles entirely) and common
 * entities decoded; for markdown the frontmatter is dropped. The format is
 * the plan file's (`relPath`), never guessed from the text, which in a
 * markdown plan may hold HTML tags. Blank lines are left out, so a diff shows
 * changed prose, not reformatting.
 */
export function visiblePlanLines(content: string, relPath: string): string[] {
  let text: string
  if (relPath.endsWith('.html')) {
    text = content
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(?:br|\/p|\/li|\/h[1-6]|\/tr|\/div|\/section|\/header|\/pre|\/td|\/th)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
        if (name[0] === '#') {
          const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
          return Number.isFinite(code) ? String.fromCodePoint(code) : whole
        }
        return ENTITIES[name.toLowerCase()] ?? whole
      })
  } else {
    const end = content.startsWith('---') ? content.indexOf('\n---', 3) : -1
    text = end === -1 ? content : content.slice(end + 4)
  }
  return text.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

/** Above this many line pairs the diff falls back to removed-then-added. */
const DIFF_MAX_CELLS = 4_000_000

/**
 * A line diff of `before` → `after` (longest common subsequence). Very large
 * inputs fall back to every removed line followed by every added line, which
 * is still complete, only less aligned.
 */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  const head = before.slice(0, start).map(text => ({ kind: 'same' as const, text }))
  const tail = before.slice(endBefore).map(text => ({ kind: 'same' as const, text }))
  const a = before.slice(start, endBefore)
  const b = after.slice(start, endAfter)
  if (a.length * b.length > DIFF_MAX_CELLS) {
    return [...head, ...a.map(text => ({ kind: 'del' as const, text })), ...b.map(text => ({ kind: 'add' as const, text })), ...tail]
  }
  // lengths[i][j] = LCS of a[i..] and b[j..], in one flat array.
  const width = b.length + 1
  const lengths = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] = a[i] === b[j]
        ? lengths[(i + 1) * width + j + 1] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
    }
  }
  const middle: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      middle.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      middle.push({ kind: 'del', text: a[i++] })
    } else {
      middle.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < a.length) middle.push({ kind: 'del', text: a[i++] })
  while (j < b.length) middle.push({ kind: 'add', text: b[j++] })
  return [...head, ...middle, ...tail]
}

/**
 * Whether the plan's text changed since `approved` (the snapshot taken when it
 * was approved). Todo lists and the stage badge are left out: they are meant
 * to move after approval, through the toolbar and the plan tools (g6).
 */
export function textChangedSinceApproval(approved: string, current: string, relPath: string): boolean {
  const prose = (content: string) => visiblePlanLines(
    content
      .replace(/<ul\b[^>]*\bclass=["'][^"']*\btodos\b[^"']*["'][^>]*>[\s\S]*?<\/ul>/gi, '')
      .replace(/<span\b[^>]*\bclass=["'][^"']*\bpill\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, ''),
    relPath,
  ).join('\n')
  return prose(approved) !== prose(current)
}
