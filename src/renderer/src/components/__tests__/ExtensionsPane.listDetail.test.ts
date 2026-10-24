// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ExtensionsPane from '../ExtensionsPane.vue'

// The risk level comes from the disclosure; its derivation has its own tests,
// so here it is fixed per package.
vi.mock('../../../../shared/pluginDisclosureScan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/pluginDisclosureScan')>()),
  cardRiskLevel: (disclosure: { id: string }) => (disclosure.id === 'low.one' ? 'low' : 'high'),
}))

function mockPlugins(extraInstalled: Array<Record<string, unknown>> = []) {
  const api = {
    listInstalled: vi.fn().mockResolvedValue([
      { id: 'acme.tracker', requires: ['fs'], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      { id: 'kaito.lint', requires: ['fs'], sensitive: [], packageVersion: '0.3.0' },
      ...extraInstalled,
    ]),
    listFactoryPackages: vi.fn().mockResolvedValue([{ id: 'navide.git', version: '2.0.0', active: true, optedOut: false }]),
    checkUpdates: vi.fn().mockResolvedValue([]),
    listPacks: vi.fn().mockResolvedValue([]),
    disabledStoreStatus: vi.fn().mockResolvedValue({ status: 'ok' }),
    installedDisclosures: vi.fn().mockResolvedValue([
      { id: 'acme.tracker', version: '1.0.0', disclosure: { id: 'acme.tracker' }, scan: null },
      ...extraInstalled.filter((p) => p.provenance === 'official-registry').map((p) => ({ id: p.id, version: '1.0.0', disclosure: { id: p.id }, scan: null })),
    ]),
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: api }
  return api
}

const shown = (w: VueWrapper, selector: string): boolean =>
  (w.get(selector).element as HTMLElement).style.display !== 'none'

describe('ExtensionsPane list and detail', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('shows the first installed package and switches the card from the list', async () => {
    mockPlugins()
    wrapper = mount(ExtensionsPane, { global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.findAll('.ext-md-row').map((row) => row.attributes('data-select-id'))).toEqual([
      'navide.git',
      'acme.tracker',
      'kaito.lint',
    ])
    expect(shown(wrapper, '[data-id="acme.tracker"]')).toBe(true)
    expect(shown(wrapper, '[data-id="kaito.lint"]')).toBe(false)
    expect(shown(wrapper, '[data-factory-id="navide.git"]')).toBe(false)
    expect(wrapper.get('[data-select-id="acme.tracker"]').attributes('aria-current')).toBe('true')

    await wrapper.get('[data-select-id="navide.git"]').trigger('click')
    expect(shown(wrapper, '[data-factory-id="navide.git"]')).toBe(true)
    expect(shown(wrapper, '[data-id="acme.tracker"]')).toBe(false)
    expect(wrapper.get('[data-select-id="acme.tracker"]').attributes('aria-current')).toBeUndefined()
  })

  it('shows a Registry package risk level in its row and its card, and links to its overview entry', async () => {
    mockPlugins()
    wrapper = mount(ExtensionsPane, { global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.get('[data-select-id="acme.tracker"] .ext-md-risk').text()).toBe('High')
    expect(wrapper.get('[data-id="acme.tracker"] .ext-md-risk').text()).toBe('Risk level: High')
    // A package with no disclosure record has no risk badge and no overview link.
    expect(wrapper.find('[data-select-id="kaito.lint"] .ext-md-risk').exists()).toBe(false)
    expect(wrapper.find('[data-id="kaito.lint"] .ext-disclosure-link').exists()).toBe(false)

    await wrapper.get('[data-id="acme.tracker"] .ext-disclosure-link').trigger('click')
    expect(wrapper.emitted('openDisclosureOverview')).toEqual([['acme.tracker']])
  })

  it('shows Disabled and the risk level together on a row', async () => {
    mockPlugins([{ id: 'risky.off', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry', disabled: true }])
    wrapper = mount(ExtensionsPane, { global: { plugins: [i18n] } })
    await flushPromises()

    const row = wrapper.get('[data-select-id="risky.off"]')
    expect(row.find('.ext-disabled-badge').exists()).toBe(true)
    expect(row.get('.ext-md-risk').text()).toBe('High')
  })

  it("counts the warnings a row's card carries and names them for assistive tech", async () => {
    mockPlugins([{
      id: 'kaito.risky',
      requires: ['shell.run'],
      sensitive: ['shell.run'],
      packageVersion: '0.1.0',
      source: 'local-unsigned',
      engineCompatible: false,
      minNavideVersion: '9.9.9',
    }])
    wrapper = mount(ExtensionsPane, { global: { plugins: [i18n] } })
    await flushPromises()

    const warn = wrapper.get('[data-select-id="kaito.risky"] .ext-md-warn')
    expect(warn.text()).toBe('⚠ 3')
    expect(warn.attributes('role')).toBe('img')
    expect(warn.attributes('aria-label')!.split('\n')).toEqual([
      'sensitive: shell.run',
      'Needs Navide ≥ 9.9.9',
      'Local file, not reviewed by Navide, unsigned',
    ])
    // A row whose card carries none has no marker.
    expect(wrapper.find('[data-select-id="kaito.lint"] .ext-md-warn').exists()).toBe(false)
  })
})
