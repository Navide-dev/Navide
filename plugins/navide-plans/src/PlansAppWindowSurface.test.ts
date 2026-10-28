// @vitest-environment happy-dom
// Window-level coverage for the packaged Plans plugin: the capabilities v1's
// PlanWindowApp owned outside the list and the document body — participation in
// the Host's shared keybinding rule table, the last-opened plan pointer that
// makes the Window menu reopen onto the document you were in, and the embedded
// CLI agent panel with its automatic plan-context injection. The list surface is
// covered by PlansAppListSurface.test.ts and the document preview by
// PlansApp.test.ts / PlansAppMarkdown.test.ts; this file keeps its own harness
// rather than widening a shared one.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { executeCommand, hasCommand } from '@navide/plugin-ui/shared'
import { _resetKeybindingsState, _resetRegistry } from '@navide/plugin-ui/shared/testing'

interface FixtureMeta {
  schemaVersion: number
  name: string
  overview: string
  stage: string
  approvedAt: string | null
  archivedAt: string | null
  todos: Array<{ id: string; content: string; status: string }>
  reviewNotes: never[]
}

const state = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  metas: {} as Record<string, unknown>,
  storage: {} as Record<string, unknown>,
  sets: [] as Array<{ key: string; value: unknown }>,
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  loadTheme: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(async () => true),
}))

const alphaPath = '.agent-team/plans/alpha-plan_a1b2c3.html'
const betaPath = '.agent-team/plans/beta-plan_d4e5f6.html'
const missingPath = '.agent-team/plans/deleted-plan_999999.html'

function meta(name: string, overrides: Partial<FixtureMeta> = {}): FixtureMeta {
  return {
    schemaVersion: 1,
    name,
    overview: 'Overview sentence',
    stage: 'in-review',
    approvedAt: null,
    archivedAt: null,
    todos: [
      { id: 't1', content: 'First', status: 'done' },
      { id: 't2', content: 'Second', status: 'pending' },
    ],
    reviewNotes: [],
    ...overrides,
  }
}

/** Records the `buildContext` the window hands the embedded CLI panel, which
 *  is the only place the injected briefing is observable from outside. */
const aiPanelStub = {
  name: 'SafeAiCliPanel',
  props: {
    controller: { type: Object, required: false, default: null },
    buildContext: { type: Function, required: false, default: null },
    widthKey: { type: String, required: false, default: undefined },
  },
  template: '<div data-test="ai-panel" />',
}

let PlansApp: any
let wrapper: VueWrapper | null = null

