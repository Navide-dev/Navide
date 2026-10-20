import { describe, it, expect } from 'vitest'
import { activityMeansWorking, applyLoopWait, clearProvisionalStall, loopSettleMs, LOOP_INFERRED_TURN_END_SETTLE_MS, detailMeansToolUse, quotaTurnIsFresh, recordTurnComplete, paneSignalResetKeys, loopWaitBackoffMs, loopWaitHonoured, LOOP_WAIT_BACKOFF_MS, LOOP_WAIT_TOTAL_MAX_MS, slotFinished, allSlotsFinished, turnCompleteDone, loopContinueReady, turnEndsWithSentinel, parseEventMs, isReplayedTurnComplete, turnTextFingerprint, normalizeTurnText, turnMadeProgress, loopBackoffMs, applyTurnProgress, loopStallVerdict, loopWaitingOnSubagents, backgroundWorkPending, turnUsedNoTools, LOOP_STALL_BACKOFF_MS, LOOP_MIN_PROGRESS_CHARS, LOOP_STALL_LIMIT, LOOP_MAX_CONTINUES, LOOP_SUBAGENT_WAIT_MAX_MS, LOOP_RECENT_TURNS, type SlotSignal, type LoopStallState } from '../completion'
import { VENDORS_WITHOUT_TURN_END } from '../agentMessaging'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'

// Fixed reference time for the watcher arming. turn_complete only counts when
// its timestamp is strictly AFTER this.
const ARMED = 1000

describe('slotFinished', () => {
  it('is true when the sentinel was seen, regardless of turn_complete', () => {
    expect(slotFinished({ sentinelSeen: true, turnCompleteAt: 0, armedAt: ARMED })).toBe(true)
  })

  it('sentinel wins even over a stale turn_complete', () => {
    expect(slotFinished({ sentinelSeen: true, turnCompleteAt: 500, armedAt: ARMED })).toBe(true)
  })

  it('is true when turn_complete landed after the watcher armed', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: 2000, armedAt: ARMED })).toBe(true)
  })

  it('is false when there is no signal at all', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: 0, armedAt: ARMED })).toBe(false)
  })

  it('ignores a stale turn_complete from a prior stage/turn', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: 500, armedAt: ARMED })).toBe(false)
  })

  it('ignores a turn_complete exactly at arm time (must be strictly after)', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: ARMED, armedAt: ARMED })).toBe(false)
  })
})

describe('allSlotsFinished', () => {
  const finished: SlotSignal = { sentinelSeen: true, turnCompleteAt: 0, armedAt: ARMED }
  const unfinished: SlotSignal = { sentinelSeen: false, turnCompleteAt: 0, armedAt: ARMED }

  it('is never true for an empty list (no signals yet)', () => {
    expect(allSlotsFinished([])).toBe(false)
  })

  it('is true when a single slot is finished', () => {
    expect(allSlotsFinished([finished])).toBe(true)
  })

  it('is true when every slot is finished (mixed signal kinds)', () => {
    const viaTurnComplete: SlotSignal = { sentinelSeen: false, turnCompleteAt: 2000, armedAt: ARMED }
    expect(allSlotsFinished([finished, viaTurnComplete])).toBe(true)
  })

  it('is false when any slot is unfinished (partial completion never advances)', () => {
    expect(allSlotsFinished([finished, unfinished])).toBe(false)
  })

  it('is false when a slot only has a stale turn_complete', () => {
    const stale: SlotSignal = { sentinelSeen: false, turnCompleteAt: 500, armedAt: ARMED }
    expect(allSlotsFinished([finished, stale])).toBe(false)
  })
})

describe('turnCompleteDone', () => {
  const SETTLE = 1500

  it('is true when turn_complete is post-arm, latest, and settled', () => {
    // armed=1000, active=1500, turn_complete=2000, now=2000+SETTLE
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(true)
  })

  it('is true exactly at the settle boundary', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(true)
  })

  it('is false before settle elapses (lets a QUESTION render & be caught first)', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + 1000, settleMs: SETTLE
    })).toBe(false)
  })

  it('is false when agent_active came AFTER turn_complete (revived by injection)', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 2500, armedAt: ARMED,
      now: 2000 + SETTLE + 5000, settleMs: SETTLE
    })).toBe(false)
  })

  it('is false for a stale turn_complete from before the watcher armed', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 500, lastActiveAt: 0, armedAt: ARMED,
      now: 999_999, settleMs: SETTLE
    })).toBe(false)
  })

  it('is false when there is no turn_complete signal at all', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 0, lastActiveAt: 0, armedAt: ARMED,
      now: 999_999, settleMs: SETTLE
    })).toBe(false)
  })
})

// ── Background work outliving the turn end (pipeline hand-off) ──────────────
// claude (run_in_background Bash / async Agent) and qwen (background agents by
// default, background shells) end the CURRENT turn while the work keeps
// running, so that turn_complete is not the slot finishing. The field is
// opt-in: a caller that leaves it out (the loop, the done notification, every
// vendor that never reports background work) judges exactly as before.
describe('background work holds the pipeline verdict', () => {
  const SETTLE = 1500
  const settled = { turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED, now: 2000 + SETTLE, settleMs: SETTLE }

  it('slotFinished refuses a post-arm turn_complete while background work runs', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: 2000, armedAt: ARMED, backgroundRunning: true })).toBe(false)
  })

  it('slotFinished counts the same turn_complete once the background work has ended', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: 2000, armedAt: ARMED, backgroundRunning: false })).toBe(true)
  })

  it('slotFinished still lets the sentinel outrank running background work', () => {
    expect(slotFinished({ sentinelSeen: true, turnCompleteAt: 0, armedAt: ARMED, backgroundRunning: true })).toBe(true)
  })

  it('allSlotsFinished stays false while one slot is parked on background work', () => {
    const done: SlotSignal = { sentinelSeen: false, turnCompleteAt: 2000, armedAt: ARMED }
    const parked: SlotSignal = { sentinelSeen: false, turnCompleteAt: 2000, armedAt: ARMED, backgroundRunning: true }
    expect(allSlotsFinished([done, parked])).toBe(false)
  })

  it('turnCompleteDone refuses a settled turn end while background work runs', () => {
    expect(turnCompleteDone({ ...settled, backgroundRunning: true })).toBe(false)
  })

  it('turnCompleteDone is unchanged when the field is absent or false', () => {
    expect(turnCompleteDone(settled)).toBe(true)
    expect(turnCompleteDone({ ...settled, backgroundRunning: false })).toBe(true)
  })

  it('the turn the CLI runs on the completion notice is what releases the slot', () => {
    // The background:end event is an agent_active, so it stamps lastActiveAt
    // AFTER the parked turn end; only the follow-up turn's turn_complete counts.
    expect(turnCompleteDone({ ...settled, lastActiveAt: 2600, now: 9000 })).toBe(false)
    expect(turnCompleteDone({ ...settled, turnCompleteAt: 4000, lastActiveAt: 2600, now: 4000 + SETTLE })).toBe(true)
  })
})

describe('backgroundWorkPending', () => {
  const NOW = 1_000_000

  it('is true while the pane tracks a live background task', () => {
    expect(backgroundWorkPending({ liveTasks: true, now: NOW })).toBe(true)
  })

  it('is true while a hook reports pending background subagents', () => {
    expect(backgroundWorkPending({ liveTasks: false, subagents: { pending: 1, observedAt: NOW - 1000 }, now: NOW })).toBe(true)
  })

  it('is false with no tasks and no pending subagents (every vendor without background work)', () => {
    expect(backgroundWorkPending({ liveTasks: false, now: NOW })).toBe(false)
    expect(backgroundWorkPending({ liveTasks: false, subagents: { pending: 0, observedAt: NOW }, now: NOW })).toBe(false)
  })

  it('lets a hook count lapse on the same cap the loop uses', () => {
    expect(backgroundWorkPending({
      liveTasks: false,
      subagents: { pending: 2, observedAt: NOW - LOOP_SUBAGENT_WAIT_MAX_MS - 1 },
      now: NOW,
    })).toBe(false)
  })
})

