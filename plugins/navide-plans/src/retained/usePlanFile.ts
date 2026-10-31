/**
 * usePlanFile.ts
 *
 * Parses and writes `.plan.md` files with YAML frontmatter. The frontmatter
 * block is parsed/serialized with the `yaml` library (robust for the nested
 * `reviewNotes` / `executions` arrays); the markdown body after the closing
 * `---` is preserved byte-for-byte via `splitFrontmatter`.
 *
 * Two surfaces:
 *   - `parsePlanFile` / `writePlanFile` — the legacy `ParsedPlan` shape used by
 *     PlanFileView. Its todo status stays the 3-value set (`skipped` collapses
 *     to `pending` on read) so the existing UI keeps compiling unchanged.
 *   - `parsePlanMeta` / `writePlanMeta` — the unified `PlanMeta` model, which
 *     carries the full 4-value todo status set (including `skipped`) plus
 *     stage / approvedAt / reviewNotes / executions.
 *
 * Frontmatter schema:
 *   name: string
 *   overview: string
 *   todos:
 *     - id: string
 *       content: string
 *       status: 'pending' | 'in-progress' | 'done' | 'skipped'
 *   isProject: boolean
 *   stage: PlanStage
 *   approvedAt: string | null
 *   reviewNotes: ReviewNote[]
 *   executions?: PlanExecution[]
 */

import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { PLAN_STAGES } from './planModel'
import type {
  PlanStage,
  PlanMeta,
  ReviewNote,
  PlanExecution,
  PlanTodo as ModelPlanTodo,
  TodoStatus as ModelTodoStatus,
} from './planModel'

export type { PlanStage, PlanMeta, ReviewNote, PlanExecution } from './planModel'

/**
 * Todo status carried by `ParsedPlan` — the full 4-value model set (`skipped`
 * preserved). PlanFileView reads/writes this directly, so a `skipped` todo set
 * elsewhere (e.g. the review toolbar) survives a PlanFileView save.
 */
export type TodoStatus = ModelTodoStatus
export type RawTodoStatus = TodoStatus | 'completed' | 'in_progress' | 'complete' | 'finished'

/** Alias to the unified model todo (4-value status + preserved unknown fields). */
export type PlanTodo = ModelPlanTodo

export interface PlanSection {
  heading: string
  body: string
}

export interface ParsedPlan {
  name: string
  overview: string
  todos: PlanTodo[]
  sections: PlanSection[]
  isProject: boolean
  stage: PlanStage
  approvedAt: string | null
  reviewNotes: ReviewNote[]
  executions?: PlanExecution[]
}

export interface PlanProgress {
  total: number
  done: number
  inProgress: number
  pending: number
  complete: boolean
}

/** Normalize any raw status string to the unified 4-value set; unknown → pending. */
export function normalizeTodoStatus(value: string): ModelTodoStatus {
  const v = value.trim().toLowerCase().replace(/_/g, '-')
  if (v === 'done' || v === 'completed' || v === 'complete' || v === 'finished') return 'done'
  if (v === 'in-progress' || v === 'inprogress' || v === 'active') return 'in-progress'
  if (v === 'skipped' || v === 'skip') return 'skipped'
  return 'pending'
}

export function planProgress(todos: PlanTodo[]): PlanProgress {
  const done = todos.filter((t) => t.status === 'done').length
  const inProgress = todos.filter((t) => t.status === 'in-progress').length
  const pending = todos.length - done - inProgress
  return {
    total: todos.length,
    done,
    inProgress,
    pending,
    complete: todos.length > 0 && done === todos.length,
  }
}

/** Serialize a status back to the Cursor-compatible alias used on disk. */
function serializeStatus(status: ModelTodoStatus): string {
  if (status === 'done') return 'completed'
  if (status === 'in-progress') return 'in_progress'
  if (status === 'skipped') return 'skipped'
  return 'pending'
}

/**
 * Split a `.plan.md` raw string into frontmatter YAML and markdown body.
 * Returns null if the file doesn't start with `---`.
 */
