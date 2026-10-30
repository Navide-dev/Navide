/**
 * usePlanHtml.ts
 *
 * Parses and rewrites the `plan-meta` JSON island inside `.agent-team/plans/*.html`
 * plan documents. Contract: `.agent-team/plans/_spec.md` (schema v1).
 * Legacy `.plan.md` handling lives in usePlanFile.ts and is intentionally untouched.
 */

// The unified plan model is the source of truth for these shared shapes;
// the Html* names are kept as aliases so existing importers stay unchanged.
// Only the type/const declarations are re-exports — the parse/serialize logic
// below is untouched.
import { PLAN_STAGES, TODO_STATUSES } from './planModel'
import type { PlanStage, TodoStatus, PlanTodo, ReviewNote, PlanExecution } from './planModel'

export { PLAN_STAGES }
export type { PlanStage, PlanExecution }

export const HTML_TODO_STATUSES = TODO_STATUSES
export type HtmlTodoStatus = TodoStatus
export type HtmlPlanTodo = PlanTodo
export type HtmlPlanReviewNote = ReviewNote

export interface HtmlPlanMeta {
  schemaVersion: 1
  name: string
  overview: string
  stage: PlanStage
  approvedAt: string | null
  /** ISO timestamp when archived; null/absent = not archived (orthogonal to stage). */
  archivedAt?: string | null
  todos: HtmlPlanTodo[]
  reviewNotes: HtmlPlanReviewNote[]
  /** Optional dispatch log; absent means never dispatched. */
  executions?: PlanExecution[]
  /** Unknown fields are preserved verbatim for forward compatibility. */
  [key: string]: unknown
}

export interface HtmlPlanProgress {
  total: number
  done: number
}

// Matches the single machine-readable island. Attribute order tolerant; the
// spec guarantees exactly one such block per plan file. Case-insensitive and
// quote-style tolerant; the `\s` before `id` keeps `data-id="plan-meta"`
// from matching.
const PLAN_META_RE = /<script\b[^>]*\s(?:id="plan-meta"|id='plan-meta')[^>]*>([\s\S]*?)<\/script>/i

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Extract and validate the `plan-meta` JSON island.
 * Returns `null` when the block is missing, the JSON is malformed, or a hard
 * requirement fails (schemaVersion !== 1, name missing/empty) — callers treat
 * such files as plain docs. Recoverable issues (bad stage, bad todo status)
 * are downgraded to defaults and reported in `warnings`.
 */
