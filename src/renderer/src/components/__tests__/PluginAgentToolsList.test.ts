// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginTrustDialog from '../PluginTrustDialog.vue'
import NativeBackendPanel from '../NativeBackendPanel.vue'
import PluginAgentToolsList from '../PluginAgentToolsList.vue'

// B1-a: the consent surfaces list every declared agent tool with its name, its
// full description, read-only or changes data, and its timeout; the
// Extensions row says why a colliding tool stays offline.

const LONG_DESCRIPTION = `Set one block's status (done|wip|plan) in this workspace's dev map. ${'More detail. '.repeat(40)}`

const TOOLS = [
  {
    name: 'devmap_read',
    method: 'devmap.read',
    risk: 'read' as const,
    title: 'Read dev map',
    description: "Read this workspace's dev map.",
    timeoutMs: 30000,
    inputSchema: { type: 'object' },
  },
  {
    name: 'devmap_set_status',
    method: 'devmap.status',
    risk: 'write' as const,
    title: 'Set block status',
    description: LONG_DESCRIPTION,
    timeoutMs: 5000,
    inputSchema: { type: 'object', required: ['block_id'], properties: { block_id: { type: 'string', description: 'The block.' } } },
  },
]

function prepared(overrides: Record<string, unknown> = {}) {
  return {
    id: 'nerdtechnic.devmap',
    version: '0.2.0',
    trustTier: 'signed-verified' as const,
    sensitive: ['fs'],
    containsBackendExecutable: true,
    requiresConfirmation: true,
    publisherId: 'nerdtechnic',
    requiresPublisherTrust: false,
    requiresRiskConfirmation: true,
    ...overrides,
  }
}

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  delete (window as { agentTeam?: unknown }).agentTeam
})

describe('install trust dialog', () => {
  it('lists each declared tool in full on the permissions step', () => {
    wrapper = mount(PluginTrustDialog, {
      props: { pending: { label: 'nerdtechnic.devmap', prepared: prepared({ agentTools: TOOLS }) }, step: 'risk' },
      global: { plugins: [i18n] },
      attachTo: document.body,
    })
    const rows = wrapper.findAll('[data-agent-tool]')
    expect(rows.map((row) => row.attributes('data-agent-tool'))).toEqual(['devmap_read', 'devmap_set_status'])
    expect(rows[0].text()).toContain('Declared read-only')
    expect(rows[0].text()).toContain('Calls devmap.read')
    expect(rows[0].text()).toContain('Times out after 30 s')
    expect(rows[1].text()).toContain('Declared as changing data')
    expect(rows[1].text()).toContain('Times out after 5 s')
    // The whole description, never truncated.
    expect(rows[1].get('.agent-tool-description').text()).toBe(LONG_DESCRIPTION.trim())
    expect(wrapper.text()).toContain('Tools agents can call (2)')
    expect(wrapper.get('.agent-tools-total').text()).toMatch(/^2 tools; their text and input schemas total [\d.]+ KB\.$/)
    // The whole input schema the agent will read, collapsed but present.
    const schema = rows[1].get('details.agent-tool-schema')
    expect(schema.get('summary').text()).toContain('Input schema')
    expect(JSON.parse(schema.get('pre').text())).toEqual(TOOLS[1].inputSchema)
    expect(wrapper.text()).toContain('may pass it on elsewhere')
  })

  it('shows no tool list for a package that declares none, or on the publisher step', () => {
    wrapper = mount(PluginTrustDialog, {
      props: { pending: { label: 'acme.demo', prepared: prepared() }, step: 'risk' },
      global: { plugins: [i18n] },
      attachTo: document.body,
    })
    expect(wrapper.find('.agent-tools').exists()).toBe(false)
    wrapper.unmount()
    wrapper = mount(PluginTrustDialog, {
      props: { pending: { label: 'nerdtechnic.devmap', prepared: prepared({ agentTools: TOOLS }) }, step: 'publisher' },
      global: { plugins: [i18n] },
      attachTo: document.body,
    })
    expect(wrapper.find('.agent-tools').exists()).toBe(false)
  })
})

describe('native backend rows', () => {
  it('lists the tools and names the earlier package that holds a colliding name', async () => {
    const row = (pluginId: string, agentTools?: unknown[]) => ({
      pluginId,
      packageVersion: '0.2.0',
      name: 'Dev Map',
      status: 'needs-consent',
      changedSinceConsent: false,
      canWriteWorkspace: true,
      workspaceWrite: [],
      ...(agentTools ? { agentTools } : {}),
    })
    const list = vi.fn().mockResolvedValue({
      enabled: true,
      plugins: [
        row('acme.devmap', [
          { name: 'devmap_read', title: 'Read dev map', description: 'Read it.', risk: 'read', timeoutMs: 30000, method: 'devmap.read', inputSchema: { type: 'object' }, collidesWith: 'zeta.devmap' },
        ]),
        row('zeta.devmap', [
          { name: 'devmap_read', title: 'Read dev map', description: 'Read it.', risk: 'read', timeoutMs: 30000, method: 'devmap.read', inputSchema: { type: 'object' }, sharedWith: ['acme.devmap'] },
        ]),
        row('acme.plain'),
      ],
    })
    ;(window as { agentTeam?: unknown }).agentTeam = {
      plugins: { nativeBackends: { list }, listInstalled: vi.fn().mockResolvedValue([]), listFactoryPackages: vi.fn().mockResolvedValue([]) },
    }
    wrapper = mount(NativeBackendPanel, { global: { plugins: [i18n] } })
    await flushPromises()
    const withTools = wrapper.get('[data-native-backend-id="acme.devmap"]')
    expect(withTools.get('[data-agent-tool="devmap_read"]').text()).toContain(
      'Not available to agents: zeta.devmap, allowed earlier, already uses this name.'
    )
    expect(wrapper.get('[data-native-backend-id="zeta.devmap"]').get('[data-agent-tool="devmap_read"]').text()).toContain(
      'acme.devmap also declares this name; that tool stays offline.'
    )
    expect(wrapper.get('[data-native-backend-id="acme.plain"]').find('.agent-tools').exists()).toBe(false)
  })
})

describe('agent tool schema display', () => {
  it('spells out invisible characters in schema keys and enum values instead of showing them raw', () => {
    const tool = {
      ...TOOLS[0],
      inputSchema: { type: 'object', properties: { 'k\u202ex': { type: 'string', enum: ['a\u200bb', 'tag\u{e0041}'] } } },
    }
    wrapper = mount(PluginAgentToolsList, { props: { tools: [tool] }, global: { plugins: [i18n] } })
    const shown = wrapper.find('.agent-tool-schema-body').text()
    expect(shown).toContain('"k\\u{202e}x"')
    expect(shown).toContain('"a\\u{200b}b"')
    expect(shown).toContain('"tag\\u{e0041}"')
    expect(shown).not.toMatch(/[\u200b\u202e]|\u{e0041}/u)
  })
})
