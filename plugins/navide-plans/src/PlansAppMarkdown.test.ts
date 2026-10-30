// @vitest-environment happy-dom
// Markdown carrier coverage for the packaged Plans plugin: a `.plan.md` renders
// its document body with editable sections and clickable frontmatter todos, and
// a plain `.md` renders its prose. The HTML carrier is covered by PlansApp.test.ts.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { parsePlanMeta } from './retained/usePlanFile'

const state = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  mtimes: {} as Record<string, number>,
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  loadTheme: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(async () => true),
}))

const planPath = '.agent-team/plans/markdown-plan.plan.md'
const documentPath = '.agent-team/plans/field-notes.md'

const planFixture = [
  '---',
  'name: Markdown plan',
  'overview: Overview sentence',
  'stage: in-review',
  'todos:',
  '  - id: todo-1',
  '    content: First task',
  '    status: pending',
  '---',
  '',
  '## Goals',
  '',
  'Ship the **markdown body** renderer.',
  '',
  '- rendered bullet',
  '',
  '## Risks',
  '',
  'Nothing renders today.',
  '',
].join('\n')

const documentFixture = [
  '# Field notes',
  '',
  'Plain prose that must be visible.',
  '',
  '- plain bullet',
  '',
].join('\n')

let PlansApp: any
let wrapper: VueWrapper | null = null

function writes(): Array<Record<string, unknown>> {
  return state.calls.filter((call) => call.name === 'plans.write_document').map((call) => call.args)
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
  window.history.replaceState({}, '', `/?workspace_path=%2Fworkspace&rel_path=${encodeURIComponent(planPath)}`)
  PlansApp = (await import('./PlansApp.vue')).default
})

