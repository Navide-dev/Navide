/** Which worker ASK / REPORT blocks a pipeline router sends again.
 *
 *  The routers read blocks from the worker's screen, and the screen cannot say
 *  which turn printed a row: a TUI repaint re-emits a block already sent, and
 *  a block from an earlier turn is scanned again in the next one. So the
 *  screen sends a block only the first time its text is seen. Whether a later
 *  turn printed the same text again is read from that turn's own text (the
 *  CLI's reader, at turn end), which holds only what the turn printed.
 *
 *  A turn text that carries a block is a new message unless the screen already
 *  sent it for that turn. Each screen send leaves a credit with its receipt
 *  time; a turn text spends one credit the screen took after the pane's
 *  previous turn text, and sends the block when there is none. A vendor with
 *  no turn text never reaches the second half and keeps text-only dedupe. */

/** The screen sent `key` at `now` (its first sighting). */
export function noteScreenRoute(credits: Map<string, number[]>, key: string, now: number): void {
  credits.set(key, [...(credits.get(key) ?? []), now])
}

/** A turn text carries `key`: spend the screen send of the same turn, if any.
 *  `since` is when the pane's previous turn text arrived: a screen send before
 *  it belonged to that earlier turn and is dropped. False means no screen send
 *  covers this turn, so the block is a new message to send. */
export function takeScreenRoute(credits: Map<string, number[]>, key: string, since: number): boolean {
  const left = (credits.get(key) ?? []).filter((at) => at >= since)
  const taken = left.length > 0
  if (taken) left.shift()
  if (left.length) credits.set(key, left)
  else credits.delete(key)
  return taken
}
