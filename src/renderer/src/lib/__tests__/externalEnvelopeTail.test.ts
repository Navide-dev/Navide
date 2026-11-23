/**
 * An envelope typed behind one the CLI put back into its input box must still
 * be recognised as typed.
 *
 * Linux VM 0.2.44 (08:25): a cli_interrupt landed before the model printed
 * anything, so Claude Code cancelled the turn and restored the LONGTURN prompt
 * to the composer. The next message, a PING from the same external MCP caller,
 * was typed after it. Both envelopes ended in the same no-reply hint, so the
 * composer's visible bottom rows were identical before and after the typing,
 * and the redraw changed only the "↑ N more" counter. The echo watch never saw
 * a new tail and held the message on pty-blocked until the pane was closed.
 */
import { describe, expect, it } from 'vitest'

import { renderEnvelope } from '../agentMessaging'
import { echoEvidenceSince, normalizeForMatch, screenShowsNewTail, TAIL_MATCH_LEN } from '../injectEcho'
import { awaitEcho } from '../ptyInputBlock'

/** The composer as a 32-column Claude Code draws it: only its last `rows`
 *  wrapped rows are visible under the "↑ N more" line. */
function composerScreen(text: string, rows = 4): string {
  const wrapped: string[] = []
  for (const line of text.split('\n')) {
    const chars = [...line]
    for (let i = 0; i < chars.length; i += 15) wrapped.push(chars.slice(i, i + 15).join(''))
  }
  const hidden = wrapped.length - rows
  return [
    '✻ Churned for 6s · done 8:20 AM',
    `─── ↑ ${hidden} more ───────────────────`,
    ...wrapped.slice(-rows),
    '────────────────────────────────',
    '⏵⏵ bypass permissions on',
  ].join('\n')
}

describe('an external envelope typed behind a restored prompt', () => {
  const restored = renderEnvelope('an external client', 'LONGTURN: start the long task', {
    correlationId: 'external:mcp:e1013ad0f09c0fc2',
    noReplyRoute: true,
  })
  const ping = renderEnvelope('an external client', 'PING-faa5da20 reply with ok', {
    correlationId: 'external:mcp:9ac79b4a44f1bc44',
    noReplyRoute: true,
  })
  const tail = normalizeForMatch(ping).slice(-TAIL_MATCH_LEN)
  const before = composerScreen(restored)
  const after = composerScreen(`${restored}${ping}`)
  // All the PTY printed for the typing: the counter's redraw.
  const stream = 'earlier output…11 more'
  const grownBy = '11 more'.length

  const echoed = () =>
    echoEvidenceSince(stream, tail, grownBy, normalizeForMatch(ping).length)
      ?? (screenShowsNewTail(before, after, tail) ? 'tail' : null)

  it('ends each envelope differently', () => {
    expect(normalizeForMatch(restored).slice(-TAIL_MATCH_LEN)).not.toBe(tail)
  })

  it('sees the second envelope land instead of holding it on pty-blocked', async () => {
    let clock = 0
    let polls = 0
    const holds: boolean[] = []
    const result = await awaitEcho({
      echoed,
      outputBytes: () => stream.length,
      // The messaging path waits without a cap; stop the test after 40 polls.
      aborted: () => ++polls > 40,
      onHold: (held) => holds.push(held),
      sleep: async (ms) => { clock += ms },
      now: () => clock,
      roundMs: 1_000,
      maxSilentRounds: null,
    })
    expect(result.outcome).toBe('ready')
    expect(holds).not.toContain(true)
  })
})
