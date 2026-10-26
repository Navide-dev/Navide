// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginDisclosureDiff from '../PluginDisclosureDiff.vue'
import PluginTrustDialog from '../PluginTrustDialog.vue'
import { computeDisclosure, diffDisclosure } from '../../../../shared/pluginDisclosure'

const disclosure = (version: string, permissions: Record<string, unknown>) =>
  computeDisclosure({ schemaVersion: 2, id: 'acme.demo', version, publisher: 'acme', permissions } as never)

const widened = diffDisclosure(
  disclosure('1.0.0', { system: ['fs'], scopes: { fs: { root: 'workspace', read: ['README.md'] } } }),
  disclosure('1.0.1', { shell: 'allowlist' })
)

let saved: typeof i18n.global.locale.value
beforeEach(() => {
  saved = i18n.global.locale.value
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  i18n.global.locale.value = saved
})

describe('PluginDisclosureDiff (plan B D2)', () => {
  it('marks added items "New" and removed ones "Removed", and folds what did not change', () => {
    const wrapper = mount(PluginDisclosureDiff, { props: { diff: widened }, global: { plugins: [i18n] } })
    const added = wrapper.findAll('.nv-diff-added li').map((li) => li.text())
    expect(added).toContain('New Shell mode: allowlist')
    expect(added).toContain('New Can run: git')
    const removed = wrapper.findAll('.nv-diff-removed li').map((li) => li.text())
    expect(removed).toContain('Removed Permission: fs')
    // fs goes with its scope, so the scope item is a narrower declaration.
    expect(removed).toContain('Removed Declared scope (informational) Can read: README.md')
    expect(wrapper.text()).toContain('Risk level: Medium → High')
    // Facts, not warnings: no alert role anywhere in the diff.
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('says so when nothing was added or removed', () => {
    const same = diffDisclosure(disclosure('1.0.0', { shell: 'full' }), disclosure('1.0.1', { shell: 'full' }))
    const wrapper = mount(PluginDisclosureDiff, { props: { diff: same }, global: { plugins: [i18n] } })
    expect(wrapper.text()).toContain('No permission was added or removed')
    expect(wrapper.find('details.nv-diff-unchanged summary').text()).toContain('Unchanged (2)')
  })

  it('renders in zh-TW and ja-JP', () => {
    i18n.global.locale.value = 'zh-TW'
    expect(mount(PluginDisclosureDiff, { props: { diff: widened }, global: { plugins: [i18n] } }).text()).toContain('新增')
    i18n.global.locale.value = 'ja-JP'
    expect(mount(PluginDisclosureDiff, { props: { diff: widened }, global: { plugins: [i18n] } }).text()).toContain('追加')
  })
})

// A file scope is declared, never enforced (d14ed3055). Plans 0.2.9 → 0.2.31
// declared one for its unscoped fs, and every scope item read "New" as if
// the update asked for more access.
describe('PluginDisclosureDiff file scopes (0.2.31)', () => {
  const unscoped = disclosure('1.0.0', { system: ['fs'] })
  const docs = disclosure('1.1.0', { system: ['fs'], scopes: { fs: { root: 'repository', read: ['docs/*'], write: ['docs/*'] } } })
  const tags = (diff: ReturnType<typeof diffDisclosure>, list: 'added' | 'removed') =>
    mount(PluginDisclosureDiff, { props: { diff }, global: { plugins: [i18n] } })
      .findAll(`.nv-diff-${list} li`)
      .map((li) => li.text())

  it('lists a newly declared scope as new and informational, every item kept', () => {
    const diff = diffDisclosure(unscoped, docs)
    expect(diff.widened).toBe(false)
    expect(tags(diff, 'added')).toEqual([
      'New Declared scope (informational) Can read: docs/*',
      'New Declared scope (informational) File scope: repository',
      'New Declared scope (informational) Can write: docs/*',
    ])
  })

  it('keeps the plain "New" on a scope change that claims more', () => {
    const more = disclosure('1.2.0', { system: ['fs'], scopes: { fs: { root: 'repository', read: ['docs/*', 'src/**'], write: ['docs/*'] } } })
    const diff = diffDisclosure(docs, more)
    expect(diff.widened).toBe(true)
    expect(tags(diff, 'added')).toEqual(['New Can read: src/**'])
  })

  it('says plainly that Navide does not enforce a declared scope, only where one is tagged (#647 L1)', () => {
    const note = (diff: ReturnType<typeof diffDisclosure>) =>
      mount(PluginDisclosureDiff, { props: { diff }, global: { plugins: [i18n] } }).find('.nv-diff-scope-note')
    expect(note(diffDisclosure(unscoped, docs)).text()).toBe(i18n.global.t('pluginDisclosure.diff.declaredScopeNote'))
    expect(note(diffDisclosure(unscoped, docs)).text()).toContain('does not enforce')
    const more = disclosure('1.2.0', { system: ['fs'], scopes: { fs: { root: 'repository', read: ['docs/*', 'src/**'], write: ['docs/*'] } } })
    expect(note(diffDisclosure(docs, more)).exists()).toBe(false)
    for (const locale of i18n.global.availableLocales) {
      expect(i18n.global.te('pluginDisclosure.diff.declaredScopeNote', locale), locale).toBe(true)
    }
  })

  it('never tags anything but a scope item', () => {
    const withShell = disclosure('1.2.0', { system: ['fs'], shell: 'allowlist', scopes: { fs: { root: 'repository', read: ['docs/*'], write: ['docs/*'] } } })
    const added = tags(diffDisclosure(unscoped, withShell), 'added')
    expect(added).toContain('New Shell mode: allowlist')
    expect(added.filter((text) => text.includes('Declared scope'))).toHaveLength(3)
  })

  it('has the label in every locale', () => {
    for (const locale of i18n.global.availableLocales) {
      expect(i18n.global.te('pluginDisclosure.diff.declaredScope', locale), locale).toBe(true)
    }
  })
})

describe('PluginTrustDialog on an update (plan B D2)', () => {
  const pending = (disclosureDiff: unknown) => ({
    label: 'acme.demo',
    prepared: {
      id: 'acme.demo',
      version: '1.0.1',
      trustTier: 'signed-verified',
      sensitive: ['shell'],
      containsBackendExecutable: false,
      requiresConfirmation: true,
      publisherId: 'acme',
      requiresPublisherTrust: false,
      requiresRiskConfirmation: true,
      disclosureDiff,
      disclosure: disclosure('1.0.1', { shell: 'allowlist' }),
      scan: null,
      registry: null,
    },
  })

  it('adds the difference to the dialog as on main, with the full card folded away', () => {
    const wrapper = mount(PluginTrustDialog, {
      props: { pending: pending(widened) as never, step: 'risk' },
      global: { plugins: [i18n] },
    })
    expect(wrapper.find('.nv-diff').exists()).toBe(true)
    // Main's sensitive-capability list stays (D-d option B: nothing is hidden).
    expect(wrapper.find('.ext-cap-list').exists()).toBe(true)
    expect(wrapper.find('details.ext-trust-full-card .nv-disclosure').exists()).toBe(true)
  })

  it('keeps the first-install dialog as before', () => {
    const wrapper = mount(PluginTrustDialog, {
      props: { pending: pending(null) as never, step: 'risk' },
      global: { plugins: [i18n] },
    })
    expect(wrapper.find('.nv-diff').exists()).toBe(false)
    expect(wrapper.find('.ext-cap-list').exists()).toBe(true)
    expect(wrapper.find('details.ext-trust-full-card').exists()).toBe(false)
    expect(wrapper.find('.nv-disclosure').exists()).toBe(true)
  })
})

describe('PluginDisclosureDiff invisible characters (review L3 on #360)', () => {
  it('spells out invisible characters in item keys', () => {
    const diff = { ...widened, added: [{ kind: 'fsScopeRead' as const, key: 'a‮b.md', detail: null }] }
    const text = mount(PluginDisclosureDiff, { props: { diff }, global: { plugins: [i18n] } }).text()
    expect(text).not.toMatch(/‮/)
    expect(text).toContain('a\\u{202e}b.md')
  })
})
