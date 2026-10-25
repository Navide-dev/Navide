import { describe, expect, it } from 'vitest'
import { leadSentence } from '../leadSentence'
import en from '../../../../../packages/plugin-ui/src/foundation/i18n/locales/en-US.json'
import zhTW from '../../../../../packages/plugin-ui/src/foundation/i18n/locales/zh-TW.json'
import ja from '../../../../../packages/plugin-ui/src/foundation/i18n/locales/ja-JP.json'

const join = (parts: ReturnType<typeof leadSentence>) => parts.lead + parts.separator + parts.rest

describe('leadSentence', () => {
  it('splits after the first sentence and loses nothing', () => {
    const parts = leadSentence('First sentence here. Second one. Third.')
    expect(parts).toEqual({ lead: 'First sentence here.', separator: ' ', rest: 'Second one. Third.' })
  })

  it('splits after a full-width full stop', () => {
    expect(leadSentence('第一句。第二句。')).toEqual({ lead: '第一句。', separator: '', rest: '第二句。' })
  })

  it('keeps a single sentence whole', () => {
    expect(leadSentence('Only one sentence.')).toEqual({ lead: 'Only one sentence.', separator: '', rest: '' })
    expect(leadSentence('No full stop at all')).toEqual({ lead: 'No full stop at all', separator: '', rest: '' })
  })

  it('reproduces the real warnings it is used on, word for word, in every script', () => {
    for (const locale of [en, zhTW, ja] as Array<typeof en>) {
      for (const text of [locale.settings.extensions.plansRiskNote, locale.settings.extensions.nativeBackends.description]) {
        const parts = leadSentence(text)
        expect(join(parts)).toBe(text)
        expect(parts.rest.length).toBeGreaterThan(0)
      }
    }
  })
})
