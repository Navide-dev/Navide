import { describe, expect, it } from 'vitest'
import { awaitingPromptText, isPermanentAllow, parseMenuOptions, resolveAnswerKeys, type PaneAnswer } from '../paneAnswerKeys'

const CLAUDE_PERMISSION = [
  'Do you want to make this edit to useTerminal.ts?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again this session",
  '  3. No, and tell Claude what to do differently (esc)',
].join('\n')

const CLAUDE_QUESTION = [
  '  1. Merge them into one state',
  '  2. Keep them separate',
  '  3. Type something.',
  '  4. Chat about this',
  'Enter to select · Tab/Arrow keys to navigate· Esc to cancel',
].join('\n')

const CODEX_PERMISSION = [
  'Would you like to run the following command?',
  '› 1. Yes, just this once',
  "  2. Yes, and don't ask again for this command in this session",
  '  3. No, and tell Codex what to do differently',
].join('\n')

function resolve(agentKey: string, answer: PaneAnswer, screen: string, awaitingKind: string | null = answer.kind) {
  return resolveAnswerKeys({ agentKey, displayStatus: 'awaiting', awaitingKind, screen, answer })
}

describe('parseMenuOptions', () => {
  it('reads the numbered options with or without a cursor marker', () => {
    expect(parseMenuOptions(CLAUDE_PERMISSION)).toEqual([
      'Yes',
      "Yes, and don't ask again this session",
      'No, and tell Claude what to do differently (esc)',
    ])
    expect(parseMenuOptions(CLAUDE_QUESTION)).toHaveLength(4)
    expect(parseMenuOptions(CODEX_PERMISSION)[0]).toBe('Yes, just this once')
  })

  it('keeps the last menu when an older numbered list is still on screen', () => {
    expect(parseMenuOptions(`1. old\n2. list\nprose\n${CODEX_PERMISSION}`)[0]).toBe('Yes, just this once')
  })

  it('finds nothing in ordinary output', () => {
    expect(parseMenuOptions('Running tests…\n12 passed')).toEqual([])
  })
})

describe('awaitingPromptText', () => {
  it('keeps the last 12 non-empty lines within 800 characters', () => {
    const screen = Array.from({ length: 30 }, (_, i) => (i % 2 ? '' : `line ${i}`)).join('\n')
    const text = awaitingPromptText(screen)
    expect(text.split('\n')).toHaveLength(12)
    expect(text.endsWith('line 28')).toBe(true)
    expect(awaitingPromptText('x'.repeat(2000))).toHaveLength(800)
  })
})