beforeEach(() => {
  window.history.replaceState({}, '', `/?workspace_path=%2Fworkspace&rel_path=${encodeURIComponent(planPath)}`)
  state.calls.length = 0
  state.files = { [planPath]: planFixture, [documentPath]: documentFixture }
  state.mtimes = { [planPath]: 1, [documentPath]: 1 }
  state.toast.mockReset()
  state.confirm.mockReset()
  state.confirm.mockResolvedValue(true)

  vi.stubGlobal('nav', {
    ready: vi.fn(),
    onOpenTarget: vi.fn(() => vi.fn()),
    callCapability: async (namespace: string, method: string, args: Record<string, unknown>) => {
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
          result: Object.entries(state.files).map(([path, content]) => {
            const meta = parsePlanMeta(content)
            return {
              rel_path: path,
              name: meta?.name ?? path.split('/').pop(),
              stage: meta?.stage ?? null,
              overview: meta?.overview ?? '',
              mtime: state.mtimes[path],
              kind: meta ? 'plan' : 'document',
              meta,
            }
          }),
        }
      }
      if (name === 'plans.read') {
        const content = state.files[relPath]
        return {
          reqId,
          ok: true,
          result: {
            rel_path: relPath,
            meta: parsePlanMeta(content ?? ''),
            html: content,
            mtime: state.mtimes[relPath],
          },
        }
      }
      if (name === 'plans.read_document') {
        return {
          reqId,
          ok: true,
          result: { ok: true, content: state.files[relPath], mtime: state.mtimes[relPath] },
        }
      }
      if (name === 'plans.write_document') {
        state.files[relPath] = String(args.content)
        state.mtimes[relPath] = (state.mtimes[relPath] ?? 0) + 1
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

describe('PlansApp markdown carrier', () => {
  it('renders the body of a markdown plan instead of only an overview and a todo list', async () => {
    const view = await mountPlans()

    expect(view.find('.plan-markdown-container').exists()).toBe(true)
    expect(view.find('.plan-fallback-container').exists()).toBe(false)

    const headings = view.findAll('.pmb-section-title').map((node) => node.text())
    expect(headings).toContain('Goals')
    expect(headings).toContain('Risks')

    const body = view.get('.pmb').text()
    expect(body).toContain('Ship the')
    expect(body).toContain('markdown body')
    expect(body).toContain('Nothing renders today.')
    expect(view.findAll('.pmb-line--bullet').map((node) => node.text())).toContain('rendered bullet')
    // The markdown line renderer produced real inline markup, not escaped text.
    expect(view.get('.pmb-doc-body').html()).toContain('<strong>markdown body</strong>')
  })

  it('round-trips a section edit as markdown text, never as sanitized HTML', async () => {
    const view = await mountPlans()

    const goals = view.findAll('.pmb-section').find((section) => section.get('.pmb-section-title').text() === 'Goals')!
    await goals.findAll('.pmb-btn').find((button) => button.text() === 'pane.plans.edit')!.trigger('click')
    await nextTick()
    await goals.get('textarea.pmb-textarea').setValue('Rewritten **bold** body.\n\n- kept bullet')
    await goals.findAll('.pmb-btn').find((button) => button.text() === 'pane.plans.save')!.trigger('click')
    await flushPromises()

    const written = writes()
    expect(written).toHaveLength(1)
    const content = String(written[0].content)
    expect(content).toContain('## Goals\n\nRewritten **bold** body.\n\n- kept bullet')
    expect(content).not.toContain('<p>')
    expect(content).not.toContain('&lt;')
    // The untouched section and the frontmatter survive the surgical write.
    expect(content).toContain('## Risks')
    expect(content).toContain('name: Markdown plan')
  })

  it('offers both versions when the section changed on disk during the edit', async () => {
    const view = await mountPlans()

    const goals = view.findAll('.pmb-section').find((section) => section.get('.pmb-section-title').text() === 'Goals')!
    await goals.findAll('.pmb-btn').find((button) => button.text() === 'pane.plans.edit')!.trigger('click')
    await nextTick()
    // An agent rewrites the same section while the textarea is open.
    state.files[planPath] = state.files[planPath].replace(/## Goals\n\n[^#]*/, '## Goals\n\nAgent goals.\n\n')
    state.mtimes[planPath] += 1
    await goals.get('textarea.pmb-textarea').setValue('My goals.')
    await goals.findAll('.pmb-btn').find((button) => button.text() === 'pane.plans.save')!.trigger('click')
    await flushPromises()

    expect(writes()).toHaveLength(0)
    expect(view.get('.scd-dialog [data-side="mine"] textarea').element.value).toBe('My goals.')
    expect(view.get('.scd-dialog [data-side="theirs"] textarea').element.value).toContain('Agent goals.')

    await view.get('.scd-keep-mine').trigger('click')
    await flushPromises()
    expect(writes()).toHaveLength(1)
    expect(String(writes()[0].content)).toContain('## Goals\n\nMy goals.')
    expect(String(writes()[0].content)).not.toContain('Agent goals.')
    expect(view.get('.scd-dialog [data-side="theirs"] textarea').element.value).toContain('Agent goals.')
  })

  it('cycles an in-document todo from the rendered body', async () => {
    const view = await mountPlans()

    const status = view.get('.pmb-todo-status')
    expect(status.text()).toBe('pending')
    await status.trigger('click')
    await flushPromises()

    const written = writes()
    expect(written).toHaveLength(1)
    expect(String(written[0].content)).toContain('status: in_progress')
    expect(String(written[0].content)).toContain('## Goals')
    await nextTick()
    expect(view.get('.pmb-todo-status').text()).toBe('in-progress')
  })

  it('renders the prose of a plain markdown document', async () => {
    window.history.replaceState({}, '', `/?workspace_path=%2Fworkspace&rel_path=${encodeURIComponent(documentPath)}`)
    const view = await mountPlans()

    expect(view.find('.plan-markdown-container').exists()).toBe(true)
    // A plain document carries no plan metadata, so no review toolbar.
    expect(view.find('.prt').exists()).toBe(false)

    const body = view.get('.pmb').text()
    expect(body).toContain('Field notes')
    expect(body).toContain('Plain prose that must be visible.')
    expect(view.findAll('.pmb-line--bullet').map((node) => node.text())).toContain('plain bullet')
  })
})
