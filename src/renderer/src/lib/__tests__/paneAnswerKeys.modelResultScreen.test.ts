// @vitest-environment happy-dom
//
// cli_set_model reads claude's "Set model to" line through readScreenTail.
// Claude Code 2.1.286 draws a full-screen TUI on the alternate screen: a short
// transcript stays at the top of the pane and the composer is pinned to the
// bottom, with blank rows between them. On the Linux VM (106 columns, a tall
// pane) the 25-row tail held only the composer, so a switch that had worked
// was read as unconfirmed and the pane was restarted. Rows below are that
// layout at 106x50, as 2.1.286 replayed into @xterm/headless 6 draws it.
import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'

import { MODEL_RESULT_SCREEN_LINES, modelSwitchDiagnostic, modelSwitchResult } from '../paneAnswerKeys'
import { serializeRenderedBuffer } from '../../platform/terminal/composables/useTerminal'

const ROWS = 50
const RULE = '─'.repeat(106)

const TOP = [
  '',
  ' ▐▛███▛█   Claude Code v2.1.286',
  '▝▜██████▀  Opus 5.5 · API Usage Billing',
  ' ▝▝   ▝▝   ~/wh/wmcp',
  '',
  '❯ setmodel test: reply briefly.',
  '',
  '⏺ Bash(touch RAN.txt)',
  '  ⎿  (No output)',
  '',
  '⏺ finished',
  '',
  '✻ Cogitated for 12s · done 2:09 PM',
  '',
  '❯ /model',
  '  ⎿  Set model to Sonnet 5.5 for this session only',
]
const BOTTOM = [RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)', '']
const AFTER_YES = [...TOP, ...Array<string>(ROWS - TOP.length - BOTTOM.length).fill(''), ...BOTTOM]

/** readScreenTail(n): the alternate buffer has no scrollback, so baseY is 0. */
function readScreenTail(rows: string[], maxLines: number): string {
  const term = {
    rows: rows.length,
    buffer: {
      active: {
        type: 'alternate',
        baseY: 0,
        cursorY: rows.length - 2,
        getLine: (r: number) => (rows[r] === undefined ? undefined : { translateToString: () => rows[r] }),
      },
    },
  } as unknown as Terminal
  return serializeRenderedBuffer(term, maxLines, 'viewport-bottom')
}

describe('cli_set_model result line on a tall full-screen pane', () => {
  it('is out of reach of the 25-row tail the boxes are read from', () => {
    const tail = readScreenTail(AFTER_YES, 25)
    expect(AFTER_YES).toHaveLength(ROWS)
    expect(modelSwitchResult(tail)).toBeNull()
    // The shape the Linux VM logged: the composer and nothing else.
    expect(modelSwitchDiagnostic(tail)).toMatchObject({ selectModel: -1, switchModel: -1, setModelTo: -1 })
  })

  it('is found in the window cli_set_model reads the result from', () => {
    expect(MODEL_RESULT_SCREEN_LINES).toBeGreaterThanOrEqual(ROWS)
    expect(modelSwitchResult(readScreenTail(AFTER_YES, MODEL_RESULT_SCREEN_LINES))).toBe('session')
  })
})