describe('loopContinueReady', () => {
  const SETTLE = 1500

  it('is true when the continue woke the CLI: agent_active landed after arm', () => {
    // armed=1000, active=1500 (>arm), turn_complete=2000, settled.
    expect(loopContinueReady({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(true)
  })

  it('is false for an empty turn_complete with NO agent_active after arm (the infinite-loop bug)', () => {
    // turnCompleteDone alone would be TRUE here (post-arm, latest, settled), but
    // lastActiveAt (from before arm) never advanced — the injected continue did
    // not wake the CLI, so a re-fire would spam "繼續" forever.
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 500, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(true)
    expect(loopContinueReady({
      turnCompleteAt: 2000, lastActiveAt: 500, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(false)
  })

  it('is false when agent_active landed exactly at arm time (must be strictly after)', () => {
    expect(loopContinueReady({
      turnCompleteAt: 2000, lastActiveAt: ARMED, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(false)
  })

  it('inherits turnCompleteDone gating: false before settle even with a post-arm agent_active', () => {
    expect(loopContinueReady({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + 1000, settleMs: SETTLE
    })).toBe(false)
  })
})

describe('turnMadeProgress', () => {
  // Long enough to clear LOOP_MIN_PROGRESS_CHARS.
  const WORK = 'Implemented the parser, added three tests, and ran the suite — all green.'
  const OTHER_WORK = 'Fixed the failing case in the reducer and re-ran the suite — still green.'

  it('is true for a substantial turn that differs from the previous one', () => {
    expect(turnMadeProgress(WORK, OTHER_WORK)).toBe(true)
  })

  it('is false when the CLI repeats its previous answer verbatim', () => {
    expect(turnMadeProgress(WORK, WORK)).toBe(false)
  })

  it('ignores whitespace/wrapping differences when comparing to the previous turn', () => {
    expect(turnMadeProgress(WORK.replace(' ', '\n  '), WORK)).toBe(false)
  })

  it('is false for a turn too short to be work (the "等待中。" spin)', () => {
    expect(turnMadeProgress('等待中。', '')).toBe(false)
    expect(turnMadeProgress('等待中。', '等待中。')).toBe(false)
  })

  it('is false for an empty turn_complete', () => {
    expect(turnMadeProgress('', 'anything')).toBe(false)
  })

  it('treats exactly LOOP_MIN_PROGRESS_CHARS as long enough', () => {
    expect(turnMadeProgress('x'.repeat(LOOP_MIN_PROGRESS_CHARS), '')).toBe(true)
    expect(turnMadeProgress('x'.repeat(LOOP_MIN_PROGRESS_CHARS - 1), '')).toBe(false)
  })
})

describe('normalizeTurnText', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeTurnText('  a \n\n b\tc  ')).toBe('a b c')
  })
})

describe('loopBackoffMs', () => {
  it('does not delay a productive loop', () => {
    expect(loopBackoffMs(0)).toBe(0)
    expect(loopBackoffMs(-1)).toBe(0)
  })

  it('escalates with each consecutive stalled run', () => {
    expect(loopBackoffMs(1)).toBe(LOOP_STALL_BACKOFF_MS[1])
    expect(loopBackoffMs(2)).toBe(LOOP_STALL_BACKOFF_MS[2])
    expect(loopBackoffMs(3)).toBe(LOOP_STALL_BACKOFF_MS[3])
  })

  it('clamps past the last tier', () => {
    expect(loopBackoffMs(99)).toBe(LOOP_STALL_BACKOFF_MS[LOOP_STALL_BACKOFF_MS.length - 1])
  })
})

describe('applyTurnProgress', () => {
  const FRESH: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
  const WORK = 'Implemented the parser, added three tests, and ran the suite — all green.'

  it('records a productive turn and keeps the counter at zero', () => {
    expect(applyTurnProgress(FRESH, WORK)).toEqual({ stalledRuns: 0, lastTurnText: WORK, recentTurns: [WORK] })
  })

  it('clears the counter as soon as the loop gets moving again', () => {
    expect(applyTurnProgress({ stalledRuns: 3, lastTurnText: '等待中。' }, WORK).stalledRuns).toBe(0)
  })

  it('counts a repeated answer as a stalled run', () => {
    const after = applyTurnProgress({ stalledRuns: 1, lastTurnText: WORK }, WORK)
    expect(after.stalledRuns).toBe(2)
  })

  it('reaches the stall limit after LOOP_STALL_LIMIT "等待中。" turns (the reported spin)', () => {
    let state = FRESH
    for (let i = 0; i < LOOP_STALL_LIMIT; i++) state = applyTurnProgress(state, '等待中。')
    expect(state.stalledRuns).toBe(LOOP_STALL_LIMIT)
    expect(loopStallVerdict({ continues: 0, stalledRuns: state.stalledRuns })).toBe('stop-stalled')
  })

  it('leaves the state untouched for a text-less turn_complete (kimi/qwen/pi readers)', () => {
    const stalled: LoopStallState = { stalledRuns: 2, lastTurnText: WORK }
    expect(applyTurnProgress(stalled, '')).toBe(stalled)
    expect(applyTurnProgress(stalled, '   \n ')).toBe(stalled)
  })

  it('never stalls a vendor that sends no turn text, however many turns pass', () => {
    let state = FRESH
    for (let i = 0; i < 50; i++) state = applyTurnProgress(state, '')
    expect(loopStallVerdict({ continues: 0, stalledRuns: state.stalledRuns })).toBe('ok')
  })
})

describe('clearProvisionalStall', () => {
  it('takes back the charge an empty-text copy made, and marks the turn judged', () => {
    const after = clearProvisionalStall({ stalledRuns: 3, lastTurnText: '', emptyCharged: true })
    expect(after.stalledRuns).toBe(2)
    expect(after.emptyCharged).toBe(false)
    expect(after.toolJudged).toBe(true)
  })

  it('leaves the count alone when no provisional charge was made', () => {
    const after = clearProvisionalStall({ stalledRuns: 3, lastTurnText: '' })
    expect(after.stalledRuns).toBe(3)
    expect(after.toolJudged).toBe(true)
  })

  it('never drives the count negative', () => {
    // The count is a number of turns. Three places write it and only their
    // relative order kept this subtraction above zero; the clamp is what
    // actually holds.
    expect(clearProvisionalStall({ stalledRuns: 0, lastTurnText: '', emptyCharged: true }).stalledRuns).toBe(0)
  })

  it('keeps the rest of the state', () => {
    const after = clearProvisionalStall({ stalledRuns: 1, lastTurnText: 'x', recentTurns: ['x'], emptyCharged: true })
    expect(after.lastTurnText).toBe('x')
    expect(after.recentTurns).toEqual(['x'])
  })
})

describe('loopStallVerdict', () => {
  it('lets a healthy loop keep going', () => {
    expect(loopStallVerdict({ continues: 0, stalledRuns: 0 })).toBe('ok')
    expect(loopStallVerdict({ continues: LOOP_MAX_CONTINUES - 1, stalledRuns: LOOP_STALL_LIMIT - 1 })).toBe('ok')
  })

  it('stops on the stall limit', () => {
    expect(loopStallVerdict({ continues: 0, stalledRuns: LOOP_STALL_LIMIT })).toBe('stop-stalled')
  })

  it('stops on the continue cap', () => {
    expect(loopStallVerdict({ continues: LOOP_MAX_CONTINUES, stalledRuns: 0 })).toBe('stop-capped')
  })

  it('reports the cap when both trip on the same poll', () => {
    expect(loopStallVerdict({ continues: LOOP_MAX_CONTINUES, stalledRuns: LOOP_STALL_LIMIT })).toBe('stop-capped')
  })
})

describe('parseEventMs', () => {
  it('parses an ISO-8601 timestamp (Claude/Codex)', () => {
    expect(parseEventMs('2026-07-23T07:45:32.000Z')).toBe(Date.parse('2026-07-23T07:45:32.000Z'))
  })

  it('parses a bare epoch-ms string (Kimi wire.jsonl time)', () => {
    expect(parseEventMs('1784762222265')).toBe(1784762222265)
  })

  it('returns NaN for empty or unparseable input', () => {
    expect(Number.isNaN(parseEventMs(''))).toBe(true)
    expect(Number.isNaN(parseEventMs('not-a-date'))).toBe(true)
  })
})

describe('isReplayedTurnComplete', () => {
  const TOL = 60_000
  const NOW = 2_000_000

  it('flags a stale ISO event replayed on backend restart', () => {
    const old = new Date(NOW - TOL - 5_000).toISOString()
    expect(isReplayedTurnComplete(old, NOW, TOL)).toBe(true)
  })

  it('flags a stale epoch-ms (Kimi) event beyond tolerance', () => {
    expect(isReplayedTurnComplete(String(NOW - TOL - 1), NOW, TOL)).toBe(true)
  })

  it('passes a live turn end within tolerance (both formats)', () => {
    expect(isReplayedTurnComplete(String(NOW - 8_000), NOW, TOL)).toBe(false)
    expect(isReplayedTurnComplete(new Date(NOW - 8_000).toISOString(), NOW, TOL)).toBe(false)
  })

  it('treats a missing/unparseable timestamp as live (never suppresses)', () => {
    expect(isReplayedTurnComplete('', NOW, TOL)).toBe(false)
    expect(isReplayedTurnComplete('garbage', NOW, TOL)).toBe(false)
  })
})

describe('turnEndsWithSentinel', () => {
  const S = '---SPEC-DONE---'

  it('accepts the sentinel as the final non-empty line', () => {
    expect(turnEndsWithSentinel(`規格完成。\n${S}`, S)).toBe(true)
    expect(turnEndsWithSentinel(`規格完成。\n${S}\n\n  `, S)).toBe(true)
    expect(turnEndsWithSentinel(`  ${S}  `, S)).toBe(true)
  })

  it('rejects mid-text mentions (quoted protocol / instructions)', () => {
    // Real kickoff instruction lines from the CRM run — these were echoed by
    // the TUI and falsely completed stages under the old log-file scanner.
    expect(turnEndsWithSentinel(`錯誤：完成了 ${S}\n接下來開始工作`, S)).toBe(false)
    expect(turnEndsWithSentinel(`${S}\n正確：最後一行只有 ${S}。`, S)).toBe(false)
    expect(turnEndsWithSentinel(`完成後，最後一行只輸出 ${S}。`, S)).toBe(false)
  })

  it('rejects inline text on the final line', () => {
    expect(turnEndsWithSentinel(`完成了 ${S}`, S)).toBe(false)
    expect(turnEndsWithSentinel(`${S} 以上`, S)).toBe(false)
  })

  it('rejects empty inputs', () => {
    expect(turnEndsWithSentinel('', S)).toBe(false)
    expect(turnEndsWithSentinel('done', '')).toBe(false)
  })

  it('question block followed by a bare sentinel line still ends with the sentinel', () => {
    // Ordering (question wins) is the caller's job; this fn only judges the tail.
    const text = `---QUESTION-START---\ntype: choice\nprompt: MVP 核心？\n---QUESTION-END---\n${S}`
    expect(turnEndsWithSentinel(text, S)).toBe(true)
  })
})

// ── The reported spin (2026-08-26) ─────────────────────────────────────────
//
// A loop resent "繼續" every 5s for hours while the CLI sat waiting on two
// background agents. Every guard passed: the turn really had ended (Claude's
// Stop hook fires when the main agent stops to wait), the continue really had
// woken it, and each turn's TEXT really was different — the agent restated
// "still waiting" in fresh words every single time.
//
// These are the four turns from the report, verbatim.
const SPIN_TURNS = [
  '回歸 agent 已被喚回去收結果（背景 phpunit 應已跑完，遺失就重跑）。瀏覽器實測 agent 仍在進行中。兩者回報後收尾。尚未完成，不輸出標記。',
  '回歸 agent 正在收取/重跑結果、瀏覽器實測 agent 仍在操作中，兩份回報一到即產出報告書收尾。尚未完成，不輸出標記。',
  '兩個驗收 agent 都在收尾階段，等待回報中。尚未完成，不輸出標記。',
  '驗收回報尚未到達，持續等待中（回歸 agent 收結果、瀏覽器 agent 實測）。尚未完成，不輸出標記。',
]

describe('loopSettleMs', () => {
  const DEFAULT = 1500
  // grok dropped out when it moved to the official xAI CLI, whose transcript
  // carries an explicit `turn_completed` record.
  const SILENCE_VENDORS = ['kimi', 'pi', 'qwen']

  it('holds the verdict longer for the vendors whose turn end is inferred from silence', () => {
    for (const key of SILENCE_VENDORS) {
      expect(VENDORS_WITHOUT_TURN_END.has(key)).toBe(true)
      expect(loopSettleMs(VENDORS_WITHOUT_TURN_END.has(key), DEFAULT)).toBe(LOOP_INFERRED_TURN_END_SETTLE_MS)
    }
    expect(LOOP_INFERRED_TURN_END_SETTLE_MS).toBeGreaterThan(DEFAULT)
  })

  it('leaves every other vendor on the default settle', () => {
    const others = CLI_AGENT_SPECS.map((s) => s.agentKey).filter((k) => !SILENCE_VENDORS.includes(k))
    expect(others.length).toBe(CLI_AGENT_SPECS.length - SILENCE_VENDORS.length)
    for (const key of others) {
      expect(VENDORS_WITHOUT_TURN_END.has(key)).toBe(false)
      expect(loopSettleMs(VENDORS_WITHOUT_TURN_END.has(key), DEFAULT)).toBe(DEFAULT)
    }
  })

  it('never shortens a default that is already longer', () => {
    expect(loopSettleMs(true, LOOP_INFERRED_TURN_END_SETTLE_MS + 1)).toBe(LOOP_INFERRED_TURN_END_SETTLE_MS + 1)
  })
})

describe('loopWaitingOnSubagents', () => {
  const NOW = 10_000_000

  it('holds the loop while a fresh count says subagents are running', () => {
    expect(loopWaitingOnSubagents({ pending: 2, observedAt: NOW - 5_000, now: NOW })).toBe(true)
  })

  it('does not hold when nothing is pending', () => {
    expect(loopWaitingOnSubagents({ pending: 0, observedAt: NOW - 5_000, now: NOW })).toBe(false)
  })

  it('does not hold on a pane that never reported a count', () => {
    expect(loopWaitingOnSubagents({ pending: 0, observedAt: 0, now: NOW })).toBe(false)
    // A count with no report time is unusable even if non-zero.
    expect(loopWaitingOnSubagents({ pending: 3, observedAt: 0, now: NOW })).toBe(false)
  })

  it('fails OPEN once the count is stale — a drifted count only ever delays', () => {
    const stale = NOW - LOOP_SUBAGENT_WAIT_MAX_MS - 1
    expect(loopWaitingOnSubagents({ pending: 2, observedAt: stale, now: NOW })).toBe(false)
  })

  it('still holds right up to the staleness boundary', () => {
    const edge = NOW - LOOP_SUBAGENT_WAIT_MAX_MS + 1
    expect(loopWaitingOnSubagents({ pending: 1, observedAt: edge, now: NOW })).toBe(true)
  })

  it('never holds on a negative count (a stop with no matching start)', () => {
    expect(loopWaitingOnSubagents({ pending: -1, observedAt: NOW, now: NOW })).toBe(false)
  })
})

describe('normalizeTurnText CJK wrapping', () => {
  it('drops the space a TUI wrap inserts between two Chinese characters', () => {
    // Chinese has no space to collapse back down to, so a wrap ADDS one.
    // Without this, every wrapped repeat reads as a brand-new turn.
    expect(normalizeTurnText('尚未完成，不輸出標記。')).toBe(
      normalizeTurnText('尚未完成，\n  不輸出標記。')
    )
  })

  it('makes a wrapped Chinese repeat compare equal', () => {
    const wrapped = SPIN_TURNS[0].replace('。瀏覽器', '。\n  瀏覽器')
    expect(turnMadeProgress(wrapped, SPIN_TURNS[0])).toBe(false)
  })

  it('leaves English word spacing alone', () => {
    expect(normalizeTurnText('ran the suite')).toBe('ran the suite')
    // A space with CJK on only one side is real spacing, not a wrap artefact.
    expect(normalizeTurnText('執行 pytest 完成')).toBe('執行 pytest 完成')
  })
})

describe('text comparison stays exact', () => {
  it('calls a verbatim repeat a stall, ignoring only re-wrapping', () => {
    expect(turnMadeProgress(SPIN_TURNS[0], SPIN_TURNS[0])).toBe(false)
    expect(turnMadeProgress(SPIN_TURNS[0].replace('。瀏覽器', '。\n  瀏覽器'), SPIN_TURNS[0])).toBe(false)
  })

  it('does NOT catch the reported spin — the reworded turns read as progress', () => {
    // Pinned deliberately. A fuzzy (trigram-similarity) judgement was tried
    // here and dropped: the threshold that caught these four turns also called
    // "Completed step 1…" a repeat of "Completed step 0…", which differs by one
    // character and is real progress. Text cannot tell the two apart, so the
    // spin is caught by turnUsedNoTools and loopWaitingOnSubagents instead.
    expect(turnMadeProgress(SPIN_TURNS[1], SPIN_TURNS[0])).toBe(true)
    expect(turnMadeProgress(SPIN_TURNS[3], SPIN_TURNS[2])).toBe(true)
    // The third turn IS caught, but only by the length floor — it happens to be
    // under LOOP_MIN_PROGRESS_CHARS. One stall in four never reaches
    // LOOP_STALL_LIMIT, and the next turn resets the counter to zero, which is
    // why the run span hours on the old judgement.
    expect(SPIN_TURNS[2].length).toBeLessThan(LOOP_MIN_PROGRESS_CHARS)
    expect(turnMadeProgress(SPIN_TURNS[2], SPIN_TURNS[1])).toBe(false)
  })

  it('keeps near-identical but genuinely stepwise turns as progress', () => {
    const step0 = 'Completed step 0 of the migration and verified its output.'
    const step1 = 'Completed step 1 of the migration and verified its output.'
    expect(turnMadeProgress(step1, step0)).toBe(true)
  })
})

describe('turnUsedNoTools', () => {
  it('is true when a reporting pane ended a turn without touching a tool', () => {
    expect(turnUsedNoTools({ toolUsesThisTurn: 0, toolSignalsSeen: true })).toBe(true)
  })

  it('is false when the turn used tools', () => {
    expect(turnUsedNoTools({ toolUsesThisTurn: 3, toolSignalsSeen: true })).toBe(false)
  })

  it('is false for a vendor that never reports tool use — the whole safety net', () => {
    // Without this, every turn of every non-hook CLI would look stalled and
    // stop a perfectly healthy loop after LOOP_STALL_LIMIT turns.
    expect(turnUsedNoTools({ toolUsesThisTurn: 0, toolSignalsSeen: false })).toBe(false)
  })
})

describe('the reported spin is now caught', () => {
  const NO_TOOLS = { toolUsesThisTurn: 0, toolSignalsSeen: true }
  const WORKED = { toolUsesThisTurn: 4, toolSignalsSeen: true }

  it('stops the loop after LOOP_STALL_LIMIT waiting turns', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (const turn of SPIN_TURNS) state = applyTurnProgress(state, turn, NO_TOOLS)
    expect(state.stalledRuns).toBe(SPIN_TURNS.length)
    expect(loopStallVerdict({ continues: 4, stalledRuns: state.stalledRuns })).toBe('stop-stalled')
  })

  it('used to look like progress on every turn — the old verbatim judgement', () => {
    // Same four turns, judged the way they were before: each differs from the
    // one before it, so the counter never left zero and only the 200-continue
    // cap could end the run.
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (const turn of SPIN_TURNS) state = applyTurnProgress(state, turn)
    expect(state.stalledRuns).toBe(0)
  })

  it('leaves a genuinely working loop alone', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (const turn of SPIN_TURNS) state = applyTurnProgress(state, turn, WORKED)
    expect(state.stalledRuns).toBe(0)
    expect(loopStallVerdict({ continues: 4, stalledRuns: state.stalledRuns })).toBe('ok')
  })

  it('counts an empty-text turn that touched no tool', () => {
    // Claude's Stop hook carries no text. Before, that was UNKNOWN and the
    // turn was ignored entirely; now the tool signal can still speak for it.
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (let i = 0; i < LOOP_STALL_LIMIT; i++) {
      // One empty copy per armed turn; the arm between turns clears the flags.
      state = { ...applyTurnProgress(state, '', NO_TOOLS), emptyCharged: false, toolJudged: false }
    }
    expect(loopStallVerdict({ continues: 0, stalledRuns: state.stalledRuns })).toBe('stop-stalled')
  })

  it('still ignores an empty-text turn from a vendor with no tool signals', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (let i = 0; i < 50; i++) {
      state = applyTurnProgress(state, '', { toolUsesThisTurn: 0, toolSignalsSeen: false })
    }
    expect(loopStallVerdict({ continues: 0, stalledRuns: state.stalledRuns })).toBe('ok')
  })
})

describe('one turn reported twice charges one stall', () => {
  // Claude reports every turn end TWICE: the Stop hook (no text) and the JSONL
  // reader (with text). Both reach applyTurnProgress with the same per-turn
  // tool count, so a talk-only turn was charged on each copy — two stalls per
  // turn, LOOP_STALL_LIMIT reached after two turns instead of four.
  const NO_TOOLS = { toolUsesThisTurn: 0, toolSignalsSeen: true }
  const WORKED = { toolUsesThisTurn: 2, toolSignalsSeen: true }
  const TALK = 'Still waiting on the background job; nothing else to do this turn until it finishes.'

  it('hook copy first, then the reader text (the usual order)', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    state = applyTurnProgress(state, '', NO_TOOLS)
    state = applyTurnProgress(state, TALK, NO_TOOLS)
    expect(state.stalledRuns).toBe(1)
  })

  it('reader text first, then the hook copy', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    state = applyTurnProgress(state, TALK, NO_TOOLS)
    state = applyTurnProgress(state, '', NO_TOOLS)
    expect(state.stalledRuns).toBe(1)
  })

  it('the text judgement REPLACES the hook copy\'s charge, it does not add to it', () => {
    // Both copies must see the same tool count — that is what makes them one
    // turn. The empty copy charges provisionally (2 → 3) and the text lands on
    // the same 3; judged independently it would read 4.
    let state: LoopStallState = { stalledRuns: 2, lastTurnText: '' }
    state = applyTurnProgress(state, '', NO_TOOLS)
    expect(state.stalledRuns).toBe(3) // provisional
    state = applyTurnProgress(state, TALK, NO_TOOLS)
    expect(state.stalledRuns).toBe(3) // replaced, not added to
  })

  it('a turn that used tools clears the count outright', () => {
    let state: LoopStallState = { stalledRuns: 2, lastTurnText: '' }
    state = applyTurnProgress(state, '', NO_TOOLS)
    state = applyTurnProgress(state, TALK, WORKED)
    expect(state.stalledRuns).toBe(0)
  })

  it('still charges once per turn across turns', () => {
    // The per-turn flags are what armLoopTurn resets; a fresh arm is modelled
    // by dropping them, exactly as the watcher does.
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (let i = 0; i < LOOP_STALL_LIMIT; i++) {
      state = applyTurnProgress(state, '', NO_TOOLS)
      state = applyTurnProgress(state, `${TALK} (turn ${i})`, NO_TOOLS)
      state = { ...state, emptyCharged: false, toolJudged: false }
    }
    expect(state.stalledRuns).toBe(LOOP_STALL_LIMIT)
  })
})

