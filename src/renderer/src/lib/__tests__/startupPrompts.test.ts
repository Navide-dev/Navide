import { describe, expect, it } from 'vitest'

import { matchAwaitingInput } from '../cliAwaitingInput'
import { parseMenuOptions, resolveAnswerKeys } from '../paneAnswerKeys'
import { createKickoffReporter } from '../spawnKickoff'
import {
  answerStartupPrompt, decideStartupPrompt, readStartupPrompt, settleStartupPrompts, waitStartupPromptGone,
  type StartupPromptRecord,
} from '../startupPrompts'

// Claude Code 2.1.329's "Adding a new directory" dialog exactly as it rendered
// in a 100-column pane, from a live PTY capture (isolated CLAUDE_CONFIG_DIR, an
// --add-dir folder with no trust record). Only the folder is replaced, by one
// just as long, wrapped at the same column the CLI wrapped the real one.
const WRAPPED_VIEW = '/Users/alex-with-a-rather-long-account-name/Library/Application Support/agent-team/runtime/skills-views/claude'
const REAL_SCREEN = [
  '────────────────────────────────────────────────────────────────────────────────────────────────────',
  ' Adding a new directory:',
  '',
  ' /Users/alex-with-a-rather-long-account-name/Library/Application Support/agent-team/runtime/skills-v',
  ' iews/claude',
  '',
  " This session hasn't worked here before. Is this a directory you created or one you trust?",
  '',
  " Claude Code'll be able to read, edit, and execute files here. Its skills, commands, and agents",
  ' load and can run commands, and so can the git settings of its repository. Your answer holds for',
  ' this session. Starting Claude Code in this directory and trusting it there lasts, and covers its',
  ' whole repository or everything below it.',
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, add it',
  '',
  ' Enter to confirm · Esc to cancel',
  '',
].join('\n')

// The same dialog about a folder short enough not to wrap.
const VIEW = '/Users/alex/Library/Application Support/agent-team/runtime/skills-views/claude'
const screenFor = (folder: string): string =>
  REAL_SCREEN.replace(/ \/Users\/alex-with\S*\n iews\/claude| \/Users\/alex-with[^\n]*\n[^\n]*claude/, ` ${folder}`)

describe('readStartupPrompt', () => {
  it('reads the live dialog and rejoins a wrapped folder', () => {
    const prompt = readStartupPrompt('claude', REAL_SCREEN)
    expect(prompt).not.toBeNull()
    expect(prompt!.folder.replace(/\s+/g, '')).toBe(WRAPPED_VIEW.replace(/\s+/g, ''))
    expect(prompt!.options).toEqual(['No, exit', 'Yes, add it'])
    expect(prompt!.cursorOn).toBe('No, exit')
  })

  it('is not the dialog once later output follows it (scrollback, a quoted transcript)', () => {
    expect(readStartupPrompt('claude', `${REAL_SCREEN}\n${'> later turn output '.repeat(20)}`)).toBeNull()
  })

  it('is only read for Claude', () => {
    expect(readStartupPrompt('codex', REAL_SCREEN)).toBeNull()
  })

  it('makes the pane read as awaiting and offers its two options to cli_answer_prompt', () => {
    expect(matchAwaitingInput('claude', REAL_SCREEN)).toBe(true)
    expect(parseMenuOptions(REAL_SCREEN)).toEqual(['No, exit', 'Yes, add it'])
  })
})

