import { describe, expect, it } from 'vitest'

import {
  composerHoldsPayload, echoEvidence, echoLanded, echoTimeoutFor, growthNeededFor, injectionVerified,
  composerFromScreen, framedComposerHolds, kickoffVerified, normalizeForMatch, submitBaseline, submitEvidence,
  submitLanded, TAIL_MATCH_LEN
} from '../injectEcho'

describe('normalizeForMatch', () => {
  it('drops whitespace so a re-indented echo still matches', () => {
    expect(normalizeForMatch('hello   world\n  again')).toBe('helloworldagain')
  })

  it("drops the TUI's frame characters", () => {
    // A wrapped line puts the frame between our own characters; leaving it in
    // breaks an otherwise exact match.
    expect(normalizeForMatch('db/schema.sql │\n│ 裡定義了')).toBe('db/schema.sql裡定義了')
  })
})

describe('growthNeededFor', () => {
  it('caps at the flat minimum for long payloads', () => {
    expect(growthNeededFor(500)).toBe(40)
  })

  it('scales down for a short prompt that can never grow 40 chars', () => {
    expect(growthNeededFor(38)).toBe(19)
  })

  it('keeps a floor that noise cannot reach', () => {
    expect(growthNeededFor(4)).toBe(8)
  })
})

describe('echoLanded', () => {
  const text = '請只用一句話回答，不要使用任何工具：db/schema.sql 裡定義了哪些資料表？'
  const normalized = normalizeForMatch(text)
  const tail = normalized.slice(-TAIL_MATCH_LEN)

  it('matches a wrapped echo that the TUI framed mid-sentence', () => {
    // The exact shape that caused a duplicate injection: our prompt wrapped,
    // with the frame drawn at the break.
    const buffer = '❯ 請只用一句話回答，不要使用任何工具：db/schema.sql │\n│   裡定義了哪些資料表？'

    expect(echoLanded(buffer, tail, 5, normalized.length)).toBe(true)
  })

  it('accepts growth alone when the tail cannot be matched', () => {
    expect(echoLanded('[Pasted text +12 lines]', tail, 25, normalized.length)).toBe(true)
  })

  it('rejects an empty echo with no growth — nothing landed', () => {
    expect(echoLanded('❯ ', tail, 0, normalized.length)).toBe(false)
  })

  it('a short prompt no longer needs 40 chars of growth', () => {
    const short = normalizeForMatch('回答 A 或 B')

    expect(echoLanded('unrelated', 'nomatch', 10, short.length)).toBe(true)
  })
})

describe('submitLanded', () => {
  const text = '請只用一句話回答，不要使用任何工具：db/schema.sql 裡定義了哪些資料表？'
  const tail = normalizeForMatch(text).slice(-TAIL_MATCH_LEN)

  it('reports unsubmitted while the composer still holds our tail', () => {
    // The antigravity failure: its spinner repaints the buffer non-stop, so
    // growth alone said "delivered" while the text sat in the input box.
    expect(submitLanded({
      tailWasOnScreen: true,
      tail,
      screen: `❯ ${text}\n  esc to clear`,
      grownBy: 4_000,
    })).toBe(false)
  })

  it('reports submitted once the tail leaves the composer', () => {
    expect(submitLanded({
      tailWasOnScreen: true,
      tail,
      screen: '✻ Thinking…\n❯ \n  esc to interrupt',
      grownBy: 12,
    })).toBe(true)
  })

  it('falls back to any reaction when the tail never echoed verbatim', () => {
    // A TUI that collapses a big paste into "[Pasted text +12 lines]" never
    // shows the tail, so there is nothing to watch for leaving.
    expect(submitLanded({
      tailWasOnScreen: false, tail, screen: '[Pasted text +12 lines]', grownBy: 1,
    })).toBe(true)
    expect(submitLanded({
      tailWasOnScreen: false, tail, screen: '[Pasted text +12 lines]', grownBy: 0,
    })).toBe(false)
  })

  it('falls back to growth when the screen cannot be read at all', () => {
    expect(submitLanded({ tailWasOnScreen: false, tail, screen: '', grownBy: 5 })).toBe(true)
  })
})

describe('echoTimeoutFor', () => {
  it('gives a short prompt enough time for a freshly booted CLI', () => {
    // At the old 2.5s floor a just-spawned pane resent a ~40 char prompt three
    // times before its first echo appeared.
    expect(echoTimeoutFor(40)).toBe(6_000)
  })

  it('caps long payloads at the ceiling', () => {
    expect(echoTimeoutFor(90_000)).toBe(8_000)
  })

  it('scales between the floor and the ceiling', () => {
    expect(echoTimeoutFor(42_000)).toBe(7_000)
  })
})

