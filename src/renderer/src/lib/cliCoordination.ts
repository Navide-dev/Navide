import { isReplayedTurnComplete, parseEventMs, turnTextFingerprint } from './completion'
import type { EchoEvidence, SubmitEvidence } from './injectEcho'

export const MAX_KICKOFF_ATTEMPTS = 3
export const MAX_PERSIST_PANE_ATTEMPTS = 8

/** Retry only an injection that left the composer empty. A failed submit with
 * an observed echo must never append a second copy of the kickoff. */
export async function runPipelineKickoff(input: {
  /** `stopped`: the injection asked stillWanted right before its Enter, got
   *  no, and cleared the box instead of submitting. */
  inject: () => Promise<{ injected: boolean; echo?: EchoEvidence | null; submit?: SubmitEvidence | null; stopped?: boolean }>
  sleep: (ms: number) => Promise<void>
  paneAlive: () => boolean
  onHeld?: () => void
  onRetry?: (attempt: number) => void
  /** This pane's last kickoff was held in its input box (#448). A copy still
   *  there is submitted with Enter, never pasted a second time. */
  heldCopy?: { holds: () => boolean; submit: () => Promise<boolean> }
  /** The pane is parked on a CLI prompt (a permission box, a menu, a startup
   *  dialog). Nothing is typed then: the kickoff's Enter would answer that
   *  prompt for the user, and its echo check cannot tell the difference. */
  parkedOnPrompt?: () => boolean
  /** The run still wants this kickoff. Checked before every attempt: a sibling
   *  slot can fail the run while this one waits, and an attempt that already
   *  typed is never undone. */
  stillWanted?: () => boolean
  /** A kickoff the CLI queued behind a turn still running (submit 'queued')
   *  is not sent yet: resolves true once that turn has ended and the kickoff
   *  started a turn of its own. False holds it, as a kickoff left in the box
   *  is held, and is never typed again. */
  confirmQueued?: () => Promise<boolean>
}): Promise<{ sent: boolean; cancelled: boolean; parked?: boolean; stopped?: boolean }> {
  if (input.parkedOnPrompt?.()) return { sent: false, cancelled: false, parked: true }
  if (input.heldCopy?.holds()) {
    if (input.stillWanted && !input.stillWanted()) return { sent: false, cancelled: false, stopped: true }
    if (await input.heldCopy.submit()) return { sent: true, cancelled: false }
    input.onHeld?.()
    return { sent: false, cancelled: false }
  }
  for (let attempt = 1; attempt <= MAX_KICKOFF_ATTEMPTS; attempt++) {
    if (input.stillWanted && !input.stillWanted()) return { sent: false, cancelled: false, stopped: true }
    const result = await input.inject()
    if (result.injected && result.submit === 'queued' && input.confirmQueued) {
      if (await input.confirmQueued()) return { sent: true, cancelled: false }
      input.onHeld?.()
      return { sent: false, cancelled: false }
    }
    if (result.injected) return { sent: true, cancelled: false }
    if (result.stopped) return { sent: false, cancelled: false, stopped: true }
    if (result.echo != null) {
      input.onHeld?.()
      break
    }
    if (attempt < MAX_KICKOFF_ATTEMPTS) {
      input.onRetry?.(attempt)
      await input.sleep(3000)
      if (!input.paneAlive()) return { sent: false, cancelled: true }
      if (input.parkedOnPrompt?.()) return { sent: false, cancelled: false, parked: true }
    }
  }
  return { sent: false, cancelled: false }
}

/** Ctrl-U presses that empty a Claude Code input box holding `text`, typed
 *  at `cols` columns. Measured on 2.1.286 and 2.1.316: each Ctrl-U deletes one
 *  screen row of the box and the next the line break before it, so a wrapped
 *  line costs one row per wrap; on an empty box it does nothing, so a count
 *  that runs over is harmless. Wide characters count as two columns, the
 *  box's frame and prompt take four, and one row more covers a wide character
 *  wrapping early.
 *
 *  Returned as separate writes of at most 32: one read of 64 or more Ctrl-U
 *  is taken as a paste and does nothing (measured on 2.1.286), so the caller
 *  leaves a gap between them for the CLI to read each on its own. */