function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
  if (!raw.startsWith('---')) return null
  const after = raw.slice(3)
  const end = after.indexOf('\n---')
  if (end === -1) return null
  return {
    yaml: after.slice(0, end).trim(),
    // Preserve the exact body after the closing `---` (typically starts with `\n`).
    body: after.slice(end + 4),
  }
}

/**
 * Parse the frontmatter YAML block into a plain object with the `yaml` library.
 * Returns null when the block is empty or is not a mapping.
 */
function parseFrontmatterObject(yaml: string): Record<string, unknown> | null {
  let doc: unknown
  try {
    doc = yamlParse(yaml)
  } catch {
    return null
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
  return doc as Record<string, unknown>
}

/** Read the `todos` array into the unified 4-value model (skipped preserved). */
function readTodos(obj: Record<string, unknown>): ModelPlanTodo[] {
  const out: ModelPlanTodo[] = []
  if (!Array.isArray(obj.todos)) return out
  for (const entry of obj.todos) {
    if (entry === null || typeof entry !== 'object') continue
    const t = entry as Record<string, unknown>
    if (typeof t.id !== 'string') continue
    // Spread the raw entry first so unknown fields (e.g. `priority`) survive a
    // parse → serialize round-trip; the known fields are then normalised.
    out.push({
      ...t,
      id: t.id,
      content: typeof t.content === 'string' ? t.content : '',
      status: normalizeTodoStatus(typeof t.status === 'string' ? t.status : ''),
    })
  }
  return out
}

/**
 * Resolve the plan stage. A valid explicit `stage` wins; otherwise derive from
 * todo completion — a non-empty, fully-done todo list means `done`, else `draft`.
 */
function readStage(obj: Record<string, unknown>, todos: ModelPlanTodo[]): PlanStage {
  if (typeof obj.stage === 'string' && (PLAN_STAGES as readonly string[]).includes(obj.stage)) {
    return obj.stage as PlanStage
  }
  return todos.length > 0 && todos.every((t) => t.status === 'done') ? 'done' : 'draft'
}

/** Read the `reviewNotes` array, defaulting to `[]`; unknown fields preserved. */
function readReviewNotes(obj: Record<string, unknown>): ReviewNote[] {
  const out: ReviewNote[] = []
  if (!Array.isArray(obj.reviewNotes)) return out
  for (const entry of obj.reviewNotes) {
    if (entry === null || typeof entry !== 'object') continue
    const n = entry as Record<string, unknown>
    out.push({
      ...n,
      id: typeof n.id === 'string' ? n.id : '',
      author: n.author === 'ai' ? 'ai' : 'user',
      text: typeof n.text === 'string' ? n.text : '',
      resolved: n.resolved === true,
      reply: typeof n.reply === 'string' ? n.reply : '',
      anchor: typeof n.anchor === 'string' ? n.anchor : '',
    })
  }
  return out
}

/** Read the optional `executions` array; `undefined` when the key is absent. */
function readExecutions(obj: Record<string, unknown>): PlanExecution[] | undefined {
  if (obj.executions === undefined || !Array.isArray(obj.executions)) return undefined
  const out: PlanExecution[] = []
  for (const entry of obj.executions) {
    if (entry === null || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    out.push({
      ...e,
      agent: typeof e.agent === 'string' ? e.agent : '',
      startedAt: typeof e.startedAt === 'string' ? e.startedAt : '',
    })
  }
  return out
}

/**
 * Extract `## Heading` sections from the markdown body.
 * Each section includes everything up to the next `##` heading.
 */
function parseSections(body: string): PlanSection[] {
  const sections: PlanSection[] = []
  const lines = body.split('\n')
  let current: PlanSection | null = null

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/)
    if (headingMatch) {
      if (current) sections.push({ ...current, body: current.body.trimEnd() })
      current = { heading: headingMatch[1].trim(), body: '' }
    } else if (current) {
      current.body += line + '\n'
    }
  }
  if (current) sections.push({ ...current, body: current.body.trimEnd() })
  return sections
}

