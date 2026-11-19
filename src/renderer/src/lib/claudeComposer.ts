/**
 * claudeComposer.ts
 *
 * What Claude Code's input box holds right before Navide types into it.
 *
 * An interrupt (Esc, cli_interrupt) makes Claude Code put the prompt it was
 * working on — and any queued messages — back in the input box. Text typed
 * after that lands behind it, and the Enter submits both as one prompt: the
 * interrupted prompt runs again, glued to the next message (0.2.38–0.2.44).
 *
 * Two kinds of text can be in the box and they are owed different things:
 * - a line the person at the keyboard is writing — never touched; the
 *   messaging gate holds delivery while the screen still shows it;
 * - anything else (a restored prompt, a leftover of ours) — emptied with
 *   Ctrl-U before typing, since whoever interrupted meant it not to run, and
 *   a diagnostic (inject.cleared-leftover) records what was cleared.
 *
 * Claude Code's "suggested next prompt" is drawn in the empty box too and
 * reads like text on a plain screen read. Ctrl-U on an empty box does nothing,
 * so clearing it costs nothing; the diagnostic only fires when the box
 * actually changed.
 *
 * Any other CLI, or a Claude screen whose box cannot be located, reads as
 * null and is left as it was.
 */
import { composerClearKeys } from './cliCoordination'
import { normalizeForMatch } from './injectEcho'
import { PROMPT_ROW, PROMPT_RULE } from './paneAnswerKeys'

/** Rows a box may span before the read stops trusting it is one. */
const MAX_BOX_ROWS = 60

/** Tracked keystrokes shorter than this are a menu answer (`1`, `y`), not a
 *  line someone is writing — the draft tracker's own SINGLE_KEY_ANSWER_MAX. */
const MIN_DRAFT_CHARS = 3

/** Chars of the tracked draft looked for in the box (the tracker keeps the
 *  last 100; the box wraps and re-indents them). */
const DRAFT_MATCH_LEN = 40

/** The text in Claude Code's input box, or null when the screen shows no box
 *  framed by its two rules. Empty string for an empty box. Read from the
 *  bottom: the box is the last framed "❯" row, and a slash-command menu drawn
 *  under it has a ❯ cursor of its own but no closing rule. */
export function claudeComposerText(screen: string): string | null {
  const lines = screen.split('\n')
  for (let at = lines.length - 1; at > 0; at--) {
    if (!PROMPT_ROW.test(lines[at]) || !PROMPT_RULE.test(lines[at - 1])) continue
    let close = -1
    for (let j = at + 1; j < lines.length && j <= at + MAX_BOX_ROWS; j++) {
      if (PROMPT_RULE.test(lines[j])) { close = j; break }
    }
    if (close < 0) continue
    const rows = lines.slice(at, close)
    rows[0] = rows[0].replace(/^\s*(?:│\s*)?[❯>]/, '')
    return rows.map((r) => r.replace(/^\s*│/, '').replace(/│\s*$/, '').trim()).join('\n').trim()
  }
  return null
}

/** True when the box holds what the person at the keyboard typed and has not
 *  sent: the tracked draft's tail is in it. */
export function boxHoldsUserDraft(box: string | null, draft: string): boolean {
  if (!box) return false
  const typed = normalizeForMatch(draft)
  if (typed.length < MIN_DRAFT_CHARS) return false
  return normalizeForMatch(box).includes(typed.slice(-DRAFT_MATCH_LEN))
}

export type LeftoverOutcome = 'none' | 'user-draft' | 'cleared' | 'unchanged'

/** Before typing into a Claude Code pane: empty a box that holds text the
 *  person at the keyboard is not writing. 'cleared' when the box changed,
 *  'unchanged' when Ctrl-U left it as it was (a suggestion, which typing
 *  replaces), 'user-draft' when it was left alone, 'none' when there was
 *  nothing to do or no box to read. */
export async function clearLeftoverPrompt(deps: {
  readScreen: () => string
  draftText: () => string
  cols: number
  send: (keys: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  record: (message: string) => void
}): Promise<LeftoverOutcome> {
  const box = claudeComposerText(deps.readScreen())
  if (!box) return 'none'
  if (boxHoldsUserDraft(box, deps.draftText())) return 'user-draft'
  for (const keys of composerClearKeys(box, deps.cols)) {
    try {
      await deps.send(keys)
    } catch {
      return 'none' // the session is gone; the send that follows fails too
    }
    await deps.sleep(100)
  }
  await deps.sleep(150) // let the box repaint before it is read again
  if (claudeComposerText(deps.readScreen()) === box) return 'unchanged'
  const preview = box.replace(/\s+/g, ' ').slice(0, 60)
  deps.record(`cleared ${box.length} chars left in the input box before typing: "${preview}${box.length > 60 ? '…' : ''}"`)
  return 'cleared'
}