describe('applyTurnProgress recent-turn history', () => {
  const A = 'Ran the migration on the staging database and verified the row counts matched.'
  const B = 'Rebuilt the search index from scratch and confirmed the query latency dropped.'

  it('catches a two-phrase alternation that verbatim comparison called progress', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (const turn of [A, B, A, B]) state = applyTurnProgress(state, turn)
    // A and B each repeat a turn inside the retained window.
    expect(state.stalledRuns).toBeGreaterThan(0)
  })

  it('keeps at most LOOP_RECENT_TURNS turns of history', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (let i = 0; i < LOOP_RECENT_TURNS + 3; i++) {
      state = applyTurnProgress(state, `Completed step ${i} of the migration and verified its output.`)
    }
    expect(state.recentTurns?.length).toBe(LOOP_RECENT_TURNS)
  })

  it('does not call a turn stalled just because it fell out of the window', () => {
    let state: LoopStallState = { stalledRuns: 0, lastTurnText: '' }
    for (let i = 0; i < LOOP_RECENT_TURNS + 1; i++) {
      state = applyTurnProgress(state, `Completed step ${i} of the migration and verified its output.`)
    }
    expect(state.stalledRuns).toBe(0)
  })
})

describe('activityMeansWorking', () => {
  it('treats ordinary activity as the pane working', () => {
    expect(activityMeansWorking('hook:pre_tool_use')).toBe(true)
    expect(activityMeansWorking('hook:notification')).toBe(true)
    expect(activityMeansWorking('user')).toBe(true)
    expect(activityMeansWorking('')).toBe(true)
  })

  it('does not count a subagent finishing as the pane working', () => {
    // Both spellings, because both jam the loop the same way. claude reports it
    // through its hook; opencode and kilo through their reader. Missing the
    // second one is how the fix for claude failed to reach the vendors the
    // tool-signal work had just brought into range.
    expect(activityMeansWorking('hook:subagent_stop')).toBe(false)
    expect(activityMeansWorking('subagent:done')).toBe(false)
  })

  it('still counts a subagent STARTING, and ordinary tool use', () => {
    // Only the finishing event is a borrowed timestamp. A tool call — including
    // the one that dispatches a subagent — really is this pane working.
    expect(activityMeansWorking('tool:task')).toBe(true)
    expect(activityMeansWorking('tool:read')).toBe(true)
    expect(activityMeansWorking('hook:pre_tool_use')).toBe(true)
  })

  it('the two subagent spellings are also kept out of the tool count', () => {
    // Same events, second judgement: neither may be counted as tool use either,
    // since neither has a pairable "started" event.
    expect(detailMeansToolUse('hook:subagent_stop')).toBe(false)
    expect(detailMeansToolUse('subagent:done')).toBe(false)
  })
})

