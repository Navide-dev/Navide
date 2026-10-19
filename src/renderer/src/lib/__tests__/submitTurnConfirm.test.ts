import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { SubmitEvidence } from '../injectEcho'
import { AGENT_SPECS } from '../../platform/plugin-shell/agents'
import { kickoffAttemptOutcome } from '../spawnKickoff'
import {
  blockingDialogShown, confirmWeakSubmit, extraEnterAllowed, shouldWatchTurn, SUBMIT_TURN_CONFIRM_MS,
  TURN_START_SIGNAL,
} from '../submitTurnConfirm'

/** A fake clock: sleep advances it, nothing really waits. */
function harness(opts: {
  how: SubmitEvidence
  turnAfterMs?: number
  held?: () => boolean | null
  abortAfterMs?: number
  watchTurn?: boolean
  dialog?: () => boolean
}) {
  let t = 0
  const slept: number[] = []
  let enters = 0
  const run = confirmWeakSubmit({
    how: opts.how,
    watchTurn: opts.watchTurn ?? true,
    dialogShown: opts.dialog ?? (() => false),
    turnStarted: () => opts.turnAfterMs !== undefined && t >= opts.turnAfterMs,
    collapsedHeld: opts.held ?? (() => false),
    pressEnter: async () => { enters++; return true },
    aborted: () => opts.abortAfterMs !== undefined && t >= opts.abortAfterMs,
    sleep: async (ms) => { slept.push(ms); t += ms },
    now: () => t,
  })
  return { run, slept: () => slept, enters: () => enters, elapsed: () => t }
}

describe('confirmWeakSubmit', () => {
  // The strong verdicts watched our own text leave the box (or the CLI's own
  // queue hint appear): they must never pay the turn wait.
  it.each(['tail-left', 'queued', 'unconfirmed'] as const)('returns %s at once, without waiting', async (how) => {
    const h = harness({ how })
    expect(await h.run).toBe(how)
    expect(h.slept()).toEqual([])
    expect(h.enters()).toBe(0)
  })

  it('watches for 10–15 seconds', () => {
    expect(SUBMIT_TURN_CONFIRM_MS).toBeGreaterThanOrEqual(10_000)
    expect(SUBMIT_TURN_CONFIRM_MS).toBeLessThanOrEqual(15_000)
  })

  it('upgrades growth to turn as soon as the CLI starts a new turn', async () => {
    const h = harness({ how: 'growth', turnAfterMs: 600 })
    expect(await h.run).toBe('turn')
    expect(h.elapsed()).toBeLessThan(1_000)
  })

  it('answers unconfirmed when no new turn shows up in the window', async () => {
    const h = harness({ how: 'growth' })
    expect(await h.run).toBe('unconfirmed')
    expect(h.elapsed()).toBeGreaterThanOrEqual(SUBMIT_TURN_CONFIRM_MS)
    expect(h.enters()).toBe(0)
  })

  it('presses Enter at most once while the box still holds the collapsed paste', async () => {
    const h = harness({ how: 'growth', held: () => true })
    expect(await h.run).toBe('unconfirmed')
    expect(h.enters()).toBe(1)
  })

  it('confirms the turn the extra Enter started', async () => {
    let t = 0
    let entered = -1
    const how = await confirmWeakSubmit({
      how: 'growth',
      watchTurn: true,
      dialogShown: () => false,
      turnStarted: () => entered >= 0 && t > entered,
      collapsedHeld: () => entered < 0,
      pressEnter: async () => { entered = t; return true },
      aborted: () => false,
      sleep: async (ms) => { t += ms },
      now: () => t,
    })
    expect(how).toBe('turn')
  })

  it('never presses Enter on a box it cannot locate or that is empty', async () => {
    for (const held of [() => null, () => false]) {
      const h = harness({ how: 'growth', held })
      await h.run
      expect(h.enters()).toBe(0)
    }
  })

  // A permission or confirm dialog: Enter would pick its default option.
  it('never presses Enter while a dialog is on screen, held box or not', async () => {
    const h = harness({ how: 'growth', held: () => true, dialog: () => true })
    expect(await h.run).toBe('unconfirmed')
    expect(h.enters()).toBe(0)
  })

  // No turn signal to wait for (mcode), or the pane was mid-turn when Enter
  // went in: growth keeps main's meaning and nothing waits.
  it('returns growth at once when the turn is not watched', async () => {
    const h = harness({ how: 'growth', watchTurn: false, held: () => true })
    expect(await h.run).toBe('growth')
    expect(h.slept()).toEqual([])
    expect(h.enters()).toBe(0)
  })

  it('answers null once the injection is aborted', async () => {
    const h = harness({ how: 'growth', abortAfterMs: 400 })
    expect(await h.run).toBeNull()
  })
})

