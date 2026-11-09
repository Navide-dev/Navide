/**
 * ptyInputBlock.ts
 *
 * What injectText (App.vue) does when the PTY will not take its bytes.
 *
 * The backend writes to the PTY without blocking. When the CLI on the other
 * end has stopped reading — a TUI wedged on its own output, a `sleep` in a
 * plain shell — the kernel's input queue (about 1KB on macOS) fills, the
 * write gets EAGAIN and the rest of the payload waits in the backend's own
 * buffer. The `terminal.input` ack reports how much is still waiting as
 * `pending`, and an episode that outlasts a short grace is announced as
 * `terminal.input_blocked` / `terminal.input_unblocked` for the session.
 *
 * The echo watch alone cannot tell this apart from "the bytes were dropped":
 * both look like no echo. But the two owe opposite responses — dropped bytes
 * are re-sent, queued bytes must NOT be, since every copy re-sent lands behind
 * the first and is read with it as one three-fold prompt the moment the CLI
 * resumes. So a send whose ack says `pending > 0`, or whose session has an
 * open episode, waits for the CLI to read before the echo clock even starts.
 *
 * Pure so it can be tested; App.vue owns the tracker instance and the PTY.
 */

export interface InputBlockEpisode {
  /** Bytes the backend was still holding when the episode was announced. */
  pending: number
  /** When this window learnt of it (ms epoch). */
  since: number
}

export interface InputBlockTracker {
  /** The open episode for a session, or null when its input is flowing. */
  get(sessionId: string): InputBlockEpisode | null
  onBlocked(sessionId: string, pending: number, now: number): void
  onUnblocked(sessionId: string): void
}

export function createInputBlockTracker(): InputBlockTracker {
  const episodes = new Map<string, InputBlockEpisode>()
  return {
    get: (sessionId) => episodes.get(sessionId) ?? null,
    onBlocked: (sessionId, pending, now) => {
      // One episode per session: a repeat announcement refreshes the count
      // but keeps the original start, which is what a "held for N s" reads.
      const open = episodes.get(sessionId)
      episodes.set(sessionId, { pending, since: open?.since ?? now })
    },
    onUnblocked: (sessionId) => {
      episodes.delete(sessionId)
    },
  }
}

/** How often, while the ack said bytes are pending, the backend is asked
 *  again. The probe is an empty `terminal.input` write — side-effect free —
 *  whose ack carries the live `pending`; it is what ends the wait, with the
 *  blocked/unblocked events only speeding it up. */
export const INPUT_BLOCK_PROBE_MS = 1_000

/** Whether a send has to wait for the CLI to read before its echo is judged. */
export function needsInputWait(ackPending: number, blocked: boolean): boolean {
  return ackPending > 0 || blocked
}

/** A probe's answer when the backend refused it: the session is gone. */
export const PROBE_SESSION_GONE = 'gone' as const

export type InputWaitResult<E> =
  /** The echo showed up while waiting — the payload is in the composer. */
  | { outcome: 'ready'; echo: E }
  /** The CLI has read what was queued; nothing echoed yet, so the ordinary
   *  echo watch takes over with a fresh timeout. */
  | { outcome: 'watch' }
  /** The caller's abort fired: pane gone, message withdrawn. */
  | { outcome: 'aborted' }

export interface InputWaitDeps<E> {
  /** `pending` from the last `terminal.input` ack (0 for a backend too old to
   *  send it). */
  ackPending: number
  /** Is an episode open for this session right now? */
  blocked: () => boolean
  /** Ask the backend how much is still pending. `null` when the transport
   *  failed (the events are then the only way out); {@link PROBE_SESSION_GONE}
   *  when the backend answered that the session no longer exists, which ends
   *  the wait — nothing will ever read those bytes. */
  probe: () => Promise<number | null | typeof PROBE_SESSION_GONE>
  /** A probe came back with nothing pending. The caller closes the session's
   *  episode here, so a lost `input_unblocked` can never wedge the tracker. */
  drained: () => void
  /** The echo check the ordinary watch uses; non-null once our text landed. */
  echoed: () => E | null
  aborted: () => boolean
  /** Told `true` once the block is confirmed — an episode announced, or a
   *  probe still finding bytes pending — and `false` again on every way out.
   *  A queue that drained before either is never reported. */
  onHold: (held: boolean) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  pollMs?: number
  probeMs?: number
}

/**
 * Wait for a PTY that stopped taking input to take it again.
 *
 * No upper bound on purpose: the user decided the message must be received,
 * not timed out, so only the caller's abort ends a wait the CLI does not. The
 * backend is probed every `probeMs` while bytes are pending; an ack that says
 * none are left ends the wait, and so does the session's episode closing
 * after it was seen open (the contract: unblocked means everything queued was
 * read).
 */
