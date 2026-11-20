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
 * | `claude.add-dir.navide-skills-view` | Claude Code's "Adding a new directory: <dir> … This session hasn't worked here before" (No, exit / Yes, add it) | `<dir>` is one of the directories Navide itself handed this pane with `--add-dir` (the spawn reports them as `navide_dirs`) AND it is Navide's managed-skills view (`…/runtime/skills-views/claude`) | Navide built that folder out of the skills the user enabled for Claude and added it to the pane itself; "Yes, add it" holds for this session only and writes nothing. It is the folder the convenience feature claude.skills-trust pre-trusts; this covers a spawn where that record could not be written (lock held, feature off). |
 *
 * Everything else is left to a person or to the caller's cli_answer_prompt:
 * any other folder (the pane's workspace included — a folder Claude asks to
 * add is not the one the user opened), a prompt this module does not know,
 * and any prompt whose text speaks of signing in, accounts, keys, billing,
 * deleting or permissions, whatever rule it might otherwise match.
 *
 * The workspace's own trust dialog at launch is not decided here: the marker
 * bootstrap and dismissStartupDialog accept it as before, and Grok's folder
 * trust stays with startupTrust.ts.
 */

export const ADD_DIR_OPTIONS = ['No, exit', 'Yes, add it'] as const

export interface StartupPrompt {
  /** Which known prompt this is. */
  kind: 'claude.add-dir'
  /** The folder it asks about, as drawn (a wrapped path rejoined). */
  folder: string
  /** The prompt's text, whitespace-collapsed, folder included. */
  prompt: string
  options: string[]
  /** The option the cursor is on, or '' when none is marked. */
  cursorOn: string
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

// Claude Code 2.1.329's dialog (verified against the installed binary and a
// live render). The body between the question and the menu differs with the
// window height, so it is skipped; the folder is everything between the title
// and the first sentence, which a wrapped path splits with a line break.
const CLAUDE_ADD_DIR = new RegExp(
  'Adding a new directory: (.+?) This session hasn\'t worked here before\\. '
    + 'Is this a directory you created or one you trust\\?(.{0,900}?)'
    + ' ?(❯ ?)?No, exit ?(❯ ?)?Yes, add it ?Enter to confirm · Esc to cancel(.{0,200})$',
)

// Whatever an allowlist rule says, these are a person's call.
const SENSITIVE = /\b(?:sign(?:ed)?[ -]?in|log[ -]?in|logout|api[ -]?key|token|account|billing|payment|purchase|subscri\w*|upgrade|credits?|delete|remove|uninstall|overwrite|bypass|dangerously|permissions?)\b/i

/** The known startup prompt live on this pane's screen, or null. */
export function readStartupPrompt(agentKey: string, screen: string): StartupPrompt | null {
  if (agentKey !== 'claude') return null
  const m = CLAUDE_ADD_DIR.exec(collapse(screen))
  if (!m) return null
  // The tail after the footer is the CLI's own status line at most; a long
  // tail is a later screen, so this dialog is scrollback.
  const cursorOn = m[3] ? ADD_DIR_OPTIONS[0] : m[4] ? ADD_DIR_OPTIONS[1] : ''
  const prompt = collapse(m[0].slice(0, m[0].length - m[5].length))
  return { kind: 'claude.add-dir', folder: m[1], prompt, options: [...ADD_DIR_OPTIONS], cursorOn }
}

/** Whether Navide answers `prompt` by itself (see the allowlist above).
 *  `navideDirs` are the directories the spawn handed this pane itself. */
export function decideStartupPrompt(prompt: StartupPrompt, ctx: { navideDirs: readonly string[] }): StartupPromptDecision {
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
    now !== null && noSpace(now.folder) === noSpace(prompt.folder)
  await deps.sleep(deps.settleMs)
  let now = readStartupPrompt(agentKey, deps.readScreen())
  if (!same(now)) return false
  for (let moves = 0; now.cursorOn !== choose; moves++) {
    if (moves >= now.options.length) return false
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
      const decision = decideStartupPrompt(prompt, { navideDirs: deps.navideDirs() })
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
