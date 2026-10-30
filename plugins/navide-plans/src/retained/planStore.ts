/**
 * planStore.ts
 *
 * Format-agnostic persistence adapter for plan documents. A `PlanStore` hides
 * whether a plan lives as an HTML `plan-meta` island (`.agent-team/plans/*.html`)
 * or a `.plan.md` YAML-frontmatter file behind one interface, so higher layers
 * can read/mutate a plan without branching on format.
 *
 * The two implementations do not reimplement any parsing/serialization: they
 * compose the existing format helpers (`usePlanHtml` / `usePlanFile`) and mirror
 * the optimistic-lock write flows already proven in `PlanReviewToolbar.writeMeta`
 * (HTML meta writes) and `PlanWindowApp.writePlanBody` (HTML body writes).
 *
 * Stage 1 scope: this module is standalone — nothing outside its test wires it
 * up yet, so existing HTML/markdown plan behavior is unchanged.
 */

import type { PlanMeta } from './planModel'
import type { PlansTransport } from './transport'
import {
  parsePlanMeta,
  writePlanMeta,
  replacePlanSectionBody,
  deleteSection as deleteMarkdownSection,
  sectionRegion as markdownSectionRegion,
  parsePlanFile,
} from './usePlanFile'
import {
  parseHtmlPlanMeta,
  replaceHtmlPlanMeta,
  syncStageMarkup,
  syncTodoMarkup,
  replaceSectionBody as replaceHtmlSectionBody,
  deleteSection as deleteHtmlSection,
  sectionRegion as htmlSectionRegion,
  type HtmlPlanMeta,
} from './usePlanHtml'
import { extractPlanOutline } from './planRuntime'

type Backend = PlansTransport

export interface ReadResult {
  meta: PlanMeta
  raw: string
  mtime?: number
  warnings: string[]
}

export interface WriteResult {
  ok: boolean
  conflict?: boolean
  error?: string
  /** The final on-disk content on success, or the fresh content on abandon. */
  raw?: string
  /** A section write merged into a document someone else had changed elsewhere. */
  merged?: boolean
  /** The section itself changed on disk since the edit began; nothing was written. */
  sectionConflict?: SectionConflict
}

/**
 * Both sides of a section that changed on disk while the user edited it.
 * `mine` is what the user submitted (empty for a delete), `theirs` the
 * section's current source on disk (null when it no longer exists), and
 * `fresh` the whole document it was read from: passing `fresh` back as the
 * base writes `mine` over exactly that version, and conflicts again if the
 * document moved once more.
 */
export interface SectionConflict {
  anchor: string
  mine: string
  theirs: string | null
  fresh: string
}

export type SectionBody = { kind: 'markdown'; text: string } | { kind: 'html'; sanitized: string }

export interface PlanCtx {
  backend: Backend
  workspacePath: string
  relPath: string
}

export interface PlanStore {
  readonly format: 'markdown' | 'html'
  canHandle(relPath: string): boolean
  /**
   * Pure, synchronous meta parse of already-read content (no I/O). The review
   * toolbar uses it to refresh its local `meta` state from freshly written
   * bytes without re-branching on format. Returns null when the content is not
   * a valid plan of this store's format.
   */
  parseMeta(raw: string): PlanMeta | null
  readMeta(ctx: PlanCtx): Promise<ReadResult | null>
  writeMeta(
    ctx: PlanCtx,
    mutate: (fresh: PlanMeta) => PlanMeta | null,
    /**
     * Optional structural body-markup sync applied to the already
     * meta+status-synced content, immediately before the write (same read,
     * same expected_mtime). Mirrors the toolbar's original `syncBody` step for
     * todo/note CRUD (insert/remove/retext `<li>`); status-only markup is
     * handled internally, so callers pass this only for structural edits.
     */
    syncBody?: (content: string) => string,
  ): Promise<WriteResult>
  /**
   * `base` is the document the user was looking at when the edit began. With
   * it, a section that changed on disk since then is reported as
   * `sectionConflict` instead of being overwritten; changes elsewhere in the
   * document are kept and the result says `merged`. Without it, the write is
   * reapplied to fresh bytes on a conflict, as for an agent-side mutation.
   */
  replaceSectionBody(ctx: PlanCtx, anchor: string, body: SectionBody, base?: string): Promise<WriteResult>
  deleteSection(ctx: PlanCtx, anchor: string, base?: string): Promise<WriteResult>
  /** The source of the section `anchor` names (heading included), or null. */
  sectionRegion(raw: string, anchor: string): string | null
  outline(raw: string): string[]
}

