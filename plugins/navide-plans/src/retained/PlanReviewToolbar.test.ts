// @vitest-environment happy-dom
// Unit tests for the plan review toolbar shown above HTML plan previews:
// stage badge + progress display, approve gating, note resolution, note
// submission, and that every write goes through replaceHtmlPlanMeta (only the
// plan-meta block changes; all other bytes are preserved).
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import PlanReviewToolbar from './PlanReviewToolbar.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { parseHtmlPlanMeta, replaceHtmlPlanMeta } from './usePlanHtml'
import type { HtmlPlanMeta } from './usePlanHtml'
import { parsePlanMeta } from './usePlanFile'
import { resolvePlanStore, type PlanStore } from './planStore'
import { installPlansMessages } from '../plansI18n'

i18n.global.locale.value = 'en-US'
// The package's own messages, as the Plans view installs them at start.
installPlansMessages((locale, messages) => i18n.global.mergeLocaleMessage(locale, messages))

const toastMock = vi.hoisted(() => vi.fn())
const confirmMock = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => ({ toast: toastMock, alert: vi.fn(), confirm: confirmMock }),
}))

function baseMeta(overrides: Partial<HtmlPlanMeta> = {}): HtmlPlanMeta {
  return {
    schemaVersion: 1,
    name: 'Test Plan',
    overview: 'A plan for testing.',
    stage: 'in-review',
    approvedAt: null,
    todos: [
      { id: 'phase-a', content: 'Phase A', status: 'done' },
      { id: 'phase-b', content: 'Phase B', status: 'pending' },
    ],
    reviewNotes: [],
    ...overrides,
  }
}

function planDoc(meta: HtmlPlanMeta): string {
  return [
    '<html><head><title>Test Plan</title></head><body>',
    '<h1>Head marker</h1>',
    '<script type="application/json" id="plan-meta">',
    JSON.stringify(meta, null, 2),
    '</scr' + 'ipt>',
    '<footer>tail marker</footer>',
    '</body></html>',
  ].join('\n')
}

interface Harness {
  wrapper: VueWrapper
  writes: string[]
  writeCalls: { relPath: string; content: string }[]
  /** Every write attempt (including refused conflicts) with its expected_mtime. */
  writeAttempts: { relPath: string; expectedMtime?: number }[]
  /** Every fs.delete the toolbar sent (the ⋯ menu's Delete action). */
  deleteAttempts: { workspacePath: string; relPath: string }[]
  /** The store instance the toolbar was mounted with (real HtmlPlanStore by default). */
  store: PlanStore
  setContent: (c: string) => void
  /** Simulate a backend broadcast to `on()` subscribers. */
  emitBackend: (type: string, payload: unknown) => void
}

interface HistoryOpts {
  entries?: { name: string; is_dir: boolean }[]
  error?: string
  /** Extra rel_path → content read responses (snapshot files). */
  files?: Record<string, string>
  /** history.list versions as the backend returns them (overrides entries). */
  versions?: Array<Record<string, unknown>>
  /** history.restore reply. */
  restore?: { ok: boolean; conflict?: boolean }
}

vi.mock('./transport', () => ({ plansShell: {
  dispatchPlanExecution: (args: unknown) => (window as any).agentTeam?.dispatchPlanExecution?.(args),
  openPath: (relPath: string) => (window as any).agentTeam?.openPath('/ws/' + relPath),
  onPlanExecutionResult: (listener: never) => (window as any).agentTeam?.onPlanExecutionResult?.(listener) ?? (() => undefined),
} }))

const PLAN_REL_PATH = '.agent-team/plans/test-plan_a1b2c3.html'

async function mountToolbar(
  content: string,
  opts: {
    failWrite?: string
    failDelete?: string
    conflictWrites?: number
    history?: HistoryOpts
    store?: PlanStore
  } = {},
): Promise<Harness> {
  const writes: string[] = []
  const writeCalls: { relPath: string; content: string }[] = []
  const writeAttempts: { relPath: string; expectedMtime?: number }[] = []
  const deleteAttempts: { workspacePath: string; relPath: string }[] = []
  let current = content
  // Emulated file mtime: bumped on every successful plan write and on
  // setContent (external edit), mirroring the backend's optimistic lock.
  let mtimeNow = 1000
  let conflictsLeft = opts.conflictWrites ?? 0
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const backend = {
    httpUrl: ref('http://127.0.0.1:8123'),
    status: ref('connected'),
    on: (type: string, cb: (p: unknown) => void) => {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(cb)
      return () => set!.delete(cb)
    },
    send: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      if (type === 'fs.read_file') {
        const rel = payload.rel_path as string
        if (opts.history?.files && rel in opts.history.files) {
          return { payload: { ok: true, content: opts.history.files[rel], mtime: mtimeNow } }
        }
        return { payload: { ok: true, content: current, mtime: mtimeNow } }
      }
      // Versions are listed and read through the backend; it lists every
      // file of the history directory as a version (it decompresses and
      // filters in the real backend).
      if (type === 'history.list') {
        if (opts.history?.versions) return { payload: { ok: true, versions: opts.history.versions } }
        if (opts.history?.error) return { payload: { ok: true, versions: [] } }
        return {
          payload: {
            ok: true,
            versions: (opts.history?.entries ?? []).filter((entry) => !entry.is_dir).map((entry) => ({ file: entry.name, stage: '' })),
          },
        }
      }
      if (type === 'history.restore') return { payload: opts.history?.restore ?? { ok: true } }
      if (type === 'history.read') {
        const rel = `${HISTORY_DIR}/${payload.file as string}`
        if (opts.history?.files && rel in opts.history.files) {
          return { payload: { ok: true, content: opts.history.files[rel], mtime: mtimeNow } }
        }
        return { payload: { ok: true, content: current, mtime: mtimeNow } }
      }
      if (type === 'fs.write_file') {
        writeAttempts.push({
          relPath: payload.rel_path as string,
          expectedMtime: payload.expected_mtime as number | undefined,
        })
        if (opts.failWrite !== undefined) return { payload: { ok: false, error: opts.failWrite } }
        const expected = payload.expected_mtime as number | undefined
        if (
          (conflictsLeft > 0 && payload.rel_path === PLAN_REL_PATH) ||
          (expected !== undefined && expected !== mtimeNow)
        ) {
          if (conflictsLeft > 0) conflictsLeft--
          return { payload: { ok: false, conflict: true, mtime: mtimeNow, error: 'file changed on disk' } }
        }
        writeCalls.push({ relPath: payload.rel_path as string, content: payload.content as string })
        writes.push(payload.content as string)
        if (payload.rel_path === PLAN_REL_PATH) {
          current = payload.content as string
          mtimeNow++
        }
        return { payload: { ok: true, mtime: mtimeNow } }
      }
      if (type === 'fs.delete') {
        deleteAttempts.push({
          workspacePath: payload.workspace_path as string,
          relPath: payload.rel_path as string,
        })
        if (opts.failDelete !== undefined) return { payload: { ok: false, error: opts.failDelete } }
        return { payload: { ok: true } }
      }
      return { payload: { ok: true } }
    }),
  }
  // Inject a real HtmlPlanStore (resolved from the .html rel path) so the same
  // fs mock above continues to drive the read/write flow; the store performs
  // the parse/serialize/markup-sync the toolbar used to do inline.
  const store = opts.store ?? resolvePlanStore(PLAN_REL_PATH)
  const notes = ref(parseHtmlPlanMeta(current)?.meta.reviewNotes ?? [])
  async function noteMutation(mutate: (meta: HtmlPlanMeta) => HtmlPlanMeta | null): Promise<boolean> {
    const result = await store.writeMeta({ backend: backend as never, workspacePath: '/ws', relPath: PLAN_REL_PATH }, mutate as never)
    if (result.raw) {
      notes.value = parseHtmlPlanMeta(result.raw)?.meta.reviewNotes ?? []
      await wrapper.setProps({ notes: notes.value })
    }
    if (!result.ok && (result.error || result.conflict)) toastMock(result.error ?? 'Could not save review notes.')
    return result.ok
  }
  const wrapper = mount(PlanReviewToolbar, {
    props: {
      workspacePath: '/ws',
      relPath: PLAN_REL_PATH,
      backend: backend as never,
      store,
      get notes() { return notes.value },
      todos: parseHtmlPlanMeta(current)?.meta.todos ?? [],
      noteActions: {
        add: (text: string, anchor: string) => noteMutation(meta => {
          const maxId = Math.max(0, ...meta.reviewNotes.map(note => Number(note.id.match(/^n(\d+)$/)?.[1] ?? 0)))
          return { ...meta, reviewNotes: [...meta.reviewNotes, { id: 'n' + (maxId + 1), author: 'user', text, anchor, resolved: false, reply: '' }] }
        }),
        edit: (id: string, text: string) => noteMutation(meta => ({ ...meta, reviewNotes: meta.reviewNotes.map(note => note.id === id && note.author === 'user' ? { ...note, text } : note) })),
        resolve: (id: string) => noteMutation(meta => ({ ...meta, reviewNotes: meta.reviewNotes.map(note => note.id === id ? { ...note, resolved: true } : note) })),
        remove: (id: string) => noteMutation(meta => ({ ...meta, reviewNotes: meta.reviewNotes.filter(note => note.id !== id) })),
      },
    },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return {
    wrapper,
    backend,
    writes,
    writeCalls,
    writeAttempts,
    deleteAttempts,
    store,
    setContent: (c: string) => {
      current = c
      mtimeNow++
    },
    emitBackend: (type: string, payload: unknown) =>
      listeners.get(type)?.forEach((cb) => cb(payload)),
  }
}

function lastWrittenMeta(writes: string[]): HtmlPlanMeta {
  const parsed = parseHtmlPlanMeta(writes[writes.length - 1])
  expect(parsed).not.toBeNull()
  return parsed!.meta
}

// The compact bar keeps only the icon buttons an edit session reaches for;
// navigation, export and lifecycle actions live behind ⋯ and are absent from
// the DOM until it is opened. Menu items dismiss the menu when clicked, so a
// test driving two of them opens it again in between.
async function openOverflow(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.prt-overflow-btn').trigger('click')
}

describe('PlanReviewToolbar – display', () => {
  it('shows the stage badge and todo progress from plan-meta', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()))
    const badge = wrapper.find('.prt-stage')
    expect(badge.exists()).toBe(true)
    expect(badge.classes()).toContain('prt-stage--in-review')
    expect(badge.text()).toBe('In Review')
    expect(wrapper.find('.prt-progress').text()).toBe('1/2 done')
  })

  it('renders a stage-colored progressbar, and none when the plan has no todos', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()))
    const bar = wrapper.find('[role="progressbar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('aria-valuenow')).toBe('1')
    expect(bar.attributes('aria-valuemin')).toBe('0')
    expect(bar.attributes('aria-valuemax')).toBe('2')
    expect(bar.classes()).toContain('prt-progress-bar--in-review')

    const { wrapper: emptyWrapper } = await mountToolbar(planDoc(baseMeta({ todos: [] })))
    expect(emptyWrapper.find('[role="progressbar"]').exists()).toBe(false)
  })

  it('renders nothing for a file without a valid plan-meta block', async () => {
    const { wrapper } = await mountToolbar('<html><body><p>plain page</p></body></html>')
    expect(wrapper.find('.prt').exists()).toBe(false)
  })

  it('shows the unresolved note count and note details in the panel', async () => {
    const meta = baseMeta({
      reviewNotes: [
        { id: 'n1', author: 'user', text: 'Fix the risk section', resolved: false, reply: '', anchor: '' },
        { id: 'n2', author: 'ai', text: 'Clarified scope', resolved: true, reply: 'Done in rev 2', anchor: '' },
      ],
    })
    const { wrapper } = await mountToolbar(planDoc(meta))
    // Unresolved notes keep the button on the bar. It is icon-only now, so the
    // count shows as a badge and the wording moved into the tooltip/aria-label.
    const notesBtn = wrapper.find('.prt-icon-btn.prt-notes-btn')
    expect(notesBtn.attributes('aria-label')).toContain('1 unresolved')
    expect(notesBtn.find('.prt-icon-count').text()).toBe('1')

    await notesBtn.trigger('click')
    const notes = wrapper.findAll('.prt-note')
    expect(notes).toHaveLength(2)
    expect(notes[0].find('.prt-note-author').text()).toBe('user')
    expect(notes[0].find('.prt-note-text').text()).toBe('Fix the risk section')
    expect(notes[0].find('.prt-note-resolve').exists()).toBe(true)
    expect(notes[1].find('.prt-note-reply').text()).toBe('Done in rev 2')
    expect(notes[1].find('.prt-note-resolve').exists()).toBe(false)
    expect(notes[1].find('.prt-note-done').exists()).toBe(true)
  })
})