describe('the full wait-then-resume sequence', () => {
  // Walks one real exchange through the actual predicates, which is where the
  // pieces meet: the unit tests above each pass while the SEQUENCE still jams.
  const SETTLE = 1500
  const ARMED = 1000
  const TASK_STARTED = 1100 // PreToolUse(Task) → agent_active
  const TURN_ENDED = 1200 // "still waiting" → Stop hook → turn_complete
  const SUBAGENT_DONE = 5000 // SubagentStop

  it('holds the loop while the subagent runs', () => {
    expect(loopWaitingOnSubagents({ pending: 1, observedAt: TURN_ENDED, now: 1300 })).toBe(true)
  })

  it('lets the loop continue once the subagent is done', () => {
    // The gate opens (count back to zero) AND the continue verdict must agree.
    expect(loopWaitingOnSubagents({ pending: 0, observedAt: SUBAGENT_DONE, now: 9000 })).toBe(false)
    expect(
      loopContinueReady({
        turnCompleteAt: TURN_ENDED,
        // SubagentStop did NOT advance the clock — activityMeansWorking said no.
        lastActiveAt: TASK_STARTED,
        armedAt: ARMED,
        now: 9000,
        settleMs: SETTLE,
      })
    ).toBe(true)
  })

  it('would jam forever if SubagentStop advanced the activity clock', () => {
    // The regression this pins: turnCompleteDone requires the turn end to be
    // the LATEST signal, so an activity stamp landing after it can never be
    // overtaken by anything except a NEW turn — and a main agent that stays
    // idle never produces one. Silent, and fails CLOSED.
    expect(
      loopContinueReady({
        turnCompleteAt: TURN_ENDED,
        lastActiveAt: SUBAGENT_DONE,
        armedAt: ARMED,
        now: 9000,
        settleMs: SETTLE,
      })
    ).toBe(false)
  })
})

