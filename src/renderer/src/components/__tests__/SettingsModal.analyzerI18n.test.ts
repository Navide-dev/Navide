// @vitest-environment happy-dom
// The last hard-coded strings in Settings: the Analyzer tab, the settings
// bundle export/import, the shell (nav aria-label, close button), and the five
// "Settings & System" help rows whose zh-TW value was still the English one.
//
// SettingsModal is not mounted here (its props are six composable APIs; the
// full-mount check lives with the i18n acceptance tests), so its half is the
// source contract plus the i18n bundle resolving each key to a different
// string per locale. SettingsSystemHelp mounts cheaply, so the help rows are
// asserted off the rendered text.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import SettingsSystemHelp from '../SettingsSystemHelp.vue'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/SettingsModal.vue'),
  'utf8',
)

function tIn(locale: 'en-US' | 'zh-TW', key: string, named?: Record<string, unknown>): string {
  i18n.global.locale.value = locale
  return named ? i18n.global.t(key, named) : i18n.global.t(key)
}

describe('Settings — remaining hard-coded strings', () => {
  const originalLocale = i18n.global.locale.value
  afterEach(() => {
    i18n.global.locale.value = originalLocale
  })

  // key → [template/script reference, en-US text, zh-TW text]
  const KEYS: Array<[string, string, string, string]> = [
    // A. Analyzer tab
    ['settings.analyzer.ai-keys-label', "{{ $t('settings.analyzer.ai-keys-label') }} {{ settingsPaths.ai_chat }}", 'AI keys:', 'AI 金鑰：'],
    ['settings.analyzer.llama-cli-placeholder', ":placeholder=\"$t('settings.analyzer.llama-cli-placeholder')\"", 'e.g. llama-cli or /usr/local/bin/llama-completion', '例如 llama-cli 或 /usr/local/bin/llama-completion'],
    ['settings.analyzer.gguf-file-found', "{{ $t('settings.analyzer.gguf-file-found') }} ·", 'File found', '已找到檔案'],
    ['settings.analyzer.gguf-not-detected', "?.gguf_warning ?? $t('settings.analyzer.gguf-not-detected')", 'Not yet detected', '尚未偵測到'],
    ['settings.analyzer.gguf-hint', "<div class=\"az-gguf-hint\" v-html=\"$t('settings.analyzer.gguf-hint')\"></div>", 'Download a <code>.gguf</code> file from', '下載 <code>.gguf</code> 檔案，並在這裡填入完整路徑'],
    // B. Settings bundle export / import
    ['settings.management.export-dialog-title', "title: t('settings.management.export-dialog-title')", 'Export Settings Bundle', '匯出設定全集'],
    ['settings.management.exported', "settingsBundleSummary.value = [{ key: 'settings.management.exported' }]", 'Settings bundle exported', '設定全集已匯出'],
    ['settings.management.export-failed', "{ text: err.message } : { key: 'settings.management.export-failed' }", 'Export failed', '匯出失敗'],
    ['settings.management.import-dialog-title', "openJson({ title: t('settings.management.import-dialog-title') })", 'Import Settings Bundle JSON', '匯入設定全集 JSON'],
    ['settings.management.import-failed', "{ text: err.message } : { key: 'settings.management.import-failed' }", 'Import failed', '匯入失敗'],
    ['settings.analyzer.filter-executable', "{ name: t('settings.analyzer.filter-executable'), extensions: ['*'] }", 'Executable', '執行檔'],
    ['settings.analyzer.filter-gguf', "{ name: t('settings.analyzer.filter-gguf'), extensions: ['gguf'] }", 'GGUF Model', 'GGUF 模型'],
    ['settings.analyzer.filter-all-files', "{ name: t('settings.analyzer.filter-all-files'), extensions: ['*'] }", 'All Files', '所有檔案'],
    // C. Shell
    ['settings.nav.sections-label', "<nav class=\"s-nav\" ref=\"navRef\" :aria-label=\"$t('settings.nav.sections-label')\">", 'Settings sections', '設定分區'],
    ['action.close-esc', ":title=\"$t('action.close-esc')\"", 'Close (ESC)', '關閉（ESC）'],
  ]

  it.each(KEYS)('%s is referenced from the template and resolves per locale', (key, reference, en, zh) => {
    expect(source).toContain(reference)
    expect(tIn('en-US', key)).toContain(en)
    expect(tIn('zh-TW', key)).toContain(zh)
    expect(tIn('zh-TW', key)).not.toBe(tIn('en-US', key))
  })

  it('the import summary interpolates the applied list', () => {
    expect(source).toContain("{ key: 'settings.management.imported', params: { items: applied.join(', ') || 'appearance' } }")
    expect(tIn('en-US', 'settings.management.imported', { items: 'roles, mcp' })).toBe('Imported: roles, mcp')
    expect(tIn('zh-TW', 'settings.management.imported', { items: 'roles, mcp' })).toBe('已匯入：roles, mcp')
  })

  it('keeps the gguf hint link in both locales', () => {
    const href = 'href="https://huggingface.co/models?library=gguf"'
    expect(tIn('en-US', 'settings.analyzer.gguf-hint')).toContain(href)
    expect(tIn('zh-TW', 'settings.analyzer.gguf-hint')).toContain(href)
  })

  it('leaves product names, units, ids and example values untranslated', () => {
    for (const literal of [
      '>Ollama REST</button>',
      '>llama.cpp</button>',
      'placeholder="http://localhost:11434"',
      "v-for=\"t in ['T1','T2','T3','T4']\"",
      "{{ r.tasks.find(t => t.task_id === tid)!.elapsed_s }}s</span>",
      "(m.size / 1e9).toFixed(1) }} GB",
    ]) {
      expect(source).toContain(literal)
    }
  })
})

