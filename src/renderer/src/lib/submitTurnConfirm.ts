/**
 * submitTurnConfirm.ts
 *
 * The second look injectText (App.vue) takes after Enter when the only
 * evidence it has is 'growth' — the terminal reacted, nothing more. A focused
 * TUI repaints on its own, so growth alone has reported a collapsed paste
 * delivered while it still sat unsent in the box. What does mean the CLI took
 * the message is the CLI starting a new turn, so that is what this waits for.
 *
 * Only growth pays the wait. A verdict that watched our own text leave the
 * box, or the CLI's own queue hint appear, is returned untouched and at once.
 */

import { matchAwaitingInput } from './cliAwaitingInput'
import { BOX_ONLY_LINE_RE, type SubmitEvidence } from './injectEcho'
import { screenShowsBlockingDialog } from './sessionMarkerTurn'

/** How long to watch for the new turn after a growth-only submit. */
export const SUBMIT_TURN_CONFIRM_MS = 12_000

/** Whether a vendor's log reader reports the start of a turn (agent_active
 *  after a turn end) — the only thing the watch can wait for. Every agent spec
 *  is listed on purpose (a test enforces it): a vendor that cannot signal a
 *  turn would have every growth-only submit read as unconfirmed, and a
 *  scheduler run recorded as an error. Those keep main's growth verdict. */
export const TURN_START_SIGNAL: Readonly<Record<string, boolean>> = {
  claude: true,
  codex: true,
  copilot: true,
  cursor: true,
  droid: true,
  antigravity: true,
  aider: true,
  muse: true,
  opencode: true,
  kilo: true,
  grok: true,
  kimi: true,
  pi: true,
  qwen: true,
  // No log reader: mcode keeps its history in SQLite Navide cannot read yet.
  mcode: false,
  // A plain shell takes its own submit path and never reaches the watch.
  terminal: false,
}

/** Watch for a new turn only where one can be seen, and only on a pane that
 *  was not already mid-turn: a message pushed mid-turn is queued by the CLI
 *  and starts no turn of its own until the current one ends, however long
 *  that is. Both cases keep main's growth verdict. */
export function shouldWatchTurn(input: { agentKey: string | undefined; midTurn: boolean }): boolean {
  return !input.midTurn && input.agentKey !== undefined && TURN_START_SIGNAL[input.agentKey] === true
}

/** An Enter we add on our own goes only into a box we located by its frame,
 *  that still holds the collapsed paste, with no dialog on screen — Enter on
 *  a permission or confirm dialog picks its default option. */
export function extraEnterAllowed(framedHeld: boolean | null, dialogShown: boolean): boolean {
  return framedHeld === true && !dialogShown
}

/** A frameless composer's prompt row, and a menu's cursor row (a numbered
 *  option) that uses the same glyph. */
const PROMPT_ROW_RE = /^\s*[›>❯]/
const OPTION_ROW_RE = /^\s*[›>❯]\s*\d+[.)]/
/** A prompt row inside a drawn frame, whose side border may precede the glyph.
 *  A numbered option is not one: a dialog's own cursor row ("❯ 1. Yes") sits
 *  between the box-only rows its separators draw. */
const FRAMED_PROMPT_ROW_RE = /^[\s│]*[›>❯](?!\s*\d+[.)])/

/** Is a dialog that would take an Enter as its answer on screen?
 *
 *  `awaitingKind` 'permission' is one by definition. 'question' is NOT: the
 *  turn ended on a question and the CLI is back at its ordinary prompt — the
 *  message gate lets such a pane through on purpose (parkedOnQuestion).
 *
 *  The text patterns are read only below the input box when its frame can be
 *  located: our own unsent message inside the box, or the transcript above
 *  it, may quote a dialog's wording without any dialog being up. With no
 *  frame (codex), the composer is the last prompt row and what wraps below
 *  it, and only the rows above it are read — unless that row is a numbered
 *  option, the cursor of a menu drawn in the composer's place, or a dialog
 *  pattern matches below it (aider prints its Y/N question under the
 *  submitted "> message" row, with no prompt row of its own); then, as with
 *  no prompt row at all, the whole screen is read. Safety first: a wrapped
 *  message quoting a dialog below its prompt row reads as a dialog too. */
export function blockingDialogShown(input: {
  awaitingKind: string | null | undefined
  agentKey: string | undefined
  screen: string
}): boolean {
  if (input.awaitingKind === 'permission') return true
  const matches = (text: string): boolean => screenShowsBlockingDialog(text)
    || (!!input.agentKey && matchAwaitingInput(input.agentKey, text))
  const lines = input.screen.split('\n')
  let close = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BOX_ONLY_LINE_RE.test(lines[i])) { close = i; break }
  }
  let open = -1
  for (let i = close - 1; i >= 0; i--) {
    if (BOX_ONLY_LINE_RE.test(lines[i])) { open = i; break }
  }
  // Two box-only rows are the input box only when a prompt row sits between
  // them: border characters left below a live dialog's footer pair up the same
  // way, and reading below THEM would skip the dialog.
  const framed = open >= 0 && lines.slice(open + 1, close).some(line => FRAMED_PROMPT_ROW_RE.test(line))
  let region = input.screen
  if (framed) {
    region = lines.slice(close + 1).join('\n')
  } else {
    let prompt = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (PROMPT_ROW_RE.test(lines[i])) { prompt = i; break }
    }
    if (prompt >= 0 && !OPTION_ROW_RE.test(lines[prompt]) && !matches(lines.slice(prompt + 1).join('\n'))) {
      region = lines.slice(0, prompt).join('\n')
    }
  }
  return matches(region)
}

/** 'turn' once the CLI starts a new turn inside the window, 'unconfirmed'
 *  when it does not, null once the injection is aborted. Any verdict but
 *  'growth' — and growth when `watchTurn` is false — comes back as it went
 *  in, without a single sleep.
 *
 *  While watching, a framed box that still holds the collapsed paste gets ONE
 *  more Enter, and only when extraEnterAllowed says so. */
export async function confirmWeakSubmit(deps: {
  how: SubmitEvidence
  /** shouldWatchTurn's answer for this pane, sampled before the Enter. */
  watchTurn: boolean
  /** A permission / confirm dialog is on screen. */
  dialogShown: () => boolean
  /** Has the CLI started a turn since the Enter that produced `how`? */
  turnStarted: () => boolean
  collapsedHeld: () => boolean | null
  /** False when the keystroke could not be written. */
  pressEnter: () => Promise<boolean>
  aborted: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  windowMs?: number
  pollMs?: number
}): Promise<SubmitEvidence | null> {
  if (deps.how !== 'growth' || !deps.watchTurn) return deps.how
  const pollMs = deps.pollMs ?? 250
  const deadline = deps.now() + (deps.windowMs ?? SUBMIT_TURN_CONFIRM_MS)
  let pressed = false
  while (deps.now() < deadline) {
    await deps.sleep(pollMs)
    if (deps.aborted()) return null
    if (deps.turnStarted()) return 'turn'
    if (!pressed && extraEnterAllowed(deps.collapsedHeld(), deps.dialogShown())) {
      pressed = true
      await deps.pressEnter()
    }
  }
  return deps.turnStarted() ? 'turn' : 'unconfirmed'
}