describe('resolveAnswerKeys', () => {
  it('maps a claude permission to 1 / Esc', () => {
    expect(resolve('claude', { kind: 'permission', choice: 'allow' }, CLAUDE_PERMISSION)).toEqual({ ok: true, keys: '1' })
    expect(resolve('claude', { kind: 'permission', choice: 'deny' }, CLAUDE_PERMISSION)).toEqual({ ok: true, keys: '\x1b' })
  })

  it('maps a codex permission the same way', () => {
    expect(resolve('codex', { kind: 'permission', choice: 'allow' }, CODEX_PERMISSION)).toEqual({ ok: true, keys: '1' })
    expect(resolve('codex', { kind: 'permission', choice: 'deny' }, CODEX_PERMISSION)).toEqual({ ok: true, keys: '\x1b' })
  })

  it('maps a question option to its digit, only if the menu has it', () => {
    expect(resolve('claude', { kind: 'question', option: 2 }, CLAUDE_QUESTION)).toEqual({ ok: true, keys: '2' })
    expect(resolve('claude', { kind: 'question', option: 5 }, CLAUDE_QUESTION)).toMatchObject({ ok: false })
    expect(resolve('claude', { kind: 'question', option: 0 }, CLAUDE_QUESTION)).toMatchObject({ ok: false })
  })

  it('answers aider with y/n and Enter, and refuses questions there', () => {
    expect(resolve('aider', { kind: 'permission', choice: 'allow' }, '')).toEqual({ ok: true, keys: 'y\r' })
    expect(resolve('aider', { kind: 'permission', choice: 'deny' }, '')).toEqual({ ok: true, keys: 'n\r' })
    expect(resolve('aider', { kind: 'question', option: 1 }, '')).toEqual({ ok: false, error: 'unsupported for aider' })
  })

  it('refuses a vendor with no known mapping', () => {
    expect(resolve('kimi', { kind: 'permission', choice: 'allow' }, CLAUDE_PERMISSION)).toEqual({
      ok: false,
      error: 'unsupported for kimi',
    })
  })

  it('refuses unless the pane is awaiting the same kind', () => {
    expect(
      resolveAnswerKeys({
        agentKey: 'claude',
        displayStatus: 'running',
        awaitingKind: null,
        screen: CLAUDE_PERMISSION,
        answer: { kind: 'permission', choice: 'allow' },
      })
    ).toMatchObject({ ok: false })
    expect(resolve('claude', { kind: 'permission', choice: 'allow' }, CLAUDE_PERMISSION, 'question')).toMatchObject({ ok: false })
  })

  it('answers a question menu whatever awaitingKind says, as long as the option is on screen', () => {
    // claude's AskUserQuestion box reports awaitingKind 'permission'.
    expect(resolve('claude', { kind: 'question', option: 2 }, CLAUDE_QUESTION, 'permission')).toEqual({ ok: true, keys: '2' })
    expect(resolve('claude', { kind: 'question', option: 2 }, CLAUDE_QUESTION, 'question')).toEqual({ ok: true, keys: '2' })
    expect(resolve('claude', { kind: 'question', option: 5 }, CLAUDE_QUESTION, 'permission')).toMatchObject({ ok: false })
    expect(resolve('claude', { kind: 'question', option: 1 }, 'no menu here', 'question')).toMatchObject({ ok: false })
  })

  it('refuses when the screen does not show the menu the answer assumes', () => {
    expect(resolve('claude', { kind: 'permission', choice: 'allow' }, 'plain output')).toMatchObject({ ok: false })
    expect(resolve('claude', { kind: 'permission', choice: 'allow' }, CLAUDE_QUESTION)).toMatchObject({ ok: false })
    expect(resolve('claude', { kind: 'permission', choice: 'deny' }, CLAUDE_QUESTION)).toMatchObject({ ok: false })
  })

  it('never presses a permanent-allow option, whichever way it is asked for', () => {
    expect(resolve('claude', { kind: 'question', option: 2 }, CLAUDE_PERMISSION, 'permission')).toMatchObject({ ok: false })
    expect(resolve('codex', { kind: 'question', option: 2 }, CODEX_PERMISSION, 'permission')).toMatchObject({ ok: false })
    const permanentFirst = ['Allow this?', "❯ 1. Yes, and don't ask again this session", '  2. No'].join('\n')
    expect(resolve('claude', { kind: 'permission', choice: 'allow' }, permanentFirst)).toMatchObject({ ok: false })
    expect(resolve('claude', { kind: 'question', option: 1 }, permanentFirst, 'permission')).toMatchObject({ ok: false })
    // The safe choices on the same menus still work.
    expect(resolve('claude', { kind: 'question', option: 1 }, CLAUDE_PERMISSION, 'permission')).toEqual({ ok: true, keys: '1' })
    expect(resolve('claude', { kind: 'permission', choice: 'deny' }, permanentFirst)).toEqual({ ok: true, keys: '\x1b' })
  })
})

describe('isPermanentAllow', () => {
  it('matches the claude / codex permanent wording and nothing one-off', () => {
    for (const text of [
      "Yes, and don't ask again this session",
      "Yes, and don’t ask again for this command in this session",
      'Yes, allow all edits during this session (shift+tab)',
      'Always allow Bash(rm:*)',
      'Auto-accept edits',
      // claude 2.1.303's Bash box: switching the pane to auto mode approves
      // every later prompt, so it is as permanent as "always allow".
      'Yes, and switch to auto mode · auto mode handles these prompts for',
      '是，並且不再詢問',
      '一律允許',
      '自動核准',
      'はい、今後は確認しない',
    ]) {
      expect(isPermanentAllow(text), text).toBe(true)
    }
    for (const text of ['Yes', 'Yes, just this once', 'No, and tell Claude what to do differently (esc)', 'Keep it']) {
      expect(isPermanentAllow(text), text).toBe(false)
    }
  })
})

describe('resolveAnswerKeys with the prompt the caller checked', () => {
  const SAFE = ['Bash command', '  npm test', 'Do you want to proceed?', '❯ 1. Yes', '  2. No (esc)'].join('\n')
  const RISKY = ['Bash command', '  rm -rf ~', 'Do you want to proceed?', '❯ 1. Yes', '  2. No (esc)'].join('\n')
  const checked = (screen: string) => ({ prompt: awaitingPromptText(screen), options: parseMenuOptions(screen) })
  const press = (screen: string, expected: { prompt: string; options: string[] }) =>
    resolveAnswerKeys({
      agentKey: 'claude', displayStatus: 'awaiting', awaitingKind: 'permission', screen,
      answer: { kind: 'permission', choice: 'allow' }, expected,
    })

  it('presses the keys while the checked prompt is still on screen', () => {
    expect(press(SAFE, checked(SAFE))).toEqual({ ok: true, keys: '1' })
  })

  it('ignores a re-wrap that only moves whitespace', () => {
    const rewrapped = { prompt: checked(SAFE).prompt.replace(/\n/g, '\n  '), options: checked(SAFE).options }
    expect(press(SAFE, rewrapped)).toEqual({ ok: true, keys: '1' })
  })

  it('refuses when a different prompt replaced the checked one', () => {
    const result = press(RISKY, checked(SAFE))
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ errorCode: 'prompt-changed' })
  })

  it('refuses when only the menu changed', () => {
    const other = ['Bash command', '  npm test', 'Do you want to proceed?', '❯ 1. Yes', '  2. Yes, always', '  3. No (esc)'].join('\n')
    expect(press(other, checked(SAFE))).toMatchObject({ ok: false, errorCode: 'prompt-changed' })
  })
})

