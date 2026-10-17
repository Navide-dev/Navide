import { describe, expect, it } from 'vitest'
import {
  loopContinueReady,
  loopInjectFailures,
  turnEndsWithLoopDone,
  turnEndsWithSentinel,
  LOOP_INJECT_FAIL_LIMIT,
  type TurnCompleteState,
} from '../completion'
import { LOOP_DONE_MARKER, LOOP_WAIT_MARKER } from '../loopPrompt'

const SETTLE = 1500
const base = (o: Partial<TurnCompleteState>): TurnCompleteState => ({
  turnCompleteAt: 0, lastActiveAt: 0, armedAt: 0, now: 0, settleMs: SETTLE, ...o,
})

// Markdown decorations of a bare final line: none of these matched on main.
const DECORATED: Array<(s: string) => string> = [
  (s) => `\`${s}\``,
  (s) => `\`\` ${s} \`\``,
  (s) => `*${s}*`,
  (s) => `**${s}**`,
  (s) => `***${s}***`,
  (s) => `_${s}_`,
  (s) => `__${s}__`,
  (s) => `* ${s}`,
  (s) => `${s}\``,
  (s) => `**\`${s}\`**`,
  (s) => `_*\`${s}\`*_`,
  (s) => `  \` ${s} \`  `,
]
// Stage sentinels in use plus a user-chosen one, and the loop's WAIT marker.
const EXACT_SENTINELS = [LOOP_WAIT_MARKER, '---SPEC-DONE---', '---DONE---', 'DONE', '---QUESTION-END---']

describe('F4: only the loop DONE check accepts a decorated marker', () => {
  it('turnEndsWithLoopDone accepts every decorated form of the done marker', () => {
    for (const decorate of DECORATED) {
      expect(turnEndsWithLoopDone(`全部完成。\n${decorate(LOOP_DONE_MARKER)}`, LOOP_DONE_MARKER)).toBe(true)
    }
  })

  it('turnEndsWithSentinel stays exact for LOOP_WAIT and stage sentinels', () => {
    // Guard: LOOP_WAIT parks the loop and a stage sentinel completes a pipeline
    // stage; neither gate may widen with the done-marker fix.
    for (const sentinel of [...EXACT_SENTINELS, LOOP_DONE_MARKER]) {
      for (const decorate of DECORATED) {
        expect(turnEndsWithSentinel(`text\n${decorate(sentinel)}`, sentinel)).toBe(false)
      }
      expect(turnEndsWithSentinel(`text\n${sentinel}`, sentinel)).toBe(true)
    }
  })

  it('still rejects the marker sharing its line with other text', () => {
    for (const line of [
      `全部完成 ${LOOP_DONE_MARKER}`,
      `全部完成 \`${LOOP_DONE_MARKER}\``,
      `**完成：${LOOP_DONE_MARKER}**`,
      `\`${LOOP_DONE_MARKER}\` 以上`,
      `- ${LOOP_DONE_MARKER}`,
      `> ${LOOP_DONE_MARKER}`,
    ]) {
      expect(turnEndsWithLoopDone(`x\n${line}`, LOOP_DONE_MARKER)).toBe(false)
    }
  })

  it('still rejects a decorated marker that is not the final line', () => {
    expect(turnEndsWithLoopDone(`\`${LOOP_DONE_MARKER}\`\n接下來繼續`, LOOP_DONE_MARKER)).toBe(false)
  })

  it('does not take the wait marker for done, decorated or not', () => {
    expect(turnEndsWithLoopDone(`\`${LOOP_WAIT_MARKER}\``, LOOP_DONE_MARKER)).toBe(false)
    expect(turnEndsWithLoopDone('', LOOP_DONE_MARKER)).toBe(false)
    expect(turnEndsWithLoopDone('done', '')).toBe(false)
  })
})

describe('F5: a continue armed at injection start sees a fast turn', () => {
  it('a turn that woke and ended before injectPane returned is ready', () => {
    // Injection started at 1000, agent_active 1200, turn_complete 2500,
    // injectPane returned 2600. Arming at the return (main) misses the turn;
    // arming at the start judges it.
    const fast = { lastActiveAt: 1_200, turnCompleteAt: 2_500, now: 10_000 }
    expect(loopContinueReady(base({ ...fast, armedAt: 2_600 }))).toBe(false)
    expect(loopContinueReady(base({ ...fast, armedAt: 1_000 }))).toBe(true)
  })

  it('the previous turn end alone never satisfies the earlier arm', () => {
    // The wake guard is untouched: without a post-arm agent_active the turn
    // that triggered this continue cannot re-trigger it.
    expect(loopContinueReady(base({ armedAt: 1_000, lastActiveAt: 500, turnCompleteAt: 900, now: 10_000 }))).toBe(false)
  })
})

describe('F6: consecutive continue-injection failures', () => {
  it('counts consecutive failures and resets on a success', () => {
    let n = 0
    n = loopInjectFailures(n, false)
    n = loopInjectFailures(n, false)
    expect(n).toBe(2)
    n = loopInjectFailures(n, true)
    expect(n).toBe(0)
    n = loopInjectFailures(n, false)
    expect(n).toBe(1)
  })

  it('the stop condition is three failures in a row', () => {
    expect(LOOP_INJECT_FAIL_LIMIT).toBe(3)
  })
})
