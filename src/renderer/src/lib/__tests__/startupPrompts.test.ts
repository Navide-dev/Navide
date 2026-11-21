import { describe, expect, it } from 'vitest'

import { matchAwaitingInput } from '../cliAwaitingInput'
import { parseMenuOptions, resolveAnswerKeys } from '../paneAnswerKeys'
import { createKickoffReporter } from '../spawnKickoff'
import {
  answerStartupPrompt, decideStartupPrompt, readContinueNotice, readStartupPrompt, settleStartupPrompts, waitStartupPromptGone,
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

// Claude Code 2.1.329's workspace trust dialog at launch (strings from the
// installed binary), and Codex's.
const claudeTrust = (folder: string): string => [
  ' Accessing workspace:',
  '',
  ` ${folder}`,
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known',
  " open source project, or work from your team). If not, take a moment to review what's in this folder first.",
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')
// The same dialog as 2.1.329 actually draws it (VM, Linux, 2.1.329; binary:
// cancelFirst, focus "cancel", hideIndexes): "No, exit" first with the cursor
// on it, no numbers. `cursor` is the option the ❯ is on.
const claudeTrustLive = (folder: string, cursor: 0 | 1 | null = 0): string => [
  ' Accessing workspace:',
  '',
  ` ${folder}`,
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known',
  " open source project, or work from your team). If not, take a moment to review what's in this folder first.",
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  `${cursor === 0 ? ' ❯ ' : '   '}No, exit`,
  `${cursor === 1 ? ' ❯ ' : '   '}Yes, I trust this folder`,
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')
const codexTrust = (folder: string): string => [
  ` You are in ${folder}`,
  '',
  ' Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.',
  '',
  ' › 1. Trust and continue',
  '   2. Open restricted',
].join('\n')
const WORKSPACE = '/Users/alex/proj'

describe('the workspace trust dialog at launch', () => {
  const decide = (screen: string, workspace: string, agentKey = 'claude') => {
    const prompt = readStartupPrompt(agentKey, screen)
    expect(prompt).toMatchObject({ kind: 'workspace-trust' })
    return decideStartupPrompt(prompt!, { navideDirs: [], workspace })
  }

  it('is answered when it names the pane\'s own workspace', () => {
    expect(decide(claudeTrust(WORKSPACE), WORKSPACE)).toMatchObject({ action: 'auto', rule: 'workspace-trust.own-workspace' })
    expect(decide(claudeTrust(WORKSPACE), `${WORKSPACE}/`)).toMatchObject({ action: 'auto' })
    // Codex's boilerplate speaks of permission settings; that is not what it asks.
    expect(decide(codexTrust(WORKSPACE), WORKSPACE, 'codex')).toMatchObject({ action: 'auto' })
    expect(decide(codexTrust('~/proj'), WORKSPACE, 'codex')).toMatchObject({ action: 'auto' })
    expect(decide(claudeTrust('C:\\Users\\dev\\proj'), 'C:\\Users\\dev\\proj')).toMatchObject({ action: 'auto' })
  })

  it('is answered when a terminal wrap split the workspace path where its row was full', () => {
    const long = '/Users/alex/a-rather-long-folder-name/that-wraps-in-a-narrow-pane/proj'
    const cols = ' /Users/alex/a-rather-long-folder-name/that-wraps-in-a-narrow-p'.length
    const wrapped = claudeTrust('/Users/alex/a-rather-long-folder-name/that-wraps-in-a-narrow-p\nane/proj')
    const prompt = readStartupPrompt('claude', wrapped, cols)
    expect(decideStartupPrompt(prompt!, { navideDirs: [], workspace: long })).toMatchObject({ action: 'auto' })
    // Without the pane's width the break cannot be told from a new line.
    expect(decide(wrapped, long)).toMatchObject({ action: 'block' })
    // A row that was not full, or a continuation row that starts with padding
    // (Ink), may hide a space: left to a person.
    for (const [screen, width] of [[wrapped, cols + 1], [claudeTrust(long.replace('narrow-pane', 'narrow-p\n ane')), cols]] as Array<[string, number]>) {
      expect(decideStartupPrompt(readStartupPrompt('claude', screen, width)!, { navideDirs: [], workspace: long }))
        .toMatchObject({ action: 'block' })
    }
  })

  it('is left to a person for any other folder, or when it names none', () => {
    for (const [screen, workspace] of [
      [claudeTrust('/Users/alex/other'), WORKSPACE],
      [claudeTrust('/Users/alex'), WORKSPACE], // the workspace's parent
      [claudeTrust(`${WORKSPACE}/sub`), WORKSPACE], // a folder inside it
      [claudeTrust(`${WORKSPACE}2`), WORKSPACE],
      [claudeTrust('/Users/alex/pro'), WORKSPACE],
      [codexTrust('~/other'), WORKSPACE],
      [codexTrust('~/proj'), '/opt/proj'],
      [' Trust this folder?\n ❯ 1. Yes\n   2. No', WORKSPACE],
      [claudeTrust(WORKSPACE), ''],
    ] as Array<[string, string]>) {
      expect(decide(screen, workspace), `${screen} / ${workspace}`).toMatchObject({ action: 'block' })
    }
  })

  it('leaves a vendor with its own trust watcher (Grok) to that watcher', () => {
    const grok = 'Do you trust the contents of this directory?\n/Users/alex/proj\n  Yes, proceed   y\n  No, quit       n'
    expect(readStartupPrompt('grok', grok)).toBeNull()
  })

  it('settles: Enter for the own workspace, blocked with nothing typed for another folder', async () => {
    for (const [folder, outcome, sent] of [
      [WORKSPACE, 'clear', ['\r']],
      ['/Users/alex/other', 'blocked', []],
    ] as Array<[string, string, string[]]>) {
      const state = { screen: claudeTrust(folder), sent: [] as string[] }
      let t = 0
      const watch = await settleStartupPrompts({
        agentKey: 'claude',
        readScreen: () => state.screen,
        navideDirs: () => [],
        workspace: () => WORKSPACE,
        awaiting: () => false,
        ready: () => state.screen === ' > ',
        alive: () => true,
        send: async (keys) => {
          state.sent.push(keys)
          if (keys === '\r') state.screen = ' > '
          return true
        },
        sleep: async () => { t += 250 },
        now: () => t,
        settleMs: 0,
        timeoutMs: 15_000,
        record: () => {},
      })
      expect(watch.outcome).toBe(outcome)
      expect(state.sent).toEqual(sent)
    }
  })
})

describe('Claude Code\'s trust menu, in either order', () => {
  // A pane on the 2.1.329 dialog: Down/Up move the cursor, Enter on Yes
  // trusts, Enter on No exits the CLI (as the real one does).
  function trustPane(layout: 'live' | 'old', folder = WORKSPACE) {
    const options = layout === 'live' ? ['No, exit', 'Yes, I trust this folder'] : ['Yes, I trust this folder', 'No, exit']
    const state = { cursor: 0, open: true, alive: true, sent: [] as string[] }
    const draw = (): string => layout === 'live'
      ? claudeTrustLive(folder, state.cursor as 0 | 1)
      : claudeTrust(folder).replace(' ❯ 1. Yes', `${state.cursor === 0 ? ' ❯ ' : '   '}1. Yes`)
        .replace('   2. No', `${state.cursor === 1 ? ' ❯ ' : '   '}2. No`)
    return {
      state,
      readScreen: () => (state.open ? draw() : ' > '),
      send: async (keys: string) => {
        state.sent.push(keys)
        if (keys === '\x1b[B') state.cursor = Math.min(state.cursor + 1, 1)
        if (keys === '\r') {
          state.open = false
          state.alive = options[state.cursor] !== 'No, exit'
        }
        return true
      },
    }
  }
  const settle = (pane: ReturnType<typeof trustPane>) => {
    let t = 0
    return settleStartupPrompts({
      agentKey: 'claude',
      readScreen: pane.readScreen,
      navideDirs: () => [],
      workspace: () => WORKSPACE,
      awaiting: () => false,
      ready: () => !pane.state.open,
      alive: () => pane.state.alive,
      send: pane.send,
      sleep: async () => { t += 250 },
      now: () => t,
      settleMs: 0,
      timeoutMs: 15_000,
      record: () => {},
    })
  }

  it('reads the cursor off the 2.1.329 menu and the older one', () => {
    expect(readStartupPrompt('claude', claudeTrustLive(WORKSPACE))).toMatchObject({
      kind: 'workspace-trust', options: ['No, exit', 'Yes, I trust this folder'], cursorOn: 'No, exit',
    })
    expect(readStartupPrompt('claude', claudeTrustLive(WORKSPACE, 1))).toMatchObject({ cursorOn: 'Yes, I trust this folder' })
    expect(readStartupPrompt('claude', claudeTrust(WORKSPACE))).toMatchObject({
      options: ['Yes, I trust this folder', 'No, exit'], cursorOn: 'Yes, I trust this folder',
    })
  })

  it('moves onto "Yes, I trust this folder" before Enter on the 2.1.329 menu', async () => {
    const pane = trustPane('live')
    expect(await settle(pane)).toEqual({ outcome: 'clear' })
    expect(pane.state.sent).toEqual(['\x1b[B', '\r'])
    expect(pane.state.alive).toBe(true)
  })

  it('presses Enter alone where the cursor already is on it (older menu)', async () => {
    const pane = trustPane('old')
    expect(await settle(pane)).toEqual({ outcome: 'clear' })
    expect(pane.state.sent).toEqual(['\r'])
  })

  it('presses nothing when the cursor cannot be read', async () => {
    const pane = trustPane('live')
    const unmarked = claudeTrustLive(WORKSPACE, null)
    expect(decideStartupPrompt(readStartupPrompt('claude', unmarked)!, { navideDirs: [], workspace: WORKSPACE }))
      .toMatchObject({ action: 'block' })
    const watch = await settle({ ...pane, readScreen: () => unmarked })
    expect(watch.outcome).toBe('blocked')
    expect(pane.state.sent).toEqual([])
  })

  it('still leaves any other folder alone on the 2.1.329 menu', async () => {
    for (const folder of ['/Users/alex', `${WORKSPACE}/sub`, '/Users/alex/other']) {
      const pane = trustPane('live', folder)
      expect((await settle(pane)).outcome).toBe('blocked')
      expect(pane.state.sent).toEqual([])
    }
  })

  it('is not blocked by a dialog that was answered already and is leaving the screen', async () => {
    // dismissStartupDialog's Enter went in; the watch reads the dialog once
    // more before the CLI redraws, and must not report the kickoff blocked.
    const pane = trustPane('old')
    let reads = 0
    const lagging = { ...pane, readScreen: () => (reads++ === 0 ? claudeTrust(WORKSPACE) : ' > ') }
    pane.state.open = false
    expect(await settle(lagging)).toEqual({ outcome: 'clear' })
    expect(pane.state.sent).toEqual([])
  })
})

describe('the trust dialog in a narrow pane (UI zoom 125%, ~20-30 columns)', () => {
  // The terminal wraps every row at `cols`, mid-word included ("Yes, I trust
  // this f" / "older"), and the rendered screen joins the rows with line
  // breaks — what readScreenTail returns for a pane that narrow.
  const wrapAt = (screen: string, cols: number): string => screen.split('\n')
    .flatMap((line) => (line.length <= cols ? [line] : line.match(new RegExp(`.{1,${cols}}`, 'g'))!))
    .join('\n')
  const tail = (screen: string, lines: number): string => screen.split('\n').slice(-lines).join('\n')

  function narrowPane(folder: string, cols: number, lines = 120) {
    const state = { cursor: 0, open: true, alive: true, sent: [] as string[] }
    const options = ['No, exit', 'Yes, I trust this folder']
    return {
      state,
      cols,
      readScreen: () => (state.open ? tail(wrapAt(claudeTrustLive(folder, state.cursor as 0 | 1), cols), lines) : ' > '),
      send: async (keys: string) => {
        state.sent.push(keys)
        if (keys === '\x1b[B') state.cursor = Math.min(state.cursor + 1, 1)
        if (keys === '\r') {
          state.open = false
          state.alive = options[state.cursor] !== 'No, exit'
        }
        return true
      },
    }
  }
  const settle = (pane: ReturnType<typeof narrowPane>) => {
    let t = 0
    return settleStartupPrompts({
      agentKey: 'claude',
      readScreen: pane.readScreen,
      navideDirs: () => [],
      workspace: () => WORKSPACE,
      // A dialog the watch cannot read still makes the pane read as awaiting.
      awaiting: () => pane.state.open,
      ready: () => !pane.state.open,
      alive: () => pane.state.alive,
      send: pane.send,
      sleep: async () => { t += 250 },
      now: () => t,
      settleMs: 0,
      timeoutMs: 15_000,
      cols: () => pane.cols,
      record: () => {},
    })
  }

  it('wraps the options mid-word, as the VM pane did', () => {
    const screen = wrapAt(claudeTrustLive(WORKSPACE), 22)
    expect(screen).not.toContain('Trust this folder')
    expect(screen).not.toContain('Yes, I trust this folder')
    expect(screen.split('\n').length).toBeGreaterThan(25)
  })

  for (const cols of [20, 22, 25, 30]) {
    it(`reads the menu and its cursor at ${cols} columns`, () => {
      expect(readStartupPrompt('claude', wrapAt(claudeTrustLive(WORKSPACE), cols))).toMatchObject({
        kind: 'workspace-trust', options: ['No, exit', 'Yes, I trust this folder'], cursorOn: 'No, exit',
      })
      expect(readStartupPrompt('claude', wrapAt(claudeTrustLive(WORKSPACE, 1), cols)))
        .toMatchObject({ cursorOn: 'Yes, I trust this folder' })
    })

    it(`own workspace at ${cols} columns: moves onto Yes, then Enter`, async () => {
      const pane = narrowPane(WORKSPACE, cols)
      expect(await settle(pane)).toEqual({ outcome: 'clear' })
      expect(pane.state.sent).toEqual(['\x1b[B', '\r'])
      expect(pane.state.alive).toBe(true)
    })

    it(`parent, child and other folders at ${cols} columns: not one key`, async () => {
      for (const folder of ['/Users/alex', `${WORKSPACE}/sub`, '/Users/alex/other']) {
        const pane = narrowPane(folder, cols)
        expect((await settle(pane)).outcome, folder).toBe('blocked')
        expect(pane.state.sent, folder).toEqual([])
      }
    })
  }

  it('holds the own workspace, pressing nothing, when the screen read misses the dialog title', async () => {
    // A 25-row read of a dialog wrapped to forty-odd rows: the menu without
    // "Accessing workspace: <dir>" names no folder.
    const pane = narrowPane(WORKSPACE, 22, 25)
    expect((await settle(pane)).outcome).toBe('blocked')
    expect(pane.state.sent).toEqual([])
  })

  it('never takes a path in the scrollback above the dialog for the folder it names', () => {
    const screen = `$ cd ${WORKSPACE}\n${wrapAt(claudeTrustLive('/Users/alex/other'), 22)}`
    expect(decideStartupPrompt(readStartupPrompt('claude', screen)!, { navideDirs: [], workspace: WORKSPACE }))
      .toMatchObject({ action: 'block' })
  })

  describe('a Windows workspace (VM 0.2.46 rc2, 125%: wn\\sub was trusted at 23 columns)', () => {
    const WN = 'C:\\Users\\navide\\wh\\wn'
    const settleIn = (pane: ReturnType<typeof narrowPane>, workspace: string) => {
      let t = 0
      return settleStartupPrompts({
        agentKey: 'claude',
        readScreen: pane.readScreen,
        navideDirs: () => [],
        workspace: () => workspace,
        awaiting: () => pane.state.open,
        ready: () => !pane.state.open,
        alive: () => pane.state.alive,
        send: pane.send,
        sleep: async () => { t += 250 },
        now: () => t,
        settleMs: 0,
        timeoutMs: 15_000,
        cols: () => pane.cols,
        record: () => {},
      })
    }

    it('wraps " C:\\Users\\navide\\wh\\wn\\sub" right after "wn\\" at 23 columns, as the VM pane did', () => {
      expect(wrapAt(claudeTrustLive(`${WN}\\sub`), 23)).toContain(' C:\\Users\\navide\\wh\\wn\\\nsub')
    })

    for (let cols = 22; cols <= 30; cols++) {
      it(`own workspace at ${cols} columns: moves onto Yes, then Enter`, async () => {
        const pane = narrowPane(WN, cols)
        expect(await settleIn(pane, WN)).toEqual({ outcome: 'clear' })
        expect(pane.state.sent).toEqual(['\x1b[B', '\r'])
      })

      it(`wn\\sub, the parent and another folder at ${cols} columns: not one key`, async () => {
        for (const folder of [`${WN}\\sub`, 'C:\\Users\\navide\\wh', 'C:\\Users\\navide\\wh\\other-ws-0246', `${WN}2`]) {
          const pane = narrowPane(folder, cols)
          expect((await settleIn(pane, WN)).outcome, folder).toBe('blocked')
          expect(pane.state.sent, folder).toEqual([])
        }
      })
    }

    it('a sibling whose name the wrap splits right after the workspace\'s is not the workspace', () => {
      // " C:\Users\navide\wh\wn" is 22 columns: "wn-old" wraps to "wn" / "-old".
      for (const sibling of [`${WN}-old`, `${WN}2`]) {
        const prompt = readStartupPrompt('claude', wrapAt(claudeTrustLive(sibling), 22))
        expect(decideStartupPrompt(prompt!, { navideDirs: [], workspace: WN }), sibling).toMatchObject({ action: 'block' })
      }
    })

    it('a folder whose name holds "Quick safety check" is read whole, not cut at the phrase', () => {
      const prompt = readStartupPrompt('claude', claudeTrustLive(`${WN} Quick safety check x`))
      expect(decideStartupPrompt(prompt!, { navideDirs: [], workspace: WN })).toMatchObject({ action: 'block' })
    })

    it('Codex: a folder inside the workspace, wrapped after its separator, is not the workspace', () => {
      // " You are in C:\Users\navide\wh\wn\" is 34 columns.
      const prompt = readStartupPrompt('codex', wrapAt(codexTrust(`${WN}\\sub`), 34))
      expect(decideStartupPrompt(prompt!, { navideDirs: [], workspace: WN })).toMatchObject({ action: 'block' })
    })

    describe('Codex, whose dialog has no fixed text after the folder', () => {
      // Codex's dialog with its path row padded so that WN ends `endsAt`
      // columns before the end of the second row, `after` drawn right behind it.
      const codexRow = (cols: number, after: string, endsAt = 0): string => {
        const pad = ' '.repeat(2 * cols - endsAt - ('You are in '.length + WN.length))
        return wrapAt([`${pad}You are in ${WN}${after}`, ...codexTrust(WN).split('\n').slice(1)].join('\n'), cols)
      }
      const decideCodex = (screen: string, cols: number) =>
        decideStartupPrompt(readStartupPrompt('codex', screen, cols)!, { navideDirs: [], workspace: WN })

      for (let cols = 22; cols <= 30; cols++) {
        it(`wn2 wrapped right after "wn" at ${cols} columns: blocked`, () => {
          const screen = codexRow(cols, '2')
          expect(screen).toContain(`wn\n2`)
          expect(decideCodex(screen, cols)).toMatchObject({ action: 'block' })
        })

        it(`wn ending its row with more text on the next row at ${cols} columns: blocked`, () => {
          expect(decideCodex(codexRow(cols, ' — trust it?'.replace(' ', '\n')), cols)).toMatchObject({ action: 'block' })
        })

        it(`wn with a space or punctuation after it on the same row at ${cols} columns: answered`, () => {
          expect(decideCodex(codexRow(cols, '?', 1), cols)).toMatchObject({ action: 'auto' })
          expect(decideCodex(codexRow(cols, ' ', 1), cols)).toMatchObject({ action: 'auto' })
          // Characters a folder name may hold are not an end: "wn.old", "wn,old".
          expect(decideCodex(codexRow(cols, '.', 1), cols)).toMatchObject({ action: 'block' })
          expect(decideCodex(codexRow(cols, ',old', 4), cols)).toMatchObject({ action: 'block' })
        })

        it(`as Codex draws it at ${cols} columns: wn answered, wn2, wn\\sub, the parent and another folder blocked`, () => {
          expect(decideCodex(wrapAt(codexTrust(WN), cols), cols)).toMatchObject({ action: 'auto' })
          for (const folder of [`${WN}2`, `${WN},old`, `${WN}.old`, `${WN}\\sub`, 'C:\\Users\\navide\\wh', 'C:\\Users\\navide\\wh\\other-ws-0246']) {
            expect(decideCodex(wrapAt(codexTrust(folder), cols), cols), folder).toMatchObject({ action: 'block' })
          }
        })
      }
    })
  })

  describe('folders that differ only by a space ("some project" / "someproject")', () => {
    const SPACED = '/Users/alex/work/some project/app'
    const JOINED = '/Users/alex/work/someproject/app'
    // Claude Code's Ink wraps a long row itself, each continuation row drawn
    // with the dialog's one-column padding.
    const inkWrap = (screen: string, cols: number): string => screen.split('\n').flatMap((line) => {
      const rows = [line.slice(0, cols)]
      for (let rest = line.slice(cols); rest; rest = rest.slice(cols - 1)) rows.push(` ${rest.slice(0, cols - 1)}`)
      return rows
    }).join('\n')
    const decideAt = (screen: string, cols: number, workspace: string, agentKey = 'claude') =>
      decideStartupPrompt(readStartupPrompt(agentKey, screen, cols)!, { navideDirs: [], workspace })
    // The terminal wrap put the folder's own space at a row's last column (the
    // row read back has lost it) or its first (where padding would look the
    // same): left to a person. `line` is the dialog row that draws `own`.
    const spaceAtWrap = (line: string, own: string, cols: number): boolean => {
      const at = own.includes(' ') ? line.indexOf(own) + own.indexOf(' ') : -1
      return at >= 0 && (at % cols === 0 || (at + 1) % cols === 0)
    }

    for (let cols = 20; cols <= 40; cols++) {
      it(`never takes one for the other at ${cols} columns, Claude or Codex, terminal-wrapped or Ink`, () => {
        for (const [shown, workspace] of [[SPACED, JOINED], [JOINED, SPACED]]) {
          for (const screen of [wrapAt(claudeTrustLive(shown), cols), inkWrap(claudeTrustLive(shown), cols)]) {
            expect(decideAt(screen, cols, workspace), `${shown} / ${workspace}`).toMatchObject({ action: 'block' })
          }
          expect(decideAt(wrapAt(codexTrust(shown), cols), cols, workspace, 'codex'), `codex ${shown} / ${workspace}`)
            .toMatchObject({ action: 'block' })
        }
      })

      it(`answers each one's own dialog at ${cols} columns where a terminal wrapped it`, () => {
        for (const own of [SPACED, JOINED]) {
          expect(decideAt(wrapAt(claudeTrustLive(own), cols), cols, own), own)
            .toMatchObject({ action: spaceAtWrap(` ${own}`, own, cols) ? 'block' : 'auto' })
          expect(decideAt(wrapAt(codexTrust(own), cols), cols, own, 'codex'), `codex ${own}`)
            .toMatchObject({ action: spaceAtWrap(` You are in ${own}`, own, cols) ? 'block' : 'auto' })
        }
      })

      it(`holds its own dialog at ${cols} columns where Ink wrapped it (padding may hide a space)`, () => {
        for (const own of [SPACED, JOINED]) {
          const wrapped = ` ${own}`.length > cols
          expect(decideAt(inkWrap(claudeTrustLive(own), cols), cols, own), own)
            .toMatchObject({ action: wrapped ? 'block' : 'auto' })
        }
      })
    }

    it('reads a real space exactly on one row: no space more, none less', () => {
      for (const [shown, workspace, action] of [
        [SPACED, SPACED, 'auto'], [JOINED, JOINED, 'auto'], [SPACED, JOINED, 'block'], [JOINED, SPACED, 'block'],
        [SPACED.replace(' ', '  '), SPACED, 'block'], [SPACED, SPACED.replace(' ', '  '), 'block'],
      ]) {
        expect(decideAt(claudeTrustLive(shown), 0, workspace), `${shown} / ${workspace}`).toMatchObject({ action })
        expect(decideAt(codexTrust(shown), 0, workspace, 'codex'), `codex ${shown} / ${workspace}`).toMatchObject({ action })
      }
    })
  })

  it('reads the add-dir dialog wrapped mid-word too', () => {
    const prompt = readStartupPrompt('claude', wrapAt(screenFor(VIEW), 22))
    expect(prompt).toMatchObject({ kind: 'claude.add-dir', cursorOn: 'No, exit' })
    expect(decideStartupPrompt(prompt!, { navideDirs: [VIEW] })).toMatchObject({ action: 'auto', choose: 'Yes, add it' })
  })
})

describe('launch screens behind TRUST_DIALOG_PATTERNS: which get a bare Enter', () => {
  // (b) informational, Enter only goes on — strings from the installed Codex
  // binary (vendor/aarch64-apple-darwin/bin/codex).
  const CODEX_FRESH_DB = [
    '  Codex detected a damaged local database, moved it into a backup folder, and will',
    '  continue startup with a fresh database.',
    '  Backup folder: unavailable',
    '',
    '  Continuing startup with a fresh local database...',
    '',
    '  Press Enter to continue.',
  ].join('\n')
  // (a) screens where Enter grants, signs in, selects or resumes something.
  const GRANTING: Array<[string, string, string]> = [
    // Codex onboarding (updatePrompt.test.ts AFTER_ESC): Enter starts a sign-in.
    ['codex', 'sign-in', [
      "  Welcome to Codex, OpenAI's command-line coding agent",
      '  Choose how you want to use Codex.',
      '› 1. Sign in with ChatGPT',
      '  2. Sign in with Device Code',
      '  Press enter to continue',
    ].join('\n')],
    // Codex full access confirmation: "Yes, continue anyway" grants it.
    ['codex', 'full access', [
      '  With full access, it can edit any file on your computer and run commands with network, without your approval.',
      '› Yes, continue anyway  Apply full access for this session',
      '  Go back without enabling full access',
    ].join('\n')],
    // Claude Code 2.1.330 org sign-in: "Yes, continue" applies an organization's settings.
    ['claude', 'org sign-in', [
      " Continue only if this is your account; that organization's settings will then apply to this machine.",
      ' ❯ Yes, continue',
      '   Go back',
    ].join('\n')],
    // Claude Code 2.1.330 usage limit reset: Enter resumes the task (spends usage).
    ['claude', 'usage reset', ' Your usage limit has reset\n Press enter to continue'],
    // Claude Code 2.1.330 managed settings: "allow Claude Code to use …" (it cannot start).
    ['claude', 'managed providers', " Your organization's managed settings allow Claude Code to use no API provider at all"],
    // Qwen Code's /agents wizard footer: Enter selects a step's option.
    ['qwen', 'agents wizard', ' Step 1: Choose Location\n Press Enter to continue, ↑↓ to navigate, Esc to cancel'],
  ]

  it('(b) dismisses Codex\'s fresh-database notice, wrapped or not', () => {
    expect(readContinueNotice('codex', CODEX_FRESH_DB)).toBe('codex.fresh-database-notice')
    const narrow = CODEX_FRESH_DB.split('\n').flatMap((l) => l.match(/.{1,22}/g) ?? ['']).join('\n')
    expect(readContinueNotice('codex', narrow)).toBe('codex.fresh-database-notice')
  })

  it('(b) only for its own vendor, live at the bottom of the screen', () => {
    expect(readContinueNotice('claude', CODEX_FRESH_DB)).toBe('')
    expect(readContinueNotice('codex', `${CODEX_FRESH_DB}\n${'later output '.repeat(30)}`)).toBe('')
  })

  it('(a) never gets a bare Enter, and is no prompt Navide answers', () => {
    for (const [agentKey, name, screen] of GRANTING) {
      expect(readContinueNotice(agentKey, screen), name).toBe('')
      expect(readStartupPrompt(agentKey, screen), name).toBeNull()
    }
  })

  it('(a) a folder trust dialog it cannot decide is held, not pressed', async () => {
    const sent: string[] = []
    let t = 0
    const watch = await settleStartupPrompts({
      agentKey: 'claude',
      readScreen: () => claudeTrustLive(WORKSPACE, null),
      navideDirs: () => [],
      workspace: () => WORKSPACE,
      awaiting: () => true,
      ready: () => false,
      alive: () => true,
      send: async (keys) => { sent.push(keys); return true },
      sleep: async () => { t += 250 },
      now: () => t,
      settleMs: 0,
      timeoutMs: 15_000,
      record: () => {},
    })
    expect(watch.outcome).toBe('blocked')
    expect(sent).toEqual([])
  })
})
