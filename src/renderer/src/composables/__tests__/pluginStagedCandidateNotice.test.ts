import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import { pluginStagedCandidateNotice } from '../pluginStagedCandidateNotice'

const root = join(__dirname, '../../../../..')
const notice = { pluginId: 'acme.todo', version: '1.0.0', reason: 'staged candidate quarantined: digest mismatch' }

describe('pluginStagedCandidateNotice', () => {
  afterEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  it('names the plugin, the reason and where Restart and Discard are, in each language', () => {
    const cases = [
      ['en-US', 'The Navide plugin acme.todo 1.0.0 was installed but could not be activated when Navide started: staged candidate quarantined: digest mismatch. Open Settings → Navide Plugins to restart or discard it.'],
      ['zh-TW', 'Navide 外掛 acme.todo 1.0.0 已安裝，但 Navide 啟動時無法啟用：staged candidate quarantined: digest mismatch。請到「設定 → Navide 外掛」重新啟動或捨棄它。'],
      ['ja-JP', 'Navide プラグイン acme.todo 1.0.0 はインストール済みですが、Navide の起動時に有効化できませんでした：staged candidate quarantined: digest mismatch。「設定 → Navide プラグイン」で再起動するか破棄してください。'],
    ] as const
    for (const [locale, text] of cases) {
      i18n.global.locale.value = locale
      expect(pluginStagedCandidateNotice(notice)).toBe(text)
    }
  })

  it('is shown from the Host report the main window receives', () => {
    const app = readFileSync(join(root, 'src/renderer/src/App.vue'), 'utf8')
    const preload = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
    const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
    const relay = readFileSync(join(root, 'src/main/pluginStagedCandidateRelay.ts'), 'utf8')
    // main hands every failed launch activation to the relay, which sends it to a loaded main window.
    expect(main).toMatch(/activateStagedFirstInstalls\(\)\.then\(\(failures\) => \{[\s\S]*?pluginStagedCandidateRelay\.notify\(failure\)/)
    expect(main).toContain("win.webContents.on('did-finish-load', () => pluginStagedCandidateRelay.flush(win))")
    expect(relay).toContain("webContents.send('plugins:stagedCandidateNotActivated', notice)")
    expect(preload).toContain("ipcRenderer.on('plugins:stagedCandidateNotActivated', listener)")
    expect(app).toMatch(
      /onPluginStagedCandidateNotActivated\?\.\(\(notice\) => \{\s*notifyRestore\.toast\(pluginStagedCandidateNotice\(notice\), \{ type: 'error' \}\)/,
    )
  })
})
