// @vitest-environment happy-dom
// Share-link entry in the Plan view toolbar. The button exists only once the
// Host's `ui.shareCaps` answers `{ ok: true }`: any failure (no Cloud link, an
// old Host, a server without links) leaves the toolbar exactly as it was.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { _resetKeybindingsState, _resetRegistry } from '@navide/plugin-ui/shared/testing'

type CapabilityResponse = { reqId: string; ok: boolean; result?: unknown; error?: { code: string; message?: string } }

const state = vi.hoisted(() => ({
  shareCaps: null as null | (() => Promise<CapabilityResponse>),
  shareCreate: null as null | ((args: Record<string, unknown>) => Promise<CapabilityResponse>),
  shareChatTargets: null as null | (() => Promise<CapabilityResponse>),
  capabilityCalls: [] as Array<{ address: string; args: Record<string, unknown> }>,
  loadTheme: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(async () => true),
}))

const planPath = '.agent-team/plans/alpha-plan_a1b2c3.html'
const betaPath = '.agent-team/plans/beta-plan_d4e5f6.html'
const planMeta = {
  schemaVersion: 1,
  name: 'Alpha plan',
  overview: 'Overview sentence',
  stage: 'in-review',
  approvedAt: null,
  archivedAt: null,
  todos: [{ id: 't1', content: 'First', status: 'pending' }],
  reviewNotes: [],
}

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
}, 30_000)