describe('PlanReviewToolbar – switching plans clears in-progress state', () => {
  it('resets an open panel + in-flight note edit when relPath changes', async () => {
    const meta = baseMeta({
      reviewNotes: [{ id: 'n1', author: 'user', text: 'A-note', resolved: false, reply: '', anchor: '' }],
    })
    const { wrapper } = await mountToolbar(planDoc(meta))
    // Open the notes panel and enter edit mode on the user-authored note.
    await wrapper.find('.prt-notes-btn').trigger('click')
    await wrapper.find('.prt-note .prt-ghost').trigger('click')
    expect(wrapper.find('.prt-input').exists()).toBe(true)
    // Switch to another plan in the same live window. The parent keys the
    // toolbar per relPath, but the watch must also self-clear so a draft/edit
    // (note ids collide across plans) can't leak into — or be written to — B.
    await wrapper.setProps({ relPath: '.agent-team/plans/other_d4e5f6.html' })
    await flushPromises()
    expect(wrapper.find('.prt-input').exists()).toBe(false)
    expect(wrapper.find('.prt-panel').exists()).toBe(false)
  })
})

describe('PlanReviewToolbar – approve gating', () => {
  it('disables Approve while unresolved notes exist', async () => {
    const meta = baseMeta({
      reviewNotes: [{ id: 'n1', author: 'user', text: 'Open point', resolved: false, reply: '', anchor: '' }],
    })
    const { wrapper } = await mountToolbar(planDoc(meta))
    expect(wrapper.find('.prt-approve').attributes('disabled')).toBeDefined()
  })

  it('disables Approve once the stage is past review (e.g. in-progress)', async () => {
    const meta = baseMeta({ stage: 'in-progress' })
    const { wrapper } = await mountToolbar(planDoc(meta))
    expect(wrapper.find('.prt-approve').attributes('disabled')).toBeDefined()
  })

  it('enables Approve for a draft plan and approves it (no draft→in-review step exists)', async () => {
    const meta = baseMeta({ stage: 'draft' })
    const { wrapper, writes } = await mountToolbar(planDoc(meta))
    const approve = wrapper.find('.prt-approve')
    expect(approve.attributes('disabled')).toBeUndefined()

    await approve.trigger('click')
    await flushPromises()

    expect(writes).toHaveLength(1)
    expect(lastWrittenMeta(writes).stage).toBe('approved')
    expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--approved')
  })

  it('approves an in-review plan with all notes resolved, writing stage and approvedAt', async () => {
    const meta = baseMeta({
      reviewNotes: [{ id: 'n1', author: 'user', text: 'Ok now', resolved: true, reply: 'ack', anchor: '' }],
    })
    const { wrapper, writes } = await mountToolbar(planDoc(meta))
    const approve = wrapper.find('.prt-approve')
    expect(approve.attributes('disabled')).toBeUndefined()

    await approve.trigger('click')
    await flushPromises()

    expect(writes).toHaveLength(1)
    const written = lastWrittenMeta(writes)
    expect(written.stage).toBe('approved')
    expect(typeof written.approvedAt).toBe('string')
    expect(Number.isNaN(Date.parse(written.approvedAt!))).toBe(false)
    expect(wrapper.emitted('updated')).toHaveLength(1)
    // Badge reflects the new stage without a remount.
    expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--approved')
  })
})

describe('PlanReviewToolbar – notes', () => {
  it('resolves a note and writes the flip through replaceHtmlPlanMeta', async () => {
    const meta = baseMeta({
      reviewNotes: [
        { id: 'n1', author: 'user', text: 'First', resolved: false, reply: '', anchor: '' },
        { id: 'n2', author: 'user', text: 'Second', resolved: false, reply: '', anchor: '' },
      ],
    })
    const doc = planDoc(meta)
    const { wrapper, writes } = await mountToolbar(doc)
    await wrapper.find('.prt-notes-btn').trigger('click')

    await wrapper.findAll('.prt-note-resolve')[0].trigger('click')
    await flushPromises()

    const written = lastWrittenMeta(writes)
    expect(written.reviewNotes[0]).toMatchObject({ id: 'n1', resolved: true })
    expect(written.reviewNotes[1]).toMatchObject({ id: 'n2', resolved: false })
    // The write is exactly the replaceHtmlPlanMeta output: bytes outside the
    // meta block are untouched.
    expect(writes[0]).toBe(replaceHtmlPlanMeta(doc, written))
    expect(writes[0]).toContain('<h1>Head marker</h1>')
    expect(writes[0]).toContain('<footer>tail marker</footer>')
  })

  it('appends a submitted note with the next incremental id and user author', async () => {
    const meta = baseMeta({
      reviewNotes: [{ id: 'n2', author: 'ai', text: 'Existing', resolved: true, reply: '', anchor: '' }],
    })
    const { wrapper, writes } = await mountToolbar(planDoc(meta))
    // Nothing unresolved yet, so Review Notes sits in the ⋯ menu.
    await openOverflow(wrapper)
    await wrapper.find('.prt-menu .prt-notes-btn').trigger('click')

    await wrapper.find('.prt-input').setValue('  Please add tests  ')
    await wrapper.find('.prt-send').trigger('click')
    await flushPromises()

    const written = lastWrittenMeta(writes)
    expect(written.reviewNotes).toHaveLength(2)
    expect(written.reviewNotes[1]).toEqual({
      id: 'n3',
      author: 'user',
      text: 'Please add tests',
      resolved: false,
      reply: '',
      anchor: '',
    })
    expect((wrapper.find('.prt-input').element as HTMLInputElement).value).toBe('')
    // The now-unresolved note promotes the button back onto the bar.
    expect(wrapper.find('.prt-icon-btn.prt-notes-btn').attributes('aria-label')).toContain(
      '1 unresolved',
    )
  })
})

describe('PlanReviewToolbar – IME composition', () => {
  it('ignores Enter pressed during IME composition', async () => {
    const { wrapper, writes } = await mountToolbar(planDoc(baseMeta()))
    await openOverflow(wrapper)
    await wrapper.find('.prt-menu .prt-notes-btn').trigger('click')
    await wrapper.find('.prt-input').setValue('中文留言')

    await wrapper.find('.prt-input').trigger('keydown', { key: 'Enter', isComposing: true })
    await flushPromises()

    expect(writes).toHaveLength(0)
    expect((wrapper.find('.prt-input').element as HTMLInputElement).value).toBe('中文留言')
  })

  it('submits on Enter when not composing', async () => {
    const { wrapper, writes } = await mountToolbar(planDoc(baseMeta()))
    await openOverflow(wrapper)
    await wrapper.find('.prt-menu .prt-notes-btn').trigger('click')
    await wrapper.find('.prt-input').setValue('中文留言')

    await wrapper.find('.prt-input').trigger('keydown', { key: 'Enter', isComposing: false })
    await flushPromises()

    expect(writes).toHaveLength(1)
    expect(lastWrittenMeta(writes).reviewNotes[0].text).toBe('中文留言')
  })
})

