import { describe, it, expect } from 'vitest'
import { matchAwaitingInput } from '../cliAwaitingInput'
import { resolveAnswerKeys, type PaneAnswer } from '../paneAnswerKeys'

// Claude Code 2.1.304 can stop a resumed conversation on a dialog before it
// takes any input (plan cli-10-19-0-2-28_411e93, p0-claude-resume-warn). The
// start-up path runs it for `claude --resume <id>` with no prompt, which is how
// Navide's boot restore and account-switch rebuild start a pane. Neither dialog
// fires the Notification hook, and neither uses the permission/question
// footers, so the pane read as idle and a delivered message's Enter chose an
// option for the user.
//
// The screens are transcribed from the strings in the 2.1.304 binary
// (`Resume this conversation?`, `This conversation has been inactive for … and
// is … tokens long.`, `Resuming it will use about N% of your 5-hour usage
// limit.`, `Resume` / `Start a new conversation`; and `This session is … old
// and … tokens.`, `Resume from summary (recommended)` / `Resume full session
// as-is` / `Don't ask me again`). The exact layout has not been captured on a
// live pane: the user verifies it by hand (steps in the PR body).

const COLD_RESUME = [
  ' Resume this conversation?',
  '',
  ' This conversation has been inactive for 3d 4h and is 412.3k tokens long.',
  ' Resuming it will use about 38% of your 5-hour usage limit.',
  '',
  ' ❯ 1. Resume',
  '   2. Start a new conversation',
  '      Claude can look this one up if you refer to it later',
  '',
  ' Enter to confirm · Esc to resume',
].join('\n')

const COLD_RESUME_ALL = COLD_RESUME.replace(
  'Resuming it will use about 38% of your 5-hour usage limit.',
  'Resuming it will use all of your 5-hour usage limit.'
)

const STALE_RESUME = [
  ' This session is 2h 14m old and 152.4k tokens.',
  '',
  ' Resuming the full session will consume a substantial portion of your usage',
  ' limits. We recommend resuming from a summary.',
  '',
  ' ❯ 1. Resume from summary (recommended)',
  '   2. Resume full session as-is',
  "   3. Don't ask me again",
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

const RULE = '────────────────────────────────────────'
const STATUS_LINE = '  ~/git/navide · main · Opus 4.7 · 42% context'

describe('claude resume dialogs (2.1.304) read as awaiting', () => {
  it.each([
    ['the cold-cache quota dialog', COLD_RESUME],
    ['the cold-cache quota dialog at 100%', COLD_RESUME_ALL],
    ['the stale-session dialog', STALE_RESUME],
  ])('matches %s', (_name, screen) => {
    expect(matchAwaitingInput('claude', screen)).toBe(true)
    // A statusLine and blank rows under the dialog do not hide it.
    expect(matchAwaitingInput('claude', `${screen}\n\n${STATUS_LINE}`)).toBe(true)
  })

  it('matches the dialog drawn in a box', () => {
    const boxed = ['╭' + '─'.repeat(78) + '╮', ...STALE_RESUME.split('\n').map((l) => `│${l}`), '╰' + '─'.repeat(78) + '╯'].join('\n')
    expect(matchAwaitingInput('claude', boxed)).toBe(true)
  })

  it.each([
    ['the cold-cache quota dialog', COLD_RESUME],
    ['the stale-session dialog', STALE_RESUME],
  ])('does not match %s quoted above the idle input box', (_name, screen) => {
    const quoted = [screen, '', RULE, '❯ ', RULE, STATUS_LINE].join('\n')
    expect(matchAwaitingInput('claude', quoted)).toBe(false)
  })

  it('does not match a draft that names the options', () => {
    const draft = ['', RULE, '❯ pick Resume full session as-is, not Don\'t ask me again', RULE, STATUS_LINE].join('\n')
    expect(matchAwaitingInput('claude', draft)).toBe(false)
  })

  it('does not match prose about resuming', () => {
    expect(matchAwaitingInput('claude', 'Resume this conversation? Sure, I can do that.')).toBe(false)
    expect(matchAwaitingInput('claude', 'Start a new conversation if the context is too long.')).toBe(false)
  })
})

describe('claude resume dialogs: what a remote answer may press', () => {
  const resolve = (answer: PaneAnswer, screen: string) =>
    resolveAnswerKeys({ agentKey: 'claude', displayStatus: 'awaiting', awaitingKind: answer.kind, screen, answer })

  it('refuses allow/deny: there is no Yes or No to press', () => {
    for (const screen of [COLD_RESUME, STALE_RESUME]) {
      expect(resolve({ kind: 'permission', choice: 'allow' }, screen).ok).toBe(false)
      expect(resolve({ kind: 'permission', choice: 'deny' }, screen).ok).toBe(false)
    }
  })

  it('refuses "Don\'t ask me again", a permanent choice', () => {
    expect(resolve({ kind: 'question', option: 3 }, STALE_RESUME)).toMatchObject({ ok: false })
  })
})
