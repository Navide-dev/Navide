import { describe, expect, it } from 'vitest'
import { modelConfirmKeys, modelPickerKeys, modelSwitchDiagnostic, modelSwitchResult, onModelPicker, onModelSwitchConfirm, stillOnModelPicker, stillOnModelSwitchConfirm, writeAnswerSteps } from '../paneAnswerKeys'

const UP = '\x1b[A'
const DOWN = '\x1b[B'

// Claude Code 2.1.322's /model picker, as it reads on screen.
function picker(cursor: number, footer = 'Enter to set as default · s to use this session only · Esc to cancel'): string {
  const rows = [
    '1.  Default (recommended)  Sonnet 5.5 · Efficient for routine tasks',
    '2.  Opus 5.5 ✔             For complex work and everyday tasks',
    '3.  Fable 5.2              Most capable for the hardest work',
    '4.  Sonnet 5.5             Efficient for routine tasks',
    '5.  Haiku 5.5              Fastest for quick answers',
  ]
  return [
    ' Select model',
    ' Switch between Claude models. Your pick becomes the default for new sessions.',
    '',
    ...rows.map((r, i) => `${i === cursor ? ' ❯ ' : '   '}${r}`),
    '   ▸ More models',
    '',
    ' ◐ Medium effort (default) ←/→ to adjust',
    '',
    ` ${footer}`,
  ].join('\n')
}

describe('modelPickerKeys', () => {
  it('moves to the named row and presses s', () => {
    expect(modelPickerKeys(picker(1), 'Haiku 5.5')).toEqual([DOWN, DOWN, DOWN, 's'])
    expect(modelPickerKeys(picker(1), 'Opus 5.5')).toEqual(['s'])
    expect(modelPickerKeys(picker(4), 'Fable 5.2')).toEqual([UP, UP, 's'])
  })

  it('reads only the name column, so the Default row never stands in for Sonnet', () => {
    expect(modelPickerKeys(picker(1), 'Sonnet 5.5')).toEqual([DOWN, DOWN, 's'])
    expect(modelPickerKeys(picker(0), 'Sonnet')).toEqual([DOWN, DOWN, DOWN, 's'])
  })

  it('takes a bare family only when one row of it is listed', () => {
    expect(modelPickerKeys(picker(1), 'Opus')).toEqual(['s'])
    const twoOpus = picker(1).replace('3.  Fable 5.2  ', '3.  Opus 5.1   ')
    expect(modelPickerKeys(twoOpus, 'Opus')).toBeNull()
  })

  it('never presses a digit or Enter', () => {
    for (const label of ['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5']) {
      const keys = modelPickerKeys(picker(0), label) ?? []
      expect(keys.length).toBeGreaterThan(0)
      expect(keys.some((k) => /\d|\r|\n/.test(k))).toBe(false)
    }
  })

  it('is null without the session-only key', () => {
    expect(modelPickerKeys(picker(1, 'Enter to confirm · Esc to cancel'), 'Haiku 5.5')).toBeNull()
  })

  it('is null for a model under More models or not listed', () => {
    expect(modelPickerKeys(picker(1), 'Opus 4.1')).toBeNull()
    expect(modelPickerKeys(picker(1), 'Sonnet 4.5')).toBeNull()
  })

  it('is null off the picker or without a cursor', () => {
    expect(modelPickerKeys('  1. Yes\n  2. No\n s to use this session only', 'Yes')).toBeNull()
    expect(modelPickerKeys(picker(-1), 'Haiku 5.5')).toBeNull()
  })
})

// Captured from a live Claude Code 2.1.322 pane at 120 columns (11-11).
const LIVE_PICKER = [
  '   Select model',
  '   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,',
  '   specify with --model.',
  '',
  '     1.  Default (recommended)  Sonnet 5.5 · Efficient for routine tasks',
  '   ❯ 2.  Opus 5.5 ✔             For complex work and everyday tasks',
  '     3.  Fable 5.2              For your toughest challenges',
  '     4.  Sonnet 5.5             Most efficient for simpler tasks',
  '     5.  Haiku 5.5              Fastest for quick answers',
  '     ▸   More models',
  '',
  '   ◐ Medium effort (default) ←/→ to adjust',
  '',
  '   Enter to set as default · s to use this session only · Esc to cancel',
].join('\n')