interface ReadFileResp {
  ok: boolean
  content?: string
  mtime?: number
  sha256?: string
  error?: string
}
interface WriteFileResp {
  ok: boolean
  conflict?: boolean
  error?: string
}

/** Read the plan file's fresh content + mtime through the backend. */
function readFile(ctx: PlanCtx) {
  return ctx.backend.send<ReadFileResp>('fs.read_file', {
    workspace_path: ctx.workspacePath,
    rel_path: ctx.relPath,
  })
}

/** Write content back with the optimistic-lock `expected_mtime` and
 *  `expected_sha256` of the read it was derived from (each when known). */
function writeFile(ctx: PlanCtx, content: string, read: { mtime?: number; sha256?: string }) {
  return ctx.backend.send<WriteFileResp>('fs.write_file', {
    workspace_path: ctx.workspacePath,
    rel_path: ctx.relPath,
    content,
    ...(typeof read.mtime === 'number' ? { expected_mtime: read.mtime } : {}),
    ...(typeof read.sha256 === 'string' ? { expected_sha256: read.sha256 } : {}),
  })
}

/**
 * Shared body-write flow, mirroring `PlanWindowApp.writePlanBody`: re-read fresh
 * content + mtime, apply the byte-surgical `mutate` to the fresh bytes, write
 * with `expected_mtime`, retry once on a conflict. A mutation that leaves the
 * content unchanged (anchor gone / refused region) is a silent no-op success —
 * no write is issued, matching the reference.
 */
async function writeBody(ctx: PlanCtx, mutate: (fresh: string) => string): Promise<WriteResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const readResp = await readFile(ctx)
    if (!readResp.payload?.ok || readResp.payload.content === undefined) {
      return { ok: false, error: readResp.payload?.error }
    }
    const fresh = readResp.payload.content
    const next = mutate(fresh)
    if (next === fresh) return { ok: true, raw: fresh } // no-op: anchor not found or region refused
    const resp = await writeFile(ctx, next, readResp.payload)
    if (resp.payload?.ok) return { ok: true, raw: next }
    if (resp.payload?.conflict) {
      if (attempt === 0) continue // file changed under us — re-read and retry once
      return { ok: false, conflict: true, error: resp.payload?.error }
    }
    return { ok: false, error: resp.payload?.error }
  }
  return { ok: false } // unreachable: both iterations return
}

/** Re-reads allowed while other writers keep moving the document. */
const SECTION_WRITE_ATTEMPTS = 3

/**
 * A user's section write against the document they saw (`base`). Each attempt
 * compares the section in `base` with the one on disk: unchanged, the edit is
 * applied to the fresh bytes (keeping every other change); changed, the
 * attempt stops with both sides so the user can choose. A write that loses a
 * race is re-evaluated the same way, never reapplied blindly.
 */
async function writeSection(
  ctx: PlanCtx,
  base: string,
  anchor: string,
  mine: string,
  region: (raw: string, anchor: string) => string | null,
  mutate: (fresh: string) => string,
): Promise<WriteResult> {
  for (let attempt = 0; attempt < SECTION_WRITE_ATTEMPTS; attempt++) {
    const readResp = await readFile(ctx)
    if (!readResp.payload?.ok || readResp.payload.content === undefined) {
      return { ok: false, error: readResp.payload?.error }
    }
    const fresh = readResp.payload.content
    if (fresh !== base) {
      const theirs = region(fresh, anchor)
      if (theirs !== region(base, anchor)) {
        return { ok: false, sectionConflict: { anchor, mine, theirs, fresh } }
      }
    }
    const next = mutate(fresh)
    if (next === fresh) return { ok: true, raw: fresh } // no-op: anchor not found or region refused
    const resp = await writeFile(ctx, next, readResp.payload)
    if (resp.payload?.ok) return { ok: true, raw: next, ...(fresh !== base ? { merged: true } : {}) }
    if (!resp.payload?.conflict) return { ok: false, error: resp.payload?.error }
  }
  return { ok: false, conflict: true }
}

