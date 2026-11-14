// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import Welcome from '../Welcome.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'

type Closed = { workspace_path: string; adopted_workspaces: string[]; closed_at: number }

function closed(path: string, adopted: string[] = []): Closed {
  return { workspace_path: path, adopted_workspaces: adopted, closed_at: Date.now() - 60_000 }
}

describe('Welcome — Recently Closed Windows', () => {
  let wrapper: VueWrapper | undefined
  let list: Closed[]
  let changed: (() => void) | null
  let reopenClosed: ReturnType<typeof vi.fn>

  beforeEach(() => {
    list = []
    changed = null
    reopenClosed = vi.fn().mockResolvedValue({ ok: true, opened: 1, focused: 0, missing: [] })
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      listOpenWorkspaces: vi.fn().mockResolvedValue([]),
      onOpenWorkspacesChanged: () => () => {},
      restore: {
        listRecentlyClosed: vi.fn(async () => list),
        reopenClosed,
        onRecentlyClosedChanged: (cb: () => void) => { changed = cb; return () => {} },
      },
    }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  async function mountWelcome(dismissible = false): Promise<void> {
    const mock = createMockBackend('connected')
    mock.setResponse('workspace.list_recent', { recent: [], path: '/tmp/recent.json' })
    wrapper = mount(Welcome, { props: { backend: mock.backend, dismissible }, global: { plugins: [i18n] } })
    await flushPromises()
  }

  it('shows nothing while no window was closed', async () => {
    await mountWelcome()
    expect(wrapper!.find('.w-closed').exists()).toBe(false)
  })

  it('lists at most three, newest first, with the other workspaces each one held', async () => {
    list = [closed('/ws/alpha', ['/ws/beta', '/ws/gamma']), closed('/ws/b'), closed('/ws/c'), closed('/ws/d')]
    await mountWelcome()
    const rows = wrapper!.findAll('.w-closed .closed-item')
    expect(rows).toHaveLength(3)
    expect(rows[0].find('.r-name').text()).toBe('alpha')
    expect(rows[0].find('.r-count').text()).toBe('+2')
    expect(rows[0].find('.r-path').text()).toContain('beta, gamma')
    expect(rows[1].find('.r-path').text()).toBe('/ws/b')
  })

  it('reopens the picked window and refreshes when the list changes', async () => {
    list = [closed('/ws/alpha'), closed('/ws/b')]
    await mountWelcome()
    await wrapper!.findAll('.w-closed .r-reopen')[1].trigger('click')
    await flushPromises()
    expect(reopenClosed).toHaveBeenCalledWith('/ws/b')
    expect(reopenClosed).toHaveBeenCalledTimes(1)

    list = []
    changed?.()
    await flushPromises()
    expect(wrapper!.find('.w-closed').exists()).toBe(false)
  })

  it('closes the picker over a working window once the window is back', async () => {
    list = [closed('/ws/alpha')]
    await mountWelcome(true)
    await wrapper!.find('.w-closed .closed-item').trigger('click')
    await flushPromises()
    expect(wrapper!.emitted('close')).toHaveLength(1)
  })
})
