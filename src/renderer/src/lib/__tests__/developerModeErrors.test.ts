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
  })

  it('leaves any other message as it is', () => {
    expect(localizeDeveloperModeError('download failed: HTTP 500', i18n.global.t)).toBe('download failed: HTTP 500')
  })
})
