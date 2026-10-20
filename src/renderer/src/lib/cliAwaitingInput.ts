// Deciding whether a CLI pane is parked on the user — blocked on a permission
// prompt or a question — as opposed to having finished its turn. The two look
// identical on the PTY: a prompt paints once and then goes silent, exactly
// like a turn that ended, so the RUNNING/idle heuristic cannot separate them
// and needs an out-of-band signal.
//
// There are two such signals, and which one a pane gets depends on its vendor:
//   • A notification hook we install, whose payload names the situation. This
//     is authoritative and is what claude/qwen/copilot use.
//   • Otherwise the prompt is recognized from the text it paints — the vendor
//     declares the shape in its `awaitingInput` spec (see agents/types.ts).
//
// Where each CLI stands, and why (surveyed 2026-08-08):
//
//   claude    hook   Notification, ~/.claude/settings.json
//   qwen      hook   Notification, ~/.qwen/settings.json (Claude's schema)
//   copilot   hook   notification, ~/.copilot/hooks/*.json (own file)
//   codex     text   Has a PermissionRequest hook, deliberately unused: Codex
//                    gates new hooks behind a trust screen the user must clear
//                    per pane, and again on every change to the hook file.
//   aider     text   No hook system at all. Its --notifications-command fires
//                    identically for "waiting" and "turn ended" and carries no
//                    payload, so it cannot answer the question.
//   kimi      —      Has PermissionRequest/PermissionResult hooks, but they
//                    fire only when an approval RPC surface exists, unverified
//                    for the TUI, and the payload's outer envelope (where a
//                    session id would live) was never confirmed. Attribution
//                    would fail silently.
//   opencode  —      Best mechanism of any of them (permission.updated over
//                    an SSE /event stream) but it needs the pane spawned with
//                    `--port`: without one the TUI serves no HTTP listener.
//                    Its on-screen strings are i18n keys, so text is out too.
//   kilo      —      An opencode fork; same story, and not installed here.
//   cursor    —      No permission event. Its beforeShellExecution hook is a
//                    synchronous gate — using it would make Navide part of the
//                    approval decision, not an observer of it.
//   antigravity text Hook docs unpublished, and no permission event. Its
//                    ask_question box is matched from the screen instead —
//                    a second route to the QUESTION its reader already raises
//                    from step_type 138, which needs marker binding first and
//                    reports nothing while that is pending. The permission box
//                    is still unmatched: its strings are in the binary but in
//                    none of the PTY captures, since Navide launches past it.
//   grok      —      Hooks exist but carry no permission event; its
//                    Notification is for background delegations. The TUI is
//                    compiled to bytecode, so no strings to match either.
//   muse      —      No hook system and no permission record in its log.
//   pi        —      Documented as deliberately having no permission prompts.
//                    It never stops to ask, so the state does not exist.

import { AGENT_SPECS } from '@navide/plugin-shell'

/** Notification types that block the turn until the user answers. Claude's
 *  other types are informational: `idle_prompt` fires every time a turn ends
 *  (the pane is genuinely idle then), and auth_success / elicitation_complete
 *  / elicitation_response all report something that already finished.
 *
 *  The docs page lists nine types; the binary carries eleven. The two extra
 *  ones both block, so they are read off the CLI itself rather than the docs
 *  (surveyed against 2.1.233: the full set is permission_prompt, idle_prompt,
 *  auth_success, elicitation_dialog, agent_needs_input, agent_completed,
 *  elicitation_url_dialog, worker_permission_prompt, push_notification,
 *  computer_use_enter, computer_use_exit).
 *  Source: https://code.claude.com/docs/en/hooks.md */
const AWAITING_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'permission_prompt', // Claude wants approval for a tool call
  'worker_permission_prompt', // the same, raised by a worker rather than the main agent
  'elicitation_dialog', // an MCP server opened a form and is waiting on it
  'elicitation_url_dialog', // the same, asked as a URL the user has to visit
  'agent_needs_input', // a background session is waiting (Claude Code 2.1.198+)
])

/** Notification types that mean the wait is over.
 *
 *  A hook fires once and never repeats, so unlike the polled pattern watcher
 *  it cannot re-check whether the prompt is still up — it needs an explicit
 *  release. Without one, the waits that end WITHOUT the CLI producing output
 *  (an MCP form submitted, a background session finishing, a turn ending on a
 *  prompt nobody answered) would hold AWAITING forever, which also parks the
 *  pane out of inter-CLI messaging and MCP dispatch. */
