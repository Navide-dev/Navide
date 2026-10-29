import { describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import { startRefusalText } from '../pipelineErrors'

// PR-E E1: the backend's PIPELINE_ALREADY_RUNNING reaches the Run toast in
// the UI language, through PR-B's start-refusal vocabulary.
describe('startRefusalText – refusals the backend makes', () => {
  it('words already-running and not-recorded in the UI language', () => {
    const t = i18n.global.t as (k: string, p?: Record<string, unknown>) => string
    i18n.global.locale.value = 'zh-TW'
    expect(startRefusalText(t, { code: 'already-running' })).toBe('這個 workspace 已有 pipeline 正在執行，請先中止它。')
    i18n.global.locale.value = 'en-US'
    expect(startRefusalText(t, { code: 'not-recorded' })).toContain('was not recorded')
  })
})