/**
 * Parse a raw `.plan.md` string.
 * Returns `null` when:
 *   - there is no valid `---` frontmatter
 *   - the YAML cannot be parsed (malformed)
 *   - the `name` field is missing (not a plan file)
 */
export function parsePlanFile(raw: string): ParsedPlan | null {
  const parts = splitFrontmatter(raw)
  if (!parts) return null

  const obj = parseFrontmatterObject(parts.yaml)
  if (!obj) return null
  const name = typeof obj.name === 'string' ? obj.name : ''
  if (!name) return null

  // ParsedPlan carries the full 4-value status (skipped preserved), so a
  // PlanFileView save re-serializes skipped todos verbatim instead of dropping
  // them back to pending.
  const todos = readTodos(obj)

  const result: ParsedPlan = {
    name,
    overview: typeof obj.overview === 'string' ? obj.overview : '',
    todos,
    sections: parseSections(parts.body),
    isProject: obj.isProject === true,
    stage: readStage(obj, todos),
    approvedAt: typeof obj.approvedAt === 'string' ? obj.approvedAt : null,
    reviewNotes: readReviewNotes(obj),
  }
  const executions = readExecutions(obj)
  if (executions !== undefined) result.executions = executions
  return result
}

/**
 * Parse a raw `.plan.md` string into the unified `PlanMeta` model. Unlike
 * `parsePlanFile`, this preserves the full 4-value todo status set (including
 * `skipped`). Returns `null` under the same conditions as `parsePlanFile`.
 */
export function parsePlanMeta(raw: string): PlanMeta | null {
  const parts = splitFrontmatter(raw)
  if (!parts) return null

  const obj = parseFrontmatterObject(parts.yaml)
  if (!obj) return null
  const name = typeof obj.name === 'string' ? obj.name : ''
  if (!name) return null

  const todos = readTodos(obj)
  const meta: PlanMeta = {
    schemaVersion: 1,
    format: 'markdown',
    name,
    overview: typeof obj.overview === 'string' ? obj.overview : '',
    stage: readStage(obj, todos),
    approvedAt: typeof obj.approvedAt === 'string' ? obj.approvedAt : null,
    archivedAt: typeof obj.archivedAt === 'string' ? obj.archivedAt : null,
    todos,
    reviewNotes: readReviewNotes(obj),
    isProject: obj.isProject === true,
  }
  const executions = readExecutions(obj)
  if (executions !== undefined) meta.executions = executions
  return meta
}

/** Bridge a legacy `ParsedPlan` into the unified `PlanMeta` (format 'markdown'). */
export function toPlanMeta(parsed: ParsedPlan): PlanMeta {
  const meta: PlanMeta = {
    schemaVersion: 1,
    format: 'markdown',
    name: parsed.name,
    overview: parsed.overview,
    stage: parsed.stage,
    approvedAt: parsed.approvedAt,
    todos: parsed.todos.map((t) => ({ id: t.id, content: t.content, status: t.status })),
    reviewNotes: parsed.reviewNotes.map((n) => ({ ...n })),
    isProject: parsed.isProject,
  }
  if (parsed.executions !== undefined) meta.executions = parsed.executions.map((e) => ({ ...e }))
  return meta
}

/** Fields that `serializeFrontmatter` renders (todo status pre-serialized). */
interface FrontmatterFields {
  name: string
  overview: string
  todos: { id: string; content: string; status: string; [k: string]: unknown }[]
  isProject: boolean
  stage: PlanStage
  approvedAt: string | null
  /** Omitted (undefined) by the legacy `writePlanFile` path so an existing
   * on-disk value round-trips; `writePlanMeta` always passes it (null or ISO). */
  archivedAt?: string | null
  reviewNotes: ReviewNote[]
  executions?: PlanExecution[]
}

/**
 * Rebuild the frontmatter YAML from `fields`. Unknown top-level keys present in
 * the original block are preserved; the memory-only `format` / `schemaVersion`
 * keys are never persisted; `executions` is omitted when empty/undefined. YAML
 * string escaping (colons, quotes in note text/reply) is handled by the lib.
 */
