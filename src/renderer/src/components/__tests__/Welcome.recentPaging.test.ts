// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import Welcome from '../Welcome.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { RecentWorkspace } from '../../composables/useRecentWorkspaces'

function item(i: number, extra: Partial<RecentWorkspace> = {}): RecentWorkspace {
  const name = `w${String(i).padStart(2, '0')}`
  return {
    path: `/Users/test/${name}`,
    name,
    last_opened_at: new Date(Date.now() - i * 60_000).toISOString(),
    pinned: false,
    last_known_state: '',
    last_known_task: '',
    exists: true,
    ...extra
  }
}

// 25 entries, most recent first. w03 and w07 are open in a window, w20 is pinned.
const RECENT = Array.from({ length: 25 }, (_, i) => item(i, i === 20 ? { pinned: true } : {}))
const OPEN = ['/Users/test/w03', '/Users/test/w07']

describe('Welcome Recent list paging', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      listOpenWorkspaces: vi.fn().mockResolvedValue(OPEN),
      focusWorkspaceWindow: vi.fn().mockResolvedValue(false),
      onOpenWorkspacesChanged: () => () => {}
    }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  async function mountWelcome(extra: Record<string, unknown> = {}) {
    const mock = createMockBackend('connected')
    mock.setResponse('workspace.list_recent', { recent: RECENT, path: '/tmp/r.json', limit: 1000, trimmed: 0, ...extra })
    mock.setResponse('workspace.touch', { recent: RECENT, limit: 1000, trimmed: 0 })
    wrapper = mount(Welcome, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return mock
  }

  const names = (sel: string): string[] => wrapper!.findAll(`${sel} .r-name`).map((n) => n.text())
  const moreButton = () => wrapper!.find('.r-more')

  it('shows pinned and open workspaces first, then the first page of the rest', async () => {
    await mountWelcome()
    expect(names('.recent-group--open')).toEqual(['w20', 'w03', 'w07'])
    expect(names('.recent-group--recent')).toHaveLength(10)
    expect(names('.recent-group--recent')[0]).toBe('w00')
    expect(moreButton().text()).toContain('12')
  })

  it('loads the next page on "show more" and hides the button at the end', async () => {
    await mountWelcome()
    await moreButton().trigger('click')
    expect(names('.recent-group--recent')).toHaveLength(20)
    expect(moreButton().text()).toContain('2')
    await moreButton().trigger('click')
    expect(names('.recent-group--recent')).toHaveLength(22)
    expect(moreButton().exists()).toBe(false)
  })

  it('search matches entries that are not loaded yet', async () => {
    await mountWelcome()
    expect(wrapper!.text()).not.toContain('w24')
    await wrapper!.find('.r-search').setValue('W24')
    expect(names('.recent-item')).toEqual(['w24'])
    await wrapper!.find('.r-search').setValue('/Users/test/w0')
    expect(names('.recent-item')).toContain('w03')
    await wrapper!.find('.r-search').setValue('nothing-like-this')
    expect(wrapper!.findAll('.recent-item')).toHaveLength(0)
    expect(wrapper!.find('.r-nomatch').exists()).toBe(true)
  })

  it('says so when the history limit trimmed entries', async () => {
    await mountWelcome({ trimmed: 3 })
    expect(wrapper!.find('.r-trimmed').text()).toContain('3')
  })

  it('stays quiet when nothing was trimmed', async () => {
    await mountWelcome()
    expect(wrapper!.find('.r-trimmed').exists()).toBe(false)
  })

  it('offers "remove from list" on every row, open ones included', async () => {
    await mountWelcome()
    const rows = wrapper!.findAll('.recent-item')
    expect(rows.every((r) => r.find('.r-delete').exists())).toBe(true)
  })

  it('keeps a folder that no longer exists, marked missing', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('workspace.list_recent', { recent: [item(0, { exists: false })], path: '', limit: 1000, trimmed: 0 })
    wrapper = mount(Welcome, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('.recent-item.stale .r-missing').exists()).toBe(true)
  })

  it('tells the backend which workspaces are open when it records an open', async () => {
    const mock = await mountWelcome()
    await wrapper!.findAll('.recent-group--recent .recent-item')[0].trigger('click')
    await flushPromises()
    const touch = mock.sent.find((s) => s.type === 'workspace.touch')
    expect(touch?.payload).toMatchObject({ path: '/Users/test/w00', open: OPEN })
  })

  it('opens a row from the keyboard', async () => {
    await mountWelcome()
    const row = wrapper!.findAll('.recent-group--recent .recent-item')[1]
    expect(row.attributes('tabindex')).toBe('0')
    await row.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper!.emitted('select')).toEqual([['/Users/test/w01']])
  })
})
