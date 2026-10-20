// @vitest-environment happy-dom
// Tests for the interactive plan preview host: the srcdoc iframe is built
// with allow-scripts sandbox, stripped document scripts, a CSP meta, and the
// injected runtime; a refresh bump reloads in place; messages that fail the
// source check never emit; outline navigation posts into the frame.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import PlanDocPreview from '../PlanDocPreview.vue'
import { i18n } from '@navide/plugin-ui/foundation'

i18n.global.locale.value = 'en-US'

const originalContentWindowDesc = Object.getOwnPropertyDescriptor(
  HTMLIFrameElement.prototype,
  'contentWindow',
)

beforeAll(() => {
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    get() {
      if (!this._mockContentWindow) {
        this._mockContentWindow = {
          postMessage: vi.fn(),
        } as unknown as Window
      }
      return this._mockContentWindow
    },
    configurable: true,
  })
})

afterAll(() => {
  if (originalContentWindowDesc) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', originalContentWindowDesc)
  } else {
    delete (HTMLIFrameElement.prototype as unknown as { contentWindow?: unknown }).contentWindow
  }
})

function getDocumentToken(wrapper: ReturnType<typeof mount>): string {
  const srcdoc = wrapper.find('iframe').attributes('srcdoc') ?? ''
  const match = srcdoc.match(/"documentToken":"([^"]+)"/)
  return match ? match[1] : ''
}

const PLAN_DOC = [
  '<!doctype html><html><head><title>t</title>',
  '<script type="application/json" id="plan-meta">',
  JSON.stringify({
    schemaVersion: 1,
    name: 'Test Plan',
    overview: '',
    stage: 'in-progress',
    approvedAt: null,
    todos: [{ id: 'phase-a', content: 'Phase A', status: 'pending' }],
    reviewNotes: [
      { id: 'n1', author: 'user', text: 'note', resolved: false, reply: '', anchor: 'Goals' },
    ],
  }),
  '</scr' + 'ipt>',
  '<script>alert("evil")</scr' + 'ipt>',
  '</head><body><section><h2>Goals</h2></section></body></html>',
].join('\n')

function makeBackend(content: string | null, status = 'connected') {
  return {
    httpUrl: ref('http://127.0.0.1:1'),
    status: ref(status),
    send: vi.fn(async (type: string) => {
      if (type === 'fs.read_file') {
        return content === null
          ? { payload: { ok: false, error: 'missing' } }
          : { payload: { ok: true, content } }
      }
      return { payload: { ok: true } }
    }),
  }
}

