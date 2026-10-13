/**
 * injectEcho.ts
 *
 * Deciding whether injected text actually reached a CLI's input box. We watch
 * the pane's own echo: either the tail of what we sent shows up, or the buffer
 * grows enough that something clearly landed. Getting this wrong is expensive
 * in both directions — a false negative resends the whole prompt (the user
 * sees their instruction twice), a false positive presses Enter on an empty
 * box.
 */

/** Chars of the payload's tail to look for in the echo. Long enough to be
 *  unique, short enough to survive minor TUI re-rendering. */
export const TAIL_MATCH_LEN = 40

/** Buffer growth that counts as "something echoed" when the tail itself cannot
 *  be matched — e.g. a TUI that collapses a big paste into a placeholder. */
export const READY_GROWTH_MIN = 40

/** Strip whitespace *and* box-drawing characters before comparing.
 *
 *  A TUI that wraps our text draws its frame at every line break. Once
 *  whitespace is gone those frame characters sit in the middle of the payload
 *  and break an otherwise exact match — observed with a wrapped Chinese prompt
 *  in Claude Code, which resent the whole instruction because of it. */
export function normalizeForMatch(s: string): string {
  return s.replace(/[\s│┃┆┇┊┋╎╏|─━┄┅┈┉╌╍]+/g, '')
}

/** How we concluded our text landed. `tail` and `placeholder` observe the
 *  payload; `growth` only observes that the buffer changed size, which a
 *  booting TUI does regardless. */
export type EchoEvidence = 'tail' | 'placeholder' | 'growth'

/** How we concluded Enter took. `tail-left` watched our text leave the
 *  composer; `queued` saw the CLI's own "message queued" hint appear; `growth`
 *  only saw the terminal react. */
export type SubmitEvidence = 'tail-left' | 'queued' | 'growth'

/** Claude Code's footer hint once a mid-turn message is enqueued. Three
 *  wordings ship ("Press up to edit queued messages", "Press up to select a
 *  queued message to edit, …", "…, then Enter to edit it"); all share this
 *  prefix. Matched against the normalized screen, so it is written without
 *  spaces and survives wrapping and frame characters. */
export const QUEUED_HINT_RE = /pressupto(?:edit|selecta)queuedmessage/i

/** A line made of nothing but box-drawing glyphs and spaces — the frame of a
 *  CLI's bottom input widget (╭──╮ / ╰──╯). At least one box char is required
 *  so a plain blank line isn't matched (blanks are handled separately).
 *
 *  Lives here, in the module with no imports, because two places need the same
 *  answer and neither may depend on the other: serializeRenderedBuffer drops
 *  these rows off the end of a screen read, and composerFromScreen below uses
 *  them to find where the input box starts and ends. Two copies of a character
 *  class is how the two quietly stop agreeing. */
export const BOX_ONLY_LINE_RE = /^[\s─-╿]*[─-╿][\s─-╿]*$/

/** Bottom rows treated as the composer when a screen has no frame to locate it
 *  by — a plain shell, or a CLI that draws no input box. A guess, and the only
 *  reason it is tolerable is that submitBaseline records whether the guess
 *  actually found our text (composerHeldTail) and the verdict stays "not seen"
 *  when it did not. */
export const COMPOSER_FALLBACK_LINES = 3

/** The input box's contents, picked out of a rendered screen read.
 *
 *  Located by the frame, not by counting rows. Counting was tried and is wrong
 *  by construction: Claude Code's footer is a variable number of lines — the
 *  accept-edits mode line, a model line, a quota warning, an update notice —
 *  and every row it grows by pushes the composer out of a fixed window. That
 *  is not a safe degradation. submitEvidence would answer "not submitted",
 *  injectText would press Enter three times and report failure, and the sender
 *  would resend into a queue that already holds the message: the antigravity
 *  bug dc4b191e fixed, arriving from the other direction.
 *
 *  The frame does not move. Everything between the last closing box-only row
 *  and the box-only row above it is the composer; the message a TUI redraws
 *  once the Enter takes is drawn ABOVE the box and is therefore out of scope by
 *  construction, whatever the footer is doing. Without a frame — a plain shell,
 *  a CLI that draws no box — fall back to the bottom few rows. */
export function composerFromScreen(screen: string): string {
  return framedComposer(screen) ?? screen.split('\n').slice(-COMPOSER_FALLBACK_LINES).join('\n')
}

/** The input box located by its frame alone — null when the screen has no
 *  frame to locate it by. Split out of composerFromScreen for the one caller
 *  that must not act on the bottom-rows guess: the collapsed-paste check in
 *  submitEvidence, where a wrong guess would refuse a submit that took. */
