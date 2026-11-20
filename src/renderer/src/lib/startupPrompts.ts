/**
 * startupPrompts.ts
 *
 * What a new pane's CLI is stopped on before its first turn, and whether
 * Navide may answer it on its own. A kickoff that types the task into such a
 * prompt either answers it with the task's Enter or is swallowed by it, so
 * kickoffRequestedPane asks here first.
 *
 * Read off the RENDERED, whitespace-collapsed screen and anchored on the
 * dialog's live footer, so a transcript that merely quotes a prompt is never
 * taken for one.
 *
 * ALLOWLIST — the only prompts Navide answers by itself. Each names the exact
 * prompt, the condition on what it asks about, and why answering is the user's
 * own choice already:
 *
 * | rule | prompt | answered only when | why |
 * |---|---|---|---|
 * | `workspace-trust.own-workspace` | A CLI's workspace trust dialog at launch (Claude Code "Accessing workspace: <dir> … Yes, I trust this folder", Codex "Trust this folder?", "Do you trust the contents of this directory?"), answered on its trust option: Claude Code's is selected by reading where the cursor is and moving it there first (2.1.329 draws "No, exit" first with the cursor on it), never answered when the cursor cannot be read; any other vendor's with Enter on its default (trust) option | the dialog names `<dir>` and it is exactly the pane's own workspace (`workspace`), the folder the user opened; not a parent, not a folder inside it | The user opened that workspace in Navide and asked for a pane in it; any other folder, or a dialog that names none, is theirs to judge. Vendors with a trust watcher of their own (`startupTrust`, Grok) are left to it. |
 * | `claude.add-dir.navide-skills-view` | Claude Code's "Adding a new directory: <dir> … This session hasn't worked here before" (No, exit / Yes, add it) | `<dir>` is one of the directories Navide itself handed this pane with `--add-dir` (the spawn reports them as `navide_dirs`) AND it is Navide's managed-skills view (`…/runtime/skills-views/claude`) | Navide built that folder out of the skills the user enabled for Claude and added it to the pane itself; "Yes, add it" holds for this session only and writes nothing. It is the folder the convenience feature claude.skills-trust pre-trusts; this covers a spawn where that record could not be written (lock held, feature off). |
 *
 * Apart from these, Enter goes only to an informational launch screen that
 * grants nothing (CONTINUE_NOTICES below, each matched whole for its vendor).
 *
 * Everything else is left to a person or to the caller's cli_answer_prompt:
 * any other folder (for an add-dir prompt the pane's workspace included — a
 * folder Claude asks to add is not the one the user opened), a prompt this
 * module does not know,
 * and any prompt whose text speaks of signing in, accounts, keys, billing,
 * deleting or permissions, whatever rule it might otherwise match.
 *
 * App.vue's dismissStartupDialog answers a workspace trust dialog through
 * decideStartupPrompt and answerStartupPrompt too, so the dialog has one
 * answerer, and Grok's folder trust stays with startupTrust.ts.
 */

import { AGENT_SPECS } from '@navide/plugin-shell'

export const ADD_DIR_OPTIONS = ['No, exit', 'Yes, add it'] as const
export const CLAUDE_TRUST_YES = 'Yes, I trust this folder'

export interface StartupPrompt {
  /** Which known prompt this is. */
  kind: 'claude.add-dir' | 'workspace-trust'
  /** The folder it asks about, as drawn (a wrapped path rejoined). '' for a
   *  workspace trust dialog: which folder it names is decided against the
   *  workspace (namesFolder), not read off the screen. */
  folder: string
  /** The prompt's text, whitespace-collapsed, folder included. */
  prompt: string
  options: string[]
  /** The option the cursor is on, or '' when none is marked. */
  cursorOn: string
  /** A trust dialog whose menu order is not fixed (Claude Code): it is
   *  answered only by reading the cursor and moving it, never by Enter alone. */
  readCursor?: boolean
}

export type StartupPromptDecision =
  | {
      action: 'auto'
      rule: string
      /** Why this answer is safe, for the diagnostics record. */
      why: string
      /** The option the answer selects. */
      choose: string
    }
  | { action: 'block'; why: string }

