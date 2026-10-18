// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginSourceBadge from '../PluginSourceBadge.vue'
import PluginTrustDialog from '../PluginTrustDialog.vue'
import { PLUGIN_SOURCES, type PluginSource } from '../../../../shared/pluginSource'

const LOCALES = ['zh-TW', 'en-US', 'ja-JP'] as const
const LOCAL_SOURCES: PluginSource[] = ['local-signed', 'local-unsigned', 'developer-unpacked']
/** Sources a Registry signature stands behind. */
const REGISTRY_SIGNED: PluginSource[] = ['marketplace', 'prerelease']

function render(props: Record<string, unknown>) {
  return mount(PluginSourceBadge, { props: props as never, global: { plugins: [i18n] } })
}

let saved: typeof i18n.global.locale.value
beforeEach(() => {
  saved = i18n.global.locale.value
})
afterEach(() => {
  i18n.global.locale.value = saved
})

describe('PluginSourceBadge (K2)', () => {
  it('words every source in every locale (badge and disclosure row)', () => {
    const shown: Record<string, Record<string, { badge: string; row: string }>> = {}
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      shown[locale] = {}
      for (const source of PLUGIN_SOURCES) {
        const props = { source, publisher: 'acme', expiresAt: '2026-12-31T08:00:00Z' }
        shown[locale][source] = { badge: render(props).text(), row: render({ ...props, row: true }).text() }
      }
    }
    expect(shown).toMatchSnapshot()
  })

  it('never leaves the scan field of a local source blank or says nothing was found', () => {
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      for (const source of LOCAL_SOURCES) {
        const scan = render({ source, row: true }).find('.nv-source-scan')
        expect(scan.exists(), `${locale} ${source}`).toBe(true)
        expect(scan.text().length).toBeGreaterThan(0)
      }
    }
    i18n.global.locale.value = 'en-US'
    const text = render({ source: 'local-unsigned', row: true }).find('.nv-source-scan').text()
    expect(text).toBe('Not scanned (only Navide plugins installed from the Navide Marketplace are scanned by Navide)')
    expect(text).not.toMatch(/nothing|no findings|not found/i)
  })

  it('shows an unsigned local publisher as self-declared, unlike a Registry publisher', () => {
    i18n.global.locale.value = 'zh-TW'
    for (const source of ['local-unsigned', 'developer-unpacked'] as const) {
      expect(render({ source, publisher: 'acme', row: true }).find('.nv-source-publisher').text()).toContain('自稱：acme')
    }
    i18n.global.locale.value = 'en-US'
    expect(render({ source: 'local-unsigned', publisher: 'acme', row: true }).find('.nv-source-publisher').text()).toContain('Self-declared: acme')
    // A Registry source's publisher is shown by the existing card; the row adds none.
    expect(render({ source: 'marketplace', publisher: 'acme', row: true }).find('.nv-source-publisher').exists()).toBe(false)
  })

  it('keeps "verified" and "safe" wording to Registry-signed sources only', () => {
    const misleading = /verified|safe|已驗證|安全|検証済み|安全/i
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      for (const source of PLUGIN_SOURCES.filter((s) => !REGISTRY_SIGNED.includes(s))) {
        const text = render({ source, publisher: 'acme', expiresAt: '2026-12-31', row: true }).text()
        expect(text, `${locale} ${source}`).not.toMatch(misleading)
      }
    }
  })

  it('prints a test build expiry as YYYY-MM-DD, and says when it is unknown', () => {
    i18n.global.locale.value = 'zh-TW'
    expect(render({ source: 'testplace', expiresAt: '2026-12-31T08:00:00Z' }).text()).toBe('測試版，沒有人工審核，2026-12-31 到期')
    for (const expiresAt of [undefined, null, '']) {
      expect(render({ source: 'testplace', expiresAt }).text()).toBe('測試版，沒有人工審核，到期日不明')
    }
  })
})