const RESOLVED_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'idle_prompt', // the turn ended; the CLI wants the next instruction
  'agent_idle', // copilot's spelling of the same thing
  'elicitation_complete', // the MCP form was submitted or dismissed
  'elicitation_response', // its answer went back to the server
  'agent_completed', // the background session finished or failed
])

/** True when a Notification hook payload means the pane is waiting on the user.
 *
 *  An unknown or missing type is NOT awaiting. The field is absent on Claude
 *  builds that predate it, and treating "unknown" as awaiting would light the
 *  badge on every `idle_prompt` — i.e. after every single turn — which also
 *  parks the pane out of inter-CLI messaging and MCP dispatch while it is in
 *  fact free. Losing the badge on an old build is the cheaper failure. */
export function notificationMeansAwaiting(notificationType: string | undefined): boolean {
  return notificationType !== undefined && AWAITING_NOTIFICATION_TYPES.has(notificationType)
}

/** True when a Notification hook payload means an earlier wait has ended.
 *
 *  Deliberately a whitelist and not `!notificationMeansAwaiting(...)`: an
 *  unrecognized type must do NOTHING. Clearing on unknown values would let a
 *  future notification type silently cancel a real permission prompt. */
export function notificationEndsAwaiting(notificationType: string | undefined): boolean {
  return notificationType !== undefined && RESOLVED_NOTIFICATION_TYPES.has(notificationType)
}

/** True when a completed turn's text ends on a question to the user.
 *
 *  The second half of the QUESTION state, and the weaker half. Claude's
 *  AskUserQuestion box is a structured signal the reader can name exactly; a
 *  turn that simply ENDS on "shall I go ahead?" has no marker at all, and the
 *  only thing separating it from a finished turn is the prose. So this reads
 *  the last non-empty line and asks whether it closes on a question mark.
 *
 *  Judged on the LAST LINE, never the whole turn: `text` carries the entire
 *  assistant message (up to 200k chars), and a mid-report rhetorical "?" would
 *  otherwise light the badge on turns that ask nothing. Trailing emphasis and
 *  list/quote punctuation are stripped first because a question routinely ends
 *  "**...?**" or "- ...?" once markdown is in play.
 *
 *  This is deliberately advisory. QUESTION passes the messaging gate exactly
 *  like idle does (see messagingHoldKey), so a false positive costs a wrong
 *  badge and nothing else — it can never park a pane out of inter-CLI dispatch. */
export function textEndsOnQuestion(text: string): boolean {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    return /[?？]["'’”）)\]*_`]*$/.test(line)
  }
  return false
}

/** Record types a reader attaches the user's own prompt text to. Shared by the
 *  question release below, the session-marker gate, and App.vue's auto-namer,
 *  which all key off the same three spellings ('user' for most vendors,
 *  'prompt' for kimi/aider, 'user_message' for codex). */
export const USER_RECORD_DETAILS: ReadonlySet<string> = new Set(['user', 'prompt', 'user_message'])

/** The reader's name for an assistant message that opened a question box. */
export const QUESTION_DETAIL = 'assistant:question'

/** What one `agent.activity` event means for a held permission wait.
 *
 *  Claude's PermissionRequest hook runs only when its permission dialog is about
 *  to open, so it raises a hold that output alone cannot end (the Notification
 *  hook's wait settles on the box's own repaints). Only the tool the box was for
 *  finishing releases it here: the backend stamps PermissionRequest and
 *  PostToolUse(Failure) with `tool_key`, the tool name plus a fingerprint of its
 *  input (the request carries no tool_use_id), and a result for any other tool —
 *  a parallel one, a subagent's — leaves the hold alone. Two identical calls
 *  share a key, so one finishing can release the other's box; the screen check
 *  (holdOutlivedBox) and the answering key pick that up. PreToolUse never
 *  releases, for the same parallel-tool reason.
 *
 *  Everything else that ends a hold is not an event: the answering key
 *  (keysAnswerPermissionBox), the turn end, a respawn, the screen check.
 *
 *  `held.since` is 0 when nothing is held; nothing is released then, so a wait
 *  some other signal raised (the Notification hook, a screen match) is never
 *  ended from here. A hold without a key matches nothing. */