export function framedComposer(screen: string): string | null {
  const lines = screen.split('\n')
  let close = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BOX_ONLY_LINE_RE.test(lines[i])) { close = i; break }
  }
  if (close > 0) {
    for (let open = close - 1; open >= 0; open--) {
      if (BOX_ONLY_LINE_RE.test(lines[open])) {
        return lines.slice(open + 1, close).join('\n')
      }
    }
  }
  return null
}

/** What the composer looked like BEFORE Enter, for the `queued` verdict. The
 *  queue hint alone is ambiguous once a message is already queued: it stays on
 *  screen whether or not this Enter took. So the caller samples it, plus
 *  whether our tail was inside the narrow composer window — the one thing
 *  whose disappearance means this Enter, and this Enter only. */
export interface SubmitBaseline {
  queuedHint: boolean
  composerHeldTail: boolean
}

/** Sample the composer before pressing Enter. `screen` is the same read
 *  (SUBMIT_SCREEN_LINES) the submitEvidence polls use — the input box is
 *  picked out of it by composerFromScreen, so there is only ever one read. */
export function submitBaseline(opts: { screen: string; tail: string }): SubmitBaseline {
  return {
    queuedHint: QUEUED_HINT_RE.test(normalizeForMatch(opts.screen)),
    composerHeldTail:
      !!opts.tail && normalizeForMatch(composerFromScreen(opts.screen)).includes(opts.tail),
  }
}

/** Whether a pair of evidences is strong enough to call the injection verified.
 *  Growth-only on either half means we wrote bytes and cannot say where they
 *  went — an honest "unverified", not a success and not a failure. */
export function injectionVerified(
  echo: EchoEvidence | null,
  submit: SubmitEvidence | null,
): boolean {
  return echo !== null && echo !== 'growth' && submit !== null && submit !== 'growth'
}

/** Whether a spawn kickoff landed. Strict evidence (injectionVerified) is
 *  unreachable for the common case: Claude Code collapses a multi-line paste
 *  to "[Pasted text #N +M lines]", so the tail is never on screen, Enter can
 *  only be judged by growth, and every long kickoff read 'unverified' — which
 *  the retry loop then retyped or reported failed with a resend hint, doubling
 *  the task. Once the prompt-ready gate has opened (idle + quiet), the pane is
 *  not painting anything of its own, so growth after Enter is the CLI
 *  reacting to us and counts as the submit half.
 *
 *  The ECHO half still has to observe the payload — `tail` or the collapsed
 *  paste's own summary. Growth there is 40 bytes for any payload over 80
 *  characters (growthNeededFor caps at READY_GROWTH_MIN), which a periodic
 *  repaint clears on its own: an update notice, a hook line, or the SIGWINCH
 *  repaint the new pane's own layout reflow triggers. Accepting it would
 *  report `kickoff: "sent"` for a paste the CLI never took — the exact
 *  silence this verdict exists to end. Without the gate, growth stays what it
 *  was: a booting TUI repainting. */
export function kickoffVerified(
  echo: EchoEvidence | null,
  submit: SubmitEvidence | null,
  promptReady: boolean,
): boolean {
  if (injectionVerified(echo, submit)) return true
  return promptReady && echo !== null && echo !== 'growth' && submit !== null
}

/** Growth that counts as "echoed" for a payload of this size.
 *
 *  A flat 40 chars is unreachable for a short prompt: a one-line instruction
 *  can normalize to fewer than 40 characters, so the buffer can never grow
 *  that much and the only remaining signal is the tail match. Scale it down
 *  for short payloads, keeping a floor that noise cannot reach. */
export function growthNeededFor(normalizedLength: number): number {
  return Math.min(READY_GROWTH_MIN, Math.max(8, Math.floor(normalizedLength / 2)))
}

/** A TUI that decides a paste is too big to show collapses it to a summary —
 *  "[Pasted text #1 +40 lines]" and its variants — and the payload itself is
 *  never drawn. Recognising that summary is how we tell "the paste landed"
 *  apart from "nothing happened" in the one case where neither of the other
 *  two signals can fire. */
export const PASTE_PLACEHOLDER_RE = /\[pasted?\s+text\b[^\]]*\]/i

/** Chars either side of the grown region to search for the placeholder. The
 *  summary can straddle the boundary when the TUI redraws the composer rather
 *  than appending to it. */
const PLACEHOLDER_MARGIN = 120

/** Has our text landed in the input box? `tail` is the normalized tail of the
 *  payload; `buffer` the pane's current clean scrollback. */
export function echoLanded(
  buffer: string,
  tail: string,
  grownBy: number,
  normalizedLength: number,
): boolean {
  return echoEvidence(buffer, tail, grownBy, normalizedLength) !== null
}