describe('PlanReviewToolbar – read-before-write', () => {
  it('preserves concurrent external edits when resolving a note', async () => {
    const meta = baseMeta({
      reviewNotes: [{ id: 'n1', author: 'user', text: 'First', resolved: false, reply: '', anchor: '' }],
    })
    const { wrapper, writes, setContent } = await mountToolbar(planDoc(meta))
    await wrapper.find('.prt-notes-btn').trigger('click')

    // External agent flips phase-b to done after the toolbar's initial read.
    setContent(
      planDoc(
        baseMeta({
          reviewNotes: [{ id: 'n1', author: 'user', text: 'First', resolved: false, reply: '', anchor: '' }],
          todos: [
            { id: 'phase-a', content: 'Phase A', status: 'done' },
            { id: 'phase-b', content: 'Phase B', status: 'done' },
          ],
        }),
      ),
    )

    await wrapper.findAll('.prt-note-resolve')[0].trigger('click')
    await flushPromises()

    const written = lastWrittenMeta(writes)
    // External todo change survives, and our resolve is applied on top of it.
    expect(written.todos[1].status).toBe('done')
    expect(written.reviewNotes[0]).toMatchObject({ id: 'n1', resolved: true })
  })

  it('recomputes the submitted note id against fresh notes', async () => {
    const { wrapper, writes, setContent } = await mountToolbar(planDoc(baseMeta()))
    await openOverflow(wrapper)
    await wrapper.find('.prt-menu .prt-notes-btn').trigger('click')

    // External agent appended n5 after the toolbar's initial read.
    setContent(
      planDoc(
        baseMeta({
          reviewNotes: [{ id: 'n5', author: 'ai', text: 'External', resolved: true, reply: '', anchor: '' }],
        }),
      ),
    )

    await wrapper.find('.prt-input').setValue('New note')
    await wrapper.find('.prt-send').trigger('click')
    await flushPromises()

    const written = lastWrittenMeta(writes)
    expect(written.reviewNotes).toHaveLength(2)
    expect(written.reviewNotes[0]).toMatchObject({ id: 'n5', text: 'External' })
    expect(written.reviewNotes[1]).toMatchObject({ id: 'n6', text: 'New note', author: 'user' })
  })

  it('aborts approve without writing when the fresh file is no longer approvable', async () => {
    const { wrapper, writes, setContent } = await mountToolbar(planDoc(baseMeta()))
    expect(wrapper.find('.prt-approve').attributes('disabled')).toBeUndefined()

    // External agent moved the plan into in-progress (past review) after the read.
    setContent(planDoc(baseMeta({ stage: 'in-progress' })))

    await wrapper.find('.prt-approve').trigger('click')
    await flushPromises()

    expect(writes).toHaveLength(0)
    // The UI refreshed to the fresh state instead of writing.
    expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--in-progress')
    expect(wrapper.emitted('updated')).toHaveLength(1)
  })
})

describe('PlanReviewToolbar – share to git', () => {
  it('writes the freshly-read content byte-identical to .plans/<filename>', async () => {
    toastMock.mockClear()
    const { wrapper, writeCalls, setContent } = await mountToolbar(planDoc(baseMeta()))

    // External edit after mount: the share must snapshot the fresh bytes.
    const freshDoc = planDoc(baseMeta({ stage: 'approved', approvedAt: '2026-07-19T00:00:00Z' }))
    setContent(freshDoc)

    await openOverflow(wrapper)
    await wrapper.find('.prt-share').trigger('click')
    await flushPromises()

    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0].relPath).toBe('.plans/test-plan_a1b2c3.html')
    expect(writeCalls[0].content).toBe(freshDoc)
    expect(toastMock).toHaveBeenCalledWith('Saved to .plans/ — commit to share')
  })

  it('shows the backend error via toast when the write fails', async () => {
    toastMock.mockClear()
    const { wrapper, writeCalls } = await mountToolbar(planDoc(baseMeta()), {
      failWrite: 'disk full',
    })

    await openOverflow(wrapper)
    await wrapper.find('.prt-share').trigger('click')
    await flushPromises()

    expect(writeCalls).toHaveLength(0)
    expect(toastMock).toHaveBeenCalledWith('disk full')
  })
})

// Fixture with visible markup (stage pill + todo list) so markup-sync on
// write can be asserted alongside the meta change.
function markupDoc(meta: HtmlPlanMeta): string {
  return [
    '<html><head><title>Test Plan</title></head><body>',
    '<h1>Test Plan<span class="pill in-review">in-review</span></h1>',
    '<ul class="todos">',
    '<li data-status="done" data-todo-id="phase-a"><span class="st">done</span> <span>Phase A</span></li>',
    '<li data-status="pending" data-todo-id="phase-b"><span class="st">pending</span> <span>Phase B</span></li>',
    '</ul>',
    '<script type="application/json" id="plan-meta">',
    JSON.stringify(meta, null, 2),
    '</scr' + 'ipt>',
    '</body></html>',
  ].join('\n')
}

describe('PlanReviewToolbar – todo sidebar', () => {
  it('cycles a pending todo to in-progress and syncs the visible markup', async () => {
    const { wrapper, writes } = await mountToolbar(markupDoc(baseMeta()))
    await wrapper.find('.prt-todos-btn').trigger('click')
    const todos = wrapper.findAll('.prt-todo')
    expect(todos).toHaveLength(2)

    await todos[1].trigger('click') // phase-b: pending → in-progress
    await flushPromises()

    const written = lastWrittenMeta(writes)
    expect(written.todos[1]).toMatchObject({ id: 'phase-b', status: 'in-progress' })
    // Meta + markup written together: data-status and .st pill are synced.
    expect(writes[0]).toContain(
      '<li data-status="in-progress" data-todo-id="phase-b"><span class="st">in-progress</span>',
    )
    // Untouched todo markup stays as-is; stage pill re-synced to same stage.
    expect(writes[0]).toContain('<li data-status="done" data-todo-id="phase-a"><span class="st">done</span>')
    expect(writes[0]).toContain('<span class="pill in-review">in-review</span>')
    // UI reflects the new status without a remount.
    expect(wrapper.findAll('.prt-todo')[1].classes()).toContain('prt-todo--in-progress')
  })

  it('cycles a done todo back to pending', async () => {
    const { wrapper, writes } = await mountToolbar(markupDoc(baseMeta()))
    await wrapper.find('.prt-todos-btn').trigger('click')

    await wrapper.findAll('.prt-todo')[0].trigger('click') // phase-a: done → pending
    await flushPromises()

    expect(lastWrittenMeta(writes).todos[0]).toMatchObject({ id: 'phase-a', status: 'pending' })
    expect(writes[0]).toContain('<li data-status="pending" data-todo-id="phase-a"><span class="st">pending</span>')
  })

  it('right-click toggles skipped and back to pending', async () => {
    const { wrapper, writes } = await mountToolbar(markupDoc(baseMeta()))
    await wrapper.find('.prt-todos-btn').trigger('click')

    await wrapper.findAll('.prt-todo')[1].trigger('contextmenu')
    await flushPromises()
    expect(lastWrittenMeta(writes).todos[1]).toMatchObject({ id: 'phase-b', status: 'skipped' })
    expect(writes[0]).toContain('<li data-status="skipped" data-todo-id="phase-b"><span class="st">skipped</span>')

    await wrapper.findAll('.prt-todo')[1].trigger('contextmenu')
    await flushPromises()
    expect(lastWrittenMeta(writes).todos[1]).toMatchObject({ id: 'phase-b', status: 'pending' })
  })
})

describe('PlanReviewToolbar – stage controls', () => {
  it('abandons an active plan after confirmation, syncing the stage pill', async () => {
    confirmMock.mockClear()
    confirmMock.mockResolvedValueOnce(true)
    const { wrapper, writes } = await mountToolbar(markupDoc(baseMeta()))
    await openOverflow(wrapper)
    expect(wrapper.find('.prt-reopen').exists()).toBe(false)

    await wrapper.find('.prt-abandon').trigger('click')
    await flushPromises()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(lastWrittenMeta(writes).stage).toBe('abandoned')
    expect(writes[0]).toContain('<span class="pill abandoned">abandoned</span>')
    expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--abandoned')
  })

  it('does not write when the abandon confirmation is declined', async () => {
    confirmMock.mockClear()
    confirmMock.mockResolvedValueOnce(false)
    const { wrapper, writes } = await mountToolbar(markupDoc(baseMeta()))

    await openOverflow(wrapper)
    await wrapper.find('.prt-abandon').trigger('click')
    await flushPromises()

    expect(writes).toHaveLength(0)
  })

  it('reopens a done plan into in-review and clears approvedAt', async () => {
    const meta = baseMeta({ stage: 'done', approvedAt: '2026-07-01T00:00:00Z' })
    const { wrapper, writes } = await mountToolbar(markupDoc(meta))
    await openOverflow(wrapper)
    expect(wrapper.find('.prt-abandon').exists()).toBe(false)

    await wrapper.find('.prt-reopen').trigger('click')
    await flushPromises()

    const written = lastWrittenMeta(writes)
    expect(written.stage).toBe('in-review')
    expect(written.approvedAt).toBeNull()
    expect(writes[0]).toContain('<span class="pill in-review">in-review</span>')
  })

  it('aborts the abandon without writing when the fresh file is already finished', async () => {
    confirmMock.mockClear()
    confirmMock.mockResolvedValueOnce(true)
    const { wrapper, writes, setContent } = await mountToolbar(markupDoc(baseMeta()))

    // External agent finished the plan after the toolbar's read.
    setContent(markupDoc(baseMeta({ stage: 'done' })))

    await openOverflow(wrapper)
    await wrapper.find('.prt-abandon').trigger('click')
    await flushPromises()

    expect(writes).toHaveLength(0)
    expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--done')
  })
})

describe('PlanReviewToolbar – external refresh', () => {
  it('re-reads the file on window focus and emits updated when it changed', async () => {
    const { wrapper, setContent } = await mountToolbar(planDoc(baseMeta()))
    expect(wrapper.emitted('updated')).toBeUndefined()

    setContent(planDoc(baseMeta({ stage: 'approved', approvedAt: '2026-07-18T00:00:00Z' })))
    window.dispatchEvent(new Event('focus'))
    await flushPromises()

    expect(wrapper.emitted('updated')).toHaveLength(1)
    expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--approved')
  })

  it('does not emit updated on focus when the file is unchanged', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()))
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(wrapper.emitted('updated')).toBeUndefined()
  })

  it('silently re-reads on a matching plans.changed broadcast', async () => {
    const { wrapper, setContent, emitBackend } = await mountToolbar(planDoc(baseMeta()))
    setContent(planDoc(baseMeta({ stage: 'approved', approvedAt: '2026-07-19T00:00:00Z' })))

    emitBackend('plans.changed', { workspace_path: '/ws' })
    await flushPromises()

    expect(wrapper.emitted('updated')).toHaveLength(1)
    expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--approved')
  })

  it('re-reads when the broadcast names the enclosing project root of the window workspace', async () => {
    // The Host reports the plan root (the git root), which is an ancestor of a
    // window opened on a repository subdirectory.
    const { wrapper, setContent, emitBackend } = await mountToolbar(planDoc(baseMeta()))
    setContent(planDoc(baseMeta({ stage: 'approved', approvedAt: '2026-07-19T00:00:00Z' })))

    emitBackend('plans.changed', { workspace_path: '/' })
    await flushPromises()

    expect(wrapper.emitted('updated')).toHaveLength(1)
  })

  it('ignores plans.changed broadcasts for other workspaces', async () => {
    const { wrapper, setContent, emitBackend } = await mountToolbar(planDoc(baseMeta()))
    setContent(planDoc(baseMeta({ stage: 'approved', approvedAt: '2026-07-19T00:00:00Z' })))

    emitBackend('plans.changed', { workspace_path: '/other-ws' })
    emitBackend('plans.changed', null)
    await flushPromises()

    expect(wrapper.emitted('updated')).toBeUndefined()
    expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--in-review')
  })
})

