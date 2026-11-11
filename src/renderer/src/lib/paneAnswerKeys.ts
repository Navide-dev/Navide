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
const MENU_LINE = /^\s*(?:[❯›>]\s*)?(\d)\.\s+(.+?)\s*$/
const CURSOR_LINE = /^\s*[❯›>]/
const MENU_HEADING_LINES = 3
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
function parseMenu(screen: string): { options: string[]; cursor: number; heading: string } {
  const lines = screen.split('\n')
  let run: string[] = []
  let runCursor = -1
  let runStart = 0
  let best: string[] = []
  let cursor = -1
  let start = 0
  for (const [at, line] of lines.entries()) {
    const m = MENU_LINE.exec(line)
    if (!m) continue
    const n = Number(m[1])
    if (n === 1) {
      run = [m[2]]
      runCursor = -1
      runStart = at
    } else if (n === run.length + 1) {
      run.push(m[2])
    } else {
      continue
    }
    if (CURSOR_LINE.test(line)) runCursor = run.length - 1
    best = run
    cursor = runCursor
    start = runStart
  }
  // The question above the menu: its nearest non-empty lines, without the
  // marks the tab header flips as the box's questions are answered.
  const heading = lines
    .slice(0, best.length ? start : 0)
    .filter((l) => l.trim())
    .slice(-MENU_HEADING_LINES)
    .map((l) => squash(l.replace(/[☐☑☒✓✔]/g, '')))
    .join('\n')
  return { options: [...best], cursor, heading }
}

const isFreeText = (option: string) => FREE_TEXT.test(option.replace(CHECKBOX, ''))

// Bidi controls and zero-width characters. Keep in sync with _INVISIBLE_RE in
// backend/agent_team_backend/channels/relay.py.
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

/** Free text as it is typed into a pane: one line (U+2028 / U+2029 too), no
 *  control or invisible characters. Never shortened: the pane gets all of it. */
