// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref, nextTick } from 'vue'
import { EditorPane } from '@navide/plugin-ui/editor'
import { createHostEditorPort } from '../../composables/hostEditorPort'
import { i18n } from '@navide/plugin-ui/foundation'

// Stateful Monaco view stub: enough surface for selection, external edits and
// find/replace to run against the bound modelValue.
vi.mock('../../../../../packages/plugin-ui/src/editor/view/EditorViewMonaco.vue', () => ({
  default: defineComponent({
    name: 'EditorViewMonaco',
    props: { modelValue: { type: String, default: '' } },
    emits: ['update:modelValue', 'cursor-change'],
    data() {
      return {
        selText: '',
        selRange: null as null | { startLine: number; startCol: number; endLine: number; endCol: number },
      }
    },
    methods: {
      getValue(): string {
        return this.modelValue
      },
      getSelectionText(): string {
        return this.selText
      },
      getSelectionRange() {
        return this.selRange
      },
      applyEditExternal(
        range: { start: { line: number; col: number }; end: { line: number; col: number } },
        text: string,
      ) {
        const lines = this.modelValue.split('\n')
        const off = (line: number, col: number): number =>
          lines.slice(0, line).reduce((n: number, l: string) => n + l.length + 1, 0) + col
        const next =
          this.modelValue.slice(0, off(range.start.line, range.start.col)) +
          text +
          this.modelValue.slice(off(range.end.line, range.end.col))
        this.$emit('update:modelValue', next)
      },
      setDecorations() {},
      revealPosition() {},
      revealLine() {},
      focus() {},
      getCursor() {
        return { line: 0, col: 0 }
      },
      setSelection() {},
    },
    render() {
      return h('div', { class: 'mock-monaco' }, this.modelValue)
    },
  }),
}))

const notify = vi.hoisted(() => ({
  toast: vi.fn(),
  alert: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true),
}))
vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => notify,
}))

type Status = 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'
type SendImpl = (type: string, params: Record<string, unknown>) => Promise<{ payload: unknown }>

function makeBackend(sendImpl?: SendImpl) {
  const events = new Map<string, (raw: unknown) => void>()
  return {
    status: ref<Status>('connected'),
    lastError: ref(''),
    events,
    send: vi.fn(async (type: string, params: Record<string, unknown>) => {
      if (sendImpl) return sendImpl(type, params)
      if (type === 'fs.read_file') {
        return { payload: { ok: true, content: 'hello world', encoding: 'UTF-8' } }
      }
      return { payload: { ok: true } }
    }),
    on: vi.fn((event: string, cb: (raw: unknown) => void) => {
      events.set(event, cb)
      return () => events.delete(event)
    }),
    restart: vi.fn(async () => undefined),
  }
}

function mountPane(backend: ReturnType<typeof makeBackend>) {
  return mount(EditorPane, {
    props: {
      workspacePath: '/ws',
      relPath: 'a.txt',
      name: 'a.txt',
      port: createHostEditorPort(backend as never),
    },
    global: { plugins: [i18n] },
  })
}

function mockView(wrapper: VueWrapper) {
  return wrapper.findComponent({ name: 'EditorViewMonaco' })
}

beforeEach(() => {
  notify.toast.mockClear()
  notify.alert.mockClear()
  notify.confirm.mockClear()
  notify.confirm.mockResolvedValue(true)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined), readText: vi.fn(async () => '') },
    configurable: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('EditorPane – floating Add to Chat button', () => {
  it('appears after a mouse selection without touching e.currentTarget in the rAF', async () => {
    const rafQueue: FrameRequestCallback[] = []
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => { rafQueue.push(cb); return 1 })
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    const view = mockView(wrapper)
    ;(view.vm as never as { selText: string }).selText = 'hello'
    // cursor-change populates selectionInfo (required by the button's v-if)
    view.vm.$emit('cursor-change', { line: 0, col: 5 })
    await nextTick()

    await wrapper.find('.ep-body').trigger('mouseup', { clientX: 100, clientY: 60 })
    // Run the deferred frame after dispatch completed (currentTarget is gone).
    rafQueue.forEach((cb) => cb(0))
    await nextTick()

    expect(wrapper.find('.ep-float-chat-btn').exists()).toBe(true)
    rafSpy.mockRestore()
  })
})

