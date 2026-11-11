// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ControlPane from '../ControlPane.vue'
import { setArenaEnabled, useArenaPrefs } from '../../composables/useArenaPrefs'

// Settings → General → Experimental features → Model arena. Off (the default)
// the ＋ menu has no Compare block; on, it offers "Model arena…", which asks
// App.vue to open the start dialog for the menu's workspace, and — once the
// workspace has runs — a second entry that reopens the run view.

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

function mountWith(arenaRuns = 0): VueWrapper {
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
      arenaRuns,
    } as never,
    global: { mocks: { $t: (key: string, args?: Record<string, unknown>) => (args?.label ? `${key}:${args.label}` : key) } },
  })
}

async function openMenu(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.ws-add').trigger('click')
}

describe('ControlPane – the ＋ menu Compare block (model arena)', () => {
  let wrapper: VueWrapper
  afterEach(() => {
    wrapper?.unmount()
    setArenaEnabled(false)
  })

  it('is off by default, and off the menu has no Compare block', async () => {
    expect(useArenaPrefs().arenaEnabled.value).toBe(false)
    wrapper = mountWith(2)
    await openMenu(wrapper)
    expect(wrapper.find('[data-section="compare"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="add-menu-arena"]').exists()).toBe(false)
  })

  it('on, it sits below the CLI list and above the terminal, and opens the start dialog', async () => {
    setArenaEnabled(true)
    wrapper = mountWith()
    await openMenu(wrapper)
    const menu = wrapper.find('.ws-add-menu')
    const order = menu.findAll('.ws-add-scroll, [data-section="compare"], .ws-add-term').map((el) =>
      el.classes().includes('ws-add-scroll') ? 'list' : el.classes().includes('ws-add-term') ? 'terminal' : 'compare')
    expect(order).toEqual(['list', 'compare', 'terminal'])
    expect(wrapper.find('[data-testid="add-menu-arena-runs"]').exists()).toBe(false)
    await wrapper.find('[data-testid="add-menu-arena"]').trigger('click')
    await nextTick()
    expect(wrapper.emitted('arena-start')?.[0]).toEqual(['/Users/me/Desktop/Agent-Team'])
    expect(wrapper.emitted('spawn')).toBeUndefined()
  })

  it('offers the run view once the workspace has runs', async () => {
    setArenaEnabled(true)
    wrapper = mountWith(2)
    await openMenu(wrapper)
    await wrapper.find('[data-testid="add-menu-arena-runs"]').trigger('click')
    expect(wrapper.emitted('arena-panel')?.[0]).toEqual(['/Users/me/Desktop/Agent-Team'])
  })
})
