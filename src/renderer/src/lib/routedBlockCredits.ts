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

/** A repaint can read a cell back blank: "worker ask Y2ddd9 5bdacf" for a
 *  block routed as "worker ask Y2ddd9e5bdacf" (0.2.44 Linux VM). Is `content`
 *  such a copy of a routed block? `routed` is that block's whitespace-free
 *  text, as the routers key it. Only blanked cells count, a few at most, so a
 *  message that differs in any letter it shows is never taken for a copy. */
export function isBlankedCopy(content: string, routed: string): boolean {
  let j = 0
  let blanked = 0
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (!/\s/.test(c)) {
      if (routed[j] !== c) return false
      j++
      continue
    }
    // A blank run: the cells the routed text has here before the next shown
    // character were read back blank. A plain space consumes none.
    let run = 1
    while (i + run < content.length && /\s/.test(content[i + run])) run++
    const next = content.slice(i + run).match(/\S/)?.[0]
    for (let k = 0; k < run && j < routed.length && routed[j] !== next; k++) { j++; blanked++ }
    i += run - 1
  }
  return j === routed.length && blanked > 0 && blanked <= Math.min(3, Math.floor(routed.length / 8))
}