// Claude Code 2.1.304's AskUserQuestion box, as its components render it: a
// single-select menu ends in the "Other" text row ("Type something.") with
// "Chat about this" under a divider; a multi-select menu boxes every row,
// its "Other" row included, and puts a Submit (or Next) button after them.
const DOWN = '\x1b[B'
const UP = '\x1b[A'

const CLAUDE_SINGLE_WITH_OTHER = [
  'Which approach?',
  '❯ 1. Merge them into one state',
  '  2. Keep them separate',
  '  3. Type something.',
  '────────────────',
  '  4. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

const claudeMulti = (focus: number, checked: number[] = []) =>
  [
    '←  ☐ Checks  ✔ Submit  →',
    'Which checks should run?',
    ...['Lint', 'Unit tests', 'Type something'].map(
      (label, i) => `${i === focus ? '❯' : ' '} ${i + 1}. [${checked.includes(i + 1) ? '✔' : ' '}] ${label}`,
    ),
    '     Submit',
    '────────────────',
    '  4. Chat about this',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n')

describe('resolveAnswerKeys for free text and multi-select (claude)', () => {
  it('moves to the "Other" row, types the text and submits it, one step at a time', () => {
    const r = resolve('claude', { kind: 'question', option: 3, text: 'keep both' }, CLAUDE_SINGLE_WITH_OTHER, 'permission')
    expect(r).toEqual({ ok: true, keys: `${DOWN}${DOWN}keep both\r`, steps: [DOWN, DOWN, 'keep both', '\r'] })
  })

  it('types only printable text: control characters never reach the pane', () => {
    const r = resolve('claude', { kind: 'question', option: 3, text: 'a\x1b[2J\r\nb\x03' }, CLAUDE_SINGLE_WITH_OTHER, 'permission')
    expect(r.ok && r.steps).toEqual([DOWN, DOWN, 'a [2J b', '\r'])
  })

  it('refuses text for a row that takes none, and an empty text', () => {
    expect(resolve('claude', { kind: 'question', option: 2, text: 'x' }, CLAUDE_SINGLE_WITH_OTHER, 'permission').ok).toBe(false)
    expect(resolve('claude', { kind: 'question', option: 3, text: ' \x1b ' }, CLAUDE_SINGLE_WITH_OTHER, 'permission').ok).toBe(false)
  })

  it('toggles the picked boxes by number, then moves past the last row to Submit', () => {
    const r = resolve('claude', { kind: 'multi', options: [1, 2] }, claudeMulti(0), 'permission')
    expect(r.ok && r.steps).toEqual(['1', '2', DOWN, DOWN, DOWN, '\r'])
  })

  it('toggles only the boxes whose state differs from the answer', () => {
    const r = resolve('claude', { kind: 'multi', options: [2] }, claudeMulti(1, [1, 2]), 'permission')
    expect(r.ok && r.steps).toEqual(['1', DOWN, DOWN, '\r'])
  })

  it('types the free text into the "Other" row, which picks it, then submits', () => {
    const r = resolve('claude', { kind: 'multi', options: [1, 3], text: 'docs' }, claudeMulti(0), 'permission')
    expect(r.ok && r.steps).toEqual(['1', DOWN, DOWN, 'docs', DOWN, '\r'])
  })

  it('leaves the text row before pressing digits, which would be typed there', () => {
    const r = resolve('claude', { kind: 'multi', options: [1] }, claudeMulti(2), 'permission')
    expect(r.ok && r.steps).toEqual([UP, '1', DOWN, DOWN, '\r'])
  })

  it('refuses a row that is not a box, text without the "Other" row, and a permanent allow', () => {
    expect(resolve('claude', { kind: 'multi', options: [1, 4] }, claudeMulti(0), 'permission').ok).toBe(false)
    expect(resolve('claude', { kind: 'multi', options: [1], text: 'x' }, claudeMulti(0), 'permission').ok).toBe(false)
    expect(resolve('claude', { kind: 'multi', options: [3] }, claudeMulti(0), 'permission').ok).toBe(false)
    const always = claudeMulti(0).replace('Unit tests', 'Always run every check')
    expect(resolve('claude', { kind: 'multi', options: [2] }, always, 'permission').ok).toBe(false)
  })

  it('refuses free text and multi-select for a vendor it has not been mapped for', () => {
    expect(resolve('codex', { kind: 'multi', options: [1] }, claudeMulti(0), 'permission').ok).toBe(false)
    expect(resolve('codex', { kind: 'question', option: 3, text: 'x' }, CLAUDE_SINGLE_WITH_OTHER, 'permission').ok).toBe(false)
  })

  it('refuses when no row on screen has the cursor', () => {
    expect(resolve('claude', { kind: 'multi', options: [1] }, claudeMulti(-1), 'permission').ok).toBe(false)
  })
})
