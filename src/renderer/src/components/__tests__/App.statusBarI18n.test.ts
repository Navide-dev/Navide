// @vitest-environment happy-dom
// The status bar's backend pill popover and its pipeline pill were still
// hard-coded English, so a zh-TW or ja-JP window showed "Backend",
// "connected", "Restart", "Stop" and "Stage 2 / 5" beside translated pills.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount. The template
// half asserts the literals are gone; the i18n half asserts every key resolves
// to a translated string in each locale.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

type Locale = 'en-US' | 'zh-TW' | 'ja-JP'

function tIn(locale: Locale, key: string, named?: Record<string, unknown>): string {
  i18n.global.locale.value = locale
  return named ? i18n.global.t(key, named) : i18n.global.t(key)
}

function sliceBetween(start: string, end: string): string {
  const at = appSource.indexOf(start)
  return at === -1 ? '' : appSource.slice(at, appSource.indexOf(end, at))
}

describe('status bar — hard-coded strings', () => {
  const originalLocale = i18n.global.locale.value
  afterEach(() => {
    i18n.global.locale.value = originalLocale
  })

  const popover = sliceBetween('<!-- Backend supervisor popover -->', '<!-- Announcements centre popover -->')
  const pipelinePill = sliceBetween('class="sb-item sb-pipeline"', '</span>')

  it('the backend popover has no English literals left', () => {
    expect(popover).not.toBe('')
    expect(popover).not.toContain('>Backend<')
    expect(popover).not.toContain("'working…'")
    expect(popover).not.toContain("'Restart'")
    expect(popover).not.toContain("'Start'")
    expect(popover).not.toContain('>Stop<')
    expect(popover).not.toContain('{{ backend.status.value }}')
    expect(popover).toContain("$t('label.backend-state-' + backend.status.value)")
  })

  it('the pipeline pill has no English literals left', () => {
    expect(pipelinePill).not.toBe('')
    expect(pipelinePill).not.toContain('`Stage ')
    expect(pipelinePill).toContain("$t('label.pipeline-pill-stage'")
    expect(pipelinePill).toContain("$t('label.pipeline-pill-' + pipeline.state)")
  })

  // key → [en-US, zh-TW, ja-JP]
  const KEYS: Array<[string, string, string, string]> = [
    ['label.backend-popover-title', 'Backend', '後端', 'バックエンド'],
    ['label.backend-state-starting', 'starting', '啟動中', '起動中'],
    ['label.backend-state-connecting', 'connecting', '連線中', '接続中'],
    ['label.backend-state-connected', 'connected', '已連線', '接続済み'],
    ['label.backend-state-disconnected', 'disconnected', '已斷線', '未接続'],
    ['label.backend-state-error', 'error', '錯誤', 'エラー'],
    ['label.backend-working', 'working…', '處理中…', '処理中…'],
    ['label.backend-restart', 'Restart', '重新啟動', '再起動'],
    ['label.backend-start', 'Start', '啟動', '起動'],
    ['label.backend-stop', 'Stop', '停止', '停止'],
    ['label.pipeline-pill-completed', 'completed', '已完成', '完了'],
    ['label.pipeline-pill-aborted', 'aborted', '已中止', '中止'],
  ]

  it.each(KEYS)('%s resolves per locale', (key, en, zh, ja) => {
    expect(tIn('en-US', key)).toBe(en)
    expect(tIn('zh-TW', key)).toBe(zh)
    expect(tIn('ja-JP', key)).toBe(ja)
  })

  it('label.pipeline-pill-stage interpolates per locale', () => {
    const named = { current: 2, total: 5 }
    expect(tIn('en-US', 'label.pipeline-pill-stage', named)).toBe('Stage 2 / 5')
    expect(tIn('zh-TW', 'label.pipeline-pill-stage', named)).toBe('階段 2 / 5')
    expect(tIn('ja-JP', 'label.pipeline-pill-stage', named)).toBe('ステージ 2 / 5')
  })
})
