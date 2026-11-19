// What Claude Code's input box holds before Navide types into it. The screens
// start from a real Claude Code 2.1.327 capture (fixtures/claude-2.1.327-*);
// the restored-prompt ones put text on its "❯" row the way Claude Code draws a
// prompt an interrupt put back: on the prompt row, wrapped rows indented by two.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { boxHoldsUserDraft, claudeComposerText, clearLeftoverPrompt } from '../claudeComposer'
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
const wrapped = withBox(['[Navide] from Navide指揮: check the CI run on integration/0.2.45 and', 'tell me which job failed first'])

describe('claudeComposerText', () => {
  it('reads an empty box as empty and a typed one as its text', () => {
    expect(claudeComposerText(empty)).toBe('')
    expect(claudeComposerText(typed)).toBe('/login')
  })

  it('reads a restored prompt, one row or wrapped over several', () => {
    expect(claudeComposerText(restored)).toBe(RESTORED)
    expect(claudeComposerText(wrapped)).toBe('[Navide] from Navide指揮: check the CI run on integration/0.2.45 and\ntell me which job failed first')
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

function harness(screens: string[], draft = '') {
  const writes: string[] = []
  const record = vi.fn()
  let read = 0
  return {
    writes,
    record,
    deps: {
      readScreen: () => screens[Math.min(read++, screens.length - 1)],
      draftText: () => draft,
      cols: 72,
      send: async (keys: string) => { writes.push(keys) },
      sleep: async () => {},
      record,
    },
  }
}

describe('clearLeftoverPrompt', () => {
  it('empties a restored prompt with Ctrl-U and says so', async () => {
    const h = harness([restored, empty])
    expect(await clearLeftoverPrompt(h.deps)).toBe('cleared')
    expect(h.writes).toEqual(composerClearKeys(RESTORED, 72))
    expect(h.record).toHaveBeenCalledOnce()
    expect(h.record.mock.calls[0][0]).toContain('Run the release dry run')
  })

  it('clears every row of a wrapped one', async () => {
    const h = harness([wrapped, empty])
    expect(await clearLeftoverPrompt(h.deps)).toBe('cleared')
    expect(h.writes).toEqual(composerClearKeys(claudeComposerText(wrapped) as string, 72))
  })

  it('never touches what the person at the keyboard is writing', async () => {
    const h = harness([restored], 'Run the release dry run and report back')
    expect(await clearLeftoverPrompt(h.deps)).toBe('user-draft')
    expect(h.writes).toEqual([])
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
    expect(h.record).not.toHaveBeenCalled()
  })
})