describe('EditorPane – context menu Cut', () => {
  it('copies and deletes the selection', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    const view = mockView(wrapper)
    const vm = view.vm as never as { selText: string; selRange: unknown }
    vm.selText = 'lo wo'
    vm.selRange = { startLine: 0, startCol: 3, endLine: 0, endCol: 8 }

    await wrapper.find('.ep-body').trigger('contextmenu', { clientX: 10, clientY: 10 })
    await nextTick()
    const cutBtn = wrapper.findAll('.ep-ctx-item').find((b) => b.text() === 'Cut')
    expect(cutBtn).toBeTruthy()
    await cutBtn!.trigger('click')
    await nextTick()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('lo wo')
    expect(wrapper.find('.mock-monaco').text()).toBe('helrld')
    expect(wrapper.emitted('dirty')?.some((e) => e[0] === true)).toBe(true)
  })
})

describe('EditorPane – load error retry while connected', () => {
  it('shows a Retry button that reloads without a reconnect', async () => {
    const backend = makeBackend()
    backend.send.mockRejectedValueOnce(new Error('request fs.read_file timeout'))
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(wrapper.text()).toContain('request fs.read_file timeout')

    const retry = wrapper.find('.ep-retry')
    expect(retry.exists()).toBe(true)
    await retry.trigger('click')
    await flushPromises()
    expect(backend.restart).not.toHaveBeenCalled()
    expect(wrapper.find('.mock-monaco').text()).toBe('hello world')
  })
})

describe('EditorPane – find bar cap and debounce', () => {
  it('debounces query input and caps matches at 1000 with a "+" indicator', async () => {
    const bigContent = Array.from({ length: 1500 }, () => 'a').join('\n')
    const backend = makeBackend(async (type) =>
      type === 'fs.read_file'
        ? { payload: { ok: true, content: bigContent, encoding: 'UTF-8' } }
        : { payload: { ok: true } })
    const wrapper = mountPane(backend)
    await flushPromises()

    vi.useFakeTimers()
    ;(wrapper.vm as never as { openFind: () => void }).openFind()
    await nextTick()
    await wrapper.find('.ep-find-input').setValue('a')
    await nextTick()
    // Debounced — no scan happened yet.
    expect(wrapper.find('.ep-find-count').text()).toContain('No results')

    vi.advanceTimersByTime(150)
    await nextTick()
    expect(wrapper.find('.ep-find-count').text()).toBe('1/1000+')
  })
})

describe('EditorPane – regex Replace All', () => {
  it('replaces every anchored per-line match (m flag)', async () => {
    const backend = makeBackend(async (type) =>
      type === 'fs.read_file'
        ? { payload: { ok: true, content: 'import a\nimport b\nimport c', encoding: 'UTF-8' } }
        : { payload: { ok: true } })
    const wrapper = mountPane(backend)
    await flushPromises()

    vi.useFakeTimers()
    ;(wrapper.vm as never as { openReplace: () => void }).openReplace()
    await nextTick()
    // Enable regex mode (third option button: Aa, W|, .*)
    await wrapper.findAll('.ep-find-btn')[2].trigger('click')
    await wrapper.find('.ep-find-input').setValue('^import')
    vi.advanceTimersByTime(150)
    await nextTick()
    expect(wrapper.find('.ep-find-count').text()).toBe('1/3')

    const inputs = wrapper.findAll('.ep-find-input')
    await inputs[1].setValue('using')
    await wrapper.find('[title="Replace All (⌥↵)"]').trigger('click')
    await nextTick()
    expect(wrapper.find('.mock-monaco').text()).toBe('using a\nusing b\nusing c')
    vi.runOnlyPendingTimers()
  })
})