// ── History panel (Phase C) ────────────────────────────────────────────────

const HISTORY_DIR = '.agent-team/plans/.history/test-plan_a1b2c3'

describe('PlanReviewToolbar – history panel', () => {
  it('lists parseable snapshots newest first with preview and diff actions', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()), {
      history: {
        entries: [
          { name: '20260601T080000_draft.html', is_dir: false },
          { name: '20260710T120000_in-review.html', is_dir: false },
          { name: 'not-a-snapshot.html', is_dir: false },
          { name: 'subdir', is_dir: true },
        ],
      },
    })

    await openOverflow(wrapper)
    await wrapper.find('.prt-history-btn').trigger('click')
    await flushPromises()

    const rows = wrapper.findAll('.prt-history-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].find('.prt-history-stage').text()).toBe('in-review')
    expect(rows[1].find('.prt-history-stage').text()).toBe('draft')
    const actions = rows[0].findAll('.prt-history-action')
    expect(actions.map((a) => a.text())).toEqual(['Preview', 'Diff', 'Restore'])
  })

  it('labels who made each version and why, and marks a kept conflict side', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()), {
      history: {
        versions: [
          { file: '20260710T120000_in-review.html.parts.gz', stage: 'in-review', author: { kind: 'agent' }, reason: 'save' },
          { file: '20260709T120000_in-review.html.gz', stage: 'in-review', author: { kind: 'user' }, reason: 'conflict', detached: true },
          { file: '20260708T120000_draft.html.gz', stage: 'draft', author: { kind: 'external' }, reason: 'external' },
          { file: '20260601T080000_draft.html', stage: 'draft' },
        ],
      },
    })
    await openOverflow(wrapper)
    await wrapper.find('.prt-history-btn').trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('.prt-history-row')
    expect(rows.map(row => [row.find('.prt-history-author').text(), row.find('.prt-history-reason').text()])).toEqual([
      ['Agent', 'Saved'],
      ['You', 'Version you did not keep'],
      ['Outside Plans', 'Edited outside Plans'],
      ['Unknown', 'Stage change'],
    ])
  })

  it('names the agent pane a version came from, and ignores a pane on any other author', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()), {
      history: {
        versions: [
          { file: '20260710T120000_in-review.html.gz', stage: 'in-review', author: { kind: 'agent', pane: 'Reviewer' }, reason: 'save' },
          { file: '20260709T120000_in-review.html.gz', stage: 'in-review', author: { kind: 'agent', pane: '  ' }, reason: 'save' },
          { file: '20260708T120000_in-review.html.gz', stage: 'in-review', author: { kind: 'user', pane: 'Reviewer' }, reason: 'save' },
        ],
      },
    })
    await openOverflow(wrapper)
    await wrapper.find('.prt-history-btn').trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('.prt-history-row')
    expect(rows.map(row => row.find('.prt-history-author').text())).toEqual(['Agent · Reviewer', 'Agent', 'You'])
  })

  it('restores a version after confirmation and refreshes the plan', async () => {
    const { wrapper, backend } = await mountToolbar(planDoc(baseMeta()), {
      history: { versions: [{ file: '20260601T080000_draft.html.gz', stage: 'draft', author: { kind: 'user' }, reason: 'save' }] },
    })
    await openOverflow(wrapper)
    await wrapper.find('.prt-history-btn').trigger('click')
    await flushPromises()
    confirmMock.mockClear()
    await wrapper.find('.prt-history-restore').trigger('click')
    await flushPromises()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    const restore = (backend.send as ReturnType<typeof vi.fn>).mock.calls.find(([type]) => type === 'history.restore')
    expect(restore?.[1]).toMatchObject({ rel_path: PLAN_REL_PATH, file: '20260601T080000_draft.html.gz' })
    expect(wrapper.emitted('updated')).toBeTruthy()
  })

  it('does not restore when declined, and says so when the plan moved meanwhile', async () => {
    const { wrapper, backend } = await mountToolbar(planDoc(baseMeta()), {
      history: {
        versions: [{ file: '20260601T080000_draft.html.gz', stage: 'draft' }],
        restore: { ok: false, conflict: true },
      },
    })
    await openOverflow(wrapper)
    await wrapper.find('.prt-history-btn').trigger('click')
    await flushPromises()
    const restores = () => (backend.send as ReturnType<typeof vi.fn>).mock.calls.filter(([type]) => type === 'history.restore')
    confirmMock.mockResolvedValueOnce(false)
    await wrapper.find('.prt-history-restore').trigger('click')
    await flushPromises()
    expect(restores()).toHaveLength(0)
    toastMock.mockClear()
    await wrapper.find('.prt-history-restore').trigger('click')
    await flushPromises()
    expect(restores()).toHaveLength(1)
    expect(toastMock).toHaveBeenCalledWith('The plan changed while restoring. Try again.')
    expect(wrapper.emitted('updated')).toBeFalsy()
  })

  it('shows the text that changed between a version and the plan', async () => {
    const snapshot = planDoc(baseMeta()).replace('tail marker', 'old closing line')
    const { wrapper } = await mountToolbar(planDoc(baseMeta()), {
      history: {
        versions: [{ file: '20260601T080000_in-review.html.gz', stage: 'in-review' }],
        files: { [`${HISTORY_DIR}/20260601T080000_in-review.html.gz`]: snapshot },
      },
    })
    await openOverflow(wrapper)
    await wrapper.find('.prt-history-btn').trigger('click')
    await flushPromises()
    await wrapper.findAll('.prt-history-action')[1].trigger('click')
    await flushPromises()
    const lines = wrapper.findAll('.prt-history-line').map(line => [line.classes().find(c => c.startsWith('prt-history-line--')), line.text()])
    expect(lines).toEqual([
      ['prt-history-line--del', '−old closing line'],
      ['prt-history-line--add', '+tail marker'],
    ])
  })

  it('flags an approved plan whose text changed since approval, not its todo progress', async () => {
    const approved = planDoc(baseMeta({ stage: 'approved' }))
    const versions = [{ file: '20260601T080000_approved.html.gz', stage: 'approved', reason: 'stage' }]
    const files = { [`${HISTORY_DIR}/20260601T080000_approved.html.gz`]: approved }
    const unchanged = await mountToolbar(planDoc(baseMeta({
      stage: 'in-progress',
      todos: [{ id: 'phase-a', content: 'Phase A', status: 'done' }, { id: 'phase-b', content: 'Phase B', status: 'done' }],
    })), { history: { versions, files } })
    await flushPromises()
    expect(unchanged.wrapper.find('[data-test="approved-modified"]').exists()).toBe(false)

    const edited = await mountToolbar(planDoc(baseMeta({ stage: 'in-progress' })).replace('tail marker', 'rewritten after approval'), {
      history: { versions, files },
    })
    await flushPromises()
    const badge = edited.wrapper.get('[data-test="approved-modified"]')
    expect(badge.text()).toBe('Changed since approval')
    await badge.trigger('click')
    await flushPromises()
    expect(edited.wrapper.find('.prt-history-line--add').text()).toContain('rewritten after approval')
  })

  it('shows the empty state when the history directory does not exist', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()), {
      history: { error: 'not a directory' },
    })

    await openOverflow(wrapper)
    await wrapper.find('.prt-history-btn').trigger('click')
    await flushPromises()

    expect(wrapper.find('.prt-history-row').exists()).toBe(false)
    expect(wrapper.find('.prt-empty').text()).toBe('No history snapshots yet')
  })

  it('emits preview-snapshot with the snapshot rel path and a stage-bearing label', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()), {
      history: { entries: [{ name: '20260601T080000_draft.html', is_dir: false }] },
    })
    await openOverflow(wrapper)
    await wrapper.find('.prt-history-btn').trigger('click')
    await flushPromises()

    await wrapper.findAll('.prt-history-action')[0].trigger('click')
    const emitted = wrapper.emitted('preview-snapshot')!
    expect(emitted).toHaveLength(1)
    const payload = emitted[0][0] as { relPath: string; label: string }
    expect(payload.relPath).toBe(`${HISTORY_DIR}/20260601T080000_draft.html`)
    expect(payload.label).toContain('draft')
  })

  it('renders an inline diff summary between a snapshot and the current plan', async () => {
    const snapshot = planDoc(
      baseMeta({
        stage: 'draft',
        todos: [{ id: 'phase-a', content: 'Phase A', status: 'pending' }],
      }),
    )
    // Current: stage in-review, phase-a done, phase-b added, one note added.
    const current = planDoc(
      baseMeta({
        todos: [
          { id: 'phase-a', content: 'Phase A', status: 'done' },
          { id: 'phase-b', content: 'Phase B', status: 'pending' },
        ],
        reviewNotes: [
          { id: 'n1', author: 'user', text: 'note', resolved: false, reply: '', anchor: '' },
        ],
      }),
    )
    const { wrapper } = await mountToolbar(current, {
      history: {
        entries: [{ name: '20260601T080000_draft.html', is_dir: false }],
        files: { [`${HISTORY_DIR}/20260601T080000_draft.html`]: snapshot },
      },
    })
    await openOverflow(wrapper)
    await wrapper.find('.prt-history-btn').trigger('click')
    await flushPromises()

    await wrapper.findAll('.prt-history-action')[1].trigger('click')
    await flushPromises()

    const diff = wrapper.find('.prt-history-diff')
    expect(diff.exists()).toBe(true)
    expect(diff.text()).toContain('Stage: draft → in-review')
    expect(diff.text()).toContain('Todo phase-a: pending → done')
    expect(diff.text()).toContain('1 todo added')
    expect(diff.text()).toContain('Review notes: +1')
    expect(diff.text()).toMatch(/\+\d+ \/ −\d+ lines/)
  })

  it('shows the no-differences message when the snapshot equals the current plan', async () => {
    const doc = planDoc(baseMeta())
    const { wrapper } = await mountToolbar(doc, {
      history: {
        entries: [{ name: '20260601T080000_in-review.html', is_dir: false }],
        files: { [`${HISTORY_DIR}/20260601T080000_in-review.html`]: doc },
      },
    })
    await openOverflow(wrapper)
    await wrapper.find('.prt-history-btn').trigger('click')
    await flushPromises()

    await wrapper.findAll('.prt-history-action')[1].trigger('click')
    await flushPromises()

    expect(wrapper.find('.prt-history-diff').text()).toBe('No differences')
  })
})

