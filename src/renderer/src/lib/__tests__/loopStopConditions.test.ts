import { describe, expect, it } from 'vitest'
import {
  loopContinueReady,
  loopInjectFailures,
  turnEndsWithSentinel,
  LOOP_INJECT_FAIL_LIMIT,
  type TurnCompleteState,
} from '../completion'
import { LOOP_DONE_MARKER, LOOP_WAIT_MARKER } from '../loopPrompt'

const SETTLE = 1500
const base = (o: Partial<TurnCompleteState>): TurnCompleteState => ({
  turnCompleteAt: 0, lastActiveAt: 0, armedAt: 0, now: 0, settleMs: SETTLE, ...o,
})

describe('F4: a markdown-decorated done marker still ends the loop', () => {
  it('accepts the marker wrapped in backticks, emphasis or underscores', () => {
    for (const line of [
      `\`${LOOP_DONE_MARKER}\``,
      `**${LOOP_DONE_MARKER}**`,
      `*${LOOP_DONE_MARKER}*`,
      `__${LOOP_DONE_MARKER}__`,
      `_${LOOP_DONE_MARKER}_`,
      `**\`${LOOP_DONE_MARKER}\`**`,
      `  \` ${LOOP_DONE_MARKER} \`  `,
    ]) {
      expect(turnEndsWithSentinel(`全部完成。\n${line}`, LOOP_DONE_MARKER)).toBe(true)
    }
  })

  it('accepts a decorated wait marker the same way', () => {
    expect(turnEndsWithSentinel(`還在等。\n\`${LOOP_WAIT_MARKER}\``, LOOP_WAIT_MARKER)).toBe(true)
  })

  it('still rejects the marker sharing its line with other text', () => {
    expect(turnEndsWithSentinel(`全部完成 ${LOOP_DONE_MARKER}`, LOOP_DONE_MARKER)).toBe(false)
    expect(turnEndsWithSentinel(`全部完成 \`${LOOP_DONE_MARKER}\``, LOOP_DONE_MARKER)).toBe(false)
    expect(turnEndsWithSentinel(`**完成：${LOOP_DONE_MARKER}**`, LOOP_DONE_MARKER)).toBe(false)
    expect(turnEndsWithSentinel(`\`${LOOP_DONE_MARKER}\` 以上`, LOOP_DONE_MARKER)).toBe(false)
  })

  it('still rejects a decorated marker that is not the final line', () => {
    expect(turnEndsWithSentinel(`\`${LOOP_DONE_MARKER}\`\n接下來繼續`, LOOP_DONE_MARKER)).toBe(false)
  })

  it('never strips characters a sentinel itself ends with', () => {
    // The bare comparison runs first, so a sentinel with its own underscore
    // still matches exactly.
    expect(turnEndsWithSentinel('done\n__END__', '__END__')).toBe(true)
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

  it('stops after three failures in a row', () => {
    expect(LOOP_INJECT_FAIL_LIMIT).toBe(3)
    let n = 0
    for (let i = 0; i < LOOP_INJECT_FAIL_LIMIT; i++) n = loopInjectFailures(n, false)
    expect(n >= LOOP_INJECT_FAIL_LIMIT).toBe(true)
  })
})