describe('EditorPane – Cmd+K stale range protection', () => {
  async function openAndSubmitCmdK(
    wrapper: VueWrapper,
    rewrite: Promise<{ payload: unknown }>,
    backend: ReturnType<typeof makeBackend>,
  ) {
    const view = mockView(wrapper)
    const vm = view.vm as never as { selText: string; selRange: unknown }
    vm.selText = 'hello'
    vm.selRange = { startLine: 0, startCol: 0, endLine: 0, endCol: 5 }
    backend.send.mockImplementation(async (type: string) => {
      if (type === 'editor.rewrite') return rewrite
      return { payload: { ok: true } }
    })
    ;(wrapper.vm as never as { openCmdK: () => void }).openCmdK()
    await nextTick()
    const input = wrapper.find('.ep-cmdk-input')
    await input.setValue('rewrite this')
    await input.trigger('keydown.enter')
  }

  it('discards the proposal when the document was edited during the rewrite', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    let resolveRewrite!: (v: { payload: unknown }) => void
    const pending = new Promise<{ payload: unknown }>((res) => { resolveRewrite = res })
    await openAndSubmitCmdK(wrapper, pending, backend)

    // User types while the AI is thinking.
    mockView(wrapper).vm.$emit('update:modelValue', 'hello world EDITED')
    await nextTick()
    resolveRewrite({ payload: { ok: true, text: 'HELLO' } })
    await flushPromises()

    expect(wrapper.find('.ep-proposal').exists()).toBe(false)
    expect(notify.toast).toHaveBeenCalledWith(
      'Document changed — AI rewrite discarded', { type: 'info' })
  })

  it('discards an open proposal when the document is edited before Accept', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    await openAndSubmitCmdK(
      wrapper, Promise.resolve({ payload: { ok: true, text: 'HELLO' } }), backend)
    await flushPromises()
    expect(wrapper.find('.ep-proposal').exists()).toBe(true)

    mockView(wrapper).vm.$emit('update:modelValue', 'hello world EDITED')
    await nextTick()
    expect(wrapper.find('.ep-proposal').exists()).toBe(false)
  })

  it('applies the proposal normally when nothing changed', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    await openAndSubmitCmdK(
      wrapper, Promise.resolve({ payload: { ok: true, text: 'HELLO' } }), backend)
    await flushPromises()
    await wrapper.find('.ep-prop-actions .ep-act.success').trigger('click')
    await nextTick()
    expect(wrapper.find('.mock-monaco').text()).toBe('HELLO world')
    expect(notify.toast).not.toHaveBeenCalledWith(
      'Document changed — AI rewrite discarded', { type: 'info' })
  })
})

