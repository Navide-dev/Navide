// @vitest-environment happy-dom
//
// The composer read that submitEvidence's queued verdict depends on, across
// the seam between the two files that produce it: serializeRenderedBuffer
// renders the screen, composerFromScreen picks the input box out of it. Neither
// side asserted the other — readScreenTail had no test at all — so an xterm
// change or a CLI that grows its footer could turn every mid-turn delivery into
// "never submitted" with the suite still green.
//
// The box is located by its FRAME, never by a row count. A fixed window was
// tried first and is wrong by construction: Claude Code's footer is a variable
// number of rows (accept-edits mode, model line, quota warning, update notice)
// and each one pushes the composer further out of a fixed window — which does
// not degrade safely. It reports "not submitted", injectText presses Enter
// three times, and the sender resends into a queue that already holds the
// message: the antigravity bug dc4b191e fixed, arriving from the other side.
import { describe, it, expect } from 'vitest'
import type { Terminal } from '@xterm/xterm'

import {
  composerFromScreen, normalizeForMatch, submitBaseline, submitEvidence, SUBMIT_SCREEN_LINES,
} from '../../../../lib/injectEcho'
import { serializeRenderedBuffer, serializeVisibleScreen } from '../useTerminal'

/** What readScreenTail(n) does: read the viewport bottom, not the cursor. */
function readScreenTail(rows: string[], maxLines: number = SUBMIT_SCREEN_LINES): string {
  const term = {
    rows: rows.length,
    buffer: {
      active: {
        baseY: 0,
        cursorY: 0,
        getLine: (r: number) =>
          rows[r] === undefined ? undefined : { translateToString: () => rows[r] },
      },
    },
  } as unknown as Terminal
  return serializeRenderedBuffer(term, maxLines, 'viewport-bottom')
}

const TAIL = normalizeForMatch('please run the tests')

/** Claude Code mid-turn with one message already queued, in accept-edits mode —
 *  the footer state a pane spends most of its life in, not an edge case. */
function midTurn(opts: { composer: string; above: string[] }): string[] {
  return [
    '⏺ Running the test suite…',
    '',
    ...opts.above,
    '╭────────────────────────────────╮',
    opts.composer,
    '╰────────────────────────────────╯',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
    '  ? for shortcuts   Press up to edit queued messages',
    '',
    '',
  ]
}

const HOLDING = midTurn({
  composer: '│ > please run the tests         │',
  above: ['> the earlier queued message'],
})
const SUBMITTED = midTurn({
  composer: '│ >                              │',
  above: ['> the earlier queued message', '> please run the tests'],
})

describe('locating the composer in a rendered screen', () => {
  it('finds the box however many rows the footer has grown to', () => {
    const composer = composerFromScreen(readScreenTail(HOLDING))
    expect(composer).toBe('│ > please run the tests         │')
    expect(normalizeForMatch(composer)).toContain(TAIL)
  })

  it('stops at the frame, so the copy redrawn above the box is not the composer', () => {
    // The half that makes the verdict mean anything: the screen read keeps
    // showing our tail after a successful Enter, which is why 'tail-left'
    // cannot fire and the box has to answer instead.
    const screen = readScreenTail(SUBMITTED)
    expect(normalizeForMatch(screen)).toContain(TAIL)
    expect(composerFromScreen(screen)).toBe('│ >                              │')
    expect(composerFromScreen(screen)).not.toContain('please run the tests')
  })

  it('reads the whole box when the composer has wrapped onto two rows', () => {
    const wrapped = midTurn({
      composer: '│ > please run           │\n│   the tests            │',
      above: [],
    })
    expect(normalizeForMatch(composerFromScreen(readScreenTail(wrapped)))).toContain(TAIL)
  })

  it('falls back to the bottom rows for a vendor that draws no box', () => {
    const plain = ['$ ls', 'a.txt  b.txt', '$ please run the tests', '']
    expect(normalizeForMatch(composerFromScreen(readScreenTail(plain)))).toContain(TAIL)
  })
})

describe('the queued verdict over a pre-existing hint', () => {
  it('says queued once the box empties, with the footer at its tallest', () => {
    const before = readScreenTail(HOLDING)
    const after = readScreenTail(SUBMITTED)
    const baseline = submitBaseline({ screen: before, tail: TAIL })
    expect(baseline).toEqual({ queuedHint: true, composerHeldTail: true })
    expect(
      submitEvidence({ tailWasOnScreen: true, tail: TAIL, screen: after, grownBy: 900, baseline }),
    ).toBe('queued')
  })

  it('says nothing while the box still holds the text, whatever the repaint did', () => {
    const before = readScreenTail(HOLDING)
    const baseline = submitBaseline({ screen: before, tail: TAIL })
    expect(
      submitEvidence({ tailWasOnScreen: true, tail: TAIL, screen: before, grownBy: 9_000, baseline }),
    ).toBeNull()
  })
})

/** What readVisibleScreen() does: every viewport row, frames kept. */
function readVisibleScreen(rows: string[]): string {
  const term = {
    rows: rows.length,
    buffer: { active: { baseY: 0, cursorY: 0, getLine: (r: number) => ({ translateToString: () => rows[r] ?? '' }) } },
  } as unknown as Terminal
  return serializeVisibleScreen(term)
}

describe('the collapsed-paste check reads the whole visible screen', () => {
  const rule = '────────────────────────────────────────'
  // No footer under the box: its closing rule is the bottom row, which the
  // tail read drops as a trailing frame row.
  const HELD = ['⏺ Done.', '', rule, '❯ [Pasted text #4 +31 lines]', rule, '', '']

  it('keeps the closing frame row the tail read drops', () => {
    expect(readScreenTail(HELD).split('\n').pop()).toBe('❯ [Pasted text #4 +31 lines]')
    expect(readVisibleScreen(HELD).split('\n')).toEqual(HELD)
  })

  it('refuses growth while the summary is still in that box', () => {
    expect(
      submitEvidence({
        tailWasOnScreen: false, tail: TAIL, screen: readScreenTail(HELD), grownBy: 900,
        visibleScreen: readVisibleScreen(HELD),
      }),
    ).toBeNull()
  })
})
