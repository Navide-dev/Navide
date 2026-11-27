import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  QUEUE_CAP,
  type MessageHold,
  type MessagingDeps,
} from '../useAgentMessaging'

/**
 * A chat-channel message past QUEUE_CAP waits at the tail of the queue with
 * hold `queue-full` instead of failing; every other sender is still refused.
 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging — chat overflow past the queue cap', () => {
  let idlePanes: Set<string>
  let delivered: string[]
  let reports: Array<{ msgKey: string; ok: boolean; reason: string | null }>
  let holds: Array<{ msgKey: string; hold: MessageHold | null }>
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => 1_000_000,
    deliver: async (_paneId, text) => {
      delivered.push(text)
      return true
    },
    isPaneIdle: (paneId) => idlePanes.has(paneId),
    reportDelivery: (msgKey, ok, reason) => reports.push({ msgKey, ok, reason: reason?.key ?? null }),
    reportHold: (msgKey, hold) => holds.push({ msgKey, hold }),
  }

  function accept(msgKey: string, overflow: boolean): boolean {
    return m.acceptRemoteMessage({
      msgKey,
      targetPaneId: 'p2',
      fromDisplay: 'telegram:alice',
      content: `body ${msgKey}`,
      external: true,
      ...(overflow ? { overflow: true } : {}),
    })
  }

  beforeEach(() => {
    _resetMessagingForTest()
    idlePanes = new Set()
    delivered = []
    reports = []
    holds = []
    m = useAgentMessaging()
    m.configureMessaging(deps)
    m.registerPane('p2', 'claude', 'target')
  })

  it('keeps a channel message past the cap, held as queue-full', () => {
    for (let i = 0; i < QUEUE_CAP; i++) accept(`c${i}`, true)
    accept('over', true)
    m.pump()

    expect(reports).toEqual([])
    expect(m.queuedCountFor('p2')).toBe(QUEUE_CAP + 1)
    expect(holds.filter((h) => h.msgKey === 'over').at(-1)?.hold).toEqual({ key: 'queue-full', n: QUEUE_CAP })
  })

  it('still refuses a non-channel sender at the cap', () => {
    for (let i = 0; i < QUEUE_CAP; i++) accept(`c${i}`, true)
    accept('mcp', false)

    expect(reports).toEqual([{ msgKey: 'mcp', ok: false, reason: 'queue-full' }])
    expect(m.queuedCountFor('p2')).toBe(QUEUE_CAP)
  })

  it('delivers the overflow in order once the pane frees up', async () => {
    for (let i = 0; i < QUEUE_CAP; i++) accept(`c${i}`, true)
    accept('over', true)
    idlePanes.add('p2')
    for (let i = 0; i <= QUEUE_CAP; i++) {
      m.pump()
      await flush()
    }

    expect(delivered).toHaveLength(QUEUE_CAP + 1)
    expect(delivered.at(-1)).toContain('body over')
    expect(reports.every((r) => r.ok)).toBe(true)
  })
})