describe('decideStartupPrompt (the allowlist)', () => {
  it("answers Claude asking to add Navide's own skills view that the spawn handed it", () => {
    const prompt = readStartupPrompt('claude', screenFor(VIEW))!
    expect(prompt.folder).toBe(VIEW)
    expect(decideStartupPrompt(prompt, { navideDirs: [VIEW] })).toMatchObject({
      action: 'auto', rule: 'claude.add-dir.navide-skills-view', choose: 'Yes, add it',
    })
  })

  it('matches a folder the CLI wrapped with a line break', () => {
    const decision = decideStartupPrompt(readStartupPrompt('claude', REAL_SCREEN)!, { navideDirs: [WRAPPED_VIEW] })
    expect(decision.action).toBe('auto')
  })

  it('leaves a skills view the spawn did not hand this pane to a person', () => {
    const decision = decideStartupPrompt(readStartupPrompt('claude', screenFor(VIEW))!, { navideDirs: [] })
    expect(decision.action).toBe('block')
  })

  it('leaves any other folder to a person, even one the spawn named', () => {
    for (const folder of ['/Users/alex/project', '/Users/alex']) {
      const decision = decideStartupPrompt(readStartupPrompt('claude', screenFor(folder))!, { navideDirs: [VIEW, folder] })
      expect(decision.action).toBe('block')
    }
  })

  it('never answers a prompt that speaks of accounts, keys or deleting', () => {
    const prompt = readStartupPrompt('claude', screenFor(VIEW))!
    const decision = decideStartupPrompt({ ...prompt, prompt: `${prompt.prompt} Sign in to your account` }, { navideDirs: [VIEW] })
    expect(decision.action).toBe('block')
  })
})

const CURSOR_ON_NO = ' ❯ No, exit\n   Yes, add it'
const CURSOR_ON_YES = '   No, exit\n ❯ Yes, add it'

function fakePane(initial: string) {
  const state = { screen: initial, sent: [] as string[], cursorMoves: true }
  return {
    state,
    readScreen: () => state.screen,
    send: async (keys: string) => {
      state.sent.push(keys)
      if (keys === '\x1b[B' && state.cursorMoves) state.screen = state.screen.replace(CURSOR_ON_NO, CURSOR_ON_YES)
      if (keys === '\r' && state.screen.includes(CURSOR_ON_YES)) state.screen = ' ╭───╮\n │ > \n ╰───╯'
      return true
    },
    sleep: async () => undefined,
  }
}

describe('answerStartupPrompt', () => {
  it('moves to "Yes, add it" and confirms only once the cursor is on it', async () => {
    const pane = fakePane(screenFor(VIEW))
    const prompt = readStartupPrompt('claude', pane.state.screen)!
    expect(await answerStartupPrompt('claude', prompt, 'Yes, add it', { ...pane, settleMs: 0 })).toBe(true)
    expect(pane.state.sent).toEqual(['\x1b[B', '\r'])
  })

  it('never presses Enter while the cursor is still on "No, exit"', async () => {
    const pane = fakePane(screenFor(VIEW))
    pane.state.cursorMoves = false
    const prompt = readStartupPrompt('claude', pane.state.screen)!
    expect(await answerStartupPrompt('claude', prompt, 'Yes, add it', { ...pane, settleMs: 0 })).toBe(false)
    expect(pane.state.sent).not.toContain('\r')
  })
})