function typedText(text: string): string {
  return text
    .replace(INVISIBLE, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

/** Arrow presses that move the cursor from row `from` to row `to`. */
function moves(from: number, to: number): string[] {
  return Array<string>(Math.abs(to - from)).fill(to > from ? DOWN : UP)
}

/** Between the steps of an answer: the pane still waits on the question and
 *  menu the steps were worked out for (`before`, the screen they were read
 *  from). Only box marks, the cursor and the "Other" row's text may change;
 *  anything else (answered at the keyboard, the box's next question even with
 *  the same options, the idle input box) stops the rest, so typed text and
 *  Enter never land outside the box. */
export function stillOnMenu(before: string, displayStatus: string | undefined, screen: string): boolean {
  if (displayStatus !== 'awaiting') return false
  const was = parseMenu(before)
  const now = parseMenu(screen)
  const label = (o: string) => squash(o.replace(CHECKBOX, ''))
  return (
    now.heading === was.heading &&
    now.options.length === was.options.length &&
    was.options.every((o, i) => isFreeText(o) || label(o) === label(now.options[i]))
  )
}

/** Writes an answer's steps in order, `gapMs` apart. Every step after the first
 *  (each typed text and each Enter included) goes in only while `stillOnMenu`
 *  holds for the screen `read` returns then; otherwise it stops with
 *  'prompt-changed' and nothing more is written. */
export async function writeAnswerSteps<R extends { ok: boolean }>(opts: {
  steps: string[]
  /** The screen the steps were worked out from. */
  menu: string
  read: () => { displayStatus: string | undefined; screen: string }
  write: (data: string) => Promise<R>
  gapMs: number
  /** The check between steps; `stillOnMenu` unless given. */
  stillOn?: (before: string, displayStatus: string | undefined, screen: string) => boolean
}): Promise<R | 'prompt-changed'> {
  const stillOn = opts.stillOn ?? stillOnMenu
  const [first, ...rest] = opts.steps
  let resp = await opts.write(first)
  for (const data of rest) {
    if (!resp.ok) break
    await new Promise((resolve) => setTimeout(resolve, opts.gapMs))
    const { displayStatus, screen } = opts.read()
    if (!stillOn(opts.menu, displayStatus, screen)) return 'prompt-changed'
    resp = await opts.write(data)
  }
  return resp
}

// claude's /model picker (Claude Code 2.1.322). Its footer reads "Enter to
// set as default · s to use this session only · Esc to cancel": Enter (and a
// digit, which acts as Enter) saves the pick as the default for new sessions,
// while `s` switches only the running session. Only `s` is ever pressed.
const MODEL_PICKER_TITLE = /\bSelect model\b/
const MODEL_PICKER_SESSION_ONLY = /\bs to use this session only\b/

/** A picker row's name column: the text before its first double space (the
 *  Default row's description names a model too), without the current tick. */
function pickerName(option: string): string {
  return squash(option.split(/\s{2,}/)[0].replace(/[✔✓]/g, '')).toLowerCase()
}

/** True while claude's /model picker is on screen. */
export function onModelPicker(screen: string): boolean {
  return MODEL_PICKER_TITLE.test(screen) && parseMenu(screen).options.length > 0
}

/** Between the picker's keys: still the same picker, with the same rows.
 *  Reads the screen alone, since the picker is not an awaiting prompt. */
export function stillOnModelPicker(before: string, _displayStatus: string | undefined, screen: string): boolean {
  if (!MODEL_PICKER_TITLE.test(screen)) return false
  const was = parseMenu(before).options.map(pickerName)
  const now = parseMenu(screen).options.map(pickerName)
  return now.length === was.length && was.every((n, i) => n === now[i])
}

/** The keys that move the picker's cursor to the row named `label` and press
 *  `s`. A bare family ("Opus") takes the one row of that family on the list.
 *  Null when the picker, its `s` key, its cursor or the row (one under "More
 *  models" included) is not on screen. Never a digit and never Enter. */
export function modelPickerKeys(screen: string, label: string): string[] | null {
  if (!MODEL_PICKER_TITLE.test(screen) || !MODEL_PICKER_SESSION_ONLY.test(screen)) return null
  const { options, cursor } = parseMenu(screen)
  if (cursor < 0) return null
  const names = options.map(pickerName)
  const hits = names.flatMap((n, i) => (namesModel(n, label) ? [i] : []))
  if (hits.length !== 1) return null
  return [...moves(cursor, hits[0]), 's']
}

/** A lowercased model name ("sonnet 5.5") is `label`, or the one version of
 *  a bare family label ("Sonnet"). */
function namesModel(name: string, label: string): boolean {
  const want = squash(label).toLowerCase()
  return name === want || (!/\d/.test(want) && name.startsWith(`${want} `) && /^\d+(?:\.\d+)*$/.test(name.slice(want.length + 1)))
}

// After `s`, a pane that already has a conversation asks once more (Claude
// Code 2.1.286 and 2.1.322): "Switch model? … This conversation is cached for
// the current model …" with "1. Yes, switch to <name>" and "2. No, go back".
// Enter on Yes confirms the session-only switch `s` asked for (checked live
// on 2.1.322: settings.json unchanged, "for this session only"). Esc is "No,
// go back", which reopens the picker.
const MODEL_CONFIRM_TITLE = /\bSwitch model\?/
const MODEL_CONFIRM_YES = /^Yes, switch to (.+)$/

/** True while claude's "Switch model?" confirmation is on screen. */
export function onModelSwitchConfirm(screen: string): boolean {
  return MODEL_CONFIRM_TITLE.test(screen) && parseMenu(screen).options.some((o) => MODEL_CONFIRM_YES.test(squash(o)))
}

/** Between the confirmation's keys: still the same box, with the same rows. */
export function stillOnModelSwitchConfirm(before: string, _displayStatus: string | undefined, screen: string): boolean {
  if (!MODEL_CONFIRM_TITLE.test(screen)) return false
  const was = parseMenu(before).options.map(squash)
  const now = parseMenu(screen).options.map(squash)
  return now.length === was.length && was.every((o, i) => o === now[i])
}

/** The keys that move the confirmation's cursor to "Yes, switch to <name>"
 *  and press Enter, only when <name> is the model `label` names. Null when
 *  the box, its cursor or a matching Yes row is not on screen. */
export function modelConfirmKeys(screen: string, label: string): string[] | null {
  if (!MODEL_CONFIRM_TITLE.test(screen)) return null
  const { options, cursor } = parseMenu(screen)
  if (cursor < 0) return null
  const hits = options.flatMap((o, i) => {
    const m = MODEL_CONFIRM_YES.exec(squash(o))
    return m && namesModel(m[1].toLowerCase(), label) ? [i] : []
  })
  if (hits.length !== 1) return null
  return [...moves(cursor, hits[0]), '\r']
}

// How far up from the bottom the picker's result line may be: just above the
// composer and status lines, never an older switch further up the screen.
const MODEL_SWITCH_RESULT_LINES = 10

/** What the screen says after the picker's keys: 'session' for claude's "Set
 *  model to …" line, 'default' when that line says it was saved as the
 *  default, null while the picker or its confirmation is still up or no fresh
 *  line is there. Only the text below the last picker or confirmation title
 *  counts: a closed box's title can stay on the screen tail above the result
 *  line, while an open box has no result line below its title. */
export function modelSwitchResult(screen: string): 'session' | 'default' | null {
  const lines = screen.split('\n').filter((l) => l.trim())
  let lastTitle = lines.length - 1
  while (lastTitle >= 0 && !MODEL_PICKER_TITLE.test(lines[lastTitle]) && !MODEL_CONFIRM_TITLE.test(lines[lastTitle])) lastTitle--
  const tail = lines
    .slice(lastTitle + 1)
    .slice(-MODEL_SWITCH_RESULT_LINES)
    .join('\n')
  if (!/\bSet model to\b/.test(tail)) return null
  return /saved as your default/i.test(tail) ? 'default' : 'session'
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

// Claude Code's "will automatically deny this request in 1:19" under an
// unattended prompt: the time left changes every second, the prompt does not.
// Matched across a line break, since a narrow pane wraps it anywhere.
const AUTO_ANSWER_COUNTDOWN = /(\bautomatically\s+\w+\s+this\s+request\s+in\s+)\d+(?::\d+)*s?/gi

/** The last ≤ 12 non-empty screen lines, capped at 800 characters, with the
 *  auto-answer countdown's time left out so the same prompt reads the same. */
export function awaitingPromptText(screen: string): string {
  const lines = screen
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-12)
  const text = lines.join('\n').replace(AUTO_ANSWER_COUNTDOWN, '$1')
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