describe('the live picker', () => {
  it('gives the keys that switched a live pane to Sonnet 5.5 for this session only', () => {
    expect(onModelPicker(LIVE_PICKER)).toBe(true)
    expect(modelPickerKeys(LIVE_PICKER, 'Sonnet 5.5')).toEqual([DOWN, DOWN, 's'])
    expect(modelSwitchResult('❯ /model\n  ⎿  Set model to Sonnet 5.5 for this session only\n❯')).toBe('session')
  })
})

describe('onModelPicker / stillOnModelPicker', () => {
  it('sees the picker by its title and rows', () => {
    expect(onModelPicker(picker(1))).toBe(true)
    expect(onModelPicker('> /model')).toBe(false)
  })

  it('holds while only the cursor moves, whatever the awaiting state', () => {
    expect(stillOnModelPicker(picker(1), undefined, picker(3))).toBe(true)
    expect(stillOnModelPicker(picker(1), 'idle', picker(1))).toBe(true)
  })

  it('stops when the title goes or the rows change', () => {
    expect(stillOnModelPicker(picker(1), undefined, '> ')).toBe(false)
    const fewer = picker(1).replace(/ {3}5\. {2}Haiku.*\n/, '')
    expect(stillOnModelPicker(picker(1), undefined, fewer)).toBe(false)
    const renamed = picker(1).replace('Fable 5.2', 'Fable 5.3')
    expect(stillOnModelPicker(picker(1), undefined, renamed)).toBe(false)
  })

  it('stops writeAnswerSteps through the injected check', async () => {
    const written: string[] = []
    const screens = [picker(2), '> ']
    const result = await writeAnswerSteps({
      steps: [DOWN, DOWN, 's'],
      menu: picker(1),
      read: () => ({ displayStatus: 'idle', screen: screens.shift() ?? '> ' }),
      write: async (data) => {
        written.push(data)
        return { ok: true }
      },
      gapMs: 0,
      stillOn: stillOnModelPicker,
    })
    expect(result).toBe('prompt-changed')
    expect(written).toEqual([DOWN, DOWN])
  })
})

describe('modelSwitchResult', () => {
  const composer = ['╭────╮', '│ >  │', '╰────╯', '  ? for shortcuts'].join('\n')

  it('reads a fresh session-only switch', () => {
    expect(modelSwitchResult(`> /model\n  ⎿  Set model to Sonnet 5.5\n${composer}`)).toBe('session')
  })

  it('reads a switch saved as the default', () => {
    expect(modelSwitchResult(`  ⎿  Set model to Sonnet 5.5 (saved as your default)\n${composer}`)).toBe('default')
  })

  it('ignores the picker still up and an old line far above', () => {
    expect(modelSwitchResult(picker(1))).toBeNull()
    const old = ['  ⎿  Set model to Opus 5.5', ...Array(12).fill('some answer text'), composer].join('\n')
    expect(modelSwitchResult(old)).toBeNull()
  })
})

