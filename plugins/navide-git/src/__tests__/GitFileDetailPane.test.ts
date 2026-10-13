// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import GitFileDetailPane from '../GitFileDetailPane.vue'
import ConflictPane from '../editor/ConflictPane.vue'
import type { GitTransport } from '#git-feature'

vi.mock('@navide/plugin-ui/foundation', () => ({
  vTruncate: {},
  useNotify: () => ({ toast: vi.fn() }),
}))

const diffText = '@@ -1,2 +1,2 @@\n-old line\n+new line\n'
const conflictText = 'before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\nafter\n'

function makeTransport(send: ReturnType<typeof vi.fn>): GitTransport {
  return { status: ref('connected'), send } as unknown as GitTransport
}

function makeFileAccess(readFile = vi.fn(async () => ({ ok: true, content: conflictText }))) {
  return {
    readFile,
    writeFile: vi.fn(async () => ({ ok: true })),
    readImage: vi.fn(async () => ({ ok: false, error: 'not an image' })),
  }
}

const fileTarget = {
  resource: { kind: 'file-diff' as const, filepath: 'src/main.ts', staged: false, commit: '' },
  presentation: { mode: 'diff' as const },
}

describe('GitFileDetailPane close preparation', () => {
  it('keeps a working-tree DiffPane mounted while apply is busy and blocks mode changes', async () => {
    let resolveApply: ((value: unknown) => void) | undefined
    const send = vi.fn(async (method: string) => {
      if (method === 'git.diff_file') return { ok: true, payload: { ok: true, diff: diffText } }
      return await new Promise((resolve) => { resolveApply = resolve })
    })
    const wrapper = mount(GitFileDetailPane, {
      global: { config: { globalProperties: { $t: (key: string) => key } } },
      props: {
        target: fileTarget,
        workspacePath: '/workspace',
        gitTransport: makeTransport(send),
        fileAccess: makeFileAccess(),
        fileLog: vi.fn(async () => []),
        commitFileDiff: vi.fn(async () => []),
        blameFile: vi.fn(async () => []),
        diffBlame: vi.fn(async () => []),
      },
    })
    await flushPromises()

    await wrapper.get('button.hk-btn').trigger('click')
    expect(wrapper.vm.getCloseState()).toBe('busy')
    expect(wrapper.findComponent({ name: 'DiffPane' }).exists()).toBe(true)

    await wrapper.findAll('button.detail-open').find((button) => button.text() === 'History')!.trigger('click')
    expect(wrapper.findComponent({ name: 'DiffPane' }).exists()).toBe(true)
    expect(wrapper.find('.detail-scroll').exists()).toBe(false)

    resolveApply?.({ ok: true, payload: { ok: true, diff: diffText } })
    await flushPromises()
    wrapper.unmount()
  })

  it('disables patch, selection, and mode mutations during clean preparation, then restores the exact subtree', async () => {
    const send = vi.fn(async (method: string) =>
      method === 'git.diff_file' ? { ok: true, payload: { ok: true, diff: diffText } } : { ok: true, payload: { ok: true } })
    const wrapper = mount(GitFileDetailPane, {
      global: { config: { globalProperties: { $t: (key: string) => key } } },
      props: {
        target: fileTarget,
        workspacePath: '/workspace',
        gitTransport: makeTransport(send),
        fileAccess: makeFileAccess(),
        fileLog: vi.fn(async () => []),
        commitFileDiff: vi.fn(async () => []),
        blameFile: vi.fn(async () => []),
        diffBlame: vi.fn(async () => []),
      },
    })
    await flushPromises()

    const checkbox = wrapper.get('input.dp-check')
    await checkbox.setValue(true)
    expect((checkbox.element as HTMLInputElement).checked).toBe(true)
    const beforePrepare = wrapper.find('.dp-hunks').html()

    wrapper.vm.setClosePrepared(true)
    await nextTick()
    expect(wrapper.vm.getCloseState()).toBe('busy')
    expect(wrapper.get('input.dp-check').attributes('disabled')).toBeDefined()
    expect(wrapper.get('button.hk-btn').attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('button.detail-open').find((button) => button.text() === 'History')!.attributes('disabled')).toBeDefined()

    wrapper.vm.setClosePrepared(false)
    await nextTick()
    expect(wrapper.vm.getCloseState()).toBe('accepted')
    expect(wrapper.find('.dp-hunks').html()).toBe(beforePrepare)
    expect((wrapper.get('input.dp-check').element as HTMLInputElement).checked).toBe(true)
    wrapper.unmount()
  })

  it('keeps a dirty conflict refused, and blocks then restores conflict mutations around preparation', async () => {
    const send = vi.fn(async (method: string) => method === 'git.conflict_stages'
      ? { ok: true, payload: { ok: true, has_base: false, binary: false } }
      : { ok: true, payload: { ok: true } })
    const wrapper = mount(ConflictPane, {
      global: { config: { globalProperties: { $t: (key: string) => key } } },
      props: {
        workspacePath: '/workspace', filepath: 'src/main.ts', name: 'main.ts',
        gitTransport: makeTransport(send), fileAccess: makeFileAccess(),
      },
    })
    await flushPromises()

    expect(wrapper.find('.cp-btn').exists()).toBe(true)
    await wrapper.findAll('.cp-btn').at(0)!.trigger('click')
    expect(wrapper.vm.getCloseState()).toBe('refused')
    const beforePrepare = wrapper.find('.cp-conflict').html()

    wrapper.vm.setClosePrepared(true)
    await nextTick()
    expect(wrapper.vm.getCloseState()).toBe('busy')
    await wrapper.findAll('.cp-btn').at(1)!.trigger('click')

    wrapper.vm.setClosePrepared(false)
    await nextTick()
    expect(wrapper.vm.getCloseState()).toBe('refused')
    expect(wrapper.find('.cp-conflict').html()).toBe(beforePrepare)
    await wrapper.findAll('.cp-btn').at(1)!.trigger('click')
    expect(wrapper.vm.getCloseState()).toBe('refused')
    wrapper.unmount()
  })
})
