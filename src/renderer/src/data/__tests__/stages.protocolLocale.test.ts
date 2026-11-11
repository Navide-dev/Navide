import { afterEach, describe, it, expect } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import {
  renderSlotKickoff,
  renderManagerProtocol,
  renderWorkerProtocol,
  stageContextText,
  continueNudgeText,
  MESSAGING_PROTOCOL,
  SPAWN_PROTOCOL,
  INTERACTION_PROTOCOL,
  INTERACTION_PROTOCOL_AUTO,
  PROTOCOL_EXAMPLE_PROMPTS,
  type StageSlot
} from '../stages'
import {
  MSG_ENVELOPE_PREFIX,
  MSG_NOTICE_PREFIX,
  MSG_FORMAT_PREFIX,
  MSG_FALLBACK_PREFIX,
  MSG_SPAWN_FAILED_PREFIX,
  MSG_SPAWN_PARTIAL_PREFIX
} from '../../lib/agentMessaging'
import { findConsecutiveQuestionBlocks } from '../../platform/terminal/lib/buffer'

// The protocol preambles Navide puts in front of every pipeline kickoff follow
// the UI language: zh-* keeps the Chinese text byte for byte, every other
// locale gets English. Only the prose changes — every sentinel, block marker,
// field name and notice prefix a parser keys on stays the same.

const CJK = /[　-〿㐀-鿿豈-﫿＀-￯]/
const PREFIXES = [
  MSG_ENVELOPE_PREFIX, MSG_NOTICE_PREFIX, MSG_FORMAT_PREFIX,
  MSG_FALLBACK_PREFIX, MSG_SPAWN_FAILED_PREFIX, MSG_SPAWN_PARTIAL_PREFIX
]

/** Every machine-read token in a Chinese preamble. */
function markers(zh: string): string[] {
  const out = new Set<string>()
  for (const m of zh.matchAll(/---[A-Z]+(?:-[A-Z]+)*---/g)) out.add(m[0])
  for (const m of zh.matchAll(/\[[^\]\n]*\]/g)) if (!CJK.test(m[0])) out.add(m[0])
  for (const m of zh.matchAll(/\b[A-Z][A-Z0-9_-]+\b/g)) out.add(m[0])
  for (const m of zh.matchAll(/(?:^|\s)([a-z_]+):(?=\s|$)/gm)) out.add(`${m[1]}:`)
  for (const p of PREFIXES) if (zh.includes(p)) out.add(p)
  // The header up to its mode suffix: "[Pipeline Control Protocol — ".
  const header = zh.split('\n')[0]
  out.add(header.includes(' — ') ? header.slice(0, header.indexOf(' — ') + 3) : header)
  return [...out]
}

const roster = [
  { label: 'Backend', agentLabel: 'Codex', roleLabel: 'Backend Engineer' },
  { label: 'Frontend', agentLabel: 'Claude', roleLabel: 'Frontend Engineer' }
]

/** Each preamble, rendered in the current UI language. */
function preambles(): Record<string, string> {
  const slot = { agentKey: 'claude', roleKey: 'pm', label: 'PM', kickoffBody: '{{task}}' } as unknown as StageSlot
  const kickoff = (opts: Parameters<typeof renderSlotKickoff>[2]) => renderSlotKickoff(slot, 't', opts)
  const prefixLen = (renderSlotKickoff(slot, 't').indexOf('[Pipeline Control Protocol'))
  const head = renderSlotKickoff(slot, 't').slice(0, prefixLen)
  const split = head.indexOf('[CLI Pane Spawn Protocol]')
  const strip = (s: string) => s.slice(prefixLen, s.length - 't'.length)
  return {
    messaging: head.slice(0, split),
    spawn: head.slice(split),
    interactive: strip(kickoff({ allowQuestions: true })),
    auto: strip(kickoff({})),
    manager: renderManagerProtocol(roster),
    managerSolo: renderManagerProtocol([]),
    worker: renderWorkerProtocol('Lead PM')
  }
}