function serializeFrontmatter(originalYaml: string, fields: FrontmatterFields): string {
  const base = parseFrontmatterObject(originalYaml) ?? {}
  base.name = fields.name
  base.overview = fields.overview
  base.todos = fields.todos
  base.isProject = fields.isProject
  base.stage = fields.stage
  base.approvedAt = fields.approvedAt
  // archivedAt mirrors approvedAt (a value is always written, null is written
  // too) — but only when the caller supplies it. The legacy `writePlanFile`
  // path omits it, so an existing on-disk `archivedAt` survives untouched.
  if (fields.archivedAt !== undefined) base.archivedAt = fields.archivedAt
  base.reviewNotes = fields.reviewNotes
  if (fields.executions && fields.executions.length > 0) base.executions = fields.executions
  else delete base.executions
  delete base.format
  delete base.schemaVersion
  return yamlStringify(base).trimEnd()
}

/**
 * Serialize a legacy `ParsedPlan` back into the original raw file, replacing the
 * frontmatter block (now including stage / approvedAt / reviewNotes /
 * executions). The markdown body after the second `---` is preserved
 * character-for-character.
 *
 * Also synchronises `- [ ]` / `- [x]` body checkboxes to match each todo's status.
 */
export function writePlanFile(parsed: ParsedPlan, originalRaw: string): string {
  const parts = splitFrontmatter(originalRaw)
  if (!parts) return originalRaw

  const yaml = serializeFrontmatter(parts.yaml, {
    name: parsed.name,
    overview: parsed.overview,
    todos: parsed.todos.map((t) => ({ ...t, id: t.id, content: t.content, status: serializeStatus(t.status) })),
    isProject: parsed.isProject,
    stage: parsed.stage,
    approvedAt: parsed.approvedAt,
    reviewNotes: parsed.reviewNotes,
    executions: parsed.executions,
  })

  // Sync body checkboxes only when they map 1:1 onto the frontmatter todos.
  // Plans whose Detailed Todos are finer-grained than the phase-level todos
  // (more checkboxes than todos) would be corrupted by an order-based mapping,
  // so those bodies are left untouched.
  let body = parts.body
  const checkboxPattern = /^(\s*-\s+)\[[ x]\](\s*status:\s*[A-Za-z_-]+\s*\|)?/gm
  const boxCount = (body.match(checkboxPattern) ?? []).length
  if (boxCount === parsed.todos.length) {
    let todoIdx = 0
    body = body.replace(checkboxPattern, (_match, prefix: string, label?: string) => {
      const todo = parsed.todos[todoIdx++]
      if (!todo) return _match
      const mark = todo.status === 'done' ? 'x' : ' '
      const newLabel = label !== undefined ? ` status: ${serializeStatus(todo.status)} |` : ''
      return `${prefix}[${mark}]${newLabel}`
    })
  }

  // body already starts with `\n` (e.g. `\n\n# Goals...`), so no extra separator needed.
  return `---\n${yaml}\n---${body}`
}

/**
 * Serialize a unified `PlanMeta` back into the original raw file, preserving the
 * markdown body byte-for-byte. This is the reverse of `parsePlanMeta` and the
 * on-disk writer adapters use; it carries the full 4-value todo status set
 * (`skipped` persists as `skipped`). The memory-only `format` field is dropped.
 */
export function writePlanMeta(meta: PlanMeta, originalRaw: string): string {
  const parts = splitFrontmatter(originalRaw)
  if (!parts) return originalRaw

  const yaml = serializeFrontmatter(parts.yaml, {
    name: meta.name,
    overview: meta.overview,
    todos: meta.todos.map((t) => ({ ...t, id: t.id, content: t.content, status: serializeStatus(t.status) })),
    isProject: meta.isProject === true,
    stage: meta.stage,
    approvedAt: meta.approvedAt,
    archivedAt: meta.archivedAt ?? null,
    reviewNotes: meta.reviewNotes,
    executions: meta.executions,
  })
  return `---\n${yaml}\n---${parts.body}`
}