// Exposed methods used by the host to route validated in-document
// interactions (Phase B) through the toolbar's existing write paths.
interface ExposedToolbar {
  cycleTodo: (id: string) => Promise<void>
  toggleSkipTodo: (id: string) => Promise<void>
  startNoteWithAnchor: (anchor: string) => void
}

function exposed(wrapper: VueWrapper): ExposedToolbar {
  return wrapper.vm as unknown as ExposedToolbar
}

describe('PlanReviewToolbar – in-document interactions (Phase B)', () => {
  it('exposed cycleTodo writes the next status through the normal write path', async () => {
    const { wrapper, writes } = await mountToolbar(markupDoc(baseMeta()))

    await exposed(wrapper).cycleTodo('phase-b') // pending → in-progress
    await flushPromises()

    expect(lastWrittenMeta(writes).todos[1]).toMatchObject({ id: 'phase-b', status: 'in-progress' })
    expect(writes[0]).toContain(
      '<li data-status="in-progress" data-todo-id="phase-b"><span class="st">in-progress</span>',
    )
  })

  it('exposed toggleSkipTodo flips a todo to skipped', async () => {
    const { wrapper, writes } = await mountToolbar(markupDoc(baseMeta()))

    await exposed(wrapper).toggleSkipTodo('phase-b')
    await flushPromises()

    expect(lastWrittenMeta(writes).todos[1]).toMatchObject({ id: 'phase-b', status: 'skipped' })
  })

  it('startNoteWithAnchor opens the notes panel and submit writes the anchored note', async () => {
    const { wrapper, writes } = await mountToolbar(planDoc(baseMeta()))
    expect(wrapper.find('.prt-new').exists()).toBe(false)

    exposed(wrapper).startNoteWithAnchor('Phase B · Runtime')
    await flushPromises()

    expect(wrapper.find('.prt-note-anchor--pending').text()).toContain('Phase B · Runtime')
    await wrapper.find('.prt-input').setValue('Anchored comment')
    await wrapper.find('.prt-send').trigger('click')
    await flushPromises()

    const written = lastWrittenMeta(writes)
    expect(written.reviewNotes[0]).toMatchObject({
      text: 'Anchored comment',
      author: 'user',
      anchor: 'Phase B · Runtime',
    })
    // The pending anchor chip is cleared after a successful submit.
    expect(wrapper.find('.prt-note-anchor--pending').exists()).toBe(false)
  })

  it('clears the pending anchor via its remove button without writing', async () => {
    const { wrapper, writes } = await mountToolbar(planDoc(baseMeta()))
    exposed(wrapper).startNoteWithAnchor('Goals')
    await flushPromises()

    await wrapper.find('.prt-anchor-clear').trigger('click')
    expect(wrapper.find('.prt-note-anchor--pending').exists()).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it('shows the anchor badge on anchored notes in the panel', async () => {
    const meta = baseMeta({
      reviewNotes: [
        { id: 'n1', author: 'user', text: 'On risks', resolved: false, reply: '', anchor: 'Risks' },
      ],
    })
    const { wrapper } = await mountToolbar(planDoc(meta))
    await wrapper.find('.prt-notes-btn').trigger('click')
    expect(wrapper.find('.prt-note .prt-note-anchor').text()).toBe('Risks')
  })
})

// ── Execute dispatch (Phase D) ─────────────────────────────────────────────

describe('PlanReviewToolbar – execute dispatch', () => {
  const dispatchMock = vi.fn(async () => ({ delivered: true }))
  type ExecutionResult = { workspace_path: string; rel_path: string; ok: boolean; reason?: string }
  let executionResultHandler: ((p: ExecutionResult) => void) | null = null

  function installAgentTeam(): void {
    executionResultHandler = null
    ;(window as unknown as { agentTeam: unknown }).agentTeam = {
      dispatchPlanExecution: dispatchMock,
      onPlanExecutionResult: (h: (p: ExecutionResult) => void) => {
        executionResultHandler = h
        return () => {
          executionResultHandler = null
        }
      },
    }
  }

  function approvedMeta(overrides: Partial<HtmlPlanMeta> = {}): HtmlPlanMeta {
    return baseMeta({ stage: 'approved', approvedAt: '2026-07-19T00:00:00Z', ...overrides })
  }

  it('hides the Execute button unless the stage is approved', async () => {
    for (const stage of ['draft', 'in-review', 'in-progress', 'done', 'abandoned'] as const) {
      const { wrapper } = await mountToolbar(planDoc(baseMeta({ stage })))
      expect(wrapper.find('.prt-execute').exists()).toBe(false)
    }
    const { wrapper } = await mountToolbar(planDoc(approvedMeta()))
    expect(wrapper.find('.prt-execute').exists()).toBe(true)
  })

  it('opens an agent picker listing CLI agents without the plain terminal', async () => {
    const { wrapper } = await mountToolbar(planDoc(approvedMeta()))
    expect(wrapper.find('.prt-execute-agent').exists()).toBe(false)

    await wrapper.find('.prt-execute').trigger('click')
    const labels = wrapper.findAll('.prt-execute-agent .prt-execute-agent-label').map((b) => b.text())
    expect(labels).toContain('Claude Code (Anthropic)')
    expect(labels).toContain('Codex CLI (OpenAI)')
    expect(labels).not.toContain('Terminal')
  })

  it('dispatching appends an execution, moves stage to in-progress, syncs markup, and sends the IPC payload', async () => {
    installAgentTeam()
    dispatchMock.mockClear()
    toastMock.mockClear()
    const { wrapper, writes } = await mountToolbar(markupDoc(approvedMeta()))

    await wrapper.find('.prt-execute').trigger('click')
    const claude = wrapper
      .findAll('.prt-execute-agent')
      .find((b) => b.text().includes('Claude Code'))!
    await claude.trigger('click')
    await flushPromises()

    expect(writes).toHaveLength(1)
    const written = lastWrittenMeta(writes)
    expect(written.stage).toBe('in-progress')
    expect(written.executions).toHaveLength(1)
    expect(written.executions![0].agent).toBe('claude')
    expect(Number.isNaN(Date.parse(written.executions![0].startedAt))).toBe(false)
    // Visible stage pill synced alongside the meta write.
    expect(writes[0]).toContain('<span class="pill in-progress">in-progress</span>')
    // IPC payload shape.
    expect(dispatchMock).toHaveBeenCalledTimes(1)
    expect(dispatchMock).toHaveBeenCalledWith({
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/test-plan_a1b2c3.html',
      agent_key: 'claude',
    })
    // delivered only means forwarded: no success toast until the result event.
    expect(toastMock).not.toHaveBeenCalledWith('Plan dispatched to CLI agent')

    executionResultHandler!({ workspace_path: '/ws', rel_path: PLAN_REL_PATH, ok: true })
    await flushPromises()

    expect(toastMock).toHaveBeenCalledWith('Plan dispatched to CLI agent')
    expect(writes).toHaveLength(1) // success — no rollback write
  })

  it('rolls back the execution and reverts to approved on a failed execution result', async () => {
    installAgentTeam()
    dispatchMock.mockClear()
    toastMock.mockClear()
    const { wrapper, writes } = await mountToolbar(markupDoc(approvedMeta()))

    await wrapper.find('.prt-execute').trigger('click')
    await wrapper.findAll('.prt-execute-agent')[0].trigger('click')
    await flushPromises()
    expect(writes).toHaveLength(1)

    executionResultHandler!({
      workspace_path: '/ws',
      rel_path: PLAN_REL_PATH,
      ok: false,
      reason: 'inject-failed',
    })
    await flushPromises()

    expect(writes).toHaveLength(2)
    const rolledBack = lastWrittenMeta(writes)
    expect(rolledBack.stage).toBe('approved')
    expect(rolledBack.executions ?? []).toHaveLength(0)
    // Markup synced with the rollback write.
    expect(writes[1]).toContain('<span class="pill approved">approved</span>')
    expect(toastMock).toHaveBeenCalledWith(
      'Dispatch failed — the plan was reverted to approved, please retry',
    )
    expect(toastMock).not.toHaveBeenCalledWith('Plan dispatched to CLI agent')
  })

  it('ignores execution results addressed to another plan file', async () => {
    installAgentTeam()
    dispatchMock.mockClear()
    toastMock.mockClear()
    const { wrapper, writes } = await mountToolbar(planDoc(approvedMeta()))

    await wrapper.find('.prt-execute').trigger('click')
    await wrapper.findAll('.prt-execute-agent')[0].trigger('click')
    await flushPromises()

    executionResultHandler!({
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/other-plan_ffffff.html',
      ok: false,
    })
    await flushPromises()

    expect(writes).toHaveLength(1) // no rollback
    expect(toastMock).not.toHaveBeenCalledWith(
      'Dispatch failed — the plan was reverted to approved, please retry',
    )
  })

  it('rolls back locally right away when the dispatch is not delivered', async () => {
    installAgentTeam()
    dispatchMock.mockClear()
    dispatchMock.mockResolvedValueOnce({ delivered: false })
    toastMock.mockClear()
    const { wrapper, writes } = await mountToolbar(planDoc(approvedMeta()))

    await wrapper.find('.prt-execute').trigger('click')
    await wrapper.findAll('.prt-execute-agent')[0].trigger('click')
    await flushPromises()

    // Dispatch write + immediate rollback write: retry starts from approved.
    expect(writes).toHaveLength(2)
    const rolledBack = lastWrittenMeta(writes)
    expect(rolledBack.stage).toBe('approved')
    expect(rolledBack.executions ?? []).toHaveLength(0)
    expect(toastMock).toHaveBeenCalledWith(
      'No main window is open for this workspace — open it and retry',
    )
  })

  it('rolls back when no execution result arrives before the timeout', async () => {
    installAgentTeam()
    dispatchMock.mockClear()
    toastMock.mockClear()
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const { wrapper, writes } = await mountToolbar(planDoc(approvedMeta()))

      await wrapper.find('.prt-execute').trigger('click')
      await wrapper.findAll('.prt-execute-agent')[0].trigger('click')
      await flushPromises()
      expect(writes).toHaveLength(1)

      // Fire the 60s result-timeout guard manually.
      const timeoutCall = timeoutSpy.mock.calls.find((c) => c[1] === 60_000)!
      expect(timeoutCall).toBeDefined()
      ;(timeoutCall[0] as () => void)()
      await flushPromises()

      expect(writes).toHaveLength(2)
      const rolledBack = lastWrittenMeta(writes)
      expect(rolledBack.stage).toBe('approved')
      expect(rolledBack.executions ?? []).toHaveLength(0)
      expect(toastMock).toHaveBeenCalledWith(
        'Dispatch failed — the plan was reverted to approved, please retry',
      )

      // A late result after the timeout settles nothing further.
      executionResultHandler?.({ workspace_path: '/ws', rel_path: PLAN_REL_PATH, ok: true })
      await flushPromises()
      expect(writes).toHaveLength(2)
      expect(toastMock).not.toHaveBeenCalledWith('Plan dispatched to CLI agent')
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('requires confirmation when a dispatched execution is already in progress', async () => {
    installAgentTeam()
    dispatchMock.mockClear()
    confirmMock.mockClear()
    confirmMock.mockResolvedValueOnce(true)
    const { wrapper, writes, setContent } = await mountToolbar(planDoc(approvedMeta()))

    // Concurrent dispatch elsewhere: on disk the plan is already in-progress
    // with a recorded execution.
    setContent(
      planDoc(
        baseMeta({
          stage: 'in-progress',
          approvedAt: '2026-07-19T00:00:00Z',
          executions: [{ agent: 'codex', startedAt: '2026-07-19T01:00:00Z' }],
        }),
      ),
    )

    await wrapper.find('.prt-execute').trigger('click')
    const claude = wrapper
      .findAll('.prt-execute-agent')
      .find((b) => b.text().includes('Claude Code'))!
    await claude.trigger('click')
    await flushPromises()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(1)
    const written = lastWrittenMeta(writes)
    expect(written.executions).toHaveLength(2)
    expect(written.executions![1].agent).toBe('claude')
    expect(written.stage).toBe('in-progress')
    expect(dispatchMock).toHaveBeenCalledTimes(1)
  })

  it('does not write or dispatch when the duplicate confirmation is declined', async () => {
    installAgentTeam()
    dispatchMock.mockClear()
    confirmMock.mockClear()
    confirmMock.mockResolvedValueOnce(false)
    const { wrapper, writes, setContent } = await mountToolbar(planDoc(approvedMeta()))

    setContent(
      planDoc(
        baseMeta({
          stage: 'in-progress',
          approvedAt: '2026-07-19T00:00:00Z',
          executions: [{ agent: 'codex', startedAt: '2026-07-19T01:00:00Z' }],
        }),
      ),
    )

    await wrapper.find('.prt-execute').trigger('click')
    await wrapper.findAll('.prt-execute-agent')[0].trigger('click')
    await flushPromises()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(0)
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('aborts silently without dispatching when the fresh stage is no longer dispatchable', async () => {
    installAgentTeam()
    dispatchMock.mockClear()
    confirmMock.mockClear()
    const { wrapper, writes, setContent } = await mountToolbar(planDoc(approvedMeta()))

    // External agent finished the plan after the toolbar's read.
    setContent(planDoc(baseMeta({ stage: 'done' })))

    await wrapper.find('.prt-execute').trigger('click')
    await wrapper.findAll('.prt-execute-agent')[0].trigger('click')
    await flushPromises()

    expect(writes).toHaveLength(0)
    expect(confirmMock).not.toHaveBeenCalled()
    expect(dispatchMock).not.toHaveBeenCalled()
    expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--done')
  })
})

// ── Optimistic write lock (expected_mtime) ─────────────────────────────────

describe('PlanReviewToolbar – optimistic write lock', () => {
  it('carries the read mtime as expected_mtime on plan writes', async () => {
    const { wrapper, writeAttempts } = await mountToolbar(planDoc(baseMeta()))

    await wrapper.find('.prt-approve').trigger('click')
    await flushPromises()

    expect(writeAttempts).toHaveLength(1)
    expect(writeAttempts[0].relPath).toBe(PLAN_REL_PATH)
    expect(writeAttempts[0].expectedMtime).toBe(1000)
  })

  it('re-reads and retries once when the write hits an mtime conflict', async () => {
    toastMock.mockClear()
    const { wrapper, writes, writeAttempts } = await mountToolbar(planDoc(baseMeta()), {
      conflictWrites: 1,
    })

    await wrapper.find('.prt-approve').trigger('click')
    await flushPromises()

    expect(writeAttempts).toHaveLength(2)
    expect(writes).toHaveLength(1)
    expect(lastWrittenMeta(writes).stage).toBe('approved')
    expect(toastMock).not.toHaveBeenCalledWith('Save failed')
    expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--approved')
  })

  it('surfaces the save-failed toast after a second consecutive conflict', async () => {
    toastMock.mockClear()
    const { wrapper, writes, writeAttempts } = await mountToolbar(planDoc(baseMeta()), {
      conflictWrites: 2,
    })

    await wrapper.find('.prt-approve').trigger('click')
    await flushPromises()

    expect(writeAttempts).toHaveLength(2) // no third attempt
    expect(writes).toHaveLength(0)
    expect(toastMock).toHaveBeenCalledWith('Save failed')
  })

  it('share-to-git snapshots write without expected_mtime (overwrite semantics)', async () => {
    const { wrapper, writeAttempts } = await mountToolbar(planDoc(baseMeta()))

    await openOverflow(wrapper)
    await wrapper.find('.prt-share').trigger('click')
    await flushPromises()

    const shareAttempt = writeAttempts.find((a) => a.relPath === '.plans/test-plan_a1b2c3.html')
    expect(shareAttempt).toBeDefined()
    expect(shareAttempt!.expectedMtime).toBeUndefined()
  })
})

// ── Overflow (⋯) menu ──────────────────────────────────────────────────────
// The bar keeps a handful of icon buttons; everything else moved behind ⋯ and
// is only rendered while the menu is open.

const MENU_ONLY_ACTIONS = [
  '.prt-history-btn',
  '.prt-share',
  '.prt-open-browser',
  '.prt-archive',
  '.prt-abandon',
  '.prt-delete',
]

describe('PlanReviewToolbar – overflow menu', () => {
  it('keeps the moved actions out of the DOM until ⋯ is clicked', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()))
    expect(wrapper.find('.prt-menu').exists()).toBe(false)
    for (const sel of MENU_ONLY_ACTIONS) expect(wrapper.find(sel).exists()).toBe(false)

    await openOverflow(wrapper)
    expect(wrapper.find('.prt-menu').exists()).toBe(true)
    for (const sel of MENU_ONLY_ACTIONS) expect(wrapper.find(sel).exists()).toBe(true)
  })

  it('closes on a backdrop click', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()))
    await openOverflow(wrapper)

    await wrapper.find('.prt-menu-backdrop').trigger('click')

    expect(wrapper.find('.prt-menu').exists()).toBe(false)
  })

  it('closeActiveOverlay dismisses the menu before collapsing an open panel', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()))
    const vm = wrapper.vm as unknown as { closeActiveOverlay: () => boolean }
    await wrapper.find('.prt-todos-btn').trigger('click')
    await openOverflow(wrapper)

    // ESC peels the topmost surface only: the menu first, the panel under it
    // survives to the next press.
    expect(vm.closeActiveOverlay()).toBe(true)
    await nextTick()
    expect(wrapper.find('.prt-menu').exists()).toBe(false)
    expect(wrapper.find('.prt-todo-row').exists()).toBe(true)

    expect(vm.closeActiveOverlay()).toBe(true)
    await nextTick()
    expect(wrapper.find('.prt-todo-row').exists()).toBe(false)
  })

  it('keeps Review Notes on the bar only while notes are unresolved', async () => {
    // All resolved: nothing for the review stage to surface, so it demotes
    // into the menu.
    const { wrapper: resolved } = await mountToolbar(
      planDoc(
        baseMeta({
          reviewNotes: [{ id: 'n1', author: 'user', text: 'Done', resolved: true, reply: '', anchor: '' }],
        }),
      ),
    )
    expect(resolved.find('.prt-icon-btn.prt-notes-btn').exists()).toBe(false)
    await openOverflow(resolved)
    expect(resolved.find('.prt-menu .prt-notes-btn').exists()).toBe(true)

    // One still open: promoted onto the bar and no longer duplicated in the menu.
    const { wrapper: open } = await mountToolbar(
      planDoc(
        baseMeta({
          reviewNotes: [{ id: 'n1', author: 'user', text: 'Open', resolved: false, reply: '', anchor: '' }],
        }),
      ),
    )
    expect(open.find('.prt-icon-btn.prt-notes-btn').exists()).toBe(true)
    await openOverflow(open)
    expect(open.find('.prt-menu .prt-notes-btn').exists()).toBe(false)
  })
})

