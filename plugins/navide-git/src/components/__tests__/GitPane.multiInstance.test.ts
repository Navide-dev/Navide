// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@navide/plugin-ui/foundation', () => ({
  vTruncate: {},
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn(async () => false) }),
}))

import GitPane from '../GitPane.vue'

const mounted: Array<{ unmount(): void }> = []

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

function responseFor(type: string): { ok: true; payload: unknown; error: null } {
  if (type === 'git.status') {
    return { ok: true, payload: {
      is_git_repo: true, branch: 'main', remote_branch: 'origin/main', ahead: 0, behind: 0,
      staged: [], unstaged: [], untracked: [], ignored: [], operation_in_progress: '',
    }, error: null }
  }
  if (type === 'git.log') return { ok: true, payload: { commits: [] }, error: null }
  if (type === 'git.branches') return { ok: true, payload: { branches: [] }, error: null }
  if (type === 'git.stash_list') return { ok: true, payload: { stashes: [] }, error: null }
  if (type === 'git.remotes') return { ok: true, payload: { remotes: [] }, error: null }
  if (type === 'git.tags') return { ok: true, payload: { tags: [] }, error: null }
  if (type === 'git.worktrees') return { ok: true, payload: { worktrees: [] }, error: null }
  return { ok: true, payload: {}, error: null }
}

function mountPane(
  workspacePath: string,
  send: (type: string) => Promise<unknown> = async (type: string) => responseFor(type),
  accounts = {
    accounts: ref<Array<{ id: string; label: string; host: string; username: string; tokenLast4: string }>>([]),
    available: ref(true),
    refresh: vi.fn(async () => {}),
    addAccount: vi.fn(async () => true),
    bind: vi.fn(async () => true),
    unbind: vi.fn(async () => true),
    getBinding: vi.fn(async () => null as string | null),
  },
  on: (type: string, handler: (payload: unknown) => void) => () => void = () => () => {},
) {
  const wrapper = mount(GitPane, {
    attachTo: document.body,
    props: {
      workspacePath,
      gitTransport: {
        status: { value: 'connected' },
        send: vi.fn(send) as never,
        on: vi.fn(on) as never,
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
  return wrapper
}

describe('GitPane menu ownership', () => {
  it('binds and unbinds accounts from the Host-backed selector', async () => {
    const accounts = {
      accounts: ref([{ id: 'account-1', label: 'GitHub', host: 'github.com', username: 'octo', tokenLast4: '1234' }]),
      available: ref(true),
      refresh: vi.fn(async () => {}),
      addAccount: vi.fn(async () => true),
      bind: vi.fn(async () => true),
      unbind: vi.fn(async () => true),
      getBinding: vi.fn(async () => null as string | null),
    }
    const wrapper = mountPane('/workspace/account', undefined, accounts)
    await flushPromises()

    await wrapper.get('.account-pill').trigger('click')
    await flushPromises()

    const menu = document.querySelector<HTMLElement>('.account-menu')
    expect(menu).not.toBeNull()
    const buttons = Array.from(menu!.querySelectorAll<HTMLButtonElement>('.menu-item'))
    buttons.find((button) => button.textContent?.includes('GitHub'))!.click()
    await flushPromises()

    expect(accounts.bind).toHaveBeenCalledWith('account-1')
    expect(wrapper.get('.account-pill-label').text()).toBe('GitHub')

    await wrapper.get('.account-pill').trigger('click')
    await flushPromises()
    const reopened = document.querySelector<HTMLElement>('.account-menu')!
    Array.from(reopened.querySelectorAll<HTMLButtonElement>('.menu-item'))
      .find((button) => button.textContent?.includes('git.account.unbound'))!
      .click()
    await flushPromises()

    expect(accounts.unbind).toHaveBeenCalledOnce()
    expect(wrapper.get('.account-pill-label').text()).toBe('git.account.unbound')
  })

  it('gives mounted panes distinct owners and keeps a sibling menu open on Escape', async () => {
    const first = mountPane('/workspace/a')
    const second = mountPane('/workspace/b')
    await flushPromises()

    expect(first.attributes('data-git-pane-owner')).not.toBe(second.attributes('data-git-pane-owner'))

    await second.findAll('.remote-btn').at(-1)!.trigger('click')
    const secondMenu = `[data-git-pane-menu-owner="${second.attributes('data-git-pane-owner')}"]`
    expect(document.querySelector(`${secondMenu}.tp-dropdown`)).not.toBeNull()
    first.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector(`${secondMenu}.tp-dropdown`)).not.toBeNull()
  })

  it('renders the Host-correlated askpass prompt for this pane', async () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    mountPane(
      '/workspace/credential',
      undefined,
      undefined,
      (type, handler) => {
        listeners.set(type, handler)
        return () => listeners.delete(type)
      },
    )
    await flushPromises()

    listeners.get('git.credential_request')?.({
      request_id: 'request-1',
      host: 'github.com',
      prompt: 'Password for https://github.com:',
    })
    await flushPromises()

    expect(document.querySelector('[data-submit-credential]')).not.toBeNull()
  })

  it('shows an actionable status error instead of repository initialization and retries', async () => {
    let statusFailed = true
    const send = vi.fn(async (type: string) => {
      if (type === 'git.status' && statusFailed) {
        return {
          ok: false,
          payload: null,
          error: { code: 'CAPABILITY_DENIED', message: 'Git capability is unavailable' },
        }
      }
      return responseFor(type)
    })
    const wrapper = mountPane('/workspace/repo', send)
    await flushPromises()

    expect(wrapper.find('.status-error-panel').text()).toContain('Git capability is unavailable')
    expect(wrapper.find('.init-panel').exists()).toBe(false)

    statusFailed = false
    await wrapper.find('.status-retry').trigger('click')
    await flushPromises()

    expect(send.mock.calls.filter(([type]) => type === 'git.status')).toHaveLength(2)
    expect(wrapper.find('.status-error-panel').exists()).toBe(false)
    expect(wrapper.find('.init-panel').exists()).toBe(false)
  })
})
