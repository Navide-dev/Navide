// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MultiRepoGit from '../MultiRepoGit.vue'
import GitPane from '../GitPane.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { GitStatus } from '../../composables/useGit'
import { createHostGitSurfacePorts } from '../../composables/hostSurfacePorts'

// A workspace on a cloud-synced folder: the backend refuses the downward walk
// until the user opts in. Clicking "scan anyway" inside GitPane must fill in
// MultiRepoGit's tab bar too — and cost exactly ONE forced walk, because on a
// File Provider mount each walk blocks for minutes.

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (k: string) => k }),
}))

const NOT_A_REPO: GitStatus = {
  is_git_repo: false,
  branch: '',
  remote_branch: '',
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  ignored: [],
  operation_in_progress: '',
}

const SKIPPED_RESPONSE = {
  ok: true,
  repositories: [],
  truncated: true,
  skipped: 'cloud_storage',
}

const FORCED_RESPONSE = {
  ok: true,
  repositories: [
    { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
  ],
}

function makeMock() {
  const mock = createMockBackend('connected')
  mock.setResponse('git.status', NOT_A_REPO)
  mock.setResponse('git.discover_repositories', SKIPPED_RESPONSE)
  return mock
}

function discoverCalls(mock: ReturnType<typeof createMockBackend>) {
  return mock.sent.filter((s) => s.type === 'git.discover_repositories')
}

function forcedCalls(mock: ReturnType<typeof createMockBackend>) {
  return discoverCalls(mock).filter((s) => s.payload.force === true)
}

function surfacePorts(mock: ReturnType<typeof createMockBackend>) {
  return createHostGitSurfacePorts(mock.backend, mock.backend)
}

const mountOpts = { global: { mocks: { $t: (k: string) => k } } }

/** The "Scan for Repositories Anyway" button rendered by GitPane's init panel. */
function scanButton(wrapper: { findAll: (s: string) => { text: () => string }[] }) {
  return wrapper
    .findAll('button')
    .find((b) => b.text().includes('action.scan-repos-anyway'))
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* ignore */ }
})

describe('forced repo discovery — one click, one walk', () => {
  it('fills MultiRepoGit\'s tab bar from GitPane\'s scan with a single forced request', async () => {
    const mock = makeMock()
    const wrapper = mount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: mock.backend, surfacePorts: surfacePorts(mock) },
      ...mountOpts,
    })
    await flushPromises()

    // Cloud-synced: no repos discovered, so no tab bar yet.
    expect(wrapper.find('.repo-tab-bar').exists()).toBe(false)
    expect(forcedCalls(mock)).toHaveLength(0)

    const btn = scanButton(wrapper as never) as unknown as { trigger: (e: string) => Promise<void> }
    expect(btn).toBeTruthy()

    mock.setResponse('git.discover_repositories', FORCED_RESPONSE)
    await btn.trigger('click')
    await flushPromises()

    // The hard constraint: the click caused exactly ONE forced walk.
    expect(forcedCalls(mock)).toHaveLength(1)
    expect(forcedCalls(mock)[0].payload.workspace_path).toBe('/ws')

    // ...and MultiRepoGit adopted its result: root tab + the two found repos.
    expect(wrapper.find('.repo-tab-bar').exists()).toBe(true)
    const names = wrapper.findAll('.repo-tab-name').map((n) => n.text())
    expect(names).toEqual(['label.git-repo-root', 'a', 'b'])
  })

  it('keeps the adopted repos and never forces again on a git.changed re-discovery', async () => {
    vi.useFakeTimers()
    try {
      const mock = makeMock()
      const wrapper = mount(MultiRepoGit, {
        props: { workspacePath: '/ws', backend: mock.backend, surfacePorts: surfacePorts(mock) },
        ...mountOpts,
      })
      await vi.runAllTimersAsync()

      const btn = scanButton(wrapper as never) as unknown as { trigger: (e: string) => Promise<void> }
      mock.setResponse('git.discover_repositories', FORCED_RESPONSE)
      await btn.trigger('click')
      await vi.runAllTimersAsync()
      expect(wrapper.find('.repo-tab-bar').exists()).toBe(true)

      // The backend goes back to skipping once the forced walk is over.
      mock.setResponse('git.discover_repositories', SKIPPED_RESPONSE)
      mock.emit('git.changed', { workspace_path: '/ws' })
      await vi.runAllTimersAsync()

      // Still one forced call in total, and the user's result survived.
      expect(forcedCalls(mock)).toHaveLength(1)
      expect(discoverCalls(mock).length).toBeGreaterThan(1)
      expect(wrapper.find('.repo-tab-bar').exists()).toBe(true)
      expect(wrapper.findAll('.repo-tab-name').map((n) => n.text()))
        .toEqual(['label.git-repo-root', 'a', 'b'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never forces on a workspace switch', async () => {
    const mock = makeMock()
    const wrapper = mount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: mock.backend, surfacePorts: surfacePorts(mock) },
      ...mountOpts,
    })
    await flushPromises()

    await wrapper.setProps({ workspacePath: '/ws2' })
    await flushPromises()

    expect(forcedCalls(mock)).toHaveLength(0)
    expect(discoverCalls(mock).some((c) => c.payload.workspace_path === '/ws2')).toBe(true)
  })

  it('standalone GitPane (no MultiRepoGit host) still scans on its own', async () => {
    const mock = makeMock()
    const wrapper = mount(GitPane, {
      props: {
        workspacePath: '/ws',
        gitTransport: mock.backend,
        fileAccess: mock.fileAccess,
        ui: surfacePorts(mock).paneUi,
        issuePort: mock.issuePort,
        accounts: surfacePorts(mock).accounts,
      },
      ...mountOpts,
    })
    await flushPromises()

    const btn = scanButton(wrapper as never) as unknown as { trigger: (e: string) => Promise<void> }
    expect(btn).toBeTruthy()

    mock.setResponse('git.discover_repositories', FORCED_RESPONSE)
    await btn.trigger('click')
    await flushPromises()

    expect(forcedCalls(mock)).toHaveLength(1)
    // Its own nested-repo list is filled in, and the emit is simply unheard.
    expect(wrapper.findAll('.repo-row').map((r) => r.find('.repo-path').text()))
      .toEqual(['a', 'b'])
    expect(wrapper.emitted('force-discovered')).toHaveLength(1)
    expect(wrapper.emitted('force-discovered')![0][0]).toEqual(FORCED_RESPONSE.repositories)
  })
})