describe('echoLanded — a TUI that collapses a big paste', () => {
  // A long payload the composer will never echo verbatim: the tail cannot
  // match, and the summary the TUI draws instead is far shorter than the
  // growth a payload that size would normally produce.
  const tail = 'x'.repeat(40)
  const summary = '[Pasted text #1 +40 lines]'

  it('accepts the summary as evidence the paste arrived', () => {
    // 26 chars of growth against a 2000-char payload: both older signals read
    // "nothing landed", which resent the whole message — three copies of one
    // message ended up in antigravity's composer and the send reported failure
    // without ever pressing Enter.
    expect(echoLanded(`> ${summary}`, tail, summary.length, 2_000)).toBe(true)
  })

  it('still refuses when the terminal did not react at all', () => {
    // A summary already on screen from an earlier paste is not ours. Saying
    // "landed" here would press Enter on a composer holding someone else's
    // draft.
    expect(echoLanded(`> ${summary}`, tail, 0, 2_000)).toBe(false)
  })

  it('ignores a summary that scrolled out of the region that grew', () => {
    const stale = `> ${summary}` + ' '.repeat(400) + 'unrelated output'
    expect(echoLanded(stale, tail, 16, 2_000)).toBe(false)
  })

  it('leaves the verbatim-echo path alone', () => {
    expect(echoLanded(`> ${tail}`, tail, 0, 2_000)).toBe(true)
  })
})

describe('echoEvidence', () => {
  it('names the tail match, the strongest signal', () => {
    expect(echoEvidence('...please run the tests', 'runthetests', 0, 20)).toBe('tail')
  })

  it('names growth when only the buffer size says anything', () => {
    // No tail anywhere in the buffer; the only thing that changed is its size.
    expect(echoEvidence('unrelated repaint output', 'nowherenearthis', 400, 40)).toBe('growth')
  })

  it('names the collapsed-paste placeholder', () => {
    // Below the growth threshold, so the placeholder is the only signal left.
    expect(echoEvidence('[Pasted text #1 +40 lines]', 'nomatch', 5, 400)).toBe('placeholder')
  })

  // The summary is what a collapsed paste looks like, and a collapsed paste
  // grows the buffer too — the summary line plus the composer repaint clear
  // the 40-byte bar on their own. Answering 'growth' first made the one
  // payload-observing signal available in that case unreachable, and left the
  // kickoff verdict with nothing to tell "the CLI took our paste" apart from
  // "the CLI repainted".
  it('prefers the placeholder over growth when both would answer', () => {
    const buffer = 'a'.repeat(400) + '[Pasted text #1 +40 lines]'
    expect(echoEvidence(buffer, 'nomatch', 400, 4_000)).toBe('placeholder')
  })

  it('answers null when nothing landed', () => {
    expect(echoEvidence('quiet', 'nomatch', 0, 400)).toBeNull()
  })

  it('agrees with echoLanded on every one of those', () => {
    // The refactor must not have moved any decision, only exposed how it was made.
    const cases: [string, string, number, number][] = [
      ['...please run the tests', 'runthetests', 0, 20],
      ['unrelated repaint output', 'nowherenearthis', 400, 40],
      ['[Pasted text #1 +40 lines]', 'nomatch', 5, 400],
      ['a'.repeat(400) + '[Pasted text #1 +40 lines]', 'nomatch', 400, 4_000],
      ['quiet', 'nomatch', 0, 400],
    ]
    for (const c of cases) {
      expect(echoLanded(...c)).toBe(echoEvidence(...c) !== null)
    }
  })
})