/** Strip the memory-only `format` field before serialization; never persisted. */
function toHtmlMeta(meta: PlanMeta): HtmlPlanMeta {
  const { format: _format, ...rest } = meta
  return rest as HtmlPlanMeta
}

// ── HTML plans (`plan-meta` island) ────────────────────────────────────────
class HtmlPlanStore implements PlanStore {
  readonly format = 'html' as const

  canHandle(relPath: string): boolean {
    return relPath.endsWith('.html')
  }

  parseMeta(raw: string): PlanMeta | null {
    const parsed = parseHtmlPlanMeta(raw)
    return parsed ? ({ ...parsed.meta, format: 'html' } as PlanMeta) : null
  }

  async readMeta(ctx: PlanCtx): Promise<ReadResult | null> {
    const readResp = await readFile(ctx)
    if (!readResp.payload?.ok || readResp.payload.content === undefined) return null
    const raw = readResp.payload.content
    const parsed = parseHtmlPlanMeta(raw)
    if (!parsed) return null
    const meta = { ...parsed.meta, format: 'html' } as PlanMeta
    return { meta, raw, mtime: readResp.payload.mtime, warnings: parsed.warnings }
  }

  /**
   * Optimistic-lock meta write, mirroring `PlanReviewToolbar.writeMeta` byte for
   * byte: re-read fresh content + mtime → parseHtmlPlanMeta → mutate → on null,
   * abandon → replaceHtmlPlanMeta → syncStageMarkup → syncTodoMarkup per todo
   * (same timing/order) → optional syncBody → write with expected_mtime →
   * retry once on conflict.
   */
  async writeMeta(
    ctx: PlanCtx,
    mutate: (fresh: PlanMeta) => PlanMeta | null,
    syncBody?: (content: string) => string,
  ): Promise<WriteResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const readResp = await readFile(ctx)
      if (!readResp.payload?.ok || readResp.payload.content === undefined) {
        return { ok: false, error: readResp.payload?.error }
      }
      const freshContent = readResp.payload.content
      const parsed = parseHtmlPlanMeta(freshContent)
      if (!parsed) return { ok: false, error: 'not a plan file' }
      const next = mutate({ ...parsed.meta, format: 'html' } as PlanMeta)
      if (!next) return { ok: false, raw: freshContent } // mutation abandoned
      const nextHtml = toHtmlMeta(next)
      let content = replaceHtmlPlanMeta(freshContent, nextHtml)
      content = syncStageMarkup(content, nextHtml.stage)
      for (const todo of nextHtml.todos) content = syncTodoMarkup(content, todo.id, todo.status)
      if (syncBody) content = syncBody(content)
      const resp = await writeFile(ctx, content, readResp.payload)
      if (resp.payload?.ok) return { ok: true, raw: content }
      if (resp.payload?.conflict) {
        if (attempt === 0) continue // re-read and retry once
        return { ok: false, conflict: true, error: resp.payload?.error }
      }
      return { ok: false, error: resp.payload?.error }
    }
    return { ok: false } // unreachable: both iterations return
  }

  replaceSectionBody(ctx: PlanCtx, anchor: string, body: SectionBody, base?: string): Promise<WriteResult> {
    const html = body.kind === 'html' ? body.sanitized : body.text
    const mutate = (fresh: string) => replaceHtmlSectionBody(fresh, anchor, html)
    return base === undefined ? writeBody(ctx, mutate) : writeSection(ctx, base, anchor, html, htmlSectionRegion, mutate)
  }

  deleteSection(ctx: PlanCtx, anchor: string, base?: string): Promise<WriteResult> {
    const mutate = (fresh: string) => deleteHtmlSection(fresh, anchor)
    return base === undefined ? writeBody(ctx, mutate) : writeSection(ctx, base, anchor, '', htmlSectionRegion, mutate)
  }

  sectionRegion(raw: string, anchor: string): string | null {
    return htmlSectionRegion(raw, anchor)
  }

  outline(raw: string): string[] {
    return extractPlanOutline(raw)
  }
}

