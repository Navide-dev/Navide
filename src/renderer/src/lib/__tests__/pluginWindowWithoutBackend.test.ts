import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import { pluginWindowWithoutBackendText } from '../pluginWindowWithoutBackend'

const saved = i18n.global.locale.value
afterEach(() => {
  i18n.global.locale.value = saved
})

const t = i18n.global.t as (key: string, values?: Record<string, unknown>) => string

describe('pluginWindowWithoutBackendText (#641 L2)', () => {
  it('words the reason in the user language, as the Settings row does', () => {
    i18n.global.locale.value = 'zh-TW'
    const text = pluginWindowWithoutBackendText(t, {
      name: 'Map',
      reason: 'third-party native backends are turned off',
      status: 'disabled-globally',
    })
    expect(text).toContain(t('settings.extensions.nativeBackends.status.disabledGlobally'))
    expect(text).not.toContain('turned off')
    expect(text).toContain('Map')
  })

  it.each(['disabled-globally', 'needs-consent'])('offers "allow", then reopening, for %s', (status) => {
    i18n.global.locale.value = 'en-US'
    const text = pluginWindowWithoutBackendText(t, { name: 'Map', reason: 'x', status })
    expect(text).toContain('To allow the backend')
    expect(text).toContain('reopen the window')
    expect(text).toContain(t('settings.extensions.developerNative'))
  })

  it.each(['disabled', 'sandbox-unavailable', 'shell-not-allowed', 'stopped-after-crashes', 'unavailable'])(
    'only points at Settings for %s, which the user cannot "allow" there',
    (status) => {
      i18n.global.locale.value = 'en-US'
      const text = pluginWindowWithoutBackendText(t, { name: 'Map', reason: 'x', status })
      expect(text).not.toContain('allow')
      expect(text).toContain(`${t('settings.extensions.developerNative')} shows why`)
    },
  )

  it('falls back to the reason as sent when no status came with it', () => {
    i18n.global.locale.value = 'en-US'
    const text = pluginWindowWithoutBackendText(t, { name: 'Map', reason: 'the native backend could not start' })
    expect(text).toContain('the native backend could not start')
    expect(text).not.toContain('{')
  })

  it('leaves no placeholder unfilled in any locale', () => {
    for (const locale of i18n.global.availableLocales) {
      i18n.global.locale.value = locale
      for (const status of ['needs-consent', 'sandbox-unavailable']) {
        expect(pluginWindowWithoutBackendText(t, { name: 'Map', reason: 'x', status }), locale).not.toMatch(/[{}]/)
      }
    }
  })
})
