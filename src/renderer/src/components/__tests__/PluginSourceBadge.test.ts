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

  it('shows "Reviewed" only for a Registry-signed package, on both steps', () => {
    i18n.global.locale.value = 'en-US'
    for (const step of ['publisher', 'risk'] as const) {
      const signed = mount(PluginTrustDialog, { props: { pending: pending('signed-verified'), step } as never, global: { plugins: [i18n] } })
      expect(signed.get('.nv-source-row').text()).toBe('Source and review Reviewed')
      signed.unmount()
      const unsigned = mount(PluginTrustDialog, { props: { pending: pending('unsigned'), step } as never, global: { plugins: [i18n] } })
      expect(unsigned.find('.nv-source-row').exists()).toBe(false)
      unsigned.unmount()
    }
  })
  it('names a pre-release by its version and prefers the Host\'s own source', () => {
    i18n.global.locale.value = 'en-US'
    const at = (prepared: Record<string, unknown>) => {
      const base = pending('signed-verified')
      return mount(PluginTrustDialog, { props: { pending: { ...base, prepared: { ...base.prepared, ...prepared } }, step: 'risk' } as never, global: { plugins: [i18n] } })
    }
    expect(at({ version: '2.0.0-beta.1' }).get('.nv-source-row').attributes('data-source')).toBe('prerelease')
    expect(at({ version: '2.0.0+build.7' }).get('.nv-source-row').attributes('data-source')).toBe('marketplace')
    expect(at({ source: 'prerelease', version: '2.0.0' }).get('.nv-source-row').attributes('data-source')).toBe('prerelease')
    const local = at({ trustTier: 'unsigned', source: 'local-unsigned' }).get('.nv-source-row')
    expect(local.attributes('data-source')).toBe('local-unsigned')
    expect(local.text()).toContain('Self-declared: acme')
  })
})