describe('settleStartupPrompts', () => {
  const deps = (pane: ReturnType<typeof fakePane>, records: StartupPromptRecord[], dirs: string[]) => {
    let t = 0
    return {
      agentKey: 'claude',
      readScreen: pane.readScreen,
      navideDirs: () => dirs,
      awaiting: () => readStartupPrompt('claude', pane.state.screen) !== null,
      ready: () => pane.state.screen.includes('│ > '),
      alive: () => true,
      send: pane.send,
      sleep: async () => { t += 250 },
      now: () => t,
      settleMs: 0,
      timeoutMs: 15_000,
      record: (r: StartupPromptRecord) => { records.push(r) },
    }
  }

  it('answers the allowlisted prompt, records it, and lets the kickoff go on', async () => {
    const pane = fakePane(screenFor(VIEW))
    const records: StartupPromptRecord[] = []
    expect(await settleStartupPrompts(deps(pane, records, [VIEW]))).toEqual({ outcome: 'clear' })
    expect(records).toEqual([
      expect.objectContaining({ answered: true, rule: 'claude.add-dir.navide-skills-view', folder: VIEW }),
    ])
  })

  it('blocks on a prompt off the allowlist without pressing anything', async () => {
    const pane = fakePane(screenFor('/Users/alex/elsewhere'))
    const records: StartupPromptRecord[] = []
    const watch = await settleStartupPrompts(deps(pane, records, [VIEW]))
    expect(watch).toMatchObject({ outcome: 'blocked', prompt: { folder: '/Users/alex/elsewhere' } })
    expect(pane.state.sent).toEqual([])
    expect(records).toEqual([expect.objectContaining({ answered: false })])
  })

  it('blocks on any other prompt the pane is awaiting', async () => {
    const pane = fakePane(' Do you want to proceed?\n ❯ 1. Yes\n   2. No')
    const records: StartupPromptRecord[] = []
    const watch = await settleStartupPrompts({ ...deps(pane, records, [VIEW]), awaiting: () => true })
    expect(watch).toMatchObject({ outcome: 'blocked', prompt: null })
    expect(pane.state.sent).toEqual([])
  })

  it('waits for whoever answers a blocked prompt', async () => {
    const pane = fakePane(screenFor('/Users/alex/elsewhere'))
    let t = 0
    const gone = await waitStartupPromptGone({
      agentKey: 'claude',
      readScreen: pane.readScreen,
      awaiting: () => false,
      alive: () => true,
      sleep: async () => {
        t += 500
        if (t === 1500) pane.state.screen = ' > '
      },
      now: () => t,
    }, 60_000)
    expect(gone).toBe(true)
  })
})

describe('cli_answer_prompt keys for the dialog', () => {
  const status = { displayStatus: 'awaiting', awaitingKind: 'permission' }
  it('allow moves to "Yes, add it" and confirms; deny is Esc ("No, exit")', () => {
    const screen = screenFor(VIEW)
    expect(resolveAnswerKeys({
      agentKey: 'claude', ...status, screen, answer: { kind: 'permission', choice: 'allow' }, navideDirs: [VIEW],
    }))
      .toEqual({ ok: true, keys: '\x1b[B\r', steps: ['\x1b[B', '\r'] })
    expect(resolveAnswerKeys({ agentKey: 'claude', ...status, screen, answer: { kind: 'permission', choice: 'deny' } }))
      .toEqual({ ok: true, keys: '\x1b' })
    expect(resolveAnswerKeys({ agentKey: 'claude', ...status, screen, answer: { kind: 'question', option: 3 } }).ok)
      .toBe(false)
  })
})

describe('createKickoffReporter', () => {
  it('carries the prompt a blocked kickoff is held behind', () => {
    const sent: Record<string, unknown>[] = []
    const report = createKickoffReporter({ requestId: 'r1', paneId: 'p1', send: (p) => { sent.push(p) } })
    report('blocked-by-prompt', 'why', { prompt: 'Adding a new directory', options: ['No, exit', 'Yes, add it'] })
    report('sent')
    expect(sent).toEqual([{
      prompt: 'Adding a new directory',
      options: ['No, exit', 'Yes, add it'],
      request_id: 'r1',
      pane_id: 'p1',
      kickoff: 'blocked-by-prompt',
      reason: 'why',
    }])
  })
})

describe('cli_answer_prompt never trusts a folder Navide did not hand the pane', () => {
  const status = { displayStatus: 'awaiting', awaitingKind: 'permission' }
  it('refuses allow and option 2 for any other folder, and still lets it be refused', () => {
    const screen = screenFor('/Users/alex/elsewhere')
    for (const answer of [{ kind: 'permission', choice: 'allow' }, { kind: 'question', option: 2 }] as const) {
      const keys = resolveAnswerKeys({ agentKey: 'claude', ...status, screen, answer, navideDirs: [VIEW] })
      expect(keys.ok).toBe(false)
    }
    expect(resolveAnswerKeys({ agentKey: 'claude', ...status, screen, answer: { kind: 'permission', choice: 'allow' } }).ok)
      .toBe(false)
    expect(resolveAnswerKeys({
      agentKey: 'claude', ...status, screen, answer: { kind: 'permission', choice: 'deny' }, navideDirs: [VIEW],
    })).toEqual({ ok: true, keys: '\x1b' })
  })
})
