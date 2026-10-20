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
 * - grok: its folder-trust prompt ("Yes, proceed y / No, quit n") takes the
 *   hotkey alone, no Enter. "No, quit" exits the CLI — that is the prompt's
 *   own No. It has no other prompt Navide can see. Its "Yes" is refused:
 *   Grok keeps the folder trusted for good, so it is a permanent allow.
 *
 * - claude's AskUserQuestion box also takes free text and multi-select answers
 *   (Claude Code 2.1.304's components): its "Other" row ("Type something.")
 *   is a text box the cursor has to be on, so the arrows move there, the text
 *   is typed and Enter submits. A multi-select menu boxes every row ("[ ]",
 *   "[✔]"); a digit toggles that box unless the cursor is on the text row (the
 *   digit would be typed there), and Down from the last row reaches the
 *   Submit / Next button, which Enter presses. Each step is written on its own
 *   (`steps`), so the CLI never reads text and Enter as one paste.
 *
 * Free text is the only input the remote sender shapes, and it is typed into
 * the text box the question offered, as one line with no control characters.
 *
 * A permanent-allow option ("don't ask again", "always allow", "for this
 * session" …) is never pressed from here: that choice is made at the computer.
 */

export type PaneAnswer =
  | { kind: 'permission'; choice: 'allow' | 'deny' }
  | { kind: 'question'; option: number; text?: string }
  | { kind: 'multi'; options: number[]; text?: string }

export type AnswerKeys =
  | { ok: true; keys: string; steps?: string[] }
  | { ok: false; error: string; errorCode?: 'prompt-changed' }

const MENU_VENDORS = new Set(['claude', 'codex'])
// Vendors whose menus take free text and multi-select answers (see above).
const TEXT_MENU_VENDORS = new Set(['claude'])
const LINE_PROMPT_VENDORS = new Set(['aider'])
const HOTKEY_VENDORS = new Set(['grok'])
// Vendors whose "allow" is always permanent. Keep in sync with
// PERMANENT_ALLOW_AGENTS in backend/agent_team_backend/channels/relay.py.
const PERMANENT_ALLOW_VENDORS = new Set(['grok'])

const ESC = '\x1b'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const MAX_ANSWER_TEXT = 500
const MENU_LINE = /^\s*(?:[❯›>]\s*)?(\d)\.\s+(.+?)\s*$/
const CURSOR_LINE = /^\s*[❯›>]/
// Keep in sync with _MULTI_SELECT_RE and _FREE_TEXT_RE in backend/agent_team_backend/channels/relay.py.
const CHECKBOX = /^\s*(?:\[[^\]]?\]|[☐☑☒□■◻◼✓✔✗])/
const CHECKED = /^\s*(?:\[[^\s\]]\]|[☑☒■◼✓✔✗])/
const FREE_TEXT = /^\s*(?:type something|type here|something else|other\b|自行輸入|自由輸入|其他)/i
// Keep in sync with _PERMANENT_ALLOW_RE in backend/agent_team_backend/channels/relay.py.
const PERMANENT_ALLOW = new RegExp(
  [
    "\\bdon['’]?t ask (?:me )?again\\b",
    '\\bdo not ask (?:me )?again\\b',
    '\\balways\\b',
    '\\b(?:this|the) session\\b',
    '\\bauto[- ]?accept',
    // "Yes, and switch to auto mode": auto mode then approves every later prompt.
    '\\bauto mode\\b',
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
  return parseMenu(screen).options
}

/** The last numbered run and the index of the row the cursor is on (-1: none). */
function parseMenu(screen: string): { options: string[]; cursor: number } {
  let run: string[] = []
  let runCursor = -1
  let best: string[] = []
  let cursor = -1
  for (const line of screen.split('\n')) {
    const m = MENU_LINE.exec(line)
    if (!m) continue
    const n = Number(m[1])
    if (n === 1) {
      run = [m[2]]
      runCursor = -1
    } else if (n === run.length + 1) {
      run.push(m[2])
    } else {
      continue
    }
    if (CURSOR_LINE.test(line)) runCursor = run.length - 1
    best = run
    cursor = runCursor
  }
  return { options: [...best], cursor }
}

const isFreeText = (option: string) => FREE_TEXT.test(option.replace(CHECKBOX, ''))

/** Free text as it is typed into a pane: one line, no control characters, capped. */
function typedText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').split(/\s+/).filter(Boolean).join(' ').slice(0, MAX_ANSWER_TEXT)
}

