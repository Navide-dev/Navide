// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import Welcome from '../Welcome.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { RecentWorkspace } from '../../composables/useRecentWorkspaces'

function recentItem(path: string, last_known_state: string): RecentWorkspace {
  return {
    path,
    name: path.split('/').pop() ?? path,
    last_opened_at: new Date().toISOString(),
    pinned: false,
    last_known_state,
    last_known_task: '',
    exists: true
  }
}

// The backend mirrors Project.state onto the recent entry when a pipeline
// starts/resumes/completes/aborts. Everything else ('' for entries written
// before that, 'idle' for a workspace only ever used to spawn CLI panes) means
// "never ran a pipeline" and must not render a placeholder badge.
const RECENT = [
  recentItem('/Users/test/ran-ok', 'completed'),
  recentItem('/Users/test/in-flight', 'running'),
  recentItem('/Users/test/stopped', 'aborted'),
  recentItem('/Users/test/never-ran', 'idle'),
  recentItem('/Users/test/legacy', '')
]

describe('Welcome recent-workspace state badge', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      listOpenWorkspaces: () => Promise.resolve([]),
      focusWorkspaceWindow: () => Promise.resolve(false),
      onOpenWorkspacesChanged: () => () => {}
    }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  async function mountWelcome(): Promise<void> {
    const mock = createMockBackend('connected')
    mock.setResponse('workspace.list_recent', { recent: RECENT, path: '/tmp/recent.json' })
    wrapper = mount(Welcome, {
      props: { backend: mock.backend },
      global: { plugins: [i18n] }
    })
    await flushPromises()
  }

  it('badges each pipeline outcome with its own label and class', async () => {
    await mountWelcome()
    const items = wrapper!.findAll('.recent-item')
    expect(items).toHaveLength(5)

    const completed = items[0].find('.r-badge')
    expect(completed.text()).toContain('completed')
    expect(completed.classes()).toContain('completed')

    const running = items[1].find('.r-badge')
    expect(running.text()).toContain('running')
    expect(running.classes()).toContain('running')

    const aborted = items[2].find('.r-badge')
    expect(aborted.text()).toContain('aborted')
    expect(aborted.classes()).toContain('aborted')
  })

  it('renders no badge for workspaces that never ran a pipeline', async () => {
    await mountWelcome()
    const items = wrapper!.findAll('.recent-item')
    expect(items[3].find('.r-badge').exists()).toBe(false)
    expect(items[4].find('.r-badge').exists()).toBe(false)
  })

  it('never shows the old spawn-only placeholder', async () => {
    await mountWelcome()
    expect(wrapper!.text()).not.toContain('spawn-only')
  })

  // The badges and the "3m ago" times were English literals in the component,
  // so a Chinese or Japanese window read them in English.
  it('labels badges and times in the window language', async () => {
    const previous = i18n.global.locale.value
    i18n.global.locale.value = 'zh-TW'
    try {
      await mountWelcome()
      const items = wrapper!.findAll('.recent-item')
      expect(items[1].find('.r-badge').text()).toContain('執行中')
      expect(items[0].find('.r-time').text()).toBe('剛剛')
      expect(wrapper!.text()).not.toMatch(/running|completed|aborted|just now|ago/)
    } finally {
      i18n.global.locale.value = previous
    }
  })
})
