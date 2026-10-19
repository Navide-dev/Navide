import { describe, expect, it } from 'vitest'
import enUS from '../../../../packages/plugin-ui/src/foundation/i18n/locales/en-US.json'
import jaJP from '../../../../packages/plugin-ui/src/foundation/i18n/locales/ja-JP.json'
import zhTW from '../../../../packages/plugin-ui/src/foundation/i18n/locales/zh-TW.json'

describe('web disclosure', () => {
  it('says agents use your sign-ins and that a reload stops agent scripts, the same in the trust dialog and the card', () => {
    const expected = [
      [enUS, 'agents use your sign-ins in this Navide plugin (they can send requests on websites for you)',
        'after you take over, agent scripts already running in a page stop only when you reload it'],
      [zhTW, 'agent 會使用你在此 Navide 外掛中的登入身分（可代你在網頁上發送請求）',
        '你接手後，頁面內已經在跑的 agent 腳本要重新載入才會停止'],
      [jaJP, 'agent はこの Navide プラグインでのあなたのログイン情報を使い（あなたの代わりにウェブページでリクエストを送信できます）',
        '操作を引き継いだ後も、ページ内ですでに動いている agent のスクリプトは、再読み込みするまで止まりません'],
    ] as const
    for (const [locale, identity, reload] of expected) {
      const summary = locale.pluginDisclosure.summary.web
      expect(locale.settings.extensions.trust.capability.web).toBe(summary)
      expect(summary).toContain(identity)
      expect(summary).toContain(reload)
    }
  })
})