/** What kind of evidence says our text landed — or null when none does.
 *
 *  Same decision as echoLanded, same order, but it does not flatten *how* it
 *  decided. That distinction is load-bearing: `tail` and `placeholder` both
 *  observe the payload itself, while `growth` only observes that the buffer got
 *  bigger. A CLI painting its first screen grows the buffer no matter what
 *  happened to our bytes, so on a freshly spawned pane `growth` is not evidence
 *  at all — it is the absence of evidence, reported as success. Callers that
 *  care (a spawn kickoff) can tell the two apart; callers that just need a
 *  yes/no keep using echoLanded and are unaffected. */
export function echoEvidence(
  buffer: string,
  tail: string,
  grownBy: number,
  normalizedLength: number,
): EchoEvidence | null {
  if (tail && normalizeForMatch(buffer).includes(tail)) return 'tail'
  // The collapsed-paste case. A TUI that decides the paste is too big to show
  // draws a short, fixed-size summary instead, so neither the tail nor enough
  // bytes to account for the payload ever appear. A long message read as
  // "never arrived", was sent again, and again: three copies of one message
  // sat in antigravity's composer while the send reported failure, Enter never
  // pressed. Short messages were unaffected, which is why this looked like a
  // length limit rather than a verification fault.
  //
  // Only a summary inside the region that just grew counts. One left over from
  // an earlier paste would otherwise say "landed" while nothing of ours had,
  // and the Enter that follows would submit whatever the composer was holding.
  //
  // Asked BEFORE growth, which it used to sit behind. A collapsed paste grows
  // the buffer too — the summary plus the composer repaint clears the 40-byte
  // bar on its own — so growth answered first and this branch was unreachable
  // in the one case it was written for. The label is load-bearing now that
  // kickoffVerified trusts a payload-observing echo and refuses a growth-only
  // one, and the two are only ever told apart here.
  if (grownBy > 0 && PASTE_PLACEHOLDER_RE.test(buffer.slice(-(grownBy + PLACEHOLDER_MARGIN)))) {
    return 'placeholder'
  }
  if (grownBy >= growthNeededFor(normalizedLength)) return 'growth'
  return null
}

/** Is the composer holding OUR payload right now — either its normalized
 *  `tail` verbatim, or the collapsed-paste summary a TUI draws in its place?
 *
 *  Asked before a spawn kickoff judged 'unverified' is typed a second time:
 *  growth-only evidence cannot say whether the first copy landed, and typing
 *  another on top of it would submit both as one prompt. A vendor's own
 *  empty-composer hint ("Try \"fix lint errors\"") matches neither signal, so
 *  it reads as blank — which it is, as far as our text goes. `screen` is the
 *  rendered bottom of the visible screen (useTerminal.readScreenTail). */
export function composerHoldsPayload(screen: string, tail: string): boolean {
  if (!tail) return false
  return normalizeForMatch(screen).includes(tail) || PASTE_PLACEHOLDER_RE.test(screen)
}

/** Is the FRAMED input box holding our payload — its tail or a collapsed
 *  paste summary? null when the screen has no frame to locate the box by.
 *
 *  Narrower than composerHoldsPayload on purpose: it decides whether to press
 *  Enter on a held kickoff and whether that Enter took, and a summary Claude
 *  Code redraws ABOVE the box after a submit that took must read as released,
 *  not held. No frame means no answer, so nothing presses Enter on a guess. */
export function framedComposerHolds(screen: string, tail: string): boolean | null {
  const framed = framedComposer(screen)
  if (framed === null) return null
  return (!!tail && normalizeForMatch(framed).includes(tail)) || PASTE_PLACEHOLDER_RE.test(framed)
}

/** Lines at the bottom of the visible screen that hold the input box. Small
 *  on purpose: a TUI redraws the submitted message just ABOVE the composer, so
 *  a generous window keeps matching our tail after a successful submit. */
export const SUBMIT_SCREEN_LINES = 8

/** How long to watch the input box after each Enter before resending it. */
export const SUBMIT_CONFIRM_MS = 2_500

/** Did Enter actually submit? Buffer growth cannot answer this: a TUI with a
 *  spinner or a status footer repaints constantly, so the buffer grows whether
 *  or not the composer was ever emptied — antigravity reported every injected
 *  message as delivered while the text sat unsent in its input box.
 *
 *  When our tail echoed into the composer we have a far better signal: it
 *  LEAVES the composer once submitted. Only when the tail never echoed
 *  verbatim (a TUI that collapses a big paste into a placeholder) do we fall
 *  back to "the terminal reacted at all".
 *
 *  `screen` is the rendered bottom of the visible screen
 *  (useTerminal.readScreenTail), not the raw scrollback. */
export function submitLanded(opts: {
  tailWasOnScreen: boolean
  tail: string
  screen: string
  grownBy: number
}): boolean {
  return submitEvidence(opts) !== null
}

