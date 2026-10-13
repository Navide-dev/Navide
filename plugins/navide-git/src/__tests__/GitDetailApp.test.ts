// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import GitDetailApp from '../GitDetailApp.vue'
import {
  GIT_BRANCH_DIFF_KEY,
  GIT_FILE_ACCESS_KEY,
  GIT_TRANSPORT_KEY,
  GIT_UI_KEY,
} from '../ports/gitSurface'

const runtime = vi.hoisted(() => ({
  targetListener: null as ((update: { revision: number; target: unknown }) => { applied: boolean; reason?: string }) | null,
  closeListener: null as (() => { accepted: boolean; reason: string }) | null,
  closeCancelledListener: null as (() => void) | null,
}))
const git = vi.hoisted(() => ({
  fileLog: vi.fn(async () => [{ hash: 'abc', short_hash: 'abc', message: 'history' }]),
  commitFileDiff: vi.fn(async () => []),
  blameFile: vi.fn(async () => [{ short_hash: 'abc', author: 'A', content: 'line' }]),
  diffBlame: vi.fn(async () => []),
  listConflicts: vi.fn(async () => ({ ok: true, conflicts: [{ path: 'src/main.ts' }] })),
}))
const conflictState = vi.hoisted(() => ({ value: 'accepted' as 'accepted' | 'refused' | 'busy' }))
const notify = vi.hoisted(() => ({ toast: vi.fn() }))

vi.mock('@navide/plugin-sdk', () => ({
  createPluginViewRuntimeClient: () => ({
    onDetailTarget: (listener: (update: { revision: number; target: unknown }) => { applied: boolean; reason?: string }) => {
      runtime.targetListener = listener
      return { dispose: vi.fn() }
    },
    onPrepareClose: (listener: () => { accepted: boolean; reason: string }) => {
      runtime.closeListener = listener
      return { dispose: vi.fn() }
    },
    onCloseCancelled: (listener: () => void) => {
      runtime.closeCancelledListener = listener
      return { dispose: vi.fn() }
    },
  }),
}))

vi.mock('@navide/plugin-ui/foundation', () => ({
  vTruncate: {},
  useNotify: () => notify,
  i18n: { global: { t: (key: string) => key } },
}))

vi.mock('../composables/useGit', () => ({
  useGit: () => ({
    gitBranches: ref([]),
    gitStatus: ref({}),
    fileLog: git.fileLog,
    commitFileDiff: git.commitFileDiff,
    blameFile: git.blameFile,
    diffBlame: git.diffBlame,
    listConflicts: git.listConflicts,
  }),
}))

vi.mock('../editor/BranchDiffPane.vue', () => ({
  default: { name: 'BranchDiffPane', template: '<div data-test="branch-detail" />' },
}))

vi.mock('../editor/DiffPane.vue', () => ({
  default: { name: 'DiffPane', template: '<div data-test="file-diff" />' },
}))

vi.mock('../editor/ConflictPane.vue', () => ({
  default: {
    name: 'ConflictPane',
    setup(_: unknown, context: { expose: (value: unknown) => void }) {
      context.expose({ getCloseState: () => conflictState.value, setClosePrepared: vi.fn() })
      return () => h('div', { 'data-test': 'conflict-detail' })
    },
  },
}))

function mountDetail(ui: { openInEditor: ReturnType<typeof vi.fn> } = { openInEditor: vi.fn() }): VueWrapper {
  return mount(GitDetailApp, {
    global: {
      provide: {
        [GIT_TRANSPORT_KEY as symbol]: { status: ref('connected'), send: vi.fn(), on: vi.fn(() => () => undefined) },
        [GIT_BRANCH_DIFF_KEY as symbol]: { load: vi.fn(async () => ({ ok: true, diff: '' })) },
        [GIT_FILE_ACCESS_KEY as symbol]: { readFile: vi.fn(), writeFile: vi.fn(), readImage: vi.fn() },
        [GIT_UI_KEY as symbol]: { openInEditor: ui.openInEditor, openExternal: vi.fn(), revealPath: vi.fn(), pickFolder: vi.fn() },
      },
    },
  })
}

