import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The messaging gate let a message into a `claude --resume` that was still
// reloading its transcript (see lib/__tests__/resumeBoot.test.ts for the
// incident). messagingHoldKey lives in App.vue, which the suite cannot mount,
// so its wiring is asserted against the source the way the other
// App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const terminalSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/platform/terminal/composables/useTerminal.ts'),
  'utf8',
)
const paneSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/TerminalPane.vue'), 'utf8')

function fn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('messagingHoldKey holds a resuming CLI as starting', () => {
  it('asks resumeBootHold, with the PTY, spawn time, push channel and CLI clocks', () => {
    const body = fn(appSource, 'messagingHoldKey')
    expect(body).toContain('resumeBootHold({')
    expect(body).toContain('hasPty: !!')
    expect(body).toContain('resumeSpawnedAt')
    expect(body).toContain('pushReady: pushReadyPanes.has(paneId)')
    expect(body).toContain('lastSignalAt: paneCliSignalAt(paneId)')
  })

  it('reads the CLI clock as the newer of its activity and its turn end', () => {
    const body = fn(appSource, 'paneCliSignalAt')
    expect(body).toContain('paneTurnCompleteAt.get(paneId)')
    expect(body).toContain('paneLastActiveAt.get(paneId)')
  })

  it("answers 'starting', ahead of the typing and turn holds", () => {
    const body = fn(appSource, 'messagingHoldKey')
    const boot = body.indexOf('resumeBootHold({')
    expect(body.slice(boot, boot + 400)).toContain("return 'starting'")
    expect(boot).toBeLessThan(body.indexOf("return 'typing'"))
    expect(boot).toBeLessThan(body.indexOf("return 'mid-turn'"))
  })
})

describe('useTerminal stamps a resume only when it creates the PTY', () => {
  it('sets resumeSpawnedAt on a successful create of a resume spawn', () => {
    const created = terminalSource.indexOf('sessionId.value = resp.payload.terminal_session_id')
    expect(created).toBeGreaterThan(-1)
    expect(terminalSource.slice(created, created + 400)).toContain('resumeSpawnedAt.value = opts.isResume ? Date.now() : 0')
  })

  it('leaves a reattach unstamped — that CLI never stopped running', () => {
    const start = terminalSource.indexOf('async function tryReattach(')
    expect(start).toBeGreaterThan(-1)
    const body = terminalSource.slice(start, terminalSource.indexOf('\n  }\n', start))
    expect(body).toContain('sessionId.value = prev')
    expect(body).not.toContain('resumeSpawnedAt')
  })

  it('is exposed to App through the pane ref', () => {
    expect(paneSource).toContain('resumeSpawnedAt: terminal.resumeSpawnedAt')
  })
})

describe('deliverAgentMessage does not vouch for a resumed CLI on growth alone', () => {
  it('collects the echo and submit evidence of the typed message', () => {
    const body = fn(appSource, 'deliverAgentMessage')
    expect(body).toContain('echo?: EchoEvidence | null')
    expect(body).toContain('submit?: SubmitEvidence | null')
  })

  it('samples the resume state before typing, then waits for the CLI to show it received it', () => {
    const body = fn(appSource, 'deliverAgentMessage')
    const sampled = body.indexOf('resumeUnconfirmed({')
    expect(sampled).toBeGreaterThan(-1)
    expect(sampled).toBeLessThan(body.indexOf('await injectPane('))
    expect(body).toContain('injectionVerified(outcome.echo ?? null, outcome.submit ?? null)')
    expect(body).toContain('await cliSignalSince(paneId, typedAt')
  })

  it('reports it unconfirmed — not failed — when the CLI never shows it', () => {
    // Failing it told the sender to resend work that may already be running.
    const body = fn(appSource, 'deliverAgentMessage')
    const wait = body.indexOf('await cliSignalSince(paneId, typedAt')
    expect(body.slice(wait, wait + 600)).toContain('return { unconfirmed: true }')
    expect(body).not.toContain("key: 'inject-failed'")
  })

  it('confirms it later from the user record the transcript reader reports', () => {
    const consume = appSource.indexOf('if (isInjectedMessageText(ev.text)) {')
    expect(consume).toBeGreaterThan(-1)
    expect(appSource.slice(consume, consume + 300)).toContain('messaging.confirmDelivery(ev.pane_id, ev.text)')
  })
})

describe('the delivery-unconfirmed reason reads as a caveat in every locale', () => {
  for (const locale of ['en-US', 'zh-TW', 'ja-JP']) {
    it(locale, () => {
      const messages = JSON.parse(readFileSync(
        resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${locale}.json`), 'utf8',
      ))
      expect(messages.msg['reason-delivery-unconfirmed']).toBeTruthy()
    })
  }
})