const DOWN = '\x1b[B'
const BOX = /[─-╿]/g
const collapse = (screen: string): string => screen.replace(BOX, ' ').replace(/\s+/g, ' ').trim()
const noSpace = (path: string): string => path.replace(/\s+/g, '').replace(/\\/g, '/').replace(/(.)\/+$/, '$1')

// A narrow pane wraps the dialog's own text, mid-word too ("Yes, I trust this
// f" / "older"), and collapse() turns each break into a space, so a fixed
// phrase is matched with an optional space between any two of its characters.
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const loose = (phrase: string): string => [...phrase.replace(/ /g, '')].map(escapeRe).join(' ?')
const squash = (text: string): string => text.replace(/\s+/g, '')
const FOOTER = loose('Enter to confirm · Esc to cancel')

// Claude Code 2.1.329's dialog (verified against the installed binary and a
// live render). The body between the question and the menu differs with the
// window height, so it is skipped; the folder is everything between the title
// and the first sentence, which a wrapped path splits with a line break.
const CLAUDE_ADD_DIR = new RegExp(
  `${loose('Adding a new directory:')} (.+?) ${loose("This session hasn't worked here before.")} ?`
    + `${loose('Is this a directory you created or one you trust?')}(.{0,1200}?)`
    + ` ?(❯ ?)?${loose(ADD_DIR_OPTIONS[0])} ?(❯ ?)?${loose(ADD_DIR_OPTIONS[1])} ?${FOOTER}(.{0,200})$`,
)

// A CLI asking at launch whether to trust the folder it runs in. The menu and
// wording differ by vendor and version; the question does not.
const WORKSPACE_TRUST = ['Do you trust the contents', 'Trust the contents of this', 'Trust this folder']
  .map((phrase) => new RegExp(loose(phrase), 'i'))

// Where Claude Code's trust dialog starts: the folder it names is read from
// here on, so a path in the scrollback above it is never taken for it.
const CLAUDE_TRUST_TITLE = new RegExp(loose('Accessing workspace:'), 'g')

// Claude Code's trust menu, in either order: 2.1.329 draws "No, exit" first
// with the cursor on it and no numbers (cancelFirst, focus "cancel"); older
// builds drew "1. Yes, I trust this folder" first with the cursor on it.
const CLAUDE_TRUST_OPTIONS = [CLAUDE_TRUST_YES, 'No, exit']
const CLAUDE_TRUST_OPTION = `(${CLAUDE_TRUST_OPTIONS.map(loose).join('|')})`
const CLAUDE_TRUST_MENU = new RegExp(
  `(❯ ?)?(?:\\d ?\\. ?)?${CLAUDE_TRUST_OPTION} ?(❯ ?)?(?:\\d ?\\. ?)?${CLAUDE_TRUST_OPTION} ?`
    + `${FOOTER}(.{0,200})$`,
)
/** A menu option as read (a wrapped one has spaces in it), by its own name. */
const trustOption = (read: string): string => CLAUDE_TRUST_OPTIONS.find((o) => squash(o) === squash(read)) ?? read

const HOME = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=$|[\\/])/

/** Whether `screen` names `folder` as a whole path: not a parent of it, not a
 *  folder inside it, not a longer name that starts with it. A path the CLI
 *  wrapped (a line break inside it) still counts, and so does a home folder
 *  drawn as `~`. */
export function namesFolder(screen: string, folder: string): boolean {
  const target = folder.trim().replace(/(.)[\\/]+$/, '$1')
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(target)) return false
  const text = screen.replace(BOX, ' ').replace(/\s+/g, ' ')
  const pattern = (path: string): string => [...path]
    .map((ch) => (ch === '/' || ch === '\\' ? '[\\\\/]' : escapeRe(ch)))
    .join(' ?')
  const spellings = [pattern(target)]
  const home = HOME.exec(target)
  if (home) spellings.push('~' + (target.length > home[0].length ? ' ?' + pattern(target.slice(home[0].length)) : ''))
  // Before: the start, a space, or punctuation that opens a path. After: the
  // end, a space or punctuation, but never a separator (a folder inside it,
  // wrapped or not) or another path character.
  const whole = new RegExp(`(?:^|[\\s:'"(\\[])(?:${spellings.join('|')})[\\\\/]?(?=$|[\\s'")\\],;:?!])(?! ?[\\\\/])`)
  return whole.test(text)
}

