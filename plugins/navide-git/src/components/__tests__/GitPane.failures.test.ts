// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { seedSettings } from '@navide/plugin-ui/shared'

const notify = vi.hoisted(() => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn(async () => false) }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => params ? `${key} ${JSON.stringify(params)}` : key }),
}))
vi.mock('@navide/plugin-ui/foundation', () => ({ useNotify: () => notify, vTruncate: {} }))

import GitPane from '../GitPane.vue'

const mounted: Array<{ unmount(): void }> = []
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.clearAllMocks()
})

function statusFor(type: string): { ok: true; payload: unknown; error: null } {
  if (type === 'git.status') {
    return { ok: true, payload: {
      is_git_repo: true, branch: 'main', remote_branch: 'origin/main', ahead: 0, behind: 0,
      staged: [], unstaged: [], untracked: [], ignored: [], operation_in_progress: '',
    }, error: null }
  }
  if (type === 'git.log') return { ok: true, payload: { commits: [] }, error: null }
  const empty: Record<string, unknown> = {
    'git.branches': { branches: [] }, 'git.stash_list': { stashes: [] }, 'git.remotes': { remotes: [] },
    'git.tags': { tags: [] }, 'git.worktrees': { worktrees: [] },
  }
  return { ok: true, payload: empty[type] ?? {}, error: null }
}

function mountPane(bind: () => Promise<boolean>, sendImpl: (type: string) => Promise<unknown> = async (type) => statusFor(type)) {
  const accounts = {
    accounts: ref([{ id: 'account-1', label: 'GitHub', host: 'github.com', username: 'octo', tokenLast4: '1234' }]),
    available: ref(true),
    refresh: vi.fn(async () => {}),
    addAccount: vi.fn(async () => true),
    bind: vi.fn(bind),
    unbind: vi.fn(async () => true),
    getBinding: vi.fn(async () => null as string | null),
  }
  const wrapper = mount(GitPane, {
    attachTo: document.body,
    props: {
      workspacePath: '/workspace/failures',
      gitTransport: {
        status: { value: 'connected' },
        send: vi.fn(sendImpl) as never,
        on: vi.fn(() => () => {}) as never,
      },
      fileAccess: { readFile: vi.fn(), writeFile: vi.fn(), readImage: vi.fn() },
      ui: {
        openInEditor: vi.fn(), openExternal: vi.fn(), revealPath: vi.fn(), openPath: vi.fn(),
        openTempFile: vi.fn(), pickWorkspace: vi.fn(), openMainWindow: vi.fn(),
        openBranchDiffWindow: vi.fn(), openGitWindow: vi.fn(), openGitHistoryWindow: vi.fn(),
      },
      issuePort: { provider: vi.fn(), list: vi.fn(), get: vi.fn(), create: vi.fn(), comment: vi.fn(), setState: vi.fn() },
      accounts,
    },
    global: { mocks: { $t: (key: string) => key } },
  })
  mounted.push(wrapper)
  return { wrapper, accounts }
}

describe('GitPane failure outlets', () => {
  it('tells the user when binding a Git account fails (MED-1)', async () => {
    const { wrapper, accounts } = mountPane(async () => false)
    await flushPromises()
    await wrapper.get('.account-pill').trigger('click')
    await flushPromises()
    Array.from(document.querySelectorAll<HTMLButtonElement>('.account-menu .menu-item'))
      .find((button) => button.textContent?.includes('GitHub'))!.click()
    await flushPromises()

    expect(accounts.bind).toHaveBeenCalledWith('account-1')
    expect(notify.toast).toHaveBeenCalledWith('git.account-update-failed', { type: 'error' })
    expect(wrapper.get('.account-pill-label').text()).toBe('git.account.unbound')
  })

  it('says when the status list stopped at the backend cap (#144)', async () => {
    const send = async (type: string) => {
      if (type !== 'git.status') return statusFor(type)
      const reply = statusFor(type) as { payload: Record<string, unknown> }
      return { ...reply, payload: { ...reply.payload, untracked: [{ path: 'a.txt', status: '?' }], truncated: true } }
    }
    const { wrapper } = mountPane(async () => true, send)
    await flushPromises()
    expect(wrapper.find('.status-truncated-banner').text()).toBe('git.status-truncated')
  })

  it('shows no truncation notice for a complete status', async () => {
    const { wrapper } = mountPane(async () => true)
    await flushPromises()
    expect(wrapper.find('.status-truncated-banner').exists()).toBe(false)
  })

  it('reports auto-commit failures instead of stopping silently (MED-3)', async () => {
    seedSettings({ 'agentTeam.git.autoCommit': 'true' })
    vi.useFakeTimers()
    try {
      let staged = false
      const send = vi.fn(async (type: string) => {
        if (type === 'git.stage_all') { staged = true; return { ok: true, payload: { ok: true }, error: null } }
        if (type === 'git.check_staged') return { ok: true, payload: { ok: true, error_count: 0, summary: '' }, error: null }
        if (type === 'git.generate_message') return { ok: true, payload: { ok: false, error: 'model unavailable' }, error: null }
        if (type === 'git.status') {
          const file = [{ path: 'a.txt', status: 'M' }]
          return { ok: true, payload: {
            is_git_repo: true, branch: 'main', remote_branch: 'origin/main', ahead: 0, behind: 0,
            staged: staged ? file : [], unstaged: staged ? [] : file, untracked: [], ignored: [], operation_in_progress: '',
          }, error: null }
        }
        return statusFor(type)
      })
      const { wrapper } = mountPane(async () => true, send)
      await vi.advanceTimersByTimeAsync(0)
      await flushPromises()
      await vi.advanceTimersByTimeAsync(61_000)
      await flushPromises()

      expect(send).toHaveBeenCalledWith('git.generate_message', expect.anything(), expect.anything())
      expect(notify.toast).toHaveBeenCalledWith('git.auto-commit-generate-failed', { type: 'error' })
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
      seedSettings({ 'agentTeam.git.autoCommit': 'false' })
    }
  })
})