export function permissionHoldActionFor(
  ev: { detail?: string; tool_key?: string },
  held: { since: number; key: string },
): 'hold' | 'release' | null {
  if (ev.detail === 'hook:permission_request') return 'hold'
  if (held.since <= 0 || held.key === '') return null
  if (ev.detail === 'hook:post_tool_use' || ev.detail === 'hook:post_tool_use_failure') {
    return ev.tool_key === held.key ? 'release' : null
  }
  return null
}

/** True when an `agent_active` event should stamp the pane's activity clocks
 *  (last active, last working, turn start).
 *
 *  Two kinds never do. idle_prompt fires about a minute after EVERY finished
 *  turn: the pane is waiting, not working. PostToolUse(Failure) run async, so
 *  under load the last tool's result can land after the Stop hook's
 *  turn_complete; stamping it would make isTurnInFlight read the finished pane
 *  as mid-turn (queued messages held, the loop's turn-end check stalled). They
 *  add no activity signal anyway — PreToolUse already stamped the tool's start —
 *  and exist only to release a permission hold (permissionHoldActionFor). */
export function activityStampsTurnClocks(ev: { detail?: string; notification_type?: string }): boolean {
  if (ev.notification_type === 'idle_prompt') return false
  return ev.detail !== 'hook:post_tool_use' && ev.detail !== 'hook:post_tool_use_failure'
}

/** True when `data` — what a pane is sent, from the keyboard (xterm's onData
 *  hands over one keystroke at a time) or from the chat relay (a short run such
 *  as `y\r`) — contains a key that answers a permission box: Enter, a lone Esc,
 *  Ctrl+C, or a digit 1-9 (the menu's numbered options).
 *
 *  Every way of answering the box is input to the pane, which ends the hold
 *  with no hook or record: a subagent's "No" lives in a transcript nobody reads,
 *  and a hook that approves and rewrites the input fires no matching result.
 *  Navigation (arrows, Tab) and ordinary letters do not answer. Escape
 *  SEQUENCES are skipped whole — an arrow is `ESC [ A`, not an Esc — and so are
 *  the terminal's own reports and replies (focus, mouse, device attributes,
 *  cursor position, colour and version strings): an X10 mouse report carries
 *  three printable bytes and an OSC/DCS reply is mostly digits. A bracketed
 *  paste is text. Choosing "No, and tell Claude what to do" and pressing Enter
 *  releases while the text field is open: the user is at the keyboard. */
export function keysAnswerPermissionBox(data: string): boolean {
  if (data.startsWith('\x1b[200~')) return false
  let i = 0
  while (i < data.length) {
    const c = data[i]
    if (c === '\r' || c === '\x03' || (c >= '1' && c <= '9')) return true
    if (c !== '\x1b') {
      i += 1
      continue
    }
    const next = data[i + 1]
    if (next === undefined) return true // a lone Esc
    if (next === '[') {
      if (data[i + 2] === 'M') {
        i += 6 // X10 mouse report: ESC [ M plus three bytes
        continue
      }
      let j = i + 2
      while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) j += 1
      i = j + 1 // past the final byte of the CSI sequence
    } else if (next === 'O') {
      i += 3 // SS3 (application-mode arrows, F1-F4)
    } else if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
      // OSC / DCS / SOS / PM / APC: a string, ended by BEL or ST (ESC \). These
      // are the terminal's replies to a CLI's queries (a colour, a version), and
      // their payload is full of digits.
      let j = i + 2
      while (j < data.length && data[j] !== '\x07' && !(data[j] === '\x1b' && data[j + 1] === '\\')) j += 1
      i = data[j] === '\x07' ? j + 1 : j + 2
    } else {
      i += 2 // Alt+key arrives as ESC plus the key
    }
  }
  return false
}

/** How long a hold may sit with no box on screen before that counts as
 *  evidence. The hook runs before the box paints. */
export const HOLD_PAINT_GRACE_MS = 1500

/** The one safety net under a held permission wait: true when the hold should
 *  end because the box it was raised for is not on screen. It covers what no key,
 *  hook or turn end reports — a hook that approved the call and rewrote its
 *  input (no box, no matching result), a box-less PermissionRequest on a pane
 *  that is not mid-turn. `boxOnScreen` is the vendor's awaitingInput pattern on
 *  the rendered screen tail, so this relies on that pattern recognising the
 *  current box, rows below it included. A pane that is mid-turn gets the paint
 *  grace; one that is not has nothing left to paint. */