describe('PlanReviewToolbar – delete', () => {
  it('does nothing when the first confirmation is declined', async () => {
    confirmMock.mockClear()
    confirmMock.mockResolvedValueOnce(false)
    const { wrapper, deleteAttempts } = await mountToolbar(planDoc(baseMeta()))

    await openOverflow(wrapper)
    await wrapper.find('.prt-delete').trigger('click')
    await flushPromises()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(deleteAttempts).toHaveLength(0)
    expect(wrapper.emitted('deleted')).toBeUndefined()
  })

  it('asks a second time for an approved plan and aborts when that is declined', async () => {
    confirmMock.mockClear()
    confirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { wrapper, deleteAttempts } = await mountToolbar(
      planDoc(baseMeta({ stage: 'approved', approvedAt: '2026-07-19T00:00:00Z' })),
    )

    await openOverflow(wrapper)
    await wrapper.find('.prt-delete').trigger('click')
    await flushPromises()

    // Same two-step guard as the plan list: a plan under review or already
    // approved is worth losing work over, so it confirms twice.
    expect(confirmMock).toHaveBeenCalledTimes(2)
    expect(deleteAttempts).toHaveLength(0)
    expect(wrapper.emitted('deleted')).toBeUndefined()
  })

  it('deletes the file and emits deleted with the plan rel path', async () => {
    confirmMock.mockClear()
    const { wrapper, deleteAttempts } = await mountToolbar(planDoc(baseMeta()))

    await openOverflow(wrapper)
    await wrapper.find('.prt-delete').trigger('click')
    await flushPromises()

    expect(deleteAttempts).toEqual([{ workspacePath: '/ws', relPath: PLAN_REL_PATH }])
    expect(wrapper.emitted('deleted')).toEqual([[PLAN_REL_PATH]])
  })

  it('toasts the backend error and emits nothing when the delete fails', async () => {
    confirmMock.mockClear()
    toastMock.mockClear()
    const { wrapper, deleteAttempts } = await mountToolbar(planDoc(baseMeta()), {
      failDelete: 'permission denied',
    })

    await openOverflow(wrapper)
    await wrapper.find('.prt-delete').trigger('click')
    await flushPromises()

    expect(deleteAttempts).toHaveLength(1)
    expect(toastMock).toHaveBeenCalledWith('permission denied', { type: 'error' })
    // The host must not drop the open document when the file is still there.
    expect(wrapper.emitted('deleted')).toBeUndefined()
  })
})

