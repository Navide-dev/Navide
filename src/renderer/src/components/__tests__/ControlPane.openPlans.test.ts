// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

const minimalProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
  autoAnswerEnabled: false,
  existingProject: null,
} as unknown as Record<string, unknown>

// Minimal backend so the Explorer/Git/Plans child panes (all `v-if="backend"`)
// can mount as stubs under shallowMount.
const fakeBackend = {
  status: { value: 'connected' },
  send: vi.fn(async () => ({ payload: {} })),
  on: vi.fn(() => () => {})
} as unknown as Record<string, unknown>

const plansContribution = {
  pluginId: 'navide.plans',
  packageVersion: '1.0.0',
  contributionKey: 'navide.plans.left',
  title: 'Plans',
  icon: null,
  kind: 'custom' as const,
  location: 'left' as const,
  manifestOrder: 0,
}

describe('ControlPane – Plans sidebar tab', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: { ...minimalProps, backend: fakeBackend, workspace: '/tmp/ws' },
      global: { mocks: { $t: (key: string) => key } }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
  })

  it('no longer renders the pop-out plans button in the Pipelines header', () => {
    expect(wrapper.find('.plans-btn').exists()).toBe(false)
  })

  it('renders the retained Plans tab in the sidebar icon rail', () => {
    const btns = wrapper.findAll('.sidebar-tabs .tab-btn')
    // agents, commanders, pipeline, explorer, factory-installed Git, retained Plans
    expect(btns).toHaveLength(6)
    // Select on the tab id, not the title: the title is composed from a
    // locale key and this file stubs $t to echo keys, so matching its text
    // would assert against the stub rather than against the product.
    expect(btns[5].attributes('data-tab')).toBe('plans')
  })

  it('mounts the packaged Plans left contribution on the canonical tab', async () => {
    await wrapper.setProps({ pluginContributions: [plansContribution] } as never)
    expect(wrapper.findComponent({ name: 'PlanPane' }).exists()).toBe(false)
    const plansButton = wrapper.find('.sidebar-tabs .tab-btn[data-tab="plans"]')
    expect(plansButton.exists()).toBe(true)
    await plansButton.trigger('click')
    await wrapper.vm.$nextTick()
    const planHost = wrapper.findAllComponents({ name: 'PluginRegionHost' })
      .find((host) => host.props('contribution').contributionKey === 'navide.plans.left')
    expect(planHost).toBeDefined()
    expect(planHost!.props('visible')).toBe(true)
  })

  it('keeps the legacy Plans pane as an explicit recovery adapter', async () => {
    await wrapper.setProps({
      pluginContributions: [plansContribution],
      legacyPlansRecovery: true,
    } as never)
    const plansButton = wrapper.find('.sidebar-tabs .tab-btn[data-tab="plans"]')
    await plansButton.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-plans-legacy-recovery-label]').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'PluginRegionHost' }).exists()).toBe(false)
  })

  it('invokes projectLegacyPlansPreferences with active workspace before prepare in PluginRegionHost', async () => {
    const projectSpy = vi.fn(async () => ({ ok: true }))
    window.agentTeam = {
      ...(window.agentTeam ?? {}),
      projectLegacyPlansPreferences: projectSpy,
    } as unknown as typeof window.agentTeam

    await wrapper.setProps({
      workspace: '/workspace/active-target',
      pluginContributions: [plansContribution],
      legacyPlansRecovery: false,
    } as never)

    const planHost = wrapper.findAllComponents({ name: 'PluginRegionHost' })
      .find((host) => host.props('contribution').contributionKey === 'navide.plans.left')
    expect(planHost).toBeDefined()
    const beforePrepare = planHost!.props('beforePrepare') as (() => Promise<void>) | undefined
    expect(beforePrepare).toBeDefined()

    await beforePrepare!()
    expect(projectSpy).toHaveBeenCalledWith(expect.objectContaining({
      workspace_path: '/workspace/active-target',
    }))
  })
})
