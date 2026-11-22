// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import EditorPane from './EditorPane.vue'
import type { EditorPort, EditorReadResult } from './port'

const editor = vi.hoisted(() => ({
  revealPosition: vi.fn(),
  setReadOnly: vi.fn(),
  getModelIdentity: vi.fn(() => 'model-1'),
}))

vi.mock('./view/EditorViewMonaco.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'EditorViewMonaco',
      emits: ['update:modelValue', 'cursor-change'],
      setup(_, context) {
        context.expose({
          revealPosition: editor.revealPosition,
          setReadOnly: editor.setReadOnly,
          getModelIdentity: editor.getModelIdentity,
          getValue: () => '',
          getCursor: () => null,
        })
        return () => h('div', { 'data-test': 'monaco-editor' })
      },
    }),
  }
})

vi.mock('../foundation', () => ({
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn(async () => false) }),
}))

vi.mock('../shared', () => ({ setContext: vi.fn() }))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function port(readFile: () => Promise<EditorReadResult>): EditorPort {
  return {
    status: ref('connected'),
    lastError: ref(''),
    restart: vi.fn(async () => undefined),
    readFile: vi.fn(readFile),
    writeFile: vi.fn(async () => ({ ok: true })),
    readImage: vi.fn(async () => ''),
    rewrite: vi.fn(async () => ({ ok: true })),
    complete: vi.fn(async () => ({ ok: true, text: '' })),
    onFilesChanged: vi.fn(() => () => undefined),
    diagnostics: vi.fn(() => []),
  }
}

function mountEditor(editorPort: EditorPort) {
  return mount(EditorPane, {
    props: {
      workspacePath: '/workspace',
      port: editorPort,
      relPath: 'src/App.ts',
      name: 'App.ts',
    },
    global: { mocks: { $t: (key: string) => key } },
  })
}

