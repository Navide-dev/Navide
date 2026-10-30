// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { bindPlansLocale, bootstrapPlansI18n } from './plansI18n'
import { parseHtmlPlanMeta } from './retained/usePlanHtml'

const state = vi.hoisted(() => ({
  preferences: {} as Record<string, unknown>,
  sets: [] as Array<{ key: string; value: unknown }>,
  list: [] as Array<Record<string, unknown>>,
  documents: {} as Record<string, Record<string, unknown>>,
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  subscriptionListener: null as ((payload: unknown) => void) | null,
  subscribe: vi.fn(),
  callCapability: vi.fn(),
  loadTheme: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(async () => true),
  realNotify: false,
}))

const existingPath = '.agent-team/plans/existing_a1b2c3.html'
let PlansApp: any
let wrapper: VueWrapper | null = null

beforeAll(async () => {
  vi.doMock('@navide/plugin-ui', () => ({
    SafeAiCliPanel: { name: 'SafeAiCliPanel', template: '<div data-test="ai-panel" />' },
    createAiCliSessionController: vi.fn(() => ({ dispose: vi.fn() })),
  }))
  vi.doMock('@navide/plugin-ui/foundation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@navide/plugin-ui/foundation')>()
    return {
      ...actual,
      useNotify: () => ({ ...actual.useNotify(), toast: state.toast, ...(state.realNotify ? {} : { confirm: state.confirm }) }),
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
  window.history.replaceState({}, '', `/?workspace_path=%2Fworkspace&rel_path=${encodeURIComponent(existingPath)}`)
  PlansApp = (await import('./PlansApp.vue')).default
  // Imports the whole PlansApp graph once; under a full parallel run the
  // 10s hook default is on the edge and collects the file as failed.
}, 30_000)

beforeEach(() => {
  state.realNotify = false
  window.history.replaceState({}, '', `/?workspace_path=%2Fworkspace&rel_path=${encodeURIComponent(existingPath)}`)
  state.preferences = {}
  state.sets.length = 0
  state.calls.length = 0
  state.subscriptionListener = null
  state.subscribe.mockImplementation((event: string, listener: (payload: unknown) => void) => {
    expect(event).toBe('plans.changed')
    const previous = state.subscriptionListener
    state.subscriptionListener = payload => { previous?.(payload); listener(payload) }
    return {
      ready: Promise.resolve(),
      settled: Promise.resolve(),
      dispose: vi.fn(),
    }
  })
  vi.stubGlobal('nav', {
    ready: vi.fn(),
    onOpenTarget: vi.fn(() => vi.fn()),
    callCapability: async (namespace: string, method: string, args: Record<string, unknown>) => {
      if (namespace === 'storage' && method === 'get') {
        const key = String(args.key)
        return {
          reqId: 'storage',
          ok: true,
          result: {
            found: Object.prototype.hasOwnProperty.call(state.preferences, key),
            ...(Object.prototype.hasOwnProperty.call(state.preferences, key)
              ? { value: state.preferences[key] }
              : {}),
          },
        }
      }
      if (namespace === 'storage' && method === 'set') {
        const key = String(args.key)
        state.sets.push({ key, value: args.value })
        state.preferences[key] = args.value
        return { reqId: 'storage', ok: true, result: null }
      }
      return { reqId: 'capability', ok: true, result: await state.callCapability(namespace, method, args) }
    },
    on: vi.fn(() => vi.fn()),
    callBackend: async (reqId: string, name: string, args: Record<string, unknown>) => {
      state.calls.push({ name, args })
      if (name === 'plans.list') return { reqId, ok: true, result: state.list }
      if (name === 'plans.read') {
        return { reqId, ok: true, result: state.documents[String(args.rel_path)] }
      }
      if (name === 'plans.read_document') {
        const document = state.documents[String(args.rel_path)]
        return { reqId, ok: true, result: {
          ok: true,
          content: document?.raw ?? `<script id="plan-meta" type="application/json">${JSON.stringify(document?.meta)}</script>${document?.html ?? ''}`,
          mtime: 1,
        } }
      }
      if (name === 'plans.write_document') {
        const document = state.documents[String(args.rel_path)]
        const content = String(args.content)
        document.raw = content
        document.html = content
        document.meta = parseHtmlPlanMeta(content)?.meta
        return { reqId, ok: true, result: { ok: true } }
      }
      if (name.startsWith('plans.review_note_')) {
        const relPath = String(args.rel_path)
        const meta = state.documents[relPath]?.meta as { reviewNotes: Array<Record<string, unknown>> }
        const notes = meta.reviewNotes
        if (name === 'plans.review_note_add') {
          const note = { id: `n${notes.length + 1}`, author: 'user', text: String(args.text), resolved: false, reply: '', anchor: String(args.anchor ?? '') }
          notes.push(note)
          return { reqId, ok: true, result: note }
        }
        const note = notes.find((item) => item.id === args.note_id)
        if (name === 'plans.review_note_delete') {
          meta.reviewNotes = notes.filter(item => item.id !== args.note_id)
          return { reqId, ok: true, result: null }
        }
        const result = name === 'plans.review_note_edit'
          ? { ...note, text: String(args.text) }
          : { ...note, resolved: true }
        if (note) Object.assign(note, result)
        return { reqId, ok: true, result }
      }
      if (name === 'plans.create') {
        const relPath = '.agent-team/plans/new-plan_a1b2c3.html'
        state.list = [...state.list, {
          rel_path: relPath,
          name: String(args.name),
          stage: 'draft',
          meta: {
            schemaVersion: 1,
            name: String(args.name),
            overview: String(args.overview),
            stage: 'draft',
            todos: [],
            reviewNotes: [],
          },
        }]
        state.documents[relPath] = {
          rel_path: relPath,
          meta: state.list.at(-1)?.meta ?? null,
          html: '<html />',
        }
        return { reqId, ok: true, result: { rel_path: relPath } }
      }
      if (name === 'plans.rename') {
        const from = String(args.from)
        const to = String(args.to)
        const item = state.list.find((plan) => plan.rel_path === from)
        if (item) {
          item.rel_path = to
          state.documents[to] = state.documents[from]
          delete state.documents[from]
        }
        return { reqId, ok: true, result: { to } }
      }
      if (name === 'plans.delete') {
        const relPath = String(args.rel_path)
        state.list = state.list.filter((plan) => plan.rel_path !== relPath)
        delete state.documents[relPath]
        return { reqId, ok: true, result: null }
      }
      return { reqId, ok: true, result: null }
    },
    cancelBackend: vi.fn(),
    subscribeBackend: (event: string, listener: (payload: unknown) => void) =>
      state.subscribe(event, listener),
  })
  state.callCapability.mockReset()
  state.callCapability.mockResolvedValue({ opened: true })
  state.confirm.mockReset()
  state.confirm.mockResolvedValue(true)
  state.list = [{
    rel_path: existingPath,
    name: 'Existing plan',
    stage: 'approved',
    meta: {
      schemaVersion: 1,
      name: 'Existing plan',
      overview: 'Existing overview',
      stage: 'approved',
      todos: [],
      reviewNotes: [],
    },
  }]
  state.documents = {
    [existingPath]: {
      rel_path: existingPath,
      meta: state.list[0].meta,
      html: '<html />',
    },
  }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
})

async function mountPlans(options: Parameters<typeof mount>[1] = {}): Promise<VueWrapper> {
  const { global: globalOptions, ...rest } = options
  wrapper = mount(PlansApp, {
    ...rest,
    global: {
      stubs: { SafeAiCliPanel: true },
      ...globalOptions,
    },
  })
  await flushPromises()
  await nextTick()
  return wrapper
}

async function openToolbarOverflow(view: VueWrapper): Promise<void> {
  await view.get('[data-test="review-notes-overflow"]').trigger('click')
  await nextTick()
}

describe('PlansApp', () => {
  function reviewFixture(): void {
    Object.assign(state.list[0].meta as object, { stage: 'in-review', reviewNotes: [
      { id: 'n1', author: 'user', text: 'Please clarify', resolved: false, reply: '', anchor: 'Scope' },
      { id: 'n2', author: 'agent', text: 'Addressed', resolved: true, reply: 'Done' },
    ] })
    state.documents[existingPath].html = '<html><body><section><h2>Scope</h2><p>Body</p></section></body></html>'
  }

  it('opens the requested plan when the Host hands over a Windows backslash rel_path', async () => {
    window.history.replaceState({}, '', `/?workspace_path=C%3A%5Cws&rel_path=${encodeURIComponent(existingPath.replace(/\//g, '\\'))}`)
    await mountPlans()
    expect(state.calls.some((call) => call.name.startsWith('plans.read') && call.args.rel_path === existingPath)).toBe(true)
  })

  it('opens a backslash rel_path handed to an already open window', async () => {
    state.list.push({ ...state.list[0], rel_path: '.agent-team/plans/other_d4e5f6.html', name: 'Other plan' })
    state.documents['.agent-team/plans/other_d4e5f6.html'] = { ...state.documents[existingPath], rel_path: '.agent-team/plans/other_d4e5f6.html' }
    let deliver: ((target: Record<string, string>) => void) | undefined
    ;(globalThis as any).nav.onOpenTarget = vi.fn((listener: (target: Record<string, string>) => void) => { deliver = listener; return vi.fn() })
    await mountPlans()
    state.calls.length = 0
    deliver?.({ rel_path: '.agent-team\\plans\\other_d4e5f6.html' })
    await flushPromises()
    expect(state.calls.some((call) => call.name.startsWith('plans.read') && call.args.rel_path === '.agent-team/plans/other_d4e5f6.html')).toBe(true)
  })

  it('parity: real Notes click opens the v1 panel inside the toolbar immediately above preview', async () => {
    reviewFixture()
    const view = await mountPlans({ attachTo: document.body })
    expect(view.find('.prt-panel').exists()).toBe(false)
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    const panel = view.get('.prt-panel')
    expect(panel.element.parentElement).toBe(view.get('.prt').element)
    expect(panel.findAll('.prt-note')).toHaveLength(2)
    expect(view.get('.prt').element.nextElementSibling).toBe(view.get('.plan-main-body').element)
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    expect(view.find('.prt-panel').exists()).toBe(false)
  })

  it('parity: real Edit enables and focuses the input and Save calls the immutable target exactly once', async () => {
    reviewFixture()
    const view = await mountPlans({ attachTo: document.body })
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    const edit = view.get('[data-test="edit-n1"]')
    expect(edit.attributes('disabled')).toBeUndefined()
    await edit.trigger('click')
    const input = view.get('[data-test="review-note-edit-input"]')
    expect(input.attributes('disabled')).toBeUndefined()
    expect(document.activeElement).toBe(input.element)
    await input.setValue('Clarified')
    await view.get('[data-test="review-note-edit-save"]').trigger('click')
    await flushPromises()
    expect(state.calls.filter(call => call.name === 'plans.review_note_edit')).toEqual([
      { name: 'plans.review_note_edit', args: { rel_path: existingPath, note_id: 'n1', text: 'Clarified' } },
    ])
    expect(view.get('[data-test="edit-n1"]').attributes('disabled')).toBeUndefined()
  })

  it('parity: section comment refocuses an already open composer and retains the authenticated anchor', async () => {
    reviewFixture()
    const view = await mountPlans({ attachTo: document.body })
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    const button = view.get('[data-test="review-notes-toggle"]')
    ;(button.element as HTMLButtonElement).focus()
    const frame = view.get('iframe').element as HTMLIFrameElement
    const postMessage = vi.fn()
    const source = { postMessage } as unknown as Window
    Object.defineProperty(frame, 'contentWindow', { value: source, configurable: true })
    const documentToken = frame.getAttribute('srcdoc')?.match(/var documentToken = "([0-9a-f]{32})"/)?.[1]
    expect(documentToken).toBeTruthy()
    window.dispatchEvent(new MessageEvent('message', { source, data: { type: 'section-comment', anchor: 'Scope', documentToken } }))
    await flushPromises()
    const input = view.get('[data-test="review-note-input"]')
    expect(view.get('.prt-note-anchor--pending').text()).toContain('Scope')
    expect(document.activeElement).toBe(input.element)
    await input.setValue('Anchored comment')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(state.calls.filter(call => call.name === 'plans.review_note_add')).toEqual([
      { name: 'plans.review_note_add', args: { rel_path: existingPath, text: 'Anchored comment', anchor: 'Scope' } },
    ])
    expect(view.get('iframe').element).toBe(frame)
    expect(postMessage).toHaveBeenCalledWith({
      type: 'review-note-anchors-updated', documentToken, anchors: { Scope: 2 },
    }, '*')
  })

  it('parity: toolbar retains v1 stage badge, Todos and disabled Approve controls', async () => {
    reviewFixture()
    const view = await mountPlans()
    expect(view.get('.prt-stage').element.tagName).toBe('SPAN')
    expect(view.find('.prt-bar .prt-todos-btn').exists()).toBe(true)
    expect(view.get('.prt-bar .prt-approve').attributes('disabled')).toBeDefined()
  })

  it('parity: actual application confirmation Escape cancels only the dialog and Enter deletes once', async () => {
    reviewFixture()
    state.realNotify = true
    const view = await mountPlans({ attachTo: document.body })
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    await view.get('[data-test="delete-n1"]').trigger('click')
    await flushPromises()
    const modal = document.querySelector('.modal')!
    expect(modal).not.toBeNull()
    expect(state.calls.filter(call => call.name === 'plans.review_note_delete')).toHaveLength(0)
    modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('.modal')).toBeNull()
    expect(view.find('.prt-note').exists()).toBe(true)
    await view.get('[data-test="delete-n1"]').trigger('click')
    await flushPromises()
    document.querySelector('.modal')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(state.calls.filter(call => call.name === 'plans.review_note_delete')).toEqual([
      { name: 'plans.review_note_delete', args: { rel_path: existingPath, note_id: 'n1' } },
    ])
    expect(view.find('[data-test="delete-n1"]').exists()).toBe(false)
    expect(view.get('[data-test="review-note-input"]').attributes('disabled')).toBeUndefined()
  })

  it('parity: real outline control navigates the current iframe and scroll reports keep its identity', async () => {
    reviewFixture()
    const view = await mountPlans({ attachTo: document.body })
    const frame = view.get('iframe').element as HTMLIFrameElement
    const postMessage = vi.fn()
    const source = { postMessage } as unknown as Window
    Object.defineProperty(frame, 'contentWindow', { value: source, configurable: true })
    await openToolbarOverflow(view)
    await view.get('.prt-menu-outline').trigger('click')
    await view.get('.prt-menu-anchor').trigger('click')
    expect(postMessage).toHaveBeenCalledWith({ type: 'scroll-to', anchor: 'Scope' }, '*')
    const srcdoc = frame.getAttribute('srcdoc')!
    const documentToken = srcdoc.match(/var documentToken = "([0-9a-f]{32})"/)?.[1]
    window.dispatchEvent(new MessageEvent('message', { source, data: { type: 'scroll-pos', y: 320, documentToken } }))
    await flushPromises()
    expect(view.get('iframe').element).toBe(frame)
    expect(frame.getAttribute('srcdoc')).toBe(srcdoc)
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    window.dispatchEvent(new MessageEvent('message', { source, data: { type: 'section-editing', active: true, documentToken } }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(postMessage).toHaveBeenCalledWith({ type: 'cancel-edit' }, '*')
    expect(view.find('.prt-note').exists()).toBe(true)
  })

  it('parity: real history Preview opens the retained read-only snapshot and Close returns to the plan', async () => {
    reviewFixture()
    const original = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === 'plans.list_directory') return { reqId, ok: true, result: { ok: true, entries: [{ name: '20260905T010203_draft.html', is_dir: false }] } }
      if (name === 'plans.read_document' && String(args.rel_path).includes('/.history/')) return { reqId, ok: true, result: { ok: true, content: `<html><body><script id="plan-meta" type="application/json">${JSON.stringify({ schemaVersion: 1, name: 'Snapshot', stage: 'draft', todos: [], reviewNotes: [{ id: 's1', author: 'user', text: 'One', resolved: false, anchor: 'Snapshot scope' }, { id: 's2', author: 'user', text: 'Two', resolved: false, anchor: 'Snapshot scope' }] })}</script><h2>Snapshot scope</h2><p>Earlier snapshot</p></body></html>`, mtime: 1 } }
      return original(reqId, name, args)
    }
    const view = await mountPlans({ attachTo: document.body })
    await openToolbarOverflow(view)
    await view.get('.prt-history-btn').trigger('click')
    await flushPromises()
    await view.get('.prt-history-action').trigger('click')
    await flushPromises()
    expect(view.get('.plan-snapshot-note').text()).toBe('pane.plans.snapshot-readonly')
    expect(view.find('.prt').exists()).toBe(false)
    expect(view.get('iframe').attributes('srcdoc')).toContain('Earlier snapshot')
    const snapshotInit = JSON.parse(view.get('iframe').attributes('srcdoc')!.match(/var INIT = (\{[^\n]+\});/)![1])
    expect(snapshotInit.anchors).toEqual({ 'Snapshot scope': 2 })
    await view.get('.plan-snapshot-close').trigger('click')
    await flushPromises()
    expect(view.find('.plan-snapshot-banner').exists()).toBe(false)
    expect(view.find('.prt').exists()).toBe(true)
    expect(view.get('iframe').attributes('srcdoc')).toContain('<h2>Scope</h2>')
    const liveInit = JSON.parse(view.get('iframe').attributes('srcdoc')!.match(/var INIT = (\{[^\n]+\});/)![1])
    expect(liveInit.anchors).toEqual({ Scope: 1 })
  })

  it('parity: failed document read replaces the old iframe with the retained reason and resolved path', async () => {
    reviewFixture()
    const pathB = '.agent-team/plans/missing.html'
    state.list.push({ rel_path: pathB, name: 'Missing plan' })
    const original = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === 'plans.read' && args.rel_path === pathB) return { reqId, ok: false, error: { code: 'BACKEND_ERROR', message: 'missing' } }
      return original(reqId, name, args)
    }
    const view = await mountPlans({ attachTo: document.body })
    await view.findAll('.plan-row').find(row => row.text().includes('Missing plan'))!.trigger('click')
    await flushPromises()
    expect(view.find('iframe').exists()).toBe(false)
    expect(view.get('.pdp-error').text()).toContain('pane.plans.doc-load-failed')
    expect(view.get('.pdp-error-reason').text()).toBe('missing')
    expect(view.get('.pdp-error-path').text()).toBe(`/workspace › ${pathB}`)
    await view.findAll('.plan-row').find(row => row.text().includes('Existing plan'))!.trigger('click')
    await flushPromises()
    expect(view.find('.pdp-error').exists()).toBe(false)
    expect(view.find('iframe').exists()).toBe(true)
  })

  it('lists a document the backend could not fully read, with its reason, and explains the failed open', async () => {
    reviewFixture()
    const pathB = '.agent-team/plans/huge.html'
    state.list.push({
      rel_path: pathB, name: 'huge.html', kind: 'unreadable', meta: null,
      reason: 'too large for this version of Navide to read (RESULT_TOO_LARGE)',
    })
    const original = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === 'plans.read' && args.rel_path === pathB) return { reqId, ok: false, error: { code: 'BACKEND_ERROR', message: 'nope' } }
      return original(reqId, name, args)
    }
    const view = await mountPlans({ attachTo: document.body })
    const row = view.findAll('.plan-row').find(candidate => candidate.text().includes('huge.html'))!
    expect(row.get('.plan-chip--problem').attributes('title')).toContain('RESULT_TOO_LARGE')
    // A healthy plan carries no such chip.
    expect(view.findAll('.plan-row').find(candidate => candidate.text().includes('Existing plan'))!.find('.plan-chip--problem').exists()).toBe(false)
    await row.trigger('click')
    await flushPromises()
    expect(view.get('.pdp-error-reason').text()).toBe('too large for this version of Navide to read (RESULT_TOO_LARGE) — nope')
  })

  it('opens a document the backend returns page by page as one preview', async () => {
    reviewFixture()
    const pathB = '.agent-team/plans/paged.html'
    state.list.push({ rel_path: pathB, name: 'Paged plan' })
    const meta = { schemaVersion: 1, name: 'Paged plan', stage: 'draft', todos: [], reviewNotes: [] }
    const original = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === 'plans.read' && args.rel_path === pathB) {
        state.calls.push({ name, args })
        return { reqId, ok: true, result: args.offset === undefined
          ? { rel_path: pathB, meta, html: '<html><body><h2>Part one</h2>', mtime: 3, size: 60, offset: 0, eof: false, next_offset: 30 }
          : { rel_path: pathB, html: '<p>Part two</p></body></html>', mtime: 3, size: 60, offset: 30, eof: true } }
      }
      return original(reqId, name, args)
    }
    const view = await mountPlans({ attachTo: document.body })
    await view.findAll('.plan-row').find(row => row.text().includes('Paged plan'))!.trigger('click')
    await flushPromises()
    const srcdoc = view.get('iframe').attributes('srcdoc')!
    expect(srcdoc).toContain('Part one')
    expect(srcdoc).toContain('Part two')
    expect(state.calls.filter(({ name, args }) => name === 'plans.read' && args.rel_path === pathB).map(({ args }) => args.offset))
      .toEqual([undefined, 30])
  })

  it('parity: a real plans.changed broadcast after todo status persistence does not reload the preview', async () => {
    reviewFixture()
    ;(state.documents[existingPath].meta as any).todos = [{ id: 't1', content: 'Task', status: 'pending' }]
    state.documents[existingPath].html = '<html><body><section><h2>Scope</h2><ul class="todos"><li data-todo-id="t1" data-status="pending"><span class="st">pending</span>Task</li></ul></section></body></html>'
    const view = await mountPlans({ attachTo: document.body })
    const frame = view.get('iframe').element as HTMLIFrameElement
    const srcdoc = frame.getAttribute('srcdoc')
    const postMessage = vi.fn()
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage }, configurable: true })
    ;(state.documents[existingPath].meta as any).todos[0].status = 'done'
    state.documents[existingPath].html = String(state.documents[existingPath].html).replaceAll('pending', 'done')
    state.subscriptionListener?.({ workspace_path: '/workspace' })
    await flushPromises()
    expect(view.get('iframe').element).toBe(frame)
    expect(frame.getAttribute('srcdoc')).toBe(srcdoc)
    expect(view.get('.prt-progress').text()).toContain('"done":1')
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'todo-status-updated', todoId: 't1', status: 'done' }), '*')
  })

  it('parity: iframe runtime starts with the retained unresolved anchor counts', async () => {
    reviewFixture()
    const view = await mountPlans()
    const init = JSON.parse(view.get('iframe').attributes('srcdoc')!.match(/var INIT = (\{[^\n]+\});/)![1])
    expect(init.anchors).toEqual({ Scope: 1 })
  })

  it.each([
    ['pending', false, 'in-progress'], ['in-progress', false, 'done'], ['done', false, 'pending'],
    ['pending', true, 'skipped'], ['skipped', true, 'pending'],
  ])('parity: iframe todo %s with alt=%s persists v1 status %s without reloading', async (status, alt, expected) => {
    reviewFixture()
    ;(state.documents[existingPath].meta as any).todos = [{ id: 't1', content: 'Task', status }]
    const view = await mountPlans({ attachTo: document.body })
    const frame = view.get('iframe').element as HTMLIFrameElement
    const source = { postMessage: vi.fn() } as unknown as Window
    Object.defineProperty(frame, 'contentWindow', { value: source, configurable: true })
    const documentToken = frame.getAttribute('srcdoc')?.match(/var documentToken = "([0-9a-f]{32})"/)?.[1]
    window.dispatchEvent(new MessageEvent('message', { source, data: { type: 'todo-clicked', todoId: 't1', alt, documentToken } }))
    await flushPromises()
    expect(state.calls.filter(call => call.name === 'plans.update_todo')).toEqual([
      { name: 'plans.update_todo', args: { rel_path: existingPath, todo_id: 't1', status: expected } },
    ])
    expect(view.get('iframe').element).toBe(frame)
  })

  it('parity: real toolbar Todo cycle updates its status without reloading the preview', async () => {
    reviewFixture()
    ;(state.documents[existingPath].meta as any).todos = [{ id: 't1', content: 'Task', status: 'pending' }]
    state.documents[existingPath].html = '<html><body><section><h2>Scope</h2><ul class="todos"><li data-todo-id="t1" data-status="pending"><span class="st">pending</span>Task</li></ul></section></body></html>'
    const view = await mountPlans({ attachTo: document.body })
    const frame = view.get('iframe').element
    await view.get('.prt-todos-btn').trigger('click')
    await view.get('.prt-todo').trigger('click')
    await flushPromises()
    expect(view.get('.prt-todo-status').text()).toBe('in-progress')
    expect(view.get('iframe').element).toBe(frame)
  })

  it('parity: same-plan external body reload clears iframe editing before Escape reaches the toolbar', async () => {
    reviewFixture()
    const view = await mountPlans({ attachTo: document.body })
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    const frame = view.get('iframe').element as HTMLIFrameElement
    const source = { postMessage: vi.fn() } as unknown as Window
    Object.defineProperty(frame, 'contentWindow', { value: source, configurable: true })
    const documentToken = frame.getAttribute('srcdoc')?.match(/var documentToken = "([0-9a-f]{32})"/)?.[1]
    window.dispatchEvent(new MessageEvent('message', { source, data: { type: 'section-editing', active: true, documentToken } }))
    state.documents[existingPath].html = '<html><body><section><h2>Scope</h2><p>External body update</p></section></body></html>'
    state.subscriptionListener?.({ workspace_path: '/workspace' })
    await flushPromises()
    expect(view.get('iframe').element).not.toBe(frame)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(view.find('.prt-note').exists()).toBe(false)
  })

  it.each(['add', 'edit'])('parity: failed %s returns to idle and retains the draft for retry', async operation => {
    reviewFixture()
    const original = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === `plans.review_note_${operation}`) return { reqId, ok: false, error: { code: 'CONFLICT', message: 'Concurrent write conflict' } }
      return original(reqId, name, args)
    }
    const view = await mountPlans({ attachTo: document.body })
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    if (operation === 'edit') await view.get('[data-test="edit-n1"]').trigger('click')
    const input = view.get(operation === 'edit' ? '[data-test="review-note-edit-input"]' : '[data-test="review-note-input"]')
    await input.setValue('Retry me')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect((input.element as HTMLInputElement).value).toBe('Retry me')
    expect(input.attributes('disabled')).toBeUndefined()
    const send = operation === 'edit' ? view.get('[data-test="review-note-edit-save"]') : view.get('.prt-new .prt-send')
    expect(send.attributes('disabled')).toBeUndefined()
    expect(state.toast).toHaveBeenCalled()
  })

  it.each(['add', 'edit'])('parity: committed %s clears its draft even when the followup metadata read fails', async operation => {
    reviewFixture()
    const original = (window as any).nav.callBackend
    let committed = false
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (committed && name === 'plans.read_document') return { reqId, ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'Refresh unavailable' } }
      const result = await original(reqId, name, args)
      if (name === `plans.review_note_${operation}`) committed = true
      return result
    }
    const onError = vi.fn()
    const view = await mountPlans({ attachTo: document.body, global: { config: { errorHandler: onError } } })
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    if (operation === 'edit') await view.get('[data-test="edit-n1"]').trigger('click')
    await view.get(operation === 'edit' ? '[data-test="review-note-edit-input"]' : '[data-test="review-note-input"]').setValue('Committed text')
    await view.get(operation === 'edit' ? '[data-test="review-note-edit-save"]' : '.prt-new .prt-send').trigger('click')
    await flushPromises()
    expect(state.calls.filter(call => call.name === `plans.review_note_${operation}`)).toHaveLength(1)
    expect(view.find('[data-test="review-note-edit-input"]').exists()).toBe(false)
    expect((view.get('[data-test="review-note-input"]').element as HTMLInputElement).value).toBe('')
    expect(view.get('[data-test="edit-n1"]').attributes('disabled')).toBeUndefined()
    expect(onError).not.toHaveBeenCalled()
  })

  it.each(['add', 'edit'])('parity: delayed %s response from A cannot replace B drafts or pending state', async operation => {
    reviewFixture()
    const pathB = '.agent-team/plans/other.html'
    const meta = { ...(state.list[0].meta as object), name: 'Other plan', reviewNotes: [{ id: 'n1', author: 'user', text: 'B note', resolved: false, reply: '' }] }
    state.list.push({ rel_path: pathB, name: 'Other plan', meta })
    state.documents[pathB] = { rel_path: pathB, meta, html: '<html><body>Other</body></html>' }
    const original = (window as any).nav.callBackend
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === `plans.review_note_${operation}` && args.rel_path === existingPath) await pending
      return original(reqId, name, args)
    }
    const view = await mountPlans({ attachTo: document.body })
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    if (operation === 'edit') await view.get('[data-test="edit-n1"]').trigger('click')
    const input = view.get(operation === 'edit' ? '[data-test="review-note-edit-input"]' : '[data-test="review-note-input"]')
    await input.setValue('A write')
    await input.trigger('keydown', { key: 'Enter' })
    await view.findAll('.plan-row').find(row => row.text().includes('Other plan'))!.trigger('click')
    await flushPromises()
    expect(view.find('.prt-panel').exists()).toBe(false)
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    expect(view.find('[data-test="review-note-edit-input"]').exists()).toBe(false)
    expect(view.find('.prt-note-anchor--pending').exists()).toBe(false)
    const composer = view.get('[data-test="review-note-input"]')
    expect((composer.element as HTMLInputElement).value).toBe('')
    await composer.setValue('B draft')
    finish()
    await flushPromises()
    expect((composer.element as HTMLInputElement).value).toBe('B draft')
    expect(view.get('.prt-note-text').text()).toBe('B note')
    expect(view.get('[data-test="edit-n1"]').attributes('disabled')).toBeUndefined()
    expect(state.calls.filter(call => call.name === `plans.review_note_${operation}`)).toEqual([
      { name: `plans.review_note_${operation}`, args: operation === 'edit' ? { rel_path: existingPath, note_id: 'n1', text: 'A write' } : { rel_path: existingPath, text: 'A write', anchor: '' } },
    ])
  })

  it('parity: delayed Delete confirmation cannot delete a same-id note after switching plans', async () => {
    reviewFixture()
    const pathB = '.agent-team/plans/other.html'
    const meta = { ...(state.list[0].meta as object), name: 'Other plan' }
    state.list.push({ rel_path: pathB, name: 'Other plan', meta })
    state.documents[pathB] = { rel_path: pathB, meta, html: '<html><body>Other</body></html>' }
    let settle!: (accepted: boolean) => void
    state.confirm.mockImplementationOnce(() => new Promise<boolean>(resolve => { settle = resolve }))
    const view = await mountPlans({ attachTo: document.body })
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    await view.get('[data-test="delete-n1"]').trigger('click')
    expect(state.confirm).toHaveBeenCalledTimes(1)
    expect(state.calls.filter(call => call.name === 'plans.review_note_delete')).toHaveLength(0)
    await view.findAll('.plan-row').find(row => row.text().includes('Other plan'))!.trigger('click')
    await flushPromises()
    settle(true)
    await flushPromises()
    expect(state.calls.filter(call => call.name === 'plans.review_note_delete')).toHaveLength(0)
  })

  it.each(['resolved', 'empty'])('parity: %s notes appear only in overflow and toggle the real panel', async kind => {
    reviewFixture()
    const meta = state.list[0].meta as { reviewNotes: Array<{ resolved: boolean }> }
    meta.reviewNotes = kind === 'empty' ? [] : meta.reviewNotes.map(note => ({ ...note, resolved: true }))
    const view = await mountPlans({ attachTo: document.body })
    expect(view.find('[data-test="review-notes-toggle"]').exists()).toBe(false)
    await openToolbarOverflow(view)
    expect(view.findAll('.prt-notes-btn')).toHaveLength(1)
    await view.get('[data-test="review-notes-overflow-item"]').trigger('click')
    expect(view.find('.prt-panel').exists()).toBe(true)
    expect(view.find('.prt-menu-backdrop').exists()).toBe(false)
    await openToolbarOverflow(view)
    await view.get('[data-test="review-notes-overflow-item"]').trigger('click')
    expect(view.find('.prt-panel').exists()).toBe(false)
  })

  it('parity: IME Enter does not send and ordinary Enter sends once then returns idle', async () => {
    reviewFixture()
    const view = await mountPlans({ attachTo: document.body })
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    const input = view.get('[data-test="review-note-input"]')
    await input.setValue('New note')
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    expect(state.calls.filter(call => call.name === 'plans.review_note_add')).toHaveLength(0)
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(state.calls.filter(call => call.name === 'plans.review_note_add')).toHaveLength(1)
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(input.attributes('disabled')).toBeUndefined()
    expect(view.get('[data-test="edit-n1"]').attributes('disabled')).toBeUndefined()
  })

  it('parity: Escape peels edit, composer, then the existing panel', async () => {
    reviewFixture()
    const view = await mountPlans({ attachTo: document.body })
    await view.get('[data-test="review-notes-toggle"]').trigger('click')
    await view.get('[data-test="review-note-input"]').setValue('Draft')
    await view.get('[data-test="edit-n1"]').trigger('click')
    await view.get('[data-test="review-note-edit-input"]').trigger('keydown', { key: 'Escape' })
    expect(view.find('[data-test="review-note-edit-input"]').exists()).toBe(false)
    expect((view.get('[data-test="review-note-input"]').element as HTMLInputElement).value).toBe('Draft')
    await view.get('[data-test="review-note-input"]').trigger('keydown', { key: 'Escape' })
    expect((view.get('[data-test="review-note-input"]').element as HTMLInputElement).value).toBe('')
    await view.get('[data-test="review-note-input"]').trigger('keydown', { key: 'Escape' })
    expect(view.find('.prt-panel').exists()).toBe(false)
  })

  it.each(['wrong-source', 'null-source', 'stale-window', 'stale-token', 'unknown-anchor', 'token-alias', 'nonce-alias'])(
    'parity: rejects section-comment with %s before opening the composer', async kind => {
      reviewFixture()
      const view = await mountPlans({ attachTo: document.body })
      const frame = view.get('iframe').element as HTMLIFrameElement
      const source = {} as Window
      Object.defineProperty(frame, 'contentWindow', { value: source, configurable: true })
      const documentToken = frame.getAttribute('srcdoc')?.match(/var documentToken = "([0-9a-f]{32})"/)?.[1]
      expect(documentToken).toBeTruthy()
      const data: Record<string, unknown> = { type: 'section-comment', anchor: kind === 'unknown-anchor' ? 'Unknown' : 'Scope', documentToken: kind === 'stale-token' ? 'stale' : documentToken }
      if (kind.endsWith('-alias')) { delete data.documentToken; data[kind.split('-')[0]] = documentToken }
      const eventSource = kind === 'wrong-source' ? window : kind === 'null-source' ? null : kind === 'stale-window' ? {} as Window : source
      window.dispatchEvent(new MessageEvent('message', { source: eventSource, data }))
      await flushPromises()
      expect(view.find('.prt-panel').exists()).toBe(false)
      expect(state.calls.filter(call => call.name.startsWith('plans.review_note_'))).toHaveLength(0)
    },
  )

  it('uses the v1-equivalent window hierarchy outside the left contribution', async () => {
    const view = await mountPlans()

    expect(view.find('.plan-window').exists()).toBe(true)
    expect(view.find('.plan-window-side').exists()).toBe(true)
    expect(view.find('.plan-window-main').exists()).toBe(true)
    expect(view.find('.plans-surface').exists()).toBe(false)
    expect(view.find('.plans-layout').exists()).toBe(false)
  })

  it('renders the normal plugin surface as the v1 Plans window without v2 sidebar chrome', async () => {
    const view = await mountPlans()

    expect(view.find('.plan-window > .plan-window-side > .plans-pane').exists()).toBe(true)
    expect(view.find('.plan-window > .plan-window-main > .plan-window-doc').exists()).toBe(true)
    expect(view.find('.plan-window-doc > .prt > .prt-bar').exists()).toBe(true)
    expect(view.find('.plan-window-doc > .plan-main-body').exists()).toBe(true)
    expect(view.find('.sidebar-create-section').exists()).toBe(false)
    expect(view.find('.plans-head-actions').exists()).toBe(false)
  })

  it('keeps the embedded left contribution in its original Plans layout without window classes', async () => {
    window.history.replaceState({}, '', '/?workspace_path=%2Fworkspace&contribution=left')

    const view = await mountPlans()

    expect(view.find('.plans-surface.plans-left-surface').exists()).toBe(true)
    expect(view.find('.plans-layout.is-left-contribution').exists()).toBe(true)
    expect(view.find('.plans-sidebar').exists()).toBe(true)
    expect(view.find('.plan-window').exists()).toBe(false)
    expect(view.find('.plan-window-side').exists()).toBe(false)
    expect(view.find('.plan-window-main').exists()).toBe(false)
  })

  it('renders translated Chinese Plans strings on first mount when bootstrapped with locale=zh-TW', async () => {
    window.history.replaceState(
      {},
      '',
      `/?workspace_path=%2Fworkspace&locale=zh-TW&rel_path=${encodeURIComponent(existingPath)}`,
    )
    const realI18n = createI18n({
      legacy: false,
      locale: 'en-US',
      fallbackLocale: 'zh-TW',
      messages: {
        'en-US': {
          action: {
            'open-in-editor': 'Open in Editor',
            'copy-path': 'Copy Path',
            create: 'Create',
            rename: 'Rename',
            delete: 'Delete',
            cancel: 'Cancel',
          },
        },
        'zh-TW': {
          action: {
            'open-in-editor': '在編輯器中開啟',
            'copy-path': '複製路徑',
            create: '建立',
            rename: '重新命名',
            delete: '刪除',
            cancel: '取消',
          },
        },
      },
    })
    bootstrapPlansI18n(realI18n, window.location.search)

    const view = await mountPlans({
      global: {
        plugins: [realI18n],
      },
    })

    expect(view.text()).not.toContain('新增計畫')
    expect(view.text()).toContain('所有文件')
    await view.get('[data-test="review-notes-overflow"]').trigger('click')
    expect(view.text()).toContain('審查留言')
    expect(view.text()).not.toContain('pane.plans.v2.new-plan')
    expect(view.text()).not.toContain('pane.plans.review-notes')
  })

  it('renders translated English Plans strings on first mount when bootstrapped with locale=en-US while default is zh-TW before any host event', async () => {
    window.history.replaceState(
      {},
      '',
      `/?workspace_path=%2Fworkspace&locale=en-US&rel_path=${encodeURIComponent(existingPath)}`,
    )
    const realI18n = createI18n({
      legacy: false,
      locale: 'zh-TW',
      fallbackLocale: 'zh-TW',
      messages: {
        'en-US': {
          action: {
            'open-in-editor': 'Open in Editor',
            'copy-path': 'Copy Path',
            create: 'Create',
            rename: 'Rename',
            delete: 'Delete',
            cancel: 'Cancel',
          },
        },
        'zh-TW': {
          action: {
            'open-in-editor': '在編輯器中開啟',
            'copy-path': '複製路徑',
            create: '建立',
            rename: '重新命名',
            delete: '刪除',
            cancel: '取消',
          },
        },
      },
    })
    bootstrapPlansI18n(realI18n, window.location.search)
    let hostEventListener: ((payload: unknown) => void) | null = null
    bindPlansLocale(realI18n, (_event, listener) => {
      hostEventListener = listener
      return vi.fn()
    })

    const view = await mountPlans({
      global: {
        plugins: [realI18n],
      },
    })

    expect(hostEventListener).toBeTypeOf('function')
    expect(view.text()).not.toContain('New plan')
    expect(view.text()).toContain('All documents')
    await view.get('[data-test="review-notes-overflow"]').trigger('click')
    expect(view.text()).toContain('Review Notes')
    expect(view.text()).not.toContain('新增計畫')
    expect(view.text()).not.toContain('所有文件')
    expect(view.text()).not.toContain('審查留言')
    expect(view.text()).not.toContain('pane.plans.v2.new-plan')
    expect(view.text()).not.toContain('pane.plans.review-notes')
  })
  it('restores workspace preferences and refreshes from plans.changed', async () => {
    state.preferences = {
      'plans.filter': 'approved',
      'plans.sort': 'title',
      'plans.sortdir': 'asc',
      'plans.group': 'stage',
      'plans.collapsed': JSON.stringify(['approved']),
      'plans.recent': JSON.stringify([existingPath]),
      'plans.pinned': JSON.stringify([existingPath]),
    }
    const view = await mountPlans()

    expect(view.findAll('select')[0].element).toHaveProperty('value', 'approved')
    expect(view.findAll('select')[1].element).toHaveProperty('value', 'title')
    // Only the last-opened pointer for the document actually opened; no
    // preference default is written back on load.
    expect(state.sets).toEqual([{ key: 'plans.last-opened', value: existingPath }])
    expect(state.subscribe).toHaveBeenCalledTimes(2)
    expect(state.calls.filter(({ name }) => name === 'plans.list')).toHaveLength(1)

    await state.subscriptionListener?.({ workspace_path: '/workspace' })
    await new Promise((r) => setTimeout(r, 250))
    await flushPromises()
    expect(state.calls.filter(({ name }) => name === 'plans.list')).toHaveLength(2)
  })

  it('collapses a burst of plans.changed events into one plans.list scan', async () => {
    await mountPlans()
    expect(state.calls.filter(({ name }) => name === 'plans.list')).toHaveLength(1)

    // One saved document fans out into several watcher events; a file storm
    // into hundreds. Each used to start its own full scan.
    for (let index = 0; index < 5; index += 1) {
      state.subscriptionListener?.({ workspace_path: '/workspace' })
      await new Promise((r) => setTimeout(r, 20))
    }
    await flushPromises()
    expect(state.calls.filter(({ name }) => name === 'plans.list')).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 250))
    await flushPromises()
    expect(state.calls.filter(({ name }) => name === 'plans.list')).toHaveLength(2)
  })

  it('keeps in-memory fallback on initial empty preference read without calling setWorkspacePreference', async () => {
    state.preferences = {}
    const view = await mountPlans()

    // Defaults applied in memory
    expect(view.findAll('select')[0].element).toHaveProperty('value', 'all')
    expect(view.findAll('select')[1].element).toHaveProperty('value', 'updated')

    // Did not write default fallbacks into workspace storage — the only write
    // is the last-opened pointer for the document that was actually opened.
    expect(state.sets).toEqual([{ key: 'plans.last-opened', value: existingPath }])

    // Explicit user change does persist
    const filterSelect = view.findAll('select')[0]
    await filterSelect.setValue('draft')
    await filterSelect.trigger('change')
    await flushPromises()

    expect(state.sets).toContainEqual({
      key: 'plans.filter',
      value: 'draft',
    })
  })

  it('loads the initial rel_path document in the standalone view without opening it in the editor', async () => {
    const view = await mountPlans()

    expect(state.calls).toContainEqual({
      name: 'plans.read',
      args: { rel_path: existingPath },
    })
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Existing plan')
    expect(state.callCapability).not.toHaveBeenCalledWith('ui', 'openInEditor', expect.anything())
  })

  it('selects a document on standalone row click without opening it in the editor', async () => {
    const secondPath = '.agent-team/plans/second_a1b2c3.html'
    state.list = [
      ...state.list,
      {
        rel_path: secondPath,
        name: 'Second plan',
        stage: 'draft',
        meta: {
          schemaVersion: 1,
          name: 'Second plan',
          overview: 'Second overview',
          stage: 'draft',
          todos: [],
          reviewNotes: [],
        },
      },
    ]
    state.documents[secondPath] = {
      rel_path: secondPath,
      meta: state.list[1].meta,
      html: '<html />',
    }

    const view = await mountPlans()
    expect(state.callCapability).not.toHaveBeenCalledWith('ui', 'openInEditor', expect.anything())

    const rows = view.findAll('.plan-row')
    await rows[1].trigger('click')
    await flushPromises()

    expect(state.calls).toContainEqual({
      name: 'plans.read',
      args: { rel_path: secondPath },
    })
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Second plan')
    expect(state.callCapability).not.toHaveBeenCalledWith('ui', 'openInEditor', expect.anything())
  })

  it('opens the selected document in editor only from explicit context-menu actions', async () => {
    const view = await mountPlans()
    expect(state.callCapability).not.toHaveBeenCalledWith('ui', 'openInEditor', expect.anything())

    const row = view.find('button.plan-row')
    await row.trigger('contextmenu', { clientX: 50, clientY: 50 })
    await flushPromises()

    const contextMenuOpen = view.findAll('.context-menu button')
      .find((button) => button.text() === 'action.open-in-editor')
    expect(contextMenuOpen).toBeDefined()
    await contextMenuOpen!.trigger('click')
    await flushPromises()

    expect(state.callCapability).toHaveBeenCalledWith('ui', 'openInEditor', { path: existingPath })
  })

  it('opens a selected document in the packaged Plans window from the left contribution', async () => {
    window.history.replaceState({}, '', `/?workspace_path=%2Fworkspace&contribution=left`)
    const view = await mountPlans()

    await view.find('.plan-row').trigger('click')
    await flushPromises()

    expect(state.callCapability).toHaveBeenCalledWith('ui', 'openPlansWindow', { path: existingPath })
    expect(state.callCapability).not.toHaveBeenCalledWith('ui', 'openInEditor', expect.anything())
  })

  it('does not render the removed v2 create-plan sidebar chrome', async () => {
    const view = await mountPlans()
    expect(view.find('.sidebar-create-section').exists()).toBe(false)
    expect(view.find('.create-form').exists()).toBe(false)
  })

  it('renames a plan through the package backend', async () => {
    const view = await mountPlans()
    await view.get('.plan-row').trigger('contextmenu', { clientX: 50, clientY: 50 })
    await view.findAll('.context-menu button').find(button => button.text() === 'action.rename')!.trigger('click')
    await view.get('.rename-dialog input').setValue('renamed_a1b2c3.html')
    await view.get('.rename-dialog').trigger('submit')
    await flushPromises()

    expect(state.calls).toContainEqual({
      name: 'plans.rename',
      args: { from: existingPath, to: '.agent-team/plans/renamed_a1b2c3.html' },
    })
  })

  it('renames a plan inside the directory it lives in instead of moving it', async () => {
    const docsPath = 'docs/plans/elsewhere_a1b2c3.html'
    state.list[0].rel_path = docsPath
    state.documents[docsPath] = state.documents[existingPath]
    const view = await mountPlans()
    await view.get('.plan-row').trigger('contextmenu', { clientX: 50, clientY: 50 })
    await view.findAll('.context-menu button').find(button => button.text() === 'action.rename')!.trigger('click')
    await view.get('.rename-dialog input').setValue('renamed_a1b2c3.html')
    await view.get('.rename-dialog').trigger('submit')
    await flushPromises()

    expect(state.calls).toContainEqual({
      name: 'plans.rename',
      args: { from: docsPath, to: 'docs/plans/renamed_a1b2c3.html' },
    })
  })

  it('reloads the list when a bulk delete fails part-way', async () => {
    const donePlan = (name: string) => {
      const relPath = `.agent-team/plans/${name}_a1b2c3.html`
      const meta = { schemaVersion: 1, name, overview: '', stage: 'done', todos: [], reviewNotes: [] }
      state.documents[relPath] = { rel_path: relPath, meta, html: '<html />' }
      return { rel_path: relPath, name, stage: 'done', meta }
    }
    const first = donePlan('first')
    const second = donePlan('second')
    state.list = [...state.list, first, second]
    const original = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === 'plans.delete' && args.rel_path === second.rel_path) {
        state.calls.push({ name, args })
        return { reqId, ok: false, error: { code: 'BACKEND_ERROR', message: 'nope' } }
      }
      return original(reqId, name, args)
    }
    const view = await mountPlans()
    const listCalls = () => state.calls.filter(call => call.name === 'plans.list').length
    const before = listCalls()
    await view.findAll('button').find(button => button.text() === 'pane.plans.delete-all')!.trigger('click')
    await flushPromises()

    expect(state.calls.some(call => call.name === 'plans.delete' && call.args.rel_path === first.rel_path)).toBe(true)
    expect(listCalls()).toBeGreaterThan(before)
  })

  it('confirms Plan deletion through the application confirmation service', async () => {
    const view = await mountPlans()
    const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await openToolbarOverflow(view)
    const deleteButton = view.get('.prt-delete')
    await deleteButton.trigger('click')
    await flushPromises()
    await nextTick()

    expect(state.confirm).toHaveBeenCalledWith(
      'pane.plans.delete-confirm:{"name":"Existing plan"}',
      { title: 'pane.plans.menu-delete', confirmText: 'pane.plans.menu-delete' },
    )
    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(state.calls).toContainEqual({
      name: 'plans.delete',
      args: { rel_path: existingPath },
    })
  })

  it('formats progress using pane.plans.progress-done translation key', async () => {
    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Existing plan',
      overview: 'Existing overview',
      stage: 'approved',
      todos: [
        { id: 'todo-1', content: 'T1', status: 'done' },
        { id: 'todo-2', content: 'T2', status: 'pending' },
        { id: 'todo-3', content: 'T3', status: 'pending' },
      ],
      reviewNotes: [],
    }
    state.documents[existingPath].meta = state.list[0].meta

    const view = await mountPlans()
    const toolbarProgress = view.find('.plan-toolbar-progress')
    expect(toolbarProgress.text()).toContain('pane.plans.progress-done')
    expect(toolbarProgress.text()).toContain('"done":1')
    expect(toolbarProgress.text()).toContain('"total":3')
  })

  it('renders iframe with stripped scripts and strict nonce CSP in srcdoc', async () => {
    state.documents[existingPath].html =
      '<!doctype html><html><head><script>alert("evil")</script></head><body><p>Clean body</p></body></html>'

    const view = await mountPlans()
    const iframe = view.find('iframe.plan-doc-frame')
    expect(iframe.exists()).toBe(true)
    // The Host keeps a frame by this name on its srcdoc (its planFrameNavigation guard).
    expect(iframe.attributes('name')).toBe('navide-plan-doc')

    const srcdoc = iframe.attributes('srcdoc') ?? ''
    expect(srcdoc).not.toContain('alert("evil")')
    expect(srcdoc).toContain('Content-Security-Policy')
    expect(srcdoc).toContain("default-src 'none'")
    expect(srcdoc).toMatch(/script-src 'nonce-[0-9a-f]{32}'/)
    expect(srcdoc).toContain('data-todo-id')
  })

  it('places the toolbar overflow overlay beside the clipped bar, not inside it', async () => {
    const view = await mountPlans()
    await openToolbarOverflow(view)

    const toolbar = view.get('.prt')
    const bar = view.get('.prt-bar')
    const menu = view.get('.prt-menu')
    const backdrop = view.get('.prt-menu-backdrop')

    expect(menu.element.parentElement).toBe(toolbar.element)
    expect(backdrop.element.parentElement).toBe(toolbar.element)
    expect(bar.element.contains(menu.element)).toBe(false)
    expect(bar.element.contains(backdrop.element)).toBe(false)
  })

  it('ports section Edit and Delete controls into the trusted iframe runtime', async () => {
    state.documents[existingPath].html = [
      '<html><body>',
      '<section><h2>Editable section</h2><p>Editable prose.</p></section>',
      '<section><h2>Todo section</h2><ul class="todos"><li data-todo-id="todo-1">T1</li></ul></section>',
      '</body></html>',
    ].join('')

    const view = await mountPlans()
    const srcdoc = view.get('iframe.plan-doc-frame').attributes('srcdoc') ?? ''

    expect(srcdoc).toContain('plan-rt-secbar')
    expect(srcdoc).toContain("type: 'section-edit'")
    expect(srcdoc).toContain("type: 'section-delete'")
    expect(srcdoc).toContain('contenteditable')
    expect(srcdoc).toContain('Todo section')
    expect(srcdoc).toContain('documentToken')
  })

  it('accepts only trusted, anchored section edit/delete messages and confirms deletes', async () => {
    state.documents[existingPath].html = '<html><body><section><h2>Editable section</h2><p>Original prose.</p></section></body></html>'
    const view = await mountPlans()
    const iframeEl = view.get('iframe.plan-doc-frame').element as HTMLIFrameElement
    const frameWin = {} as Window
    Object.defineProperty(iframeEl, 'contentWindow', { value: frameWin, configurable: true })
    const documentToken = (iframeEl.getAttribute('srcdoc') || '').match(/var documentToken = "([0-9a-f]{32})"/)?.[1]
    expect(documentToken).toBeTruthy()

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: { type: 'section-edit', anchor: 'Editable section', html: '<p>Rejected</p>', documentToken },
    }))
    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'section-edit', anchor: 'Unknown anchor', html: '<p>Rejected</p>', documentToken },
    }))
    await flushPromises()
    expect(state.calls.filter((call) => call.name === 'plans.write_document')).toHaveLength(0)

    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'section-delete', anchor: 'Editable section', documentToken },
    }))
    await flushPromises()
    expect(state.confirm).toHaveBeenCalledWith(
      'pane.plans.section-delete-confirm:{"anchor":"Editable section"}',
      { title: 'pane.plans.delete', confirmText: 'pane.plans.delete' },
    )
    const writes = state.calls.filter(call => call.name === 'plans.write_document')
    expect(writes).toHaveLength(1)
    expect(writes[0].args).toMatchObject({ rel_path: existingPath, expected_mtime: 1 })
    expect(writes[0].args.content).not.toContain('Original prose.')

  })

  it('sanitizes trusted anchored section edits before the private backend adapter', async () => {
    state.documents[existingPath].html = '<html><body><section><h2>Editable section</h2><p>Original prose.</p></section></body></html>'
    // plans.read and plans.read_document return the same bytes on disk.
    state.documents[existingPath].raw = state.documents[existingPath].html
    const view = await mountPlans()
    const iframeEl = view.get('iframe.plan-doc-frame').element as HTMLIFrameElement
    const frameWin = {} as Window
    Object.defineProperty(iframeEl, 'contentWindow', { value: frameWin, configurable: true })
    const documentToken = (iframeEl.getAttribute('srcdoc') || '').match(/var documentToken = "([0-9a-f]{32})"/)?.[1]
    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'section-edit', anchor: 'Editable section', html: '<p>Updated prose.</p><script>evil()</script>', documentToken },
    }))
    await flushPromises()
    expect(state.toast).not.toHaveBeenCalled()
    const writes = state.calls.filter(call => call.name === 'plans.write_document')
    expect(writes).toHaveLength(1)
    expect(writes[0].args).toMatchObject({ rel_path: existingPath, expected_mtime: 1 })
    expect(writes[0].args.content).toContain('<p>Updated prose.</p>')
    expect(writes[0].args.content).not.toContain('evil()')
  })

  describe('section edits against a document that changed on disk', () => {
    const page = (scope: string, risks = 'Risk prose.') =>
      `<html><body><section><h2>Scope</h2><p>${scope}</p></section><section><h2>Risks</h2><p>${risks}</p></section></body></html>`

    async function editScope(disk: string, html = '<p>Mine prose.</p>') {
      state.documents[existingPath].html = page('Original prose.')
      state.documents[existingPath].raw = disk
      const view = await mountPlans({ attachTo: document.body })
      const iframeEl = view.get('iframe.plan-doc-frame').element as HTMLIFrameElement
      const frameWin = { postMessage: vi.fn() } as unknown as Window
      Object.defineProperty(iframeEl, 'contentWindow', { value: frameWin, configurable: true })
      const documentToken = (iframeEl.getAttribute('srcdoc') || '').match(/var documentToken = "([0-9a-f]{32})"/)?.[1]
      window.dispatchEvent(new MessageEvent('message', { source: frameWin, data: { type: 'section-editing', active: true, documentToken } }))
      window.dispatchEvent(new MessageEvent('message', { source: frameWin, data: { type: 'section-editing', active: false, documentToken } }))
      window.dispatchEvent(new MessageEvent('message', { source: frameWin, data: { type: 'section-edit', anchor: 'Scope', html, documentToken } }))
      await flushPromises()
      return view
    }
    const writes = () => state.calls.filter(call => call.name === 'plans.write_document')

    it('merges into a document an agent changed in another section, and says so', async () => {
      await editScope(page('Original prose.', 'Agent risks.'))
      expect(writes()).toHaveLength(1)
      expect(writes()[0].args.content).toContain('<p>Mine prose.</p>')
      expect(writes()[0].args.content).toContain('Agent risks.')
      expect(state.toast).toHaveBeenCalledWith('pane.plans.merged-others', { type: 'success' })
    })

    it('writes nothing and shows both versions when the same section changed', async () => {
      const view = await editScope(page('Agent prose.'))
      expect(writes()).toHaveLength(0)
      const dialog = view.get('.scd-dialog')
      expect(dialog.get('[data-side="mine"] textarea').element.value).toContain('Mine prose.')
      expect(dialog.get('[data-side="theirs"] textarea').element.value).toContain('Agent prose.')
    })

    it('keeping the disk version leaves the user’s text on screen until closed', async () => {
      const view = await editScope(page('Agent prose.'))
      await view.get('.scd-keep-theirs').trigger('click')
      await flushPromises()
      expect(writes()).toHaveLength(0)
      expect(view.get('.scd-dialog [data-side="mine"] textarea').element.value).toContain('Mine prose.')
      await view.get('.scd-close').trigger('click')
      expect(view.find('.scd-dialog').exists()).toBe(false)
    })

    it('keeping mine writes over the version shown and keeps theirs on screen', async () => {
      const view = await editScope(page('Agent prose.'))
      await view.get('.scd-keep-mine').trigger('click')
      await flushPromises()
      expect(writes()).toHaveLength(1)
      expect(writes()[0].args.content).toContain('<p>Mine prose.</p>')
      expect(writes()[0].args.content).not.toContain('Agent prose.')
      expect(view.get('.scd-dialog [data-side="theirs"] textarea').element.value).toContain('Agent prose.')
    })
  })

  describe('edit mode', () => {
    const meta = { schemaVersion: 1, name: 'Existing plan', overview: 'Existing overview', stage: 'approved', todos: [], reviewNotes: [] }
    const page = (goals: string, risks: string) => [
      '<html><body>',
      `<script type="application/json" id="plan-meta">${JSON.stringify(meta)}</script>`,
      '<header><h1>Existing plan<span class="pill approved">approved</span></h1><p class="overview">Existing overview</p></header>',
      `<section><h2>Goals</h2><p>${goals}</p></section>`,
      `<section><h2>Risks</h2><p>${risks}</p></section>`,
      '</body></html>',
    ].join('')

    async function enterEditMode() {
      state.documents[existingPath].html = page('Goals 0', 'Risks 0')
      state.documents[existingPath].raw = state.documents[existingPath].html
      const view = await mountPlans({ attachTo: document.body })
      const iframeEl = view.get('iframe.plan-doc-frame').element as HTMLIFrameElement
      const frameWin = { postMessage: vi.fn() } as unknown as Window
      Object.defineProperty(iframeEl, 'contentWindow', { value: frameWin, configurable: true })
      const documentToken = (iframeEl.getAttribute('srcdoc') || '').match(/var documentToken = "([0-9a-f]{32})"/)?.[1]
      const send = async (data: Record<string, unknown>) => {
        window.dispatchEvent(new MessageEvent('message', { source: frameWin, data: { ...data, documentToken } }))
        await flushPromises()
      }
      await view.get('.plan-edit-toggle').trigger('click')
      expect(frameWin.postMessage).toHaveBeenCalledWith({ type: 'edit-mode', active: true, documentToken }, '*')
      await send({ type: 'section-editing', active: true })
      await send({ type: 'edit-mode-changed', active: true })
      return { view, send, iframeEl }
    }
    const writes = () => state.calls.filter(call => call.name === 'plans.write_document')
    const reads = () => state.calls.filter(call => call.name === 'plans.read')

    it('saves each section without re-rendering the document', async () => {
      const { view, send, iframeEl } = await enterEditMode()
      const srcdoc = iframeEl.getAttribute('srcdoc')
      const readsBefore = reads().length
      await send({ type: 'section-edit', anchor: 'Goals', html: '<p>Goals 1</p>' })
      expect(writes()).toHaveLength(1)
      expect(writes()[0].args.content).toContain('<p>Goals 1</p>')
      expect(reads().length).toBe(readsBefore)
      expect(view.get('iframe.plan-doc-frame').attributes('srcdoc')).toBe(srcdoc)
      expect(view.get('.plan-edit-status').text()).toContain('pane.plans.edit-saved')
      expect(state.toast).not.toHaveBeenCalled()
    })

    it('never overwrites a section an agent changed after the frame rendered', async () => {
      const { view, send } = await enterEditMode()
      await send({ type: 'section-edit', anchor: 'Goals', html: '<p>Goals 1</p>' })
      // An agent rewrites Risks on disk; the frame still shows "Risks 0".
      state.documents[existingPath].raw = String(state.documents[existingPath].raw).replace('Risks 0', 'Agent risks')
      await send({ type: 'section-edit', anchor: 'Risks', html: '<p>Risks 0 and mine</p>' })
      expect(writes()).toHaveLength(1)
      expect(view.get('.scd-dialog [data-side="theirs"] textarea').element.value).toContain('Agent risks')
      expect(String(state.documents[existingPath].raw)).toContain('Agent risks')
    })

    it('saves the name to plan-meta and the header together', async () => {
      const { send } = await enterEditMode()
      await send({ type: 'header-edit', field: 'name', text: 'Renamed <plan>' })
      expect(writes()).toHaveLength(1)
      const content = String(writes()[0].args.content)
      expect(parseHtmlPlanMeta(content)?.meta.name).toBe('Renamed <plan>')
      expect(content).toContain('<h1>Renamed &lt;plan&gt;<span class="pill approved">approved</span></h1>')
    })

    it('shows the saved document once edit mode ends', async () => {
      const { send } = await enterEditMode()
      await send({ type: 'section-edit', anchor: 'Goals', html: '<p>Goals 1</p>' })
      const readsBefore = reads().length
      await send({ type: 'section-editing', active: false })
      await send({ type: 'edit-mode-changed', active: false })
      expect(reads().length).toBe(readsBefore + 1)
    })
  })

  describe('an open document changed on disk', () => {
    async function changeOnDisk(): Promise<void> {
      state.list[0].mtime = 2
      state.documents[existingPath].mtime = 2
      state.documents[existingPath].html = '<html><body><section><h2>Scope</h2><p>Agent prose.</p></section></body></html>'
      state.subscriptionListener?.({})
      await new Promise(resolve => setTimeout(resolve, 260))
      await flushPromises()
    }
    const reads = () => state.calls.filter(call => call.name === 'plans.read' && call.args.rel_path === existingPath)

    beforeEach(() => {
      state.list[0].mtime = 1
      state.documents[existingPath].mtime = 1
      state.documents[existingPath].html = '<html><body><section><h2>Scope</h2><p>Original prose.</p></section></body></html>'
    })

    it('reloads in place when nobody is editing it', async () => {
      const view = await mountPlans()
      const before = reads().length
      await changeOnDisk()
      expect(reads().length).toBe(before + 1)
      expect(view.get('iframe.plan-doc-frame').attributes('srcdoc')).toContain('Agent prose.')
      expect(view.find('.plan-disk-changed-banner').exists()).toBe(false)
    })

    it('waits for an inline edit to end, showing a notice meanwhile', async () => {
      const view = await mountPlans()
      const iframeEl = view.get('iframe.plan-doc-frame').element as HTMLIFrameElement
      const frameWin = { postMessage: vi.fn() } as unknown as Window
      Object.defineProperty(iframeEl, 'contentWindow', { value: frameWin, configurable: true })
      const documentToken = (iframeEl.getAttribute('srcdoc') || '').match(/var documentToken = "([0-9a-f]{32})"/)?.[1]
      window.dispatchEvent(new MessageEvent('message', { source: frameWin, data: { type: 'section-editing', active: true, documentToken } }))
      await flushPromises()
      const before = reads().length
      await changeOnDisk()
      expect(reads().length).toBe(before)
      expect(view.find('.plan-disk-changed-banner').exists()).toBe(true)

      window.dispatchEvent(new MessageEvent('message', { source: frameWin, data: { type: 'section-editing', active: false, documentToken } }))
      await flushPromises()
      expect(reads().length).toBe(before + 1)
      expect(view.find('.plan-disk-changed-banner').exists()).toBe(false)
    })

    it('does not reload when the listing shows the copy already open', async () => {
      await mountPlans()
      const before = reads().length
      state.subscriptionListener?.({})
      await new Promise(resolve => setTimeout(resolve, 260))
      await flushPromises()
      expect(reads().length).toBe(before)
    })
  })

  it('safely handles todo-clicked only from the preview frame with known todo ID', async () => {
    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Existing plan',
      overview: 'Existing overview',
      stage: 'approved',
      todos: [
        { id: 'todo-1', content: 'T1', status: 'pending' },
      ],
      reviewNotes: [],
    }
    state.documents[existingPath].meta = state.list[0].meta
    state.documents[existingPath].html = '<html><body><li data-todo-id="todo-1">T1</li></body></html>'

    const view = await mountPlans()
    const iframeEl = view.find('iframe.plan-doc-frame').element as HTMLIFrameElement
    const frameWin = {} as Window
    Object.defineProperty(iframeEl, 'contentWindow', { value: frameWin, configurable: true })

    const srcdoc = iframeEl.getAttribute('srcdoc') || ''
    const tokenMatch = srcdoc.match(/(?:var documentToken = |"documentToken":)"([0-9a-f]{32})"/)
    const validToken = tokenMatch ? tokenMatch[1] : ''

    // 1. Rejected: mismatched window source
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: validToken },
    }))
    await flushPromises()
    expect(state.calls.filter((c) => c.name === 'plans.update_todo')).toHaveLength(0)

    // 2. Rejected: null source (both event.source and getSourceWindow could be null)
    window.dispatchEvent(new MessageEvent('message', {
      source: null,
      data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: validToken },
    }))
    await flushPromises()
    expect(state.calls.filter((c) => c.name === 'plans.update_todo')).toHaveLength(0)

    // 3. Rejected: unknown todo ID
    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'todo-clicked', todoId: 'unlisted-todo', documentToken: validToken },
    }))
    await flushPromises()
    expect(state.calls.filter((c) => c.name === 'plans.update_todo')).toHaveLength(0)

    // 4. Rejected: missing token, legacy token alias, or wrong document token
    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'todo-clicked', todoId: 'todo-1' },
    }))
    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'todo-clicked', todoId: 'todo-1', token: validToken },
    }))
    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: 'wrong-or-stale-token' },
    }))
    await flushPromises()
    expect(state.calls.filter((c) => c.name === 'plans.update_todo')).toHaveLength(0)

    // 5. Accepted: matching frame window, valid documentToken, and valid todo ID
    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: validToken },
    }))
    await flushPromises()
    expect(state.calls).toContainEqual({
      name: 'plans.update_todo',
      args: {
        rel_path: existingPath,
        todo_id: 'todo-1',
        status: 'in-progress',
      },
    })
  })

  it('acknowledges a successful todo update without replacing the preview iframe', async () => {
    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Existing plan',
      overview: 'Existing overview',
      stage: 'approved',
      todos: [
        { id: 'todo-1', content: 'T1', status: 'pending' },
        { id: 'todo-2', content: 'T2', status: 'pending' },
      ],
      reviewNotes: [],
    }
    state.documents[existingPath].meta = state.list[0].meta
    state.documents[existingPath].html = '<html><body><li data-todo-id="todo-1">T1</li></body></html>'

    const view = await mountPlans()
    const iframe = view.find('iframe.plan-doc-frame')
    const iframeEl = iframe.element as HTMLIFrameElement
    const acknowledgement = vi.fn()
    const frameWin = { postMessage: acknowledgement } as unknown as Window
    Object.defineProperty(iframeEl, 'contentWindow', { value: frameWin, configurable: true })
    const documentToken = (iframeEl.getAttribute('srcdoc') || '').match(/(?:var documentToken = |"documentToken":)"([0-9a-f]{32})"/)?.[1]
    expect(documentToken).toBeTruthy()

    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'todo-clicked', todoId: 'todo-1', documentToken },
    }))
    await flushPromises()
    await nextTick()

    expect(state.calls.filter((call) => call.name === 'plans.update_todo')).toEqual([{
      name: 'plans.update_todo',
      args: { rel_path: existingPath, todo_id: 'todo-1', status: 'in-progress' },
    }])
    expect(state.calls.filter((call) => call.name === 'plans.read')).toHaveLength(1)
    expect(view.find('iframe.plan-doc-frame').element).toBe(iframeEl)
    expect((view.find('iframe.plan-doc-frame').element as HTMLIFrameElement).contentWindow).toBe(frameWin)
    expect((view.find('iframe.plan-doc-frame').element as HTMLIFrameElement).getAttribute('srcdoc')).toContain(`var documentToken = ${JSON.stringify(documentToken)}`)
    expect(acknowledgement).toHaveBeenCalledWith({
      type: 'todo-status-updated',
      documentToken,
      todoId: 'todo-1',
      status: 'in-progress',
    }, '*')
    expect(view.find('.plan-toolbar-progress').text()).toContain('"done":0')
  })

  it('mounts the plugin-local Review Notes panel and completes manual CRUD without duplicate Enter submission', async () => {
    const view = await mountPlans()
    await view.get('[data-test="review-notes-overflow"]').trigger('click')
    await view.get('[data-test="review-notes-overflow-item"]').trigger('click')
    const input = view.get('[data-test="review-note-input"]')
    expect(input.attributes('placeholder')).toBe('pane.plans.review-add-placeholder')
    await input.setValue('Need one clarification')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(state.calls.filter((call) => call.name === 'plans.review_note_add')).toHaveLength(1)
    expect(view.text()).toContain('Need one clarification')
  })

  it('keeps resolved-only Review Notes exclusively in the overflow and never exposes Reopen', async () => {
    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Existing plan',
      overview: 'Existing overview',
      stage: 'in-review',
      todos: [],
      reviewNotes: [{ id: 'n1', author: 'user', text: 'Already handled', resolved: true, reply: 'Done', anchor: 'Goals' }],
    }
    state.documents[existingPath].meta = state.list[0].meta

    const view = await mountPlans()
    expect(view.find('.review-notes-toggle').exists()).toBe(false)
    await view.get('[data-test="review-notes-overflow"]').trigger('click')
    const menuItem = view.get('[data-test="review-notes-overflow-item"]')
    await menuItem.trigger('click')

    expect(view.get('[data-test="review-note-anchor-n1"]').text()).toBe('Goals')
    expect(view.get('[data-test="review-note-reply-n1"]').text()).toBe('Done')
    expect(view.find('[data-test="resolve-n1"]').exists()).toBe(false)
    expect(view.text()).not.toContain('pane.plans.review-reopen')
  })

  it('uses the application confirmation service and preserves the preview identity for Review Notes', async () => {
    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Existing plan',
      overview: 'Existing overview',
      stage: 'in-review',
      todos: [],
      reviewNotes: [{ id: 'n1', author: 'user', text: 'Delete me', resolved: false, reply: '', anchor: '' }],
    }
    state.documents[existingPath].meta = state.list[0].meta
    state.documents[existingPath].html = '<html><body><h2>Goals</h2></body></html>'

    const view = await mountPlans()
    const iframe = view.get('iframe.plan-doc-frame').element as HTMLIFrameElement
    const srcdoc = iframe.getAttribute('srcdoc')
    const documentToken = srcdoc?.match(/(?:var documentToken = |"documentToken":)"([0-9a-f]{32})"/)?.[1]
    expect(documentToken).toBeTruthy()

    await view.get('.review-notes-toggle').trigger('click')
    await view.get('[data-test="delete-n1"]').trigger('click')
    await flushPromises()

    expect(state.confirm).toHaveBeenCalledOnce()
    expect(state.calls).toContainEqual({
      name: 'plans.review_note_delete',
      args: { rel_path: existingPath, note_id: 'n1' },
    })
    expect(view.get('iframe.plan-doc-frame').element).toBe(iframe)
    expect(view.get('iframe.plan-doc-frame').attributes('srcdoc')).toContain(`var documentToken = ${JSON.stringify(documentToken)}`)
  })

  it('routes a validated section comment into an anchored Review Note without remounting the iframe', async () => {
    state.documents[existingPath].html = '<html><body><section><h2>Goals</h2><p>Goal details</p></section></body></html>'
    const view = await mountPlans()
    const iframe = view.get('iframe.plan-doc-frame').element as HTMLIFrameElement
    const frameWin = { postMessage: vi.fn() } as unknown as Window
    Object.defineProperty(iframe, 'contentWindow', { value: frameWin, configurable: true })
    const token = iframe.getAttribute('srcdoc')?.match(/(?:var documentToken = |"documentToken":)"([0-9a-f]{32})"/)?.[1]
    expect(token).toBeTruthy()

    window.dispatchEvent(new MessageEvent('message', {
      source: frameWin,
      data: { type: 'section-comment', anchor: 'Goals', documentToken: token },
    }))
    await flushPromises()
    await view.get('[data-test="review-note-input"]').setValue('Anchor this')
    await view.get('[data-test="review-note-input"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(state.calls).toContainEqual({
      name: 'plans.review_note_add',
      args: { rel_path: existingPath, text: 'Anchor this', anchor: 'Goals' },
    })
    expect(view.get('iframe.plan-doc-frame').element).toBe(iframe)
  })

  it('does not apply a pending Plan A review-note response after Plan B is selected', async () => {
    const planBPath = '.agent-team/plans/plan_b_112233.html'
    state.list.push({
      rel_path: planBPath, name: 'Plan B', stage: 'draft',
      meta: { schemaVersion: 1, name: 'Plan B', overview: '', stage: 'draft', todos: [], reviewNotes: [] },
    })
    state.documents[planBPath] = { rel_path: planBPath, meta: state.list[1].meta, html: '<html><body>Plan B</body></html>' }
    let resolveAdd!: () => void
    const delayed = new Promise<void>((resolve) => { resolveAdd = resolve })
    const original = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === 'plans.review_note_add') await delayed
      return original(reqId, name, args)
    }

    const view = await mountPlans()
    await view.get('[data-test="review-notes-overflow"]').trigger('click')
    await view.get('[data-test="review-notes-overflow-item"]').trigger('click')
    await view.get('[data-test="review-note-input"]').setValue('Only A')
    await view.get('[data-test="review-note-input"]').trigger('keydown', { key: 'Enter' })
    await view.findAll('.plan-row')[1].trigger('click')
    await flushPromises()
    resolveAdd()
    await flushPromises()

    expect(view.get('.selected-document').attributes('aria-label')).toBe('Plan B')
    expect(view.text()).not.toContain('Only A')
  })

  it('prevents cross-document todo mutation race when switching documents while plans.read is deferred', async () => {
    const planBPath = '.agent-team/plans/plan_b_112233.html'
    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Existing plan',
      overview: 'Existing overview',
      stage: 'approved',
      todos: [{ id: 'todo-1', content: 'T1', status: 'pending' }],
      reviewNotes: [],
    }
    state.documents[existingPath].meta = state.list[0].meta
    state.documents[existingPath].html = '<html><body><li data-todo-id="todo-1">T1</li></body></html>'

    state.list.push({
      rel_path: planBPath,
      name: 'Plan B',
      stage: 'draft',
      meta: {
        schemaVersion: 1,
        name: 'Plan B',
        overview: 'Overview B',
        stage: 'draft',
        todos: [{ id: 'todo-1', content: 'T1 in B', status: 'pending' }],
        reviewNotes: [],
      },
    })
    state.documents[planBPath] = {
      rel_path: planBPath,
      meta: state.list[1].meta,
      html: '<html><body><li data-todo-id="todo-1">T1 in B</li></body></html>',
    }

    let resolveReadB!: () => void
    const deferredReadB = new Promise<void>((resolve) => {
      resolveReadB = resolve
    })

    const originalCallBackend = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === 'plans.read' && args.rel_path === planBPath) {
        await deferredReadB
      }
      return originalCallBackend(reqId, name, args)
    }

    const view = await mountPlans()
    const iframeEl = view.find('iframe.plan-doc-frame').element as HTMLIFrameElement
    const frameWin = {} as Window
    Object.defineProperty(iframeEl, 'contentWindow', { value: frameWin, configurable: true })

    const readCallsForA = () =>
      state.calls.filter((c) => c.name === 'plans.read' && c.args.rel_path === existingPath).length
    const initialReadsForA = readCallsForA()

    const srcdocA = iframeEl.getAttribute('srcdoc') || ''
    const tokenMatchA = srcdocA.match(/(?:var documentToken = |"documentToken":)"([0-9a-f]{32})"/)
    const validTokenA = tokenMatchA ? tokenMatchA[1] : ''

    // 1. User initiates switch to Plan B
    const rows = view.findAll('.plan-row')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    await rows[1].trigger('click')

    // 2. While read(B) is deferred, user clicks todo-1 in Plan A's preview iframe
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frameWin,
        data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: validTokenA },
      }),
    )
    await flushPromises()

    // A remains painted while B loads, but its generation no longer accepts writes.
    expect(state.calls.filter(c => c.name === 'plans.update_todo')).toHaveLength(0)
    expect(state.calls.filter((c) => c.name === 'plans.update_todo' && c.args.rel_path === planBPath)).toHaveLength(0)

    // Assertion 2: No redundant plans.read(A) was called while B is pending
    expect(readCallsForA()).toBe(initialReadsForA)

    // Assertion 3: selected is still Plan A prior to B resolving
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Existing plan')

    // 3. Resolve Plan B's read
    resolveReadB()
    await flushPromises()

    // Assertion 4: Plan B is applied only after B resolves
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Plan B')
  })

  it('prevents out-of-order plans.read results when B is read then C is read, and C resolves first', async () => {
    const planBPath = '.agent-team/plans/plan_b.html'
    const planCPath = '.agent-team/plans/plan_c.html'

    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Plan A',
      overview: 'Overview A',
      stage: 'approved',
      todos: [{ id: 'todo-1', content: 'T1', status: 'pending' }],
      reviewNotes: [],
    }
    state.documents[existingPath].meta = state.list[0].meta
    state.documents[existingPath].html = '<html><body>Plan A</body></html>'

    state.list.push({
      rel_path: planBPath,
      name: 'Plan B',
      stage: 'in-progress',
      meta: {
        schemaVersion: 1,
        name: 'Plan B',
        overview: 'Overview B',
        stage: 'in-progress',
        todos: [{ id: 'tb-1', content: 'TB', status: 'pending' }],
        reviewNotes: [],
      },
    })
    state.documents[planBPath] = {
      rel_path: planBPath,
      meta: state.list[1].meta,
      html: '<html><body>Plan B</body></html>',
    }

    state.list.push({
      rel_path: planCPath,
      name: 'Plan C',
      stage: 'done',
      meta: {
        schemaVersion: 1,
        name: 'Plan C',
        overview: 'Overview C',
        stage: 'done',
        todos: [{ id: 'tc-1', content: 'TC', status: 'done' }],
        reviewNotes: [],
      },
    })
    state.documents[planCPath] = {
      rel_path: planCPath,
      meta: state.list[2].meta,
      html: '<html><body>Plan C</body></html>',
    }

    let resolveReadB!: () => void
    const deferredReadB = new Promise<void>((resolve) => {
      resolveReadB = resolve
    })

    let resolveReadC!: () => void
    const deferredReadC = new Promise<void>((resolve) => {
      resolveReadC = resolve
    })

    const originalCallBackend = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === 'plans.read' && args.rel_path === planBPath) {
        await deferredReadB
      } else if (name === 'plans.read' && args.rel_path === planCPath) {
        await deferredReadC
      }
      return originalCallBackend(reqId, name, args)
    }

    const view = await mountPlans()

    // Find rows
    const rows = view.findAll('.plan-row')
    expect(rows.length).toBeGreaterThanOrEqual(3)

    // 1. Click Plan B (starts read B, which is deferred)
    await rows[1].trigger('click')

    // 2. Click Plan C (starts read C, which is also deferred)
    await rows[2].trigger('click')

    // 3. Resolve C first
    resolveReadC()
    await flushPromises()

    // Verify C is displayed
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Plan C')
    const iframeC = view.find('iframe.plan-doc-frame')
    const cSrcdoc = iframeC.attributes('srcdoc') ?? ''
    expect(cSrcdoc).toContain('Plan C')

    // 4. Resolve B afterward
    resolveReadB()
    await flushPromises()

    // Stale B must NOT revert the UI from C
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Plan C')
    const iframeAfterB = view.find('iframe.plan-doc-frame')
    expect(iframeAfterB.attributes('srcdoc')).toBe(cSrcdoc)
  })

  it('prevents a refresh for A from overwriting B when selection changed to B after refresh started', async () => {
    const planBPath = '.agent-team/plans/plan_b.html'

    state.list[0].meta = {
      schemaVersion: 1,
      name: 'Plan A',
      overview: 'Overview A',
      stage: 'approved',
      todos: [{ id: 'todo-1', content: 'T1', status: 'pending' }],
      reviewNotes: [],
    }
    state.documents[existingPath].meta = state.list[0].meta
    state.documents[existingPath].html = '<html><body>Plan A</body></html>'

    state.list.push({
      rel_path: planBPath,
      name: 'Plan B',
      stage: 'draft',
      meta: {
        schemaVersion: 1,
        name: 'Plan B',
        overview: 'Overview B',
        stage: 'draft',
        todos: [{ id: 'tb-1', content: 'TB', status: 'pending' }],
        reviewNotes: [],
      },
    })
    state.documents[planBPath] = {
      rel_path: planBPath,
      meta: state.list[1].meta,
      html: '<html><body>Plan B</body></html>',
    }

    let resolveRefreshA!: () => void
    let interceptA = false
    const deferredRefreshA = new Promise<void>((resolve) => {
      resolveRefreshA = resolve
    })

    const originalCallBackend = (window as any).nav.callBackend
    ;(window as any).nav.callBackend = async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (interceptA && name === 'plans.read' && args.rel_path === existingPath) {
        await deferredRefreshA
      }
      return originalCallBackend(reqId, name, args)
    }

    const view = await mountPlans()
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Plan A')

    // Start intercepting reads for A (simulating delayed refresh)
    interceptA = true

    // Trigger refresh for A (e.g. via toolbar refresh or todo click)
    const refreshBtn = view.find('button[title*="重新整理"], button[title*="Refresh"]')
    if (refreshBtn.exists()) {
      await refreshBtn.trigger('click')
    } else {
      // Direct todo toggle
      const frameEl = view.find('iframe.plan-doc-frame').element as HTMLIFrameElement
      const frameWin = {} as Window
      Object.defineProperty(frameEl, 'contentWindow', { value: frameWin, configurable: true })
      const srcdocA = frameEl.getAttribute('srcdoc') || ''
      const tokenMatchA = srcdocA.match(/(?:var documentToken = |"documentToken":)"([0-9a-f]{32})"/)
      const validTokenA = tokenMatchA ? tokenMatchA[1] : ''
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frameWin,
          data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: validTokenA },
        }),
      )
    }

    // Now user switches to Plan B
    const rows = view.findAll('.plan-row')
    await rows[1].trigger('click')
    await flushPromises()

    // B is now selected and displayed
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Plan B')
    const bSrcdoc = view.find('iframe.plan-doc-frame').attributes('srcdoc') ?? ''
    expect(bSrcdoc).toContain('Plan B')

    // Now resolve deferred read/refresh for A
    resolveRefreshA()
    await flushPromises()

    // The UI must remain on Plan B and not revert to Plan A
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Plan B')
    expect(view.find('iframe.plan-doc-frame').attributes('srcdoc')).toBe(bSrcdoc)
  })

  it('localizes stage labels across recent, grouped, and archived rows and formats progress bar percentage', async () => {
    state.preferences['plans.recent'] = JSON.stringify([existingPath])
    state.preferences['plans.collapsed'] = JSON.stringify([])
    state.list = [
      {
        rel_path: existingPath,
        name: 'Approved Plan',
        stage: 'approved',
        overview: 'Overview',
        todos: { total: 2, by_status: { done: 1 } },
        meta: {
          schemaVersion: 1,
          name: 'Approved Plan',
          overview: 'Overview',
          stage: 'approved',
          todos: [
            { id: 't1', content: 'T1', status: 'done' },
            { id: 't2', content: 'T2', status: 'pending' },
          ],
          reviewNotes: [],
        },
      },
      {
        rel_path: '.agent-team/plans/archived.html',
        name: 'Archived Plan',
        stage: 'done',
        overview: 'Archived Overview',
        meta: {
          schemaVersion: 1,
          name: 'Archived Plan',
          overview: 'Archived Overview',
          stage: 'done',
          archivedAt: '2026-09-01T00:00:00Z',
          todos: [],
          reviewNotes: [],
        },
      },
    ]
    state.documents[existingPath] = {
      rel_path: existingPath,
      meta: state.list[0].meta,
      html: '<html><body>Content</body></html>',
    }
    state.documents['.agent-team/plans/archived.html'] = {
      rel_path: '.agent-team/plans/archived.html',
      meta: state.list[1].meta,
      html: '<html><body>Archived</body></html>',
    }

    const view = await mountPlans()

    // 1. Recent row chip has localized label
    const recentChip = view.find('.plan-row--compact .plan-chip--stage-approved')
    expect(recentChip.exists()).toBe(true)
    expect(recentChip.text()).toBe('pane.plans.stage-approved')

    // 2. Grouped row chip has localized label
    const groupedChip = view.find('.plans-section .plan-row:not(.plan-row--compact) .plan-chip--stage-approved')
    expect(groupedChip.exists()).toBe(true)
    expect(groupedChip.text()).toBe('pane.plans.stage-approved')

    // 3. Archived row chip has localized label
    const archivedChip = view.find('.plan-row--done .plan-chip--stage-done')
    expect(archivedChip.exists()).toBe(true)
    expect(archivedChip.text()).toBe('pane.plans.stage-done')

    // 4. Progress bar width formatted as percentage
    const fillEl = view.find('.plan-toolbar-progress + .plan-progress-bar .plan-progress-fill')
    expect(fillEl.exists()).toBe(true)
    expect(fillEl.attributes('style')).toContain('width: 50%;')
  })

  it('decouples openInEditor so clicking open-in-editor invokes capability without mutating selectedPath', async () => {
    state.list = [
      {
        rel_path: existingPath,
        name: 'Plan A',
        stage: 'draft',
        meta: { schemaVersion: 1, name: 'Plan A', overview: '', stage: 'draft', todos: [], reviewNotes: [] },
      },
    ]
    state.documents[existingPath] = {
      rel_path: existingPath,
      meta: state.list[0].meta,
      html: '<html><body>A</body></html>',
    }

    const capabilityCalls: Array<{ namespace: string; method: string; args: Record<string, unknown> }> = []
    state.callCapability.mockImplementation(async (namespace: string, method: string, args: Record<string, unknown>) => {
      capabilityCalls.push({ namespace, method, args })
      return { opened: true }
    })

    const view = await mountPlans()
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Plan A')

    await view.get('.plan-row').trigger('contextmenu', { clientX: 50, clientY: 50 })
    const openEditorBtn = view.findAll('.context-menu button').find(button => button.text() === 'action.open-in-editor')!
    await openEditorBtn.trigger('click')
    await flushPromises()

    expect(capabilityCalls).toContainEqual({
      namespace: 'ui',
      method: 'openInEditor',
      args: { path: existingPath },
    })
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Plan A')
  })
})
