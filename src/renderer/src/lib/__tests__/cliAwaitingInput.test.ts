import { describe, it, expect } from 'vitest'
import {
  awaitingClearsOnMiss,
  notificationMeansAwaiting,
  notificationEndsAwaiting,
  hasAwaitingPattern,
  matchAwaitingInput,
  textEndsOnQuestion,
  questionActionFor,
  QUESTION_DETAIL,
} from '../cliAwaitingInput'

// AWAITING means "the CLI stopped and cannot continue until the user answers".
// Getting that wrong in either direction is costly: a missed prompt looks
// exactly like a finished turn, and a false one parks a free pane out of
// inter-CLI messaging and MCP dispatch.

describe('notificationMeansAwaiting — Claude hook types', () => {
  it('is true only for the types that block the turn', () => {
    expect(notificationMeansAwaiting('permission_prompt')).toBe(true)
    expect(notificationMeansAwaiting('elicitation_dialog')).toBe(true)
    expect(notificationMeansAwaiting('agent_needs_input')).toBe(true)
  })

  it('covers the blocking types the docs page omits', () => {
    // Read off the 2.1.233 binary, which carries eleven types to the docs'
    // nine. Both of these block on the user exactly like the documented
    // variants they shadow, and missing them reported a stuck pane as idle.
    expect(notificationMeansAwaiting('worker_permission_prompt')).toBe(true)
    expect(notificationMeansAwaiting('elicitation_url_dialog')).toBe(true)
  })

  it('is false for idle_prompt', () => {
    // Regression: idle_prompt fires every time a turn ends and Claude waits for
    // the next instruction — the pane is genuinely idle. Accepting it would
    // light AWAITING after every single turn.
    expect(notificationMeansAwaiting('idle_prompt')).toBe(false)
  })

  it('is false for the informational types', () => {
    // These all report something that already finished.
    expect(notificationMeansAwaiting('auth_success')).toBe(false)
    expect(notificationMeansAwaiting('elicitation_complete')).toBe(false)
    expect(notificationMeansAwaiting('elicitation_response')).toBe(false)
    expect(notificationMeansAwaiting('agent_completed')).toBe(false)
  })

  it('is false when the field is missing or unrecognized', () => {
    // Fail-closed: the field is absent on Claude builds that predate it, and a
    // permissive default would treat every idle_prompt as awaiting.
    expect(notificationMeansAwaiting(undefined)).toBe(false)
    expect(notificationMeansAwaiting('')).toBe(false)
    expect(notificationMeansAwaiting('some_future_type')).toBe(false)
  })
})

describe('notificationEndsAwaiting — releasing a hook-set wait', () => {
  // A hook fires once and cannot re-check itself, so without an explicit
  // release the waits that end with no CLI output — an MCP form submitted, a
  // background session finishing, a turn ending on an unanswered prompt —
  // would hold AWAITING forever and keep the pane out of dispatch.
  it('is true for the types that mean the wait is over', () => {
    expect(notificationEndsAwaiting('idle_prompt')).toBe(true)
    expect(notificationEndsAwaiting('agent_idle')).toBe(true)
    expect(notificationEndsAwaiting('elicitation_complete')).toBe(true)
    expect(notificationEndsAwaiting('elicitation_response')).toBe(true)
    expect(notificationEndsAwaiting('agent_completed')).toBe(true)
  })

  it('is false for the types that START a wait', () => {
    expect(notificationEndsAwaiting('permission_prompt')).toBe(false)
    expect(notificationEndsAwaiting('elicitation_dialog')).toBe(false)
    expect(notificationEndsAwaiting('agent_needs_input')).toBe(false)
  })

  it('is false for unknown or missing types', () => {
    // Whitelist, not the negation of the awaiting set: clearing on unknown
    // values would let a future notification type silently cancel a real
    // permission prompt.
    expect(notificationEndsAwaiting(undefined)).toBe(false)
    expect(notificationEndsAwaiting('')).toBe(false)
    expect(notificationEndsAwaiting('some_future_type')).toBe(false)
  })

  it('never claims a type both starts and ends a wait', () => {
    for (const t of [
      'permission_prompt', 'elicitation_dialog', 'agent_needs_input',
      'idle_prompt', 'agent_idle', 'elicitation_complete',
      'elicitation_response', 'agent_completed', 'auth_success',
    ]) {
      expect(notificationMeansAwaiting(t) && notificationEndsAwaiting(t)).toBe(false)
    }
  })
})

