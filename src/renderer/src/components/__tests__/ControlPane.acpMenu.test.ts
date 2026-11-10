// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ControlPane from '../ControlPane.vue'
import { setAcpEnabled, useAcpPrefs } from '../../composables/useAcpPrefs'

// Settings → CLI Agents → ACP (experimental). Off (the default) the ＋ menu is
// exactly what it was; on, its Agents block gains "Claude Code (ACP)", which
// asks App.vue for an ACP pane (spawn-acp) — or the adapter's guided install
// while it is missing — and never emits a terminal spawn.

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

function mountWith(missing: string[] = []): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    attachTo: document.body,
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      backend: {
        send: vi.fn().mockResolvedValue({
          payload: { deps: missing.map((id) => ({ id, group: 'agent_cli', status: 'missing' })) },
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

function menuRows(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.ws-add-scroll > *').map((el) =>
    el.classes().includes('ws-add-sec') ? `# ${el.text()}` : `${el.attributes('data-section')}: ${el.text()}`,
  )
}

describe('ControlPane – the ＋ menu ACP entry', () => {
  let wrapper: VueWrapper
  afterEach(() => {
    wrapper?.unmount()
    setAcpEnabled(false)
  })

  it('is off by default, and off the menu is the CLI block alone', async () => {
    expect(useAcpPrefs().acpEnabled.value).toBe(false)
    wrapper = mountWith()
    await openMenu(wrapper)
    expect(wrapper.find('[data-testid="add-menu-acp"]').exists()).toBe(false)
    expect(menuRows(wrapper)).toEqual(['# label.add-menu-cli', 'cli: ✓Claude Code', 'cli: Codex'])
  })

  it('on, the Agents block offers Claude Code over ACP and it asks for an ACP pane', async () => {
    setAcpEnabled(true)
    wrapper = mountWith()
    await openMenu(wrapper)
    const rows = menuRows(wrapper)
    expect(rows.slice(0, 3)).toEqual(['# label.add-menu-cli', 'cli: ✓Claude Code', 'cli: Codex'])
    expect(rows[3]).toBe('# label.add-menu-agents')
    expect(rows).toHaveLength(5)
    const acp = wrapper.find('[data-testid="add-menu-acp"]')
    expect(acp.text()).toContain('Claude Code')
    expect(acp.text()).toContain('ACP')
    await acp.trigger('click')
    await nextTick()
    expect(wrapper.emitted('spawn')).toBeUndefined()
    expect(wrapper.emitted('spawn-acp')?.[0]?.[0]).toMatchObject({
      agentKey: 'claude', stageId: '', workspacePath: '/Users/me/Desktop/Agent-Team',
    })
  })

  it('on, with the adapter missing, it offers the guided install instead', async () => {
    setAcpEnabled(true)
    wrapper = mountWith(['claude-acp'])
    await openMenu(wrapper)
    await vi.waitFor(() => expect(wrapper.find('[data-testid="add-menu-acp"]').text()).toContain('label.agent-not-installed'))
    await wrapper.find('[data-testid="add-menu-acp"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.emitted('install-cli')).toBeTruthy())
    expect(wrapper.emitted('install-cli')?.[0]?.[0]).toMatchObject({ agentKey: 'claude-acp' })
    expect(wrapper.emitted('spawn-acp')).toBeUndefined()
    expect(wrapper.emitted('spawn')).toBeUndefined()
  })
})
