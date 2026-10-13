import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backendErrorText } from '../pipelineErrors'

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
