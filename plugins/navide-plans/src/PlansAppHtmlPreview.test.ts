// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  target: null as ((value: Record<string, string>) => void) | null,
  capability: vi.fn(),
  backend: vi.fn(),
  subscribe: vi.fn(),
  list: [] as Array<Record<string, unknown>>,
}))

let PlansApp: any
let wrapper: VueWrapper | null = null
const planPath = '.agent-team/plans/plan_a1b2c3.html'

beforeAll(async () => {
  vi.doMock('@navide/plugin-ui', () => ({
    SafeAiCliPanel: { name: 'SafeAiCliPanel', template: '<div data-test="ai-panel" />' },
    createAiCliSessionController: vi.fn(() => ({ dispose: vi.fn() })),
  }))
  vi.doMock('@navide/plugin-ui/foundation', () => ({
    useNotify: () => ({ toast: vi.fn(), confirm: vi.fn(async () => true), dialog: { value: null } }),
    useTheme: () => ({ loadTheme: vi.fn() }),
    vTruncate: {},
  }))
  vi.doMock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, te: () => false }) }))
  vi.doMock('@navide/plugin-sdk', () => ({
    createPluginBackendClient: () => ({
      call: state.backend,
      subscribe: state.subscribe,
    }),
    createPluginViewRuntimeClient: () => ({
      onOpenTarget: (listener: (value: Record<string, string>) => void) => {
        state.target = listener
        return { dispose: vi.fn() }
      },
    }),
    createPluginCapabilityClient: () => ({ capabilities: { invoke: state.capability } }),
  }))
  window.history.replaceState({}, '', '/?workspace_path=%2Fworkspace')
  PlansApp = (await import('./PlansApp.vue')).default
})

beforeEach(() => {
  window.history.replaceState({}, '', '/?workspace_path=%2Fworkspace')
  state.target = null
  state.list = [{
    rel_path: planPath,
    name: 'Plan',
    meta: { name: 'Plan', stage: 'draft', todos: [], reviewNotes: [] },
  }]
  state.capability.mockReset().mockResolvedValue({ found: false })
  state.backend.mockReset().mockImplementation(async (name: string) => {
    if (name === 'plans.list') return state.list
    if (name === 'plans.read') return {
      rel_path: planPath,
      meta: { name: 'Plan', stage: 'draft', todos: [], reviewNotes: [] },
      html: '<html><body>plan</body></html>',
    }
    return null
  })
  state.subscribe.mockReset().mockReturnValue({
    ready: Promise.resolve(), settled: Promise.resolve(), dispose: vi.fn(),
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
})

async function mountPlans(component = PlansApp): Promise<VueWrapper> {
  wrapper = mount(component, {
    attachTo: document.body,
    global: {
      stubs: {
        SafeAiCliPanel: true,
        NotificationHost: true,
        PlanReviewToolbar: {
          props: ['notes'],
          methods: { resetDocumentState: vi.fn() },
          template: '<div data-test="review-toolbar" />',
        },
        PlanMarkdownBody: true,
        HtmlFilePreview: { props: ['path', 'name'], template: '<div data-test="html-preview" />' },
      },
    },
  })
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('PlansApp HTML filepath preview', () => {
  it('previews an in-workspace .htm target and hides it when a plan target arrives', async () => {
    const view = await mountPlans()
    expect(state.target).toBeTypeOf('function')

    state.target!({ workspace_path: '/workspace', filepath: '/workspace/reports/report.htm' })
    await nextTick()
    expect(view.find('[data-test="html-preview"]').exists()).toBe(true)
    expect(view.find('.prt').exists()).toBe(false)

    state.target!({ workspace_path: '/workspace', rel_path: planPath })
    await flushPromises()
    await nextTick()
    expect(view.find('[data-test="html-preview"]').exists()).toBe(false)
    expect(view.find('[data-test="review-toolbar"]').exists()).toBe(true)
  })

  it('switches a plan to a canonical in-workspace HTML target without stale plan actions', async () => {
    const view = await mountPlans()
    state.target!({ workspace_path: '/workspace', rel_path: planPath })
    await flushPromises()
    await nextTick()
    expect(view.find('[data-test="review-toolbar"]').exists()).toBe(true)

    state.target!({ workspace_path: '/workspace', filepath: '/workspace/docs/page.html' })
    await nextTick()
    expect(view.find('[data-test="html-preview"]').exists()).toBe(true)
    expect(view.find('[data-test="review-toolbar"]').exists()).toBe(false)
    expect(view.find('.plan-main-body').exists()).toBe(false)
  })

  it('closes a stale rename dialog when switching to an HTML target', async () => {
    const view = await mountPlans()
    state.target!({ workspace_path: '/workspace', rel_path: planPath })
    await flushPromises()
    await nextTick()

    await view.get('.plan-row').trigger('contextmenu', { clientX: 50, clientY: 50 })
    await view.findAll('.context-menu button').find(button => button.text() === 'action.rename')!.trigger('click')
    expect(view.find('.rename-dialog').exists()).toBe(true)

    state.target!({ workspace_path: '/workspace', filepath: '/workspace/docs/page.html' })
    await nextTick()

    expect(view.find('.rename-dialog').exists()).toBe(false)
    expect(state.backend.mock.calls.some(([name]) => name === 'plans.rename')).toBe(false)
  })

  it('ignores an HTML filepath outside the canonical workspace', async () => {
    const view = await mountPlans()
    state.target!({ workspace_path: '/workspace', filepath: '/other/page.html' })
    await nextTick()
    expect(view.find('[data-test="html-preview"]').exists()).toBe(false)
    expect(view.find('.plan-window-empty').exists()).toBe(true)
  })

  it('renders a fresh initial canonical HTML filepath before preference restoration', async () => {
    wrapper?.unmount()
    wrapper = null
    vi.resetModules()
    window.history.replaceState({}, '', '/?workspace_path=%2Fworkspace&filepath=%2Fworkspace%2Fdocs%2Ffresh.html')
    const FreshPlansApp = (await import('./PlansApp.vue')).default
    const view = await mountPlans(FreshPlansApp)
    expect(view.find('[data-test="html-preview"]').exists()).toBe(true)
    expect(view.find('.plan-window-empty').exists()).toBe(false)
  })
})
