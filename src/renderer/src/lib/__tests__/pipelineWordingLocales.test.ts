import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Pipeline wording that drifted from docs/en-US/glossary.md or from what
// Navide does now, checked in every locale file.
const dir = resolve(process.cwd(), 'packages/plugin-ui/src/foundation/i18n/locales')
const locales = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(resolve(dir, f), 'utf8'))])
) as Record<string, Record<string, Record<string, unknown>>>

const at = (code: string, path: string): string =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], locales[code]) as string

const PANE_STRINGS = [
  'action.clear-pipeline',
  'pipelineEditor.recover.resume-desc',
  'pipelineEditor.recover.restart-desc',
  'pipelineEditor.recover.reset-desc',
  'pipelineEditor.run.abort-message',
]

describe('pipeline wording in every locale', () => {
  it('names the Pipeline Manager the same way on its button and its window in zh-TW and zh-CN', () => {
    for (const code of ['zh-TW', 'zh-CN']) {
      expect(at(code, 'action.manage-pipelines')).toBe(at(code, 'label.pipeline-manager'))
    }
  })

  it('calls a pane what the glossary calls it, never a panel word', () => {
    const banned: Record<string, RegExp> = {
      'zh-TW': /窗格|面板/,
      'zh-CN': /窗格|面板/,
      'ko-KR': /패널/,
      'es-ES': /panel/i,
      'fr-FR': /panneau/i,
      'pt-BR': /painel|painéis/i,
      'de-DE': /\bPanes?\b/,
    }
    for (const [code, re] of Object.entries(banned)) {
      for (const key of PANE_STRINGS) expect(`${code} ${key}: ${at(code, key)}`).not.toMatch(re)
    }
  })

  it('points an n8n schedule trigger at a scheduled pipeline run instead of saying Navide cannot schedule', () => {
    for (const code of Object.keys(locales)) {
      const s = at(code, 'pipelineImport.detail.role-trigger-schedule')
      expect(s, code).toContain(at(code, 'scheduler.editor.action-pipeline'))
      expect(s, code).toContain(at(code, 'label.tasker'))
    }
  })
})
