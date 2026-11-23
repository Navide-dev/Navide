// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ControlPane from '../ControlPane.vue'
import { setRemoteDevcontainerEnabled } from '../../composables/useRemoteDevcontainerPrefs'

// Settings → General → Experimental features → Remote container panes. Off
// (the default) the ＋ menu has no remote entry; on, it offers "Remote
// container…" with the Beta tag, which asks App.vue to open the setup dialog
// for the menu's workspace and never spawns a pane itself.

const specs = [
  { agentKey: 'claude', label: 'Claude Code' },
  { agentKey: 'codex', label: 'Codex' },
  { agentKey: 'terminal', label: 'Terminal' },
]

const workspaceRow = {
  path: '/Users/me/Desktop/Agent-Team',
  label: 'Agent-Team',
  displayPath: '~/Desktop/Agent-Team',
  isCurrent: true,
  collapsed: false,
  count: 1, paneIds: [],
  lineage: [],
  groups: [{ id: '', name: '', rows: [] }],
  remote: [],
}

function mountWith(): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    attachTo: document.body,
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      backend: {
        send: vi.fn().mockResolvedValue({
          payload: { deps: [] },
        }),
      },
      agentSpecs: specs,
      roles: [],
      stages: [],
      panes: [{ id: 'p1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false }],
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false,
      workspace: '/Users/me/Desktop/Agent-Team',
      existingProject: null,
      workspaces: [workspaceRow],
    } as never,
    global: { mocks: { $t: (key: string, args?: Record<string, unknown>) => (args?.label ? `${key}:${args.label}` : key) } },
  })
}

async function openMenu(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.ws-add').trigger('click')
}

describe('ControlPane – the ＋ menu remote container entry', () => {
  let wrapper: VueWrapper
  afterEach(() => {
    wrapper?.unmount()
    setRemoteDevcontainerEnabled(false)
  })

  it('is absent while the switch is off', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    expect(wrapper.find('.ws-add-menu').exists()).toBe(true)
    expect(wrapper.find('[data-testid="add-menu-remote"]').exists()).toBe(false)
  })

  it('on, it shows with the Beta tag and asks App to open the dialog', async () => {
    setRemoteDevcontainerEnabled(true)
    wrapper = mountWith()
    await openMenu(wrapper)
    const entry = wrapper.find('[data-testid="add-menu-remote"]')
    expect(entry.exists()).toBe(true)
    expect(entry.text()).toContain('remoteDevcontainer.menu-entry')
    expect(entry.find('.ws-add-exp').text()).toBe('arena.experimental')
    await entry.trigger('click')
    await nextTick()
    expect(wrapper.emitted('spawn-remote')?.[0]).toEqual([{ workspacePath: '/Users/me/Desktop/Agent-Team', runGroupId: undefined }])
    expect(wrapper.emitted('spawn')).toBeUndefined()
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('offers SSH Remote… below Terminal only while the switch is on', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    expect(wrapper.find('[data-testid="add-menu-ssh-remote"]').exists()).toBe(false)
    wrapper.unmount()

    setRemoteDevcontainerEnabled(true)
    wrapper = mountWith()
    await openMenu(wrapper)
    const entry = wrapper.find('[data-testid="add-menu-ssh-remote"]')
    expect(entry.exists()).toBe(true)
    expect(entry.text()).toContain('sshRemote.menu-entry')
    expect(entry.find('.ws-add-exp').text()).toBe('arena.experimental')
    const opts = wrapper.findAll('.ws-add-opt').map((b) => b.classes())
    const term = opts.findIndex((c) => c.includes('ws-add-term'))
    expect(term).toBeGreaterThanOrEqual(0)
    expect(opts[term + 1]).toContain('ws-add-ssh')
    await entry.trigger('click')
    await nextTick()
    expect(wrapper.emitted('spawn-ssh-remote')).toHaveLength(1)
    expect(wrapper.emitted('spawn')).toBeUndefined()
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })
})
