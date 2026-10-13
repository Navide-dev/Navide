/**
 * spawnKickoff.ts
 *
 * The two decisions kickoffRequestedPane (App.vue) makes that nothing could
 * test: whether an attempt at typing a new pane's task settles or is typed
 * again, and reporting the verdict back to the cli_open_agent call waiting on
 * it. Both used to live inline in a 15K-line component the suite cannot mount,
 * so they were only ever asserted as source text.
 */

import { kickoffVerified, type EchoEvidence, type SubmitEvidence } from './injectEcho'

/** How a pane's spawn-time task injection ended. `unverified` is the honest
 *  middle: bytes written, nothing observed — which is also the state where a
 *  resend would submit two copies as one prompt. */
export type KickoffVerdict = 'sent' | 'unverified' | 'failed'

export interface KickoffAttemptInput {
  /** injectPane's own answer: false when the bytes never went out. */
  injected: boolean
  echo: EchoEvidence | null
  submit: SubmitEvidence | null
  /** Whether the prompt-ready gate opened before typing — see kickoffVerified. */
  promptReady: boolean
  /** Is the composer holding the copy we just typed? Lazy: reading the screen
   *  costs a buffer scan, and only the retype decision needs the answer. */
  composerHolds: () => boolean
  attempt: number
  maxAttempts: number
}

export interface KickoffAttemptVerdict {
  outcome: KickoffVerdict
  /** `retype` types the payload again; `stop` settles on `outcome`. */
  next: 'stop' | 'retype'
  /** Settled failed only because every attempt came back unverified — as
   *  opposed to an injection that reported failure outright, which has already
   *  logged its own diagnostic. */
  retriedOut: boolean
}

/** What to do after one attempt at typing a new pane's task.
 *
 *  Order is load-bearing, and the composer question comes first — on the last
 *  attempt too. What the caller must do next is decided by whether our copy is
 *  sitting in the composer unsent, not by how many times we typed it: 'failed'
 *  tells cli_open_agent's caller to resend with cli_send, and a resend lands a
 *  second copy on top of the one already there, which the next Enter submits as
 *  one prompt. That is the same duplication the retype guard exists to prevent,
 *  arriving one step later. 'unverified' is the verdict that sends the caller
 *  to cli_get_status first, which is exactly right for a composer that is
 *  holding the task. Count only decides the blank-composer case: nothing left
 *  to protect, so say plainly that we typed it and never saw it. */
export function kickoffAttemptOutcome(input: KickoffAttemptInput): KickoffAttemptVerdict {
  if (!input.injected) return { outcome: 'failed', next: 'stop', retriedOut: false }
  if (kickoffVerified(input.echo, input.submit, input.promptReady)) {
    return { outcome: 'sent', next: 'stop', retriedOut: false }
  }
  // Retype only into a blank composer: a second copy typed on top of the first
  // is submitted with it as one prompt. Holding the first copy is why this
  // stays 'unverified' rather than becoming a failure — the same reason a
  // cli_send resend is the wrong cure for it.
  if (input.composerHolds()) return { outcome: 'unverified', next: 'stop', retriedOut: false }
  if (input.attempt >= input.maxAttempts) {
    return { outcome: 'failed', next: 'stop', retriedOut: true }
  }
  return { outcome: 'unverified', next: 'retype', retriedOut: false }
}

/** The verdict for a plain terminal pane's initial command. Typed at most
 *  once, never retyped: a shell runs what reaches it, so a second copy is a
 *  second run of the command, not a duplicate prompt. For the same reason an
 *  unconfirmed typing is `unverified`, never `failed` — `failed` tells the
 *  caller to resend, and a resend of a command that did run runs it twice.
 *  `typed` is false only when nothing went out (injectPane said so, or the
 *  shell had printed nothing and was not typed into). */
export function terminalKickoffOutcome(input: {
  typed: boolean
  echo: EchoEvidence | null
  submit: SubmitEvidence | null
  promptReady: boolean
}): KickoffVerdict {
  if (!input.typed) return 'failed'
  return kickoffVerified(input.echo, input.submit, input.promptReady) ? 'sent' : 'unverified'
}

/** Why a terminal kickoff settled on something other than `sent`, for the
 *  cli_open_agent caller. */
export const TERMINAL_KICKOFF_REASON: Record<Exclude<KickoffVerdict, 'sent'>, string> = {
  failed: 'the command was not typed — the shell never came up, or the injection failed',
  unverified: 'the command was typed once but its submit was not observed — '
    + 'read cli_read_log before resending, a resend runs it again',
}

