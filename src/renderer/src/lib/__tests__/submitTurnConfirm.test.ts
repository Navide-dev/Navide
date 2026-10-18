import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { SubmitEvidence } from '../injectEcho'
import { kickoffAttemptOutcome } from '../spawnKickoff'
import { confirmWeakSubmit, SUBMIT_TURN_CONFIRM_MS } from '../submitTurnConfirm'

/** A fake clock: sleep advances it, nothing really waits. */
function harness(opts: {
  how: SubmitEvidence
  turnAfterMs?: number
  held?: () => boolean | null
  abortAfterMs?: number
}) {
  let t = 0
  const slept: number[] = []
  let enters = 0
  const run = confirmWeakSubmit({
    how: opts.how,
    turnStarted: () => opts.turnAfterMs !== undefined && t >= opts.turnAfterMs,
    collapsedHeld: opts.held ?? (() => false),
    pressEnter: async () => { enters++; return true },
    aborted: () => opts.abortAfterMs !== undefined && t >= opts.abortAfterMs,
    sleep: async (ms) => { slept.push(ms); t += ms },
    now: () => t,
  })
  return { run, slept: () => slept, enters: () => enters, elapsed: () => t }
}

describe('confirmWeakSubmit', () => {
  // The strong verdicts watched our own text leave the box (or the CLI's own
  // queue hint appear): they must never pay the turn wait.
  it.each(['tail-left', 'queued', 'unconfirmed'] as const)('returns %s at once, without waiting', async (how) => {
    const h = harness({ how })
    expect(await h.run).toBe(how)
    expect(h.slept()).toEqual([])
    expect(h.enters()).toBe(0)
  })

  it('watches for 10–15 seconds', () => {
    expect(SUBMIT_TURN_CONFIRM_MS).toBeGreaterThanOrEqual(10_000)
    expect(SUBMIT_TURN_CONFIRM_MS).toBeLessThanOrEqual(15_000)
  })

  it('upgrades growth to turn as soon as the CLI starts a new turn', async () => {
    const h = harness({ how: 'growth', turnAfterMs: 600 })
    expect(await h.run).toBe('turn')
    expect(h.elapsed()).toBeLessThan(1_000)
  })

  it('answers unconfirmed when no new turn shows up in the window', async () => {
    const h = harness({ how: 'growth' })
    expect(await h.run).toBe('unconfirmed')
    expect(h.elapsed()).toBeGreaterThanOrEqual(SUBMIT_TURN_CONFIRM_MS)
    expect(h.enters()).toBe(0)
  })

  it('presses Enter at most once while the box still holds the collapsed paste', async () => {
    const h = harness({ how: 'growth', held: () => true })
    expect(await h.run).toBe('unconfirmed')
    expect(h.enters()).toBe(1)
  })

  it('confirms the turn the extra Enter started', async () => {
    let t = 0
    let entered = -1
    const how = await confirmWeakSubmit({
      how: 'growth',
      turnStarted: () => entered >= 0 && t > entered,
      collapsedHeld: () => entered < 0,
      pressEnter: async () => { entered = t; return true },
      aborted: () => false,
      sleep: async (ms) => { t += ms },
      now: () => t,
    })
    expect(how).toBe('turn')
  })

  it('never presses Enter on a box it cannot locate or that is empty', async () => {
    for (const held of [() => null, () => false]) {
      const h = harness({ how: 'growth', held })
      await h.run
      expect(h.enters()).toBe(0)
    }
  })

  it('answers null once the injection is aborted', async () => {
    const h = harness({ how: 'growth', abortAfterMs: 400 })
    expect(await h.run).toBeNull()
  })
})

describe('an unconfirmed kickoff submit is never retyped', () => {
  // Enter went out; a blank composer then means it most likely took, and a
  // second copy would run the task twice.
  it('stops on unverified even with a blank composer and attempts left', () => {
    expect(kickoffAttemptOutcome({
      injected: true, echo: 'placeholder', submit: 'unconfirmed', promptReady: true,
      composerHolds: () => false, attempt: 1, maxAttempts: 3,
    })).toEqual({ outcome: 'unverified', next: 'stop', retriedOut: false })
  })

  it('counts a confirmed turn as sent', () => {
    expect(kickoffAttemptOutcome({
      injected: true, echo: 'placeholder', submit: 'turn', promptReady: false,
      composerHolds: () => false, attempt: 1, maxAttempts: 3,
    }).outcome).toBe('sent')
  })
})

describe('injectText routes every submit verdict through confirmWeakSubmit', () => {
  const app = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
  const start = app.indexOf('async function injectText(')
  const fn = app.slice(start, app.indexOf('\n}\n', start))

  it('confirms before reporting, and reports what it settled on', () => {
    expect(fn).toContain('const settled = await confirmWeakSubmit({')
    expect(fn).toContain('if (evidence) evidence.submit = settled')
  })
})