// The box `s` raises once a pane has a conversation. WINDOWS_CONFIRM is the
// frame in the VM pane log claude-903435d6.log (Claude Code 2.1.286, 11-10),
// spacing restored; LIVE_CONFIRM was captured on 2.1.322 at 120 columns.
const WINDOWS_CONFIRM = [
  '❯ Reply with just the word ok.',
  '⏺ ok',
  '',
  ' Switch model?',
  ' Your next response will be slower and use more tokens',
  ' This conversation is cached for the current model. Switching to Sonnet 5.5',
  ' means the full history gets re-read on your next message.',
  '',
  ' ❯ 1. Yes, switch to Sonnet 5.5',
  '   2. No, go back',
].join('\n')
const LIVE_CONFIRM = [
  '❯ Reply with just the word ok.',
  '⏺ ok',
  '✻ Sautéed for 4s · done 7:23 AM',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '   Switch model?',
  '',
  '   Your next response will be slower and use more tokens',
  '',
  '   This conversation is cached for the current model. Switching to Sonnet 5.5 means the full history gets re-read.',
  '',
  '   ❯ 1. Yes, switch to Sonnet 5.5',
  '     2. No, go back',
].join('\n')

describe('the "Switch model?" confirmation', () => {
  it('is seen on the Windows and the live box, never on the picker', () => {
    expect(onModelSwitchConfirm(WINDOWS_CONFIRM)).toBe(true)
    expect(onModelSwitchConfirm(LIVE_CONFIRM)).toBe(true)
    expect(onModelSwitchConfirm(LIVE_PICKER)).toBe(false)
    expect(onModelSwitchConfirm(picker(1))).toBe(false)
  })

  it('picks Yes with Enter when it names the target', () => {
    expect(modelConfirmKeys(WINDOWS_CONFIRM, 'Sonnet 5.5')).toEqual(['\r'])
    expect(modelConfirmKeys(LIVE_CONFIRM, 'Sonnet 5.5')).toEqual(['\r'])
    expect(modelConfirmKeys(LIVE_CONFIRM, 'Sonnet')).toEqual(['\r'])
    const onNo = WINDOWS_CONFIRM.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. No', ' ❯ 2. No')
    expect(modelConfirmKeys(onNo, 'Sonnet 5.5')).toEqual([UP, '\r'])
  })

  it('is null when Yes names another model, or off the box, or without a cursor', () => {
    expect(modelConfirmKeys(WINDOWS_CONFIRM, 'Haiku 5.5')).toBeNull()
    expect(modelConfirmKeys(WINDOWS_CONFIRM, 'Sonnet 5.6')).toBeNull()
    expect(modelConfirmKeys(LIVE_PICKER, 'Sonnet 5.5')).toBeNull()
    expect(modelConfirmKeys(WINDOWS_CONFIRM.replace(' ❯ 1.', '   1.'), 'Sonnet 5.5')).toBeNull()
  })

  it('holds the keys only on the same box', () => {
    expect(stillOnModelSwitchConfirm(WINDOWS_CONFIRM, undefined, WINDOWS_CONFIRM)).toBe(true)
    expect(stillOnModelSwitchConfirm(WINDOWS_CONFIRM, undefined, LIVE_PICKER)).toBe(false)
    expect(stillOnModelSwitchConfirm(WINDOWS_CONFIRM, undefined, WINDOWS_CONFIRM.replace('Sonnet 5.5', 'Haiku 5.5').replace('to Sonnet', 'to Haiku'))).toBe(false)
  })

  it('is no switch result while it is up, and the live result after Yes reads as session-only', () => {
    expect(modelSwitchResult(WINDOWS_CONFIRM)).toBeNull()
    expect(modelSwitchResult(`  ⎿  Set model to Opus 5.5\n${LIVE_CONFIRM}`)).toBeNull()
    expect(modelSwitchResult('❯ /model\n  ⎿  Set model to Sonnet 5.5 for this session only\n❯')).toBe('session')
  })
})

