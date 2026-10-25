// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ExtensionsPane from '../ExtensionsPane.vue'

// The risk level comes from the disclosure; its derivation has its own tests,
// so here it is fixed per package.
vi.mock('../../lib/disclosureText', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/disclosureText')>()),
  disclosureClauses: (_t: unknown, _locale: unknown, disclosure: { id: string }) => [`declares for ${disclosure.id}`],
}))
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
    // The card says why, in the disclosure's own clauses.
    expect(wrapper.get('[data-id="acme.tracker"] .ext-risk-reason').text()).toBe('declares for acme.tracker')
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

// One case per warning the "⚠ N" marker counts: each mounts a package whose
// card carries only that warning, so dropping any one from the count is red.
describe('ExtensionsPane list row warnings', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  const DAY = 86_400_000
  const t = (key: string, params: Record<string, unknown> = {}) => i18n.global.t(key, params)
  const base = { requires: [], sensitive: [], packageVersion: '1.0.0' }

  interface Case {
    name: string
    installed?: Array<Record<string, unknown>>
    factory?: Array<Record<string, unknown>>
    api?: Record<string, unknown>
    row: string
    label: () => string
  }
  const soon = new Date(Date.now() + 3 * DAY).toISOString()
  const past = new Date(Date.now() - DAY).toISOString()
  const cases: Case[] = [
    { name: 'a blocked file', installed: [{ ...base, id: 'w.digest', digestBlock: { reason: 'security' } }], row: 'w.digest', label: () => t('settings.extensions.digestBlock.security') },
    { name: 'a sensitive capability', installed: [{ ...base, id: 'w.sens', requires: ['shell.run'], sensitive: ['shell.run'] }], row: 'w.sens', label: () => t('settings.extensionsPolicy.labeledValue', { label: t('settings.extensions.sensitive'), value: 'shell.run' }) },
    {
      name: 'an update that asks for more permissions',
      installed: [{ ...base, id: 'w.more', provenance: 'official-registry' }],
      api: { checkUpdates: vi.fn().mockResolvedValue([{ id: 'w.more', namespace: 'w', name: 'more', installedVersion: '1.0.0', latestVersion: '1.1.0', permissionChange: 'more' }]) },
      row: 'w.more',
      label: () => t('pluginDisclosure.diff.badgeMore'),
    },
    { name: 'an incompatible version', installed: [{ ...base, id: 'w.incompat', engineCompatible: false, minNavideVersion: '9.0.0' }], row: 'w.incompat', label: () => t('settings.extensions.incompatibleInstalled', { version: '9.0.0' }) },
    { name: 'an expired Testplace build kept in use', installed: [{ ...base, id: 'w.kept', source: 'testplace', expiresAt: past }], row: 'w.kept', label: () => t('testplace.expired.kept') },
    { name: 'a Testplace build about to expire', installed: [{ ...base, id: 'w.soon', source: 'testplace', expiresAt: soon }], row: 'w.soon', label: () => t('testplace.expiring', { days: 3, date: soon.slice(0, 10) }) },
    { name: 'an unsigned local file', installed: [{ ...base, id: 'w.local', source: 'local-unsigned' }], row: 'w.local', label: () => t('pluginDisclosure.source.local-unsigned') },
    { name: "the Host's warning", installed: [{ ...base, id: 'w.host', warning: 'The Host could not verify this package' }], row: 'w.host', label: () => 'The Host could not verify this package' },
    {
      name: 'a developer folder loaded by an unknown party',
      installed: [{ ...base, id: 'w.folder', provenance: 'developer-local-unpacked' }],
      api: { developerMode: vi.fn().mockResolvedValue({ enabled: true, folders: [{ pluginId: 'w.folder', path: '/dev/w', consentedAt: past, loaded: true, loadedBy: { kind: 'unknown' } }] }) },
      row: 'w.folder',
      label: () => t('settings.extensions.developerMode.loadedByUnknown'),
    },
    ...(['changed', 'key-changed', 'no-key'] as const).map((unverified): Case => ({
      name: `a developer folder whose loader record is unverified (${unverified})`,
      installed: [{ ...base, id: `w.unverified-${unverified}`, provenance: 'developer-local-unpacked' }],
      api: { developerMode: vi.fn().mockResolvedValue({ enabled: true, folders: [{ pluginId: `w.unverified-${unverified}`, path: '/dev/w', consentedAt: past, loaded: true, loadedBy: { kind: 'user' }, loadedByUnverified: unverified }] }) },
      row: `w.unverified-${unverified}`,
      label: () => t(unverified === 'key-changed' ? 'settings.extensions.developerMode.loadedByKeyChanged' : 'settings.extensions.developerMode.loadedByUnverified'),
    })),
    {
      name: 'a developer folder whose loader record is not signed',
      installed: [{ ...base, id: 'w.unsigned-loader', provenance: 'developer-local-unpacked' }],
      api: { developerMode: vi.fn().mockResolvedValue({ enabled: true, folders: [{ pluginId: 'w.unsigned-loader', path: '/dev/w', consentedAt: past, loaded: true, loadedBy: { kind: 'user' }, loadedByUnsigned: true }] }) },
      row: 'w.unsigned-loader',
      label: () => `${t('settings.extensions.developerMode.loadedByUser')} ${t('settings.extensions.developerMode.loadedByUnsigned')}`,
    },
    {
      name: 'a developer folder whose reload failed',
      installed: [{ ...base, id: 'w.reload', provenance: 'developer-local-unpacked' }],
      api: { developerMode: vi.fn().mockResolvedValue({ enabled: true, folders: [{ pluginId: 'w.reload', path: '/dev/w', consentedAt: past, loaded: true, loadedBy: { kind: 'user' }, reloadError: 'manifest is not valid JSON' }] }) },
      row: 'w.reload',
      label: () => t('settings.extensions.developerMode.reloadFailed', { error: 'manifest is not valid JSON' }),
    },
    {
      name: "a bundled package's sensitive capability",
      installed: [{ ...base, id: 'navide.mini-ide', requires: ['terminal'], sensitive: ['terminal'], provenance: 'factory-bundled' }],
      factory: [{ id: 'navide.mini-ide', version: '1.0.0', active: true, optedOut: false }],
      row: 'navide.mini-ide',
      label: () => t('settings.extensionsPolicy.labeledValue', { label: t('settings.extensions.sensitive'), value: 'terminal' }),
    },
    { name: "bundled Plans' risk note", factory: [{ id: 'navide.plans', version: '1.0.0', active: true, optedOut: false }], row: 'navide.plans', label: () => t('settings.extensions.plansRiskNote') },
  ]

  it.each(cases)('counts $name', async ({ installed = [], factory = [], api = {}, row, label }) => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: {
        listInstalled: vi.fn().mockResolvedValue(installed),
        listFactoryPackages: vi.fn().mockResolvedValue(factory),
        checkUpdates: vi.fn().mockResolvedValue([]),
        listPacks: vi.fn().mockResolvedValue([]),
        disabledStoreStatus: vi.fn().mockResolvedValue({ status: 'ok' }),
        ...api,
      },
    }
    wrapper = mount(ExtensionsPane, { global: { plugins: [i18n] } })
    await flushPromises()

    const warn = wrapper.get(`[data-select-id="${row}"] .ext-md-warn`)
    expect(warn.text()).toBe('⚠ 1')
    expect(warn.attributes('aria-label')).toBe(label())
  })

  it('does not count a developer folder you loaded yourself', async () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: {
        listInstalled: vi.fn().mockResolvedValue([{ ...base, id: 'w.mine', provenance: 'developer-local-unpacked', source: 'developer-unpacked' }]),
        listFactoryPackages: vi.fn().mockResolvedValue([]),
        checkUpdates: vi.fn().mockResolvedValue([]),
        listPacks: vi.fn().mockResolvedValue([]),
        disabledStoreStatus: vi.fn().mockResolvedValue({ status: 'ok' }),
        developerMode: vi.fn().mockResolvedValue({ enabled: true, folders: [{ pluginId: 'w.mine', path: '/dev/w', consentedAt: past, loaded: true, loadedBy: { kind: 'user' } }] }),
      },
    }
    wrapper = mount(ExtensionsPane, { global: { plugins: [i18n] } })
    await flushPromises()

    const row = wrapper.get('[data-select-id="w.mine"]')
    expect(row.find('.ext-md-warn').exists()).toBe(false)
    // Its source still shows, as a folder mark named in the card's words.
    expect(row.get('.ext-md-source').attributes('data-source-kind')).toBe('folder')
    expect(row.get('.ext-md-source').attributes('aria-label')).toBe(t('pluginDisclosure.source.developer-unpacked'))
  })

  it('marks a non-Marketplace source and leaves a Marketplace one unmarked', async () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: {
        listInstalled: vi.fn().mockResolvedValue([
          { ...base, id: 's.test', source: 'testplace' },
          { ...base, id: 's.market', source: 'marketplace' },
        ]),
        listFactoryPackages: vi.fn().mockResolvedValue([]),
        checkUpdates: vi.fn().mockResolvedValue([]),
        listPacks: vi.fn().mockResolvedValue([]),
        disabledStoreStatus: vi.fn().mockResolvedValue({ status: 'ok' }),
      },
    }
    wrapper = mount(ExtensionsPane, { global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.get('[data-select-id="s.test"] .ext-md-source').attributes('data-source-kind')).toBe('test')
    expect(wrapper.find('[data-select-id="s.market"] .ext-md-source').exists()).toBe(false)
  })

  it('marks a developer folder an agent loaded, naming who in the label, without counting it as a warning', async () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: {
        listInstalled: vi.fn().mockResolvedValue([{ ...base, id: 'w.agent', provenance: 'developer-local-unpacked', source: 'developer-unpacked' }]),
        listFactoryPackages: vi.fn().mockResolvedValue([]),
        checkUpdates: vi.fn().mockResolvedValue([]),
        listPacks: vi.fn().mockResolvedValue([]),
        disabledStoreStatus: vi.fn().mockResolvedValue({ status: 'ok' }),
        developerMode: vi.fn().mockResolvedValue({
          enabled: true,
          folders: [{ pluginId: 'w.agent', path: '/dev/w', consentedAt: past, loaded: true, loadedBy: { kind: 'agent', callerKind: 'pane', paneName: 'Claude', approvedAt: past } }],
        }),
      },
    }
    wrapper = mount(ExtensionsPane, { global: { plugins: [i18n] } })
    await flushPromises()

    const row = wrapper.get('[data-select-id="w.agent"]')
    const mark = row.get('.ext-md-source')
    expect(mark.attributes('data-loaded-by-agent')).toBe('true')
    expect(mark.attributes('aria-label')).toContain(t('pluginDisclosure.source.developer-unpacked'))
    expect(mark.attributes('aria-label')).toContain('Claude')
    expect(row.find('.ext-md-warn').exists()).toBe(false)
  })
})
