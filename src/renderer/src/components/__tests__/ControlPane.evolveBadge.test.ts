// @vitest-environment happy-dom
// Workspace self-evolution entry on the sidebar heading: each heading has its
// own display-only badge (on / running / off / failed); the ⋯ menu row and
// the right-click menu row open the panel of THAT heading's workspace.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { effectScope, ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'
import {
  __resetEvolveForTest,
  noteEvolvePanes,
  setEvolveBadge,
  useEvolve,
  useEvolveBadges,
  type EvolveBadge,
} from '../../composables/useEvolve'
import type { useBackend } from '../../composables/useBackend'

const A = '/Users/me/Desktop/alpha'
const B = '/Users/me/Desktop/beta'

const wsRow = (path: string, label: string) => ({
  path,
  label,
  displayPath: '~/Desktop',
  isCurrent: true,
  collapsed: false,
  count: 1,
  paneIds: [],
  lineage: [],
  groups: [{ id: '', name: '', rows: [] }],
  remote: [],
})

const panes = [
  { id: 'a1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false, workspacePath: A },
  { id: 'b1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false, workspacePath: B },
]

const badge = (over: Partial<EvolveBadge> = {}): EvolveBadge => ({
  enabled: false,
  running: false,
  running_since: null,
  next_run_at: null,
  last_status: null,
  ...over,
})

const sent: { type: string; payload: Record<string, unknown> }[] = []

function evolveBackend(): ReturnType<typeof useBackend> {
  return {
    status: ref('connected'),
    send: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload })
      return { id: 'r', type, ok: true, payload: { ok: true, badges: {} }, error: null, timestamp: '' }
    }),
    on: () => () => {},
  } as unknown as ReturnType<typeof useBackend>
}

function mountWith(): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    attachTo: document.body,
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      backend: { send: vi.fn().mockResolvedValue({ payload: { deps: [] } }) },
      agentSpecs: [{ agentKey: 'claude', label: 'Claude Code' }],
      roles: [],
      stages: [],
      panes,
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false,
      workspace: A,
      existingProject: null,
      workspaces: [wsRow(A, 'alpha'), wsRow(B, 'beta')],
    } as never,
    global: {
      mocks: { $t: (key: string, params?: { state?: string }) => (params?.state ? `${key}:${params.state}` : key) },
    },
  })
}

const badgeOf = (wrapper: VueWrapper, n: number) => wrapper.findAll('.ws-head')[n].get('[data-test="evolve-badge"]')