/** Arrow presses that move the cursor from row `from` to row `to`. */
function moves(from: number, to: number): string[] {
  return Array<string>(Math.abs(to - from)).fill(to > from ? DOWN : UP)
}

/** Between the steps of an answer: the pane still waits on the menu the steps
 *  were worked out for. Only box marks and the "Other" row's text may change;
 *  anything else (answered at the keyboard, the next prompt, the idle input
 *  box) stops the rest, so typed text and Enter never land outside the box. */
export function stillOnMenu(before: string[], displayStatus: string | undefined, screen: string): boolean {
  if (displayStatus !== 'awaiting') return false
  const now = parseMenuOptions(screen)
  const label = (o: string) => squash(o.replace(CHECKBOX, ''))
  return now.length === before.length && before.every((o, i) => isFreeText(o) || label(o) === label(now[i]))
}

function steps(keys: string[]): AnswerKeys {
  return { ok: true, keys: keys.join(''), steps: keys }
}

/** claude's "Other" row: move to it, type the text, Enter. */
function freeTextKeys(screen: string, option: number, text: string): AnswerKeys {
  const { options, cursor } = parseMenu(screen)
  if (!Number.isInteger(option) || option < 1 || option > options.length) {
    return { ok: false, error: `option ${option} is not on the menu (1–${options.length})` }
  }
  if (!isFreeText(options[option - 1])) return { ok: false, error: `option ${option} takes no text` }
  const typed = typedText(text)
  if (!typed) return { ok: false, error: 'the text is empty' }
  if (cursor < 0) return { ok: false, error: 'no option on screen has the cursor' }
  return steps([...moves(cursor, option - 1), typed, '\r'])
}

/** claude's multi-select menu: toggle the boxes that differ, type the "Other"
 *  text if any, then Down past the last row to Submit / Next and Enter. */
function multiSelectKeys(screen: string, picked: number[], text: string | undefined): AnswerKeys {
  const { options, cursor } = parseMenu(screen)
  const boxes = options.flatMap((o, i) => (CHECKBOX.test(o) ? [i] : []))
  if (!boxes.length) return { ok: false, error: 'no multi-select menu on screen' }
  const want = new Set(picked)
  if (!want.size) return { ok: false, error: 'no option picked' }
  for (const n of want) {
    if (!Number.isInteger(n) || n < 1 || n > 9 || !boxes.includes(n - 1)) {
      return { ok: false, error: `option ${n} is not a box on the menu` }
    }
    if (isPermanentAllow(options[n - 1])) return { ok: false, error: `option ${n} allows permanently` }
  }
  const free = boxes.find((i) => isFreeText(options[i]))
  const typed = text === undefined ? '' : typedText(text)
  if (text !== undefined && !typed) return { ok: false, error: 'the text is empty' }
  if (typed ? free === undefined || !want.has(free + 1) : free !== undefined && want.has(free + 1)) {
    return { ok: false, error: 'free text goes with the "Other" row, and only there' }
  }
  if (cursor < 0) return { ok: false, error: 'no option on screen has the cursor' }
  const keys: string[] = []
  let at = cursor
  if (at === free) {
    keys.push(UP)
    at -= 1
  }
  for (const i of boxes) {
    // Typing into the "Other" row picks it, so only a stale pick of it is toggled off.
    if (i === free && typed) continue
    if (want.has(i + 1) !== CHECKED.test(options[i])) keys.push(String(i + 1))
  }
  if (typed && free !== undefined) {
    keys.push(...moves(at, free), typed)
    at = free
  }
  keys.push(...moves(at, boxes[boxes.length - 1]), DOWN, '\r')
  return steps(keys)
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
  if (HOTKEY_VENDORS.has(agentKey)) {
    if (answer.kind !== 'permission') return { ok: false, error: `unsupported for ${agentKey}` }
    if (answer.choice === 'allow' && PERMANENT_ALLOW_VENDORS.has(agentKey)) {
      return { ok: false, error: 'trusting a folder allows permanently' }
    }
    return { ok: true, keys: answer.choice === 'allow' ? 'y' : 'n' }
  }
  if (!MENU_VENDORS.has(agentKey)) return { ok: false, error: `unsupported for ${agentKey}` }
  if (answer.kind === 'multi' || (answer.kind === 'question' && answer.text !== undefined)) {
    if (!TEXT_MENU_VENDORS.has(agentKey)) return { ok: false, error: `unsupported for ${agentKey}` }
    return answer.kind === 'multi'
      ? multiSelectKeys(input.screen, answer.options, answer.text)
      : freeTextKeys(input.screen, answer.option, answer.text ?? '')
  }

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