// Whatever an allowlist rule says, these are a person's call.
const SENSITIVE = /\b(?:sign(?:ed)?[ -]?in|log[ -]?in|logout|api[ -]?key|token|account|billing|payment|purchase|subscri\w*|upgrade|credits?|delete|remove|uninstall|overwrite|bypass|dangerously|permissions?)\b/i

/** The known startup prompt live on this pane's screen, or null. */
export function readStartupPrompt(agentKey: string, screen: string): StartupPrompt | null {
  const text = collapse(screen)
  const m = agentKey === 'claude' ? CLAUDE_ADD_DIR.exec(text) : null
  if (!m) {
    if (!WORKSPACE_TRUST.some((re) => re.test(text))) return null
    if (AGENT_SPECS.find((spec) => spec.agentKey === agentKey)?.startupTrust) return null
    if (agentKey !== 'claude') return { kind: 'workspace-trust', folder: '', prompt: text, options: [], cursorOn: '' }
    // Which option the cursor is on, read off the menu; '' when it cannot be.
    const menu = CLAUDE_TRUST_MENU.exec(text)
    const read = menu ? [trustOption(menu[2]), trustOption(menu[4])] : []
    const options = read.length && read[0] !== read[1] ? read : []
    const cursorOn = options.length ? (menu![1] ? options[0] : menu![3] ? options[1] : '') : ''
    // The dialog from its last title on; without the title on screen it names
    // no folder, and is left to a person.
    const title = [...text.matchAll(CLAUDE_TRUST_TITLE)].pop()
    const prompt = title ? text.slice(title.index) : ''
    return { kind: 'workspace-trust', folder: '', prompt, options, cursorOn, readCursor: true }
  }
  // The tail after the footer is the CLI's own status line at most; a long
  // tail is a later screen, so this dialog is scrollback.
  const cursorOn = m[3] ? ADD_DIR_OPTIONS[0] : m[4] ? ADD_DIR_OPTIONS[1] : ''
  const prompt = collapse(m[0].slice(0, m[0].length - m[5].length))
  return { kind: 'claude.add-dir', folder: m[1], prompt, options: [...ADD_DIR_OPTIONS], cursorOn }
}

// Launch screens that only inform: Enter there grants, signs in or selects
// nothing, it only goes on. Each is matched whole, for its own vendor, with
// its footer at the bottom of the screen; "continue" anywhere else is not one
// of these (Codex's sign-in screen says "Press enter to continue" too, and
// Enter there starts a sign-in).
const CONTINUE_NOTICES: ReadonlyArray<{ agentKey: string; rule: string; re: RegExp }> = [
  {
    // Codex: "Codex detected a damaged local database, moved it into a backup
    // folder, and will continue startup with a fresh database. … Continuing
    // startup with a fresh local database... Press Enter to continue."
    agentKey: 'codex',
    rule: 'codex.fresh-database-notice',
    re: new RegExp(
      `${loose('Codex detected a damaged local database')}.{0,600}?${loose('Press Enter to continue')} ?\\.?(.{0,200})$`,
      'i',
    ),
  },
]

/** The informational launch screen live on this pane's screen that Enter
 *  only dismisses (CONTINUE_NOTICES), by its rule name; '' when there is
 *  none. Anything else is never answered with a bare Enter. */
export function readContinueNotice(agentKey: string, screen: string): string {
  const text = collapse(screen)
  return CONTINUE_NOTICES.find((notice) => notice.agentKey === agentKey && notice.re.test(text))?.rule ?? ''
}

/** Whether Navide answers `prompt` by itself (see the allowlist above).
 *  `navideDirs` are the directories the spawn handed this pane itself;
 *  `workspace` is the pane's own workspace, the folder the user opened. */