// The strings below are verbatim captures from each CLI, not paraphrases —
// they are what the pattern has to survive.

describe('matchAwaitingInput — aider (line-mode prompts)', () => {
  it('matches every confirmation shape aider asks', () => {
    const prompts = [
      "Add file to the chat? (Y)es/(N)o/(A)ll/(S)kip all/(D)on't ask again [Yes]:",
      "Run shell command? (Y)es/(N)o/(S)kip all/(D)on't ask again [Yes]:",
      'Allow edits to file that has not been added to the chat? (Y)es/(N)o [Yes]:',
      'Create new file? (Y)es/(N)o [Yes]:',
    ]
    for (const prompt of prompts) {
      expect(matchAwaitingInput('aider', `some earlier output\n${prompt}`)).toBe(true)
    }
  })

  it('stops matching once the answer scrolls the prompt off the tail', () => {
    // Aider is line-mode: the answered question stays in the scrollback. What
    // ends AWAITING is the prompt no longer being the last thing on screen.
    const answered =
      "Add file to the chat? (Y)es/(N)o/(A)ll/(S)kip all/(D)on't ask again [Yes]: y\n" +
      'Added main.py to the chat.'
    expect(matchAwaitingInput('aider', answered)).toBe(false)
  })

  it('does not match aider merely mentioning the choices mid-output', () => {
    expect(
      matchAwaitingInput('aider', 'I will ask (Y)es/(N)o [Yes]: before editing anything.'),
    ).toBe(false)
  })
})

describe('matchAwaitingInput — codex (full-screen dialog)', () => {
  it('matches all three approval dialogs', () => {
    const dialogs = [
      'Would you like to run the following command?',
      'Would you like to make the following edits?',
      'Would you like to grant these permissions?',
    ]
    for (const dialog of dialogs) {
      expect(matchAwaitingInput('codex', dialog)).toBe(true)
    }
  })

  it('matches on the option list alone, which every dialog shares', () => {
    // The question can scroll out of the 25 rendered lines when the dialog
    // carries a long diff; the options sit at the bottom and never do.
    const optionsOnly = [
      '  1. Yes, just this once',
      "  2. Yes, and don't ask again for this command in this session",
      '  3. No, and tell Codex what to do differently',
    ].join('\n')
    expect(matchAwaitingInput('codex', optionsOnly)).toBe(true)
  })

  it('survives the dialog being hard-wrapped by a narrow pane', () => {
    // The rendered text keeps the wrap; matching is whitespace-collapsed so a
    // phrase broken across two rows still matches.
    expect(matchAwaitingInput('codex', 'Would you like to\nrun the following\ncommand?')).toBe(true)
  })

  it('does not match ordinary codex output', () => {
    expect(matchAwaitingInput('codex', 'Running the following command: ls -la')).toBe(false)
  })
})

