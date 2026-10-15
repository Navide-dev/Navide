/** How long a turn in flight may show no sign of life before it is flagged. */
export const PANE_STUCK_AFTER_MS = 20 * 60_000

export interface PaneStuckInput {
  /** The pane's turn has started and not ended (see isTurnInFlight). */
  turnInFlight: boolean
  /** Last activity the CLI's own session log reported (0 = never). */
  lastLogActivityAt: number
  /** Last time the terminal's cleaned text changed (0 = never). */
  lastOutputAt: number
  now: number
  afterMs?: number
}

/**
 * When a pane went quiet in the middle of a turn, or null when it is not stuck.
 *
 * Nothing watched for this before: a CLI that hung mid-turn, or a pane Navide
 * still counts as mid-turn after an interrupt left it at its prompt, showed
 * "running" for as long as anyone cared to look. Both signals must be quiet: a
 * long command keeps printing while the log waits on its result, and a long
 * model call keeps the log moving while the screen sits still. A pane whose
 * CLI never reported log activity is left out, since there is nothing to
 * measure silence against.
 */
export function paneStuckSince(input: PaneStuckInput): number | null {
  if (!input.turnInFlight || input.lastLogActivityAt <= 0) return null
  const last = Math.max(input.lastLogActivityAt, input.lastOutputAt)
  return input.now - last >= (input.afterMs ?? PANE_STUCK_AFTER_MS) ? last : null
}