describe('PlanReviewToolbar – narrow-bar demotion', () => {
  it('observes the bar created by the asynchronous document read and demotes on resize', async () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    let resized: () => void = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe = observe
      disconnect = disconnect
    })
    let wrapper: VueWrapper | undefined
    try {
      ;({ wrapper } = await mountToolbar(planDoc(baseMeta())))
      const bar = wrapper.get('.prt-bar').element
      expect(observe).toHaveBeenCalledWith(bar)
      Object.defineProperty(bar, 'clientWidth', { value: 1, configurable: true })
      Object.defineProperty(bar, 'scrollWidth', {
        get: () => bar.querySelectorAll('.prt-icon-btn').length * 30,
        configurable: true,
      })
      resized()
      await flushPromises()
      expect(wrapper.find('.prt-bar .prt-todos-btn').exists()).toBe(false)
      wrapper.unmount()
      wrapper = undefined
      expect(disconnect).toHaveBeenCalled()
    } finally {
      wrapper?.unmount()
      vi.unstubAllGlobals()
    }
  })

  // happy-dom reports every element as 0×0, so drive refitBar() against a
  // stubbed bar whose scrollWidth shrinks as buttons leave it — that is the
  // feedback loop the real layout provides.
  async function measuredBar(): Promise<{ wrapper: VueWrapper; fitTo: (px: number) => Promise<void> }> {
    const { wrapper } = await mountToolbar(
      planDoc(baseMeta({ stage: 'approved', approvedAt: '2026-07-19T00:00:00Z' })),
    )
    const el = wrapper.find('.prt-bar').element
    let clientWidth = 0
    Object.defineProperty(el, 'clientWidth', { get: () => clientWidth, configurable: true })
    Object.defineProperty(el, 'scrollWidth', {
      get: () => el.querySelectorAll('.prt-icon-btn').length * 30,
      configurable: true,
    })
    const refit = (wrapper.vm as unknown as { refitBar: () => Promise<void> }).refitBar
    return {
      wrapper,
      fitTo: async (px: number) => {
        clientWidth = px
        await refit()
        await nextTick()
      },
    }
  }

  it('demotes Todos first, then Execute, then Approve as the bar narrows', async () => {
    const { wrapper, fitTo } = await measuredBar()
    // Todos, Execute, Approve, ⋯ — all four fit.
    await fitTo(200)
    await openOverflow(wrapper)
    expect(wrapper.find('.prt-icon-btn.prt-todos-btn').exists()).toBe(true)
    expect(wrapper.find('.prt-menu-todos').exists()).toBe(false)

    // Room for three: Todos goes first.
    await fitTo(100)
    expect(wrapper.find('.prt-icon-btn.prt-todos-btn').exists()).toBe(false)
    expect(wrapper.find('.prt-menu-todos').exists()).toBe(true)
    expect(wrapper.find('.prt-icon-btn.prt-execute').exists()).toBe(true)
    expect(wrapper.find('.prt-icon-btn.prt-approve').exists()).toBe(true)

    // Room for two: Execute follows.
    await fitTo(70)
    expect(wrapper.find('.prt-menu-execute').exists()).toBe(true)
    expect(wrapper.find('.prt-icon-btn.prt-approve').exists()).toBe(true)

    // Approve is last to go — it is what the review flow leads to.
    await fitTo(20)
    expect(wrapper.find('.prt-icon-btn.prt-approve').exists()).toBe(false)
    expect(wrapper.find('.prt-menu-approve').exists()).toBe(true)
  })
})

describe('PlanReviewToolbar – outline navigation', () => {
  function outlineDoc(meta: HtmlPlanMeta): string {
    return [
      '<html><head><title>Test Plan</title></head><body>',
      '<section><h2>Goals</h2></section>',
      '<section><h2>Phases</h2>',
      '<div class="phase"><div class="phase-head">Phase A · Alpha<span class="size">S</span></div></div>',
      '</section>',
      '<script type="application/json" id="plan-meta">',
      JSON.stringify(meta, null, 2),
      '</scr' + 'ipt>',
      '</body></html>',
    ].join('\n')
  }

  it('lists section and phase anchors and emits scroll-to-anchor on pick', async () => {
    const { wrapper } = await mountToolbar(outlineDoc(baseMeta()))
    await openOverflow(wrapper)
    const parent = wrapper.find('.prt-menu-outline')
    expect(parent.exists()).toBe(true)
    expect(parent.text()).toContain('Outline')
    // The anchors are a submenu: collapsed until the Outline row is expanded.
    expect(wrapper.find('.prt-menu-anchor').exists()).toBe(false)

    await parent.trigger('click')
    const labels = wrapper.findAll('.prt-menu-anchor').map((b) => b.text())
    expect(labels).toEqual(['Goals', 'Phases', 'Phase A · Alpha'])

    await wrapper.findAll('.prt-menu-anchor')[2].trigger('click')
    expect(wrapper.emitted('scroll-to-anchor')).toEqual([['Phase A · Alpha']])
    // Picking dismisses the menu; reopening offers the same entry again.
    expect(wrapper.find('.prt-menu').exists()).toBe(false)
  })

  it('hides the outline entry when the document has no headings', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()))
    await openOverflow(wrapper)
    expect(wrapper.find('.prt-menu-outline').exists()).toBe(false)
  })
})

describe('PlanReviewToolbar – todo CRUD', () => {
  it('adds a todo with a stable kebab id and pending status', async () => {
    const { wrapper, writes } = await mountToolbar(planDoc(baseMeta({ todos: [] })))
    await wrapper.find('.prt-todos-btn').trigger('click')
    await wrapper.find('.prt-new .prt-input').setValue('Write the docs')
    await wrapper.find('.prt-new .prt-send').trigger('click')
    await flushPromises()
    const meta = lastWrittenMeta(writes)
    const added = meta.todos.find((t) => t.id === 'write-the-docs')
    expect(added).toBeDefined()
    expect(added!.content).toBe('Write the docs')
    expect(added!.status).toBe('pending')
  })

  it('edits a todo content inline through writeMeta', async () => {
    const { wrapper, writes } = await mountToolbar(planDoc(baseMeta()))
    await wrapper.find('.prt-todos-btn').trigger('click')
    // First .prt-ghost of the first row is Edit.
    await wrapper.findAll('.prt-todo-row')[0].find('.prt-ghost').trigger('click')
    await wrapper.find('.prt-todo-row .prt-input').setValue('Phase A renamed')
    await wrapper.find('.prt-todo-row .prt-send').trigger('click')
    await flushPromises()
    expect(lastWrittenMeta(writes).todos.find((t) => t.id === 'phase-a')!.content).toBe('Phase A renamed')
  })

  it('deletes a todo only after confirmation', async () => {
    confirmMock.mockResolvedValueOnce(false)
    const { wrapper, writes } = await mountToolbar(planDoc(baseMeta()))
    await wrapper.find('.prt-todos-btn').trigger('click')
    // Decline first: no write.
    await wrapper.find('.prt-todo-row .prt-ghost--danger').trigger('click')
    await flushPromises()
    expect(writes).toHaveLength(0)
    // Accept second: phase-a removed from meta.
    await wrapper.find('.prt-todo-row .prt-ghost--danger').trigger('click')
    await flushPromises()
    expect(lastWrittenMeta(writes).todos.some((t) => t.id === 'phase-a')).toBe(false)
  })
})

describe('PlanReviewToolbar – review note CRUD', () => {
  it('edits a user note text and preserves its resolved state', async () => {
    const meta0 = baseMeta({
      reviewNotes: [{ id: 'n1', author: 'user', text: 'old', resolved: true, reply: '', anchor: '' }],
    })
    const { wrapper, writes } = await mountToolbar(planDoc(meta0))
    // The only note is resolved, so Review Notes lives in the ⋯ menu.
    await openOverflow(wrapper)
    await wrapper.find('.prt-menu .prt-notes-btn').trigger('click')
    await wrapper.find('.prt-note .prt-ghost').trigger('click') // Edit
    await wrapper.find('.prt-note .prt-input').setValue('new text')
    await wrapper.find('.prt-note .prt-send').trigger('click')
    await flushPromises()
    const note = lastWrittenMeta(writes).reviewNotes[0]
    expect(note.text).toBe('new text')
    expect(note.resolved).toBe(true)
  })

  it('does not offer edit for ai-authored notes', async () => {
    const meta0 = baseMeta({
      reviewNotes: [{ id: 'n1', author: 'ai', text: 'x', resolved: false, reply: '', anchor: '' }],
    })
    const { wrapper } = await mountToolbar(planDoc(meta0))
    await wrapper.find('.prt-notes-btn').trigger('click')
    const ghosts = wrapper.find('.prt-note').findAll('.prt-ghost')
    // Only the danger (delete) ghost, no edit ghost.
    expect(ghosts).toHaveLength(1)
    expect(ghosts[0].classes()).toContain('prt-ghost--danger')
  })

  it('deletes a note after confirmation', async () => {
    const meta0 = baseMeta({
      reviewNotes: [{ id: 'n1', author: 'user', text: 'x', resolved: false, reply: '', anchor: '' }],
    })
    const { wrapper, writes } = await mountToolbar(planDoc(meta0))
    await wrapper.find('.prt-notes-btn').trigger('click')
    await wrapper.find('.prt-note .prt-ghost--danger').trigger('click')
    await flushPromises()
    expect(lastWrittenMeta(writes).reviewNotes).toHaveLength(0)
  })
})

