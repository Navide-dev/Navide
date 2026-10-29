import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  backendErrorText,
  detailsAction,
  GRAPH_PROBLEM_MESSAGE_KEYS,
  graphProblemText,
  REFUSAL_REASONS,
  RUN_ERROR_CODES,
  runErrorText,
  START_REFUSAL_CODES,
  startRefusalText,
} from '../pipelineErrors'

const LOCALES = ['en-US', 'zh-TW', 'ja-JP']
const t = (key: string) => `t:${key}`

describe('backendErrorText', () => {
  it('translates an unknown pipeline instead of showing the backend sentence', () => {
    const text = backendErrorText(t, { code: 'PIPELINE_NOT_FOUND', message: 'pipeline not found: x' }, 'fallback')
    expect(text).toBe('t:pipelineEditor.error.pipeline-not-found')
  })

  it('has the not-found message in every locale', () => {
    for (const locale of LOCALES) {
      const raw = readFileSync(resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${locale}.json`), 'utf8')
      expect(JSON.parse(raw).pipelineEditor.error['pipeline-not-found'], locale).toBeTruthy()
    }
  })
})

// ── Pipeline UX PR-B: every refusal says why, in the UI language ──────────────
const ALL_LOCALES = ['en-US', 'zh-TW', 'zh-CN', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR', 'ru-RU', 'vi-VN']
function lookup(locale: string, key: string): unknown {
  const raw = readFileSync(resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${locale}.json`), 'utf8')
  return key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], JSON.parse(raw))
}
const tp = (key: string, p?: Record<string, unknown>) => `t:${key}${p && Object.keys(p).length ? ` ${JSON.stringify(p)}` : ''}`

describe('store refusals (B1)', () => {
  it('a missing stage and each refusal reason get their own message', () => {
    expect(backendErrorText(t, { code: 'STAGE_NOT_FOUND', message: 'stage not found: s9' }, 'f')).toBe('t:pipelineErrors.stage-not-found')
    expect(backendErrorText(t, { code: 'PIPELINE_REFUSED', message: 'cannot delete the last remaining pipeline', details: { reason: 'last-pipeline' } }, 'f'))
      .toBe('t:pipelineErrors.refused.last-pipeline')
  })

  it('a refusal with a reason it does not know keeps the backend sentence', () => {
    expect(backendErrorText(t, { code: 'PIPELINE_REFUSED', message: 'something new', details: { reason: 'brand-new' } }, 'f')).toBe('something new')
  })
})

describe('run commands and start refusals (B2)', () => {
  it('a coded command refusal is translated, with the gate named by its label', () => {
    const text = runErrorText(tp, { code: 'gate-waiting', params: { gate: 'g-3' } }, (id) => (id === 'g-3' ? 'Design OK?' : id))
    expect(text).toBe('t:pipelineErrors.run.gate-waiting {"gate":"Design OK?"}')
  })

  it('a start that did not happen says the start refusal, not a generic line', () => {
    expect(runErrorText(tp, { code: 'not-started', params: { reason: 'spawn-failed' } })).toBe('t:pipelineErrors.start.spawn-failed {"reason":"spawn-failed"}')
    expect(runErrorText(tp, { code: 'not-started' })).toBe('t:pipelineErrors.run.not-started')
  })

  it('no code (an older handler) falls back to the generic line, never the developer sentence', () => {
    expect(runErrorText(tp, {})).toBe('t:pipelineEditor.error.command-failed')
  })

  it('a start refusal with an unknown code is left to the caller', () => {
    expect(startRefusalText(tp, { code: 'no-stages' as never })).toBe('t:pipelineErrors.start.no-stages')
    expect(startRefusalText(tp, null)).toBe('')
  })
})

describe('graph problems (B3)', () => {
  it('names the step by its label', () => {
    expect(graphProblemText(tp, { code: 'slot-incomplete', label: 'Writer' })).toBe('t:pipelineErrors.graph.slot-incomplete {"label":"Writer"}')
    expect(graphProblemText(tp, { code: 'cycle' })).toBe('t:pipelineEditor.error.cycle {"label":""}')
  })

  it('an uncoded problem is "would break the pipeline", never the English sentence', () => {
    expect(graphProblemText(tp, { code: 'node-no-id' })).toBe('t:pipelineErrors.graph.other')
    expect(graphProblemText(tp, { code: 'no-position', label: 'Writer' })).toBe('t:pipelineErrors.graph.other-at {"label":"Writer"}')
  })
})

describe('every message key exists in all 11 locales', () => {
  const keys = [
    'pipelineErrors.details',
    'pipelineErrors.stage-not-found',
    ...REFUSAL_REASONS.map((r) => `pipelineErrors.refused.${r}`),
    ...RUN_ERROR_CODES.map((c) => `pipelineErrors.run.${c}`),
    ...START_REFUSAL_CODES.map((c) => `pipelineErrors.start.${c}`),
    ...GRAPH_PROBLEM_MESSAGE_KEYS,
    ...['confirm-title', 'confirm-no-edge', 'confirm-exhausted', 'confirm-button', 'rejected-failed', 'ends-run-hint'].map((k) => `pipelineErrors.gate.${k}`),
  ]
  for (const locale of ALL_LOCALES) {
    it(locale, () => {
      const missing = keys.filter((k) => typeof lookup(locale, k) !== 'string' || !lookup(locale, k))
      expect(missing).toEqual([])
    })
  }
})

describe('detailsAction', () => {
  it('opens the English sentence; nothing to show means no button', () => {
    const alert = vi.fn()
    const action = detailsAction(t, { alert }, 'ui.pipeline.next: …')
    action?.run()
    expect(action?.label).toBe('t:pipelineErrors.details')
    expect(alert).toHaveBeenCalledWith('ui.pipeline.next: …', { title: 't:pipelineErrors.details' })
    expect(detailsAction(t, { alert }, '')).toBeUndefined()
  })
})
