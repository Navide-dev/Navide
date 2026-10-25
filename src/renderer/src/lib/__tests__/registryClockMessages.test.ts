import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import { localizeDeveloperModeError } from '../developerModeErrors'

// #575 follow-up (option C): a clock refusal says the clock looks off, which
// way, and to correct it, even when a caller put its own words in front.
const LOCALES = ['de-DE', 'en-US', 'es-ES', 'fr-FR', 'ja-JP', 'ko-KR', 'pt-BR', 'ru-RU', 'vi-VN', 'zh-CN', 'zh-TW'] as const
const saved = i18n.global.locale.value
afterEach(() => {
  i18n.global.locale.value = saved
})

const notYet =
  "TRUST_METADATA_NOT_YET_VALID: registry trust metadata was generated at 2026-08-16T10:00:00.000Z, later than this computer's clock (2026-08-16T09:50:00.000Z); check the computer's date and time"
const expired =
  "TRUST_METADATA_EXPIRED: registry trust metadata expired at 2026-08-17T10:00:00.000Z by this computer's clock (2026-08-17T11:00:00.000Z); check the computer's date and time"

describe('clock refusals in the install and update flows', () => {
  it('says a slow clock is behind and a fast one ahead, and to correct it', () => {
    i18n.global.locale.value = 'en-US'
    expect(localizeDeveloperModeError(notYet, i18n.global.t)).toMatch(/clock appears to be behind.*Correct your computer's date and time/)
    expect(localizeDeveloperModeError(expired, i18n.global.t)).toMatch(/clock appears to be ahead.*Correct your computer's date and time/)
  })

  it('still says so after a caller\'s own words, in every locale', () => {
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      for (const [message, wrapped] of [
        [notYet, `installed plugin quarantined: ${notYet}`],
        [expired, `staged candidate quarantined: ${expired}`],
      ]) {
        const shown = localizeDeveloperModeError(wrapped, i18n.global.t)
        expect(shown, locale).toBe(localizeDeveloperModeError(message, i18n.global.t))
        expect(shown, locale).not.toMatch(/TRUST_METADATA|quarantined|settings\.extensions/)
      }
    }
  })
})

describe('the Extensions page notice for a build stopped over the clock', () => {
  it('names the build and the way the clock looks off, in every locale', () => {
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      const behind = i18n.global.t('settings.extensions.registryTrust.clockQuarantine.behind', { id: 'acme.beta', version: '0.3.0' })
      const ahead = i18n.global.t('settings.extensions.registryTrust.clockQuarantine.ahead', { id: 'acme.beta', version: '0.3.0' })
      for (const text of [behind, ahead]) {
        expect(text, locale).toContain('acme.beta 0.3.0')
        expect(text, locale).not.toMatch(/settings\.extensions|\{/)
      }
      expect(behind, locale).not.toBe(ahead)
    }
  })
})
