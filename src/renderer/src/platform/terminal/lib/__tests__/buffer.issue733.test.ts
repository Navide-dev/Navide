import { describe, it, expect } from 'vitest'
import { findConsecutiveQuestionBlocks } from '../buffer'
import { INTERACTION_PROTOCOL, PROTOCOL_EXAMPLE_PROMPTS } from '../../../../data/stages'

// Issue #733: a Codex slot in an allow_questions stage. Codex does not collapse
// the kickoff into "[Pasted text +N lines]" the way Claude does, so the echoed
// INTERACTION_PROTOCOL (with its two literal QUESTION examples) lands in the
// buffer after the watcher's scanFrom, ahead of the agent's real block.

// The kickoff as the Codex TUI echoes it: "› " on the first line, two-space
// indent on the rest.
function codexEcho(text: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? '› ' + l : '  ' + l))
    .join('\n')
}

const kickoff = INTERACTION_PROTOCOL + '你是 story-tts 的 prep。請先問使用者要哪種聲音模式。\n'

// The agent's real block as the Codex TUI renders it (markdown re-flow): "• "
// before START, list dashes dropped, END indented under the last option.
const codexRenderedAnswer = [
  '• ---QUESTION-START---',
  '  type: choice',
  '  prompt: 已確認輸入檔 ~/下載/story.txt。請選擇聲音模式，後續會列出聲音清單供你指定。',
  '  options:',
  '',
  '      1. 單一旁白（推薦，適合 dry run 測試）',
  '',
  '      2. 旁白 + 角色多聲音',
  '         ---QUESTION-END---',
  ''
].join('\n')

const expected = {
  prompt: '已確認輸入檔 ~/下載/story.txt。請選擇聲音模式，後續會列出聲音清單供你指定。',
  options: ['單一旁白（推薦，適合 dry run 測試）', '旁白 + 角色多聲音']
}

describe('issue #733 — Codex QUESTION parse with kickoff echo in the scan window', () => {
  it('control: the Codex-rendered block alone parses correctly', () => {
    const blocks = findConsecutiveQuestionBlocks(codexRenderedAnswer, 0)
    expect(blocks.map((b) => ({ prompt: b.prompt, options: b.options }))).toEqual([expected])
  })

  it('kickoff echo intact: surfaces only the agent question, not the protocol examples', () => {
    const buf = codexEcho(kickoff) + '\n\n' + codexRenderedAnswer
    const blocks = findConsecutiveQuestionBlocks(buf, 0, undefined, PROTOCOL_EXAMPLE_PROMPTS)
    expect(blocks.map((b) => ({ prompt: b.prompt, options: b.options }))).toEqual([expected])
  })

  it('kickoff echo with a redraw-damaged example END: surfaces only the agent question', () => {
    // The reporter's dialog shows "--QUESTION-END---" (one dash lost) at the
    // tail of the choice example: a repaint mangled that marker, so it no
    // longer pairs with the example's START.
    const damaged = codexEcho(kickoff).replace(
      /(SQLite\n\s*)---QUESTION-END---/,
      '$1--QUESTION-END---'
    )
    const buf = damaged + '\n\n' + codexRenderedAnswer
    const blocks = findConsecutiveQuestionBlocks(buf, 0, undefined, PROTOCOL_EXAMPLE_PROMPTS)
    expect(blocks.map((b) => ({ prompt: b.prompt, options: b.options }))).toEqual([expected])
  })

  it('every skipped prompt is a real prompt line of the protocol examples', () => {
    for (const p of PROTOCOL_EXAMPLE_PROMPTS) {
      expect(INTERACTION_PROTOCOL).toContain(`\nprompt: ${p}\n`)
    }
  })

  it('a damaged END no longer lets an orphan START swallow the next block', () => {
    const buf = [
      '---QUESTION-START---',
      'type: text',
      'prompt: orphan',
      '--QUESTION-END---',
      'narration',
      '---QUESTION-START---',
      'type: text',
      'prompt: 真正的問題？',
      '---QUESTION-END---'
    ].join('\n')
    expect(findConsecutiveQuestionBlocks(buf, 0).map((b) => b.prompt)).toEqual(['真正的問題？'])
  })
})

describe('consecutive QUESTION blocks still parse after the #733 changes', () => {
  const twoBlocks = [
    '---QUESTION-START---',
    'type: text',
    'prompt: 專案名稱是什麼？',
    '---QUESTION-END---',
    '',
    '---QUESTION-START---',
    'type: choice',
    'prompt: 要部署到哪裡？',
    'options:',
    '  - AWS',
    '  - GCP',
    '---QUESTION-END---'
  ].join('\n')

  it('returns both blocks in order', () => {
    const blocks = findConsecutiveQuestionBlocks(twoBlocks, 0, undefined, PROTOCOL_EXAMPLE_PROMPTS)
    expect(blocks.map((b) => ({ prompt: b.prompt, type: b.type, options: b.options }))).toEqual([
      { prompt: '專案名稱是什麼？', type: 'text', options: [] },
      { prompt: '要部署到哪裡？', type: 'choice', options: ['AWS', 'GCP'] }
    ])
  })

  it('returns both blocks after a skipped protocol example without breaking the gap check', () => {
    const buf = codexEcho(kickoff) + '\n\n' + twoBlocks
    const blocks = findConsecutiveQuestionBlocks(buf, 0, undefined, PROTOCOL_EXAMPLE_PROMPTS)
    expect(blocks.map((b) => b.prompt)).toEqual(['專案名稱是什麼？', '要部署到哪裡？'])
  })

  it('still splits a block too far from the previous one into the next round', () => {
    const buf = twoBlocks.replace('\n\n---QUESTION-START---', '\n' + 'x'.repeat(700) + '\n---QUESTION-START---')
    expect(findConsecutiveQuestionBlocks(buf, 0).map((b) => b.prompt)).toEqual(['專案名稱是什麼？'])
  })
})
