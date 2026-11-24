import { describe, expect, it } from 'vitest'
import { SUPPORTED_LOCALES as UI_LOCALES } from './hostLocale'
import { ORG_HANDOFF_STRINGS, orgHandoffStrings } from './orgHandoffStrings'

describe('orgHandoffStrings', () => {
  it('has a title and body in every UI language', () => {
    for (const locale of UI_LOCALES) {
      const strings = ORG_HANDOFF_STRINGS[locale]
      expect(strings?.title, locale).toBeTruthy()
      expect(strings?.body, locale).toBeTruthy()
    }
    expect(orgHandoffStrings('zh-TW').title).toBe('無法開啟組織網站')
  })
})