/**
 * Replace the body of a single `## Heading` section in a raw `.plan.md` string,
 * leaving the frontmatter, the heading line itself, and every other section
 * byte-for-byte intact.
 *
 * The section spans from just after its `## Heading` line up to the next
 * `## ` heading (matching `parsePlanFile`'s section splitting) or end of file.
 * `newBody` is normalised (surrounding blank lines trimmed) and re-inserted
 * with a single blank line separating it from the heading and the next section.
 *
 * Pure string manipulation — no markdown parser. When `heading` is not found
 * the input is returned unchanged. Duplicate headings resolve to the first.
 */
export function replacePlanSectionBody(raw: string, heading: string, newBody: string): string {
  // Skip the frontmatter so `##` scanning never touches the YAML block.
  let bodyStart = 0
  if (raw.startsWith('---')) {
    const after = raw.slice(3)
    const end = after.indexOf('\n---')
    if (end !== -1) bodyStart = 3 + end + 4
  }
  const prefix = raw.slice(0, bodyStart)
  const body = raw.slice(bodyStart)

  const lines = body.split('\n')
  const target = heading.trim()

  let headingIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/)
    if (m && m[1].trim() === target) {
      headingIdx = i
      break
    }
  }
  if (headingIdx === -1) return raw

  // Boundary: the next `## ` heading after this one (or end of file).
  let nextIdx = lines.length
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      nextIdx = i
      break
    }
  }

  const normalizedBody = newBody.replace(/^\n+/, '').replace(/\n+$/, '')
  const rebuilt = [lines[headingIdx], '', ...(normalizedBody ? normalizedBody.split('\n') : []), '']
  const merged = [...lines.slice(0, headingIdx), ...rebuilt, ...lines.slice(nextIdx)]
  return prefix + merged.join('\n')
}

/**
 * The source of a `## Heading` section (the heading line plus its body up to
 * the next `## ` heading or end of file), or null when the heading is not
 * found. Uses the same frontmatter skip and first-match rule as
 * `replacePlanSectionBody`.
 */
export function sectionRegion(raw: string, heading: string): string | null {
  let bodyStart = 0
  if (raw.startsWith('---')) {
    const after = raw.slice(3)
    const end = after.indexOf('\n---')
    if (end !== -1) bodyStart = 3 + end + 4
  }
  const lines = raw.slice(bodyStart).split('\n')
  const target = heading.trim()
  const headingIdx = lines.findIndex((line) => line.match(/^##\s+(.+?)\s*$/)?.[1].trim() === target)
  if (headingIdx === -1) return null
  let nextIdx = lines.length
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      nextIdx = i
      break
    }
  }
  return lines.slice(headingIdx, nextIdx).join('\n')
}

/**
 * Delete a whole `## Heading` section (the heading line plus its body up to the
 * next `## ` heading or end of file) from a raw `.plan.md` string. The
 * frontmatter and every other section are preserved byte-for-byte. Symmetric
 * to `replacePlanSectionBody`: when `heading` is not found the input is
 * returned unchanged, and duplicate headings resolve to the first occurrence.
 */
export function deleteSection(raw: string, heading: string): string {
  // Skip the frontmatter so `##` scanning never touches the YAML block.
  let bodyStart = 0
  if (raw.startsWith('---')) {
    const after = raw.slice(3)
    const end = after.indexOf('\n---')
    if (end !== -1) bodyStart = 3 + end + 4
  }
  const prefix = raw.slice(0, bodyStart)
  const body = raw.slice(bodyStart)

  const lines = body.split('\n')
  const target = heading.trim()

  let headingIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/)
    if (m && m[1].trim() === target) {
      headingIdx = i
      break
    }
  }
  if (headingIdx === -1) return raw

  // Boundary: the next `## ` heading after this one (or end of file).
  let nextIdx = lines.length
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      nextIdx = i
      break
    }
  }

  const merged = [...lines.slice(0, headingIdx), ...lines.slice(nextIdx)]
  return prefix + merged.join('\n')
}
