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

function mountPane(
  agents = [row('a', 'Secretary', true), row('b', 'Researcher', false, 'openclaw')],
  focusId?: string,
  named: unknown[] = [],
  bound = false,
) {
  const agentConsole = {
    jobsFor: () => [],
    patch: vi.fn(),
    notesFor: () => null,
    refreshNotes: vi.fn(async () => {}),
    jobsNamed: vi.fn(() => named),
    retargetJobs: vi.fn(async () => [] as string[]),
  }
  const channels = {
    bindingFor: () => (bound ? { pane_id: 'pane-a', platform: 'telegram', account: 'default', chat_id: '1', thread_id: '', title: 'x' } : null),
    childrenOf: () => [],
    accountState: () => null,
  }
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
    expect(wrapper.emitted('rename')).toBeUndefined()
    await wrapper.find('[data-testid="agents-rename-ok"]').trigger('click')
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

  it('lists the schedules and channel bindings a rename affects, and updates the schedules', async () => {
    const jobs = [
      { id: 'j1', name: 'Morning brief', action: { kind: 'message', workspace: '/w', pane_name: 'Secretary', text: 'hi' } },
      { id: 'j2', name: 'Evening wrap', action: { kind: 'message', workspace: '/w', pane_name: 'Secretary', text: 'bye' } },
    ]
    const { wrapper, agentConsole } = mountPane(undefined, undefined, jobs, true)
    const input = wrapper.find('[data-testid="agents-name"]')
    await input.setValue('Assistant')
    await input.trigger('keydown', { key: 'Enter' })
    expect(agentConsole.jobsNamed).toHaveBeenCalledWith('Secretary')
    expect(wrapper.findAll('[data-testid="agents-rename-job"]').map((j) => j.text())).toEqual(['Morning brief', 'Evening wrap'])
    expect(wrapper.find('[data-testid="agents-rename-channels"]').text()).toContain('1')
    expect((wrapper.find('[data-testid="agents-rename-retarget"]').element as HTMLInputElement).checked).toBe(true)
    await wrapper.find('[data-testid="agents-rename-ok"]').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('rename')?.[0]).toEqual(['a', 'Assistant'])
    expect(agentConsole.retargetJobs).toHaveBeenCalledWith(jobs, 'Assistant')
  })

  it('renames without touching the schedules when the box is cleared', async () => {
    const jobs = [{ id: 'j1', name: 'Morning brief', action: { kind: 'message', workspace: '/w', pane_name: 'Secretary', text: 'hi' } }]
    const { wrapper, agentConsole } = mountPane(undefined, undefined, jobs)
    const input = wrapper.find('[data-testid="agents-name"]')
    await input.setValue('Assistant')
    await input.trigger('keydown', { key: 'Enter' })
    await wrapper.find('[data-testid="agents-rename-retarget"]').setValue(false)
    await wrapper.find('[data-testid="agents-rename-ok"]').trigger('click')
    expect(wrapper.emitted('rename')?.[0]).toEqual(['a', 'Assistant'])
    expect(agentConsole.retargetJobs).not.toHaveBeenCalled()
  })

  it('cancelling keeps the old name and changes nothing', async () => {
    const { wrapper, agentConsole } = mountPane()
    const input = wrapper.find('[data-testid="agents-name"]')
    await input.setValue('Assistant')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.find('[data-testid="agents-rename-no-jobs"]').exists()).toBe(true)
    await wrapper.find('[data-testid="agents-rename-cancel"]').trigger('click')
    expect(wrapper.find('[data-testid="agents-rename-confirm"]').exists()).toBe(false)
    expect((input.element as HTMLInputElement).value).toBe('Secretary')
    expect(wrapper.emitted('rename')).toBeUndefined()
    expect(agentConsole.retargetJobs).not.toHaveBeenCalled()
  })
})
