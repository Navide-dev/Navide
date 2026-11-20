// What Claude Code's input box holds before Navide types into it. The screens
// start from a real Claude Code 2.1.327 capture (fixtures/claude-2.1.327-*);
// the restored-prompt ones put text on its "❯" row the way Claude Code draws a
// prompt an interrupt put back: on the prompt row, wrapped rows indented by two.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { boxHoldsUserDraft, claudeComposerText, clearLeftoverPrompt, composerOwner, restoredText, unwrapComposer } from '../claudeComposer'
import { composerClearKeys } from '../cliCoordination'

const screen = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const empty = screen('claude-2.1.327-prompt.txt')
const typed = screen('claude-2.1.327-prompt-login-typed.txt')
const loginMethod = screen('claude-2.1.327-first-run-login-method.txt')

function withBox(rows: string[]): string {
  const lines = empty.split('\n')
  const at = lines.findIndex((l) => l.startsWith('❯'))
  return [...lines.slice(0, at), `❯ ${rows[0]}`, ...rows.slice(1).map((r) => `  ${r}`), ...lines.slice(at + 1)].join('\n')
}

const RESTORED = 'Run the release dry run and report back'
const restored = withBox([RESTORED])
const wrapped = withBox(['[Navide MSG] from: Navide指揮 check the CI run on integration/0.2.45 and', 'tell me which job failed first'])

describe('claudeComposerText', () => {
  it('reads an empty box as empty and a typed one as its text', () => {
    expect(claudeComposerText(empty)).toBe('')
    expect(claudeComposerText(typed)).toBe('/login')
  })

  it('reads a restored prompt, one row or wrapped over several', () => {
    expect(claudeComposerText(restored)).toBe(RESTORED)
    expect(claudeComposerText(wrapped)).toBe('[Navide MSG] from: Navide指揮 check the CI run on integration/0.2.45 and\ntell me which job failed first')
  })

  it('is null without a framed box: a first-run menu, a box still being drawn, a blank screen', () => {
    expect(claudeComposerText(loginMethod)).toBeNull()
    expect(claudeComposerText(restored.split('\n').slice(0, 7).join('\n'))).toBeNull()
    expect(claudeComposerText('')).toBeNull()
  })

  it('reads the old boxed prompt without its side frame', () => {
    expect(claudeComposerText(['╭──────────────────╮', '│ > hello there    │', '╰──────────────────╯'].join('\n'))).toBe('hello there')
  })
})

describe('boxHoldsUserDraft', () => {
  it('is true when the tracked keystrokes are in the box', () => {
    expect(boxHoldsUserDraft('/login', '/login')).toBe(true)
    expect(boxHoldsUserDraft(claudeComposerText(wrapped), 'tell me which job failed first')).toBe(true)
  })

  it('is false for a box the person did not type, an empty box, or a one-key answer', () => {
    expect(boxHoldsUserDraft(RESTORED, '')).toBe(false)
    expect(boxHoldsUserDraft(RESTORED, 'something else')).toBe(false)
    expect(boxHoldsUserDraft('', '/login')).toBe(false)
    expect(boxHoldsUserDraft(null, '/login')).toBe(false)
    expect(boxHoldsUserDraft('1 run it', '1')).toBe(false)
  })
})

describe('composerOwner', () => {
  const none = { draft: '', navideTypedLast: false }
  it('tells the person\'s line, their paste, our envelope and a restored prompt apart', () => {
    expect(composerOwner(RESTORED, { ...none, draft: RESTORED })).toBe('user')
    expect(composerOwner('[Pasted text #1 +12 lines]', none)).toBe('user-paste')
    expect(composerOwner('[Pasted text #1 +12 lines]', { ...none, navideTypedLast: true })).toBe('navide')
    expect(composerOwner(claudeComposerText(wrapped) as string, none)).toBe('navide')
    expect(composerOwner(RESTORED, none)).toBe('restored')
    expect(composerOwner(`${RESTORED} [Pasted text #1 +3 lines]`, none)).toBe('restored')
  })
})

describe('unwrapComposer', () => {
  it('joins rows the box wrapped and keeps a typed line break', () => {
    const long = 'word '.repeat(13).trim() // 64 columns: wrapped at 68
    expect(unwrapComposer(`${long}\nnext part`, 72)).toBe(`${long} next part`)
    expect(unwrapComposer('first line\nsecond line', 72)).toBe('first line\nsecond line')
    expect(unwrapComposer(`${'中'.repeat(32)}\n文`, 72)).toBe(`${'中'.repeat(32)}文`)
  })
})

