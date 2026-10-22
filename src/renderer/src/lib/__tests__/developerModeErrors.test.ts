import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import { localizeDeveloperModeError } from '../developerModeErrors'

const saved = i18n.global.locale.value
afterEach(() => {
  i18n.global.locale.value = saved
})

describe('localizeDeveloperModeError (review LOW-2 on #428)', () => {
  const coded = [
    'DEVELOPER_FOLDER_HOLDS_ID [acme.todo]: acme.todo is loaded from a developer folder; remove that folder in Developer Mode first',
    'ANOTHER_DEVELOPER_FOLDER [acme.todo]: acme.todo is loaded from another developer folder (/x); remove that folder first',
    'DEVELOPER_FOLDER_ID_INSTALLED [acme.todo]: acme.todo is installed; remove it before loading a developer folder with the same id',
    'DEVELOPER_MODE_OFF: turn on Developer Mode to load a Navide plugin from a folder',
    'DEVELOPER_FOLDER_V2_ONLY: Developer Mode loads Manifest v2 folders only',
    'DEVELOPER_FOLDER_RESERVED_ID [navide.x]: Developer Mode cannot claim reserved plugin id',
    'DEVELOPER_FOLDER_CHANGED [acme.todo]: the permissions or backend of acme.todo changed; choose the folder again',
    "DEVELOPER_FOLDER_TAKEN_DOWN [acme.todo]: taken down by Navide: publisher 'acme' is blocked",
    "DIGEST_BLOCKED [acme.todo]: this file of 'acme.todo' was taken down by Navide and cannot be installed",
  ]

  it('words every coded refusal in every locale, never as the raw code', () => {
    for (const locale of ['zh-TW', 'en-US', 'ja-JP'] as const) {
      i18n.global.locale.value = locale
      for (const message of coded) {
        const shown = localizeDeveloperModeError(message, i18n.global.t)
        expect(shown, `${locale}: ${message}`).not.toMatch(/^[A-Z]+_[A-Z_]+(?: \[|:)/)
        expect(shown).not.toMatch(/settings\.extensions/)
      }
    }
    i18n.global.locale.value = 'zh-TW'
    expect(localizeDeveloperModeError(coded[0], i18n.global.t)).toContain('acme.todo')
    expect(localizeDeveloperModeError(coded.at(-1)!, i18n.global.t)).toContain('acme.todo')
  })

  it('tells apart trust data that is not valid yet from expired trust data, pointing at the clock', () => {
    const notYet =
      "TRUST_METADATA_NOT_YET_VALID: registry trust metadata was generated at 2026-08-16T12:10:00.000Z, later than this computer's clock (2026-08-16T12:00:00.000Z); check the computer's date and time"
    const expired =
      "TRUST_METADATA_EXPIRED: registry trust metadata expired at 2026-08-17T10:00:00.000Z by this computer's clock (2026-08-18T00:00:00.000Z); check the computer's date and time"
    for (const locale of ['en-US', 'zh-TW', 'zh-CN', 'ja-JP', 'ko-KR'] as const) {
      i18n.global.locale.value = locale
      const a = localizeDeveloperModeError(notYet, i18n.global.t)
      const b = localizeDeveloperModeError(expired, i18n.global.t)
      expect(a, locale).not.toMatch(/TRUST_METADATA|settings\.extensions/)
      expect(b, locale).not.toMatch(/TRUST_METADATA|settings\.extensions/)
      expect(a, locale).not.toBe(b)
    }
    const signature =
      "REGISTRY_SIGNATURE_NOT_YET_VALID: registry signature was made at 2026-08-16T12:10:00.000Z, later than this computer's clock (2026-08-16T12:00:00.000Z); check the computer's date and time"
    for (const locale of ['en-US', 'zh-TW', 'zh-CN', 'ja-JP', 'ko-KR'] as const) {
      i18n.global.locale.value = locale
      expect(localizeDeveloperModeError(signature, i18n.global.t), locale).toBe(
        localizeDeveloperModeError(notYet, i18n.global.t)
      )
    }
    i18n.global.locale.value = 'en-US'
    expect(localizeDeveloperModeError(notYet, i18n.global.t)).toMatch(/date and time/)
    expect(localizeDeveloperModeError(expired, i18n.global.t)).toMatch(/expired.*date and time/)
  })

  it('leaves any other message as it is', () => {
    expect(localizeDeveloperModeError('download failed: HTTP 500', i18n.global.t)).toBe('download failed: HTTP 500')
  })
})