describe('an unconfirmed kickoff submit is never retyped', () => {
  // Enter went out; a blank composer then means it most likely took, and a
  // second copy would run the task twice.
  it('stops on unverified even with a blank composer and attempts left', () => {
    expect(kickoffAttemptOutcome({
      injected: true, echo: 'placeholder', submit: 'unconfirmed', promptReady: true,
      composerHolds: () => false, attempt: 1, maxAttempts: 3,
    })).toEqual({ outcome: 'unverified', next: 'stop', retriedOut: false })
  })

  it('counts a confirmed turn as sent', () => {
    expect(kickoffAttemptOutcome({
      injected: true, echo: 'placeholder', submit: 'turn', promptReady: false,
      composerHolds: () => false, attempt: 1, maxAttempts: 3,
    }).outcome).toBe('sent')
  })
})

describe('injectText routes every submit verdict through confirmWeakSubmit', () => {
  const app = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
  const start = app.indexOf('async function injectText(')
  const fn = app.slice(start, app.indexOf('\n}\n', start))

  it('confirms before reporting, and reports what it settled on', () => {
    expect(fn).toContain('const settled = await confirmWeakSubmit({')
    expect(fn).toContain('if (evidence) evidence.submit = settled')
  })
})

describe('extraEnterAllowed', () => {
  it('needs a located box holding the collapsed paste and no dialog', () => {
    expect(extraEnterAllowed(true, false)).toBe(true)
    expect(extraEnterAllowed(true, true)).toBe(false)
    expect(extraEnterAllowed(null, false)).toBe(false)
    expect(extraEnterAllowed(false, false)).toBe(false)
  })
})

describe('which vendors get the turn watch', () => {
  // Every vendor is classified on purpose: one that is left out must not
  // silently turn every growth-only submit into an error.
  it('classifies every agent spec explicitly', () => {
    for (const spec of AGENT_SPECS) {
      expect(TURN_START_SIGNAL, spec.agentKey).toHaveProperty(spec.agentKey)
    }
  })

  it('watches the vendors whose log reader reports a turn start', () => {
    for (const key of ['claude', 'codex', 'copilot', 'cursor', 'droid', 'antigravity', 'aider',
      'muse', 'opencode', 'kilo', 'grok', 'kimi', 'pi', 'qwen']) {
      expect(shouldWatchTurn({ agentKey: key, midTurn: false }), key).toBe(true)
    }
  })

  it('keeps main\'s growth verdict for vendors with no turn signal', () => {
    expect(shouldWatchTurn({ agentKey: 'mcode', midTurn: false })).toBe(false)
    expect(shouldWatchTurn({ agentKey: 'terminal', midTurn: false })).toBe(false)
    expect(shouldWatchTurn({ agentKey: 'some-new-cli', midTurn: false })).toBe(false)
    expect(shouldWatchTurn({ agentKey: undefined, midTurn: false })).toBe(false)
  })

  // A message pushed mid-turn is queued by the CLI and starts no turn of its
  // own until the current one ends, however long that takes.
  it('does not watch a pane that was already mid-turn', () => {
    expect(shouldWatchTurn({ agentKey: 'claude', midTurn: true })).toBe(false)
  })
})