export function parseHtmlPlanMeta(content: string): { meta: HtmlPlanMeta; warnings: string[] } | null {
  const match = content.match(PLAN_META_RE)
  if (!match) return null

  let raw: unknown
  try {
    raw = JSON.parse(match[1])
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  if (obj.schemaVersion !== 1) return null
  if (typeof obj.name !== 'string' || obj.name.trim() === '') return null

  const warnings: string[] = []

  let stage: PlanStage = 'draft'
  if (typeof obj.stage === 'string' && (PLAN_STAGES as readonly string[]).includes(obj.stage)) {
    stage = obj.stage as PlanStage
  } else {
    warnings.push(`invalid stage "${String(obj.stage)}" — downgraded to "draft"`)
  }

  const todos: HtmlPlanTodo[] = []
  if (Array.isArray(obj.todos)) {
    for (const entry of obj.todos) {
      if (typeof entry !== 'object' || entry === null) continue
      const t = entry as Record<string, unknown>
      let status: HtmlTodoStatus = 'pending'
      if (typeof t.status === 'string' && (HTML_TODO_STATUSES as readonly string[]).includes(t.status)) {
        status = t.status as HtmlTodoStatus
      } else {
        warnings.push(`invalid todo status "${String(t.status)}" on "${asString(t.id)}" — downgraded to "pending"`)
      }
      todos.push({ ...t, id: asString(t.id), content: asString(t.content), status })
    }
  }

  const reviewNotes: HtmlPlanReviewNote[] = []
  if (Array.isArray(obj.reviewNotes)) {
    for (const entry of obj.reviewNotes) {
      if (typeof entry !== 'object' || entry === null) continue
      const n = entry as Record<string, unknown>
      reviewNotes.push({
        ...n,
        id: asString(n.id),
        author: n.author === 'ai' ? 'ai' : 'user',
        text: asString(n.text),
        resolved: n.resolved === true,
        reply: asString(n.reply),
        anchor: asString(n.anchor),
      })
    }
  }

  let executions: PlanExecution[] | undefined
  if (obj.executions !== undefined) {
    if (Array.isArray(obj.executions)) {
      executions = []
      for (const entry of obj.executions) {
        if (typeof entry !== 'object' || entry === null) continue
        const e = entry as Record<string, unknown>
        executions.push({ ...e, agent: asString(e.agent), startedAt: asString(e.startedAt) })
      }
    } else {
      warnings.push('invalid executions (not an array) — dropped')
    }
  }

  // Spread first so unknown top-level fields survive the round-trip; known
  // fields are then overwritten with their validated values (spread keeps the
  // original key positions, so serialization order is stable).
  const meta: HtmlPlanMeta = {
    ...obj,
    schemaVersion: 1,
    name: obj.name,
    overview: asString(obj.overview),
    stage,
    approvedAt: typeof obj.approvedAt === 'string' ? obj.approvedAt : null,
    archivedAt: typeof obj.archivedAt === 'string' ? obj.archivedAt : null,
    todos,
    reviewNotes,
  }
  if (executions !== undefined) meta.executions = executions
  else delete meta.executions
  return { meta, warnings }
}

/**
 * Replace the JSON inside the `plan-meta` script block with the serialized
 * `meta` (2-space indent). Every byte outside the block is preserved verbatim.
 * Returns the input unchanged when no block is found.
 */
export function replaceHtmlPlanMeta(content: string, meta: HtmlPlanMeta): string {
  const match = content.match(PLAN_META_RE)
  if (!match || match.index === undefined) return content
  const openTagLength = match[0].length - match[1].length - '</script>'.length
  const innerStart = match.index + openTagLength
  const innerEnd = innerStart + match[1].length
  // JSON-escape every "<" (unicode escape) so strings like "</script>" or
  // "<!--" in the meta cannot terminate the script block early. JSON
  // semantics are unchanged; JSON.parse decodes the escape back natively.
  const json = JSON.stringify(meta, null, 2).replace(/</g, '\\u003c')
  return `${content.slice(0, innerStart)}\n${json}\n${content.slice(innerEnd)}`
}

/** done/total counts for list display; `skipped` counts toward neither. */
export function htmlPlanProgress(todos: HtmlPlanTodo[]): HtmlPlanProgress {
  return {
    total: todos.length,
    done: todos.filter((t) => t.status === 'done').length,
  }
}

/** How many unfinished todos are waiting on the user rather than on an agent.
 *
 *  `owner: 'user'` marks the things nobody else can do — a manual verification,
 *  a decision, a credential only they hold. Nobody comes back to tick those off,
 *  so without surfacing the count a finished write-up blocked on one check looks
 *  exactly like a plan nobody has started. `owner` is an optional field carried
 *  through PlanTodo's index signature, so older documents simply count zero. */
export function htmlPlanAwaitingUser(todos: HtmlPlanTodo[]): number {
  return todos.filter(
    (t) => (t as { owner?: unknown }).owner === 'user' && t.status !== 'done' && t.status !== 'skipped',
  ).length
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Sync the visible todo markup with a status change: update the `data-status`
 * attribute on the `<li data-todo-id="...">` element and the text of its
 * `<span class="st">` status pill. Returns the content unchanged when the
 * markup is not found — meta stays authoritative, markup sync is best-effort.
 */
export function syncTodoMarkup(content: string, todoId: string, status: HtmlTodoStatus): string {
  const liRe = new RegExp(`<li\\b[^>]*data-todo-id=["']${escapeRegExp(todoId)}["'][^>]*>`, 'i')
  const match = content.match(liRe)
  if (!match || match.index === undefined) return content

  const openTag = match[0].replace(/data-status=["'][^"']*["']/i, `data-status="${status}"`)
  const afterTag = match.index + match[0].length
  const closeIdx = content.indexOf('</li>', afterTag)
  const scopeEnd = closeIdx === -1 ? content.length : closeIdx
  const scope = content
    .slice(afterTag, scopeEnd)
    .replace(/(<span\b[^>]*class=["']st["'][^>]*>)[\s\S]*?(<\/span>)/i, `$1${status}$2`)
  return content.slice(0, match.index) + openTag + scope + content.slice(scopeEnd)
}

/**
 * Sync the header stage pill with a stage change: rewrite the stage class on
 * the first `<span class="pill ...">` and its visible text. Returns the
 * content unchanged when no pill markup is found.
 */
export function syncStageMarkup(content: string, stage: PlanStage): string {
  return content.replace(
    /(<span\b[^>]*class=["']pill\s+)[a-z-]+(["'][^>]*>)[\s\S]*?(<\/span>)/i,
    `$1${stage}$2${stage}$3`,
  )
}

// ── Structured content markup sync (todos + review notes) ──────────────────
// Companions to syncTodoMarkup for meta-level CRUD: keep the visible document
// markup in step with meta changes. All are best-effort — when the target
// markup is absent the content is returned unchanged (meta stays
// authoritative). Inserted text is HTML-escaped so plan content can never
// inject markup, break out of an attribute, or terminate the document.

/** Escape a value for safe insertion as an HTML text node. */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape a value for safe use inside a double-quoted HTML attribute. */
function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;')
}

// A `<ul class="... todos ...">…</ul>` block. Non-greedy: todo lists never nest.
const TODOS_UL_RE = /<ul\b[^>]*\bclass=["'][^"']*\btodos\b[^"']*["'][^>]*>[\s\S]*?<\/ul>/gi

/**
 * Insert a `<li data-todo-id>` for a newly added todo into the document's last
 * `<ul class="todos">` (best fit when a plan has several phase lists and the
 * caller has no explicit phase). Returns a `warning` and leaves the content
 * untouched when the document has no todos list — the meta write still
 * proceeds, only the body sync is skipped.
 */
export function addTodoMarkup(
  content: string,
  todo: { id: string; content: string; status: HtmlTodoStatus },
): { content: string; warning: string | null } {
  let last: RegExpMatchArray | null = null
  for (const m of content.matchAll(TODOS_UL_RE)) last = m
  if (!last || last.index === undefined) {
    return { content, warning: `no <ul class="todos"> found to sync new todo "${todo.id}"` }
  }
  const insertAt = last.index + last[0].lastIndexOf('</ul>')
  const li =
    `      <li data-status="${escapeHtmlAttr(todo.status)}" data-todo-id="${escapeHtmlAttr(todo.id)}">\n` +
    `        <span class="st">${escapeHtmlText(todo.status)}</span>\n` +
    `        <span>${escapeHtmlText(todo.content)}</span>\n` +
    `      </li>\n`
  return { content: content.slice(0, insertAt) + li + content.slice(insertAt), warning: null }
}

/** Remove the `<li data-todo-id>` of a deleted todo. No-op when absent. */
export function removeTodoMarkup(content: string, todoId: string): string {
  const re = new RegExp(
    `[^\\S\\n]*<li\\b[^>]*data-todo-id=["']${escapeRegExp(todoId)}["'][\\s\\S]*?<\\/li>[^\\S\\n]*\\n?`,
    'i',
  )
  return content.replace(re, '')
}

/**
 * Update the visible content text of an existing todo's `<li>` — the first
 * `<span>` inside the row that is not the `class="st"` status pill.
 */
export function setTodoContentMarkup(content: string, todoId: string, todoContent: string): string {
  const liRe = new RegExp(`<li\\b[^>]*data-todo-id=["']${escapeRegExp(todoId)}["'][^>]*>`, 'i')
  const match = content.match(liRe)
  if (!match || match.index === undefined) return content
  const afterTag = match.index + match[0].length
  const closeIdx = content.indexOf('</li>', afterTag)
  const scopeEnd = closeIdx === -1 ? content.length : closeIdx
  const scope = content
    .slice(afterTag, scopeEnd)
    .replace(/(<span\b(?![^>]*\bclass=)[^>]*>)[\s\S]*?(<\/span>)/i, `$1${escapeHtmlText(todoContent)}$2`)
  return content.slice(0, afterTag) + scope + content.slice(scopeEnd)
}

/**
 * Update the visible text of an existing review note's `<li data-note-id>` —
 * the text node between the `class="who"` author span and the optional
 * `.reply` block (or the row's `</li>`). No-op when the markup is absent.
 */
export function setNoteTextMarkup(content: string, noteId: string, text: string): string {
  const re = new RegExp(
    `(<li\\b[^>]*data-note-id=["']${escapeRegExp(noteId)}["'][^>]*>[\\s\\S]*?<span\\b[^>]*\\bclass=["']who["'][^>]*>[\\s\\S]*?<\\/span>)([\\s\\S]*?)(<div\\b[^>]*\\bclass=["']reply|<\\/li>)`,
    'i',
  )
  return content.replace(re, (_full, pre: string, _mid: string, tail: string) => `${pre}${escapeHtmlText(text)}${tail}`)
}

/** Remove a review note's `<li data-note-id>`. No-op when absent. */
export function removeNoteMarkup(content: string, noteId: string): string {
  const re = new RegExp(
    `[^\\S\\n]*<li\\b[^>]*data-note-id=["']${escapeRegExp(noteId)}["'][\\s\\S]*?<\\/li>[^\\S\\n]*\\n?`,
    'i',
  )
  return content.replace(re, '')
}

// ── Body section edit / delete ─────────────────────────────────────────────
// Anchor = the leading text of a section heading (h2/h3) or a `.phase-head`,
// whitespace-collapsed — the identity planRuntime derives on both frame and
// host. These operate on the document BODY, never the plan-meta island or the
// header, and refuse any region carrying a `<ul class="todos">` (todos are
// managed via the toolbar, and their data-* wiring must never be sanitized).

const HEADING_LEAD_RE =
  /<(h2|h3)\b[^>]*>|<div\b[^>]*\bclass=["'][^"']*\bphase-head\b[^"']*["'][^>]*>/gi
const SECTION_OPEN_RE = /<section\b[^>]*>/gi
// The `.phase` container only (token "phase"; not "phase-head"/"phase-body").
const PHASE_OPEN_RE = /<div\b[^>]*\bclass=["'](?:[^"']*\s)?phase(?:\s[^"']*)?["'][^>]*>/gi
const PHASE_BODY_OPEN_RE = /<div\b[^>]*\bclass=["'][^"']*\bphase-body\b[^"']*["'][^>]*>/gi

interface SectionLoc {
  kind: 'section' | 'phase' | 'heading'
  regionStart: number
  regionEnd: number
  bodyStart: number
  bodyEnd: number
}

function collapseWs(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Leading text (open tag end → next `<`), whitespace-collapsed. */
function leadTextAt(content: string, openTagEnd: number): string {
  const lt = content.indexOf('<', openTagEnd)
  return collapseWs(content.slice(openTagEnd, lt === -1 ? content.length : lt))
}

/** Index just past the tag's `>`; -1 when unterminated. */
function openTagEndIndex(content: string, startIdx: number): number {
  const gt = content.indexOf('>', startIdx)
  return gt === -1 ? -1 : gt + 1
}

/** End index (just past `</tag>`) of the element opening at `startIdx`, depth-counted. */
function elementRangeEnd(content: string, startIdx: number, tag: string): number {
  const re = new RegExp(`<${tag}\\b|<\\/${tag}\\s*>`, 'gi')
  re.lastIndex = startIdx
  let depth = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) {
    if (m[0].charAt(1) === '/') {
      depth -= 1
      if (depth === 0) return re.lastIndex
    } else {
      depth += 1
    }
  }
  return -1
}

/** Innermost element (of `tag`, matched by `openRe`) whose range covers `pos`. */
function enclosingElement(
  content: string,
  pos: number,
  tag: string,
  openRe: RegExp,
): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null
  openRe.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = openRe.exec(content))) {
    if (m.index > pos) break
    const end = elementRangeEnd(content, m.index, tag)
    if (end === -1 || end <= pos) continue
    if (!best || m.index > best.start) best = { start: m.index, end }
  }
  return best
}

/** Next heading at the same or higher level; lower headings belong to the body. */
function nextHeadingBoundary(content: string, from: number, level: number): number {
  const re = new RegExp(`<h[1-${level}]\\b`, 'gi')
  re.lastIndex = from
  const m = re.exec(content)
  return m ? m.index : content.length
}

// Elements that never carry a close tag, so they open no container.
const VOID_TAGS = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' '),
)
const ANY_TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g

/**
 * Index of the close tag that ends the heading's own parent — the point the
 * preview's sibling walk stops at. The first close tag with no matching open
 * tag after `from` is by definition the enclosing element's, so the body is
 * clamped to any container rather than to a whitelist of tag names.
 * Returns `content.length` when the heading has no enclosing element.
 */
function enclosingCloseBoundary(content: string, from: number): number {
  ANY_TAG_RE.lastIndex = from
  const open: string[] = []
  let m: RegExpExecArray | null
  while ((m = ANY_TAG_RE.exec(content))) {
    const tag = m[2].toLowerCase()
    if (m[1] === '/') {
      const depth = open.lastIndexOf(tag)
      if (depth === -1) return m.index
      open.length = depth
    } else if (m[3] !== '/' && !VOID_TAGS.has(tag)) {
      open.push(tag)
    }
  }
  return content.length
}

function locateSection(content: string, anchor: string): SectionLoc | null {
  const target = collapseWs(anchor)
  if (!target) return null
  HEADING_LEAD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = HEADING_LEAD_RE.exec(content))) {
    const openStart = m.index
    const openEnd = openStart + m[0].length
    if (leadTextAt(content, openEnd) !== target) continue

    if (m[0].toLowerCase().includes('phase-head')) {
      const phase = enclosingElement(content, openStart, 'div', PHASE_OPEN_RE)
      if (!phase) return null
      PHASE_BODY_OPEN_RE.lastIndex = phase.start
      const body = PHASE_BODY_OPEN_RE.exec(content)
      if (!body || body.index >= phase.end) return null
      const bodyStart = openTagEndIndex(content, body.index)
      const bodyRangeEnd = elementRangeEnd(content, body.index, 'div')
      if (bodyStart === -1 || bodyRangeEnd === -1) return null
      const bodyEnd = content.lastIndexOf('</div', bodyRangeEnd)
      return { kind: 'phase', regionStart: phase.start, regionEnd: phase.end, bodyStart, bodyEnd }
    }

    const tag = (m[1] ?? 'h2').toLowerCase()
    const closeMarker = `</${tag}>`
    const closeIdx = content.toLowerCase().indexOf(closeMarker, openEnd)
    const bodyStart = closeIdx === -1 ? openEnd : closeIdx + closeMarker.length
    if (tag === 'h2') {
      const section = enclosingElement(content, openStart, 'section', SECTION_OPEN_RE)
      if (section) {
        const bodyEnd = content.lastIndexOf('</section', section.end)
        return { kind: 'section', regionStart: section.start, regionEnd: section.end, bodyStart, bodyEnd }
      }
    }
    // A heading's body cannot include its enclosing element's closing tag.
    const bodyEnd = Math.min(
      nextHeadingBoundary(content, bodyStart, Number(tag.slice(1))),
      enclosingCloseBoundary(content, bodyStart),
    )
    return { kind: 'heading', regionStart: openStart, regionEnd: bodyEnd, bodyStart, bodyEnd }
  }
  return null
}

function rangeHasTodos(content: string, start: number, end: number): boolean {
  return /<ul\b[^>]*\bclass=["'][^"']*\btodos\b/i.test(content.slice(start, end))
}

function rangeIsProtected(content: string, start: number, end: number): boolean {
  const slice = content.slice(start, end)
  return /id=["']plan-meta["']/i.test(slice) || /<h1\b/i.test(slice) || /<header\b/i.test(slice)
}

/**
 * The source of the whole section/phase identified by `anchor` (heading
 * included), or null when the anchor is not found. Two versions of a document
 * whose regions are equal agree on that section.
 */
export function sectionRegion(content: string, anchor: string): string | null {
  const loc = locateSection(content, anchor)
  return loc ? content.slice(loc.regionStart, loc.regionEnd) : null
}

/**
 * Replace the prose body of the section/phase identified by `anchor` with
 * host-sanitized HTML, touching no other byte. Returns the content unchanged
 * when the anchor is not found, the region is protected (plan-meta / header /
 * h1), or the body carries a todo list.
 */
export function replaceSectionBody(content: string, anchor: string, sanitizedHtml: string): string {
  const loc = locateSection(content, anchor)
  if (!loc) return content
  if (rangeIsProtected(content, loc.regionStart, loc.regionEnd)) return content
  if (rangeHasTodos(content, loc.bodyStart, loc.bodyEnd)) return content
  return `${content.slice(0, loc.bodyStart)}\n${sanitizedHtml}\n${content.slice(loc.bodyEnd)}`
}

/**
 * Remove the whole section/phase identified by `anchor`. Same refusals as
 * replaceSectionBody (never touches plan-meta / header / a todo-bearing
 * region); no-op when the anchor is not found.
 */
export function deleteSection(content: string, anchor: string): string {
  const loc = locateSection(content, anchor)
  if (!loc) return content
  if (rangeIsProtected(content, loc.regionStart, loc.regionEnd)) return content
  if (rangeHasTodos(content, loc.regionStart, loc.regionEnd)) return content
  let start = loc.regionStart
  while (start > 0 && (content[start - 1] === ' ' || content[start - 1] === '\t')) start -= 1
  let end = loc.regionEnd
  if (content[end] === '\n') end += 1
  return content.slice(0, start) + content.slice(end)
}

/**
 * Inject a `plan-meta` JSON island into a plain HTML doc, promoting it to a
 * plan. Inserted before `</head>` when present, otherwise right after the
 * `<html>` open tag, otherwise prepended. Returns the content unchanged when
 * an island already exists.
 */
export function injectPlanMeta(content: string, meta: HtmlPlanMeta): string {
  if (PLAN_META_RE.test(content)) return content
  const json = JSON.stringify(meta, null, 2).replace(/</g, '\\u003c')
  const block = `<script type="application/json" id="plan-meta">\n${json}\n</script>\n`
  const headClose = content.search(/<\/head>/i)
  if (headClose !== -1) return content.slice(0, headClose) + block + content.slice(headClose)
  const htmlOpen = content.match(/<html\b[^>]*>/i)
  if (htmlOpen && htmlOpen.index !== undefined) {
    const at = htmlOpen.index + htmlOpen[0].length
    return `${content.slice(0, at)}\n${block}${content.slice(at)}`
  }
  return block + content
}
