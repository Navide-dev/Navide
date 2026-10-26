import { describe, expect, it } from 'vitest'
import { SUPPORTED_LOCALES } from './hostLocale'
import { webAgentWritePrompt, webPolicyDeniedMessage } from './browserAgentStrings'

describe('browserAgentStrings', () => {
  it('names web and where to add it in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const mode of ['allowlist', 'denylist'] as const) {
        const message = webPolicyDeniedMessage(locale, mode)
        expect(message, `${locale} ${mode}`).toContain('web')
        expect(message, `${locale} ${mode}`).toContain(mode)
      }
    }
    expect(webPolicyDeniedMessage('zh-TW', 'allowlist')).toBe(
      '你的 agent 執行政策 allowlist 沒有包含 web，請到「設定 → Navide 外掛 → 執行政策」加入 web。',
    )
  })

  it('asks about operating web pages, not changing files', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const prompt = webAgentWritePrompt(locale, '"Act" (browser_act)', 'Browser', '0.1.0')
      expect(prompt.message, locale).toContain('"Act" (browser_act)')
      expect(prompt.message, locale).toContain('Browser 0.1.0')
      expect(prompt.message.toLowerCase(), locale).not.toContain('file')
      expect(prompt.buttons).toHaveLength(2)
      expect(prompt.origin, locale).toContain('agent')
    }
    expect(webAgentWritePrompt('zh-TW', 't', 'Browser', '0.1.0').message).toContain('操作網頁（點擊、輸入、送出）')
  })
})
