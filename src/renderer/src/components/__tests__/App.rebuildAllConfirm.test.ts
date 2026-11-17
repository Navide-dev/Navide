// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. They lock in the
// confirmation gate on the batch rebuild buttons (sidebar "rebuild all tabs",
// tab bar "rebuild this tab"), which reprint every conversation.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const enLocale = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/renderer/src/i18n/locales/en-US.json'), 'utf8')
)
const zhLocale = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/renderer/src/i18n/locales/zh-TW.json'), 'utf8')
)

describe('App batch rebuild confirmation', () => {
  it('asks before rebuilding a batch even when no pane is mid-turn', () => {
    expect(appSource).toContain('async function confirmBatchRebuild(count: number): Promise<boolean>')
    expect(appSource).toContain("i18n.global.t('pane.terminal.rebuild-batch-confirm-body', { count })")
    expect(appSource).toContain("title: i18n.global.t('pane.terminal.rebuild-batch-confirm-title')")
  })

  it('routes the batch through one of the two dialogs and aborts on cancel', () => {
    expect(appSource).toContain('const runningCount = countPanesBusyForRebuild(ids)')
    expect(appSource).toContain('forceWhenRunning = await confirmBatchRebuildOverRunning(ids)')
    expect(appSource).toContain('} else if (!(await confirmBatchRebuild(ids.length))) {')
  })

  it('shares the running-pane count helper with the running-pane dialog', () => {
    expect(appSource).toContain('function countPanesBusyForRebuild(ids: string[]): number')
    expect(appSource).toContain('async function confirmBatchRebuildOverRunning(ids: string[]): Promise<boolean> {\n  const runningCount = countPanesBusyForRebuild(ids)')
  })

  it('ships the dialog copy in both locales', () => {
    for (const locale of [enLocale, zhLocale]) {
      expect(locale.pane.terminal['rebuild-batch-confirm-title']).toBeTruthy()
      expect(locale.pane.terminal['rebuild-batch-confirm-body']).toContain('{count}')
    }
  })
})
