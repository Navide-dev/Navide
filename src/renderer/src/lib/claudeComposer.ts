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
 * Whose text is in the box decides what is done with it (composerOwner):
 * - a line the person at the keyboard is writing, or a collapsed paste of
 *   theirs whose content is not on screen — never touched; the messaging
 *   gate holds delivery while the screen still shows it;
 * - one of Navide's own envelopes — emptied with Ctrl-U, a diagnostic
 *   (inject.cleared-leftover) records it;
 * - anything else, a prompt an interrupt put back — emptied too, since the
 *   Enter would run it again, but the caller keeps the text and tells the
 *   person, with a way to put it back (lib/leftoverToast.ts).
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
import { isInjectedMessageText } from './agentMessaging'
import { normalizeForMatch, PASTE_PLACEHOLDER_RE } from './injectEcho'
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

/** Whose text the box holds, which decides what may be done with it.
 *  - 'user': the line the person is typing (tracked draft) — never touched;
 *  - 'user-paste': nothing but a collapsed paste ("[Pasted text #1 +12
 *    lines]") Navide did not type — its content is not on screen, so a clear
 *    could not be undone: left alone, and the messaging gate holds;
 *  - 'navide': one of Navide's own envelopes, or a collapsed paste typed by
 *    Navide after the person's last key — cleared, recorded only;
 *  - 'restored': anything else, which is a prompt an interrupt put back — the
 *    person's own words, most likely: cleared, kept, and offered back. */
export type ComposerOwner = 'user' | 'user-paste' | 'navide' | 'restored'

export function composerOwner(box: string, opts: { draft: string; navideTypedLast: boolean }): ComposerOwner {
  if (boxHoldsUserDraft(box, opts.draft)) return 'user'
  if (isInjectedMessageText(box.trimStart())) return 'navide'
  if (box.replace(new RegExp(PASTE_PLACEHOLDER_RE.source, 'gi'), '').trim() === '') {
    return opts.navideTypedLast ? 'navide' : 'user-paste'
  }
  return 'restored'
}

/** Display columns of one row (wide characters count two). */
function rowWidth(row: string): number {
  let used = 0
  for (const ch of row) used += WIDE_CHAR.test(ch) ? 2 : 1
  return used
}
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u

/** Columns a wrapped row may fall short of the box by: a word that did not
 *  fit moves to the next row whole. */
const WRAP_SLACK = 12

/** The box's rows put back together as typed, for the Restore button when
 *  the pane's last submitted prompt is not what the box holds (restoredText).
 *  A row that reaches the box's width was wrapped by the TUI and joins the
 *  next one (with the space the wrap ate, unless either side is a wide
 *  character); a shorter row ended at a newline. A best guess: a typed line
 *  break right at the edge reads as a wrap. */
export function unwrapComposer(box: string, cols: number): string {
  const width = Math.max(1, cols - 4)
  const rows = box.split('\n')
  let out = rows[0]
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]
    if (rowWidth(prev) < width - WRAP_SLACK) {
      out += '\n' + rows[i]
    } else {
      const wide = WIDE_CHAR.test(prev.slice(-1)) || WIDE_CHAR.test(rows[i].charAt(0))
      out += (wide ? '' : ' ') + rows[i]
    }
  }
  return out
}

/** What Restore puts back for a box an interrupt refilled. Claude Code
 *  hard-wraps the box, so the screen cannot tell a typed line break at the
 *  right edge from a wrap; the prompt the person last submitted in this pane
 *  (useTerminal's lastSubmittedPrompt) can. When the box holds that prompt —
 *  the same text once every wrap, indent and line break is taken out — the
 *  original comes back exactly; anything else (queued messages, an edit, a
 *  collapsed paste) is rebuilt from the rows. Never one of Navide's own
 *  envelopes: those are not the person's words. */
export function restoredText(box: string, cols: number, lastSubmitted: string): string {
  const squash = (text: string): string => text.replace(/\s+/g, '')
  if (lastSubmitted.trim() !== '' && !isInjectedMessageText(lastSubmitted.trimStart()) &&
      squash(lastSubmitted) === squash(box)) {
    return lastSubmitted
  }
  return unwrapComposer(box, cols)
}

export type LeftoverOutcome = 'none' | 'user-draft' | 'cleared' | 'unchanged'

/** Before typing into a Claude Code pane: empty a box that holds text the
 *  person at the keyboard is not writing. 'cleared' when the box changed,
 *  'unchanged' when Ctrl-U left it as it was (a suggestion, which typing
 *  replaces), 'user-draft' when it was left alone ('user' or 'user-paste'),
 *  'none' when there was nothing to do or no box to read. `onCleared` hears
 *  what was in the box, put back together (restoredText), and whose it was. */
export async function clearLeftoverPrompt(deps: {
  readScreen: () => string
  draftText: () => string
  lastSubmitted: () => string
  navideTypedLast: () => boolean
  cols: number
  send: (keys: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  onCleared: (cleared: { text: string; owner: 'navide' | 'restored'; diagnostic: string }) => void
}): Promise<LeftoverOutcome> {
  const box = claudeComposerText(deps.readScreen())
  if (!box) return 'none'
  const owner = composerOwner(box, { draft: deps.draftText(), navideTypedLast: deps.navideTypedLast() })
  if (owner === 'user' || owner === 'user-paste') return 'user-draft'
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
  deps.onCleared({
    text: owner === 'restored' ? restoredText(box, deps.cols, deps.lastSubmitted()) : unwrapComposer(box, deps.cols),
    owner,
    diagnostic: `cleared ${box.length} chars (${owner}) left in the input box before typing: "${preview}${box.length > 60 ? '…' : ''}"`,
  })
  return 'cleared'
}