// The Linux VM run (Claude Code 2.1.286, 106 columns, 11-11) where the switch
// went through but cli_set_model fell back to a restart: the box's text from
// the pane log claude-9463c289.log, spacing restored, with the box's title
// left on the screen tail above the result line that followed it.
const LINUX_CONFIRM = [
  '   Switch model?',
  '   Your next response will be slower and use more tokens',
  '   This conversation is cached for the current model. Switching to Sonnet 5.5 means the full history',
  '   gets re-read on your next message.',
  '   ❯ 1. Yes, switch to Sonnet 5.5',
  '     2. No, go back',
].join('\n')
const LINUX_COMPOSER = ['─'.repeat(106), '❯ ', '─'.repeat(106)].join('\n')
// A real screen tail after Yes: 2.1.286 at 106x30 replayed into xterm 6 and
// read like readScreenTail (blank rows dropped).
const REPLAYED_AFTER_YES = [
  '❯ say ok',
  '⏺ ok',
  '✻ Crunched for 3s · done 10:18 AM',
  '❯ /model',
  '  ⎿  Set model to Haiku 4.5 for this session only',
  '                                                                    auto mode unavailable for this model',
  '─'.repeat(106),
  '❯ ',
  '─'.repeat(106),
  '  ⏸ manual mode on · ? for shortcuts',
].join('\n')

describe('modelSwitchResult after the "Switch model?" box', () => {
  it('reads the result line below a box title left on the tail as session-only', () => {
    expect(modelSwitchResult(`${LINUX_CONFIRM}\n❯ /model\n  ⎿  Set model to Sonnet 5.5 for this session only\n${LINUX_COMPOSER}`)).toBe('session')
    expect(modelSwitchResult(`${LIVE_PICKER}\n${LINUX_CONFIRM}\n❯ /model\n  ⎿  Set model to Sonnet 5.5 for this session only\n${LINUX_COMPOSER}`)).toBe('session')
    expect(modelSwitchResult(REPLAYED_AFTER_YES)).toBe('session')
  })

  it('is null while the box is still the last thing on the tail', () => {
    expect(modelSwitchResult(LINUX_CONFIRM)).toBeNull()
    expect(modelSwitchResult(`❯ /model\n  ⎿  Set model to Opus 5.5 for this session only\n${LINUX_CONFIRM}`)).toBeNull()
  })

  it('reads a line saved as the default as default', () => {
    expect(modelSwitchResult(`${LINUX_CONFIRM}\n  ⎿  Set model to Sonnet 5.5 (saved as your default)\n${LINUX_COMPOSER}`)).toBe('default')
  })
})

describe('modelSwitchDiagnostic', () => {
  // Built at runtime: a fake key-like value and customer text on the screen.
  const fakeKey = ['sk', 'ant', 'api03', 'Z'.repeat(24)].join('-')
  const customer = ['Customer', 'Ada', 'Example'].join(' ')
  const screen = [
    `${LIVE_PICKER}`,
    `❯ echo ${fakeKey}`,
    `  ${customer}`,
    LINUX_CONFIRM,
    '❯ /model',
    '  ⎿  Set model to Sonnet 5.5 for this session only',
    LINUX_COMPOSER,
  ].join('\n')

  it('gives the line count and the last line of each marker, -1 when absent', () => {
    const lines = screen.split('\n').filter((l) => l.trim())
    const d = modelSwitchDiagnostic(screen)
    expect(d).toEqual({
      lines: lines.length,
      selectModel: lines.findIndex((l) => l.includes('Select model')),
      switchModel: lines.findIndex((l) => l.includes('Switch model?')),
      setModelTo: lines.findIndex((l) => l.includes('Set model to')),
      savedAsDefault: -1,
    })
    expect(modelSwitchDiagnostic('')).toEqual({ lines: 0, selectModel: -1, switchModel: -1, setModelTo: -1, savedAsDefault: -1 })
  })

  it('puts none of the screen text into the logged line', () => {
    const line = JSON.stringify({ fallback: 'confirm-not-confirmed', waitedMs: 5123, ...modelSwitchDiagnostic(screen) })
    for (const text of [fakeKey, 'Z'.repeat(24), customer, 'Ada', 'Sonnet', 'Set model to', 'Switch model', 'Select model', 'echo']) {
      expect(line).not.toContain(text)
    }
    expect(Object.values(modelSwitchDiagnostic(screen)).every((v) => Number.isInteger(v))).toBe(true)
  })
})