export function composerClearKeys(text: string, cols: number): string[] {
  const width = Math.max(1, cols - 4)
  let rows = 0
  for (const line of text.split('\n')) {
    let used = 0
    for (const ch of line) used += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(ch) ? 2 : 1
    rows += Math.max(1, Math.ceil(used / width))
  }
  const writes: string[] = []
  for (let left = (rows + 1) * 2; left > 0; left -= 32) writes.push('\x15'.repeat(Math.min(32, left)))
  return writes
}

const TURN_STAMPS_KEPT = 512

/** Hook and transcript watcher can report the same turn. Record acceptance
 * synchronously, before a caller dispatches messages and can be reentered. */
export function createTurnTextGate() {
  // A turn end's stamp is its identity: whether that turn was already taken,
  // not whether it is the newest. The log reader can deliver an older turn
  // after a newer one (read late, behind a hook-prioritized file), and a
  // newest-only rule dropped the older turn's MSG blocks without a trace.
  const timestamps = new Map<string, Set<number>>()
  const fingerprints = new Map<string, string>()
  return {
    accept(paneId: string, text: string, timestamp: string): boolean {
      const eventMs = parseEventMs(timestamp)
      if (!Number.isNaN(eventMs)) {
        let seen = timestamps.get(paneId)
        if (!seen) timestamps.set(paneId, (seen = new Set()))
        if (seen.has(eventMs)) return false
        seen.add(eventMs)
        // Bounded: a replay older than this many turns is the boot gate's.
        if (seen.size > TURN_STAMPS_KEPT) seen.delete(seen.values().next().value as number)
      } else {
        const fingerprint = turnTextFingerprint(text)
        if (fingerprint === fingerprints.get(paneId)) return false
        fingerprints.set(paneId, fingerprint)
      }
      return true
    },
    delete(paneId: string): void {
      timestamps.delete(paneId)
      fingerprints.delete(paneId)
    },
  }
}

/** Which turn ends the MSG scan reads: each turn once, and none from before
 * this window started.
 *
 * A replay is a turn that ended before this window booted (a backend restart
 * re-emitting history), not one that is merely old: judged against `now`, a
 * turn end the log reader delivered more than the tolerance late was dropped
 * as a replay, MSG blocks and all, with no log row and no notice (2026-11-03,
 * reader lag up to 733 s). Repeats within the session are the text gate's. */
export function createMessagingTurnGate(bootMs: number) {
  const gate = createTurnTextGate()
  return {
    accept(paneId: string, text: string, timestamp: string, toleranceMs: number): boolean {
      if (isReplayedTurnComplete(timestamp, bootMs, toleranceMs)) return false
      return gate.accept(paneId, text, timestamp)
    },
    delete(paneId: string): void {
      gate.delete(paneId)
    },
  }
}

/** A missing manual-pane record is normally a transient spawn race. Retrying
 * on later activity is bounded so a permanent miss cannot flood the backend.
 * Undefined means the caller could not attempt a write (e.g. missing stage). */
export function createPaneSessionPersistence() {
  const persisted = new Set<string>()
  const attempts = new Map<string, number>()
  return async (key: string, write: () => Promise<boolean | undefined>): Promise<void> => {
    if (persisted.has(key)) return
    const saved = await write()
    if (saved === undefined) return
    if (saved) {
      persisted.add(key)
      attempts.delete(key)
    } else {
      const count = (attempts.get(key) ?? 0) + 1
      attempts.set(key, count)
      if (count >= MAX_PERSIST_PANE_ATTEMPTS) persisted.add(key)
    }
  }
}