describe('detailMeansToolUse', () => {
  it('accepts both sources that report tool use today', () => {
    expect(detailMeansToolUse('hook:pre_tool_use')).toBe(true) // claude, via hook
    expect(detailMeansToolUse('tool:read')).toBe(true) // opencode, via its reader
    expect(detailMeansToolUse('tool:unknown')).toBe(true)
  })

  it('rejects the coarse details every other vendor reports', () => {
    // These are all a vendor says today. Counting them as tool use would make
    // turnUsedNoTools fire on ordinary talking turns.
    for (const d of ['assistant', 'assistant:thinking', 'user', 'prompt', 'usage', 'token_count', '']) {
      expect(detailMeansToolUse(d)).toBe(false)
    }
  })

  it('does not mistake a subagent event for tool use', () => {
    // opencode reports subagent:done with no matching "started", so it can
    // never be paired into a count — and it is not the pane using a tool.
    expect(detailMeansToolUse('subagent:done')).toBe(false)
    expect(detailMeansToolUse('hook:subagent_stop')).toBe(false)
  })
})

describe('LOOP_WAIT backoff and budget', () => {
  const FRESH = { consecutive: 0, totalWaitedMs: 0 }

  it('holds longer each consecutive wait, then clamps', () => {
    expect(loopWaitBackoffMs(0)).toBe(0)
    expect(loopWaitBackoffMs(1)).toBe(LOOP_WAIT_BACKOFF_MS[0])
    expect(loopWaitBackoffMs(2)).toBe(LOOP_WAIT_BACKOFF_MS[1])
    expect(loopWaitBackoffMs(3)).toBe(LOOP_WAIT_BACKOFF_MS[2])
    expect(loopWaitBackoffMs(99)).toBe(LOOP_WAIT_BACKOFF_MS[LOOP_WAIT_BACKOFF_MS.length - 1])
  })

  it('counts a wait and charges its hold against the budget', () => {
    const after = applyLoopWait(FRESH, true)
    expect(after.consecutive).toBe(1)
    expect(after.totalWaitedMs).toBe(LOOP_WAIT_BACKOFF_MS[0])
  })

  it('any other turn ends the streak but keeps the spent budget', () => {
    // The streak resets so the next wait starts its backoff from the bottom;
    // the budget does not, because it bounds the whole RUN.
    const waited = applyLoopWait(applyLoopWait(FRESH, true), true)
    const worked = applyLoopWait(waited, false)
    expect(worked.consecutive).toBe(0)
    expect(worked.totalWaitedMs).toBe(waited.totalWaitedMs)
  })

  it('stops honouring the marker once the budget is spent — the fail-OPEN bound', () => {
    // Without this an agent emitting LOOP_WAIT every turn parks the loop for
    // good, silently: the same fail-CLOSED shape the subagent gate is bounded
    // against. Past the budget, ordinary continues resume and the stall
    // detector gets to see those turns.
    expect(loopWaitHonoured(FRESH)).toBe(true)
    expect(loopWaitHonoured({ consecutive: 9, totalWaitedMs: LOOP_WAIT_TOTAL_MAX_MS - 1 })).toBe(true)
    expect(loopWaitHonoured({ consecutive: 9, totalWaitedMs: LOOP_WAIT_TOTAL_MAX_MS })).toBe(false)
  })

  it('a marker-every-turn run exhausts its budget in bounded time', () => {
    let st = FRESH
    let turns = 0
    while (loopWaitHonoured(st) && turns < 1000) {
      st = applyLoopWait(st, true)
      turns++
    }
    expect(turns).toBeLessThan(1000) // it terminates at all
    expect(st.totalWaitedMs).toBeGreaterThanOrEqual(LOOP_WAIT_TOTAL_MAX_MS)
  })
})