describe('injectText never presses an extra Enter it cannot justify', () => {
  const app = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
  const start = app.indexOf('async function injectText(')
  const fn = app.slice(start, app.indexOf('\n}\n', start))

  it('does not resend Enter on a screen with no box to locate', () => {
    expect(fn).not.toContain("how === 'unconfirmed' && attempt === 1")
  })

  it('stops resending Enter once a dialog is on screen', () => {
    expect(fn).toContain('if (attempt > 1 && dialogShown()) {')
    expect(fn).toContain('blockingDialogShown({')
    expect(fn).not.toContain("displayStatus === 'awaiting'")
  })

  it('decides the turn watch per vendor and per mid-turn', () => {
    expect(fn).toContain('watchTurn: shouldWatchTurn({ agentKey, midTurn: midTurnAtEnter })')
  })
})

describe('blockingDialogShown', () => {
  const rule = '────────────────────────────────────────'
  const box = (composer: string, below: string[] = ['  ? for shortcuts']) =>
    ['⏺ Done. Want me to continue?', rule, composer, rule, ...below].join('\n')

  // A turn that ended on a question leaves the CLI at its ordinary prompt;
  // the message gate lets such a pane through on purpose (parkedOnQuestion).
  it('is false for an awaiting pane whose turn only ended on a question', () => {
    expect(blockingDialogShown({ awaitingKind: 'question', agentKey: 'claude', screen: box('❯ [Pasted text #1 +20 lines]') })).toBe(false)
  })

  it('is true for a permission prompt', () => {
    expect(blockingDialogShown({ awaitingKind: 'permission', agentKey: 'claude', screen: box('❯ ') })).toBe(true)
  })

  // Our own unsent message may quote a dialog's wording; text inside the box,
  // or in the transcript above it, is not a dialog.
  it('ignores dialog wording inside the framed composer', () => {
    const screen = box('❯ pick "No, and tell Claude what to do differently" — Press enter to confirm or esc to go back')
    expect(blockingDialogShown({ awaitingKind: null, agentKey: 'claude', screen })).toBe(false)
  })

  it('ignores dialog wording in the transcript above the box', () => {
    const screen = ['• Would you like to run the following command?', rule, '› ', rule].join('\n')
    expect(blockingDialogShown({ awaitingKind: null, agentKey: 'codex', screen })).toBe(false)
  })

  it('reads dialog wording drawn below the box', () => {
    const screen = box('❯ ', ['Press enter to confirm or esc to go back'])
    expect(blockingDialogShown({ awaitingKind: null, agentKey: 'claude', screen })).toBe(true)
  })

  // A dialog that replaced the box leaves no frame to scope by.
  it('reads the whole screen when there is no box', () => {
    const screen = ['Do you want to proceed?', '❯ 1. Yes', '  3. No, and tell Claude what to do differently (esc)'].join('\n')
    expect(blockingDialogShown({ awaitingKind: null, agentKey: 'claude', screen })).toBe(true)
  })

  // The #416 guard for AskUserQuestion rides on the screen alone, so a
  // statusLine under the picker's footer must not lift it.
  it('reads an AskUserQuestion footer with a statusLine drawn below it', () => {
    const screen = [
      '  1. Merge them into one state',
      '  2. Keep them separate',
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
      '',
      '  ~/git/navide · main · Opus 4.7 · 42% context',
    ].join('\n')
    expect(blockingDialogShown({ awaitingKind: null, agentKey: 'claude', screen })).toBe(true)
  })

  // Border rows left under a live footer pair up like an input box's frame;
  // with no prompt row between them they are not one, so the dialog above
  // them is still read.
  it('reads a dialog footer with border rows drawn below it', () => {
    const border = ['╰──────────────────────────────────────╯', '│']
    const pickerScreen = [
      '  1. Merge them into one state',
      '  2. Keep them separate',
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
      ...border,
    ].join('\n')
    const permissionScreen = [
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
      '',
      'Esc to cancel · Tab to amend',
      ...border,
    ].join('\n')
    expect(blockingDialogShown({ awaitingKind: null, agentKey: 'claude', screen: pickerScreen })).toBe(true)
    expect(blockingDialogShown({ awaitingKind: null, agentKey: 'claude', screen: permissionScreen })).toBe(true)
  })

  // Frameless (codex): the composer is the prompt row and what wraps below
  // it. An unsent message quoting a dialog's wording must not read as one —
  // main resends the Enter there and the message is delivered.
  it('ignores dialog wording in a frameless composer', () => {
    for (const composer of [
      '› review: "Would you like to run the following command?" wording',
      '› note: Press enter to confirm or esc to go back',
    ]) {
      const screen = ['• Updated the tests.', '', composer, '  continued on a second row', '', '  ⏎ send   ctrl+j newline'].join('\n')
      expect(blockingDialogShown({ awaitingKind: null, agentKey: 'codex', screen }), composer).toBe(false)
    }
  })

  // codex's approval menu: its cursor row is a numbered option, not a prompt.
  it('still reads a frameless approval menu as a dialog', () => {
    const screen = [
      '• Would you like to run the following command?',
      '  $ rm -rf build',
      '› 1. Yes, proceed',
      '  2. No, and tell Codex what to do differently',
      'Press enter to confirm or esc to go back',
    ].join('\n')
    expect(blockingDialogShown({ awaitingKind: null, agentKey: 'codex', screen })).toBe(true)
  })
})