// A typed line break exactly where the row reaches the box's right edge (72
// columns, a 68-column box): on screen it looks like Claude Code's own wrap.
const EDGE_LINE = 'word '.repeat(13) + 'edge' // 69 chars, 68 once trimmed
const AT_EDGE = `${EDGE_LINE.trim()}\nsecond line`
const atEdge = withBox(AT_EDGE.split('\n'))

describe('restoredText', () => {
  it('gives back the submitted prompt when the box holds it, a break at the right edge included', () => {
    const box = claudeComposerText(atEdge) as string
    expect(unwrapComposer(box, 72)).not.toBe(AT_EDGE) // the screen alone cannot tell
    expect(restoredText(box, 72, AT_EDGE)).toBe(AT_EDGE)
  })

  it('keeps the original whitespace: tabs, blank lines, trailing spaces', () => {
    const original = 'first\n\n\tindented  \nlast '
    expect(restoredText('first\n\nindented\nlast', 72, original)).toBe(original)
  })

  it('rebuilds from the rows when the box holds something else', () => {
    const box = claudeComposerText(atEdge) as string
    for (const other of ['', '   ', 'a different prompt', `${AT_EDGE}\nand a queued one`]) {
      expect(restoredText(box, 72, other)).toBe(unwrapComposer(box, 72))
    }
  })

  it('never hands back one of Navide\'s own envelopes as the original', () => {
    const envelope = '[Navide MSG] from: Navide指揮 run the release dry run'
    expect(restoredText(envelope, 72, envelope)).toBe(unwrapComposer(envelope, 72))
  })
})

function harness(screens: string[], draft = '', navideTypedLast = false, lastSubmitted = '') {
  const writes: string[] = []
  const onCleared = vi.fn()
  let read = 0
  return {
    writes,
    onCleared,
    deps: {
      readScreen: () => screens[Math.min(read++, screens.length - 1)],
      draftText: () => draft,
      lastSubmitted: () => lastSubmitted,
      navideTypedLast: () => navideTypedLast,
      cols: 72,
      send: async (keys: string) => { writes.push(keys) },
      sleep: async () => {},
      onCleared,
    },
  }
}

describe('clearLeftoverPrompt', () => {
  it('empties a restored prompt with Ctrl-U and hands its text over as the person\'s', async () => {
    const h = harness([restored, empty])
    expect(await clearLeftoverPrompt(h.deps)).toBe('cleared')
    expect(h.writes).toEqual(composerClearKeys(RESTORED, 72))
    expect(h.onCleared).toHaveBeenCalledOnce()
    expect(h.onCleared.mock.calls[0][0]).toMatchObject({ text: RESTORED, owner: 'restored' })
    expect(h.onCleared.mock.calls[0][0].diagnostic).toContain('Run the release dry run')
  })

  it('hands over the prompt the person submitted when the box holds it, line break at the edge kept', async () => {
    const h = harness([atEdge, empty], '', false, AT_EDGE)
    expect(await clearLeftoverPrompt(h.deps)).toBe('cleared')
    expect(h.onCleared.mock.calls[0][0]).toMatchObject({ text: AT_EDGE, owner: 'restored' })
  })

  it('falls back to the rows when the last submitted prompt is not what the box holds', async () => {
    const h = harness([atEdge, empty], '', false, 'an older prompt')
    expect(await clearLeftoverPrompt(h.deps)).toBe('cleared')
    expect(h.onCleared.mock.calls[0][0].text).toBe(unwrapComposer(claudeComposerText(atEdge) as string, 72))
  })

  it('clears every row of a wrapped one; one of our envelopes is handed over as ours', async () => {
    const h = harness([wrapped, empty])
    expect(await clearLeftoverPrompt(h.deps)).toBe('cleared')
    expect(h.writes).toEqual(composerClearKeys(claudeComposerText(wrapped) as string, 72))
    expect(h.onCleared.mock.calls[0][0].owner).toBe('navide')
  })

  it('never touches what the person at the keyboard is writing, nor a paste of theirs', async () => {
    for (const [s, draft] of [[restored, RESTORED], [withBox(['[Pasted text #1 +12 lines]']), '']]) {
      const h = harness([s], draft)
      expect(await clearLeftoverPrompt(h.deps)).toBe('user-draft')
      expect(h.writes).toEqual([])
    }
  })

  it('does nothing on an empty box, another CLI, or a screen it cannot read', async () => {
    for (const s of [empty, loginMethod, '', '> codex prompt']) {
      const h = harness([s])
      expect(await clearLeftoverPrompt(h.deps)).toBe('none')
      expect(h.writes).toEqual([])
    }
  })

  it('stays quiet when Ctrl-U leaves the box as it was (a suggested prompt)', async () => {
    const h = harness([restored, restored])
    expect(await clearLeftoverPrompt(h.deps)).toBe('unchanged')
    expect(h.onCleared).not.toHaveBeenCalled()
  })
})
