import { describe, expect, it } from 'vitest'
import { localizeBuiltinText } from '../builtinPipelineText'
import table from '../builtinPipelineText.json'

// The builtin pipelines' stage text is stored as its Chinese seed. It is shown
// and sent in English under a non-Chinese UI while it still equals the seed;
// anything the user typed is left alone. backend/tests/
// test_builtin_pipeline_text_sync.py keeps the table in step with the seeds.
const seedKickoff = Object.keys(table).find((k) => k.startsWith('[Stage 01 · Requirement Analysis]'))!

describe('localizeBuiltinText', () => {
  it('gives English for a seed kickoff and a maintenance title under en-US', () => {
    const out = localizeBuiltinText(seedKickoff, 'en-US')
    expect(out.startsWith('[Stage 01 · Requirement Analysis]\nTask: {{task}}\n')).toBe(true)
    expect(out.endsWith('---SPEC-DONE--- on the last line.')).toBe(true)
    expect(localizeBuiltinText('M01 重現 & 定位', 'en-US')).toBe('M01 Reproduce & Locate')
    expect(localizeBuiltinText('定位', 'ja-JP')).toBe('Locate')
  })

  it('keeps the stored Chinese under a Chinese UI', () => {
    expect(localizeBuiltinText(seedKickoff, 'zh-TW')).toBe(seedKickoff)
    expect(localizeBuiltinText('M01 重現 & 定位', 'zh-CN')).toBe('M01 重現 & 定位')
  })

  it('returns an edited or custom string unchanged', () => {
    expect(localizeBuiltinText(`${seedKickoff}\n多一行`, 'en-US')).toBe(`${seedKickoff}\n多一行`)
    expect(localizeBuiltinText('M01 重現', 'en-US')).toBe('M01 重現')
    expect(localizeBuiltinText('', 'en-US')).toBe('')
  })
})
