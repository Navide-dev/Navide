// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  WELCOME_RECORD_TRIES,
  WELCOME_STEPS,
  decideFirstInstall,
  isFirstInstall,
  nextWelcomeTourMove,
  welcomeActionAlreadyDone,
  welcomeActionDone,
  type WelcomeFacts,
} from '../welcomeTour'

const LOCALES = ['en-US', 'zh-TW', 'ja-JP'].map((code) => ({
  code,
  messages: JSON.parse(
    readFileSync(
      resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${code}.json`),
      'utf8',
    ),
  ) as Record<string, unknown>,
}))

function lookup(messages: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    messages,
  )
}

function leafKeys(node: unknown, prefix: string): string[] {
  if (!node || typeof node !== 'object') return [prefix]
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leafKeys(v, `${prefix}.${k}`))
}

const source = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8')

const none: WelcomeFacts = {
  workspaceOpen: false,
  agentPanes: 0,
  commandAt: 0,
  everCommanded: false,
  mentionAt: 0,
  dropAt: 0,
  usageAt: 0,
}

// The bubble-by-bubble path: pick a workspace → open an agent → give it a
// first instruction → have two agents work together → see the quota.
describe('welcome tour steps', () => {
  it('is six bubbles, each waiting for one action', () => {
    expect(WELCOME_STEPS.map((s) => [s.id, s.waitFor])).toEqual([
      ['pick-folder', 'workspace-open'],
      ['open-agent', 'agent-pane'],
      ['first-command', 'first-command'],
      ['talk-mention', 'mention'],
      ['talk-drag', 'drop'],
      ['usage-account', 'usage'],
    ])
  })

  it('keeps usable what each control opens, under the mask', () => {
    const allow = Object.fromEntries(WELCOME_STEPS.map((s) => [s.id, s.allow ?? []]))
    expect(allow).toEqual({
      'pick-folder': [],
      'open-agent': ['.ws-add-menu'],
      'first-command': [],
      'talk-mention': ['.ws-add-menu', '.term-mention-card'],
      'talk-drag': [],
      'usage-account': ['.usage-pop'],
    })
    expect(source('src/renderer/src/components/ControlPane.vue')).toContain('class="ws-add-menu"')
    expect(source('packages/plugin-ui/src/terminalMentionMenu.ts')).toContain("card.className = 'term-mention-card'")
    expect(source('src/renderer/src/components/UsageBadge.vue')).toContain('class="usage-pop"')
  })

  // 09:54: "why did the account and quota check never show?" The quota step
  // was passed over when the badge was not there yet — on a fresh install it
  // is not, until the CLI's usage is read — and as the last step that ended
  // the tour without a word. No step is passed over any more: the quota
  // bubble falls back to the pane's title bar, where the badge will appear,
  // with a line saying so.
  it('never passes over a step; the quota bubble falls back to where the badge will appear', () => {
    for (const step of WELCOME_STEPS) expect('skipIfMissing' in step, step.id).toBe(false)
    expect(WELCOME_STEPS.find((s) => s.id === 'usage-account')!.fallback).toEqual({
      anchor: '[data-tour="pane-header"]',
      textKey: 'tour.welcome.usageAccountMissing',
    })
    expect(WELCOME_STEPS.filter((s) => s.fallback).map((s) => s.id)).toEqual(['usage-account'])
  })

  it('points the @ bubble at + until there is a second pane, then at the terminal', () => {
    const mention = WELCOME_STEPS.find((s) => s.id === 'talk-mention')!
    expect(mention.anchor({ ...none, agentPanes: 1 })).toBe('[data-tour="open-agent"]')
    expect(mention.anchor({ ...none, agentPanes: 2 })).toBe('.xterm-host[data-pane-id]')
  })

  it('spotlights the whole pane stage for the drag, where it starts and ends', () => {
    expect(WELCOME_STEPS.find((s) => s.id === 'talk-drag')!.anchor(none)).toBe('[data-tour="pane-stage"]')
  })

  it('keeps every line under tour.welcome, the same keys in every locale, none left over', () => {
    const used = [
      ...WELCOME_STEPS.map((s) => s.textKey),
      'tour.welcome.next',
      'tour.welcome.doneFeedback',
      'tour.welcome.finished',
      'tour.welcome.missing',
      'tour.welcome.usageAccountMissing',
    ].sort()
    for (const { code, messages } of LOCALES) {
      expect(leafKeys(lookup(messages, 'tour.welcome'), 'tour.welcome').sort(), code).toEqual(used)
      for (const key of used) {
        const value = lookup(messages, key)
        expect(typeof value, `${code} ${key}`).toBe('string')
        expect((value as string).trim(), `${code} ${key}`).not.toBe('')
        // ⌘ is the Win/Super key off macOS: never name it.
        expect(value as string, `${code} ${key}`).not.toMatch(/[⌘⇧⌥]/)
      }
    }
  })

  it('points only at data-tour anchors the components render, and leaves none behind', () => {
    const where: Record<string, string> = {
      'welcome-open-buttons': 'src/renderer/src/components/Welcome.vue',
      'open-agent': 'src/renderer/src/components/ControlPane.vue',
      'pane-stage': 'src/renderer/src/App.vue',
      'usage-badge': 'src/renderer/src/components/TerminalPane.vue',
      'pane-header': 'src/renderer/src/components/TerminalPane.vue',
    }
    const facts = [none, { ...none, agentPanes: 2 }]
    const used = new Set<string>()
    for (const step of WELCOME_STEPS) {
      for (const f of facts) {
        const selector = step.anchor(f)
        expect(() => document.querySelectorAll(selector), step.id).not.toThrow()
        for (const [, name] of selector.matchAll(/\[data-tour="([^"]+)"\]/g)) used.add(name)
      }
      for (const [, name] of (step.fallback?.anchor ?? '').matchAll(/\[data-tour="([^"]+)"\]/g)) used.add(name)
    }
    expect([...used].sort()).toEqual(Object.keys(where).sort())
    for (const name of used) expect(source(where[name]), name).toContain(`data-tour="${name}"`)
    for (const file of new Set(Object.values(where))) {
      for (const [, name] of source(file).matchAll(/data-tour="([^"]+)"/g)) {
        expect(used.has(name), `${file}: data-tour="${name}"`).toBe(true)
      }
    }
  })
})

describe('welcomeActionDone / welcomeActionAlreadyDone', () => {
  const since = 1_000

  it('a workspace being open is both done and already done', () => {
    expect(welcomeActionDone('workspace-open', { ...none, workspaceOpen: true }, since)).toBe(true)
    expect(welcomeActionAlreadyDone('workspace-open', { ...none, workspaceOpen: true })).toBe(true)
    expect(welcomeActionDone('workspace-open', none, since)).toBe(false)
  })

  it('counts an agent pane', () => {
    expect(welcomeActionDone('agent-pane', { ...none, agentPanes: 1 }, since)).toBe(true)
    expect(welcomeActionAlreadyDone('agent-pane', { ...none, agentPanes: 1 })).toBe(true)
  })

  it('takes a first command only once it was typed after the bubble came up', () => {
    expect(welcomeActionDone('first-command', { ...none, commandAt: since - 1 }, since)).toBe(false)
    expect(welcomeActionDone('first-command', { ...none, commandAt: since + 1 }, since)).toBe(true)
    expect(welcomeActionAlreadyDone('first-command', { ...none, everCommanded: true })).toBe(true)
  })

  it('takes @, a drop and the quota badge only when they happen while the bubble is up', () => {
    for (const [action, field] of [['mention', 'mentionAt'], ['drop', 'dropAt'], ['usage', 'usageAt']] as const) {
      expect(welcomeActionDone(action, { ...none, [field]: since - 1 }, since), action).toBe(false)
      expect(welcomeActionDone(action, { ...none, [field]: since + 1 }, since), action).toBe(true)
      // Everyone should try these once: never passed over as already done.
      expect(welcomeActionAlreadyDone(action, { ...none, [field]: since + 1 }), action).toBe(false)
    }
  })
})

// 21:59 and 23:01: the tour never got going. The first-install check waited —
// first behind the CLI health guide, then on a recent-list answer slow at
// launch — and a folder the person picked meanwhile was read as a record
// against them. The check now judges the window as it was when it began.
describe('isFirstInstall', () => {
  const at = Date.parse('2026-10-05T15:00:40Z')
  const opened = (iso: string) => ({ last_opened_at: iso })

  it('is a first install with no workspace open and no older record', () => {
    expect(isFirstInstall({ workspaceOpenAtStart: false, recents: [], checkStartedAt: at })).toBe(true)
  })

  it('does not count a folder opened after the check began', () => {
    expect(
      isFirstInstall({ workspaceOpenAtStart: false, recents: [opened('2026-10-05T15:00:52Z')], checkStartedAt: at }),
    ).toBe(true)
  })

  it('is not one with a workspace open as it began, or an older record', () => {
    expect(isFirstInstall({ workspaceOpenAtStart: true, recents: [], checkStartedAt: at })).toBe(false)
    expect(
      isFirstInstall({ workspaceOpenAtStart: false, recents: [opened('2026-10-05T14:00:00Z')], checkStartedAt: at }),
    ).toBe(false)
  })

  it('counts a record it cannot date against the person, to be safe', () => {
    expect(isFirstInstall({ workspaceOpenAtStart: false, recents: [{}], checkStartedAt: at })).toBe(false)
    expect(
      isFirstInstall({ workspaceOpenAtStart: false, recents: [opened('yesterday')], checkStartedAt: at }),
    ).toBe(false)
  })
})

describe('nextWelcomeTourMove', () => {
  const base = {
    pending: true,
    active: false,
    settled: true,
    owned: true,
    eligible: false,
    decision: 'unchecked' as const,
    blocked: false,
  }

  // M14: each main window ran its own tour off the shared settings. Only the
  // window that owns the tour judges, starts or runs it.
  it('leaves the tour to the window that owns it, and lets go of one it lost', () => {
    expect(nextWelcomeTourMove({ ...base, owned: false })).toBe('wait')
    expect(nextWelcomeTourMove({ ...base, owned: false, eligible: true })).toBe('wait')
    expect(nextWelcomeTourMove({ ...base, owned: false, active: true })).toBe('release')
    // Nothing pending any more (another window ended it): stop, whoever owned it.
    expect(nextWelcomeTourMove({ ...base, owned: false, pending: false })).toBe('stop')
  })

  it('stops once nothing is pending, and waits while running or unsettled', () => {
    expect(nextWelcomeTourMove({ ...base, pending: false })).toBe('stop')
    expect(nextWelcomeTourMove({ ...base, active: true })).toBe('wait')
    expect(nextWelcomeTourMove({ ...base, settled: false })).toBe('wait')
  })

  it('starts the first-install check before anything on screen can hold it up, and waits for it', () => {
    expect(nextWelcomeTourMove({ ...base, blocked: true })).toBe('check')
    expect(nextWelcomeTourMove({ ...base, decision: 'checking' })).toBe('wait')
  })

  it('keeps the answer: eligible, or the tour called off', () => {
    expect(nextWelcomeTourMove({ ...base, blocked: true, decision: 'first-install' })).toBe('mark-eligible')
    expect(nextWelcomeTourMove({ ...base, decision: 'not-first-install' })).toBe('cancel')
    // L2: a check that gave up stops this session's poll without cancelling.
    expect(nextWelcomeTourMove({ ...base, decision: 'gave-up' })).toBe('stop')
    expect(nextWelcomeTourMove({ ...base, eligible: true, decision: 'gave-up' })).toBe('start')
  })

  it('once eligible, only waits for a clear screen — nothing opened since counts against it', () => {
    expect(nextWelcomeTourMove({ ...base, eligible: true, blocked: true })).toBe('wait')
    expect(nextWelcomeTourMove({ ...base, eligible: true, decision: 'not-first-install' })).toBe('start')
  })
})

// 22:41: the tour broke at the @ bubble. vue-i18n reads a bare "@" as a linked
// message and throws while compiling it, which stopped CoachMark rendering —
// a key check alone never compiles the text. Render every line for real.
describe('welcome tour text, compiled by vue-i18n', () => {
  it('renders every line in every locale, with an @ where it talks about @', async () => {
    const { i18n } = await import('@navide/plugin-ui/foundation')
    const keys = [
      ...WELCOME_STEPS.map((s) => s.textKey),
      'tour.welcome.next',
      'tour.welcome.doneFeedback',
      'tour.welcome.finished',
      'tour.welcome.missing',
      'tour.welcome.usageAccountMissing',
    ]
    for (const code of ['en-US', 'zh-TW', 'ja-JP']) {
      i18n.global.locale.value = code as typeof i18n.global.locale.value
      for (const key of keys) {
        let text = ''
        expect(() => {
          text = i18n.global.t(key)
        }, `${code} ${key}`).not.toThrow()
        expect(text, `${code} ${key}`).not.toBe(key)
        expect(text, `${code} ${key}`).not.toContain("{'")
      }
      expect(i18n.global.t('tour.welcome.talkMention'), code).toContain('@')
    }
  })
})

// M13: one failed or timed-out recent-list request called the tour off for
// good. Failures now retry with a growing wait; only when every try fails is
// it given up on, and that is logged.
describe('decideFirstInstall', () => {
  const at = Date.parse('2026-10-05T15:00:40Z')
  function run(answers: Array<{ ok: boolean; recent?: { last_opened_at?: string }[] } | Error>) {
    const waits: number[] = []
    const warnings: string[] = []
    let calls = 0
    const result = decideFirstInstall({
      workspaceOpenAtStart: false,
      checkStartedAt: at,
      fetchRecents: async () => {
        const a = answers[Math.min(calls++, answers.length - 1)]
        if (a instanceof Error) throw a
        return a
      },
      sleep: async (ms) => {
        waits.push(ms)
      },
      warn: (m) => warnings.push(m),
    })
    return { result, waits, warnings, calls: () => calls }
  }

  it('answers from the first good reply', async () => {
    const r = run([{ ok: true, recent: [] }])
    expect(await r.result).toBe('first-install')
    expect(r.calls()).toBe(1)
    expect(r.waits).toEqual([])
  })

  it('retries a failed or thrown reply with a growing wait, then answers', async () => {
    const r = run([{ ok: false }, new Error('timeout'), { ok: true, recent: [{ last_opened_at: '2026-10-05T14:00:00Z' }] }])
    expect(await r.result).toBe('not-first-install')
    expect(r.calls()).toBe(3)
    expect(r.waits).toHaveLength(2)
    expect(r.waits[1]).toBeGreaterThan(r.waits[0])
    expect(r.warnings).toEqual([])
  })

  // L2: giving up is not an answer — the tour stays due and the next launch
  // asks again, rather than calling it off for good.
  it('gives up, logging it, only after every try failed, leaving the question open', async () => {
    const r = run([new Error('timeout')])
    expect(await r.result).toBe('unchecked')
    expect(r.calls()).toBe(WELCOME_RECORD_TRIES)
    expect(r.warnings).toHaveLength(1)
  })

  it('judges by the window as the first try began, however late the answer', async () => {
    const r = run([{ ok: false }, { ok: true, recent: [{ last_opened_at: '2026-10-05T15:00:52Z' }] }])
    expect(await r.result).toBe('first-install')
  })
})