describe('EditorPane.prepareClose', () => {
  beforeEach(() => {
    editor.setReadOnly.mockClear()
    editor.getModelIdentity.mockClear()
    editor.getModelIdentity.mockReturnValue('model-1')
  })

  it('freezes editing and saving until the synchronized lease is released', async () => {
    const editorPort = port(async () => ({ ok: true, content: 'one\ntwo', mtime: 1 }) as EditorReadResult)
    const wrapper = mountEditor(editorPort)
    await flushPromises()
    wrapper.findComponent({ name: 'EditorViewMonaco' }).vm.$emit('update:modelValue', 'one\ntwo\nthree')
    await flushPromises()
    expect(wrapper.emitted('dirty')?.at(-1)).toEqual([true])

    const pane = wrapper.vm as unknown as {
      prepareClose: () => { isCurrent(): boolean; release(): void } | null
      save: () => Promise<void>
    }
    const guard = pane.prepareClose()
    expect(guard).not.toBeNull()
    expect(guard?.isCurrent()).toBe(true)
    expect(editor.setReadOnly).toHaveBeenLastCalledWith(true)

    wrapper.findComponent({ name: 'EditorViewMonaco' }).vm.$emit('update:modelValue', 'mutated while closing')
    await pane.save()
    await flushPromises()
    expect(editorPort.writeFile).not.toHaveBeenCalled()

    guard?.release()
    expect(guard?.isCurrent()).toBe(false)
    expect(editor.setReadOnly).toHaveBeenLastCalledWith(false)
    guard?.release()
    expect(editor.setReadOnly).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('refuses a lease during an in-flight write and grants one after it settles', async () => {
    const write = deferred<{ ok: boolean }>()
    const editorPort = port(async () => ({ ok: true, content: 'one', mtime: 1 }) as EditorReadResult)
    editorPort.writeFile = vi.fn(() => write.promise)
    const wrapper = mountEditor(editorPort)
    await flushPromises()
    wrapper.findComponent({ name: 'EditorViewMonaco' }).vm.$emit('update:modelValue', 'changed')
    await flushPromises()

    const pane = wrapper.vm as unknown as {
      prepareClose: () => { isCurrent(): boolean; release(): void } | null
      save: () => Promise<void>
    }
    void pane.save()
    await vi.waitFor(() => expect(editorPort.writeFile).toHaveBeenCalledOnce())
    expect(pane.prepareClose()).toBeNull()

    write.resolve({ ok: true })
    await flushPromises()
    const guard = pane.prepareClose()
    expect(guard?.isCurrent()).toBe(true)
    guard?.release()
    wrapper.unmount()
  })

  it.each([
    ['binary', async () => ({ ok: false, is_binary: true, size: 4 }) as EditorReadResult],
    ['image', async () => ({ ok: false, is_image: true, size: 4, ext: '.png' }) as EditorReadResult],
    ['failed read', async () => ({ ok: false, error: 'not a file' }) as EditorReadResult],
  ])('grants a no-op lease for a %s pane with no editable model', async (_name, read) => {
    const editorPort = port(read)
    const wrapper = mountEditor(editorPort)
    await flushPromises()
    const pane = wrapper.vm as unknown as { prepareClose: () => { isCurrent(): boolean; release(): void } | null }
    const guard = pane.prepareClose()
    expect(guard).not.toBeNull()
    expect(guard?.isCurrent()).toBe(true)
    guard?.release()
    expect(guard?.isCurrent()).toBe(true)
    expect(editor.setReadOnly).not.toHaveBeenCalled()
    // A cancelled close leaves nothing latched: the next close attempt is granted again.
    expect(pane.prepareClose()).not.toBeNull()
    wrapper.unmount()
  })

  it('still refuses a lease while the first read is in flight', async () => {
    const read = deferred<EditorReadResult>()
    const editorPort = port(() => read.promise)
    const wrapper = mountEditor(editorPort)
    await vi.waitFor(() => expect(editorPort.readFile).toHaveBeenCalledOnce())
    expect((wrapper.vm as unknown as { prepareClose: () => unknown }).prepareClose()).toBeNull()
    read.resolve({ ok: false, error: 'not a file' } as EditorReadResult)
    await flushPromises()
    expect((wrapper.vm as unknown as { prepareClose: () => unknown }).prepareClose()).not.toBeNull()
    wrapper.unmount()
  })

  it('invalidates the lease when its exact pane or path identity changes', async () => {
    const editorPort = port(async () => ({ ok: true, content: 'one', mtime: 1 }) as EditorReadResult)
    const wrapper = mountEditor(editorPort)
    await flushPromises()
    const pane = wrapper.vm as unknown as { prepareClose: () => { isCurrent(): boolean; release(): void } | null }
    const guard = pane.prepareClose()
    expect(guard?.isCurrent()).toBe(true)
    await wrapper.setProps({ relPath: 'src/Other.ts' })
    expect(guard?.isCurrent()).toBe(false)
    guard?.release()
    expect(editor.setReadOnly).toHaveBeenLastCalledWith(false)
    wrapper.unmount()
  })
})

describe('EditorPane.revealPositionWhenReady', () => {
  beforeEach(() => editor.revealPosition.mockReset())

  it('waits for the current load and converts one-based input to zero-based Monaco coordinates', async () => {
    const load = deferred<EditorReadResult>()
    const editorPort = port(() => load.promise)
    const wrapper = mountEditor(editorPort)

    const ready = (wrapper.vm as unknown as { revealPositionWhenReady: (line: number, column: number) => Promise<boolean> }).revealPositionWhenReady(3, 4)
    await flushPromises()
    expect(editor.revealPosition).not.toHaveBeenCalled()

    load.resolve({ ok: true, content: 'one\ntwo\nthree' })
    await expect(ready).resolves.toBe(true)
    expect(editor.revealPosition).toHaveBeenCalledOnce()
    expect(editor.revealPosition).toHaveBeenCalledWith(2, 3)
    expect(editorPort.readFile).toHaveBeenCalledOnce()
    expect(editorPort.writeFile).not.toHaveBeenCalled()
    expect(wrapper.emitted('dirty')).toBeUndefined()
    wrapper.unmount()
  })

  it.each([
    ['invalid position', async () => ({ ok: true, content: 'text' }) as EditorReadResult, 0, 1],
    ['load error', async () => ({ ok: false, error: 'read failed' }) as EditorReadResult, 1, 1],
    ['binary surface', async () => ({ ok: false, is_binary: true, size: 10 }) as EditorReadResult, 1, 1],
  ])('returns false for %s without positioning or writing', async (_name, read, line, column) => {
    const editorPort = port(read)
    const wrapper = mountEditor(editorPort)
    await expect((wrapper.vm as unknown as { revealPositionWhenReady: (line: number, column: number) => Promise<boolean> }).revealPositionWhenReady(line, column)).resolves.toBe(false)
    expect(editor.revealPosition).not.toHaveBeenCalled()
    expect(editorPort.writeFile).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
