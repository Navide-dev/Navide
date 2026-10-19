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
 *  Claude's PermissionRequest hook runs only when its permission dialog is
 *  about to open, so it raises a hold that output alone cannot end — unlike
 *  the Notification hook's wait, which the 3 s settle releases on the box's
 *  own repaints. The answer ends it: an approved tool finishing
 *  (PostToolUse / PostToolUseFailure), or, for a denial, which fires no hook
 *  at all, the transcript record the denial writes. A transcript record only
 *  counts when it was written after the hold began: the reader can deliver an
 *  earlier tool's result after the hook, and that says nothing about the box
 *  now on screen. PreToolUse never releases — a parallel tool's PreToolUse can
 *  fire while the box is still open.
 *
 *  `heldSince` is the wall-clock ms the hold began, 0 when nothing is held —
 *  then nothing is released either, so a wait some other signal raised (the
 *  Notification hook, a screen match) is never ended from here. Null leaves
 *  the state untouched. */
export function permissionHoldActionFor(
  ev: { detail?: string; timestamp?: string },
  heldSince: number,
): 'hold' | 'release' | null {
  if (ev.detail === 'hook:permission_request') return 'hold'
  if (heldSince <= 0) return null
  if (ev.detail === 'hook:post_tool_use' || ev.detail === 'hook:post_tool_use_failure') return 'release'
  if (ev.detail !== undefined && USER_RECORD_DETAILS.has(ev.detail)) {
    const writtenAt = Date.parse(ev.timestamp ?? '')
    return Number.isFinite(writtenAt) && writtenAt > heldSince ? 'release' : null
  }
  return null
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