describe('the extra Enter under each awaiting kind', () => {
  const rule = '────────────────────────────────────────'
  const held = [rule, '❯ [Pasted text #1 +20 lines]', rule].join('\n')
  const run = async (awaitingKind: 'question' | 'permission') => {
    let t = 0
    let enters = 0
    await confirmWeakSubmit({
      how: 'growth',
      watchTurn: true,
      dialogShown: () => blockingDialogShown({ awaitingKind, agentKey: 'claude', screen: held }),
      turnStarted: () => false,
      collapsedHeld: () => true,
      pressEnter: async () => { enters++; return true },
      aborted: () => false,
      sleep: async (ms) => { t += ms },
      now: () => t,
    })
    return enters
  }

  it('still presses the one extra Enter on a pane parked on a question, like main', async () => {
    expect(await run('question')).toBe(1)
  })

  it('never presses Enter on a permission prompt', async () => {
    expect(await run('permission')).toBe(0)
  })

  // aider keeps the submitted "> message" row on screen and prints its Y/N
  // question below it, with no prompt row of its own. Enter would answer the
  // default Yes.
  const AIDER_ASK = [
    '> please fix the failing test',
    '',
    'tests/test_x.py',
    'Allow edits to file that has not been added to the chat? (Y)es/(N)o [Yes]: ',
  ].join('\n')

  it('reads aider\'s question below its old prompt row as a dialog', () => {
    expect(blockingDialogShown({ awaitingKind: null, agentKey: 'aider', screen: AIDER_ASK })).toBe(true)
  })

  it('never presses Enter on aider\'s Y/N question', async () => {
    let t = 0
    let enters = 0
    await confirmWeakSubmit({
      how: 'growth',
      watchTurn: true,
      dialogShown: () => blockingDialogShown({ awaitingKind: null, agentKey: 'aider', screen: AIDER_ASK }),
      turnStarted: () => false,
      collapsedHeld: () => true,
      pressEnter: async () => { enters++; return true },
      aborted: () => false,
      sleep: async (ms) => { t += ms },
      now: () => t,
    })
    expect(enters).toBe(0)
  })

  it('never presses Enter on a frameless approval menu', async () => {
    const menu = ['• Would you like to run the following command?', '› 1. Yes, proceed',
      '  2. No, and tell Codex what to do differently'].join('\n')
    let t = 0
    let enters = 0
    await confirmWeakSubmit({
      how: 'growth',
      watchTurn: true,
      dialogShown: () => blockingDialogShown({ awaitingKind: null, agentKey: 'codex', screen: menu }),
      turnStarted: () => false,
      collapsedHeld: () => true,
      pressEnter: async () => { enters++; return true },
      aborted: () => false,
      sleep: async (ms) => { t += ms },
      now: () => t,
    })
    expect(enters).toBe(0)
  })
})