describe('a LOOP_WAIT turn reported twice still climbs the backoff', () => {
  // Claude's Stop hook reports the turn end first and carries no text; the
  // reader's copy with the <<LOOP_WAIT>> text follows. Judged as "any other
  // turn", the empty copy reset the streak every time, so the text re-opened
  // it at 1 and the hold never left the 60s tier. An empty-text turn is
  // UNKNOWN to the wait judgement — the same rule applyTurnProgress applies.
  const FRESH = { consecutive: 0, totalWaitedMs: 0 }
  const WAIT_TEXT = '仍在等背景測試回報。\n\n<<LOOP_WAIT>>'
  /** noteLoopWait's classification of one turn_complete's text. */
  const judged = (text: string): boolean | null => (text ? turnEndsWithSentinel(text, '<<LOOP_WAIT>>') : null)

  it('two turns of [hook copy, then LOOP_WAIT text] count as two consecutive waits', () => {
    let st = FRESH
    for (let turn = 0; turn < 2; turn++) {
      st = applyLoopWait(st, judged(''))
      st = applyLoopWait(st, judged(WAIT_TEXT))
    }
    expect(st.consecutive).toBe(2)
    expect(loopWaitBackoffMs(st.consecutive)).toBe(LOOP_WAIT_BACKOFF_MS[1])
  })

  it('an empty copy after the text does not end the streak either', () => {
    let st = applyLoopWait(FRESH, judged(WAIT_TEXT))
    st = applyLoopWait(st, judged(''))
    expect(st.consecutive).toBe(1)
  })

  it('a real other turn still ends the streak', () => {
    const waited = applyLoopWait(applyLoopWait(FRESH, true), true)
    expect(applyLoopWait(waited, judged('Fixed the parser and reran the suite; all green.')).consecutive).toBe(0)
  })
})

describe('the two loop markers stay distinct', () => {
  it('a waiting turn is not read as a finished one, and vice versa', () => {
    const waiting = '仍在等背景測試回報。\n\n<<LOOP_WAIT>>'
    const finished = '全部完成。\n\n<<LOOP_DONE>>'
    expect(turnEndsWithSentinel(waiting, '<<LOOP_WAIT>>')).toBe(true)
    expect(turnEndsWithSentinel(waiting, '<<LOOP_DONE>>')).toBe(false)
    expect(turnEndsWithSentinel(finished, '<<LOOP_DONE>>')).toBe(true)
    expect(turnEndsWithSentinel(finished, '<<LOOP_WAIT>>')).toBe(false)
  })

  it('mentioning a marker mid-text never counts', () => {
    const mention = `完成時我會輸出 <<LOOP_WAIT>>。\n目前還在跑第 2 階段。`
    expect(turnEndsWithSentinel(mention, '<<LOOP_WAIT>>')).toBe(false)
  })
})

describe('the opencode / kilo wait-then-resume sequence', () => {
  // The same sequence that jammed for claude, in the spelling opencode and kilo
  // use. Their reader names a subagent finishing `subagent:done` rather than
  // `hook:subagent_stop`, so the fix for claude did not reach them until both
  // spellings were listed — and the tool-signal work had just brought these two
  // vendors into range of exactly this judgement.
  const SETTLE = 1500
  const ARMED = 1000
  const TOOL_CALL = 1100 // tool:task → agent_active
  const TURN_ENDED = 1200 // "still waiting" → turn_complete
  const SUBAGENT_DONE = 5000 // subagent:done

  it('a tool call advances the loop clock', () => {
    expect(activityMeansWorking('tool:task')).toBe(true)
  })

  it('the subagent finishing does NOT advance it', () => {
    expect(activityMeansWorking('subagent:done')).toBe(false)
  })

  it('so the loop can still continue once the subagent is done', () => {
    expect(
      loopContinueReady({
        turnCompleteAt: TURN_ENDED,
        lastActiveAt: TOOL_CALL, // subagent:done was not allowed to stamp this
        armedAt: ARMED,
        now: 9000,
        settleMs: SETTLE,
      })
    ).toBe(true)
  })

  it('and would jam forever if subagent:done were treated as work', () => {
    expect(
      loopContinueReady({
        turnCompleteAt: TURN_ENDED,
        lastActiveAt: SUBAGENT_DONE,
        armedAt: ARMED,
        now: 9000,
        settleMs: SETTLE,
      })
    ).toBe(false)
  })

  it('counts the tool call as work, so the turn is not judged a stall', () => {
    const worked = { toolUsesThisTurn: 1, toolSignalsSeen: true }
    expect(turnUsedNoTools(worked)).toBe(false)
    // …while a turn that only talked, on the same vendor, still is.
    expect(turnUsedNoTools({ toolUsesThisTurn: 0, toolSignalsSeen: true })).toBe(true)
  })
})

describe('recordTurnComplete', () => {
  const TOL = 60_000
  const NOW = 2_000_000

  it('records a live turn end, stamped with now', () => {
    const map = new Map<string, number>()
    expect(recordTurnComplete(map, 'p1', String(NOW - 5_000), NOW, TOL)).toBe(true)
    expect(map.get('p1')).toBe(NOW)
  })

  it('ignores a replayed historical turn end (backend restart re-parse)', () => {
    const map = new Map<string, number>()
    const old = new Date(NOW - TOL - 5_000).toISOString()
    expect(recordTurnComplete(map, 'p1', old, NOW, TOL)).toBe(false)
    expect(map.has('p1')).toBe(false)
  })

  it('leaves an existing live stamp untouched when a replay arrives after it', () => {
    const map = new Map<string, number>([['p1', NOW - 1_000]])
    recordTurnComplete(map, 'p1', String(NOW - TOL - 1), NOW, TOL)
    expect(map.get('p1')).toBe(NOW - 1_000)
  })

  it('treats a missing timestamp as live so a vendor without one still records', () => {
    const map = new Map<string, number>()
    expect(recordTurnComplete(map, 'p1', '', NOW, TOL)).toBe(true)
    expect(map.get('p1')).toBe(NOW)
  })
})

