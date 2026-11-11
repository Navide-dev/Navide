import { describe, expect, it, vi } from 'vitest'
import { clearUpdatePrompt, screenShowsUpdatePrompt, updatePromptState } from '../updatePrompt'

// Codex 0.166.0's startup menu as a 40-row pane renders it, captured on a real
// PTY with a stub version.json (latest 99.0.0) and a fake npm on PATH; only
// Esc was ever sent to it.
const CODEX_MENU = [
  '',
  '  Update available · 0.166.0 → 99.0.0',
  '  Release notes: https://github.com/openai/codex/releases/latest',
  '',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  ...Array(30).fill(''),
  '  enter continue · esc skip',
  '',
].join('\n')

// What Esc leaves: Codex's own sign-in screen in a fresh home.
const AFTER_ESC = [
  '  Welcome to Codex, OpenAI\'s command-line coding agent',
  '  Choose how you want to use Codex.',
  '› 1. Sign in with ChatGPT',
  '  2. Sign in with Device Code',
  '  Press enter to continue',
].join('\n')

const COMPOSER = [
  '› Ask Codex to do anything',
  '',
  '  ? for shortcuts                                     100% context left',
].join('\n')

describe('updatePromptState', () => {
  it('recognizes the codex update menu', () => {
    expect(updatePromptState('codex', CODEX_MENU)).toBe('known')
    expect(screenShowsUpdatePrompt('codex', CODEX_MENU)).toBe(true)
  })

  it('recognizes the menu wrapped across rows in a narrow pane', () => {
    const narrow = CODEX_MENU.replace('Update now (runs `npm install -g @openai/codex`)', 'Update now (runs `npm\n  install -g @openai/codex`)')
    expect(updatePromptState('codex', narrow)).toBe('known')
  })

  it('holds a changed wording as suspect instead of pressing anything', () => {
    const reworded = CODEX_MENU.replace('Skip until next version', 'Remind me later')
    expect(updatePromptState('codex', reworded)).toBe('suspect')
  })

  it('sees nothing on an ordinary screen', () => {
    expect(updatePromptState('codex', AFTER_ESC)).toBe('none')
    expect(updatePromptState('codex', COMPOSER)).toBe('none')
    expect(updatePromptState('codex', '')).toBe('none')
  })

  it('ignores a transcript that quotes the menu above the composer', () => {
    const quoted = `${CODEX_MENU.replace(/\n{3,}/g, '\n')}\n• That is Codex's update menu; press Esc to skip it.\n\n${COMPOSER}`
    expect(updatePromptState('codex', quoted)).toBe('none')
  })

  it('is never set for a vendor without an update prompt', () => {
    expect(updatePromptState('claude', CODEX_MENU)).toBe('none')
    expect(updatePromptState(undefined, CODEX_MENU)).toBe('none')
  })
})

function driver(screens: string[]) {
  let i = 0
  let t = 0
  const sent: string[] = []
  const records: Array<[string, string]> = []
  return {
    sent,
    records,
    deps: {
      agentKey: 'codex',
      readScreen: () => screens[Math.min(i, screens.length - 1)],
      send: vi.fn(async (keys: string) => {
        sent.push(keys)
        i++
      }),
      sleep: async (ms: number) => { t += ms },
      now: () => t,
      record: (code: string, message: string) => { records.push([code, message]) },
    },
  }
}

describe('clearUpdatePrompt', () => {
  it('does nothing when no menu is up', async () => {
    const d = driver([COMPOSER])
    expect(await clearUpdatePrompt(d.deps)).toBe('clear')
    expect(d.sent).toEqual([])
    expect(d.records).toEqual([])
  })

  it('skips the menu with Esc, never Enter, and records it', async () => {
    const d = driver([CODEX_MENU, COMPOSER])
    expect(await clearUpdatePrompt(d.deps)).toBe('skipped')
    expect(d.sent).toEqual(['\x1b'])
    expect(d.records.map(([code]) => code)).toEqual(['update-prompt.skipped'])
  })

  it('tries Esc twice, then holds the pane', async () => {
    const d = driver([CODEX_MENU])
    expect(await clearUpdatePrompt(d.deps)).toBe('blocked')
    expect(d.sent).toEqual(['\x1b', '\x1b'])
    expect(d.records.map(([code]) => code)).toEqual(['update-prompt.blocked'])
  })

  it('sends no key at all to a menu it does not recognize', async () => {
    const d = driver([CODEX_MENU.replace('Skip until next version', 'Remind me later')])
    expect(await clearUpdatePrompt(d.deps)).toBe('blocked')
    expect(d.sent).toEqual([])
    expect(d.records.map(([code]) => code)).toEqual(['update-prompt.blocked'])
  })

  it('never sends Enter in any outcome', async () => {
    for (const screens of [[CODEX_MENU, COMPOSER], [CODEX_MENU], [COMPOSER]]) {
      const d = driver(screens)
      await clearUpdatePrompt(d.deps)
      expect(d.sent.some((keys) => keys.includes('\r') || keys.includes('\n'))).toBe(false)
    }
  })
})