describe('submitEvidence', () => {
  it('names tail-left when our text left the composer', () => {
    expect(
      submitEvidence({ tailWasOnScreen: true, tail: 'runthetests', screen: 'idle prompt', grownBy: 0 }),
    ).toBe('tail-left')
  })

  it('answers null while our text is still sitting there', () => {
    expect(
      submitEvidence({ tailWasOnScreen: true, tail: 'runthetests', screen: '> run the tests', grownBy: 99 }),
    ).toBeNull()
  })

  it('falls back to growth only when the tail never echoed', () => {
    expect(
      submitEvidence({ tailWasOnScreen: false, tail: 'x', screen: '', grownBy: 1 }),
    ).toBe('growth')
  })

  // Claude Code mid-turn: the message is enqueued, drawn just above the
  // composer, and the queue hint appears at the bottom. Our tail never leaves
  // the screen, so 'tail-left' can never fire — the hint is the proof.
  it('names queued when the tail stays but the queue hint appeared', () => {
    expect(
      submitEvidence({
        tailWasOnScreen: true,
        tail: 'runthetests',
        screen: '│ > run the tests\n│\n  Press up to edit queued messages',
        grownBy: 0,
      }),
    ).toBe('queued')
  })

  it('recognises the other wordings of the queue hint', () => {
    for (const hint of [
      'Press up to select a queued message to edit, or Enter to send them now',
      'Press up to select a queued message, then Enter to edit it',
    ]) {
      expect(
        submitEvidence({ tailWasOnScreen: true, tail: 'runthetests', screen: `> run the tests\n${hint}`, grownBy: 0 }),
      ).toBe('queued')
    }
  })

  // The hint alone is ambiguous when a message was ALREADY queued before this
  // Enter: it stays on screen whether or not this Enter took. The caller
  // snapshots the composer before pressing Enter (submitBaseline); with that
  // in hand 'queued' needs the hint to be NEW, or our tail to have LEFT the
  // input box.
  //
  // The screen keeps showing our tail either way — that is the whole reason
  // 'tail-left' cannot fire here: what a successful Enter does is redraw the
  // message just above the box. Only the box itself answers the question, and
  // composerFromScreen finds it by its frame rather than by counting rows.
  const tail = 'runthetests'
  const screenWith = (composer: string, above: string[]): string => [
    ...above,
    '╭────────────────────────────────╮',
    composer,
    '╰────────────────────────────────╯',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
    '  ? for shortcuts   Press up to edit queued messages',
  ].join('\n')
  const HOLDING = screenWith('│ > run the tests                │', ['> an earlier message'])
  const SUBMITTED = screenWith(
    '│ >                              │',
    ['> an earlier message', '> run the tests'],
  )

  it('refuses queued while the input box still holds our tail', () => {
    const baseline = submitBaseline({ screen: HOLDING, tail })
    expect(baseline).toEqual({ queuedHint: true, composerHeldTail: true })
    expect(
      submitEvidence({ tailWasOnScreen: true, tail, screen: HOLDING, grownBy: 12, baseline }),
    ).toBeNull()
  })

  // The failure the buffer-count guard could not see. An Ink TUI redraws its
  // whole bottom region on every spinner frame, so the raw stream gains copies
  // of the composer — our text still in it — several times a second, whether
  // or not the Enter took. Counting them said "delivered" for a message that
  // never left the box; the rendered box says what is actually there.
  it('is not fooled by a repaint that copies the unsubmitted composer', () => {
    const baseline = submitBaseline({ screen: HOLDING, tail })
    expect(
      submitEvidence({ tailWasOnScreen: true, tail, screen: HOLDING, grownBy: 4_000, baseline }),
    ).toBeNull()
  })

  it('accepts queued once our tail has left the input box', () => {
    const baseline = submitBaseline({ screen: HOLDING, tail })
    expect(
      submitEvidence({ tailWasOnScreen: true, tail, screen: SUBMITTED, grownBy: 40, baseline }),
    ).toBe('queued')
  })

  // The message redrawn above the box is what still matches on the wide screen.
  // Locating the composer by its frame is what keeps it out of the answer — a
  // row count would have to guess how tall the footer is today.
  it('does not count the copy redrawn above the box as the composer', () => {
    expect(composerFromScreen(SUBMITTED)).toBe('│ >                              │')
    expect(composerFromScreen(HOLDING)).toBe('│ > run the tests                │')
  })

  // A vendor that draws no box at all: the fallback rows are a guess, and when
  // the guess never held our text the honest answer is "not seen" — the sender
  // checks rather than being told a message still in the composer was sent.
  it('answers null when a frameless screen never showed our tail near the bottom', () => {
    const frameless = [
      '> run the tests',
      'working…',
      'still working…',
      '  Press up to edit queued messages',
    ].join('\n')
    const baseline = submitBaseline({ screen: frameless, tail })
    expect(baseline).toEqual({ queuedHint: true, composerHeldTail: false })
    expect(
      submitEvidence({ tailWasOnScreen: true, tail, screen: frameless, grownBy: 40, baseline }),
    ).toBeNull()
  })

  it('accepts queued when the hint was absent before this Enter', () => {
    const baseline = submitBaseline({ screen: screenWith('│ > run the tests │', []).replace(
      '  ? for shortcuts   Press up to edit queued messages', '  ? for shortcuts'), tail })
    expect(baseline).toEqual({ queuedHint: false, composerHeldTail: true })
    expect(
      submitEvidence({ tailWasOnScreen: true, tail, screen: HOLDING, grownBy: 0, baseline }),
    ).toBe('queued')
  })

  it('still answers null when the tail stays and no queue hint is shown', () => {
    expect(
      submitEvidence({ tailWasOnScreen: true, tail: 'runthetests', screen: '> run the tests\n? for shortcuts', grownBy: 99 }),
    ).toBeNull()
  })

  // The collapsed-paste case, as Claude Code 2.1.278 draws it: the payload is
  // never on screen, only "[Pasted text #65 +33 lines]" inside the box. A
  // focused pane repaints on its own, so growth alone said "delivered" while
  // the summary still sat in the box and Enter had not taken. The framed box
  // is what answers; growth only counts once the summary has left it.
  const pasteScreen = (composer: string): string => [
    '✻ Churned for 31s · done 11:56 AM',
    '            current: 2.1.278 · latest: 2.1.278',
    '────────────────────────────────────────────',
    composer,
    '────────────────────────────────────────────',
    '  paste again to expand',
  ].join('\n')
  const PASTE_HOLDING = pasteScreen('❯ [Pasted text #65 +33 lines]')
  const PASTE_GONE = pasteScreen('❯ ')

  it('refuses growth while the box still shows the collapsed-paste summary', () => {
    expect(
      submitEvidence({ tailWasOnScreen: false, tail: 'x', screen: PASTE_HOLDING, grownBy: 4_000 }),
    ).toBeNull()
  })

  it('accepts growth once the collapsed-paste summary has left the box', () => {
    expect(
      submitEvidence({ tailWasOnScreen: false, tail: 'x', screen: PASTE_GONE, grownBy: 40 }),
    ).toBe('growth')
  })

  // A summary echoed just above the box after a submit that took must not be
  // read as "still in the box": the frame keeps it out.
  it('ignores a collapsed-paste summary drawn above the framed box', () => {
    const screen = ['> [Pasted text #65 +33 lines]', PASTE_GONE].join('\n')
    expect(
      submitEvidence({ tailWasOnScreen: false, tail: 'x', screen, grownBy: 40 }),
    ).toBe('growth')
  })

  // Frameless: the bottom-rows guess could hold an echoed summary, so the
  // check does not apply and the growth fallback stays exactly as it was.
  it('leaves the growth fallback alone when there is no frame to locate the box by', () => {
    const frameless = '> [Pasted text #3 +12 lines]\nworking…'
    expect(
      submitEvidence({ tailWasOnScreen: false, tail: 'x', screen: frameless, grownBy: 40 }),
    ).toBe('growth')
  })

  it('agrees with submitLanded', () => {
    const cases = [
      { tailWasOnScreen: true, tail: 'abc', screen: 'gone', grownBy: 0 },
      { tailWasOnScreen: true, tail: 'abc', screen: 'abc', grownBy: 99 },
      { tailWasOnScreen: false, tail: 'x', screen: '', grownBy: 1 },
      { tailWasOnScreen: false, tail: 'x', screen: '', grownBy: 0 },
      { tailWasOnScreen: false, tail: 'x', screen: PASTE_HOLDING, grownBy: 99 },
      { tailWasOnScreen: false, tail: 'x', screen: PASTE_GONE, grownBy: 99 },
    ]
    for (const c of cases) expect(submitLanded(c)).toBe(submitEvidence(c) !== null)
  })
})

