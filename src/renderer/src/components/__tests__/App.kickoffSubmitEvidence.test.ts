// @vitest-environment happy-dom
// 0.2.37, Linux arm64 VM (Claude Code 2.1.286, two 50x43 panes): both pipeline
// kickoffs failed attempt 1/3 and the worker's ended "reached the input box but
// never submitted", which failed the run although the worker had done the
// task. Nothing is shared between the two panes; each one misread its own
// screen, twice.
//
// 1. The echo. Claude Code skips cells that were already blank with a column
//    move, so the collapsed paste arrives as `[Pasted\x1b[11Gtext\x1b[16G#2…`
//    and the clean buffer holds "[Pastedtext#2+58lines]". The second paste of
//    a session draws no "paste again to expand" hint, so it grows the buffer
//    by 26 bytes, under the 40-byte growth bar. No signal matched, the round
//    ended with output, and the kickoff was cleared and pasted again.
// 2. The submit. The retyped kickoff showed its tail; after Enter the CLI
//    printed the submitted prompt above the box, so the tail never left the
//    bottom rows. Three Enters read as "still in the box" while the turn ran.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRedrawGuard, dropTuiNoise, stripAnsi } from '../../platform/terminal/lib/buffer'
import { echoEvidence, normalizeForMatch, TAIL_MATCH_LEN } from '../../lib/injectEcho'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`async function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end)
}

/** useTerminal's appendClean, chunk by chunk. */
function cleanOf(chunks: string[]): string {
  const guard = createRedrawGuard()
  let buf = ''
  for (const chunk of chunks) {
    const cleaned = dropTuiNoise(stripAnsi(chunk))
    if (!cleaned || guard.isReplay(cleaned)) continue
    buf += cleaned
    guard.accept(cleaned)
  }
  return buf
}

const kickoff = '[→ KICKOFF:STAGE-M1]\n' + 'work rule line\n'.repeat(56) + 'NAVIDE-WEBHOOK-DATA-f51a0eaf>>>'
const tail = normalizeForMatch(kickoff).slice(-TAIL_MATCH_LEN)

describe('a kickoff collapsed into a paste summary drawn with column moves', () => {
  // The bytes Claude Code writes for the summary, as recorded from 2.1.316
  // (the `[Pasted…lines]` run), with the VM's charset reset in front and no
  // hint row: the VM screen shows none for a session's second paste.
  const before = '\x1b[H\r\x1b[2C\x1b[37B\x1b[K\x1b[40;1H\x1b[38;29H'
  const paste = '\x1b(B\x0f\x1b[H\r\x1b[2C\x1b[37B[Pasted\x1b[11Gtext\x1b[16G#2\x1b[19G+58\x1b[23Glines]\x1b[7m \x1b[27m\x1b[K\x1b[40;1H\x1b[38;29H'

  it('reads as landed, not as a paste that never appeared', () => {
    const pre = cleanOf([before])
    const buf = cleanOf([before, paste])
    // Each column move between two words reads as the space it skips.
    expect(buf).toContain('[Pasted text #2 +58 lines]')
    const grown = buf.length - pre.length
    expect(echoEvidence(buf, tail, grown, normalizeForMatch(kickoff).length)).toBe('placeholder')
  })
})

describe('injectText — a submit the CLI took while our tail stays on screen', () => {
  it('counts a turn started since the first Enter as the submit', () => {
    const body = fn('injectText')
    expect(body).toContain('const watchTurn = shouldWatchTurn({ agentKey, midTurn: midTurnAtEnter })')
    expect(body).toContain('if (attempt === 1) firstEnterAt = enterAt')
    expect(body).toMatch(/if \(how === null && watchTurn && turnSince\(firstEnterAt\)\) \{\s*how = 'turn'\s*break/)
  })

  it('stops before the next Enter: the turn check sits inside the poll', () => {
    const body = fn('injectText')
    const poll = body.indexOf('how = submitEvidence({')
    const turn = body.indexOf('turnSince(firstEnterAt)')
    const resend = body.indexOf('— resending Enter')
    expect(poll).toBeGreaterThan(-1)
    expect(turn).toBeGreaterThan(poll)
    expect(turn).toBeLessThan(resend)
  })

  it('keeps a mid-turn pane out of it: a queued message starts no turn of its own', () => {
    const body = fn('injectText')
    expect(body.indexOf('const watchTurn')).toBeGreaterThan(body.indexOf('const midTurnAtEnter'))
    expect(body).toContain('watchTurn,')
  })
})