beforeEach(() => {
  _resetRegistry()
  _resetKeybindingsState()
  window.history.replaceState({}, '', `/?workspace_path=%2Fworkspace&rel_path=${encodeURIComponent(planPath)}`)
  state.capabilityCalls.length = 0
  state.shareCaps = null
  state.shareCreate = null
  state.shareChatTargets = null

  vi.stubGlobal('nav', {
    ready: vi.fn(),
    onOpenTarget: vi.fn(() => vi.fn()),
    callCapability: async (namespace: string, method: string, args: Record<string, unknown>) => {
      const address = `${namespace}.${method}`
      state.capabilityCalls.push({ address, args })
      if (address === 'storage.get') return { reqId: 'storage', ok: true, result: { found: false } }
      if (address === 'ui.shareCaps' && state.shareCaps) return state.shareCaps()
      if (address === 'ui.shareCreate' && state.shareCreate) return state.shareCreate(args)
      if (address === 'ui.shareChatTargets' && state.shareChatTargets) return state.shareChatTargets()
      return { reqId: 'capability', ok: true, result: { opened: true } }
    },
    on: vi.fn(() => vi.fn()),
    callBackend: async (reqId: string, name: string, args: Record<string, unknown>) => {
      if (name === 'plans.list') {
        return {
          reqId,
          ok: true,
          result: [
            { rel_path: planPath, name: planMeta.name, stage: planMeta.stage, overview: planMeta.overview, mtime: 1, kind: 'plan', meta: planMeta },
            { rel_path: betaPath, name: 'Beta plan', stage: planMeta.stage, overview: planMeta.overview, mtime: 1, kind: 'plan', meta: { ...planMeta, name: 'Beta plan' } },
          ],
        }
      }
      if (name === 'plans.read') {
        return { reqId, ok: true, result: { rel_path: String(args.rel_path), meta: planMeta, html: '<html><body>alpha</body></html>', mtime: 1 } }
      }
      if (name === 'plans.read_document') {
        return {
          reqId,
          ok: true,
          result: { ok: true, content: `<script id="plan-meta" type="application/json">${JSON.stringify(planMeta)}</script><html><body>alpha</body></html>`, mtime: 1 },
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

function capsOk(): void {
  state.shareCaps = async () => ({ reqId: 'caps', ok: true, result: { ok: true } })
}

function toolbarHtml(view: VueWrapper): string {
  return view.find('.prt-bar').html()
}

describe('Plan view — share link', () => {
  it('shows no share button and leaves the toolbar unchanged when share caps fail', async () => {
    // Baseline: the Host never answers caps, so the feature never appears.
    state.shareCaps = () => new Promise<CapabilityResponse>(() => {})
    const baseline = toolbarHtml(await mountPlans())
    wrapper!.unmount()
    wrapper = null

    for (const failure of [
      async () => ({ reqId: 'caps', ok: true, result: { ok: false, code: 'NOT_CONFIGURED', message: 'not linked' } }),
      async () => ({ reqId: 'caps', ok: true, result: { ok: false, code: 'UNKNOWN_TYPE', message: 'old server' } }),
      async () => ({ reqId: 'caps', ok: false, error: { code: 'METHOD_NOT_FOUND', message: 'old host' } }),
      async () => { throw new Error('bridge down') },
    ] as Array<() => Promise<CapabilityResponse>>) {
      state.shareCaps = failure
      const view = await mountPlans()
      expect(view.find('[data-test="plan-share-btn"]').exists()).toBe(false)
      expect(document.querySelector('[data-test="plan-share-dialog"]')).toBeNull()
      expect(toolbarHtml(view)).toBe(baseline)
      wrapper!.unmount()
      wrapper = null
    }
    expect(state.capabilityCalls.some(call => call.address === 'ui.shareCreate')).toBe(false)
  })

  it('creates a link with the chosen expiry and shows the URL and the masked summary', async () => {
    capsOk()
    state.shareCreate = async () => ({
      reqId: 'create',
      ok: true,
      result: {
        ok: true,
        link: {
          linkId: 'l1',
          url: 'https://share.example/l/l1#k',
          expiresAt: '2026-10-14T00:00:00Z',
          createdBy: 'user',
          masked: [{ line: 132, category: 'github-token', action: 'masked' }],
        },
      },
    })
    const view = await mountPlans()
    const button = view.find('[data-test="plan-share-btn"]')
    expect(button.exists()).toBe(true)
    await button.trigger('click')
    await nextTick()

    const dialog = document.querySelector('[data-test="plan-share-dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()
    const ttl = dialog.querySelector('[data-test="plan-share-ttl"]') as HTMLSelectElement
    expect(ttl.value).toBe('7')
    ttl.value = '3'
    ttl.dispatchEvent(new Event('change'))
    const login = dialog.querySelector('[data-test="plan-share-login"]') as HTMLInputElement
    login.checked = true
    login.dispatchEvent(new Event('change'))
    await nextTick()
    ;(dialog.querySelector('[data-test="plan-share-create"]') as HTMLButtonElement).click()
    await flushPromises()

    const create = state.capabilityCalls.find(call => call.address === 'ui.shareCreate')
    expect(create?.args).toEqual({ path: planPath, ttlSeconds: 3 * 86400, requireLogin: true, sendToChat: false })
    const url = document.querySelector('[data-test="plan-share-url"]') as HTMLInputElement
    expect(url.value).toBe('https://share.example/l/l1#k')
    expect(document.querySelector('[data-test="plan-share-copy"]')).not.toBeNull()
    const masked = document.querySelector('[data-test="plan-share-masked"]')!.textContent ?? ''
    expect(masked).toContain('132')
    expect(masked).toContain('github-token')
  })

  it('leaves send-to-chat unchecked and needs an explicit chat before sending', async () => {
    capsOk()
    state.shareChatTargets = async () => ({
      reqId: 'targets',
      ok: true,
      result: { ok: true, chats: [
        { chatId: 'tg:111', platform: 'telegram', name: 'Neil DM' },
        { chatId: 'dc:222', platform: 'discord', name: 'Ops DM' },
      ] },
    })
    state.shareCreate = async () => ({ reqId: 'create', ok: true, result: { ok: false, code: 'NO_SYNC_KEY', message: 'no key' } })
    const view = await mountPlans()
    await view.find('[data-test="plan-share-btn"]').trigger('click')
    await nextTick()
    const chat = document.querySelector('[data-test="plan-share-chat"]') as HTMLInputElement
    expect(chat.checked).toBe(false)
    expect(document.querySelector('[data-test="plan-share-chat-target"]')).toBeNull()

    chat.checked = true
    chat.dispatchEvent(new Event('change'))
    await flushPromises()
    const target = document.querySelector('[data-test="plan-share-chat-target"]') as HTMLSelectElement
    expect(target).not.toBeNull()
    const labels = Array.from(target.options).filter(option => option.value).map(option => option.textContent ?? '')
    expect(labels).toHaveLength(2)
    expect(labels[0]).toContain('telegram')
    expect(labels[0]).toContain('Neil DM')
    const create = document.querySelector('[data-test="plan-share-create"]') as HTMLButtonElement
    expect(create.disabled).toBe(true)
    create.click()
    await flushPromises()
    expect(state.capabilityCalls.some(call => call.address === 'ui.shareCreate')).toBe(false)

    target.value = 'dc:222'
    target.dispatchEvent(new Event('change'))
    await nextTick()
    expect(create.disabled).toBe(false)
    create.click()
    await flushPromises()
    const sent = state.capabilityCalls.filter(call => call.address === 'ui.shareCreate')
    expect(sent).toHaveLength(1)
    expect(sent[0].args).toMatchObject({ sendToChat: true, chatId: 'dc:222' })
  })

  it('cannot send to a chat when no direct-message chat is bound', async () => {
    capsOk()
    state.shareChatTargets = async () => ({ reqId: 'targets', ok: true, result: { ok: true, chats: [] } })
    const view = await mountPlans()
    await view.find('[data-test="plan-share-btn"]').trigger('click')
    await nextTick()
    const chat = document.querySelector('[data-test="plan-share-chat"]') as HTMLInputElement
    chat.checked = true
    chat.dispatchEvent(new Event('change'))
    await flushPromises()

    expect(document.querySelector('[data-test="plan-share-chat-empty"]')).not.toBeNull()
    expect(document.querySelector('[data-test="plan-share-chat-target"]')).toBeNull()
    const create = document.querySelector('[data-test="plan-share-create"]') as HTMLButtonElement
    expect(create.disabled).toBe(true)
    create.click()
    await flushPromises()
    expect(state.capabilityCalls.some(call => call.address === 'ui.shareCreate')).toBe(false)
  })

  it('keeps a late caps answer for the previous plan off the plan now open', async () => {
    const answers: Array<(response: CapabilityResponse) => void> = []
    state.shareCaps = () => new Promise<CapabilityResponse>(resolve => { answers.push(resolve) })
    const view = await mountPlans()
    expect(answers).toHaveLength(1)

    const beta = view.findAll('.plan-row').find(row => row.text().includes('Beta plan'))!
    await beta.trigger('click')
    await flushPromises()
    expect(answers).toHaveLength(2)

    answers[1]({ reqId: 'caps-beta', ok: true, result: { ok: false, code: 'NOT_CONFIGURED', message: 'offline' } })
    await flushPromises()
    answers[0]({ reqId: 'caps-alpha', ok: true, result: { ok: true } })
    await flushPromises()

    expect(view.find('[data-test="plan-share-btn"]').exists()).toBe(false)
  })

  it('shows the refusal reason when the share is refused', async () => {
    capsOk()
    state.shareCreate = async () => ({
      reqId: 'create',
      ok: true,
      result: { ok: false, code: 'SHARE_REFUSED', message: 'Agent memory files are never shared.', reason: 'memory' },
    })
    const view = await mountPlans()
    await view.find('[data-test="plan-share-btn"]').trigger('click')
    await nextTick()
    ;(document.querySelector('[data-test="plan-share-create"]') as HTMLButtonElement).click()
    await flushPromises()

    const error = document.querySelector('[data-test="plan-share-error"]')!.textContent ?? ''
    expect(error).toContain('Agent memory files are never shared.')
    expect(document.querySelector('[data-test="plan-share-url"]')).toBeNull()
  })

  it('shows a server or key error code as it came back', async () => {
    capsOk()
    state.shareCreate = async () => ({
      reqId: 'create',
      ok: true,
      result: { ok: false, code: 'NO_SYNC_KEY', message: 'no key' },
    })
    const view = await mountPlans()
    await view.find('[data-test="plan-share-btn"]').trigger('click')
    await nextTick()
    ;(document.querySelector('[data-test="plan-share-create"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(document.querySelector('[data-test="plan-share-error"]')!.textContent).toContain('NO_SYNC_KEY')
  })
})