/** What one attempt at typing the task observed. Produced by the caller's
 *  `inject`, because only it can write to a PTY — the loop below only reads
 *  it. Each call returns its OWN evidence: reusing the previous attempt's was
 *  a live hazard while the loop lived inline, where one mutable `evidence`
 *  object was reset by hand at the top of every iteration. */
export interface KickoffAttemptEvidence {
  injected: boolean
  echo: EchoEvidence | null
  submit: SubmitEvidence | null
}

export interface KickoffLoopDeps {
  maxAttempts: number
  /** The prompt-ready gate's answer, sampled ONCE before the first attempt. A
   *  value rather than a callback on purpose: it describes the pane we started
   *  typing into, and re-reading it after we have typed would ask whether the
   *  pane is quiet while we are the reason it is not. */
  promptReady: boolean
  /** Whether the pane had still printed nothing when the gate gave up —
   *  sampled once, with `promptReady`. Only this pane is left untyped: a CLI
   *  that is up but never matched idle+quiet (a cold start on a loaded host)
   *  is typed into as before, and judged with the gate shut. */
  paneStarting: boolean
  /** Type the payload. `attempt` is 1-based and is the loop's own counter. */
  inject: (attempt: number) => Promise<KickoffAttemptEvidence>
  composerHolds: () => boolean
  /** False once the pane is gone; the loop abandons rather than typing into
   *  a dead session. */
  paneAlive: () => boolean
  onRetry: (info: {
    attempt: number
    echo: EchoEvidence | null
    submit: SubmitEvidence | null
  }) => void
  /** Press Enter on the copy the composer is holding, and answer whether it
   *  left the box. Asked only when an attempt stopped on a held copy: a retype
   *  there would ride along with the first copy, but Enter is the one
   *  keystroke still missing. Optional — without it a held copy stays
   *  'unverified', as it always has. */
  resubmit?: () => Promise<boolean>
}

export type KickoffLoopResult =
  | { settled: false }
  | {
      settled: true
      outcome: KickoffVerdict
      retriedOut: boolean
      /** Of the attempt that settled it — never an earlier one. */
      echo: EchoEvidence | null
      submit: SubmitEvidence | null
      /** Failed without typing at all: the prompt-ready gate never opened
       *  and the pane had printed nothing. The caller's resend is the right
       *  cure here — nothing is in the composer to double. */
      untyped?: boolean
      /** Sent only because `resubmit` pressed Enter on a copy the composer
       *  was holding after the attempt itself could not be verified. */
      resubmitted?: true
    }

/** Type a new pane's task, and type it again if the first copy cannot be
 *  accounted for and the composer is empty.
 *
 *  The loop itself, not just the per-attempt decision: the decision was
 *  already testable and the loop around it was not, so passing the wrong
 *  variable into it — the previous attempt's evidence, a counter that never
 *  advanced, a gate answer re-read after we had typed — was invisible to the
 *  suite. Everything that touches the pane arrives as a dependency, which is
 *  what lets this run under test at all: kickoffRequestedPane lives in a
 *  15K-line component the suite cannot mount. */
export async function runKickoffAttempts(deps: KickoffLoopDeps): Promise<KickoffLoopResult> {
  // A CLI that has printed nothing is still initialising, and raw-mode setup
  // flushes the tty's input (tcsetattr with TCSAFLUSH) — text typed now is
  // eaten, not queued. Typing it "anyway" reported that as a kickoff that was
  // sent; say plainly that it was not. A pane that IS printing but never read
  // idle+quiet is a different case: it is up, so type, with the gate's shut
  // answer keeping growth-only evidence from counting as 'sent'.
  if (!deps.promptReady && deps.paneStarting) {
    return { settled: true, outcome: 'failed', retriedOut: false, echo: null, submit: null, untyped: true }
  }
  let last: KickoffAttemptEvidence = { injected: false, echo: null, submit: null }
  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    last = await deps.inject(attempt)
    const verdict = kickoffAttemptOutcome({
      injected: last.injected,
      echo: last.echo,
      submit: last.submit,
      promptReady: deps.promptReady,
      composerHolds: deps.composerHolds,
      attempt,
      maxAttempts: deps.maxAttempts,
    })
    // Stopped on a copy the composer is holding (the only 'unverified' stop):
    // observed 10-07 as "[Pasted text #1 +31 lines]" sitting unsent while the
    // verdict went back to the caller, whose cli_send then reached the CLI
    // through its hook and left the task stranded in the box. Enter is what
    // that copy is missing, and it is ours on a pane we just spawned.
    if (verdict.next === 'stop' && verdict.outcome === 'unverified' && deps.resubmit) {
      if (!deps.paneAlive()) return { settled: false }
      if (await deps.resubmit()) {
        return {
          settled: true,
          outcome: 'sent',
          retriedOut: false,
          echo: last.echo,
          submit: last.submit,
          resubmitted: true,
        }
      }
    }
    if (verdict.next === 'stop') {
      return {
        settled: true,
        outcome: verdict.outcome,
        retriedOut: verdict.retriedOut,
        echo: last.echo,
        submit: last.submit,
      }
    }
    // Between the decision to retype and the retype itself: the pane can close
    // while a slow injection is in flight, and the caller reports the verdict
    // from its own `finally` in that case.
    if (!deps.paneAlive()) return { settled: false }
    deps.onRetry({ attempt, echo: last.echo, submit: last.submit })
  }
  // Not reachable: kickoffAttemptOutcome always answers 'stop' on the last
  // attempt. Kept so a future change to that rule cannot silently fall out of
  // the loop with no verdict at all.
  return { settled: true, outcome: 'failed', retriedOut: true, echo: last.echo, submit: last.submit }
}

