import { describe, expect, it } from 'vitest'
import { leaveLimitMenuAndResume, LIMIT_MENU_DISMISS_KEY, screenShowsLimitMenu } from '../claudeLimitMenu'

// The real screen, as backend/tests/channels/test_manager.py records it.
const MENU = [
  "  ⎿  You've hit your limit · resets 12pm (Asia/Taipei)",
  '',
  ' What do you want to do?',
  '',
  ' ❯ 1. Stop and wait for limit to reset',
  '   2. Wait here, then continue automatically at Oct 16 at 12pm',
  '   3. Switch to usage credits',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')
const PROMPT = '╭────────╮\n│ >      │\n╰────────╯'

function fake(screens: string[], resumeOk = true) {
  const writes: string[] = []
  let i = 0
  let resumed = 0
  return {
    writes,
    resumed: () => resumed,
    deps: {
      read: () => screens[Math.min(i, screens.length - 1)],
      write: (d: string) => { writes.push(d); i++ },
      sleep: async () => { if (writes.length) i++ },
      resume: async () => { resumed++; return resumeOk },
      pollMs: 10, timeoutMs: 50, settleMs: 0,
    },
  }
}

describe('claudeLimitMenu', () => {
  it('recognises the limit menu and nothing else', () => {
    expect(screenShowsLimitMenu(MENU)).toBe(true)
    expect(screenShowsLimitMenu("You've hit your limit · resets 12pm (Asia/Taipei)")).toBe(false)
    expect(screenShowsLimitMenu(PROMPT)).toBe(false)
  })

  it('counts only the live menu at the bottom of the screen', () => {
    // The same words higher up (scrollback, an agent printing them) are not the menu.
    expect(screenShowsLimitMenu(`${MENU}\n\n> tell me about the limit menu\n${PROMPT}`)).toBe(false)
    // A different prompt with the same footer but no limit header is not it either.
    const permission = ' Do you want to proceed?\n ❯ 1. Stop and wait for limit to reset\n Enter to confirm · Esc to cancel'
    expect(screenShowsLimitMenu(permission)).toBe(false)
    expect(screenShowsLimitMenu(`${'x\n'.repeat(50)}${MENU}\n\n`)).toBe(true)
  })

  it('leaves with Esc, never a choice', () => {
    expect(LIMIT_MENU_DISMISS_KEY).toBe('\x1b')
  })

  it('dismisses the menu, then continues the task', async () => {
    const f = fake([MENU, PROMPT])
    expect(await leaveLimitMenuAndResume(f.deps)).toBe('resumed')
    expect(f.writes).toEqual(['\x1b'])
    expect(f.resumed()).toBe(1)
  })

  it('does nothing when the pane is not on the menu', async () => {
    const f = fake([PROMPT])
    expect(await leaveLimitMenuAndResume(f.deps)).toBe('not-on-menu')
    expect(f.writes).toEqual([])
    expect(f.resumed()).toBe(0)
  })

  it('never types the continue text while the menu is still up', async () => {
    const f = fake([MENU])
    expect(await leaveLimitMenuAndResume(f.deps)).toBe('menu-stuck')
    expect(f.writes).toEqual(['\x1b'])
    expect(f.resumed()).toBe(0)
  })

  it('only leaves the menu when no resume is wanted', async () => {
    const f = fake([MENU, PROMPT])
    expect(await leaveLimitMenuAndResume({ ...f.deps, resume: undefined })).toBe('dismissed')
    expect(f.resumed()).toBe(0)
  })

  it('reports a continue that could not go in', async () => {
    const f = fake([MENU, PROMPT], false)
    expect(await leaveLimitMenuAndResume(f.deps)).toBe('resume-failed')
  })
})