async function mountPreview(content: string | null = PLAN_DOC, status = 'connected') {
  const backend = makeBackend(content, status)
  const wrapper = mount(PlanDocPreview, {
    props: {
      workspacePath: '/ws',
      relPath: '.agent-team/plans/test-plan_a1b2c3.html',
      backend: backend as never,
      refresh: 0,
    },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return { wrapper, backend }
}

describe('PlanDocPreview', () => {
  it('renders a srcdoc iframe sandboxed to allow-scripts with the runtime injected', async () => {
    const { wrapper } = await mountPreview()
    const frame = wrapper.find('iframe')
    expect(frame.exists()).toBe(true)
    expect(frame.attributes('sandbox')).toBe('allow-scripts')
    // The main process keeps a frame by this name on its srcdoc (planFrameNavigation.ts).
    expect(frame.attributes('name')).toBe('navide-plan-doc')
    const srcdoc = frame.attributes('srcdoc') ?? ''
    // Document scripts are stripped, the data island survives, the CSP meta
    // and the nonce'd runtime are injected.
    expect(srcdoc).not.toContain('alert("evil")')
    expect(srcdoc).toContain('id="plan-meta"')
    expect(srcdoc).toContain('Content-Security-Policy')
    expect(srcdoc).toContain('todo-clicked')
    // The unresolved anchored note count is passed to the runtime.
    expect(srcdoc).toContain('"anchors":{"Goals":1}')
  })

  it('reloads the document and replaces iframe element when the refresh prop bumps', async () => {
    const { wrapper, backend } = await mountPreview()
    expect(backend.send).toHaveBeenCalledTimes(1)
    const before = wrapper.find('iframe').element

    await wrapper.setProps({ refresh: 1 })
    await flushPromises()

    expect(backend.send).toHaveBeenCalledTimes(2)
    expect(wrapper.find('iframe').element).not.toBe(before) // replaced via :key="currentDocumentToken ?? relPath"
  })

  it('shows the error state with the backend reason and resolved path', async () => {
    const { wrapper } = await mountPreview(null)
    expect(wrapper.find('iframe').exists()).toBe(false)
    const error = wrapper.find('.pdp-error')
    expect(error.text()).toContain('Failed to load the plan document')
    expect(error.find('.pdp-error-reason').text()).toBe('missing')
    expect(error.find('.pdp-error-path').text()).toContain(
      '/ws › .agent-team/plans/test-plan_a1b2c3.html',
    )
  })

  it('reads and renders even when the transport status is not connected', async () => {
    // The status is host-pushed and can be stale while calls still land (the
    // review toolbar reads the same file through the same send with no such
    // check). Gating on it rendered an empty srcdoc — indistinguishable from a
    // loaded plan, since the frame's background is white.
    const { wrapper, backend } = await mountPreview(PLAN_DOC, 'connecting')

    expect(backend.send).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.pdp-error').exists()).toBe(false)
    expect(wrapper.find('iframe').attributes('srcdoc') ?? '').toContain('id="plan-meta"')
  })

  it('retries a failed load on its own when no reconnect ever arrives', async () => {
    vi.useFakeTimers()
    try {
      const { wrapper, backend } = await mountPreview(null, 'disconnected')
      expect(backend.send).toHaveBeenCalledTimes(1)
      expect(wrapper.find('.pdp-error').exists()).toBe(true)

      backend.send.mockResolvedValue({ payload: { ok: true, content: PLAN_DOC } } as never)
      // No status transition at all — recovery must come from the backoff timer.
      await vi.advanceTimersByTimeAsync(1_000)
      await flushPromises()

      expect(backend.send).toHaveBeenCalledTimes(2)
      expect(wrapper.find('.pdp-error').exists()).toBe(false)
      expect(wrapper.find('iframe').exists()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying once the backoff budget is exhausted', async () => {
    vi.useFakeTimers()
    try {
      const { backend } = await mountPreview(null, 'disconnected')
      expect(backend.send).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(120_000)
      await flushPromises()

      // 1 initial + 5 scheduled attempts, then the error state stands.
      expect(backend.send).toHaveBeenCalledTimes(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a failed load when the backend reconnects', async () => {
    const { wrapper, backend } = await mountPreview(null)
    expect(wrapper.find('.pdp-error').exists()).toBe(true)

    backend.send.mockResolvedValue({ payload: { ok: true, content: PLAN_DOC } } as never)
    backend.status.value = 'disconnected'
    await flushPromises()
    backend.status.value = 'connected'
    await flushPromises()

    expect(wrapper.find('.pdp-error').exists()).toBe(false)
    expect(wrapper.find('iframe').exists()).toBe(true)
  })

  it('ignores window messages whose source is not the preview frame', async () => {
    const { wrapper } = await mountPreview()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'todo-clicked', todoId: 'phase-a', alt: false },
      }),
    )
    await flushPromises()
    expect(wrapper.emitted('todo-clicked')).toBeUndefined()
    expect(wrapper.emitted('section-comment')).toBeUndefined()
  })

  it('rejects window messages with stale token or legacy token field', async () => {
    const { wrapper } = await mountPreview()
    const frame = wrapper.find('iframe').element as HTMLIFrameElement
    const frameWindow = frame.contentWindow

    // Message with stale documentToken
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'todo-clicked', todoId: 'phase-a', alt: false, documentToken: 'stale-token' },
        source: frameWindow ?? window,
      }),
    )
    // Message with legacy token alias
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'todo-clicked', todoId: 'phase-a', alt: false, token: 'stale-token' },
        source: frameWindow ?? window,
      }),
    )
    await flushPromises()
    expect(wrapper.emitted('todo-clicked')).toBeUndefined()
  })

  it('scrollToAnchor posts a scroll-to message into the frame', async () => {
    const { wrapper } = await mountPreview()
    const frameWindow = (wrapper.find('iframe').element as HTMLIFrameElement).contentWindow
    expect(frameWindow).toBeTruthy()
    const postSpy = vi.spyOn(frameWindow!, 'postMessage')
    ;(wrapper.vm as unknown as { scrollToAnchor: (a: string) => void }).scrollToAnchor('Goals')
    expect(postSpy).toHaveBeenCalledWith({ type: 'scroll-to', anchor: 'Goals' }, '*')
  })

  it('passes the inline edit/delete labels into the injected runtime', async () => {
    const { wrapper } = await mountPreview()
    const srcdoc = wrapper.find('iframe').attributes('srcdoc') ?? ''
    expect(srcdoc).toContain('"editLabel":"Edit"')
    expect(srcdoc).toContain('"deleteLabel":"Delete"')
    expect(srcdoc).toContain('"saveLabel":"Save"')
    expect(srcdoc).toContain('"cancelLabel":"Cancel"')
  })

  it('cancelEdit posts a cancel-edit message into the frame; isEditing starts false', async () => {
    const { wrapper } = await mountPreview()
    const vm = wrapper.vm as unknown as { isEditing: () => boolean; cancelEdit: () => void }
    expect(vm.isEditing()).toBe(false)
    const frameWindow = (wrapper.find('iframe').element as HTMLIFrameElement).contentWindow!
    expect(frameWindow).toBeTruthy()
    const postSpy = vi.spyOn(frameWindow, 'postMessage')
    vm.cancelEdit()
    expect(postSpy).toHaveBeenCalledWith({ type: 'cancel-edit' }, '*')
  })

  it('clears editing state when an external reload (loadDoc) runs', async () => {
    const { wrapper } = await mountPreview()
    const frameWindow = (wrapper.find('iframe').element as HTMLIFrameElement).contentWindow!
    expect(frameWindow).toBeTruthy()
    const token = getDocumentToken(wrapper)
    expect(token).toBeTruthy()
    const vm = wrapper.vm as unknown as { isEditing: () => boolean }
    // Enter editing state from the frame.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'section-editing', active: true, documentToken: token },
        source: frameWindow,
      }),
    )
    await flushPromises()
    expect(vm.isEditing()).toBe(true)
    // An external refresh reloads the doc and must clear the stuck edit state.
    await wrapper.setProps({ refresh: 1 })
    await flushPromises()
    expect(vm.isEditing()).toBe(false)
  })

  it('emits validated section-edit/section-delete and tracks editing state from the frame', async () => {
    const { wrapper } = await mountPreview()
    const frameWindow = (wrapper.find('iframe').element as HTMLIFrameElement).contentWindow!
    expect(frameWindow).toBeTruthy()
    const token = getDocumentToken(wrapper)
    expect(token).toBeTruthy()
    const vm = wrapper.vm as unknown as { isEditing: () => boolean }
    const fire = (data: Record<string, unknown>): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { ...data, documentToken: token },
          source: frameWindow,
        }),
      )
    }
    fire({ type: 'section-edit', anchor: 'Goals', html: '<p>x</p>' })
    fire({ type: 'section-delete', anchor: 'Goals' })
    fire({ type: 'section-editing', active: true })
    await flushPromises()
    expect(wrapper.emitted('section-edit')?.[0]).toEqual([{ anchor: 'Goals', html: '<p>x</p>' }])
    expect(wrapper.emitted('section-delete')?.[0]).toEqual(['Goals'])
    expect(vm.isEditing()).toBe(true)
  })

  it('enforces window source and document token across iframe remount (4 combinations)', async () => {
    const { wrapper } = await mountPreview()
    const oldFrame = wrapper.find('iframe').element as HTMLIFrameElement
    const oldWindow = oldFrame.contentWindow!
    const oldToken = getDocumentToken(wrapper)
    expect(oldWindow).toBeTruthy()
    expect(oldToken).toBeTruthy()

    // Trigger reload: refresh prop bump replaces the iframe and regenerates token
    await wrapper.setProps({ refresh: 1 })
    await flushPromises()

    const newFrame = wrapper.find('iframe').element as HTMLIFrameElement
    expect(newFrame).not.toBe(oldFrame)
    const newWindow = newFrame.contentWindow!
    const newToken = getDocumentToken(wrapper)
    expect(newWindow).toBeTruthy()
    expect(newToken).toBeTruthy()
    expect(newWindow).not.toBe(oldWindow)
    expect(newToken).not.toBe(oldToken)

    const fireTodo = (source: Window, token: string): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'todo-clicked', todoId: 'phase-a', alt: false, documentToken: token },
          source,
        }),
      )
    }

    // 1. Old iframe window + old token -> rejected
    fireTodo(oldWindow, oldToken)
    await flushPromises()
    expect(wrapper.emitted('todo-clicked')).toBeUndefined()

    // 2. Old iframe window + new token -> rejected
    fireTodo(oldWindow, newToken)
    await flushPromises()
    expect(wrapper.emitted('todo-clicked')).toBeUndefined()

    // 3. New iframe window + old token -> rejected
    fireTodo(newWindow, oldToken)
    await flushPromises()
    expect(wrapper.emitted('todo-clicked')).toBeUndefined()

    // 4. New iframe window + new token -> accepted
    fireTodo(newWindow, newToken)
    await flushPromises()
    expect(wrapper.emitted('todo-clicked')).toEqual([[{ todoId: 'phase-a', alt: false }]])
  })
})