/** Press Enter on a kickoff copy held unsent in the composer, and watch it
 *  leave — runKickoffAttempts' `resubmit`.
 *
 *  `held` reads the FRAMED box (injectEcho.framedComposerHolds): true holds our
 *  copy, false is released, null has no frame to judge by. Only a true is ever
 *  pressed on, before every Enter: a box that is already empty, or a screen
 *  we cannot locate the box on, gets no keystroke. Up to `maxEnters` Enters,
 *  each watched for `confirmMs` — an Enter sent right after a collapsed paste
 *  appeared has been seen not to take, and the next one did. */
export async function submitHeldCopy(deps: {
  held: () => boolean | null
  /** False when the keystroke could not be written. */
  pressEnter: () => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  now: () => number
  confirmMs: number
  maxEnters?: number
  pollMs?: number
}): Promise<boolean> {
  const maxEnters = deps.maxEnters ?? 3
  const pollMs = deps.pollMs ?? 200
  for (let enter = 1; enter <= maxEnters; enter++) {
    if (deps.held() !== true) return false
    if (!(await deps.pressEnter())) return false
    const deadline = deps.now() + deps.confirmMs
    while (deps.now() < deadline) {
      await deps.sleep(pollMs)
      if (deps.held() === false) return true
    }
  }
  return false
}

/** The prompt-ready gate's per-poll answer (waitForPromptReady, App.vue).
 *
 *  `idle` alone is not enough: the status machine leaves 'starting' on any raw
 *  byte, and a Claude Code running its SessionStart hooks has printed only a
 *  cursor save/restore — no clean byte at all — so it reads idle, nothing
 *  grows, and two quiet seconds opened the gate on a CLI that had drawn
 *  nothing (10-07: one kickoff flushed, one left as an unsent collapsed
 *  paste). A pane at its prompt has drawn that prompt. */
export function promptReadyNow(input: {
  status: string | undefined
  cleanBytes: number
  quietMs: number
  quietNeededMs: number
}): boolean {
  return input.status === 'idle' && input.cleanBytes > 0 && input.quietMs >= input.quietNeededMs
}

/** Whether a pane the gate gave up on is still initialising — the
 *  `paneStarting` runKickoffAttempts leaves untyped. The status machine's
 *  'starting' covers a pane that has printed no byte; a pane whose bytes were
 *  all control sequences (zero clean output) has not drawn anything either,
 *  and typing into it is typing into a CLI that may flush or misread it. */
export function paneStillStarting(input: { status: string | undefined; cleanBytes: number }): boolean {
  return input.status === 'starting' || input.cleanBytes <= 0
}

/** One-shot reporter for the `agent_spawn.kickoff` event.
 *
 *  cli_open_agent blocks on exactly one verdict per request: a second is
 *  dropped by the backend (its future is already resolved) and a missing one
 *  costs the caller the full kickoff deadline. kickoffRequestedPane reports
 *  from whichever branch settles AND from its `finally`, so "at most once" has
 *  to be the reporter's guarantee rather than the caller's discipline.
 *
 *  `requestId` is empty on the SPAWN-block path, where no MCP call is waiting;
 *  the reporter then sends nothing. A send that throws still counts as
 *  reported — the tool call times out and says so, and a retry from the
 *  `finally` would only report the wrong verdict. */
export function createKickoffReporter(opts: {
  requestId: string | undefined
  paneId: string
  send: (payload: Record<string, unknown>) => void
}): (kickoff: KickoffVerdict, reason?: string) => void {
  let reported = false
  return (kickoff, reason) => {
    if (!opts.requestId || reported) return
    reported = true
    const payload: Record<string, unknown> = {
      request_id: opts.requestId,
      pane_id: opts.paneId,
      kickoff,
    }
    if (reason) payload.reason = reason
    try {
      opts.send(payload)
    } catch { /* the tool call times out and says so */ }
  }
}