describe('PlanReviewToolbar – store delegation', () => {
  it('routes an approve write through the injected store.writeMeta', async () => {
    const store = resolvePlanStore(PLAN_REL_PATH)
    const spy = vi.spyOn(store, 'writeMeta')
    try {
      const meta = baseMeta({
        reviewNotes: [{ id: 'n1', author: 'user', text: 'Ok', resolved: true, reply: 'ack', anchor: '' }],
      })
      const { wrapper, writes } = await mountToolbar(planDoc(meta), { store })
      await wrapper.find('.prt-approve').trigger('click')
      await flushPromises()

      // Delegation: the toolbar no longer reads/writes fs itself for meta —
      // the store owns the read-before-write + optimistic-lock flow.
      expect(spy).toHaveBeenCalledTimes(1)
      expect(writes).toHaveLength(1)
      expect(lastWrittenMeta(writes).stage).toBe('approved')
      expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--approved')
    } finally {
      spy.mockRestore()
    }
  })

  it('passes a syncBody to the store for a todo add so the visible <li> is synced', async () => {
    const store = resolvePlanStore(PLAN_REL_PATH)
    const spy = vi.spyOn(store, 'writeMeta')
    try {
      const { wrapper, writes } = await mountToolbar(markupDoc(baseMeta({ todos: [] })), { store })
      await wrapper.find('.prt-todos-btn').trigger('click')
      await wrapper.find('.prt-new .prt-input').setValue('Write the docs')
      await wrapper.find('.prt-new .prt-send').trigger('click')
      await flushPromises()

      // syncBody argument is present (3rd param) — body-markup sync moved with
      // the write into the store, not dropped.
      expect(spy).toHaveBeenCalledTimes(1)
      expect(typeof spy.mock.calls[0][2]).toBe('function')
      // The added todo lands in meta and its <li> lands in the document body.
      expect(lastWrittenMeta(writes).todos.some((t) => t.id === 'write-the-docs')).toBe(true)
      expect(writes[0]).toContain('data-todo-id="write-the-docs"')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('PlanReviewToolbar – ESC overlay query', () => {
  it('reports and cancels an unsent note input, then an inline todo edit', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()))
    const vm = wrapper.vm as unknown as { closeActiveOverlay: () => boolean }
    expect(vm.closeActiveOverlay()).toBe(false)
    // Unsent note text is an overlay. No unresolved notes here, so Review
    // Notes is opened from the ⋯ menu.
    await openOverflow(wrapper)
    await wrapper.find('.prt-menu .prt-notes-btn').trigger('click')
    await wrapper.find('.prt-new .prt-input').setValue('draft note')
    expect(vm.closeActiveOverlay()).toBe(true) // clears the composer text first
    expect(vm.closeActiveOverlay()).toBe(true) // then collapses the still-open notes panel
    expect(vm.closeActiveOverlay()).toBe(false) // nothing left open
    // An open inline todo editor is an overlay.
    await wrapper.find('.prt-todos-btn').trigger('click')
    await wrapper.findAll('.prt-todo-row')[0].find('.prt-ghost').trigger('click')
    expect(vm.closeActiveOverlay()).toBe(true)
  })

  it('collapses an open panel (no active edit) before falling through to window close', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()))
    const vm = wrapper.vm as unknown as { closeActiveOverlay: () => boolean }
    await wrapper.find('.prt-todos-btn').trigger('click')
    expect(wrapper.find('.prt-todo-row').exists()).toBe(true)
    // First ESC collapses the panel (consumed); a second reports nothing open.
    expect(vm.closeActiveOverlay()).toBe(true)
    await nextTick()
    expect(wrapper.find('.prt-todo-row').exists()).toBe(false)
    expect(vm.closeActiveOverlay()).toBe(false)
  })
})

// The same toolbar drives markdown (.plan.md) plans via the markdown PlanStore:
// meta comes from YAML frontmatter (not an HTML plan-meta island), and todo CRUD
// writes back into the frontmatter with no body markup to sync.
const MD_REL_PATH = '.cursor/plans/md-plan.plan.md'
const MD_CONTENT = `---
name: MD Plan
overview: ov
todos:
  - id: t1
    content: First
    status: pending
stage: in-review
approvedAt: null
reviewNotes: []
---

## Phase A

Body A.
`

async function mountMarkdownToolbar(content: string): Promise<{ wrapper: VueWrapper; writes: string[] }> {
  let current = content
  let mtime = 1
  const writes: string[] = []
  const backend = {
    httpUrl: ref('http://127.0.0.1:8123'),
    status: ref('connected'),
    on: () => () => {},
    send: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      if (type === 'fs.read_file') return { payload: { ok: true, content: current, mtime } }
      if (type === 'fs.write_file') {
        writes.push(payload.content as string)
        current = payload.content as string
        mtime++
        return { payload: { ok: true, mtime } }
      }
      return { payload: { ok: true } }
    }),
  }
  const wrapper = mount(PlanReviewToolbar, {
    props: { workspacePath: '/ws', relPath: MD_REL_PATH, backend: backend as never, store: resolvePlanStore(MD_REL_PATH), notes: [], todos: [], noteActions: { add: async () => false, edit: async () => false, resolve: async () => false, remove: async () => false } },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return { wrapper, writes }
}

describe('PlanReviewToolbar – markdown plans', () => {
  it('renders the stage badge and progress from .plan.md frontmatter', async () => {
    const { wrapper } = await mountMarkdownToolbar(MD_CONTENT)
    const badge = wrapper.find('.prt-stage')
    expect(badge.exists()).toBe(true)
    expect(badge.classes()).toContain('prt-stage--in-review')
    expect(badge.text()).toBe('In Review')
    expect(wrapper.find('.prt-progress').text()).toBe('0/1 done')
  })

  it('adds a todo into the frontmatter (no HTML body markup to sync)', async () => {
    const { wrapper, writes } = await mountMarkdownToolbar(MD_CONTENT)
    await wrapper.find('.prt-todos-btn').trigger('click')
    await wrapper.find('.prt-new .prt-input').setValue('Write the docs')
    await wrapper.find('.prt-new .prt-send').trigger('click')
    await flushPromises()
    expect(writes).toHaveLength(1)
    const written = writes[0]
    // Todo landed in frontmatter; the markdown body is preserved verbatim.
    const meta = parsePlanMeta(written)
    expect(meta!.todos.map((t) => t.content)).toContain('Write the docs')
    expect(written).toContain('## Phase A')
    expect(written).toContain('Body A.')
    // No HTML todo markup was injected into a markdown document.
    expect(written).not.toContain('data-todo-id')
  })

  it('history panel shows only same-format (.plan.md) snapshots, hiding .html ones', async () => {
    const backend = {
      httpUrl: ref('http://127.0.0.1:8123'),
      status: ref('connected'),
      on: () => () => {},
      send: vi.fn(async (type: string) => {
        if (type === 'fs.read_file') return { payload: { ok: true, content: MD_CONTENT, mtime: 1 } }
        if (type === 'history.list') {
          return {
            payload: {
              ok: true,
              versions: [
                { file: '20260601T080000_draft.plan.md', stage: 'draft' },
                { file: '20260710T120000_in-review.plan.md.gz', stage: 'in-review' },
                // Same-stem HTML snapshots must not leak into a markdown plan's history.
                { file: '20260711T090000_approved.html.gz', stage: 'approved' },
              ],
            },
          }
        }
        return { payload: { ok: true } }
      }),
    }
    const wrapper = mount(PlanReviewToolbar, {
      props: { workspacePath: '/ws', relPath: MD_REL_PATH, backend: backend as never, store: resolvePlanStore(MD_REL_PATH), notes: [], todos: [], noteActions: { add: async () => false, edit: async () => false, resolve: async () => false, remove: async () => false } },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    await openOverflow(wrapper)
    await wrapper.find('.prt-history-btn').trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('.prt-history-row')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.find('.prt-history-stage').text())).toEqual(['in-review', 'draft'])
  })
})

describe('PlanReviewToolbar – archive', () => {
  it('shows the Archive button and no archived pill for an unarchived plan', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()))
    await openOverflow(wrapper)
    expect(wrapper.find('.prt-archive').exists()).toBe(true)
    expect(wrapper.find('.prt-unarchive').exists()).toBe(false)
    expect(wrapper.find('.prt-archived-pill').exists()).toBe(false)
  })

  it('archives the plan, writing archivedAt (stage untouched) and showing the pill + Unarchive', async () => {
    const { wrapper, writes } = await mountToolbar(planDoc(baseMeta()))
    await openOverflow(wrapper)
    await wrapper.find('.prt-archive').trigger('click')
    await flushPromises()

    const written = lastWrittenMeta(writes)
    expect(typeof written.archivedAt).toBe('string')
    expect(written.stage).toBe('in-review') // archive is orthogonal to stage
    // The pill lives on the bar; the archive/unarchive pair needs the menu
    // reopened because acting on an item dismisses it.
    expect(wrapper.find('.prt-archived-pill').exists()).toBe(true)
    await openOverflow(wrapper)
    expect(wrapper.find('.prt-unarchive').exists()).toBe(true)
    expect(wrapper.find('.prt-archive').exists()).toBe(false)
  })

  it('unarchives an archived plan, clearing archivedAt and hiding the pill', async () => {
    const { wrapper, writes } = await mountToolbar(planDoc(baseMeta({ archivedAt: '2026-07-20T00:00:00Z' })))
    expect(wrapper.find('.prt-archived-pill').exists()).toBe(true)

    await openOverflow(wrapper)
    await wrapper.find('.prt-unarchive').trigger('click')
    await flushPromises()

    expect(lastWrittenMeta(writes).archivedAt).toBeNull()
    expect(wrapper.find('.prt-archived-pill').exists()).toBe(false)
    await openOverflow(wrapper)
    expect(wrapper.find('.prt-archive').exists()).toBe(true)
  })
})
