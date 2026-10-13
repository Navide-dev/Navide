// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import Welcome from '../Welcome.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { RecentWorkspace } from '../../composables/useRecentWorkspaces'

function recentItem(path: string): RecentWorkspace {
  return {
    path,
    name: path.split('/').pop() ?? path,
    last_opened_at: new Date().toISOString(),
    pinned: false,
    last_known_state: '',
    last_known_task: '',
    exists: true
  }
}

const RECENT = [recentItem('/Users/test/proj-a'), recentItem('/Users/test/proj-b')]

describe('Welcome open-workspace dedup', () => {
  let wrapper: VueWrapper | undefined
  let openChangedCb: (() => void) | null
  let disposeOpenChanged: ReturnType<typeof vi.fn>
  let listOpenWorkspaces: ReturnType<typeof vi.fn>
  let focusWorkspaceWindow: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openChangedCb = null
    disposeOpenChanged = vi.fn()
    listOpenWorkspaces = vi.fn().mockResolvedValue(['/Users/test/proj-a'])
    focusWorkspaceWindow = vi.fn().mockResolvedValue(false)
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      listOpenWorkspaces,
      focusWorkspaceWindow,
      onOpenWorkspacesChanged: (cb: () => void) => {
        openChangedCb = cb
        return disposeOpenChanged
      }
    }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  async function mountWelcome() {
    const mock = createMockBackend('connected')
    mock.setResponse('workspace.list_recent', { recent: RECENT, path: '/tmp/recent.json' })
    mock.setResponse('workspace.touch', { recent: RECENT })
    wrapper = mount(Welcome, {
      props: { backend: mock.backend },
      global: { plugins: [i18n] }
    })
    await flushPromises()
    return mock
  }

  it('badges only the workspaces open in another window', async () => {
    await mountWelcome()
    const items = wrapper!.findAll('.recent-item')
    expect(items).toHaveLength(2)
    expect(items[0].find('.r-open').exists()).toBe(true)
    expect(items[1].find('.r-open').exists()).toBe(false)
  })

  // Removing is the only way an entry leaves Recent, so every row offers it —
  // an open workspace keeps running; only its history row goes.
  it('keeps the remove button on open workspaces too', async () => {
    await mountWelcome()
    const items = wrapper!.findAll('.recent-item')
    expect(items[0].find('.r-delete').exists()).toBe(true)
    expect(items[1].find('.r-delete').exists()).toBe(true)
  })

  it('treats trailing-slash paths as the same workspace', async () => {
    listOpenWorkspaces.mockResolvedValue(['/Users/test/proj-b/'])
    await mountWelcome()
    const byName = (n: string) => wrapper!.findAll('.recent-item').find((i) => i.find('.r-name').text() === n)!
    expect(byName('proj-a').find('.r-open').exists()).toBe(false)
    expect(byName('proj-b').find('.r-open').exists()).toBe(true)
  })

  it('re-queries the open list when main broadcasts workspace:openChanged', async () => {
    await mountWelcome()
    listOpenWorkspaces.mockResolvedValue([])
    openChangedCb!()
    await flushPromises()
    expect(wrapper!.find('.r-open').exists()).toBe(false)
  })

  it('focuses the existing window instead of opening a duplicate', async () => {
    focusWorkspaceWindow.mockResolvedValue(true)
    const mock = await mountWelcome()
    await wrapper!.findAll('.recent-item')[0].trigger('click')
    await flushPromises()
    expect(focusWorkspaceWindow).toHaveBeenCalledWith('/Users/test/proj-a')
    expect(wrapper!.emitted('select')).toBeUndefined()
    expect(mock.sent.some((s) => s.type === 'workspace.touch')).toBe(false)
  })

  it('opens normally when no other window has the workspace', async () => {
    const mock = await mountWelcome()
    await wrapper!.findAll('.recent-item')[1].trigger('click')
    await flushPromises()
    expect(focusWorkspaceWindow).toHaveBeenCalledWith('/Users/test/proj-b')
    expect(wrapper!.emitted('select')).toEqual([['/Users/test/proj-b']])
    expect(mock.sent.some((s) => s.type === 'workspace.touch')).toBe(true)
  })

  it('disposes the openChanged listener on unmount', async () => {
    await mountWelcome()
    wrapper!.unmount()
    wrapper = undefined
    expect(disposeOpenChanged).toHaveBeenCalledTimes(1)
  })
})
