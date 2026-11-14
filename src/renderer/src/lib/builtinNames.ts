import { i18n } from '@navide/plugin-ui/foundation'

// Builtin pipelines and the default roles' descriptions are stored with their
// seed text (backend/agent_team_backend/stages_store.py, roles_store.py). The stored
// rows stay as they are; for display, a row that still carries its seed text
// is shown in the UI language by its builtin id. Once the user renames it,
// what they typed is shown instead.

const PIPELINE_SEED_NAMES: Record<string, string> = {
  default: '預設流程',
  maintenance: '維護流程',
  'evolve-landing': '提案落地流程',
}

const ROLE_SEED_ONE_LINES: Record<string, string> = {
  pm: 'PRD、user stories、UAT、KPI、優先序',
  backend: 'API、資料庫、業務邏輯、安全性',
  frontend: 'Component / 狀態管理 / RWD / 效能',
  mobile: 'iOS / Android / 跨平台 / 離線優先',
  qa: 'E2E、Edge cases、自動化測試矩陣',
}

export function pipelineDisplayName(p: { id: string; name: string; builtin?: boolean }): string {
  if (p.builtin && PIPELINE_SEED_NAMES[p.id] === p.name) {
    return i18n.global.t(`pipelineEditor.builtin.pipeline.${p.id}`)
  }
  return p.name
}

/** A role's one-line description as shown; role labels are shown as stored. */
export function roleDisplayOneLine(r: { key: string; one_line: string; is_default?: boolean }): string {
  return r.is_default && ROLE_SEED_ONE_LINES[r.key] === r.one_line
    ? i18n.global.t(`pipelineEditor.builtin.role.${r.key}`)
    : r.one_line
}
