// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentsSettingsPane from '../AgentsSettingsPane.vue'

// Settings → Agents lists identities, open or closed, and shows the selected
// one's identity, channel, schedules, memory and flags — with empty states
// where Navide has no source.

const row = (id: string, name: string, open: boolean, agentKey = 'hermes') => ({
  identity: { id, name, color: 'teal', agentKey, workspacePath: '/w', paneId: open ? `pane-${id}` : null, sessionId: null, createdAt: 1 },
  open,
  status: open ? 'idle' : '',
})

function mountPane(agents = [row('a', 'Secretary', true), row('b', 'Researcher', false, 'openclaw')], focusId?: string) {
  const agentConsole = { jobsFor: () => [], patch: vi.fn() }
  const channels = { bindingFor: () => null, accountState: () => null }
  const wrapper = mount(AgentsSettingsPane, {
    props: { agents: agents as never, focusId, console: agentConsole as never, channels: channels as never },
  })
  return { wrapper, agentConsole }
}

describe('AgentsSettingsPane', () => {
  it('says so when there are no agents yet', () => {
    const { wrapper } = mountPane([])
    expect(wrapper.find('[data-testid="agents-empty"]').exists()).toBe(true)
  })

  it('lists every identity and selects the focused one', () => {
    const { wrapper } = mountPane(undefined, 'b')
    expect(wrapper.findAll('[data-testid="agents-item"]')).toHaveLength(2)
    expect((wrapper.find('[data-testid="agents-name"]').element as HTMLInputElement).value).toBe('Researcher')
  })

  it('shows empty states for channel, schedules and memory', () => {
    const { wrapper } = mountPane()
    expect(wrapper.find('[data-testid="agents-channel-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agents-jobs-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agents-memory-empty"]').exists()).toBe(true)
  })

  it('renames on Enter and opens or stops the selected identity', async () => {
    const { wrapper } = mountPane()
    const input = wrapper.find('[data-testid="agents-name"]')
    await input.setValue('Assistant')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('rename')?.[0]).toEqual(['a', 'Assistant'])
    await wrapper.find('[data-testid="agents-open"]').trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual(['a'])
    await wrapper.find('[data-testid="agents-stop"]').trigger('click')
    expect(wrapper.emitted('stop')?.[0]).toEqual(['a'])
  })

  it('changes the colour through the agent console', async () => {
    const { wrapper, agentConsole } = mountPane()
    await wrapper.findAll('.ag-swatch')[0].trigger('click')
    expect(agentConsole.patch).toHaveBeenCalledWith('a', { color: 'violet' })
  })
})