// ── Markdown plans (`.plan.md` YAML frontmatter) ───────────────────────────
class MarkdownPlanStore implements PlanStore {
  readonly format = 'markdown' as const

  canHandle(relPath: string): boolean {
    return relPath.endsWith('.plan.md') || relPath.endsWith('.md')
  }

  parseMeta(raw: string): PlanMeta | null {
    return parsePlanMeta(raw)
  }

  async readMeta(ctx: PlanCtx): Promise<ReadResult | null> {
    const readResp = await readFile(ctx)
    if (!readResp.payload?.ok || readResp.payload.content === undefined) return null
    const raw = readResp.payload.content
    const meta = parsePlanMeta(raw)
    if (!meta) return null
    return { meta, raw, mtime: readResp.payload.mtime, warnings: [] }
  }

  async writeMeta(
    ctx: PlanCtx,
    mutate: (fresh: PlanMeta) => PlanMeta | null,
    syncBody?: (content: string) => string,
  ): Promise<WriteResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const readResp = await readFile(ctx)
      if (!readResp.payload?.ok || readResp.payload.content === undefined) {
        return { ok: false, error: readResp.payload?.error }
      }
      const freshContent = readResp.payload.content
      const freshMeta = parsePlanMeta(freshContent)
      if (!freshMeta) return { ok: false, error: 'not a plan file' }
      const next = mutate(freshMeta)
      if (!next) return { ok: false, raw: freshContent } // mutation abandoned
      let content = writePlanMeta(next, freshContent)
      if (syncBody) content = syncBody(content)
      const resp = await writeFile(ctx, content, readResp.payload)
      if (resp.payload?.ok) return { ok: true, raw: content }
      if (resp.payload?.conflict) {
        if (attempt === 0) continue // re-read and retry once
        return { ok: false, conflict: true, error: resp.payload?.error }
      }
      return { ok: false, error: resp.payload?.error }
    }
    return { ok: false } // unreachable: both iterations return
  }

  replaceSectionBody(ctx: PlanCtx, anchor: string, body: SectionBody, base?: string): Promise<WriteResult> {
    const text = body.kind === 'markdown' ? body.text : body.sanitized
    const mutate = (fresh: string) => replacePlanSectionBody(fresh, anchor, text)
    return base === undefined ? writeBody(ctx, mutate) : writeSection(ctx, base, anchor, text, markdownSectionRegion, mutate)
  }

  deleteSection(ctx: PlanCtx, anchor: string, base?: string): Promise<WriteResult> {
    const mutate = (fresh: string) => deleteMarkdownSection(fresh, anchor)
    return base === undefined ? writeBody(ctx, mutate) : writeSection(ctx, base, anchor, '', markdownSectionRegion, mutate)
  }

  sectionRegion(raw: string, anchor: string): string | null {
    return markdownSectionRegion(raw, anchor)
  }

  outline(raw: string): string[] {
    // Only sections PlanMarkdownBody actually renders (non-empty body); an empty
    // `##` heading has no anchor to scroll to, so listing it dead-ends the nav.
    return parsePlanFile(raw)?.sections.filter((s) => s.body.trim()).map((s) => s.heading) ?? []
  }
}

const htmlPlanStore = new HtmlPlanStore()
const markdownPlanStore = new MarkdownPlanStore()

/** Resolve the store for a plan file by extension: `.html` → HTML, else Markdown. */
export function resolvePlanStore(relPath: string): PlanStore {
  return relPath.endsWith('.html') ? htmlPlanStore : markdownPlanStore
}