describe('injectionVerified', () => {
  it('is true only when both halves observed the payload itself', () => {
    expect(injectionVerified('tail', 'tail-left')).toBe(true)
    expect(injectionVerified('placeholder', 'tail-left')).toBe(true)
  })

  it('treats a queued submit as verified', () => {
    expect(injectionVerified('tail', 'queued')).toBe(true)
    expect(injectionVerified('growth', 'queued')).toBe(false)
  })

  it('is false when either half rests on growth alone', () => {
    // This is the freshly-spawned-pane case: a booting TUI repaints, so growth
    // is satisfied whatever happened to our bytes. Reporting that as success is
    // the bug this whole distinction exists to stop.
    expect(injectionVerified('growth', 'tail-left')).toBe(false)
    expect(injectionVerified('tail', 'growth')).toBe(false)
    expect(injectionVerified('growth', 'growth')).toBe(false)
  })

  it('is false when either half found nothing', () => {
    expect(injectionVerified(null, 'tail-left')).toBe(false)
    expect(injectionVerified('tail', null)).toBe(false)
  })
})

describe('composerHoldsPayload', () => {
  // A spawn kickoff judged 'unverified' is only retyped when the composer is
  // NOT holding the first copy — otherwise the second copy lands on top of it.
  it('holds when the normalized tail of our text is on screen', () => {
    expect(composerHoldsPayload('│ > run the tests\n│', 'runthetests')).toBe(true)
  })

  it('holds when the TUI collapsed the paste into its placeholder', () => {
    expect(composerHoldsPayload('> [Pasted text #1 +40 lines]', 'runthetests')).toBe(true)
  })

  it('reads a vendor\'s empty-composer hint as blank', () => {
    // Claude Code's idle composer shows a suggestion, not our text.
    expect(composerHoldsPayload('> Try "fix lint errors"\n? for shortcuts', 'runthetests')).toBe(false)
  })

  it('reads an empty screen as blank', () => {
    expect(composerHoldsPayload('', 'runthetests')).toBe(false)
  })

  it('never holds on an empty tail', () => {
    expect(composerHoldsPayload('anything at all', '')).toBe(false)
  })
})