describe('EditorPane – save conflict detection', () => {
  function conflictBackend() {
    const writes: Array<Record<string, unknown>> = []
    let diskContent = 'hello world'
    let writeResult: Record<string, unknown> = { ok: true, mtime: 333 }
    const backend = makeBackend(async (type, params) => {
      if (type === 'fs.read_file') {
        return { payload: { ok: true, content: diskContent, encoding: 'big5', mtime: 111 } }
      }
      if (type === 'fs.write_file') {
        writes.push(params)
        return { payload: writeResult }
      }
      return { payload: { ok: true } }
    })
    return {
      backend,
      writes,
      setWriteResult: (r: Record<string, unknown>) => { writeResult = r },
      setDiskContent: (c: string) => { diskContent = c },
    }
  }

  it('sends expected_mtime and encoding, shows the conflict bar, and Overwrite force-saves', async () => {
    const { backend, writes, setWriteResult } = conflictBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    mockView(wrapper).vm.$emit('update:modelValue', 'hello world edited')
    await nextTick()
    setWriteResult({ ok: false, conflict: true, mtime: 222 })
    await (wrapper.vm as never as { save: () => Promise<void> }).save()
    await flushPromises()

    expect(writes[0].expected_mtime).toBe(111)
    expect(writes[0].encoding).toBe('big5')
    expect(wrapper.find('.ep-conflict').exists()).toBe(true)

    setWriteResult({ ok: true, mtime: 333 })
    const buttons = wrapper.findAll('.ep-conflict .ep-act')
    await buttons[0].trigger('click') // Overwrite
    await flushPromises()
    expect(writes[1].expected_mtime).toBeUndefined()
    expect(writes[1].content).toBe('hello world edited')
    expect(wrapper.find('.ep-conflict').exists()).toBe(false)
    expect(wrapper.emitted('dirty')?.at(-1)?.[0]).toBe(false)
  })

  it('Reload replaces the buffer with the disk version and clears dirty', async () => {
    const { backend, setWriteResult, setDiskContent } = conflictBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    mockView(wrapper).vm.$emit('update:modelValue', 'hello world edited')
    await nextTick()
    setWriteResult({ ok: false, conflict: true, mtime: 222 })
    await (wrapper.vm as never as { save: () => Promise<void> }).save()
    await flushPromises()
    expect(wrapper.find('.ep-conflict').exists()).toBe(true)

    setDiskContent('disk version')
    const buttons = wrapper.findAll('.ep-conflict .ep-act')
    await buttons[1].trigger('click') // Reload
    await flushPromises()
    expect(wrapper.find('.mock-monaco').text()).toBe('disk version')
    expect(wrapper.find('.ep-conflict').exists()).toBe(false)
    expect(wrapper.emitted('dirty')?.at(-1)?.[0]).toBe(false)
  })

  it('skips conflict logic when the backend returns no mtime (backward compatible)', async () => {
    const writes: Array<Record<string, unknown>> = []
    const backend = makeBackend(async (type, params) => {
      if (type === 'fs.read_file') {
        return { payload: { ok: true, content: 'x', encoding: 'UTF-8' } }
      }
      if (type === 'fs.write_file') {
        writes.push(params)
        return { payload: { ok: true } }
      }
      return { payload: { ok: true } }
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    mockView(wrapper).vm.$emit('update:modelValue', 'x edited')
    await nextTick()
    await (wrapper.vm as never as { save: () => Promise<void> }).save()
    await flushPromises()
    expect(writes[0].expected_mtime).toBeUndefined()
    expect(notify.toast).toHaveBeenCalledWith('Saved', { type: 'success' })
  })
})

describe('EditorPane – reopen with encoding', () => {
  it('asks for confirmation when dirty and aborts when declined', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    mockView(wrapper).vm.$emit('update:modelValue', 'hello edited')
    await nextTick()
    notify.confirm.mockResolvedValueOnce(false)

    await wrapper.find('.ep-status-enc').trigger('click')
    await nextTick()
    const big5 = wrapper.findAll('.ep-indent-opt').find((b) => b.text() === 'Big5')
    await big5!.trigger('click')
    await flushPromises()

    expect(notify.confirm).toHaveBeenCalled()
    // No re-read was issued; the edited buffer is intact.
    expect(backend.send.mock.calls.filter(([t]) => t === 'fs.read_file')).toHaveLength(1)
    expect(wrapper.find('.mock-monaco').text()).toBe('hello edited')
  })

  it('reopens after confirmation and passes the encoding override', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()

    mockView(wrapper).vm.$emit('update:modelValue', 'hello edited')
    await nextTick()

    await wrapper.find('.ep-status-enc').trigger('click')
    await nextTick()
    const big5 = wrapper.findAll('.ep-indent-opt').find((b) => b.text() === 'Big5')
    await big5!.trigger('click')
    await flushPromises()

    const reread = backend.send.mock.calls.find(
      ([t, p]) => t === 'fs.read_file' && (p as Record<string, unknown>).encoding_override)
    expect(reread).toBeTruthy()
    expect((reread![1] as Record<string, unknown>).encoding_override).toBe('big5')
    expect(wrapper.emitted('dirty')?.at(-1)?.[0]).toBe(false)
  })
})

describe('EditorPane – git.changed auto-reload', () => {
  it('does not clobber keystrokes typed while the reload read is in flight', async () => {
    let resolveRead: ((v: { payload: unknown }) => void) | null = null
    let readCount = 0
    const backend = makeBackend(async (type) => {
      if (type === 'fs.read_file') {
        readCount++
        if (readCount === 1) {
          return { payload: { ok: true, content: 'v1', encoding: 'UTF-8' } }
        }
        return new Promise<{ payload: unknown }>((res) => { resolveRead = res })
      }
      return { payload: { ok: true } }
    })
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(wrapper.find('.mock-monaco').text()).toBe('v1')

    // git.changed fires while the editor is clean → reload read goes out.
    backend.events.get('git.changed')!({ workspace_path: '/ws' })
    await nextTick()
    // User types while the read is in flight.
    mockView(wrapper).vm.$emit('update:modelValue', 'v1 typed')
    await nextTick()
    resolveRead!({ payload: { ok: true, content: 'v2-from-disk', encoding: 'UTF-8' } })
    await flushPromises()

    expect(wrapper.find('.mock-monaco').text()).toBe('v1 typed')
  })
})
