// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@navide/plugin-ui/foundation', () => ({
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn(async () => false) }),
  vTruncate: {},
}))

import GitPane from '../GitPane.vue'

const mounted: Array<{ unmount(): void }> = []
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  document.body.replaceChildren()
})

function send(type: string): Promise<unknown> {
  if (type === 'git.status') {
    return Promise.resolve({ ok: true, error: null, payload: {
      is_git_repo: true, branch: 'main', remote_branch: 'origin/main', ahead: 0, behind: 0,
      staged: [], unstaged: [{ path: 'a.txt', status: 'M' }], untracked: [], ignored: [], operation_in_progress: '',
    } })
  }
  const empty: Record<string, unknown> = {
    'git.log': { commits: [] }, 'git.branches': { branches: [] }, 'git.stash_list': { stashes: [] },
    'git.remotes': { remotes: [] }, 'git.tags': { tags: [] }, 'git.worktrees': { worktrees: [] },
  }
  return Promise.resolve({ ok: true, payload: empty[type] ?? {}, error: null })
}

async function openFileMenu() {
  const wrapper = mount(GitPane, {
    attachTo: document.body,
    props: {
      workspacePath: '/workspace/submenu',
      gitTransport: { status: { value: 'connected' }, send: vi.fn(send) as never, on: vi.fn(() => () => {}) as never },
      fileAccess: { readFile: vi.fn(), writeFile: vi.fn(), readImage: vi.fn() },
      ui: {
        openInEditor: vi.fn(), openExternal: vi.fn(), revealPath: vi.fn(), openPath: vi.fn(),
        openTempFile: vi.fn(), pickWorkspace: vi.fn(), openMainWindow: vi.fn(),
        openBranchDiffWindow: vi.fn(), openGitWindow: vi.fn(), openGitHistoryWindow: vi.fn(),
      },
      issuePort: { provider: vi.fn(), list: vi.fn(), get: vi.fn(), create: vi.fn(), comment: vi.fn(), setState: vi.fn() },
      accounts: {
        accounts: ref([]), available: ref(true), refresh: vi.fn(async () => {}), addAccount: vi.fn(async () => true),
        bind: vi.fn(async () => true), unbind: vi.fn(async () => true), getBinding: vi.fn(async () => null),
        updateAccount: vi.fn(async () => true), removeAccount: vi.fn(async () => true),
      },
    },
    global: { mocks: { $t: (key: string) => key } },
  })
  mounted.push(wrapper)
  await flushPromises()
  const row = Array.from(document.querySelectorAll<HTMLElement>('.file-row'))
    .find((el) => el.textContent?.includes('a.txt'))!
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
  await flushPromises()
  const ignoreRow = Array.from(document.querySelectorAll<HTMLElement>('.ctx-menu .has-sub'))
    .find((el) => el.textContent?.includes('action.add-to-ignore'))!
  return ignoreRow
}

function hover(row: HTMLElement, rect: { left: number; right: number }, viewportWidth: number): void {
  const submenu = row.querySelector<HTMLElement>('.ctx-submenu')!
  row.getBoundingClientRect = () => rect as DOMRect
  Object.defineProperty(submenu, 'offsetWidth', { configurable: true, get: () => 220 })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth })
  row.dispatchEvent(new MouseEvent('mouseenter'))
}

describe('Host GitPane "Add to Ignore" submenu placement', () => {
  it('keeps opening to the right when there is room', async () => {
    const row = await openFileMenu()
    hover(row, { left: 10, right: 230 }, 800)
    expect(row.dataset.subPlace).toBe('right')
  })

  it('flips to the left when the right edge would clip it', async () => {
    const row = await openFileMenu()
    hover(row, { left: 300, right: 520 }, 600)
    expect(row.dataset.subPlace).toBe('left')
  })

  it('drops below the row when neither side has room', async () => {
    const row = await openFileMenu()
    hover(row, { left: 40, right: 260 }, 300)
    expect(row.dataset.subPlace).toBe('below')
  })
})