export async function awaitInputUnblocked<E>(deps: InputWaitDeps<E>): Promise<InputWaitResult<E>> {
  const poll = deps.pollMs ?? 200
  const probeMs = deps.probeMs ?? INPUT_BLOCK_PROBE_MS
  let pending = deps.ackPending
  let blockedSeen = false
  let confirmed = false
  let held = false
  let nextProbe = deps.now() + probeMs
  try {
    for (;;) {
      if (deps.aborted()) return { outcome: 'aborted' }
      const echo = deps.echoed()
      if (echo !== null) return { outcome: 'ready', echo }
      if (deps.blocked()) {
        blockedSeen = true
        confirmed = true
      } else if (blockedSeen || pending === 0) {
        return { outcome: 'watch' }
      }
      if (confirmed && !held) {
        held = true
        deps.onHold(true)
      }
      await deps.sleep(poll)
      // Probed while anything says the PTY is not reading — the ack or the
      // tracker — so a lost unblocked event ends in a probe, not a wedge.
      if ((pending > 0 || blockedSeen) && deps.now() >= nextProbe) {
        nextProbe = deps.now() + probeMs
        const found = await deps.probe()
        if (found === null) continue
        if (found === PROBE_SESSION_GONE) return { outcome: 'aborted' }
        pending = found
        if (found === 0) deps.drained()
        else confirmed = true
      }
    }
  } finally {
    if (held) deps.onHold(false)
  }
}

/** How many rounds an unbounded watch lets the pane print WITHOUT our tail
 *  before it gives up: late B1 backlog, a footer repaint, a slow echo on a
 *  loaded host all look like this for a round or two. Rounds of silence do
 *  not count — those are waited out. */
export const MESSAGE_OUTPUT_ROUNDS = 3

export type EchoWatchResult<E> =
  /** Our text is in the composer. */
  | { outcome: 'ready'; echo: E }
  /** The pane printed during the last round but not our tail: the bytes may
   *  have been dropped. Only a capped watch says this (its caller decides);
   *  an unbounded one absorbs such rounds up to {@link MESSAGE_OUTPUT_ROUNDS}. */
  | { outcome: 'resend' }
  /** The pane printed nothing for `maxSilentRounds` rounds: the caller gives
   *  up (and clears). Never returned on an unbounded watch. */
  | { outcome: 'silent' }
  /** An unbounded watch saw the pane print for {@link MESSAGE_OUTPUT_ROUNDS}
   *  rounds and never our tail: the caller gives up (and clears). */
  | { outcome: 'unechoed' }
  | { outcome: 'aborted' }

export interface EchoWatchDeps<E> {
  echoed: () => E | null
  /** The pane's monotonic output counter. */
  outputBytes: () => number
  aborted: () => boolean
  /** Told `true` once a round ends silent (the message is held on
   *  `pty-blocked`), `false` on every way out. */
  onHold: (held: boolean) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** One round's echo timeout. */
  roundMs: number
  /** How many silent rounds before giving up; null waits for as long as it
   *  takes (the messaging path — the user decided a message must be received,
   *  not timed out). Every other caller is capped: a CLI parked on a modal
   *  that neither echoes nor paints would otherwise hold a kickoff in
   *  `pending` forever, and the idle gate with it. */
  maxSilentRounds: number | null
  /** A capped watch keeps watching, through rounds silent or painting, until
   *  this long after it began, and only then answers as its cap says. For a
   *  kickoff on a host starved of CPU: its CLI read the paste a minute late,
   *  and the Ctrl-U each early give-up typed queued behind it unread (0.2.39
   *  Windows VM, `load 12`). */
  waitMs?: number
  pollMs?: number
}

/**
 * Watch for the payload's echo, in rounds of `roundMs`.
 *
 * Whether an echo that never came may be answered by sending the payload
 * again is decided PER ROUND, from output the pane produced during that round
 * alone: a live CLI that consumed the bytes paints something — the composer
 * echo, or at least a repaint — while one that is not reading is silent. The
 * kernel takes about 1KB before it says EAGAIN, so a short payload gets
 * `pending: 0` and no event even when nothing is reading it; re-pasting into
 * that silence is what put two copies of a 779-byte message into one prompt.
 * The baseline is taken at the top of each round, after the write and its
 * ack, so output the backend had buffered before the write (a reader paused
 * under back-pressure catching up) does not pass for a reaction to it.
 */
export async function awaitEcho<E>(deps: EchoWatchDeps<E>): Promise<EchoWatchResult<E>> {
  const poll = deps.pollMs ?? 200
  let silentRounds = 0
  let outputRounds = 0
  let held = false
  const startedAt = deps.now()
  try {
    for (;;) {
      const base = deps.outputBytes()
      const deadline = deps.now() + deps.roundMs
      while (deps.now() < deadline) {
        await deps.sleep(poll)
        if (deps.aborted()) return { outcome: 'aborted' }
        const echo = deps.echoed()
        if (echo !== null) return { outcome: 'ready', echo }
      }
      if (deps.maxSilentRounds !== null && deps.waitMs !== undefined && deps.now() - startedAt < deps.waitMs) continue
      if (deps.outputBytes() - base > 0) {
        if (deps.maxSilentRounds !== null) return { outcome: 'resend' }
        // Output without our tail is not proof the bytes were dropped — the
        // message path never re-pastes, so give the echo another round.
        outputRounds++
        if (outputRounds >= MESSAGE_OUTPUT_ROUNDS) return { outcome: 'unechoed' }
        continue
      }
      silentRounds++
      if (deps.maxSilentRounds !== null && silentRounds >= deps.maxSilentRounds) {
        return { outcome: 'silent' }
      }
      if (!held) {
        held = true
        deps.onHold(true)
      }
    }
  } finally {
    if (held) deps.onHold(false)
  }
}
