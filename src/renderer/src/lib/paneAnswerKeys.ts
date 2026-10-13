/**
 * Answer a pane's permission prompt or option menu with the vendor's own
 * keystrokes — for the chat-channel permission relay (`ui.pane.sendKeys`).
 *
 * Only fixed key sequences ever leave this module; nothing the remote sender
 * typed is forwarded. Every answer also needs evidence on screen: a numbered
 * menu whose options match what the answer is about to press. A vendor with no
 * mapping is refused rather than guessed at.
 *
 * Mappings (from the dialogs the awaiting patterns in agents/*.ts match):
 * - claude, codex: numbered select menus ("1. Yes …", "3. No, and tell … (esc)").
 *   A digit selects that option; Esc is the menu's "No" choice.
 * - aider: a line prompt "(Y)es/(N)o … [Yes]:" answered with y/n + Enter.
 *   It has no option menus.
 *
 * A permanent-allow option ("don't ask again", "always allow", "for this
 * session" …) is never pressed from here: that choice is made at the computer.
 */

export type PaneAnswer =
  | { kind: 'permission'; choice: 'allow' | 'deny' }
  | { kind: 'question'; option: number }

export type AnswerKeys = { ok: true; keys: string } | { ok: false; error: string; errorCode?: 'prompt-changed' }

const MENU_VENDORS = new Set(['claude', 'codex'])
const LINE_PROMPT_VENDORS = new Set(['aider'])

const ESC = '\x1b'
const MENU_LINE = /^\s*(?:[❯›>]\s*)?(\d)\.\s+(.+?)\s*$/
// Keep in sync with _PERMANENT_ALLOW_RE in backend/agent_team_backend/channels/relay.py.
const PERMANENT_ALLOW = new RegExp(
  [
    "\\bdon['’]?t ask again\\b",
    '\\bdo not ask again\\b',
    '\\balways\\b',
    '\\b(?:this|the) session\\b',
    '\\bauto[- ]?accept',
    '\\ballow all\\b',
    '\\bpermanent',
    '不再詢問|不再询问|一律允許|一律允许|自動核准|自动批准|總是允許|总是允许|始終允許|始终允许',
    '本次工作階段|此工作階段|本次会话|此会话',
    '今後|以降|常に許可|次回から|このセッション',
  ].join('|'),
  'i'
)

/** True for an option that allows more than this one prompt. */
export function isPermanentAllow(option: string): boolean {
  return PERMANENT_ALLOW.test(option)
}

/** Numbered options at the bottom of the screen: the last run 1, 2, 3 … */
export function parseMenuOptions(screen: string): string[] {
  let run: string[] = []
  let best: string[] = []
  for (const line of screen.split('\n')) {
    const m = MENU_LINE.exec(line)
    if (!m) continue
    const n = Number(m[1])
    if (n === 1) {
      run = [m[2]]
    } else if (n === run.length + 1) {
      run.push(m[2])
    } else {
      continue
    }
    best = run
  }
  return [...best]
}

/** The last ≤ 12 non-empty screen lines, capped at 800 characters. */
export function awaitingPromptText(screen: string): string {
  const lines = screen
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-12)
  const text = lines.join('\n')
  return text.length > 800 ? text.slice(-800) : text
}

// Equal up to whitespace, as relay.same_prompt and the MCP prompt fingerprint
// compare: a re-rendered screen re-wraps the same prompt.
const squash = (text: string) => text.split(/\s+/).filter(Boolean).join(' ')

function samePrompt(expected: { prompt: string; options: string[] }, screen: string): boolean {
  const options = parseMenuOptions(screen)
  return (
    squash(expected.prompt) === squash(awaitingPromptText(screen)) &&
    expected.options.length === options.length &&
    expected.options.every((o, i) => squash(o) === squash(options[i]))
  )
}

export function resolveAnswerKeys(input: {
  agentKey: string
  displayStatus: string | undefined
  awaitingKind: string | null | undefined
  screen: string
  answer: PaneAnswer
  /** The prompt and menu the caller checked the answer against (the MCP
   *  path's Guard screen); when given, the keys go in only while the same
   *  prompt is still on screen, so a prompt that replaced it is never answered. */
  expected?: { prompt: string; options: string[] }
}): AnswerKeys {
  const { agentKey, answer } = input
  if (input.displayStatus !== 'awaiting') return { ok: false, error: 'pane is not awaiting' }
  if (input.expected && !samePrompt(input.expected, input.screen)) {
    return { ok: false, error: 'the prompt on screen changed since it was checked', errorCode: 'prompt-changed' }
  }
  // A question answer only needs the menu on screen: claude's AskUserQuestion
  // box reports awaitingKind 'permission', so the kinds cannot be matched.
  if (answer.kind === 'permission' && input.awaitingKind !== 'permission') {
    return { ok: false, error: `pane is awaiting ${input.awaitingKind ?? 'nothing'}, not ${answer.kind}` }
  }

  if (LINE_PROMPT_VENDORS.has(agentKey)) {
    if (answer.kind !== 'permission') return { ok: false, error: `unsupported for ${agentKey}` }
    return { ok: true, keys: answer.choice === 'allow' ? 'y\r' : 'n\r' }
  }
  if (!MENU_VENDORS.has(agentKey)) return { ok: false, error: `unsupported for ${agentKey}` }

  const options = parseMenuOptions(input.screen)
  if (!options.length) return { ok: false, error: 'no option menu on screen' }
  if (answer.kind === 'permission') {
    if (answer.choice === 'allow') {
      if (!/^yes\b/i.test(options[0])) return { ok: false, error: 'the first option is not "Yes"' }
      if (isPermanentAllow(options[0])) return { ok: false, error: 'the first option allows permanently' }
      return { ok: true, keys: '1' }
    }
    if (!options.some((o) => /^no\b/i.test(o))) return { ok: false, error: 'the menu has no "No" option' }
    return { ok: true, keys: ESC }
  }
  const n = answer.option
  if (!Number.isInteger(n) || n < 1 || n > 9 || n > options.length) {
    return { ok: false, error: `option ${n} is not on the menu (1–${options.length})` }
  }
  if (isPermanentAllow(options[n - 1])) return { ok: false, error: `option ${n} allows permanently` }
  return { ok: true, keys: String(n) }
}