export function holdOutlivedBox(state: {
  heldMs: number
  turnInFlight: boolean
  boxOnScreen: boolean
}): boolean {
  return !state.boxOnScreen && (!state.turnInFlight || state.heldMs >= HOLD_PAINT_GRACE_MS)
}

/** What one `agent.activity` event means for the QUESTION badge.
 *
 *  Pure, so the decision can be executed in a test instead of only inspected in
 *  App.vue's source — the handler is a closure inside an SFC that the suite
 *  cannot mount, and this is the seam where the two halves of QUESTION (the
 *  structured signal and the turn text) actually meet.
 *
 *  Returns null for the events that say nothing either way; the caller must
 *  leave the badge untouched then, NOT clear it. Most activity is tool calls
 *  and assistant chatter, and clearing on those would drop the badge the
 *  instant anything else happened in the pane. */
export function questionActionFor(ev: {
  event_type?: string
  detail?: string
  text?: string
}): 'raise' | 'clear' | null {
  // The named signal wins over everything, and is checked before the event
  // type because the two vendors that emit it disagree about which type it
  // belongs to. Claude's AskUserQuestion pauses a turn that then continues, so
  // its reader calls it agent_active; antigravity treats an ask_question step
  // as the end of the turn and reports turn_complete. Both mean the same
  // thing. Reading the type first cost antigravity its only reliable signal:
  // that event carries no text, so the turn_complete branch below scored it as
  // "did not end on a question" and actively CLEARED the badge.
  if (ev.detail === QUESTION_DETAIL) return 'raise'
  if (ev.event_type === 'turn_complete') {
    // Judged per turn, never retained: an empty-text turn_complete (Stop hook,
    // thinking-only record) must not inherit the previous turn's verdict, and a
    // turn that ends on anything else is the answer to an earlier question.
    return textEndsOnQuestion(ev.text ?? '') ? 'raise' : 'clear'
  }
  if (ev.event_type !== 'agent_active') return null
  // The answer to an AskUserQuestion box comes back as a plain user record,
  // which is also what a fresh prompt looks like. Both end the wait.
  if (ev.detail !== undefined && USER_RECORD_DETAILS.has(ev.detail)) return 'clear'
  return null
}

function awaitingSpecFor(agentKey: string): { pattern: RegExp; clearsOnMiss?: boolean } | undefined {
  return AGENT_SPECS.find((s) => s.agentKey === agentKey)?.awaitingInput
}

/** Whether this vendor's prompts can be recognized from PTY text at all.
 *  False for claude (it uses the hook instead) and for CLIs whose prompt shape
 *  has not been identified — those keep the plain idle/running behaviour. */
export function hasAwaitingPattern(agentKey: string): boolean {
  return awaitingSpecFor(agentKey) !== undefined
}

/** True when `screen` shows this vendor's prompt waiting for an answer.
 *
 *  `screen` must be the RENDERED text (useTerminal.readRenderedText), not the
 *  raw clean buffer: a TUI repaints its box in place, so an answered prompt
 *  stops appearing here by itself, while the raw stream keeps every frame it
 *  ever painted and would match forever.
 *
 *  Matching is whitespace-collapsed (mirrors matchLoginExpired) because the
 *  rendered text carries the hard-wraps a narrow pane inserts mid-phrase, so
 *  an unnormalized "Do you want to\nproceed?" would never match. Always false
 *  for vendors without a spec. */
export function matchAwaitingInput(agentKey: string, screen: string): boolean {
  const spec = awaitingSpecFor(agentKey)
  return spec !== undefined && spec.pattern.test(screen.replace(/\s+/g, ' '))
}

/** Whether a poll that stopped matching should clear this vendor's AWAITING.
 *
 *  True for a pattern-only vendor (the match is the state). False when the
 *  pattern merely supplements a notification hook, which sees waits the screen
 *  cannot — clearing there would drop a real one. A vendor with no pattern
 *  never reaches the watcher at all, so its answer here is irrelevant. */
export function awaitingClearsOnMiss(agentKey: string): boolean {
  return awaitingSpecFor(agentKey)?.clearsOnMiss !== false
}
