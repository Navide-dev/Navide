// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentControlPanel from '../AgentControlPanel.vue'
import type { SchedulerJob } from '../../../lib/schedulerJobs'

// The control panel shows only what has a source: channel binding, schedules,
// the status and the memory files `agent.notes` found; a source that does not
// exist or was not measured gets an explicit empty state.

function job(id: string, enabled = true): SchedulerJob {
  return {
    id,
    name: `job ${id}`,
    enabled,
    schedule: { kind: 'daily', at: '08:30', tz: 'Asia/Taipei' },
    action: { kind: 'message', workspace: '/w', pane_id: 'p1' },
    state: { next_run_at: Date.parse('2026-11-11T00:30:00Z') },
  } as SchedulerJob
}

function fakeConsole(jobs: SchedulerJob[], notes: unknown = null) {
  return {
    notesFor: () => notes,
    refreshNotes: vi.fn(async () => {}),
    jobsFor: () => jobs,
    nextJob: () => jobs.find((j) => j.enabled) ?? null,
    wakeNow: vi.fn(),
    setSchedulesPaused: vi.fn(),
    identityForPane: () => ({ id: 'id-1' }),
    openSettings: vi.fn(),
  }
}

function fakeChannels(bound: boolean) {
  return {
    bindingFor: () => (bound ? { pane_id: 'p1', platform: 'telegram', account: 'default', chat_id: '1', thread_id: '', title: 'x' } : null),
    accountState: () => null,
  }
}

function mountPanel(jobs: SchedulerJob[] = [], bound = false, collapsed = false, notes: unknown = null) {
  const console = fakeConsole(jobs, notes)
  const wrapper = mount(AgentControlPanel, {
    props: { paneId: 'p1', paneName: 'Secretary', agentKey: 'hermes', displayStatus: 'awaiting', collapsed, console: console as never, channels: fakeChannels(bound) as never },
  })
  return { wrapper, console }
}

describe('AgentControlPanel', () => {
  it('shows explicit empty states when nothing is bound or scheduled', () => {
    const { wrapper } = mountPanel()
    expect(wrapper.find('[data-testid="agent-panel-channel-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-panel-jobs-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-panel-memory-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-panel-wake"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="agent-panel-pause"]').attributes('disabled')).toBeDefined()
  })

  it('lists the jobs that target the pane and wakes with the next one', async () => {
    const { wrapper, console } = mountPanel([job('a'), job('b', false)])
    expect(wrapper.findAll('[data-testid="agent-panel-job"]')).toHaveLength(2)
    await wrapper.find('[data-testid="agent-panel-wake"]').trigger('click')
    expect(console.wakeNow).toHaveBeenCalledWith('p1', 'Secretary')
    await wrapper.find('[data-testid="agent-panel-pause"]').trigger('click')
    expect(console.setSchedulesPaused).toHaveBeenCalledWith('p1', 'Secretary', true)
  })

  it('names the bound channel', () => {
    const { wrapper } = mountPanel([], true)
    expect(wrapper.find('[data-testid="agent-panel-channel"]').exists()).toBe(true)
  })

  it('opens the identity in Settings → Agents', async () => {
    const { wrapper, console } = mountPanel()
    await wrapper.find('[data-testid="agent-panel-settings"]').trigger('click')
    expect(console.openSettings).toHaveBeenCalledWith('id-1')
  })

  it('folds to a strip that only offers the toggle', async () => {
    const { wrapper } = mountPanel([], false, true)
    expect(wrapper.find('[data-testid="agent-panel-wake"]').exists()).toBe(false)
    await wrapper.find('[data-testid="agent-panel-toggle"]').trigger('click')
    expect(wrapper.emitted('toggle')).toHaveLength(1)
  })

  it('reads the vendor notes when it opens, and not while folded', () => {
    expect(mountPanel().console.refreshNotes).toHaveBeenCalledWith('hermes')
    expect(mountPanel([], false, true).console.refreshNotes).not.toHaveBeenCalled()
  })

  it('lists memory files with their source folder and opens that folder', async () => {
    const reveal = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { revealPath: reveal }
    const notes = {
      memory: {
        status: 'ok',
        root: '/fake/hermes/memories',
        entries: [
          { name: 'USER.md', path: '/fake/hermes/memories/USER.md', modified_at: 2, preview: 'Lives in Taipei.' },
          { name: 'MEMORY.md', path: '/fake/hermes/memories/MEMORY.md', modified_at: 1, preview: 'Prefers short replies.' },
        ],
      },
      todos: { status: 'unsupported', root: '', entries: [] },
    }
    const { wrapper } = mountPanel([], false, false, notes)
    const rows = wrapper.findAll('[data-testid="agent-panel-memory-entry"]')
    expect(rows.map((r) => r.find('.ap-note-name').text())).toEqual(['USER.md', 'MEMORY.md'])
    expect(rows[0].text()).toContain('Lives in Taipei.')
    expect(wrapper.find('[data-testid="agent-panel-memory-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-panel-memory-source"]').text()).toContain('/fake/hermes/memories')
    expect(wrapper.find('[data-testid="agent-panel-todos-empty"]').exists()).toBe(true)
    await wrapper.find('[data-testid="agent-panel-memory-open"]').trigger('click')
    expect(reveal).toHaveBeenCalledWith('/fake/hermes/memories')
  })

  it('says the folder is missing instead of offering to open it', () => {
    const notes = {
      memory: { status: 'missing', root: '/fake/hermes/memories', entries: [] },
      todos: { status: 'unsupported', root: '', entries: [] },
    }
    const { wrapper } = mountPanel([], false, false, notes)
    expect(wrapper.find('[data-testid="agent-panel-memory-empty"]').text()).toBe('Memory folder not found')
    expect(wrapper.find('[data-testid="agent-panel-memory-open"]').exists()).toBe(false)
  })

  it('shows an empty memory folder as nothing saved yet', () => {
    const notes = {
      memory: { status: 'empty', root: '/fake/ws', entries: [] },
      todos: { status: 'unsupported', root: '', entries: [] },
    }
    const { wrapper } = mountPanel([], false, false, notes)
    expect(wrapper.find('[data-testid="agent-panel-memory-empty"]').text()).toBe('No memory saved yet')
    expect(wrapper.find('[data-testid="agent-panel-memory-open"]').exists()).toBe(true)
  })
})