export function decideStartupPrompt(
  prompt: StartupPrompt,
  ctx: { navideDirs: readonly string[]; workspace?: string },
): StartupPromptDecision {
  if (prompt.kind === 'workspace-trust') {
    // Its own boilerplate speaks of permissions, so the SENSITIVE words are
    // not a reason here; the folder is.
    const workspace = ctx.workspace ?? ''
    if (!workspace || !namesFolder(prompt.prompt, workspace)) {
      return {
        action: 'block',
        why: workspace
          ? `the trust dialog does not name this pane's workspace ${workspace}`
          : 'the pane has no workspace to compare the trust dialog with',
      }
    }
    // Enter alone could land on "No, exit": without a cursor on the screen, or
    // a menu without the trust option, nothing is pressed.
    if (prompt.readCursor && (!prompt.cursorOn || !prompt.options.includes(CLAUDE_TRUST_YES))) {
      return { action: 'block', why: 'the cursor on the trust dialog\'s menu could not be read' }
    }
    return {
      action: 'auto',
      rule: 'workspace-trust.own-workspace',
      why: `the trust dialog names ${workspace}, the workspace the user opened this pane in`,
      choose: prompt.readCursor ? CLAUDE_TRUST_YES : '',
    }
  }
  const folder = noSpace(prompt.folder)
  const text = prompt.prompt.split(prompt.folder).join(' ')
  if (SENSITIVE.test(text)) {
    return { action: 'block', why: 'the prompt speaks of accounts, keys, billing, deleting or permissions' }
  }
  if (prompt.kind === 'claude.add-dir') {
    const handed = ctx.navideDirs.some((dir) => noSpace(dir) === folder)
    if (!handed) {
      return { action: 'block', why: `Claude asks to add ${prompt.folder}, which Navide did not hand this pane` }
    }
    if (!/\/runtime\/skills-views\/claude$/.test(folder)) {
      return { action: 'block', why: `${prompt.folder} is not Navide's managed-skills view` }
    }
    return {
      action: 'auto',
      rule: 'claude.add-dir.navide-skills-view',
      why: `${prompt.folder} is Navide's own managed-skills view, added to this pane by Navide; `
        + '"Yes, add it" holds for this session only',
      choose: ADD_DIR_OPTIONS[1],
    }
  }
  return { action: 'block', why: 'Navide has no rule for this prompt' }
}

export interface AnswerStartupPromptDeps {
  readScreen: () => string
  /** False when the keys could not be written. */
  send: (keys: string) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  /** Claude's dialog ignores keys for a moment after it appears and after the
   *  last key, so each key waits this long. */
  settleMs: number
}

/** Select `decision.choose` on `prompt` and confirm it, re-reading the screen
 *  before every key: the cursor has to be on the chosen option, and the same
 *  dialog still up, before Enter goes in. True when the dialog went away. */
export async function answerStartupPrompt(
  agentKey: string,
  prompt: StartupPrompt,
  choose: string,
  deps: AnswerStartupPromptDeps,
): Promise<boolean> {
  const same = (now: StartupPrompt | null): now is StartupPrompt =>
    now !== null && now.kind === prompt.kind && noSpace(now.folder) === noSpace(prompt.folder)
  await deps.sleep(deps.settleMs)
  let now = readStartupPrompt(agentKey, deps.readScreen())
  // Gone before any key: it was answered already, by whoever got there first.
  if (now === null) return true
  if (!same(now)) return false
  // A trust dialog with a fixed default (trust) is answered with Enter alone;
  // one whose cursor has to be read (Claude Code) is moved like any menu.
  if (prompt.kind === 'workspace-trust' && !choose) now = { ...now, cursorOn: choose }
  for (let moves = 0; now.cursorOn !== choose; moves++) {
    if (moves >= now.options.length || !now.cursorOn) return false
    if (!(await deps.send(DOWN))) return false
    await deps.sleep(deps.settleMs)
    now = readStartupPrompt(agentKey, deps.readScreen())
    if (!same(now)) return false
  }
  if (!(await deps.send('\r'))) return false
  for (let waited = 0; waited < 10; waited++) {
    await deps.sleep(deps.settleMs)
    if (readStartupPrompt(agentKey, deps.readScreen()) === null) return true
  }
  return false
}

