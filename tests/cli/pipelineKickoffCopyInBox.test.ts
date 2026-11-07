// 0.2.37 Windows VM, load runs 3/3 failed: the host was busy and Navide's
// window was in the background. A pipeline kickoff landed in Claude Code's box
// as "[Pasted text #1 +60 lines]", the window's echo check missed it, and the
// retry pasted the kickoff again on top of it — the box held several copies
// and the run failed. A retry now reads the box first: a copy already there
// gets Enter (#448's heldCopy path), never a second paste.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runPipelineKickoff } from '../../src/renderer/src/lib/cliCoordination'
import { framedComposerHolds, normalizeForMatch, TAIL_MATCH_LEN } from '../../src/renderer/src/lib/injectEcho'

const WIDTH = 50
const row = (text: string) => `│ ${text.padEnd(WIDTH - 4)} │`
const box = (inside: string) => [`╭${'─'.repeat(WIDTH - 2)}╮`, row(inside), `╰${'─'.repeat(WIDTH - 2)}╯`].join('\n')
const KICKOFF = '[→ KICKOFF:STAGE-L2]\n' + 'work rule line\n'.repeat(58) + 'end of kickoff'
const tail = normalizeForMatch(KICKOFF).slice(-TAIL_MATCH_LEN)

describe('runPipelineKickoff — a retry reads the input box first', () => {
  it('a copy the echo check missed, already in the box, is submitted with Enter, not pasted again', async () => {
    // The first attempt's echo was missed; by the retry the screen caught up.
    let screen = box('>')
    const inject = vi.fn(async () => {
      screen = box('> [Pasted text #1 +60 lines]')
      return { injected: false, echo: null }
    })
    const submit = vi.fn(async () => true)
    const result = await runPipelineKickoff({
      inject,
      sleep: async () => {},
      paneAlive: () => true,
      copyInBox: { holds: () => framedComposerHolds(screen, tail) === true, submit },
    })
    expect(result).toEqual({ sent: true, cancelled: false })
    expect(inject).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledOnce()
  })

  it('a held copy whose Enter does not take is held, still never pasted again', async () => {
    const inject = vi.fn(async () => ({ injected: false, echo: null }))
    const onHeld = vi.fn()
    const result = await runPipelineKickoff({
      inject,
      sleep: async () => {},
      paneAlive: () => true,
      onHeld,
      copyInBox: { holds: () => true, submit: async () => false },
    })
    expect(result).toEqual({ sent: false, cancelled: false })
    expect(inject).toHaveBeenCalledTimes(1)
    expect(onHeld).toHaveBeenCalledOnce()
  })

  it('an empty box is retyped as before', async () => {
    const inject = vi.fn().mockResolvedValueOnce({ injected: false, echo: null }).mockResolvedValue({ injected: true, echo: 'tail' })
    const submit = vi.fn(async () => true)
    const result = await runPipelineKickoff({
      inject,
      sleep: async () => {},
      paneAlive: () => true,
      copyInBox: { holds: () => framedComposerHolds(box('>'), tail) === true, submit },
    })
    expect(result).toEqual({ sent: true, cancelled: false })
    expect(inject).toHaveBeenCalledTimes(2)
    expect(submit).not.toHaveBeenCalled()
  })

  it('a summary drawn above the box by an earlier submit is not a held copy', () => {
    const screen = ['> [Pasted text #1 +60 lines]', box('>')].join('\n')
    expect(framedComposerHolds(screen, tail)).toBe(false)
  })

  it('both pipeline kickoff call sites read the box before a retry', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
    expect(app.match(/copyInBox: kickoffCopyInBox\(pane\.id, /g)).toHaveLength(2)
  })
})
