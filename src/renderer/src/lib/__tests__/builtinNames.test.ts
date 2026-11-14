import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pipelineDisplayName, roleDisplayOneLine } from '../builtinNames'

// Builtin pipeline names and default role descriptions are stored with their
// Chinese seed text; the UI shows them in its language by builtin id, and
// shows whatever the user typed once they changed one.
describe('builtinNames', () => {
  afterEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  it('translates the three builtin pipelines by id while they keep the seed name', () => {
    i18n.global.locale.value = 'en-US'
    expect(pipelineDisplayName({ id: 'default', name: '預設流程', builtin: true })).toBe('Default Pipeline')
    expect(pipelineDisplayName({ id: 'maintenance', name: '維護流程', builtin: true })).toBe('Maintenance Pipeline')
    expect(pipelineDisplayName({ id: 'evolve-landing', name: '提案落地流程', builtin: true })).toBe('Proposal Landing Pipeline')
    i18n.global.locale.value = 'ja-JP'
    expect(pipelineDisplayName({ id: 'default', name: '預設流程', builtin: true })).toBe(i18n.global.t('pipelineEditor.builtin.pipeline.default'))
  })

  it('keeps a renamed builtin, and any custom pipeline, exactly as stored', () => {
    expect(pipelineDisplayName({ id: 'default', name: 'Ship it', builtin: true })).toBe('Ship it')
    expect(pipelineDisplayName({ id: 'default', name: '預設流程', builtin: false })).toBe('預設流程')
    expect(pipelineDisplayName({ id: 'p1', name: 'Custom', builtin: false })).toBe('Custom')
  })

  it('translates a default role description only while it keeps the seed text', () => {
    i18n.global.locale.value = 'en-US'
    const pm = { key: 'pm', one_line: 'PRD、user stories、UAT、KPI、優先序', is_default: true }
    expect(roleDisplayOneLine(pm)).toBe('PRD, user stories, UAT, KPIs, priorities')
    expect(roleDisplayOneLine({ ...pm, one_line: 'my own words' })).toBe('my own words')
    expect(roleDisplayOneLine({ ...pm, is_default: false })).toBe(pm.one_line)
  })

  it('knows the same seed text the backend stores', () => {
    const stages = readFileSync(resolve(process.cwd(), 'backend/agent_team_backend/stages_store.py'), 'utf8')
    const roles = readFileSync(resolve(process.cwd(), 'backend/agent_team_backend/roles_store.py'), 'utf8')
    for (const name of ['預設流程', '維護流程', '提案落地流程']) expect(stages).toContain(`"${name}"`)
    for (const line of ['PRD、user stories、UAT、KPI、優先序', 'API、資料庫、業務邏輯、安全性', 'Component / 狀態管理 / RWD / 效能', 'iOS / Android / 跨平台 / 離線優先', 'E2E、Edge cases、自動化測試矩陣']) {
      expect(roles).toContain(`"one_line": "${line}"`)
    }
  })

})
