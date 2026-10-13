import { describe, expect, it, vi } from 'vitest'

import {
  createKickoffReporter, kickoffAttemptOutcome, paneStillStarting, promptReadyNow, runKickoffAttempts,
  submitHeldCopy, terminalKickoffOutcome, type KickoffAttemptEvidence,
} from '../spawnKickoff'

describe('terminalKickoffOutcome', () => {
  it('is sent only on payload-level evidence', () => {
    expect(terminalKickoffOutcome({ typed: true, echo: 'tail', submit: 'tail-left', promptReady: true }))
      .toBe('sent')
  })

  it('is unverified, never failed, once the command was typed — a resend would run it again', () => {
    expect(terminalKickoffOutcome({ typed: true, echo: 'growth', submit: 'growth', promptReady: false }))
      .toBe('unverified')
    expect(terminalKickoffOutcome({ typed: true, echo: null, submit: null, promptReady: true }))
      .toBe('unverified')
  })

  it('is failed only when nothing was typed', () => {
    expect(terminalKickoffOutcome({ typed: false, echo: null, submit: null, promptReady: true }))
      .toBe('failed')
  })
})

describe('kickoffAttemptOutcome', () => {
  const base = {
    injected: true,
    echo: 'growth' as const,
    submit: 'growth' as const,
    promptReady: false,
    composerHolds: () => false,
    attempt: 1,
    maxAttempts: 2,
  }

  it('fails outright when the bytes never went in', () => {
    expect(kickoffAttemptOutcome({ ...base, injected: false })).toEqual({
      outcome: 'failed', next: 'stop', retriedOut: false,
    })
  })

  it('settles sent on verified evidence without consulting the composer', () => {
    const composerHolds = vi.fn(() => true)
    expect(
      kickoffAttemptOutcome({ ...base, echo: 'tail', submit: 'tail-left', composerHolds }),
    ).toEqual({ outcome: 'sent', next: 'stop', retriedOut: false })
    expect(composerHolds).not.toHaveBeenCalled()
  })

  // The collapsed-paste case cli_open_agent's multi-line tasks always take:
  // the summary says our paste landed, and past the gate the growth after
  // Enter is the CLI reacting to it.
  it('settles sent on a growth-only submit once the prompt-ready gate opened', () => {
    expect(kickoffAttemptOutcome({ ...base, echo: 'placeholder', promptReady: true })).toEqual({
      outcome: 'sent', next: 'stop', retriedOut: false,
    })
  })

  // Growth on the ECHO half is the pane repainting, gate or not — see
  // kickoffVerified. The retype guard, not a 'sent', is what has to answer it.
  it('does not settle sent on a growth-only echo, gate or not', () => {
    expect(kickoffAttemptOutcome({ ...base, promptReady: true })).toEqual({
      outcome: 'unverified', next: 'retype', retriedOut: false,
    })
  })

  // The one the retry loop exists for. Typing a second copy on top of the
  // first submits both as one prompt, and so does a cli_send resend — which is
  // why this settles 'unverified' (the caller is told to look, not to resend)
  // rather than 'failed'.
  it('stops at unverified — never retypes — while the composer still holds the first copy', () => {
    expect(kickoffAttemptOutcome({ ...base, composerHolds: () => true })).toEqual({
      outcome: 'unverified', next: 'stop', retriedOut: false,
    })
  })

  it('retypes only when the composer is blank', () => {
    expect(kickoffAttemptOutcome({ ...base, composerHolds: () => false })).toEqual({
      outcome: 'unverified', next: 'retype', retriedOut: false,
    })
  })

  it('gives up as failed on the last attempt once the composer is blank', () => {
    expect(kickoffAttemptOutcome({ ...base, attempt: 2, composerHolds: () => false })).toEqual({
      outcome: 'failed', next: 'stop', retriedOut: true,
    })
  })

  // 'failed' is what sends cli_open_agent's caller into a cli_send resend. On
  // the last attempt the composer can be holding the copy we just typed —
  // unsubmitted, invisible to the growth checks — and that resend then lands a
  // second copy on top of it for the next Enter to submit as one prompt. Two
  // copies of the task is the failure the retype guard exists to prevent; the
  // count of attempts must not be allowed to talk past it.
  it('stays unverified on the last attempt while the composer holds the copy', () => {
    expect(kickoffAttemptOutcome({ ...base, attempt: 2, composerHolds: () => true })).toEqual({
      outcome: 'unverified', next: 'stop', retriedOut: false,
    })
  })

  it('reads the composer at most once per attempt', () => {
    const composerHolds = vi.fn(() => false)
    kickoffAttemptOutcome({ ...base, composerHolds })
    expect(composerHolds).toHaveBeenCalledTimes(1)
  })
})