describe('paneSignalResetKeys', () => {
  const pipelinePanes = new Set(['pipe-1', 'pipe-2'])
  const livePanes = new Set(['pipe-1', 'pipe-2', 'manual-1'])

  it('drops the pipeline run\'s own pane keys', () => {
    const keys = paneSignalResetKeys(['pipe-1', 'pipe-2'], pipelinePanes, livePanes)
    expect(keys.sort()).toEqual(['pipe-1', 'pipe-2'])
  })

  it('KEEPS a live manual pane, whose /loop reads the same maps', () => {
    // Zeroing turnCompleteAt for a pane running /loop made loopContinueReady
    // permanently false: it needs turnCompleteAt > armedAt, and an idle CLI
    // never produces a fresh turn end to replace the one that was deleted.
    expect(paneSignalResetKeys(['manual-1'], pipelinePanes, livePanes)).toEqual([])
  })

  it('drops keys for panes that no longer exist, so the maps cannot grow', () => {
    expect(paneSignalResetKeys(['gone-1'], pipelinePanes, livePanes)).toEqual(['gone-1'])
  })

  it('separates the three cases in one pass', () => {
    const keys = paneSignalResetKeys(
      ['pipe-1', 'manual-1', 'gone-1', 'pipe-2'],
      pipelinePanes,
      livePanes
    )
    expect(keys).toEqual(['pipe-1', 'gone-1', 'pipe-2'])
  })
})

// A quota-exhausted turn ENDS — the CLI prints its limit message and returns to
// the prompt — so every timing condition in these predicates holds and the
// stage used to read it as the slot finishing its work.
describe('quota-blocked slots and turns', () => {
  const ARMED = 1_000

  it('slotFinished refuses a turn_complete produced by running out of quota', () => {
    expect(
      slotFinished({ sentinelSeen: false, turnCompleteAt: 2_000, armedAt: ARMED })
    ).toBe(true)
    expect(
      slotFinished({
        sentinelSeen: false,
        turnCompleteAt: 2_000,
        armedAt: ARMED,
        quotaBlocked: true
      })
    ).toBe(false)
  })

  it('lets the sentinel outrank the quota block', () => {
    // Printing the done-marker is a positive statement that the work finished;
    // running out of quota afterwards does not un-finish it.
    expect(
      slotFinished({
        sentinelSeen: true,
        turnCompleteAt: 2_000,
        armedAt: ARMED,
        quotaBlocked: true
      })
    ).toBe(true)
  })

  it('keeps a stage un-finished while any one slot is out of quota', () => {
    // This is the assertion that stops the false N/N: the other slots really
    // did finish, and before this the stage advanced on their signals alone.
    const done: SlotSignal = { sentinelSeen: true, turnCompleteAt: 0, armedAt: ARMED }
    const spent: SlotSignal = {
      sentinelSeen: false,
      turnCompleteAt: 2_000,
      armedAt: ARMED,
      quotaBlocked: true
    }
    expect(allSlotsFinished([done, spent])).toBe(false)
    expect(allSlotsFinished([done, { ...spent, quotaBlocked: false }])).toBe(true)
  })

  it('turnCompleteDone refuses a quota-blocked pane', () => {
    const settled = {
      turnCompleteAt: 2_000,
      lastActiveAt: 1_500,
      armedAt: ARMED,
      now: 2_000 + 10_000,
      settleMs: 1_000
    }
    expect(turnCompleteDone(settled)).toBe(true)
    expect(turnCompleteDone({ ...settled, quotaBlocked: true })).toBe(false)
  })

  it('leaves a caller that does not opt in exactly as it was', () => {
    // The field is optional on purpose — turnCompleteDone has three consumers
    // (stage watcher, done notification, loopContinueReady) and only the ones
    // that pass it change behaviour.
    const settled = {
      turnCompleteAt: 2_000,
      lastActiveAt: 1_500,
      armedAt: ARMED,
      now: 2_000 + 10_000,
      settleMs: 1_000
    }
    expect(turnCompleteDone({ ...settled, quotaBlocked: undefined })).toBe(true)
    expect(turnCompleteDone({ ...settled, quotaBlocked: false })).toBe(true)
    expect(
      slotFinished({ sentinelSeen: false, turnCompleteAt: 2_000, armedAt: ARMED, quotaBlocked: false })
    ).toBe(true)
  })

  it('carries the block through loopContinueReady, closing the resend hole', () => {
    // The loop's own fail-open path: when a limit message carries no readable
    // reset time the loop notifies and leaves loopWaitUntil null, so the next
    // poll falls through to auto-continue and resends into the exhausted CLI.
    const woken = {
      turnCompleteAt: 2_000,
      lastActiveAt: 1_500,
      armedAt: 1_000,
      now: 2_000 + 10_000,
      settleMs: 1_000
    }
    expect(loopContinueReady(woken)).toBe(true)
    expect(loopContinueReady({ ...woken, quotaBlocked: true })).toBe(false)
  })
})