describe('ControlPane – workspace self-evolution entry', () => {
  let wrapper: VueWrapper
  let scope: ReturnType<typeof effectScope>

  beforeEach(() => {
    i18n.global.locale.value = 'zh-TW'
    sent.length = 0
    __resetEvolveForTest()
    scope = effectScope()
    scope.run(() => useEvolve(evolveBackend()))
  })
  afterEach(() => {
    wrapper?.unmount()
    scope.stop()
  })

  it('asks the backend for the badge of every heading', async () => {
    wrapper = mountWith()
    await flushPromises()
    expect(sent).toEqual([{ type: 'evolve.badges', payload: { workspaces: [A, B] } }])
  })

  it('shows each workspace its own badge state', async () => {
    setEvolveBadge(A, badge({ enabled: true, next_run_at: Date.now() + 60_000 }))
    setEvolveBadge(B, badge())
    wrapper = mountWith()
    await flushPromises()
    expect(badgeOf(wrapper, 0).attributes('data-state')).toBe('on')
    expect(badgeOf(wrapper, 1).attributes('data-state')).toBe('off')
    expect(badgeOf(wrapper, 1).attributes('title')).toContain('自我優化 關')

    setEvolveBadge(B, badge({ enabled: true, running: true, running_since: Date.now() }))
    await flushPromises()
    expect(badgeOf(wrapper, 1).attributes('data-state')).toBe('running')
    expect(badgeOf(wrapper, 0).attributes('data-state')).toBe('on')

    setEvolveBadge(A, badge({ enabled: true, last_status: 'error' }))
    await flushPromises()
    expect(badgeOf(wrapper, 0).attributes('data-state')).toBe('failed')
  })

  it('shows only the icon, with the state words in the tooltip and aria-label', async () => {
    setEvolveBadge(A, badge({ enabled: true, running: true, running_since: Date.now() }))
    setEvolveBadge(B, badge())
    wrapper = mountWith()
    await flushPromises()
    for (const [n, state, words] of [
      [0, 'running', '執行中 0m'],
      [1, 'off', '自我優化 關'],
    ] as const) {
      const b = badgeOf(wrapper, n)
      expect(b.text()).toBe('✦')
      expect(b.get('[aria-hidden="true"]').text()).toBe('✦')
      expect(b.attributes('data-state')).toBe(state)
      expect(b.attributes('title')).toBe(`evolve.badge.title:${words}`)
      expect(b.attributes('aria-label')).toBe(`evolve.badge.title:${words}`)
    }

    setEvolveBadge(B, badge({ enabled: true }))
    await flushPromises()
    expect(badgeOf(wrapper, 1).text()).toBe('✦')
    expect(badgeOf(wrapper, 1).attributes('data-state')).toBe('on')
    expect(badgeOf(wrapper, 1).attributes('aria-label')).toBe('evolve.badge.title:已啟用')
  })

  it('keeps the badge display-only: click and keys open nothing and switch nothing', async () => {
    setEvolveBadge(B, badge({ enabled: true }))
    wrapper = mountWith()
    await flushPromises()
    const b = badgeOf(wrapper, 1)
    expect(b.element.tagName).toBe('SPAN')
    expect(b.attributes('role')).not.toBe('button')
    expect(b.attributes('tabindex')).toBeUndefined()
    await b.trigger('click')
    await b.trigger('dblclick')
    await b.trigger('keydown', { key: 'Enter' })
    await b.trigger('keydown', { key: ' ' })
    expect(useEvolveBadges().panelWorkspace.value).toBeNull()
    expect(wrapper.emitted('switch-to-workspace')).toBeUndefined()
    expect(b.attributes('data-state')).toBe('on')
    expect(b.text()).toBe('✦')
  })

  it('opens it from the ⋯ menu', async () => {
    wrapper = mountWith()
    await wrapper.findAll('.ws-head')[1].find('.ws-more').trigger('click')
    const item = wrapper.get('[data-test="evolve-menu"]')
    expect(item.text()).toContain('evolve.menu.open')
    await item.trigger('click')
    expect(useEvolveBadges().panelWorkspace.value).toBe(B)
    expect(wrapper.find('.ws-more-menu').exists()).toBe(false)
  })

  it('marks the ⋯ row when the workspace has it enabled', async () => {
    setEvolveBadge(A, badge({ enabled: true }))
    wrapper = mountWith()
    await wrapper.findAll('.ws-head')[0].find('.ws-more').trigger('click')
    expect(wrapper.get('[data-test="evolve-menu"]').text()).toContain('evolve.menu.enabled')
  })

  it('v1.1: tags the pane evolve opened by id, not by its name', async () => {
    const named = [
      { ...panes[0], id: 'evolve-pane-id', customName: 'whatever' },
      { ...panes[1], id: 'b1', customName: 'evolve-1009-0900' },
    ]
    noteEvolvePanes({ running: null, runs: [{ pane_id: 'evolve-pane-id' } as never] })
    // Pane rows render without a workspaces tree (same harness as the mute tag test).
    wrapper = mountWith()
    await wrapper.setProps({ panes: named, workspaces: undefined })
    const items = wrapper.findAll('.agent-item')
    const tagged = items.filter((i) => i.find('[data-test="evolve-pane-tag"]').exists())
    expect(tagged).toHaveLength(1)
    expect(tagged[0].html()).toContain('evolve.panel.system-pane')
    expect(items.length).toBe(2)
  })

  it('opens it from the right-click menu', async () => {
    wrapper = mountWith()
    await wrapper.findAll('.ws-head')[0].trigger('contextmenu')
    await wrapper.get('[data-test="evolve-ctx"]').trigger('click')
    expect(useEvolveBadges().panelWorkspace.value).toBe(A)
    expect(wrapper.find('.ws-ctx-menu').exists()).toBe(false)
  })
})
