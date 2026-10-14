// @vitest-environment happy-dom
// List-surface coverage for the packaged Plans plugin: the capabilities the v1
// PlansPane offered on a row without opening the document — the "awaiting you"
// marker, dragging a plan onto a CLI pane, and the Share to Git / Archive /
// Promote context-menu entries — plus the sidebar hide/show control. The
// document preview is covered by PlansApp.test.ts and PlansAppMarkdown.test.ts;
// this file keeps its own harness rather than widening the shared one.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

interface FixtureTodo {
  id: string
  content: string
  status: string
  owner?: string
}

interface FixtureMeta {
  schemaVersion: number
  name: string
  overview: string
  stage: string
  approvedAt: string | null
  archivedAt?: string | null
  todos: FixtureTodo[]
  reviewNotes: never[]
}

const state = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  metas: {} as Record<string, unknown>,
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  loadTheme: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(async () => true),
  // Plans whose list entry arrives without meta (an entry too big for one
  // page): the backend still says kind 'plan' and, if archived, archivedAt.
  dropped: {} as Record<string, { name: string; archivedAt?: string; todos?: Record<string, unknown> }>,
}))

const awaitingPath = '.agent-team/plans/awaiting-me_a1b2c3.html'
const clearPath = '.agent-team/plans/all-clear_d4e5f6.html'
const archivedPath = '.agent-team/plans/archived-one_090909.html'
const documentPath = '.agent-team/plans/field-notes.md'
const droppedActivePath = '.agent-team/plans/huge-done_0a0a0a.html'
const droppedArchivedPath = '.agent-team/plans/huge-archived_0b0b0b.html'

function meta(overrides: Partial<FixtureMeta> & Pick<FixtureMeta, 'name' | 'todos'>): FixtureMeta {
  return {
    schemaVersion: 1,
    overview: 'Overview sentence',
    stage: 'in-progress',
    approvedAt: null,
    archivedAt: null,
    reviewNotes: [],
    ...overrides,
  }
}

let PlansApp: any
let wrapper: VueWrapper | null = null

function callsNamed(name: string): Array<Record<string, unknown>> {
  return state.calls.filter((call) => call.name === name).map((call) => call.args)
}

beforeAll(async () => {
  vi.doMock('@navide/plugin-ui', () => ({
    SafeAiCliPanel: { name: 'SafeAiCliPanel', template: '<div data-test="ai-panel" />' },
    createAiCliSessionController: vi.fn(() => ({ dispose: vi.fn() })),
  }))
  vi.doMock('@navide/plugin-ui/foundation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@navide/plugin-ui/foundation')>()
    return {
      ...actual,
      useNotify: () => ({ ...actual.useNotify(), toast: state.toast, confirm: state.confirm }),
      useTheme: () => ({ loadTheme: state.loadTheme }),
    }
  })
  vi.doMock('vue-i18n', async (importOriginal) => {
    const actual = await importOriginal<typeof import('vue-i18n')>()
    return {
      ...actual,
      useI18n: (options?: Parameters<typeof actual.useI18n>[0]) => {
        try {
          return actual.useI18n(options)
        } catch {
          return {
            te: () => false,
            t: (key: string, params?: Record<string, unknown>) =>
              params ? `${key}:${JSON.stringify(params)}` : key,
          }
        }
      },
    }
  })
  window.history.replaceState({}, '', '/?workspace_path=%2Fworkspace')
  PlansApp = (await import('./PlansApp.vue')).default
})