/** One prompt the watch met, for the diagnostics record (ui_diagnostics). */
export interface StartupPromptRecord {
  answered: boolean
  rule: string
  folder: string
  why: string
}

export interface StartupPromptWatchDeps {
  agentKey: string
  readScreen: () => string
  /** The folders the spawn handed this pane itself (`navide_dirs`). */
  navideDirs: () => readonly string[]
  /** The pane's own workspace, the folder the user opened it in. */
  workspace?: () => string
  /** The pane reads as awaiting (the vendor's own prompt detection). */
  awaiting: () => boolean
  /** The pane is at its prompt: nothing left to watch for. */
  ready: () => boolean
  alive: () => boolean
  send: (keys: string) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  now: () => number
  settleMs: number
  timeoutMs: number
  record: (entry: StartupPromptRecord) => void
}

export type StartupPromptWatch =
  | { outcome: 'clear' }
  | { outcome: 'blocked'; why: string; prompt: StartupPrompt | null }

/** Up to this many allowlisted prompts are answered in one launch; a CLI that
 *  keeps asking is left to a person. */
const MAX_AUTO_ANSWERS = 3

/** Before a new pane's task is typed: answer the allowlisted prompts it
 *  stops on, and report the first one that is not, so the task is held
 *  instead of typed into it. 'clear' when the pane reached its prompt, died,
 *  or nothing showed up in time — the kickoff then goes on as before. */
export async function settleStartupPrompts(deps: StartupPromptWatchDeps): Promise<StartupPromptWatch> {
  const deadline = deps.now() + deps.timeoutMs
  let answered = 0
  while (deps.now() < deadline && deps.alive()) {
    const prompt = readStartupPrompt(deps.agentKey, deps.readScreen())
    if (prompt) {
      const decision = decideStartupPrompt(prompt, { navideDirs: deps.navideDirs(), workspace: deps.workspace?.() ?? '' })
      if (decision.action === 'block') {
        deps.record({ answered: false, rule: '', folder: prompt.folder, why: decision.why })
        return { outcome: 'blocked', why: decision.why, prompt }
      }
      if (answered >= MAX_AUTO_ANSWERS) {
        const why = `the CLI asked again after ${answered} answers`
        deps.record({ answered: false, rule: decision.rule, folder: prompt.folder, why })
        return { outcome: 'blocked', why, prompt }
      }
      const done = await answerStartupPrompt(deps.agentKey, prompt, decision.choose, deps)
      answered++
      deps.record({ answered: done, rule: decision.rule, folder: prompt.folder, why: decision.why })
      if (!done) {
        return { outcome: 'blocked', why: `"${decision.choose}" did not take on the dialog`, prompt }
      }
      continue
    }
    if (deps.awaiting()) {
      const why = 'the pane is waiting on a prompt Navide has no rule for'
      deps.record({ answered: false, rule: '', folder: '', why })
      return { outcome: 'blocked', why, prompt: null }
    }
    if (deps.ready()) return { outcome: 'clear' }
    await deps.sleep(250)
  }
  return { outcome: 'clear' }
}

/** After a blocked launch: wait for whoever answers the prompt (the user, or
 *  a caller's cli_answer_prompt). True once neither a known prompt nor an
 *  awaiting state is left; false when the pane died or `timeoutMs` passed. */
export async function waitStartupPromptGone(
  deps: Pick<StartupPromptWatchDeps, 'agentKey' | 'readScreen' | 'awaiting' | 'alive' | 'sleep' | 'now'>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs
  while (deps.now() < deadline) {
    if (!deps.alive()) return false
    if (!readStartupPrompt(deps.agentKey, deps.readScreen()) && !deps.awaiting()) return true
    await deps.sleep(500)
  }
  return false
}
