// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import GitWindowApp from '../GitWindowApp.vue'
import {
  GIT_ACCOUNTS_KEY,
  GIT_BRANCH_DIFF_KEY,
  GIT_FILE_ACCESS_KEY,
  GIT_ISSUES_KEY,
  GIT_TRANSPORT_KEY,
  GIT_UI_KEY,
} from '../ports/gitSurface'
import type { GitTransport, GitTransportResponse } from '#git-feature'

// D6 (0.2.42): a real repository showed "Not a Git repository" in the Git
// window with nothing in the console. The window only looked at
// gitStatus.is_git_repo, so a failed git.status (git's own error, e.g.
// dubious ownership, or a transport error) and a read still in flight both
// rendered the init card. The Git pane already shows the error with a retry.

const DUBIOUS = "fatal: detected dubious ownership in repository at '/workspace'"
const REPO_STATUS = {
  is_git_repo: true, branch: 'main', remote_branch: '', ahead: 0, behind: 0,
  staged: [], unstaged: [], untracked: [], ignored: [], operation_in_progress: '',
}

const ok = async (): Promise<GitTransportResponse> => ({ ok: true, payload: REPO_STATUS, error: null })
// Every git.status read gets this reply until a test swaps it.
let statusReply: () => Promise<GitTransportResponse> = ok
let statusCalls = 0

const transport: GitTransport = {
  status: { value: 'connected' },
  async send<TPayload = unknown>(type: Parameters<GitTransport['send']>[0]) {
    if (type === 'git.status') {
      statusCalls++
      return (await statusReply()) as GitTransportResponse<TPayload>
    }
    if (type === 'git.discover_repositories') {
      return { ok: true, payload: { ok: true, repositories: [] }, error: null } as GitTransportResponse<TPayload>
    }
    return { ok: true, payload: { ok: true }, error: null } as GitTransportResponse<TPayload>
  },
  on: () => () => undefined,
}

const aiCliController = {
  sessionId: null, profileId: null,
  listProfiles: vi.fn(async () => []), resume: vi.fn(async () => null), start: vi.fn(async () => 'session'),
  send: vi.fn(async () => undefined), resize: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined), dispose: vi.fn(), onOutput: vi.fn(() => () => undefined), onExit: vi.fn(() => () => undefined),
} as unknown as import('@navide/plugin-ui').AiCliSessionController

describe('navide.git window status failures (D6)', () => {
  let wrapper: VueWrapper | null = null
  afterEach(() => { wrapper?.unmount(); wrapper = null; statusReply = ok; statusCalls = 0 })

  async function mountWindow(): Promise<VueWrapper> {
    window.history.replaceState({}, '', '/?workspace_path=%2Fworkspace')
    const w = mount(GitWindowApp, {
      attachTo: document.body,
      props: {
        workspaceGrantPort: { pickWorkspace: vi.fn(async () => null), openWorkspace: vi.fn(async () => undefined), openKnownWorktree: vi.fn(async () => undefined) },
        aiCliController,
      },
      global: {
        plugins: [i18n],
        stubs: { SafeAiCliPanel: true, GitCredentialModal: true, GitHistoryModal: true, NotificationHost: true, DiffPane: true, BranchDiffPane: true, ConflictPane: true },
        provide: {
          [GIT_TRANSPORT_KEY as symbol]: transport,
          [GIT_FILE_ACCESS_KEY as symbol]: { readFile: vi.fn(), writeFile: vi.fn(), readImage: vi.fn() },
          [GIT_UI_KEY as symbol]: { openInEditor: vi.fn(), openExternal: vi.fn(), revealPath: vi.fn(), pickFolder: vi.fn() },
          [GIT_BRANCH_DIFF_KEY as symbol]: { load: vi.fn() },
          [GIT_ACCOUNTS_KEY as symbol]: {
            accounts: { value: [] }, available: { value: true }, refresh: vi.fn(async () => undefined),
            addAccount: vi.fn(async () => true), bind: vi.fn(async () => true), unbind: vi.fn(async () => true),
            getBinding: vi.fn(async () => null),
          },
          [GIT_ISSUES_KEY as symbol]: { provider: vi.fn(async () => ({ ok: true, payload: { provider: 'none' }, error: null })), list: vi.fn(), get: vi.fn(), create: vi.fn(), comment: vi.fn(), setState: vi.fn() },
        },
      },
    })
    await flushPromises()
    return w
  }

  it('shows git\'s error instead of "Not a Git repository" when git.status fails, and retries', async () => {
    statusReply = async () => ({ ok: true, payload: { ok: false, error: DUBIOUS }, error: null })
    wrapper = await mountWindow()

    expect(wrapper.find('.init-card').exists()).toBe(false)
    expect(wrapper.get('.status-error').text()).toContain('detected dubious ownership')

    const callsBefore = statusCalls
    statusReply = ok
    await wrapper.get('.status-error button').trigger('click')
    await flushPromises()

    expect(statusCalls).toBeGreaterThan(callsBefore)
    expect(wrapper.find('.status-error').exists()).toBe(false)
    expect(wrapper.find('.init-card').exists()).toBe(false)
    expect(wrapper.find('.body').exists()).toBe(true)
  })

  it('shows a transport error instead of "Not a Git repository"', async () => {
    statusReply = async () => ({ ok: false, payload: null, error: { code: 'BACKEND_ERROR', message: 'request git.status timeout' } })
    wrapper = await mountWindow()

    expect(wrapper.find('.init-card').exists()).toBe(false)
    expect(wrapper.get('.status-error').text()).toContain('request git.status timeout')
  })

  it('does not show "Not a Git repository" before the first status read answers', async () => {
    let answer!: (r: GitTransportResponse) => void
    statusReply = () => new Promise<GitTransportResponse>(resolve => { answer = resolve })
    wrapper = await mountWindow()

    expect(wrapper.find('.init-card').exists()).toBe(false)

    statusReply = ok
    answer({ ok: true, payload: REPO_STATUS, error: null })
    await flushPromises()
    expect(wrapper.find('.init-card').exists()).toBe(false)
    expect(wrapper.find('.body').exists()).toBe(true)
  })

  it('still offers init for a folder git says is not a repository', async () => {
    statusReply = async () => ({ ok: true, payload: { ...REPO_STATUS, is_git_repo: false, branch: '' }, error: null })
    wrapper = await mountWindow()

    expect(wrapper.find('.status-error').exists()).toBe(false)
    expect(wrapper.find('.init-card').exists()).toBe(true)
  })
})