describe('GitDetailApp finite target variants', () => {
  beforeEach(() => {
    runtime.targetListener = null
    runtime.closeListener = null
    runtime.closeCancelledListener = null
    conflictState.value = 'accepted'
    git.fileLog.mockClear()
    git.blameFile.mockClear()
    git.listConflicts.mockClear()
    notify.toast.mockClear()
  })

  it('renders branch, diff, history, blame, and conflict variants through their public seams', async () => {
    const branch = mountDetail()
    expect(runtime.targetListener!({ revision: 1, target: { resource: { kind: 'branch-comparison', repository: '.', base: 'main', compare: 'topic' }, presentation: { mode: 'branch-diff' } } })).toEqual({ applied: true })
    await flushPromises()
    expect(branch.find('[data-test="branch-detail"]').exists()).toBe(true)
    branch.unmount()

    const diff = mountDetail()
    expect(runtime.targetListener!({ revision: 1, target: { resource: { kind: 'file-diff', repository: '.', filepath: 'src/main.ts', staged: false, commit: '' }, presentation: { mode: 'diff' } } })).toEqual({ applied: true })
    await flushPromises()
    expect(diff.find('[data-test="file-diff"]').exists()).toBe(true)
    diff.unmount()

    const history = mountDetail()
    expect(runtime.targetListener!({ revision: 1, target: { resource: { kind: 'file-history', repository: 'nested/repo', filepath: 'src/main.ts' }, presentation: { mode: 'history' } } })).toEqual({ applied: true })
    await flushPromises()
    expect(git.fileLog).toHaveBeenCalledWith('src/main.ts', 50)
    expect(history.findComponent({ name: 'GitFileDetailPane' }).props('workspacePath')).toContain('nested/repo')
    history.unmount()

    const blame = mountDetail()
    expect(runtime.targetListener!({ revision: 1, target: { resource: { kind: 'file-blame', repository: '.', filepath: 'src/main.ts', staged: false, changedOnly: false }, presentation: { mode: 'blame' } } })).toEqual({ applied: true })
    await flushPromises()
    expect(git.blameFile).toHaveBeenCalledWith('src/main.ts')
    blame.unmount()

    const conflict = mountDetail()
    expect(runtime.targetListener!({ revision: 1, target: { resource: { kind: 'merge-conflict', repository: '.', filepath: 'src/main.ts' }, presentation: { mode: 'conflict' } } })).toEqual({ applied: true })
    await flushPromises()
    expect(conflict.find('[data-test="conflict-detail"]').exists()).toBe(true)
    expect(git.listConflicts).toHaveBeenCalled()
    conflict.unmount()
  })

  it('maps conflict busy, dirty/refused, and clean close states without changing target state', async () => {
    const wrapper = mountDetail()
    expect(runtime.targetListener!({ revision: 1, target: { resource: { kind: 'merge-conflict', repository: '.', filepath: 'src/main.ts' }, presentation: { mode: 'conflict' } } })).toEqual({ applied: true })
    await flushPromises()

    conflictState.value = 'busy'
    expect(runtime.closeListener!()).toEqual({ accepted: false, reason: 'busy' })
    conflictState.value = 'refused'
    expect(runtime.closeListener!()).toEqual({ accepted: false, reason: 'refused' })
    conflictState.value = 'accepted'
    expect(runtime.closeListener!()).toEqual({ accepted: true, reason: 'accepted' })
    expect(wrapper.find('[data-test="conflict-detail"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('blocks clean prepared target mutation and restores it after close cancellation', async () => {
    const wrapper = mountDetail()
    const current = { resource: { kind: 'file-history', repository: '.', filepath: 'src/main.ts' }, presentation: { mode: 'history' } }
    const replacement = { resource: { kind: 'file-history', repository: '.', filepath: 'src/main.ts' }, presentation: { mode: 'history' } }
    expect(runtime.targetListener!({ revision: 1, target: current })).toEqual({ applied: true })
    await flushPromises()
    expect(runtime.closeListener!()).toEqual({ accepted: true, reason: 'accepted' })
    expect(runtime.targetListener!({ revision: 2, target: replacement })).toEqual({ applied: false, reason: 'busy' })
    expect(wrapper.findComponent({ name: 'GitFileDetailPane' }).props('target')).toEqual(current)

    runtime.closeCancelledListener!()
    expect(runtime.targetListener!({ revision: 3, target: replacement })).toEqual({ applied: true })
    expect(wrapper.findComponent({ name: 'GitFileDetailPane' }).props('target')).toEqual(replacement)
    wrapper.unmount()
  })

  it('keeps conflict refusal and busy decisions non-mutating while standalone detail uses the default close', async () => {
    const conflict = mountDetail()
    const conflictTarget = { resource: { kind: 'merge-conflict', repository: '.', filepath: 'src/main.ts' }, presentation: { mode: 'conflict' } }
    expect(runtime.targetListener!({ revision: 1, target: conflictTarget })).toEqual({ applied: true })
    await flushPromises()
    conflictState.value = 'refused'
    expect(runtime.closeListener!()).toEqual({ accepted: false, reason: 'refused' })
    conflictState.value = 'busy'
    expect(runtime.closeListener!()).toEqual({ accepted: false, reason: 'busy' })
    expect(conflict.find('[data-test="conflict-detail"]').exists()).toBe(true)
    conflict.unmount()

    const standalone = mountDetail()
    const branchTarget = { resource: { kind: 'branch-comparison', repository: '.', base: 'main', compare: 'topic' }, presentation: { mode: 'branch-diff' } }
    expect(runtime.targetListener!({ revision: 1, target: branchTarget })).toEqual({ applied: true })
    await flushPromises()
    expect(runtime.closeListener!()).toEqual({ accepted: true, reason: 'accepted' })
    standalone.unmount()
  })

  it('rejects unsafe paths and mismatched finite variants', async () => {
    const wrapper = mountDetail()
    expect(runtime.targetListener!({ revision: 1, target: { resource: { kind: 'file-history', repository: '.', filepath: '../secret' }, presentation: { mode: 'history' } } })).toEqual({ applied: false, reason: 'refused' })
    expect(runtime.targetListener!({ revision: 2, target: { resource: { kind: 'merge-conflict', repository: '.', filepath: 'src/main.ts' }, presentation: { mode: 'diff' } } })).toEqual({ applied: false, reason: 'refused' })
    await flushPromises()
    expect(wrapper.find('.git-detail-unavailable').exists()).toBe(true)
    expect(git.fileLog).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('accepts same-resource updates but refuses a foreign resource before mutating state', async () => {
    const wrapper = mountDetail()
    const current = { resource: { kind: 'file-history', repository: '.', filepath: 'src/main.ts' }, presentation: { mode: 'history' } }
    expect(runtime.targetListener!({ revision: 1, target: current })).toEqual({ applied: true })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'GitFileDetailPane' }).props('target')).toEqual(current)

    expect(runtime.targetListener!({ revision: 2, target: current })).toEqual({ applied: true })
    expect(runtime.targetListener!({
      revision: 3,
      target: { resource: { kind: 'file-history', repository: '.', filepath: 'src/other.ts' }, presentation: { mode: 'history' } },
    })).toEqual({ applied: false, reason: 'refused' })
    expect(wrapper.findComponent({ name: 'GitFileDetailPane' }).props('target')).toEqual(current)
    wrapper.unmount()

    const conflict = mountDetail()
    const conflictTarget = { resource: { kind: 'merge-conflict', repository: '.', filepath: 'src/main.ts' }, presentation: { mode: 'conflict' } }
    expect(runtime.targetListener!({ revision: 1, target: conflictTarget })).toEqual({ applied: true })
    await flushPromises()
    conflictState.value = 'busy'
    expect(runtime.targetListener!({ revision: 2, target: conflictTarget })).toEqual({ applied: false, reason: 'busy' })
    conflictState.value = 'refused'
    expect(runtime.targetListener!({ revision: 3, target: conflictTarget })).toEqual({ applied: false, reason: 'refused' })
    conflictState.value = 'accepted'
    expect(runtime.targetListener!({ revision: 4, target: conflictTarget })).toEqual({ applied: true })
    expect(conflict.find('[data-test="conflict-detail"]').exists()).toBe(true)
    conflict.unmount()
  })

  it('opens a file through the actual child event path and reports explicit false or thrown outcomes', async () => {
    const openInEditor = vi.fn()
    const wrapper = mountDetail({ openInEditor })
    expect(runtime.targetListener!({ revision: 1, target: { resource: { kind: 'file-diff', repository: '.', filepath: 'src/main.ts', staged: false, commit: '' }, presentation: { mode: 'diff' } } })).toEqual({ applied: true })
    await flushPromises()

    openInEditor.mockResolvedValueOnce({ opened: false, error: 'editor unavailable' })
    await wrapper.findAll('button.detail-open').at(-1)!.trigger('click')
    await flushPromises()
    expect(openInEditor).toHaveBeenCalledWith({ workspacePath: '', filepath: 'src/main.ts' })
    expect(notify.toast).toHaveBeenCalledWith('editor unavailable', { type: 'error' })

    notify.toast.mockClear()
    openInEditor.mockRejectedValueOnce(new Error('editor bridge failed'))
    await wrapper.findAll('button.detail-open').at(-1)!.trigger('click')
    await flushPromises()
    expect(notify.toast).toHaveBeenCalledWith('editor bridge failed', { type: 'error' })
    wrapper.unmount()
  })

})
