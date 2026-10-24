// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ExtensionsPane from '../ExtensionsPane.vue'

// The risk level comes from the disclosure; its derivation has its own tests,
// so here it is fixed per package.
vi.mock('../../../../shared/pluginDisclosureScan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/pluginDisclosureScan')>()),
  cardRiskLevel: (disclosure: { id: string }) => (disclosure.id === 'acme.tracker' ? 'high' : 'low'),
}))

function mockPlugins() {
  const api = {
    listInstalled: vi.fn().mockResolvedValue([
      { id: 'acme.tracker', requires: ['fs'], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      { id: 'kaito.lint', requires: ['fs'], sensitive: [], packageVersion: '0.3.0' },
    ]),
    listFactoryPackages: vi.fn().mockResolvedValue([{ id: 'navide.git', version: '2.0.0', active: true, optedOut: false }]),
    checkUpdates: vi.fn().mockResolvedValue([]),
    listPacks: vi.fn().mockResolvedValue([]),
    disabledStoreStatus: vi.fn().mockResolvedValue({ status: 'ok' }),
    installedDisclosures: vi.fn().mockResolvedValue([
      { id: 'acme.tracker', version: '1.0.0', disclosure: { id: 'acme.tracker' }, scan: null },
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
})