describe('SettingsSystemHelp — rows that quote the UI', () => {
  const originalLocale = i18n.global.locale.value
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    i18n.global.locale.value = originalLocale
    warn.mockRestore()
  })

  function mountHelp() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return mount(SettingsSystemHelp as any, { global: { plugins: [i18n] } })
  }

  // Each help row must read exactly what the control it describes reads, so
  // the expected text is the UI's own key, not a second spelling.
  const UI_KEYS = [
    'updater.auto-check',
    'updater.auto-download',
    'updater.auto-install',
    'resource.title',
    'resource.storage.title',
    'resource.storage.clean-safe',
    'settings.skills.matrix-legend-planned',
    'settings.skills.matrix-legend-unsupported',
  ]

  it('renders the update toggles, the cleanup path and the skill legend in zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const text = mountHelp().text()

    expect(text).toContain('自動檢查更新')
    expect(text).toContain('自動下載更新')
    expect(text).toContain('結束 App 時安裝更新')
    expect(text).toContain('視窗 ▸ 資源控管 ▸ 儲存空間 ▸ 清理安全項目')
    expect(text).toContain('· 支援但尚未接線')
    // The en cell drops the legend's "(not via Navide)" tail, so zh does too.
    expect(text).toContain('● 自己就讀得到')
    expect(text).toContain('— 無 skills 機制')
    for (const key of UI_KEYS) expect(text).toContain(i18n.global.t(key))
  })

  it('renders the same rows in English under en-US', () => {
    i18n.global.locale.value = 'en-US'
    const text = mountHelp().text()

    expect(text).toContain('Automatically check for updates')
    expect(text).toContain('Automatically download updates')
    expect(text).toContain('Install updates when you quit')
    expect(text).toContain('Window ▸ Resource Manager ▸ Storage ▸ Clean safe items')
    expect(text).toContain('· supported, not wired yet')
    expect(text).toContain('● already reads it')
    expect(text).toContain('— no skills mechanism')
    for (const key of UI_KEYS) expect(text).toContain(i18n.global.t(key))
  })
})
