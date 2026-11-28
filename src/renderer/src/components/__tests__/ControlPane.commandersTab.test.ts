// @vitest-environment happy-dom
// The Commanders sidebar tab (0.2.51): placed right after Agents, Cmd+6 (see
// ControlPane.sidebarShortcut.test.ts), its state chip at the tail of a
// dispatched pane's row, and "Upgrade to commander" on an expanded row.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'
import { _resetRegistry } from '@navide/plugin-ui/shared/testing'
import { resetCommandersForTest, useCommanders } from '../../composables/useCommanders'
import { commanderSummary, fakeBackend, node, tree } from '../../composables/__tests__/commanderFixtures'

function props(backend: unknown): Record<string, unknown> {
  return {
    backend,
    backendStatus: 'connected',
    backendUrl: '',
    agentSpecs: [{ agentKey: 'claude', label: 'Claude Code' }],
    roles: [],
    stages: [],
    panes: [
      { id: 'body-1', agentLabel: 'Navide指揮', agentKey: 'claude', status: 'idle', command: 'claude', origin: 'manual', workspacePath: '/w' },
      { id: 'dev', agentLabel: 'dev', agentKey: 'claude', status: 'running', command: 'claude', origin: 'mcp', workspacePath: '/w' },
      { id: 'shell', agentLabel: 'shell', agentKey: 'claude', status: 'idle', command: 'claude', origin: 'manual', workspacePath: '/w' },
    ],
    pipeline: { state: 'idle' },
    yoloEnabled: false,
    analyzerModel: '',
    analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
    autoAnswerEnabled: false,
    existingProject: null,
  }
}

describe('ControlPane – Commanders tab', () => {
  let wrapper: VueWrapper

  beforeEach(async () => {
    _resetRegistry()
    sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
    const backend = fakeBackend({
      'commander.list': { commanders: [commanderSummary()] },
      'commander.tree': tree('c1', [node('dev', 'working')]),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, { props: props(backend), global: { mocks: { $t: (key: string) => key } } })
    await flushPromises()
  })

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
    resetCommandersForTest()
    _resetRegistry()
  })

  it('is the tab right after Agents and mounts the commander list', async () => {
    const tabs = wrapper.findAll('.sidebar-tabs .tab-btn').map((b) => b.attributes('data-tab'))
    expect(tabs.slice(0, 2)).toEqual(['agents', 'commanders'])
    expect(wrapper.findComponent({ name: 'CommanderList' }).exists()).toBe(false)
    await wrapper.find('.sidebar-tabs .tab-btn[data-tab="commanders"]').trigger('click')
    expect(wrapper.findComponent({ name: 'CommanderList' }).exists()).toBe(true)
  })

  it('binds the window backend to the shared commander store', () => {
    expect(useCommanders().commanders.value.map((c) => c.id)).toEqual(['c1'])
  })

  it('puts the detected state chip at the tail of a dispatched pane row only', () => {
    const rows = wrapper.findAll('.agent-item')
    const chips = rows.map((r) => r.find('[data-testid="commander-row-chip"]'))
    expect(chips.map((c) => c.exists())).toEqual([false, true, false])
    expect(chips[1].text()).toBe('commander.state.working')
  })

  it('offers Upgrade to commander on an expanded row, but not on a commander body', async () => {
    const lines = wrapper.findAll('.agent-line')
    await lines[2].trigger('click')
    const upgrade = wrapper.find('[data-testid="commander-upgrade"]')
    expect(upgrade.exists()).toBe(true)
    await upgrade.trigger('click')
    expect(useCommanders().createOpen.value).toBe(true)
    expect(useCommanders().createPaneId.value).toBe('shell')

    await lines[0].trigger('click')
    expect(wrapper.find('[data-testid="commander-upgrade"]').exists()).toBe(false)
  })
})
