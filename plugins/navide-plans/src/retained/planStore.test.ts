import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { resolvePlanStore, type PlanCtx } from './planStore'
import type { PlansTransport } from './transport'
import { sectionRegion as htmlSectionRegion } from './usePlanHtml'
import { sectionRegion as markdownSectionRegion } from './usePlanFile'

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** One file on a fake disk, with the backend's mtime/sha256 conflict check. */
function disk(initial: string, opts: { beforeWrite?: (attempt: number) => void } = {}) {
  const state = { content: initial, mtime: 1, writes: [] as Array<Record<string, unknown>> }
  let attempt = 0
  const backend: PlansTransport = {
    async send<T>(type: string, payload: Record<string, unknown> = {}) {
      if (type === 'fs.read_file') {
        return { payload: { ok: true, content: state.content, mtime: state.mtime, sha256: sha256(state.content) } as T }
      }
      if (type === 'fs.write_file') {
        opts.beforeWrite?.(attempt++)
        state.writes.push(payload)
        if (payload.expected_mtime !== state.mtime || payload.expected_sha256 !== sha256(state.content)) {
          return { payload: { ok: false, conflict: true } as T }
        }
        state.content = String(payload.content)
        state.mtime += 1
        return { payload: { ok: true } as T }
      }
      throw new Error(`unexpected ${type}`)
    },
    on: () => () => undefined,
  }
  return { state, backend }
}

const ctx = (backend: PlansTransport, relPath: string): PlanCtx => ({ backend, workspacePath: '/ws', relPath })

const html = (scope: string, risks: string) => [
  '<html><body>',
  '<script type="application/json" id="plan-meta">{"schemaVersion":1,"name":"P","stage":"draft","todos":[],"reviewNotes":[]}</script>',
  '<header><h1>P</h1></header>',
  `<section><h2>Scope</h2>\n<p>${scope}</p>\n</section>`,
  `<section><h2>Risks</h2>\n<p>${risks}</p>\n</section>`,
  '</body></html>',
].join('\n')

const markdown = (scope: string, risks: string) =>
  `---\nname: P\nstage: draft\ntodos: []\n---\n\n## Scope\n\n${scope}\n\n## Risks\n\n${risks}\n`

describe('section regions', () => {
  it('covers one HTML section, heading included, and nothing else', () => {
    const doc = html('a', 'b')
    expect(htmlSectionRegion(doc, 'Scope')).toBe('<section><h2>Scope</h2>\n<p>a</p>\n</section>')
    expect(htmlSectionRegion(doc, 'Missing')).toBeNull()
    expect(htmlSectionRegion(html('a', 'changed'), 'Scope')).toBe(htmlSectionRegion(doc, 'Scope'))
  })

  it('covers one markdown section up to the next heading', () => {
    const doc = markdown('a', 'b')
    expect(markdownSectionRegion(doc, 'Scope')).toBe('## Scope\n\na\n')
    expect(markdownSectionRegion(doc, 'Missing')).toBeNull()
  })
})

describe.each([
  { format: 'html', relPath: '.agent-team/plans/p_aaaaaa.html', make: html },
  { format: 'markdown', relPath: '.agent-team/plans/p.plan.md', make: markdown },
] as const)('$format section writes against the version the user saw', ({ relPath, make }) => {
  const store = resolvePlanStore(relPath)
  const body = (text: string) => (relPath.endsWith('.html')
    ? { kind: 'html' as const, sanitized: `<p>${text}</p>` }
    : { kind: 'markdown' as const, text })

  it('writes with the read’s mtime and sha256 when nothing changed', async () => {
    const base = make('a', 'b')
    const { state, backend } = disk(base)
    const result = await store.replaceSectionBody(ctx(backend, relPath), 'Scope', body('mine'), base)
    expect(result).toMatchObject({ ok: true })
    expect(result.merged).toBeUndefined()
    expect(state.content).toContain('mine')
    expect(state.writes[0]).toMatchObject({ expected_mtime: 1, expected_sha256: sha256(base) })
  })

  it('merges into a document changed only in another section', async () => {
    const base = make('a', 'b')
    const { state, backend } = disk(make('a', 'agent risks'))
    const result = await store.replaceSectionBody(ctx(backend, relPath), 'Scope', body('mine'), base)
    expect(result).toMatchObject({ ok: true, merged: true })
    expect(state.content).toContain('mine')
    expect(state.content).toContain('agent risks')
  })

  it('stops with both sides when the same section changed, writing nothing', async () => {
    const base = make('a', 'b')
    const theirs = make('agent scope', 'b')
    const { state, backend } = disk(theirs)
    const result = await store.replaceSectionBody(ctx(backend, relPath), 'Scope', body('mine'), base)
    expect(result.ok).toBe(false)
    expect(result.sectionConflict).toMatchObject({ anchor: 'Scope', fresh: theirs })
    expect(result.sectionConflict?.mine).toContain('mine')
    expect(result.sectionConflict?.theirs).toContain('agent scope')
    expect(state.writes).toEqual([])
    expect(state.content).toBe(theirs)

    // Keeping mine writes over exactly the version the dialog showed.
    const kept = await store.replaceSectionBody(ctx(backend, relPath), 'Scope', body('mine'), result.sectionConflict!.fresh)
    expect(kept).toMatchObject({ ok: true })
    expect(state.content).toContain('mine')
    expect(state.content).not.toContain('agent scope')
  })

  it('treats a delete like an edit: a changed section is a conflict', async () => {
    const base = make('a', 'b')
    const { state, backend } = disk(make('agent scope', 'b'))
    const result = await store.deleteSection(ctx(backend, relPath), 'Scope', base)
    expect(result.sectionConflict).toMatchObject({ anchor: 'Scope', mine: '' })
    expect(state.content).toContain('agent scope')
  })

  it('re-checks the section after losing a write race instead of reapplying blindly', async () => {
    const base = make('a', 'b')
    const sharedState: { content?: string } = {}
    const { state, backend } = disk(base, {
      beforeWrite: (attempt) => {
        if (attempt === 0) {
          // An agent rewrites the same section between our read and write.
          state.content = make('agent scope', 'b')
          state.mtime += 1
          sharedState.content = state.content
        }
      },
    })
    const result = await store.replaceSectionBody(ctx(backend, relPath), 'Scope', body('mine'), base)
    expect(result.sectionConflict?.theirs).toContain('agent scope')
    expect(state.content).toBe(sharedState.content)
  })

  it('keeps the agent-side behaviour without a base', async () => {
    const { state, backend } = disk(make('agent scope', 'b'))
    const result = await store.replaceSectionBody(ctx(backend, relPath), 'Scope', body('mine'))
    expect(result).toMatchObject({ ok: true })
    expect(state.content).toContain('mine')
  })
})

describe('meta writes', () => {
  it('carry the read’s sha256 as well as its mtime', async () => {
    const base = html('a', 'b')
    const { state, backend } = disk(base)
    const result = await resolvePlanStore('.agent-team/plans/p_aaaaaa.html')
      .writeMeta(ctx(backend, '.agent-team/plans/p_aaaaaa.html'), (fresh) => ({ ...fresh, stage: 'in-review' }))
    expect(result.ok).toBe(true)
    expect(state.writes[0]).toMatchObject({ expected_mtime: 1, expected_sha256: sha256(base) })
  })
})