beforeAll(async () => {
  vi.doMock('@navide/plugin-ui', () => ({
    SafeAiCliPanel: aiPanelStub,
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
  _resetRegistry()
  _resetKeybindingsState()
  window.history.replaceState({}, '', '/?workspace_path=%2Fworkspace')
  state.calls.length = 0
  state.sets.length = 0
  state.storage = {}
  state.toast.mockReset()
  state.confirm.mockReset()
  state.confirm.mockResolvedValue(true)

  state.files = {
    [alphaPath]: '<html><body>alpha body</body></html>',
    [betaPath]: '<html><body>beta body</body></html>',
  }
  state.metas = {
    [alphaPath]: meta('Alpha plan'),
    [betaPath]: meta('Beta plan', { stage: 'approved' }),
  }

  vi.stubGlobal('nav', {
    ready: vi.fn(),
    onOpenTarget: vi.fn(() => vi.fn()),
    callCapability: async (namespace: string, method: string, args: Record<string, unknown>) => {
      if (namespace === 'storage' && method === 'get') {
        const key = String(args.key)
        return key in state.storage
          ? { reqId: 'storage', ok: true, result: { found: true, value: state.storage[key] } }
          : { reqId: 'storage', ok: true, result: { found: false } }
      }
      if (namespace === 'storage' && method === 'set') {
        state.storage[String(args.key)] = args.value
        state.sets.push({ key: String(args.key), value: args.value })
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
            const parsed = state.metas[path] as FixtureMeta
            return {
              rel_path: path,
              name: parsed.name,
              stage: parsed.stage,
              overview: parsed.overview,
              mtime: 1,
              kind: 'plan',
              meta: parsed,
            }
          }),
        }
      }
      if (name === 'plans.read') {
        if (!(relPath in state.files)) {
          return { reqId, ok: false, error: { code: 'BACKEND_ERROR', message: 'no such plan' } }
        }
        return {
          reqId,
          ok: true,
          result: {
            rel_path: relPath,
            meta: state.metas[relPath],
            html: state.files[relPath],
            mtime: 1,
          },
        }
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
  _resetRegistry()
  _resetKeybindingsState()
  vi.restoreAllMocks()
})

async function mountPlans(): Promise<VueWrapper> {
  wrapper = mount(PlansApp, { attachTo: document.body })
  await flushPromises()
  await nextTick()
  await flushPromises()
  return wrapper
}

describe('Plans window — Host keybinding participation', () => {
  it('registers the window commands v1 registered', async () => {
    await mountPlans()
    for (const command of [
      'workbench.action.quickOpen',
      'workbench.action.closeWindow',
      'workbench.action.reloadWindow',
      'workbench.action.closeModal',
    ]) {
      expect(hasCommand(command), command).toBe(true)
    }
  })

  it('opens quick open when the registered command fires, however it is bound', async () => {
    const view = await mountPlans()
    expect(view.find('.quick-open').exists()).toBe(false)

    expect(executeCommand('workbench.action.quickOpen')).toBe(true)
    await nextTick()

    expect(view.find('.quick-open').exists()).toBe(true)
  })

  it('closes and reloads the window from the registered commands', async () => {
    await mountPlans()
    const close = vi.fn()
    const reload = vi.fn()
    vi.stubGlobal('close', close)
    // window.location has no restorable spy target here, so swap the whole
    // object and put the real one back — later cases read location.search.
    const originalLocation = Object.getOwnPropertyDescriptor(window, 'location')!
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload, search: window.location.search },
    })
    try {
      expect(executeCommand('workbench.action.closeWindow')).toBe(true)
      expect(close).toHaveBeenCalledTimes(1)

      expect(executeCommand('workbench.action.reloadWindow')).toBe(true)
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', originalLocation)
    }
  })

  it('routes a real Escape keystroke through the shared rule table', async () => {
    const view = await mountPlans()
    expect(executeCommand('workbench.action.quickOpen')).toBe(true)
    await nextTick()
    expect(view.find('.quick-open').exists()).toBe(true)

    // Not a direct handler call: the shipped `planWindow` ESC rule has to
    // resolve, which only happens when the window declared that context and
    // installed the shared dispatcher.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(view.find('.quick-open').exists()).toBe(false)
  })

  it('closes the window once nothing is left to peel', async () => {
    await mountPlans()
    const close = vi.fn()
    vi.stubGlobal('close', close)

    expect(executeCommand('workbench.action.closeModal')).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('Plans window — last opened plan', () => {
  it('reopens the stored plan when launched without one', async () => {
    state.storage['plans.last-opened'] = betaPath
    const view = await mountPlans()

    expect(state.calls.filter((call) => call.name === 'plans.read')).toEqual([
      { name: 'plans.read', args: { rel_path: betaPath } },
    ])
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Beta plan')
  })

  it('records the plan that was actually opened', async () => {
    const view = await mountPlans()
    expect(state.sets).toEqual([])

    const row = view
      .findAll('.plan-row')
      .find((candidate) => candidate.find('.plan-row-path').text() === alphaPath)
    await row!.trigger('click')
    await flushPromises()

    expect(state.sets).toContainEqual({ key: 'plans.last-opened', value: alphaPath })
  })

  it('opens empty, without an error, when the stored plan no longer exists', async () => {
    state.storage['plans.last-opened'] = missingPath
    const view = await mountPlans()

    expect(state.calls.filter((call) => call.name === 'plans.read')).toEqual([])
    expect(view.find('.pdp-error').exists()).toBe(false)
    expect(state.toast).not.toHaveBeenCalled()
    expect(view.find('.plan-window-empty').exists()).toBe(true)
  })

  it('prefers the plan the window was launched with over the stored one', async () => {
    state.storage['plans.last-opened'] = betaPath
    window.history.replaceState(
      {},
      '',
      `/?workspace_path=%2Fworkspace&rel_path=${encodeURIComponent(alphaPath)}`,
    )
    const view = await mountPlans()

    expect(state.calls.filter((call) => call.name === 'plans.read')).toEqual([
      { name: 'plans.read', args: { rel_path: alphaPath } },
    ])
    expect(view.get('.selected-document').attributes('aria-label')).toBe('Alpha plan')
  })
})

describe('Plans window — embedded CLI agent panel', () => {
  it('mounts the panel instead of leaving it behind unreachable state', async () => {
    const view = await mountPlans()
    expect(view.find('[data-test="ai-panel"]').exists()).toBe(true)
  })

  it('injects the open plan as the spawned agent context', async () => {
    state.storage['plans.last-opened'] = alphaPath
    const view = await mountPlans()

    const buildContext = view.findComponent({ name: 'SafeAiCliPanel' }).props('buildContext') as
      | (() => string)
      | null
    expect(buildContext).toBeTypeOf('function')
    const context = buildContext!()

    expect(context).toContain('Workspace: /workspace')
    expect(context).toContain(`Currently open document: ${alphaPath}`)
    expect(context).toContain('Plan name: Alpha plan')
    expect(context).toContain('Stage: in-review')
    expect(context).toContain('Todos: 2 total (1 done, 1 pending)')
    expect(context).toContain('alpha body')
  })

  it('says so plainly when no plan is open', async () => {
    const view = await mountPlans()
    const buildContext = view.findComponent({ name: 'SafeAiCliPanel' }).props('buildContext') as () => string
    expect(buildContext()).toContain('No plan document is currently open.')
  })

  it('keeps its own width setting instead of sharing the Git window\'s', async () => {
    const view = await mountPlans()
    expect(view.findComponent({ name: 'SafeAiCliPanel' }).props('widthKey')).toBe('plans-ai-panel-width')
  })

  // The panel sizes itself (resizable, 42px collapsed). A fixed width on the
  // wrapping aside left a blank strip beside the collapsed panel and squeezed
  // the document frame.
  it('gives the aside around the panel no width of its own', () => {
    const source = import.meta.glob<string>('./PlansApp.vue', { query: '?raw', import: 'default', eager: true })['./PlansApp.vue']
    const style = source.slice(source.lastIndexOf('<style'))
    const rules = [...style.matchAll(/\.ai-sidebar\s*\{([^}]*)\}/g)].map((m) => m[1])
    expect(rules.length).toBeGreaterThan(0)
    for (const body of rules) expect(body).not.toMatch(/(^|[\s;])(min-|max-)?width\s*:/)
  })
})

describe('Plans window — workspace title', () => {
  it('titles the window with the alias the Host resolved', async () => {
    window.history.replaceState(
      {},
      '',
      '/?workspace_path=%2FUsers%2Fdev%2Fprojects%2Fagent-team&workspace_display_name=Navide&contribution=window',
    )
    await mountPlans()
    expect(document.title).toBe('Navide — Plans')
  })

  it('falls back to the folder name when the alias is absent or blank', async () => {
    for (const search of [
      '/?workspace_path=%2FUsers%2Fdev%2Fprojects%2Fagent-team&contribution=window',
      '/?workspace_path=%2FUsers%2Fdev%2Fprojects%2Fagent-team&workspace_display_name=&contribution=window',
      '/?workspace_path=%2FUsers%2Fdev%2Fprojects%2Fagent-team&workspace_display_name=%20%20&contribution=window',
    ]) {
      document.title = 'untouched'
      window.history.replaceState({}, '', search)
      const view = await mountPlans()
      expect(document.title, search).toBe('agent-team — Plans')
      view.unmount()
    }
  })

  it('leaves the title alone for the embedded left contribution, which has none of its own', async () => {
    document.title = 'Navide'
    window.history.replaceState(
      {},
      '',
      '/?workspace_path=%2FUsers%2Fdev%2Fprojects%2Fagent-team&workspace_display_name=Navide&contribution=left',
    )
    await mountPlans()
    expect(document.title).toBe('Navide')
  })
})
