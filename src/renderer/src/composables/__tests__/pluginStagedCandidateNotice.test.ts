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
    expect(relay).toContain("deliver('plugins:stagedCandidateNotActivated', notice)")
    expect(preload).toContain("ipcRenderer.on('plugins:stagedCandidateNotActivated', listener)")
    expect(app).toMatch(
      /onPluginStagedCandidateNotActivated\?\.\(\(notice\) => \{\s*notifyRestore\.toast\(pluginStagedCandidateNotice\(notice\), \{ type: 'error' \}\)/,
    )
  })
})

describe('staged packages found at launch', () => {
  it('reach the announcements centre and "Apply now" runs Restart for that package', () => {
    const app = readFileSync(join(root, 'src/renderer/src/App.vue'), 'utf8')
    const preload = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
    const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
    const panel = readFileSync(join(root, 'src/renderer/src/components/AnnouncementsPanel.vue'), 'utf8')
    expect(main).toMatch(/const staged = pluginTrustRefresh\.stagedUpdates\(\)\s*if \(staged\.length > 0\) pluginStagedCandidateRelay\.notifyStagedUpdates\(staged\)/)
    expect(preload).toContain("ipcRenderer.on('plugins:stagedUpdates', listener)")
    expect(app).toMatch(/onPluginStagedUpdates\?\.\(\(updates\) => \{\s*announcements\.notePluginStagedUpdates\(updates\)/)
    expect(panel).toContain("action.kind === 'plugin-staged-apply'")
    expect(app).toContain("if (action.kind === 'plugin-staged-apply') return applyStagedPluginPackage(action)")
    expect(app).toMatch(/applyStagedPluginPackage[\s\S]*?pluginStagedApplyApplies\(action, installed\)[\s\S]*?plugins\?\.restart\?\.\(action\.pluginId\)/)
  })
})

describe('an approved update takes effect at once (L3)', () => {
  it('is disclosed before approval, switched right after it, and recorded with a way back', () => {
    const app = readFileSync(join(root, 'src/renderer/src/App.vue'), 'utf8')
    const preload = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
    const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
    const dialog = readFileSync(join(root, 'src/renderer/src/components/PluginTrustDialog.vue'), 'utf8')
    const flow = readFileSync(join(root, 'src/renderer/src/composables/usePluginInstallFlow.ts'), 'utf8')
    // Before: the consent dialog says the views reload and the switch can be undone.
    expect(dialog).toContain("$t('settings.extensions.switchNow'")
    // Right after: the approved update goes through Restart.
    expect(flow).toMatch(/committed\?\.restartRequired === true && !committed\.activationError && plugins\.restart\)[\s\S]*?await plugins\.restart\(id\)/)
    // Recorded: main reports every switch, the window keeps a row with the way back.
    expect(main).toContain('onPackageSwitched: (notice) => pluginStagedCandidateRelay.notifySwitched(notice)')
    expect(preload).toContain("ipcRenderer.on('plugins:switched', listener)")
    expect(app).toMatch(/onPluginSwitched\?\.\(\(notice\) => \{\s*announcements\.notePluginSwitch\(notice\)/)
    expect(app).toContain("if (action.kind === 'plugin-switch-back') return revertPluginSwitch(action)")
    expect(app).toMatch(/revertPluginSwitch[\s\S]*?pluginSwitchBackApplies\(action, installed\)[\s\S]*?plugins\?\.rollback\?\.\(action\.pluginId\)/)
  })
})
