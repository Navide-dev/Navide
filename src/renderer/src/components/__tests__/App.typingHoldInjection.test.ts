// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Two halves of "an injection must not run over what the user is typing":
// messagingHoldKey holds delivery while someone is at the keyboard, and
// injectText writes as a bracketed paste rather than as loose keystrokes.
// Both live in App.vue, which the suite cannot mount, so they are asserted
// against the source the way the other App.*.test.ts files do. The pieces that
// CAN be executed are unit-tested elsewhere: the pane signals in
// composables/__tests__/useTerminal.draftSignal.test.ts, the chunking in
// lib/__tests__/cliContext.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('messagingHoldKey — the typing hold', () => {
  it('holds on an unsent draft and on a recent keystroke', () => {
    const body = fn('messagingHoldKey')
    expect(body).toContain('hasDraft')
    expect(body).toContain('lastUserKeyAt')
    expect(body).toContain('TYPING_HOLD_MS')
    expect(body).toContain("return 'typing'")
  })

  it('reads both signals from the pane rather than re-deriving them', () => {
    // The composer's contents are not observable from App.vue — only the pane
    // that owns the terminal can say whether a line is sitting unsent.
    const body = fn('messagingHoldKey')
    expect(body).toContain('paneRefs[paneId]')
  })

  it('asks about the person before it asks about the CLI', () => {
    // A half-typed line is lost the same way whether the agent is mid-turn or
    // idle, so the human reason has to be reached first.
    const body = fn('messagingHoldKey')
    const typing = body.indexOf("return 'typing'")
    expect(typing).toBeGreaterThan(-1)
    expect(typing).toBeLessThan(body.indexOf("return 'mid-turn'"))
    expect(typing).toBeLessThan(body.indexOf("return 'settling'"))
  })

  it('keeps holding while Claude Code\'s box still shows the person\'s line or paste', () => {
    // injectText never clears the person's own line or a collapsed paste of
    // theirs (lib/claudeComposer.ts), so a message let through here would be
    // typed after it and sent with it — past the one-minute draft window too.
    const body = fn('messagingHoldKey')
    expect(body).toContain('composerOwner(box')
    expect(body).toMatch(/if \(owner === 'user' \|\| owner === 'user-paste'\) return 'typing'/)
  })

  it('keeps the grace window bounded so a glance cannot park a pane', () => {
    const declared = /const TYPING_HOLD_MS = (\d+)/.exec(appSource)
    expect(declared).not.toBeNull()
    const ms = Number(declared![1])
    expect(ms).toBeGreaterThanOrEqual(1000)
    expect(ms).toBeLessThanOrEqual(10_000)
  })

  it('has a localized reason in both shipped locales', () => {
    for (const locale of ['en-US', 'zh-TW']) {
      const json = JSON.parse(
        readFileSync(resolve(process.cwd(), `src/renderer/src/i18n/locales/${locale}.json`), 'utf8')
      ) as { msg: Record<string, string> }
      expect(json.msg['hold-typing']).toBeTruthy()
    }
  })
})

describe('injectText — bracketed paste', () => {
  it('wraps every injection the vendor can take it, not just multi-line ones', () => {
    const body = fn('injectText')
    expect(body).toContain('agentUsesBracketedPaste(')
    expect(body).toMatch(/const agentBracketed = preserveNewlines\s*\n?\s*\|\| \(agentUsesBracketedPaste/)
  })

  it('asks the pane whether mode 2004 is actually on before wrapping a single line', () => {
    // The vendor key says which CLI started the pane, not what is reading the
    // PTY now: a claude pane in `!` shell mode, fallen back to bash, or on a
    // raw login prompt would receive a literal "[200~".
    const body = fn('injectText')
    expect(body).toContain('paneRefs[paneId]?.isBracketedPasteActive?.() === true')
  })

  it('does not wrap when there is no pane to ask', () => {
    const body = fn('injectText')
    expect(body).toContain('paneId !== undefined')
  })

  it('still wraps multi-line text for a vendor without the flag', () => {
    // Unflagged vendors keep their old behaviour, and for multi-line text that
    // behaviour IS bracketed — the guards are what stop embedded newlines from
    // submitting fragments.
    const body = fn('injectText')
    expect(body).toContain('const agentBracketed = preserveNewlines')
    expect(body).toContain('preserveNewlines ? text : flattenForInjection(text)')
  })

  it('routes chunking through injectionChunks so a guard is never split', () => {
    const body = fn('injectText')
    expect(body).toContain('injectionChunks(body, CHUNK, bracketed)')
    // The old size-based slice of the wrapped payload is what could cut a guard
    // in half; it must not come back.
    expect(body).not.toContain('payload.slice(i, i + CHUNK)')
  })

  it('chunks the context-share paste the same way', () => {
    // Same hazard, same fix: this path wrapped first and chunked the wrapped
    // string, so a long enough share split a guard.
    const body = fn('pastePaneContext')
    expect(body).toContain('injectionChunks(text, 512, true)')
    expect(body).not.toContain('chunkForPty(payload')
  })

  it('matches the echo against the text, never against the guards', () => {
    // The gates compare normalized clean-buffer text, so wrapping the write
    // cannot change what "it landed" means.
    const body = fn('injectText')
    expect(body).toContain('normalizeForMatch(text)')
    expect(body).not.toContain('normalizeForMatch(payload)')
  })
})