describe('runKickoffAttempts', () => {
  /** Deps with everything inert; each test says what it actually cares about. */
  function deps(over: Partial<Parameters<typeof runKickoffAttempts>[0]> = {}) {
    return {
      maxAttempts: 2,
      promptReady: false,
      paneStarting: false,
      inject: async (): Promise<KickoffAttemptEvidence> =>
        ({ injected: true, echo: 'growth', submit: 'growth' }),
      composerHolds: () => false,
      paneAlive: () => true,
      onRetry: () => {},
      ...over,
    }
  }

  it('settles on the first attempt when the evidence is there', async () => {
    const inject = vi.fn(async () => ({ injected: true, echo: 'tail', submit: 'tail-left' } as const))
    await expect(runKickoffAttempts(deps({ inject }))).resolves.toEqual({
      settled: true, outcome: 'sent', retriedOut: false, echo: 'tail', submit: 'tail-left',
    })
    expect(inject).toHaveBeenCalledTimes(1)
  })

  // Bug class 1: the second attempt judged on the FIRST attempt's evidence.
  // While the loop lived inline this was one mutable object reset by hand at
  // the top of each iteration; forget the reset and a pane that finally echoed
  // its task on the retype still reported the first attempt's "nothing seen".
  it('judges each attempt on its own evidence, not the previous one', async () => {
    const seen: Array<KickoffAttemptEvidence> = [
      { injected: true, echo: 'growth', submit: 'growth' },
      { injected: true, echo: 'tail', submit: 'tail-left' },
    ]
    const inject = vi.fn(async (attempt: number) => seen[attempt - 1])
    await expect(runKickoffAttempts(deps({ inject }))).resolves.toEqual({
      settled: true, outcome: 'sent', retriedOut: false, echo: 'tail', submit: 'tail-left',
    })
    expect(inject).toHaveBeenCalledTimes(2)
  })

  // Bug class 2: a counter that never advances. The last-attempt rule is the
  // only thing that ends an unverifiable kickoff, so a stuck counter types the
  // task forever — or, with the guard inverted, gives up after one go.
  it('advances the attempt counter and stops at maxAttempts', async () => {
    // Typed parameter, not an ignored one: the assertion below reads the
    // recorded arguments, and vi.fn() infers an empty tuple without it.
    const inject = vi.fn(async (_attempt: number) =>
      ({ injected: true, echo: 'growth', submit: 'growth' } as const))
    const onRetry = vi.fn()
    await expect(runKickoffAttempts(deps({ inject, onRetry, maxAttempts: 3 }))).resolves.toEqual({
      settled: true, outcome: 'failed', retriedOut: true, echo: 'growth', submit: 'growth',
    })
    expect(inject.mock.calls.map(([n]) => n)).toEqual([1, 2, 3])
    expect(onRetry.mock.calls.map(([i]) => i.attempt)).toEqual([1, 2])
  })

  // Bug class 3: the gate's answer re-read after we have typed. It is a
  // snapshot of the pane we started typing into; asking again once our own
  // paste is on screen asks whether the pane is quiet while we are the reason
  // it is not. Passing it as a value is what makes that unrepresentable — the
  // same answer reaches every attempt.
  it('applies the one-shot gate answer to every attempt alike', async () => {
    const inject = vi.fn(async (attempt: number) => (attempt === 1
      ? { injected: true, echo: 'growth', submit: 'growth' } as const
      : { injected: true, echo: 'placeholder', submit: 'growth' } as const))
    await expect(runKickoffAttempts(deps({ inject, promptReady: true }))).resolves.toEqual({
      settled: true, outcome: 'sent', retriedOut: false, echo: 'placeholder', submit: 'growth',
    })
    // Same evidence, gate shut: the second attempt cannot be talked into 'sent'.
    await expect(runKickoffAttempts(deps({ inject, promptReady: false }))).resolves.toMatchObject({
      settled: true, outcome: 'failed', retriedOut: true,
    })
  })

  // A pane that has printed nothing when the gate gives up is a CLI still
  // initialising, whose raw-mode setup flushes the tty input: typing "anyway"
  // wrote bytes that were eaten and reported the kickoff as sent. Not one byte
  // goes out, and the verdict is the one that tells the caller to resend.
  it('types nothing into a pane still starting when the gate never opened', async () => {
    const inject = vi.fn(async () => ({ injected: true, echo: 'tail', submit: 'tail-left' } as const))
    const onRetry = vi.fn()
    await expect(
      runKickoffAttempts(deps({ inject, onRetry, promptReady: false, paneStarting: true })),
    ).resolves.toEqual({
      settled: true, outcome: 'failed', retriedOut: false, echo: null, submit: null, untyped: true,
    })
    expect(inject).not.toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()
  })

  // A pane that IS printing but never read idle+quiet — a cold CLI on a loaded
  // host — is up, so it is typed into as before; only a starting pane is not.
  it('still types into a printing pane whose prompt never read ready', async () => {
    const inject = vi.fn(async () => ({ injected: true, echo: 'tail', submit: 'tail-left' } as const))
    await expect(
      runKickoffAttempts(deps({ inject, promptReady: false, paneStarting: false })),
    ).resolves.toEqual({
      settled: true, outcome: 'sent', retriedOut: false, echo: 'tail', submit: 'tail-left',
    })
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('types when the gate opened, whatever the pane looked like before', async () => {
    const inject = vi.fn(async () => ({ injected: true, echo: 'tail', submit: 'tail-left' } as const))
    await expect(
      runKickoffAttempts(deps({ inject, promptReady: true, paneStarting: true })),
    ).resolves.toMatchObject({ settled: true, outcome: 'sent' })
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('never retypes over a composer that is holding the first copy', async () => {
    const inject = vi.fn(async () => ({ injected: true, echo: 'growth', submit: 'growth' } as const))
    await expect(runKickoffAttempts(deps({ inject, composerHolds: () => true }))).resolves.toEqual({
      settled: true, outcome: 'unverified', retriedOut: false, echo: 'growth', submit: 'growth',
    })
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('abandons without a verdict when the pane dies before the retype', async () => {
    const inject = vi.fn(async () => ({ injected: true, echo: 'growth', submit: 'growth' } as const))
    const onRetry = vi.fn()
    await expect(runKickoffAttempts(deps({ inject, onRetry, paneAlive: () => false }))).resolves.toEqual({
      settled: false,
    })
    expect(inject).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('stops at once when the bytes never went out', async () => {
    const inject = vi.fn(async () => ({ injected: false, echo: null, submit: null } as const))
    await expect(runKickoffAttempts(deps({ inject }))).resolves.toEqual({
      settled: true, outcome: 'failed', retriedOut: false, echo: null, submit: null,
    })
    expect(inject).toHaveBeenCalledTimes(1)
  })
})

// 10-07 16:16/16:17, two cli_open_agent kickoffs into fresh Claude Code
// panes: both pane logs open with nothing but ESC7 ESC8 — a few raw bytes and
// zero clean ones — while the CLI ran its SessionStart hooks, then the
// bracketed paste, THEN the banner. Any raw byte takes the pane out of
// 'starting', zero clean bytes never move, so idle + 2s quiet opened the gate
// on a CLI that had drawn nothing. One paste was flushed, one landed as a
// collapsed paste whose Enter never took.
describe('promptReadyNow', () => {
  const ready = { status: 'idle', cleanBytes: 1200, quietMs: 2500, quietNeededMs: 2000 }

  it('opens once an idle pane that has drawn something has been quiet long enough', () => {
    expect(promptReadyNow(ready)).toBe(true)
  })

  it('stays shut on an idle pane that has not printed a single clean byte', () => {
    expect(promptReadyNow({ ...ready, cleanBytes: 0, quietMs: 30_000 })).toBe(false)
  })

  it('stays shut while not idle or not quiet long enough', () => {
    expect(promptReadyNow({ ...ready, status: 'running' })).toBe(false)
    expect(promptReadyNow({ ...ready, status: undefined })).toBe(false)
    expect(promptReadyNow({ ...ready, quietMs: 1999 })).toBe(false)
  })
})

describe('paneStillStarting', () => {
  it('treats a pane with raw bytes but no clean output as still starting', () => {
    expect(paneStillStarting({ status: 'idle', cleanBytes: 0 })).toBe(true)
  })

  it('keeps the status machine\'s own starting verdict', () => {
    expect(paneStillStarting({ status: 'starting', cleanBytes: 0 })).toBe(true)
    expect(paneStillStarting({ status: 'starting', cleanBytes: 10 })).toBe(true)
  })

  it('is not starting once the pane has drawn something', () => {
    expect(paneStillStarting({ status: 'idle', cleanBytes: 10 })).toBe(false)
    expect(paneStillStarting({ status: 'running', cleanBytes: 10 })).toBe(false)
  })
})

// 10-07 16:16: the kickoff settled 'unverified' with the task sitting in the
// composer as "[Pasted text #1 +31 lines]" — our own paste, never submitted.
// Stopping there is right for a RETYPE (a second copy would ride along), but
// the one keystroke that finishes the job is Enter, and nothing pressed it:
// the caller resent with cli_send, which reached the CLI through its hook and
// left the paste stranded in the box.
describe('runKickoffAttempts — a held copy is submitted, not abandoned', () => {
  function deps(over: Partial<Parameters<typeof runKickoffAttempts>[0]> = {}) {
    return {
      maxAttempts: 2,
      promptReady: true,
      paneStarting: false,
      inject: async (): Promise<KickoffAttemptEvidence> =>
        ({ injected: true, echo: 'growth', submit: 'growth' }),
      composerHolds: () => true,
      paneAlive: () => true,
      onRetry: () => {},
      ...over,
    }
  }

  it('settles sent once Enter took the held copy out of the composer', async () => {
    const resubmit = vi.fn(async () => true)
    const inject = vi.fn(async () => ({ injected: true, echo: 'growth', submit: 'growth' } as const))
    await expect(runKickoffAttempts(deps({ inject, resubmit }))).resolves.toEqual({
      settled: true, outcome: 'sent', retriedOut: false, echo: 'growth', submit: 'growth',
      resubmitted: true,
    })
    expect(resubmit).toHaveBeenCalledTimes(1)
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('stays unverified, never retyped, when Enter did not take either', async () => {
    const resubmit = vi.fn(async () => false)
    const inject = vi.fn(async () => ({ injected: true, echo: 'growth', submit: 'growth' } as const))
    await expect(runKickoffAttempts(deps({ inject, resubmit }))).resolves.toEqual({
      settled: true, outcome: 'unverified', retriedOut: false, echo: 'growth', submit: 'growth',
    })
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('never presses Enter on a blank composer or a verified kickoff', async () => {
    const resubmit = vi.fn(async () => true)
    await runKickoffAttempts(deps({ resubmit, composerHolds: () => false }))
    await runKickoffAttempts(deps({
      resubmit, inject: async () => ({ injected: true, echo: 'tail', submit: 'tail-left' }),
    }))
    expect(resubmit).not.toHaveBeenCalled()
  })

  it('abandons without a verdict when the pane dies before the Enter', async () => {
    const resubmit = vi.fn(async () => true)
    await expect(runKickoffAttempts(deps({ resubmit, paneAlive: () => false }))).resolves.toEqual({
      settled: false,
    })
    expect(resubmit).not.toHaveBeenCalled()
  })
})

describe('submitHeldCopy', () => {
  /** A fake clock the sleeps advance, and a box whose answers are scripted
   *  per read; the last answer repeats. */
  function harness(answers: Array<boolean | null>, pressOk = true) {
    let t = 0
    let read = 0
    const pressEnter = vi.fn(async () => pressOk)
    return {
      pressEnter,
      run: () => submitHeldCopy({
        held: () => answers[Math.min(read++, answers.length - 1)],
        pressEnter,
        sleep: async (ms: number) => { t += ms },
        now: () => t,
        confirmMs: 1000,
      }),
    }
  }

  it('presses Enter on a held copy and reports it once the box lets go', async () => {
    const h = harness([true, true, false])
    await expect(h.run()).resolves.toBe(true)
    expect(h.pressEnter).toHaveBeenCalledTimes(1)
  })

  it('presses again when the first Enter did not take, up to three', async () => {
    const h = harness([true])
    await expect(h.run()).resolves.toBe(false)
    expect(h.pressEnter).toHaveBeenCalledTimes(3)
  })

  it('never presses on an empty box or a box it cannot locate', async () => {
    for (const first of [false, null]) {
      const h = harness([first])
      await expect(h.run()).resolves.toBe(false)
      expect(h.pressEnter).not.toHaveBeenCalled()
    }
  })

  it('does not call a frameless screen after Enter a release', async () => {
    const h = harness([true, null])
    await expect(h.run()).resolves.toBe(false)
    expect(h.pressEnter).toHaveBeenCalledTimes(1)
  })

  it('gives up when the keystroke cannot be written', async () => {
    const h = harness([true], false)
    await expect(h.run()).resolves.toBe(false)
    expect(h.pressEnter).toHaveBeenCalledTimes(1)
  })
})

describe('createKickoffReporter', () => {
  // cli_open_agent blocks on exactly one agent_spawn.kickoff per request: a
  // second one is ignored by the backend (the future is already done), and a
  // missing one costs the caller the full 45s deadline. Both halves are the
  // reporter's job, since kickoffRequestedPane reports from a settled branch
  // AND from its `finally`.
  it('sends once with the request id, pane id and verdict', () => {
    const send = vi.fn()
    const report = createKickoffReporter({ requestId: 'r1', paneId: 'p1', send })
    report('sent')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ request_id: 'r1', pane_id: 'p1', kickoff: 'sent' })
  })

  it('carries a reason when one is given, and omits the key when not', () => {
    const send = vi.fn()
    createKickoffReporter({ requestId: 'r1', paneId: 'p1', send })('failed', 'typed 2×')
    expect(send).toHaveBeenCalledWith({
      request_id: 'r1', pane_id: 'p1', kickoff: 'failed', reason: 'typed 2×',
    })
  })

  it('reports exactly once however often it is called', () => {
    const send = vi.fn()
    const report = createKickoffReporter({ requestId: 'r1', paneId: 'p1', send })
    report('unverified', 'growth only')
    // The `finally` fires on every exit, settled or not.
    report('failed', 'never reached a verdict')
    report('sent')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      request_id: 'r1', pane_id: 'p1', kickoff: 'unverified', reason: 'growth only',
    })
  })

  // The SPAWN-block path has no MCP call waiting on it and passes no id.
  it('sends nothing without a request id', () => {
    const send = vi.fn()
    createKickoffReporter({ requestId: undefined, paneId: 'p1', send })('failed', 'gone')
    createKickoffReporter({ requestId: '', paneId: 'p1', send })('failed', 'gone')
    expect(send).not.toHaveBeenCalled()
  })

  it('still counts as reported when the send throws, so nothing reports twice', () => {
    const send = vi.fn(() => { throw new Error('socket closed') })
    const report = createKickoffReporter({ requestId: 'r1', paneId: 'p1', send })
    expect(() => report('sent')).not.toThrow()
    report('failed')
    expect(send).toHaveBeenCalledTimes(1)
  })
})
