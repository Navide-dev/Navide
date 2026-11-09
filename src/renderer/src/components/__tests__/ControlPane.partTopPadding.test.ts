// @vitest-environment happy-dom
//
// `.part-top-plugin` zeroes the shared `.part-top` padding. Only the packaged
// Plans panel wants that — its guest document owns the full inset. The class
// was once keyed on "not explorer", which silently stripped the 14px side
// padding from the Git tab and every generic plugin tab too.
//
// Computed styles are not observable here (the scoped CSS is never applied
// under jsdom/happy-dom), so these assert on the rendered class list instead.
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  on: vi.fn(() => () => {}),
} as unknown as Record<string, unknown>

const contribution = (overrides: Record<string, unknown> = {}) => ({
  pluginId: 'acme.files',
  packageVersion: '1.0.0',
  contributionKey: 'acme.files.left',
  title: 'Files',
  icon: null,
  kind: 'custom' as const,
  location: 'left' as const,
  manifestOrder: 0,
  ...overrides,
})

const gitContribution = contribution({
  pluginId: 'navide.git',
  contributionKey: 'navide.git.left',
  title: 'Source Control',
})
const plansContribution = contribution({
  pluginId: 'navide.plans',
  contributionKey: 'navide.plans.left',
  title: 'Plans',
})

function mountPane(overrides: Record<string, unknown> = {}): VueWrapper {
  return shallowMount(ControlPane, {
    props: { ...minimalProps, backend: fakeBackend, workspace: '/tmp/ws', ...overrides } as never,
    global: { mocks: { $t: (key: string) => key } },
  })
}

/** The class list of the shared split's top part, whatever tab is active. */
function partTopClasses(wrapper: VueWrapper): string[] {
  return wrapper.get('.pane-split .part-top').classes()
}

// `key` is a built-in tab's id (matched on data-tab) or a plugin tab's own
// title. Built-in titles are now composed from a locale key and this file stubs
// $t to echo keys, so matching their text would assert against the stub;
// plugin titles come from the contribution and are unaffected.
async function clickTab(wrapper: VueWrapper, key: string): Promise<void> {
  const button = wrapper
    .findAll('.sidebar-tabs .tab-btn, .sidebar-tabs .plugin-tab-btn')
    .find(
      (candidate) =>
        candidate.attributes('data-tab') === key ||
        candidate.attributes('title')?.includes(key),
    )
  expect(button, `no sidebar tab for ${key}`).toBeDefined()
  await button!.trigger('click')
  await wrapper.vm.$nextTick()
}

describe('ControlPane – shared split padding is scoped to the Plans panel', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    sessionStorage.clear()
  })

  it('keeps the Git tab on the padded shared `.part-top`', async () => {
    wrapper = mountPane({ pluginContributions: [gitContribution, plansContribution] })
    await clickTab(wrapper, 'Source Control')

    expect(partTopClasses(wrapper)).not.toContain('part-top-plugin')
  })

  it('keeps a generic plugin tab on the padded shared `.part-top`', async () => {
    wrapper = mountPane({ pluginContributions: [contribution(), plansContribution] })
    await clickTab(wrapper, 'Files')

    expect(partTopClasses(wrapper)).not.toContain('part-top-plugin')
  })

  it('drops the padding for the packaged Plans panel', async () => {
    wrapper = mountPane({ pluginContributions: [gitContribution, plansContribution] })
    await clickTab(wrapper, 'plans')

    expect(partTopClasses(wrapper)).toContain('part-top-plugin')
  })

  it('restores the padding for the legacy Plans recovery pane', async () => {
    wrapper = mountPane({
      pluginContributions: [gitContribution, plansContribution],
      legacyPlansRecovery: true,
    })
    await clickTab(wrapper, 'plans')

    expect(partTopClasses(wrapper)).not.toContain('part-top-plugin')
  })

  it('does not let Git recovery decide the Plans panel padding', async () => {
    // The old condition suppressed the class for every tab whenever Git was in
    // recovery, so the Plans panel's insets moved with an unrelated feature.
    wrapper = mountPane({
      pluginContributions: [gitContribution, plansContribution],
      gitActivationFailure: 'activation timed out',
    })
    await clickTab(wrapper, 'plans')

    expect(partTopClasses(wrapper)).toContain('part-top-plugin')
  })

  it('leaves the Explorer tab padded', async () => {
    wrapper = mountPane({ pluginContributions: [gitContribution, plansContribution] })
    await clickTab(wrapper, 'explorer')

    expect(partTopClasses(wrapper)).not.toContain('part-top-plugin')
  })
})