// The gap this does NOT close, written down as a test so the boundary is
// explicit rather than assumed: a turn that died on the quota keeps its
// turn_complete, so once the block lifts that stale signal is accepted again.
//
// Two rules were tried here and both withdrawn — see the KNOWN GAP note in
// completion.ts. `turnCompleteAt` is the receipt time, not when the turn ended,
// and no comparison against it can tell a delayed poisoned event from a fresh
// one without hanging stages that really did finish.
describe('a turn that died on the quota is told apart by its OWN clock', () => {
  const ARMED = 1_000
  const SEEN = 100_000   // when the block was DETECTED

  // Gap A, closed. The two withdrawn attempts and why they failed are in the
  // note above quotaTurnIsFresh; the two lettered cases below are the
  // event-interleaving scenarios the independent review named as the real
  // acceptance criteria — each one killed one of those attempts.

  it('records the event clock beside the receipt clock, in one write', () => {
    const receipt = new Map<string, number>()
    const source = new Map<string, number>()
    const now = 1_700_000_000_000
    expect(recordTurnComplete(receipt, 'p', new Date(now - 500).toISOString(), now, 60_000, source))
      .toBe(true)
    expect(receipt.get('p')).toBe(now)          // receipt stays `now`
    expect(source.get('p')).toBe(now - 500)     // …and the event keeps its own
  })

  it('stores 0 for a vendor whose stamp does not parse', () => {
    const receipt = new Map<string, number>()
    const source = new Map<string, number>()
    const now = 1_700_000_000_000
    expect(recordTurnComplete(receipt, 'p', 'not-a-date', now, 60_000, source)).toBe(true)
    expect(source.get('p')).toBe(0)
  })

  it('writes neither map for a replayed event', () => {
    const receipt = new Map<string, number>()
    const source = new Map<string, number>()
    const now = 1_700_000_000_000
    expect(recordTurnComplete(receipt, 'p', new Date(now - 120_000).toISOString(), now, 60_000, source))
      .toBe(false)
    expect(receipt.size).toBe(0)
    expect(source.size).toBe(0)
  })

  it('A · refuses the failed turn even when its event arrives after the lift', () => {
    // The case that killed attempt #2: the turn died BEFORE the block was
    // detected, but its event was received afterwards and inside the replay
    // tolerance, so the receipt clock made it look new. Its own clock does not.
    expect(slotFinished({
      sentinelSeen: false,
      turnCompleteAt: SEEN + 30_000,   // received well after the lift
      armedAt: ARMED,
      quotaBlocked: false,             // block already lifted
      quotaSeenAt: SEEN,
      turnSourceAt: SEEN - 1_000       // …but it ENDED before the block was seen
    })).toBe(false)
  })

  it('B · accepts a retry that finished before the flag was even cleared', () => {
    // The case that killed both attempts in the other direction: a real retry
    // ran right after the deadline and finished before the 5s health poll
    // cleared the flag. Anchoring on the LIFT rejected it forever; anchoring on
    // DETECTION accepts it, which is correct — it ran after the block was seen.
    expect(slotFinished({
      sentinelSeen: false,
      turnCompleteAt: SEEN + 6_000,
      armedAt: ARMED,
      quotaBlocked: false,
      quotaSeenAt: SEEN,
      turnSourceAt: SEEN + 1_000
    })).toBe(true)
  })

  it('fails open for a vendor with no usable clock', () => {
    // Same direction isReplayedTurnComplete already takes. A vendor whose
    // stamps do not parse must not lose the ability to finish a stage.
    expect(slotFinished({
      sentinelSeen: false, turnCompleteAt: SEEN + 6_000, armedAt: ARMED,
      quotaSeenAt: SEEN, turnSourceAt: 0
    })).toBe(true)
  })

  it('leaves a pane that never hit the quota untouched', () => {
    expect(slotFinished({
      sentinelSeen: false, turnCompleteAt: 2_000, armedAt: ARMED,
      quotaSeenAt: 0, turnSourceAt: 0
    })).toBe(true)
  })

  it('refuses it outright while the block still stands', () => {
    expect(slotFinished({
      sentinelSeen: false, turnCompleteAt: 2_000, armedAt: ARMED, quotaBlocked: true
    })).toBe(false)
  })

  it('still lets the sentinel through', () => {
    expect(slotFinished({
      sentinelSeen: true, turnCompleteAt: SEEN + 30_000, armedAt: ARMED,
      quotaSeenAt: SEEN, turnSourceAt: SEEN - 1_000
    })).toBe(true)
  })

  it('applies the same pair in turnCompleteDone, where base rules all pass', () => {
    // Discriminating on purpose: with lastActiveAt before the turn end every
    // base condition holds, so only the freshness rule can refuse it. An
    // earlier version of this test picked a case the base rules already
    // rejected and could not see the new rule at all.
    const base = {
      turnCompleteAt: SEEN + 30_000, lastActiveAt: SEEN + 20_000, armedAt: ARMED,
      now: SEEN + 60_000, settleMs: 1_000
    }
    expect(turnCompleteDone(base)).toBe(true)
    expect(turnCompleteDone({ ...base, quotaSeenAt: SEEN, turnSourceAt: SEEN - 1_000 })).toBe(false)
    expect(turnCompleteDone({ ...base, quotaSeenAt: SEEN, turnSourceAt: SEEN + 1_000 })).toBe(true)
  })

  it('quotaTurnIsFresh: the anchor instant itself is not "after"', () => {
    expect(quotaTurnIsFresh(undefined, 5)).toBe(true)
    expect(quotaTurnIsFresh(0, 0)).toBe(true)
    expect(quotaTurnIsFresh(SEEN, 0)).toBe(true)          // no clock → open
    expect(quotaTurnIsFresh(SEEN, SEEN - 1)).toBe(false)
    expect(quotaTurnIsFresh(SEEN, SEEN)).toBe(false)
    expect(quotaTurnIsFresh(SEEN, SEEN + 1)).toBe(true)
  })
})

// The LIMITS of quotaTurnIsFresh, asserted rather than assumed. All three came
// from independent review, and each one is a case where an earlier version of
// the comment above the rule claimed a guarantee the repo does not give.
describe('quotaTurnIsFresh · what it does NOT do', () => {
  const ARMED = 1_000
  const SEEN = 100_000

  it('lets a FUTURE source stamp through — the replay filter is one-sided', () => {
    // isReplayedTurnComplete only refuses events that are too OLD
    // (now - eventMs > tolerance), so nothing bounds a stamp from the future.
    const now = 1_700_000_000_000
    const receipt = new Map<string, number>()
    const source = new Map<string, number>()
    const future = new Date(now + 10 * 60_000).toISOString()
    expect(recordTurnComplete(receipt, 'p', future, now, 60_000, source)).toBe(true)
    expect(source.get('p')).toBeGreaterThan(now)
    // …and such a stamp satisfies the freshness rule whatever it means.
    expect(quotaTurnIsFresh(now, source.get('p'))).toBe(true)
  })

  it('is defeated by a vendor that stamps with its SCAN clock', () => {
    // cursor has no per-message timestamp at all: cli_vendors/cursor.py's
    // _store_epoch falls back to meta.json updatedAtMs and then to time.time(),
    // nudging each event 1ms past the last. Such a stamp can post-date the
    // detection of the block, and the failed turn then passes.
    const scanStampedAfterDetection = SEEN + 2_000
    expect(quotaTurnIsFresh(SEEN, scanStampedAfterDetection)).toBe(true)
    expect(slotFinished({
      sentinelSeen: false, turnCompleteAt: SEEN + 3_000, armedAt: ARMED,
      quotaBlocked: false, quotaSeenAt: SEEN, turnSourceAt: scanStampedAfterDetection
    })).toBe(true)   // ← the gap, still open for this vendor shape
  })

  it('rejects a real retry when the block was detected only afterwards', () => {
    // Detection is a 5s poll on an unconsumed tail, so a limit message can be
    // read AFTER a successful retry has already finished (account switched,
    // short turn). The anchor then post-dates that retry.
    //
    // Asserting the LIMIT: narrower than the ordering that killed the previous
    // two attempts, where EVERY retry finishing before the lift was rejected.
    expect(slotFinished({
      sentinelSeen: false, turnCompleteAt: SEEN + 1_000, armedAt: ARMED,
      quotaBlocked: false, quotaSeenAt: SEEN, turnSourceAt: SEEN - 500
    })).toBe(false)
    // The escape hatch that keeps it from being permanent: the sentinel, and
    // any later turn.
    expect(slotFinished({
      sentinelSeen: true, turnCompleteAt: SEEN + 1_000, armedAt: ARMED,
      quotaSeenAt: SEEN, turnSourceAt: SEEN - 500
    })).toBe(true)
  })
})

describe('turnTextFingerprint', () => {
  // The dedupe of last resort: the timestamp gate reads an unparseable stamp as
  // fresh, so for those vendors the same turn was re-dispatched every time it
  // was re-reported — the MSG blocks in it sent again with no ceiling.
  it('is stable for the same text', () => {
    const text = '---MSG-START---\nto: reviewer\ndone\n---MSG-END---'
    expect(turnTextFingerprint(text)).toBe(turnTextFingerprint(text))
  })

  it('separates turns that differ only at the very end', () => {
    expect(turnTextFingerprint('report A')).not.toBe(turnTextFingerprint('report B'))
  })

  it('separates turns that differ only at the very start', () => {
    expect(turnTextFingerprint('A report')).not.toBe(turnTextFingerprint('B report'))
  })

  it('separates a repeated block from the same block sent twice in one turn', () => {
    // Two identical MSG blocks in one turn are two messages; the same block
    // arriving in a later turn is a replay. Length alone cannot tell them
    // apart, which is why the hash is length-prefixed rather than length-only.
    const once = 'send it'
    expect(turnTextFingerprint(once)).not.toBe(turnTextFingerprint(once + once))
  })

  it('is order-sensitive, not a character sum', () => {
    expect(turnTextFingerprint('ab')).not.toBe(turnTextFingerprint('ba'))
  })

  it('handles an empty turn without collapsing it onto a real one', () => {
    expect(turnTextFingerprint('')).not.toBe(turnTextFingerprint(' '))
  })
})
