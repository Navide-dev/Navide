// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// An HTTP push appends the envelope to the CLI's composer and then submits it.
// When the submit fails and the clear is not confirmed, the text is still in
// the box — and nothing on the typed path can see it: hasDraft only counts
// keystrokes. Left alone, the next pump (one second later, with the push
// channel in cooldown) judged the pane idle and pasted the next envelope after
// the leftover, submitting both as one. pushUnclearAt is the record that the
// text is there, and messagingHoldKey holds the pane on it until activity
// newer than the push shows the box has moved on.
//
// It lives in App.vue, which the suite cannot mount, so it is asserted against
// the source the way the other App.*.test.ts files do. The queue side — the
// re-queue, the per-message unclear count and the push-stuck failure — is
// executed in composables/__tests__/useAgentMessagingPush.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('messagingHoldKey — the composer hold', () => {
  it('holds while the last push is unclear and the pane has shown no activity since', () => {
    const body = fn('messagingHoldKey')
    expect(body).toContain('pushUnclearAt.get(paneId)')
    expect(body).toContain('(paneLastActiveAt.get(paneId) ?? 0) <= unclearAt')
    expect(body).toContain("return 'composer'")
  })

  it('is checked before the typing hold, which cannot see pushed text', () => {
    const body = fn('messagingHoldKey')
    const composer = body.indexOf("return 'composer'")
    expect(composer).toBeGreaterThan(body.indexOf("return 'starting'"))
    expect(composer).toBeLessThan(body.indexOf("return 'typing'"))
  })

  it('forgets the push once the pane has been active since it', () => {
    const body = fn('messagingHoldKey')
    expect(body).toContain('pushUnclearAt.delete(paneId)')
  })
})

describe('pushUnclearAt — the record', () => {
  it('is stamped by the push that came back unclear', () => {
    const body = fn('pushDeliverAgentMessage')
    const stamp = body.indexOf('pushUnclearAt.set(paneId, Date.now())')
    expect(stamp).toBeGreaterThan(-1)
    expect(stamp).toBeLessThan(body.indexOf("return 'unclear'"))
  })

  it('is dropped with the rest of the pane state on unregister', () => {
    const body = fn('unregisterPaneMessaging')
    expect(body).toContain('pushUnclearAt.delete(paneId)')
  })

  it('is dropped when the backend announces a fresh push channel', () => {
    const start = appSource.indexOf("backend.on('agent_msg.push_state'")
    expect(start).toBeGreaterThan(-1)
    const handler = appSource.slice(start, appSource.indexOf('\n})\n', start))
    expect(handler).toContain('pushUnclearAt.delete(ev.pane_id)')
  })

  it('has a localized hold reason in both shipped locales', () => {
    for (const locale of ['en-US', 'zh-TW']) {
      const json = JSON.parse(
        readFileSync(resolve(process.cwd(), `src/renderer/src/i18n/locales/${locale}.json`), 'utf8')
      ) as { msg: Record<string, string> }
      expect(json.msg['hold-composer']).toBeTruthy()
      expect(json.msg['reason-push-stuck']).toBeTruthy()
    }
  })
})
