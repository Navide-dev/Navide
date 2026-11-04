/** Pipeline text that must never answer a CLI prompt for the user.
 *
 *  Typing into a pane parked on a permission box or a menu presses Enter on it:
 *  the router's ASK / REPORT / DISPATCH / handoff / reminder text would approve
 *  whatever the box asks. So a message for such a pane waits in a per-pane
 *  queue and goes out once the prompt is gone (the user answered it), in
 *  order, each message exactly once. */

export interface ParkedDeliveryDeps {
  parked: (paneId: string) => boolean
  alive: (paneId: string) => boolean
  send: (paneId: string, text: string, label: string) => Promise<boolean>
  onQueued?: (paneId: string, label: string, depth: number) => void
  /** The pane is gone with messages still queued; nothing can take them now. */
  onDropped?: (paneId: string, label: string) => void
  onFailed?: (paneId: string, label: string) => void
  intervalMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

interface Queued {
  text: string
  label: string
  resolve: (sent: boolean) => void
}

export function createParkedDelivery(deps: ParkedDeliveryDeps) {
  const queues = new Map<string, Queued[]>()
  const draining = new Set<string>()
  // Bumped by clear(): a drain already awaiting a send sees it and stops, so
  // nothing a cleared run held is typed afterwards.
  let generation = 0
  const setTimer = deps.setInterval ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms))
  const clearTimer = deps.clearInterval ?? ((h: unknown) => globalThis.clearInterval(h as ReturnType<typeof setInterval>))
  let timer: unknown = null

  const stopTimerIfIdle = (): void => {
    if (queues.size === 0 && timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  async function drainPane(paneId: string): Promise<void> {
    if (draining.has(paneId)) return
    const q = queues.get(paneId)
    if (!q) return
    if (!deps.alive(paneId)) {
      queues.delete(paneId)
      for (const item of q) {
        deps.onDropped?.(paneId, item.label)
        item.resolve(false)
      }
      return
    }
    draining.add(paneId)
    const gen = generation
    try {
      while (gen === generation && q.length > 0 && deps.alive(paneId) && !deps.parked(paneId)) {
        const item = q[0]
        const sent = await deps.send(paneId, item.text, item.label)
        // Cleared while this send was in flight: clear() has settled every
        // item, this one included, and nothing more goes out.
        if (gen !== generation) break
        q.shift()
        if (!sent) deps.onFailed?.(paneId, item.label)
        item.resolve(sent)
      }
      if (q.length === 0 && queues.get(paneId) === q) queues.delete(paneId)
    } finally {
      draining.delete(paneId)
    }
  }

  async function drain(): Promise<void> {
    await Promise.all([...queues.keys()].map((paneId) => drainPane(paneId)))
    stopTimerIfIdle()
  }

  return {
    /** Send now when nothing stands in the way; otherwise queue. A queued
     *  message resolves `true` at once (it is accepted and will go out), or,
     *  with `awaitDelivery`, when it is actually typed. */
    async deliver(paneId: string, text: string, label: string, opts: { awaitDelivery?: boolean } = {}): Promise<boolean> {
      const q = queues.get(paneId)
      if (!q && !deps.parked(paneId)) return deps.send(paneId, text, label)
      let resolve: (sent: boolean) => void = () => {}
      const sent = new Promise<boolean>((r) => { resolve = r })
      const queue = q ?? []
      queue.push({ text, label, resolve })
      if (!q) queues.set(paneId, queue)
      deps.onQueued?.(paneId, label, queue.length)
      if (timer === null) timer = setTimer(() => { void drain() }, deps.intervalMs ?? 1000)
      return opts.awaitDelivery ? sent : true
    },
    drain,
    pending(paneId: string): number {
      return queues.get(paneId)?.length ?? 0
    },
    /** A run that ended takes its undelivered messages with it. */
    clear(): void {
      generation++
      for (const q of queues.values()) {
        for (const item of q) item.resolve(false)
        q.length = 0
      }
      queues.clear()
      stopTimerIfIdle()
    },
  }
}

export type TurnWaitOutcome = 'idle' | 'parked' | 'gone' | 'moved-on'

/** Hold a kickoff until the pane's previous turn has ended. A kickoff typed
 *  mid-turn is queued by the CLI behind that turn, whose turn_complete then
 *  reads as the kickoff's. Ends early when the pane comes up on a prompt (the
 *  caller stops the run for the user), dies, or the run moves on. */
export async function waitUntilTurnEnds(deps: {
  busy: () => boolean
  parked: () => boolean
  alive: () => boolean
  stillWanted: () => boolean
  sleep: (ms: number) => Promise<void>
  pollMs?: number
}): Promise<TurnWaitOutcome> {
  for (;;) {
    if (!deps.alive()) return 'gone'
    if (!deps.stillWanted()) return 'moved-on'
    if (deps.parked()) return 'parked'
    if (!deps.busy()) return 'idle'
    await deps.sleep(deps.pollMs ?? 500)
  }
}

/** How long a role prompt's turn has to start before the kickoff goes on
 *  without waiting for it. On Windows the CLI's first activity reached the
 *  window about 2s after the role's Enter (0.2.37 VM), past the moment the
 *  turn-busy check had already read the pane as idle. */
export const ROLE_TURN_START_MS = 10_000

/** 'ended': the role's turn started and ended. 'no-start': no turn began
 *  within ROLE_TURN_START_MS, and the caller goes on as it did before. */
export type RoleTurnOutcome = 'ended' | 'no-start' | 'parked' | 'gone' | 'moved-on'

/** Hold a kickoff until the turn its pane's role prompt started has ended.
 *  Read from the CLI's turn events, not from its output: during a turn Claude
 *  Code on Windows repaints nothing but its title spinner, which reads as an
 *  idle pane to anything that watches bytes. A kickoff typed in that turn is
 *  queued behind it. First the turn's start (`startedSince`: a turn started
 *  or ended after the role went in), for at most `startTimeoutMs`, then its
 *  end, as waitUntilTurnEnds waits for it. */
export async function waitForRoleTurn(deps: {
  startedSince: () => boolean
  busy: () => boolean
  parked: () => boolean
  alive: () => boolean
  stillWanted: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  startTimeoutMs?: number
  pollMs?: number
}): Promise<RoleTurnOutcome> {
  const pollMs = deps.pollMs ?? 250
  const deadline = deps.now() + (deps.startTimeoutMs ?? ROLE_TURN_START_MS)
  while (!deps.startedSince()) {
    if (!deps.alive()) return 'gone'
    if (!deps.stillWanted()) return 'moved-on'
    if (deps.parked()) return 'parked'
    if (deps.now() >= deadline) return 'no-start'
    await deps.sleep(pollMs)
  }
  const end = await waitUntilTurnEnds({ ...deps, pollMs })
  return end === 'idle' ? 'ended' : end
}

/** How long a queued kickoff waits for the turn ahead of it to end, and then
 *  for a turn of its own to start. Past either it is held: the run fails
 *  with it rather than wait on a kickoff nothing confirms. */
export const QUEUED_TURN_END_MS = 300_000
export const QUEUED_OWN_TURN_MS = 15_000

export type QueuedTurnOutcome = 'started' | 'turn-never-ended' | 'no-own-turn' | 'parked' | 'gone' | 'moved-on'

/** A kickoff the CLI queued behind a turn still running: wait for a turn end
 *  after `since` (when the kickoff began to be typed), then for activity
 *  after that end, the queued kickoff's own turn. A turn end reported before
 *  `since` belongs to an earlier turn, and activity before the end to the
 *  turn the kickoff waited behind.
 *
 *  The times are when the window received each event, so a batch that brings
 *  the turn ahead's end, the kickoff turn's activity and its end together (a
 *  late transcript, a stalled backend) stamps them all alike: the last end is
 *  then the kickoff turn's, and no activity comes after it. A second turn end
 *  since `since` (`completionsSince`) is the kickoff's own turn, ended. */
export async function waitForQueuedTurn(deps: {
  since: number
  lastCompleteAt: () => number
  lastActiveAt: () => number
  parked: () => boolean
  alive: () => boolean
  stillWanted: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Turn ends received after the given time. */
  completionsSince?: (t: number) => number
  pollMs?: number
}): Promise<QueuedTurnOutcome> {
  const pollMs = deps.pollMs ?? 250
  const ownTurnEnded = (): boolean => (deps.completionsSince?.(deps.since) ?? 0) >= 2
  const stop = (): QueuedTurnOutcome | null =>
    !deps.alive() ? 'gone' : !deps.stillWanted() ? 'moved-on' : deps.parked() ? 'parked' : null
  const endBy = deps.now() + QUEUED_TURN_END_MS
  while (deps.lastCompleteAt() <= deps.since) {
    const why = stop()
    if (why) return why
    if (deps.now() >= endBy) return 'turn-never-ended'
    await deps.sleep(pollMs)
  }
  const ended = deps.lastCompleteAt()
  const startBy = deps.now() + QUEUED_OWN_TURN_MS
  while (deps.lastActiveAt() <= ended && deps.lastCompleteAt() <= ended && !ownTurnEnded()) {
    const why = stop()
    if (why) return why
    if (deps.now() >= startBy) return 'no-own-turn'
    await deps.sleep(pollMs)
  }
  return 'started'
}
