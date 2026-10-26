import { describe, it, expect } from 'vitest'
import { builtinPluginDisabledDialog } from './builtinPluginStrings'
import { SUPPORTED_LOCALES } from './hostLocale'

describe('builtinPluginDisabledDialog', () => {
  it('names the plugin and the Navide Plugins settings page in every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const { title, message } = builtinPluginDisabledDialog(locale, 'Plans')
      expect(title).toMatch(/Navide/)
      expect(message).toContain('Plans')
    }
    expect(builtinPluginDisabledDialog('zh-TW', 'Git').message).toBe('Navide 外掛 Git 已停用，請在「設定 → Navide 外掛」重新啟用。')
    expect(builtinPluginDisabledDialog('ja-JP', 'Git').title).toBe('Navide プラグインは無効です')
    expect(builtinPluginDisabledDialog('en-US', 'Mini-IDE').message)
      .toBe('Navide plugin Mini-IDE is disabled. Enable it in Settings → Navide Plugins.')
  })
})