describe('kickoffVerified', () => {
  // Claude Code collapses a multi-line paste to "[Pasted text #N +M lines]":
  // the tail is never on screen, so Enter can only ever be judged by growth
  // and the strict check is unreachable for every long kickoff. Past the
  // prompt-ready gate the pane paints nothing of its own, so growth is the
  // CLI reacting to us.
  it('is the strict verdict when that already passes', () => {
    expect(kickoffVerified('tail', 'tail-left', false)).toBe(true)
    expect(kickoffVerified('placeholder', 'queued', false)).toBe(true)
  })

  it('accepts a growth-only SUBMIT once the prompt-ready gate opened', () => {
    expect(kickoffVerified('placeholder', 'growth', true)).toBe(true)
    expect(kickoffVerified('tail', 'growth', true)).toBe(true)
  })

  // The gate is a snapshot — idle and quiet for 2s, once, before the paste.
  // It does not stop the pane painting during the 6-8s echo window that
  // follows, and 40 bytes is all growth needs there for any payload over 80
  // characters: an update notice, a hook line, or the SIGWINCH repaint the new
  // pane's own layout reflow triggers each clear it alone. A paste the CLI
  // refused would then be reported as `kickoff: "sent"`, and the caller that
  // trusts it never looks again.
  it('refuses a growth-only ECHO however open the gate is', () => {
    expect(kickoffVerified('growth', 'growth', true)).toBe(false)
    expect(kickoffVerified('growth', 'queued', true)).toBe(false)
  })

  it('keeps growth-only evidence unverified when the gate never opened', () => {
    expect(kickoffVerified('growth', 'growth', false)).toBe(false)
    expect(kickoffVerified('placeholder', 'growth', false)).toBe(false)
  })

  it('never vouches for a missing half, gate or not', () => {
    expect(kickoffVerified(null, 'growth', true)).toBe(false)
    expect(kickoffVerified('growth', null, true)).toBe(false)
    expect(kickoffVerified(null, null, true)).toBe(false)
  })
})

// The screens of the 10-07 16:16 kickoff, as Claude Code drew them: the
// collapsed paste sitting in the box unsent, and the empty box it would leave.
describe('framedComposerHolds', () => {
  const rule = '─'.repeat(60)
  const tail = normalizeForMatch('不可放進 code block）').slice(-TAIL_MATCH_LEN)
  const held = [rule, '❯\u00a0[Pasted text #1 +31 lines]', rule, 'paste again to expand'].join('\n')
  const empty = [rule, '❯\u00a0Try "create a util logging.py that..."', rule, 'ctrl+g to edit in Vim'].join('\n')

  it('sees the collapsed paste inside the box', () => {
    expect(framedComposerHolds(held, tail)).toBe(true)
  })

  it('sees our tail inside the box', () => {
    expect(framedComposerHolds([rule, `❯ ${'不可放進 code block）'}`, rule].join('\n'), tail)).toBe(true)
  })

  it('reads an empty box — vendor hint included — as released', () => {
    expect(framedComposerHolds(empty, tail)).toBe(false)
  })

  it('ignores a summary drawn above the box after a submit that took', () => {
    const submitted = ['> [Pasted text #1 +31 lines]', rule, '❯ ', rule].join('\n')
    expect(framedComposerHolds(submitted, tail)).toBe(false)
  })

  it('answers null without a frame, so nothing acts on a guess', () => {
    expect(framedComposerHolds('❯ [Pasted text #1 +31 lines]', tail)).toBeNull()
  })
})