beforeEach(() => {
  window.history.replaceState({}, '', '/?workspace_path=%2Fworkspace')
  state.calls.length = 0
  state.toast.mockReset()
  state.confirm.mockReset()
  state.confirm.mockResolvedValue(true)

  state.files = {
    [awaitingPath]: '<html><body>awaiting</body></html>',
    [clearPath]: '<html><body>clear</body></html>',
    [archivedPath]: '<html><body>archived</body></html>',
    [documentPath]: '# Field notes\n',
  }
  state.metas = {
    [awaitingPath]: meta({
      name: 'Awaiting me',
      overview: 'Needs a human decision',
      todos: [
        { id: 't1', content: 'Agent work', status: 'done' },
        { id: 't2', content: 'Your call', status: 'pending', owner: 'user' },
      ],
    }),
    [clearPath]: meta({
      name: 'All clear',
      todos: [
        // owner:'user' but already finished, and an unfinished todo with no
        // owner: neither counts as awaiting the user.
        { id: 't1', content: 'Your call', status: 'done', owner: 'user' },
        { id: 't2', content: 'Agent work', status: 'pending' },
      ],
    }),
    [archivedPath]: meta({
      name: 'Archived one',
      stage: 'done',
      archivedAt: '2026-01-01T00:00:00.000Z',
      todos: [{ id: 't1', content: 'Done', status: 'done' }],
    }),
    [documentPath]: null,
  }
  state.dropped = {}

  vi.stubGlobal('nav', {
    ready: vi.fn(),
    onOpenTarget: vi.fn(() => vi.fn()),
    callCapability: async (namespace: string, method: string) => {
      if (namespace === 'storage' && method === 'get') {
        return { reqId: 'storage', ok: true, result: { found: false } }
      }
      if (namespace === 'storage' && method === 'set') {
        return { reqId: 'storage', ok: true, result: null }
      }
      return { reqId: 'capability', ok: true, result: { opened: true } }
    },
    on: vi.fn(() => vi.fn()),
    callBackend: async (reqId: string, name: string, args: Record<string, unknown>) => {
      state.calls.push({ name, args })
      const relPath = String(args.rel_path ?? '')
      if (name === 'plans.list') {
        return {
          reqId,
          ok: true,
          result: Object.keys(state.files).map((path) => {
            const dropped = state.dropped[path]
            if (dropped) {
              return {
                rel_path: path,
                name: dropped.name,
                stage: 'done',
                overview: '',
                mtime: 1,
                kind: 'plan',
                meta: null,
                ...(dropped.archivedAt ? { archivedAt: dropped.archivedAt } : {}),
                ...(dropped.todos ? { todos: dropped.todos } : {}),
              }
            }
            const parsed = state.metas[path] as FixtureMeta | null
            return {
              rel_path: path,
              name: parsed?.name ?? path.split('/').pop(),
              stage: parsed?.stage ?? null,
              overview: parsed?.overview ?? '',
              mtime: 1,
              kind: parsed ? 'plan' : 'document',
              meta: parsed,
            }
          }),
        }
      }
      if (name === 'plans.read') {
        return {
          reqId,
          ok: true,
          result: {
            rel_path: relPath,
            meta: (state.metas[relPath] as FixtureMeta | null) ?? null,
            html: state.files[relPath],
            mtime: 1,
          },
        }
      }
      if (name === 'plans.read_document') {
        return { reqId, ok: true, result: { ok: true, content: state.files[relPath], mtime: 1 } }
      }
      if (name === 'plans.write_document') {
        state.files[relPath] = String(args.content)
        return { reqId, ok: true, result: { ok: true } }
      }
      return { reqId, ok: true, result: null }
    },
    cancelBackend: vi.fn(),
    subscribeBackend: () => ({ ready: Promise.resolve(), settled: Promise.resolve(), dispose: vi.fn() }),
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
})

async function mountPlans(): Promise<VueWrapper> {
  wrapper = mount(PlansApp, { global: { stubs: { SafeAiCliPanel: true } } })
  await flushPromises()
  await nextTick()
  return wrapper
}

function rowFor(view: VueWrapper, relPath: string) {
  const row = view
    .findAll('.plan-row')
    .find((candidate) => candidate.find('.plan-row-path').text() === relPath)
  if (!row) throw new Error(`no listed row for ${relPath}`)
  return row
}

async function openRowMenu(view: VueWrapper, relPath: string): Promise<void> {
  await rowFor(view, relPath).trigger('contextmenu')
  await nextTick()
}

function menuButton(view: VueWrapper, label: string) {
  const button = view
    .findAll('.context-menu button')
    .find((candidate) => candidate.text() === label)
  if (!button) {
    throw new Error(
      `no context-menu entry "${label}"; saw ${view
        .findAll('.context-menu button')
        .map((candidate) => candidate.text())
        .join(' | ')}`,
    )
  }
  return button
}

describe('Plans list surface — awaiting-you marker', () => {
  it('marks a plan whose unfinished todo is owned by the user', async () => {
    const view = await mountPlans()
    const chip = rowFor(view, awaitingPath).find('.plan-chip--awaiting')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('pane.plans.awaiting-you:{"count":1}')
  })

  it('leaves a plan unmarked when no unfinished todo is owned by the user', async () => {
    const view = await mountPlans()
    expect(rowFor(view, clearPath).find('.plan-chip--awaiting').exists()).toBe(false)
    expect(rowFor(view, documentPath).find('.plan-chip--awaiting').exists()).toBe(false)
  })

  it('counts from the list summary when an oversized entry arrives without meta', async () => {
    state.files[droppedActivePath] = '<html><body>huge</body></html>'
    state.dropped = {
      [droppedActivePath]: {
        name: 'Huge plan',
        todos: { total: 3, by_status: { pending: 2, done: 1 }, awaiting_user: 2 },
      },
    }
    const view = await mountPlans()
    const chip = rowFor(view, droppedActivePath).find('.plan-chip--awaiting')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('pane.plans.awaiting-you:{"count":2}')
  })
})

describe('Plans list surface — drag onto a CLI pane', () => {
  it('writes the plan-ref payload the terminal drop handler parses', async () => {
    const view = await mountPlans()
    const store: Record<string, string> = {}
    const dataTransfer = {
      effectAllowed: '',
      setData: (type: string, value: string) => {
        store[type] = value
      },
    }

    await rowFor(view, awaitingPath).trigger('dragstart', { dataTransfer })

    expect(Object.keys(store)).toEqual(['application/x-plan-ref'])
    expect(JSON.parse(store['application/x-plan-ref'])).toEqual({
      relPath: awaitingPath,
      name: 'Awaiting me',
      overview: 'Needs a human decision',
    })
    expect(dataTransfer.effectAllowed).toBe('copy')
  })

  it('carries a plain document with no overview', async () => {
    const view = await mountPlans()
    const store: Record<string, string> = {}
    await rowFor(view, documentPath).trigger('dragstart', {
      dataTransfer: { effectAllowed: '', setData: (type: string, value: string) => { store[type] = value } },
    })
    expect(JSON.parse(store['application/x-plan-ref'])).toEqual({
      relPath: documentPath,
      name: 'field-notes.md',
    })
  })
})

describe('Plans list surface — restored context-menu actions', () => {
  it('shares the right row to the git-tracked .plans/ directory', async () => {
    const view = await mountPlans()
    await openRowMenu(view, awaitingPath)
    await menuButton(view, 'pane.plans.share-git').trigger('click')
    await flushPromises()

    expect(callsNamed('plans.read_document')).toContainEqual({ rel_path: awaitingPath })
    expect(callsNamed('plans.write_document')).toEqual([
      { rel_path: '.plans/awaiting-me_a1b2c3.html', content: '<html><body>awaiting</body></html>' },
    ])
  })

  it('archives an unarchived plan after confirmation', async () => {
    const view = await mountPlans()
    await openRowMenu(view, awaitingPath)
    expect(menuButton(view, 'pane.plans.archive').exists()).toBe(true)
    await menuButton(view, 'pane.plans.archive').trigger('click')
    await flushPromises()

    const archives = callsNamed('plans.update_archive')
    expect(archives).toHaveLength(1)
    expect(archives[0].rel_path).toBe(awaitingPath)
    expect(typeof archives[0].archived_at).toBe('string')
    expect(state.confirm).toHaveBeenCalledTimes(1)
  })

  it('unarchives an archived plan without a confirmation prompt', async () => {
    const view = await mountPlans()
    // The Archived group ships collapsed; unfold it to reach the row.
    const archivedHead = view
      .findAll('.plans-section-head')
      .find((head) => head.text().includes('pane.plans.archived'))
    await archivedHead!.trigger('click')
    await nextTick()

    await openRowMenu(view, archivedPath)
    await menuButton(view, 'pane.plans.unarchive').trigger('click')
    await flushPromises()

    expect(callsNamed('plans.update_archive')).toEqual([
      { rel_path: archivedPath, archived_at: null },
    ])
    expect(state.confirm).not.toHaveBeenCalled()
  })

  it('promotes a plain document to a plan from its own row', async () => {
    const view = await mountPlans()
    await openRowMenu(view, documentPath)
    await menuButton(view, 'pane.plans.menu-upgrade').trigger('click')
    await flushPromises()

    expect(callsNamed('plans.promote')).toEqual([{ rel_path: documentPath }])
  })

  it('offers neither promote nor share on a row that is already a plan', async () => {
    const view = await mountPlans()
    await openRowMenu(view, awaitingPath)
    const labels = view.findAll('.context-menu button').map((button) => button.text())
    expect(labels).not.toContain('pane.plans.menu-upgrade')
    expect(labels).toContain('pane.plans.share-git')
  })
})

describe('Plans list surface — a plan whose list entry lost its meta', () => {
  beforeEach(() => {
    state.files[droppedActivePath] = '<html><body>huge done</body></html>'
    state.files[droppedArchivedPath] = '<html><body>huge archived</body></html>'
    state.dropped = {
      [droppedActivePath]: { name: 'Huge done' },
      [droppedArchivedPath]: { name: 'Huge archived', archivedAt: '2026-10-01T00:00:00.000Z' },
    }
  })

  it('stays a plan: no promote, and the archive entry archives it', async () => {
    const view = await mountPlans()
    await openRowMenu(view, droppedActivePath)
    const labels = view.findAll('.context-menu button').map((button) => button.text())
    expect(labels).not.toContain('pane.plans.menu-upgrade')
    await menuButton(view, 'pane.plans.archive').trigger('click')
    await flushPromises()

    const archives = callsNamed('plans.update_archive')
    expect(archives).toHaveLength(1)
    expect(archives[0].rel_path).toBe(droppedActivePath)
    expect(typeof archives[0].archived_at).toBe('string')
  })

  it('counts among the completed plans the bulk actions act on', async () => {
    const view = await mountPlans()
    const archiveAll = view
      .findAll('.completed-actions button')
      .find((button) => button.text() === 'pane.plans.archive-all-done')
    expect(archiveAll?.attributes('disabled')).toBeUndefined()
    await archiveAll!.trigger('click')
    await flushPromises()
    expect(callsNamed('plans.update_archive').map((call) => call.rel_path)).toContain(droppedActivePath)
    expect(callsNamed('plans.update_archive').map((call) => call.rel_path)).not.toContain(droppedArchivedPath)
  })

  it('keeps an archived one out of the active list and unarchives it from the menu', async () => {
    const view = await mountPlans()
    const listed = () => view.findAll('.plan-row').map((row) => row.find('.plan-row-path').text())
    expect(listed()).not.toContain(droppedArchivedPath)

    const archivedHead = view
      .findAll('.plans-section-head')
      .find((head) => head.text().includes('pane.plans.archived'))
    await archivedHead!.trigger('click')
    await nextTick()
    expect(listed()).toContain(droppedArchivedPath)

    await openRowMenu(view, droppedArchivedPath)
    await menuButton(view, 'pane.plans.unarchive').trigger('click')
    await flushPromises()
    expect(callsNamed('plans.update_archive')).toEqual([
      { rel_path: droppedArchivedPath, archived_at: null },
    ])
    expect(state.confirm).not.toHaveBeenCalled()
  })
})

describe('Plans list surface — sidebar hide/show', () => {
  it('hides the list and offers a control that brings it back', async () => {
    const view = await mountPlans()
    expect(view.find('.plans-sidebar').exists()).toBe(true)

    await view.find('.plans-sidebar-toggle').trigger('click')
    await nextTick()
    expect(view.find('.plans-sidebar').exists()).toBe(false)

    const show = view.find('.plans-sidebar-toggle--show')
    expect(show.exists()).toBe(true)
    await show.trigger('click')
    await nextTick()
    expect(view.find('.plans-sidebar').exists()).toBe(true)
  })
})
