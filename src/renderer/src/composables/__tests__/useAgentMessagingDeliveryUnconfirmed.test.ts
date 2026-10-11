import { beforeEach, describe, expect, it } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  encodeReason,
  type MessageReason,
  type MessagingDeps,
} from '../useAgentMessaging'

// A message typed into a resumed CLI that has not shown it received it: the
// bytes and the Enter went out, but the transcript never showed the message
// within the wait. That is neither "delivered" nor "failed" — reporting it
// failed told the sender to resend work that may already be running.
const flush = () => new Promise((r) => setTimeout(r, 0))
const UNCONFIRMED = { key: 'delivery-unconfirmed' }

describe('a delivery the CLI has not confirmed', () => {
  let m: ReturnType<typeof useAgentMessaging>
  let reports: Array<{ msgKey: string; ok: boolean; reason: MessageReason | null }>
  let delivered: string[]
  let deliverResult: Awaited<ReturnType<MessagingDeps['deliver']>>

  const deps: MessagingDeps = {
    now: () => 1_000_000,
    deliver: async (_paneId, text) => {
      delivered.push(text)
      return deliverResult
    },
    isPaneIdle: () => true,
    routeRemote: async () => ({ ok: true, targetDisplay: 'beta/reviewer', targetWorkspacePath: '/ws/beta' }),
    reportDelivery: (msgKey, ok, reason) => {
      reports.push({ msgKey, ok, reason })
    },
  }

  beforeEach(() => {
    _resetMessagingForTest()
    reports = []
    delivered = []
    deliverResult = { unconfirmed: true }
    m = useAgentMessaging()
    m.configureMessaging(deps)
  })

  async function deliverUnconfirmed(msgKey = 'sender:mcp:abc'): Promise<void> {
    m.registerPane('target-id', 'claude', 'release')
    expect(
      m.acceptRemoteMessage({
        msgKey,
        targetPaneId: 'target-id',
        fromDisplay: 'Agent-Team/Navide指揮',
        content: 'prepare the release',
        rateLimit: false,
      }),
    ).toBe(true)
    m.pump()
    await flush()
    await flush()
  }

  it('is reported as delivery-unconfirmed, not as a failure', async () => {
    await deliverUnconfirmed()
    expect(reports).toEqual([{ msgKey: 'sender:mcp:abc', ok: false, reason: UNCONFIRMED }])
    const row = m.messages.value.find((x) => x.correlationId === 'sender:mcp:abc')
    // Not offered for Resend in the panel, and no failure notice goes back.
    expect(row?.status).toBe('delivered')
    expect(row?.reason).toEqual(UNCONFIRMED)
    expect(m.messages.value.filter((x) => x.kind === 'notice')).toEqual([])
  })

  it('is confirmed when its user record shows up later', async () => {
    await deliverUnconfirmed()
    expect(m.confirmDelivery('target-id', delivered[0])).toBe(true)

    expect(reports[1]).toEqual({ msgKey: 'sender:mcp:abc', ok: true, reason: null })
    const row = m.messages.value.find((x) => x.correlationId === 'sender:mcp:abc')
    expect(row?.status).toBe('delivered')
    expect(row?.reason).toBeUndefined()
    // Once only.
    expect(m.confirmDelivery('target-id', delivered[0])).toBe(false)
  })

  it('is not confirmed by some other user record', async () => {
    await deliverUnconfirmed()
    expect(m.confirmDelivery('target-id', 'what is the weather')).toBe(false)
    expect(m.confirmDelivery('other-pane', delivered[0])).toBe(false)
    expect(reports).toHaveLength(1)
  })

  it('is forgotten when the pane goes away', async () => {
    await deliverUnconfirmed()
    m.unregisterPane('target-id')
    expect(m.confirmDelivery('target-id', delivered[0])).toBe(false)
  })
})

describe('the sending window shows an unconfirmed delivery as such', () => {
  let m: ReturnType<typeof useAgentMessaging>
  let routed: Array<{ msgKey: string }>

  beforeEach(() => {
    _resetMessagingForTest()
    routed = []
    m = useAgentMessaging()
    m.configureMessaging({
      now: () => 1_000_000,
      deliver: async () => true,
      isPaneIdle: () => true,
      routeRemote: async (args) => {
        routed.push(args)
        return { ok: true, targetDisplay: 'beta/reviewer', targetWorkspacePath: '/ws/beta' }
      },
    })
  })

  it('delivered with the caveat, then plain delivered once confirmed', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    m.resolveRemoteDelivery(routed[0].msgKey, false, encodeReason(UNCONFIRMED))
    expect(msg.status).toBe('delivered')
    expect(msg.reason).toEqual(UNCONFIRMED)
    expect(m.messages.value.filter((x) => x.kind === 'notice')).toEqual([])

    m.resolveRemoteDelivery(routed[0].msgKey, true, '')
    expect(msg.status).toBe('delivered')
    expect(msg.reason).toBeUndefined()
  })
})