describe('PluginTrustDialog source row (K2)', () => {
  const pending = (trustTier: 'signed-verified' | 'unsigned') => ({
    label: 'acme.demo',
    prepared: {
      id: 'acme.demo', version: '1.0.0', trustTier, sensitive: [], containsBackendExecutable: false,
      requiresConfirmation: true, publisherId: 'acme', requiresPublisherTrust: false, requiresRiskConfirmation: true,
    },
  })

  const at = (prepared: Record<string, unknown>, step: 'publisher' | 'risk' = 'risk') => {
    const base = pending('signed-verified')
    return mount(PluginTrustDialog, { props: { pending: { ...base, prepared: { ...base.prepared, ...prepared } }, step } as never, global: { plugins: [i18n] } })
  }

  it('shows the row only for the source the Host names, on both steps', () => {
    i18n.global.locale.value = 'en-US'
    for (const step of ['publisher', 'risk'] as const) {
      expect(at({ source: 'marketplace' }, step).get('.nv-source-row').text()).toBe('Source and review Reviewed')
      expect(at({}, step).find('.nv-source-row').exists()).toBe(false)
      expect(at({ trustTier: 'unsigned' }, step).find('.nv-source-row').exists()).toBe(false)
    }
    expect(at({ source: 'prerelease', version: '2.0.0-beta.1' }).get('.nv-source-row').attributes('data-source')).toBe('prerelease')
    const local = at({ trustTier: 'unsigned', source: 'local-unsigned' }).get('.nv-source-row')
    expect(local.attributes('data-source')).toBe('local-unsigned')
    expect(local.text()).toContain('Self-declared: acme')
  })

  it('never reads as reviewed from the version alone (a testplace build versioned 1.0.0)', () => {
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      for (const version of ['1.0.0', '2.0.0-beta.1']) {
        const dialog = at({ version })
        expect(dialog.find('.nv-source-row').exists(), `${locale} ${version}`).toBe(false)
        expect(dialog.text()).not.toMatch(/Reviewed|reviewed|已審核|審査済み/)
      }
    }
  })
})

describe('Pre-release source row (K5)', () => {
  const pending = (version: string, source?: PluginSource) => ({
    label: 'acme.demo',
    prepared: {
      id: 'acme.demo', version, trustTier: 'signed-verified', sensitive: [], containsBackendExecutable: false,
      requiresConfirmation: true, publisherId: 'acme', requiresPublisherTrust: false, requiresRiskConfirmation: true,
      ...(source ? { source } : {}),
    },
  })
  const unreviewed = /not reviewed|unreviewed|未審核|未經.*審核|審査なし|審査を受けていません/i

  it('words a pre-release install as reviewed in every locale', () => {
    const shown: Record<string, string> = {}
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      const dialog = mount(PluginTrustDialog, { props: { pending: pending('2.5.0-beta.1', 'prerelease'), step: 'risk' } as never, global: { plugins: [i18n] } })
      const row = dialog.get('.nv-source-row')
      expect(row.attributes('data-source')).toBe('prerelease')
      expect(row.text(), locale).not.toMatch(unreviewed)
      shown[locale] = row.text()
      dialog.unmount()
    }
    expect(shown).toMatchSnapshot()
  })

  it('never reads the source from the version number', () => {
    i18n.global.locale.value = 'en-US'
    // A Host that sends no source gets no row, whatever the version looks like.
    for (const version of ['2.5.0-beta.1', '2.4.0']) {
      const dialog = mount(PluginTrustDialog, { props: { pending: pending(version), step: 'risk' } as never, global: { plugins: [i18n] } })
      expect(dialog.find('.nv-source-row').exists(), version).toBe(false)
      dialog.unmount()
    }
    // A Host source wins over a pre-release-looking version.
    const stable = mount(PluginTrustDialog, { props: { pending: pending('2.5.0-beta.1', 'marketplace'), step: 'risk' } as never, global: { plugins: [i18n] } })
    expect(stable.get('.nv-source-row').attributes('data-source')).toBe('marketplace')
    stable.unmount()
  })
})