/** What kind of evidence says Enter took — or null when none does.
 *
 *  Same split as echoEvidence: `tail-left` watched our own text leave the
 *  composer, `growth` only saw the terminal react at all. The second is the
 *  documented fallback for TUIs that collapse a paste, and it is exactly as
 *  weak on a booting pane as growth is for the echo. */
export function submitEvidence(opts: {
  tailWasOnScreen: boolean
  tail: string
  screen: string
  grownBy: number
  /** From submitBaseline(), sampled before Enter. Without it the hint alone
   *  decides — the caller has not been wired for the snapshot yet. */
  baseline?: SubmitBaseline
}): SubmitEvidence | null {
  if (opts.tailWasOnScreen && opts.tail) {
    const screen = normalizeForMatch(opts.screen)
    if (!screen.includes(opts.tail)) return 'tail-left'
    // Claude Code mid-turn: Enter enqueues the message and redraws it just
    // above the composer, so our tail never leaves the screen and 'tail-left'
    // cannot fire. Its queue hint is the positive signal instead. Without it
    // every mid-turn delivery was reported as inject-failed after 3 Enters,
    // the sender resent, and the recipient's queue held 3–4 copies.
    if (!QUEUED_HINT_RE.test(screen)) return null
    // A hint that was already up before this Enter proves nothing about THIS
    // message. Only the input box can answer that: 'tail-left' fails here
    // because the screen still shows the enqueued copy drawn above the box,
    // while the box itself is empty. composerFromScreen is what separates the
    // two — by the frame, never by a row count (see its comment).
    //
    // Counting copies of the tail in the clean buffer was tried and cannot
    // work in either direction. The clean buffer is the raw output stream and
    // an Ink TUI redraws its whole bottom region on every spinner frame, so
    // the composer — still holding our tail — is copied several times a
    // second whether or not the Enter took: an exact +1 was never met (every
    // second mid-turn delivery read as unsubmitted after 3 Enters), and "one
    // more, at least" is met by the repaint alone (every one of them reads as
    // delivered, text still sitting in the box). The raw stream cannot tell a
    // repaint from an addition; a rendered screen can, because it only ever
    // holds the current state.
    if (opts.baseline && opts.baseline.queuedHint) {
      // Nothing to watch leave: this vendor draws no frame and the fallback
      // rows did not hold our text either. The honest answer is "not seen" —
      // the sender checks instead of being told a message that may still be
      // sitting in the composer was delivered.
      if (!opts.baseline.composerHeldTail) return null
      return normalizeForMatch(composerFromScreen(opts.screen)).includes(opts.tail)
        ? null
        : 'queued'
    }
    return 'queued'
  }
  // The collapsed-paste case: the tail never echoed, so growth is the only
  // signal left — and growth alone cannot tell Enter from a repaint. Observed
  // in Claude Code: an Enter sent right after the collapsed paste appeared did
  // not take. With the pane focused, the TUI repainted on its own, the repaint
  // read as 'growth', and the message was reported delivered while the
  // "[Pasted text …]" summary still sat in the box; unfocused, the pane stayed
  // quiet, the poll ran out, and the resent Enter took. The rendered box says
  // which happened: while it still shows the summary, nothing was submitted.
  // Framed box only — the bottom-rows guess a frameless vendor gets could hold
  // the summary a TUI echoes just above its box after a submit that took.
  const framed = framedComposer(opts.screen)
  if (framed !== null && PASTE_PLACEHOLDER_RE.test(framed)) return null
  return opts.grownBy > 0 ? 'growth' : null
}

/** How long to wait for the echo before concluding the bytes never landed.
 *
 *  Scales with payload size, but the floor is what matters: a CLI that has
 *  just booted needs several seconds to paint its first echo. At a 2.5s floor
 *  a freshly spawned pane resent a short prompt three times before the first
 *  one appeared, so the user saw their instruction three times over. A higher
 *  floor costs nothing in the normal case — the poll breaks out as soon as the
 *  echo shows up. */
export function echoTimeoutFor(textLength: number): number {
  return Math.min(8_000, Math.max(6_000, Math.floor(textLength / 6)))
}

/** Did Enter submit a line typed into a plain shell? submitEvidence cannot
 *  say: the command line a shell executed stays on screen above its output,
 *  so "our tail is still showing" is the normal result of a success. What does
 *  move is the cursor — onto the command's output or the next prompt — so the
 *  line before it no longer ends in our text. `cursorLine` is that line
 *  (useTerminal.readLineBeforeCursor), null when it cannot be read. */
export function shellSubmitEvidence(cursorLine: string | null, tail: string): SubmitEvidence | null {
  if (cursorLine === null || !tail) return null
  return normalizeForMatch(cursorLine).endsWith(tail) ? null : 'tail-left'
}
