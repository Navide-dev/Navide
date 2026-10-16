// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginTrustDialog from '../PluginTrustDialog.vue'
import NativeBackendPanel from '../NativeBackendPanel.vue'

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
    method: 'devmap.setStatus',
    risk: 'write' as const,
    title: 'Set block status',
    description: LONG_DESCRIPTION,
    timeoutMs: 5000,
    inputSchema: { type: 'object' },
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
    expect(rows[0].text()).toContain('Read-only')
    expect(rows[0].text()).toContain('Times out after 30 s')
    expect(rows[1].text()).toContain('Changes data')
    expect(rows[1].text()).toContain('Times out after 5 s')
    // The whole description, never truncated.
    expect(rows[1].get('.agent-tool-description').text()).toBe(LONG_DESCRIPTION.trim())
    expect(wrapper.text()).toContain('Tools agents can call')
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
          { name: 'devmap_read', title: 'Read dev map', description: 'Read it.', risk: 'read', timeoutMs: 30000, collidesWith: 'zeta.devmap' },
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
      'Not available to agents: zeta.devmap, installed earlier, already uses this name.'
    )
    expect(wrapper.get('[data-native-backend-id="acme.plain"]').find('.agent-tools').exists()).toBe(false)
  })
})