describe('matchAwaitingInput — claude (hook plus screen)', () => {
  // claude reads BOTH: the hook is authoritative but cannot see every box, and
  // the conversation log is structurally too late for the one it misses. The
  // AskUserQuestion sample below is a real capture — its record only reached
  // the log 5m16s after the box appeared, in the same batch as the event that
  // clears it, so the screen is the only signal that arrives while it matters.
  const QUESTION_BOX = [
    '  1. Merge them into one state',
    '  2. Keep them separate',
    '  3. Type something.',
    '  4. Chat about this',
    'Enter to select · Tab/Arrow keys to navigate· Esc to cancel',
  ].join('\n')

  const PERMISSION_BOX = [
    'Do you want to make this edit to useTerminal.ts?',
    '❯ 1. Yes',
    "  2. Yes, and don't ask again this session",
    '  3. No, and tell Claude what to do differently (esc)',
  ].join('\n')

  it('matches the AskUserQuestion box', () => {
    expect(hasAwaitingPattern('claude')).toBe(true)
    expect(matchAwaitingInput('claude', QUESTION_BOX)).toBe(true)
  })

  it('matches the permission box', () => {
    expect(matchAwaitingInput('claude', PERMISSION_BOX)).toBe(true)
  })

  it('matches the two-option permission box with the amend footer', () => {
    // The current box drops the "No, and tell Claude..." option; its only
    // furniture is the numbered No and the footer.
    const box = [
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
      '',
      'Esc to cancel · Tab to amend',
    ].join('\n')
    expect(matchAwaitingInput('claude', box)).toBe(true)
    // Blank rows below the box (a short conversation) do not hide it.
    expect(matchAwaitingInput('claude', `${box}\n\n\n`)).toBe(true)
  })

  it('matches the four-option Bash box from claude 2.1.303', () => {
    // Transcribed from a screenshot of a live pane in manual mode.
    const box = [
      ' Bash command',
      ' Tip: auto mode handles these prompts for you — choose "switch to auto',
      ' mode" below',
      ' Create empty permission test file in /tmp',
      ' ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' touch /tmp/navide-permission-test',
      ' ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and always allow access to /tmp from this project',
      '   3. Yes, and switch to auto mode · auto mode handles these prompts for',
      '      you',
      '   4. No',
      '',
      ' Esc to cancel · Tab to amend',
      '',
      '',
    ].join('\n')
    expect(matchAwaitingInput('claude', box)).toBe(true)
  })

  // A live box replaces the input box, so whatever is drawn below it is not an
  // idle prompt. These are the rows a real pane can paint under the footer.
  describe('with rows drawn below the box', () => {
    const STATUS_LINE = '  ~/git/navide · main · Opus 4.7 · 42% context'
    const BORDER = '╰──────────────────────────────────────╯'
    const FOOTER = 'Esc to cancel · Tab to amend'
    const permissionBox = [
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
      '',
      FOOTER,
    ]

    // A hint row walks the same branch as a statusLine, so it has no case.
    const below = [
      ['a custom statusLine', ['', STATUS_LINE]],
      ['a statusLine that draws a prompt glyph', ['', '  ~/navide ❯ main']],
      ['trailing border characters', [BORDER, '│']],
    ] as const

    it.each(below)('matches the permission box with %s below it', (_name, rows) => {
      expect(matchAwaitingInput('claude', [...permissionBox, ...rows].join('\n'))).toBe(true)
    })

    it.each(below)('matches the AskUserQuestion footer with %s below it', (_name, rows) => {
      expect(matchAwaitingInput('claude', [QUESTION_BOX, ...rows].join('\n'))).toBe(true)
    })

    it('does not match when the idle input prompt follows the anchor', () => {
      // The same words as prose above a live input box: the `❯` row is the
      // input box, so no dialog is up however much statusLine follows it.
      const rule = '────────────────────────────────────────'
      for (const anchor of [FOOTER, QUESTION_BOX.split('\n').pop()!]) {
        const screen = [anchor, '', rule, '❯ ', rule, STATUS_LINE].join('\n')
        expect(matchAwaitingInput('claude', screen)).toBe(false)
      }
    })

    it('does not match when the framed prompt of an older build follows the anchor', () => {
      const screen = [FOOTER, '╭──────────────────╮', '│ > Try "fix lint errors" │', '╰──────────────────╯', STATUS_LINE].join('\n')
      expect(matchAwaitingInput('claude', screen)).toBe(false)
    })

    it('does not count a full-width border row against the tail bound', () => {
      const wide = `╰${'─'.repeat(250)}╯`
      expect(matchAwaitingInput('claude', [...permissionBox, wide, STATUS_LINE].join('\n'))).toBe(true)
      expect(matchAwaitingInput('claude', [QUESTION_BOX, wide, STATUS_LINE].join('\n'))).toBe(true)
    })

    it('does not match when the tail outgrows its bound', () => {
      const screen = [FOOTER, '', 'x'.repeat(400)].join('\n')
      expect(matchAwaitingInput('claude', screen)).toBe(false)
    })
  })

  it('does not match the box quoted in conversation text above the idle prompt', () => {
    // A pane discussing the box shows its furniture as prose; the live box is
    // always the last thing on screen, the quoted one is followed by the input.
    const quoted = [
      '  The current box is `Do you want to proceed?` / `1. Yes` / `2. No`',
      '  with the footer Esc to cancel · Tab to amend.',
      "  The old one ended on '3. No, and tell Claude what to do differently (esc)',",
      '  and the picker on Enter to select · Tab to switch · Esc to cancel',
      '',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  ▸▸ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(matchAwaitingInput('claude', quoted)).toBe(false)
  })

  it('does not match prose that merely reads like a prompt', () => {
    // The anchors are the widget's own furniture, not the question text: a
    // sentence about selecting something must not park the pane.
    expect(matchAwaitingInput('claude', 'Enter to select the approach, then continue.')).toBe(false)
    expect(matchAwaitingInput('claude', 'Press Esc to cancel if this looks wrong.')).toBe(false)
    expect(matchAwaitingInput('claude', '> Try "how do I log an error?"')).toBe(false)
    expect(matchAwaitingInput('claude', 'Do you want to proceed? I can also 1. Yes, rewrite it.')).toBe(false)
    expect(matchAwaitingInput('claude', 'Use Tab to amend the commit message.')).toBe(false)
  })

  it('never clears on a miss, unlike a pattern-only vendor', () => {
    // The screen supplements claude's hook rather than replacing it — an MCP
    // elicitation paints no option box, so a non-match is not evidence the
    // wait ended. Clearing there would drop a real one.
    expect(awaitingClearsOnMiss('claude')).toBe(false)
    expect(awaitingClearsOnMiss('codex')).toBe(true)
    expect(awaitingClearsOnMiss('aider')).toBe(true)
  })
})

describe('matchAwaitingInput — antigravity (ask_question list)', () => {
  // Verbatim from a capture (agy 1.1.13, 2026-09-05). The separator is U+00B7
  // and the arrows U+2191/U+2193 — the pattern matches these bytes, so a
  // paraphrase here would prove nothing.
  const QUESTION_BOX = [
    'Question',
    '─────────────────────────────────────────────',
    'Question 1/1: 請問您希望推送到哪個分支？',
    '> 1. (Recommended) 將目前的 test 分支推送到雲端',
    '  2. 將目前進度同步並推送到雲端的 main 分支',
    '  3. Write-in...',
    '  ↑/↓ Navigate · enter Select · esc Skip',
  ].join('\n')

  it('matches the question box', () => {
    expect(hasAwaitingPattern('antigravity')).toBe(true)
    expect(matchAwaitingInput('antigravity', QUESTION_BOX)).toBe(true)
  })

  it('matches on the footer alone, for a screen tail that cut the header off', () => {
    expect(
      matchAwaitingInput('antigravity', '  ↑/↓ Navigate · enter Select · esc Skip'),
    ).toBe(true)
  })

  it('does not match the chrome antigravity repaints on every frame', () => {
    // These two are the whole reason the anchors are full phrases: `esc to
    // cancel` appeared 25,640 times across the captures and `? for shortcuts`
    // 3,628. A pattern loose enough to catch either pins every pane as waiting.
    const busy = '─────────────\n> \n─────────────\nesc to cancel        Gemini 3.8 Flash · medium'
    const idle = '─────────────\n> \n─────────────\n? for shortcuts      Gemini 3.8 Flash · medium'
    expect(matchAwaitingInput('antigravity', busy)).toBe(false)
    expect(matchAwaitingInput('antigravity', idle)).toBe(false)
  })

  it('does not match the other two footers that share "enter Select"', () => {
    // Slash-command completion and /model are the user driving the UI, not the
    // agent parked on them — and both keep the keystroke clock fresh anyway.
    expect(
      matchAwaitingInput('antigravity', '  ↑/↓ Navigate · enter Select · tab Complete'),
    ).toBe(false)
    expect(
      matchAwaitingInput('antigravity', 'Keyboard: ↑/↓ Navigate  enter Select  esc Go Back'),
    ).toBe(false)
  })

  it('does not match the tips it rotates through while working', () => {
    // 482 captures of this one, all mid-turn. It reads like a prompt and is not.
    expect(
      matchAwaitingInput(
        'antigravity',
        '└ Tip: When rejecting an edit, press tab to amend with feedback explaining why.',
      ),
    ).toBe(false)
  })

  it('does not match the agent writing about prompts', () => {
    expect(
      matchAwaitingInput('antigravity', '這個步驟會等使用者手動輸入 y/n 才繼續。'),
    ).toBe(false)
    expect(
      matchAwaitingInput('antigravity', '● Requested Permission: write_file(...) (ctrl+o to expand)'),
    ).toBe(false)
  })

  it('clears on a miss, having no hook to defer to', () => {
    expect(awaitingClearsOnMiss('antigravity')).toBe(true)
  })
})

describe('matchAwaitingInput — vendors without a spec', () => {
  it('never matches for an unknown agent key', () => {
    expect(hasAwaitingPattern('not-a-real-cli')).toBe(false)
    expect(matchAwaitingInput('not-a-real-cli', 'anything at all')).toBe(false)
  })
})

// QUESTION's text half. A turn that ends on "shall I go ahead?" is not idle,
// but nothing in the log says so — only the prose does.
describe('textEndsOnQuestion', () => {
  it('is true when the closing line ends on a question mark', () => {
    expect(textEndsOnQuestion('Done. Want me to commit this?')).toBe(true)
    expect(textEndsOnQuestion('全部修好了。要我接著發版嗎？')).toBe(true)
  })

  it('accepts the full-width question mark on its own', () => {
    expect(textEndsOnQuestion('要選哪一個？')).toBe(true)
  })

  it('is false for a statement', () => {
    expect(textEndsOnQuestion('All 3937 tests pass.')).toBe(false)
    expect(textEndsOnQuestion('已經全部修好了。')).toBe(false)
  })

  it('judges the LAST line, not the whole turn', () => {
    // The event carries the entire assistant message. A rhetorical "?" in the
    // body must not light the badge on a turn that asks nothing at the end.
    expect(textEndsOnQuestion('So why did it fail?\nBecause the lock was held.')).toBe(false)
    // ...and a question at the end still counts however long the body is.
    expect(textEndsOnQuestion('Line one.\nLine two.\nShould I proceed?')).toBe(true)
  })

  it('sees through trailing blank lines', () => {
    expect(textEndsOnQuestion('Ready to go?\n\n  \n')).toBe(true)
  })

  it('sees through markdown emphasis and closing brackets', () => {
    expect(textEndsOnQuestion('**Which one do you want?**')).toBe(true)
    expect(textEndsOnQuestion('- Ship it now?')).toBe(true)
    expect(textEndsOnQuestion('He asked "are we done?"')).toBe(true)
  })

  it('is false for empty text', () => {
    // Stop-hook / thinking-only turn_complete events carry no text at all.
    expect(textEndsOnQuestion('')).toBe(false)
    expect(textEndsOnQuestion('   \n\n')).toBe(false)
  })
})

// The seam where both halves of QUESTION meet. App.vue's agent.activity handler
// is a closure inside an SFC the suite cannot mount, so the rules live here and
// the handler is a two-line adapter over them — this describe block is what
// actually exercises the wiring rather than reading it.
describe('questionActionFor — activity event → QUESTION badge', () => {
  it('raises on the AskUserQuestion box (which never produces a turn_complete)', () => {
    expect(questionActionFor({ event_type: 'agent_active', detail: QUESTION_DETAIL })).toBe('raise')
  })

  it('raises on the named signal whichever event type a vendor attaches it to', () => {
    // Regression: the two vendors that emit assistant:question disagree about
    // the type. Claude's AskUserQuestion pauses a turn that continues, so its
    // reader calls it agent_active (cli_vendors/claude.py); antigravity treats
    // an ask_question step as the end of the turn and reports turn_complete
    // (cli_vendors/antigravity.py, pinned by test_antigravity_activity.py).
    // Reading the type first meant antigravity's event — which carries no text
    // — scored as "did not end on a question" and CLEARED the badge, so its one
    // reliable signal actively extinguished the state it should have raised.
    expect(
      questionActionFor({ event_type: 'turn_complete', detail: QUESTION_DETAIL, text: '' })
    ).toBe('raise')
  })

  it('lets the named signal beat the text of the same event', () => {
    // Should a vendor ever send both, the structured claim is the reliable one.
    expect(
      questionActionFor({
        event_type: 'turn_complete',
        detail: QUESTION_DETAIL,
        text: 'All done, nothing left.',
      })
    ).toBe('raise')
  })

  it('raises on a turn that ended on a question', () => {
    expect(
      questionActionFor({ event_type: 'turn_complete', text: 'Done. Want me to commit?' })
    ).toBe('raise')
  })

  it('clears on a turn that ended on anything else', () => {
    expect(questionActionFor({ event_type: 'turn_complete', text: 'All done.' })).toBe('clear')
  })

  it('clears on an empty-text turn_complete rather than inheriting a verdict', () => {
    // Stop-hook and thinking-only turns carry no text. Treating "no text" as a
    // question would strand the badge; carrying the last turn's answer forward
    // would report a question that was already answered.
    expect(questionActionFor({ event_type: 'turn_complete' })).toBe('clear')
    expect(questionActionFor({ event_type: 'turn_complete', text: '' })).toBe('clear')
  })

  it("clears on the answer coming back, in every vendor's spelling", () => {
    for (const detail of ['user', 'prompt', 'user_message']) {
      expect(questionActionFor({ event_type: 'agent_active', detail })).toBe('clear')
    }
  })

  it('leaves the badge alone for ordinary activity', () => {
    // The common case by far: tool calls and assistant chatter. Clearing here
    // would drop the badge the moment anything else happened in the pane —
    // and an AskUserQuestion box emits a plain `assistant` event alongside the
    // question one, so "clear on unknown" would cancel it immediately.
    expect(questionActionFor({ event_type: 'agent_active', detail: 'assistant' })).toBeNull()
    expect(questionActionFor({ event_type: 'agent_active', detail: 'tool_use' })).toBeNull()
    expect(questionActionFor({ event_type: 'agent_active', detail: 'hook:pre_tool_use' })).toBeNull()
    expect(questionActionFor({ event_type: 'agent_active' })).toBeNull()
  })

  it('ignores event types it has no opinion about', () => {
    expect(questionActionFor({ event_type: 'something_new' })).toBeNull()
    expect(questionActionFor({ event_type: 'something_new', detail: 'assistant' })).toBeNull()
    expect(questionActionFor({})).toBeNull()
  })

  it('still honours the named signal on an event type it does not recognise', () => {
    // Deliberately NOT fail-closed, and the assertion here used to say the
    // opposite. Being strict about the event type is exactly what silenced
    // antigravity: a vendor that names the situation has told us more than the
    // envelope it arrived in, and the next vendor to add this signal should not
    // have to also match a type this function happens to know about.
    expect(questionActionFor({ event_type: 'something_new', detail: QUESTION_DETAIL })).toBe(
      'raise'
    )
  })

  it('matches the detail string the claude reader actually emits', () => {
    // Cross-end contract: backend/agent_team_backend/cli_vendors/claude.py
    // writes this literal, and backend/tests/vendors/test_claude.py asserts it.
    expect(QUESTION_DETAIL).toBe('assistant:question')
  })
})