describe('protocol preambles follow the UI language', () => {
  afterEach(() => { i18n.global.locale.value = 'en-US' })

  it('zh-TW sends the Chinese preambles unchanged', () => {
    i18n.global.locale.value = 'zh-TW'
    const zh = preambles()
    expect(zh.messaging).toBe(MESSAGING_PROTOCOL)
    expect(zh.spawn).toBe(SPAWN_PROTOCOL)
    expect(zh.interactive).toBe(INTERACTION_PROTOCOL)
    expect(zh.auto).toBe(INTERACTION_PROTOCOL_AUTO)
    expect(zh).toMatchSnapshot()
  })

  it('zh-CN sends the same Chinese preambles as zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const tw = preambles()
    i18n.global.locale.value = 'zh-CN'
    expect(preambles()).toEqual(tw)
  })

  for (const locale of ['en-US', 'ja-JP', 'fr-FR'] as const) {
    it(`${locale} sends English preambles with every marker of the Chinese ones`, () => {
      i18n.global.locale.value = 'zh-TW'
      const zh = preambles()
      i18n.global.locale.value = locale
      const en = preambles()
      for (const [name, text] of Object.entries(en)) {
        expect(text, name).not.toMatch(CJK)
        const wanted = markers(zh[name])
        expect(wanted.length, name).toBeGreaterThanOrEqual(2)
        for (const m of wanted) expect(text, `${name}: ${m}`).toContain(m)
      }
      expect(en.messaging).toContain('to: all')
      expect(en.manager).toContain('  - Backend (Codex · Backend Engineer)')
    })
  }

  it('a language switch applies to the next kickoff', () => {
    const slot = { agentKey: 'claude', roleKey: 'pm', label: 'PM', kickoffBody: 'x' } as unknown as StageSlot
    i18n.global.locale.value = 'zh-TW'
    expect(renderSlotKickoff(slot, 't')).toMatch(CJK)
    i18n.global.locale.value = 'en-US'
    expect(renderSlotKickoff(slot, 't')).not.toMatch(CJK)
  })
})

describe('protocol example questions are never surfaced as real questions', () => {
  afterEach(() => { i18n.global.locale.value = 'en-US' })

  const real = '---QUESTION-START---\ntype: text\nprompt: Which port should the server use?\n---QUESTION-END---\n'

  for (const locale of ['zh-TW', 'en-US'] as const) {
    it(`skips the ${locale} examples echoed with the kickoff`, () => {
      i18n.global.locale.value = locale
      const slot = { agentKey: 'codex', roleKey: 'pm', label: 'PM', kickoffBody: 'ask' } as unknown as StageSlot
      const buf = renderSlotKickoff(slot, 't', { allowQuestions: true }) + '\n\n' + real
      const blocks = findConsecutiveQuestionBlocks(buf, 0, undefined, PROTOCOL_EXAMPLE_PROMPTS)
      expect(blocks.map((b) => b.prompt)).toEqual(['Which port should the server use?'])
    })
  }

  it('lists the example prompts of both languages', () => {
    i18n.global.locale.value = 'zh-TW'
    const zh = preambles().interactive
    i18n.global.locale.value = 'en-US'
    const en = preambles().interactive
    const shown = [...zh.matchAll(/\nprompt: (.+)\n/g), ...en.matchAll(/\nprompt: (.+)\n/g)].map((m) => m[1])
    expect([...PROTOCOL_EXAMPLE_PROMPTS].sort()).toEqual(shown.sort())
  })
})

describe('the prior-stage context header follows the UI language', () => {
  afterEach(() => { i18n.global.locale.value = 'en-US' })

  it('keeps the Chinese wording under zh-TW and zh-CN', () => {
    const zh = {
      managerHeader: '[完整前置歷程 — 你是 Manager，負責協調，請逐一完整讀取下列檔案]',
      workerHeader: '[前置階段產出 — 下為摘要，需要細節請讀對應檔案]',
      workerFooter: '（開始前請先讀取與你任務相關的檔案）',
      noLog: '(無 log 檔)',
      noOutput: '(無輸出)',
      summary: '摘要：',
      fullContent: '完整內容：'
    }
    for (const locale of ['zh-TW', 'zh-CN'] as const) {
      i18n.global.locale.value = locale
      expect(stageContextText()).toEqual(zh)
    }
  })

  it('is English under any other locale', () => {
    i18n.global.locale.value = 'en-US'
    const en = stageContextText()
    for (const v of Object.values(en)) expect(v).not.toMatch(CJK)
    expect(en.managerHeader).toContain('Manager')
  })
})

describe('the stall nudge follows the UI language', () => {
  afterEach(() => { i18n.global.locale.value = 'en-US' })

  it('stays 請繼續 under zh-TW and zh-CN and is English otherwise', () => {
    for (const locale of ['zh-TW', 'zh-CN'] as const) {
      i18n.global.locale.value = locale
      expect(continueNudgeText()).toBe('請繼續')
    }
    i18n.global.locale.value = 'en-US'
    expect(continueNudgeText()).toBe('Please continue.')
  })
})
