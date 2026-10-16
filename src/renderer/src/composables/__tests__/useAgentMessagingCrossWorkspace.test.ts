import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  RATE_LIMIT_MAX,
  QUEUE_CAP,
  encodeReason,
  type MessageReason,
  type MessagingDeps,
  type RouteResult,
} from '../useAgentMessaging'
import { EXTERNAL_CONTENT_START, MSG_ENVELOPE_PREFIX, MSG_NOTICE_PREFIX, renderEnvelope } from '../../lib/agentMessaging'

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging — cross-workspace routing', () => {
  let clock: number
  let idlePanes: Set<string>
  let delivered: Array<{ paneId: string; text: string }>
  let deliverResult: boolean
  let routed: Array<{
    fromPaneId: string
    fromName: string
    to: string
    content: string
    msgKey: string
    replyTo?: string
  }>
  let routeResult: RouteResult
  let reports: Array<{ msgKey: string; ok: boolean; reason: MessageReason | null }>
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: async (paneId, text) => {
      delivered.push({ paneId, text })
      return deliverResult
    },
    isPaneIdle: (paneId) => idlePanes.has(paneId),
    routeRemote: async (args) => {
      routed.push(args)
      return routeResult
    },
    reportDelivery: (msgKey, ok, reason) => {
      reports.push({ msgKey, ok, reason })
    },
  }

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    idlePanes = new Set(['p1', 'p2'])
    delivered = []
    deliverResult = true
    routed = []
    routeResult = { ok: true, targetDisplay: 'beta/reviewer', targetWorkspacePath: '/ws/beta' }
    reports = []
    m = useAgentMessaging()
    m.configureMessaging(deps)
  })

  // ── Outbound ─────────────────────────────────────────────────────────────
  it('routes a qualified target this window does not own', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'run the tests')
    await flush()

    expect(routed).toHaveLength(1)
    expect(routed[0]).toMatchObject({
      fromPaneId: 'p1',
      fromName: 'sender',
      to: 'beta/reviewer',
      content: 'run the tests',
    })
    expect(msg.status).toBe('queued')
    expect(msg.remote).toBe('outbound')
    expect(msg.remoteWorkspace).toBe('/ws/beta')
  })

  it('leaves an unqualified unknown target failing immediately, as before', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'nobody', 'hi')
    await flush()

    expect(routed).toEqual([])
    expect(msg.status).toBe('failed')
    expect(msg.reason?.key).toBe('unknown-target')
  })

  it('prefers a local pane whose own name contains a slash', async () => {
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'fix/bug')
    const msg = m.sendMessage('sender', 'fix/bug', 'local please')
    await flush()

    expect(routed).toEqual([])
    expect(msg.status).toBe('queued')
    expect(msg.remote).toBeUndefined()
  })

  it('fails the message when the backend cannot resolve the target', async () => {
    m.registerPane('p1', 'claude', 'sender')
    routeResult = { ok: false, error: 'unknown workspace "gamma"' }
    const msg = m.sendMessage('sender', 'gamma/reviewer', 'hi')
    await flush()

    expect(msg.status).toBe('failed')
    // No code from the backend → its sentence is shown verbatim.
    expect(msg.reason).toEqual({ key: 'raw', params: { text: 'unknown workspace "gamma"' } })
  })

  it('prefers the backend error code over its sentence, so the log can localize', async () => {
    m.registerPane('p1', 'claude', 'sender')
    routeResult = {
      ok: false,
      error: 'unknown workspace "gamma"',
      errorCode: 'unknown-workspace',
      errorParams: { ws: 'gamma' },
    }
    const msg = m.sendMessage('sender', 'gamma/reviewer', 'hi')
    await flush()

    expect(msg.reason).toEqual({ key: 'unknown-workspace', params: { ws: 'gamma' } })
  })

  it('takes the remote target\'s CLI from the resolved route', async () => {
    m.registerPane('p1', 'claude', 'sender')
    routeResult = {
      ok: true,
      targetDisplay: 'beta/reviewer',
      targetWorkspacePath: '/ws/beta',
      targetAgentKey: 'codex',
    }
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    expect(msg.fromAgent).toBe('claude')
    // Only the backend registry knows a pane living in another window.
    expect(msg.toAgent).toBe('codex')
  })

  it('reports a routing exception rather than hanging in queued', async () => {
    m.registerPane('p1', 'claude', 'sender')
    m.configureMessaging({
      ...deps,
      routeRemote: async () => {
        throw new Error('backend down')
      },
    })
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    expect(msg.status).toBe('failed')
    expect(msg.reason).toEqual({ key: 'route-error', params: { error: 'backend down' } })
  })

  it('degrades to the old local-only failure when no router is configured', async () => {
    m.configureMessaging({
      now: deps.now,
      deliver: deps.deliver,
      isPaneIdle: deps.isPaneIdle,
    })
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    expect(msg.status).toBe('failed')
    expect(msg.reason?.key).toBe('unknown-target')
  })

  it('applies the per-pair rate limit to cross-workspace sends', async () => {
    m.registerPane('p1', 'claude', 'sender')
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      m.sendMessage('sender', 'beta/reviewer', `msg ${i}`)
    }
    await flush()
    const blocked = m.sendMessage('sender', 'beta/reviewer', 'one too many')
    await flush()

    expect(routed).toHaveLength(RATE_LIMIT_MAX)
    expect(blocked.status).toBe('failed')
    expect(blocked.reason?.key).toBe('rate-limit')
  })

  it('refuses to route when the sender is not a registered pane', async () => {
    const msg = m.sendMessage('Navide', 'beta/reviewer', 'hi')
    await flush()

    expect(routed).toEqual([])
    expect(msg.status).toBe('failed')
  })

  // ── Delivery result ──────────────────────────────────────────────────────
  it('marks the outbound entry delivered when the receiver reports success', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    m.resolveRemoteDelivery(routed[0].msgKey, true, '')
    expect(msg.status).toBe('delivered')
    expect(msg.deliveredAt).toBe(clock)
  })

  it('marks the outbound entry failed with the receiver reason', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    m.resolveRemoteDelivery(routed[0].msgKey, false, encodeReason({ key: 'inject-failed' }))
    expect(msg.status).toBe('failed')
    expect(msg.reason?.key).toBe('inject-failed')
  })

  it('ignores a delivery result belonging to another window', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    m.resolveRemoteDelivery('someone-else:7', true, '')
    expect(msg.status).toBe('queued')
  })

  // ── Outbound logged from the deliver broadcast (MCP cli_send) ────────────
  it('logs an outbound row only in the window owning the sender pane', () => {
    m.registerPane('p1', 'claude', 'sender')

    expect(
      m.noteOutboundMessage({
        msgKey: 'mcp:1',
        fromPaneId: 'p1',
        targetPaneId: 'elsewhere',
        toDisplay: 'reviewer',
        content: 'run the tests',
        crossWorkspace: true,
        remoteWorkspace: '/ws/beta',
      }),
    ).toBe(true)
    // Another window sees the same broadcast but owns neither pane.
    expect(
      m.noteOutboundMessage({
        msgKey: 'mcp:2',
        fromPaneId: 'not-ours',
        targetPaneId: 'elsewhere',
        toDisplay: 'reviewer',
        content: 'run the tests',
        crossWorkspace: true,
      }),
    ).toBe(false)

    expect(m.messages.value).toHaveLength(1)
    const entry = m.messages.value[0]
    expect(entry.from).toBe('sender')
    expect(entry.to).toBe('reviewer')
    expect(entry.status).toBe('queued')
    expect(entry.remote).toBe('outbound')
    expect(entry.remoteWorkspace).toBe('/ws/beta')
    // The sending window never delivers: no envelope, no queue.
    expect(delivered).toEqual([])
  })

  it('leaves a same-workspace MCP send unbadged', () => {
    m.registerPane('p1', 'claude', 'sender')
    m.noteOutboundMessage({
      msgKey: 'mcp:1',
      fromPaneId: 'p1',
      targetPaneId: 'elsewhere',
      toDisplay: 'reviewer',
      content: 'hi',
      crossWorkspace: false,
    })

    expect(m.messages.value[0].remote).toBeUndefined()
  })

  it('skips the outbound row when this window also owns the target pane', () => {
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'claude', 'reviewer')

    expect(
      m.noteOutboundMessage({
        msgKey: 'mcp:1',
        fromPaneId: 'p1',
        targetPaneId: 'p2',
        toDisplay: 'reviewer',
        content: 'hi',
        crossWorkspace: false,
      }),
    ).toBe(false)
    expect(m.messages.value).toHaveLength(0)
  })

  it('resolves an outbound row logged from the broadcast', () => {
    m.registerPane('p1', 'claude', 'sender')
    m.noteOutboundMessage({
      msgKey: 'mcp:1',
      fromPaneId: 'p1',
      targetPaneId: 'elsewhere',
      toDisplay: 'reviewer',
      content: 'hi',
      crossWorkspace: true,
      remoteWorkspace: '/ws/beta',
    })

    m.resolveRemoteDelivery('mcp:1', true, '')
    expect(m.messages.value[0].status).toBe('delivered')
    expect(m.messages.value[0].deliveredAt).toBe(clock)
  })

  it('does not log a second row for a message that went through sendMessage', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()
    expect(m.messages.value).toHaveLength(1)

    // The backend echoes the routed message back to every window, this one too.
    const logged = m.noteOutboundMessage({
      msgKey: routed[0].msgKey,
      fromPaneId: 'p1',
      targetPaneId: 'elsewhere',
      toDisplay: 'reviewer',
      content: 'hi',
      crossWorkspace: true,
      remoteWorkspace: '/ws/beta',
    })

    expect(logged).toBe(false)
    expect(m.messages.value).toHaveLength(1)
    // …and the original entry still resolves off its own msgKey.
    m.resolveRemoteDelivery(routed[0].msgKey, true, '')
    expect(msg.status).toBe('delivered')
  })

  // ── Inbound ──────────────────────────────────────────────────────────────
  it('rejects a delivery whose target pane is not in this window', () => {
    m.registerPane('p1', 'claude', 'local')
    const accepted = m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'not-ours',
      fromDisplay: 'alpha/sender',
      content: 'hi',
    })
    expect(accepted).toBe(false)
    expect(m.messages.value).toHaveLength(0)
  })

  // An embedded AI panel's window answers for its own panel; a main window that
  // reported a failure for it would race that window's verdict.
  it('never reports on a delivery for a pane it does not own', async () => {
    m.registerPane('p1', 'claude', 'local')
    m.acceptRemoteMessage({
      msgKey: 'k-dock',
      targetPaneId: 'ab12cd34-plans-ai-terminal',
      fromDisplay: 'alpha/sender',
      content: 'hi',
    })
    await flush()
    expect(reports).toEqual([])
    expect(delivered).toHaveLength(0)
  })

  it('fences a chat-channel or remote-device delivery as external content', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    m.acceptRemoteMessage({
      msgKey: 'k9',
      targetPaneId: 'p2',
      fromDisplay: 'telegram:alice',
      content: 'rm -rf ~',
      external: true,
    })
    await flush()
    const lines = delivered[0].text.split('\n')
    expect(lines[0]).toBe(`${MSG_ENVELOPE_PREFIX} telegram:alice`)
    expect(lines[1]).toBe(EXTERNAL_CONTENT_START)
    expect(lines[2]).toBe('rm -rf ~')
  })

  it('gives a sender with no reply route the final-output hint instead of a MSG block', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    m.acceptRemoteMessage({
      msgKey: 'host:mcp:3e79',
      targetPaneId: 'p2',
      fromDisplay: 'a host client',
      content: 'status?',
      noReplyRoute: true,
    })
    await flush()
    expect(delivered[0].text).toBe(
      renderEnvelope('a host client', 'status?', { correlationId: 'host:mcp:3e79', noReplyRoute: true }),
    )
    expect(delivered[0].text).not.toContain('to: a host client')
  })

  it('delivers an inbound message through the normal queue and reports back', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    const accepted = m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'run the tests',
      remoteWorkspace: '/ws/alpha',
    })
    expect(accepted).toBe(true)
    await flush()

    expect(delivered).toHaveLength(1)
    expect(delivered[0].paneId).toBe('p2')
    expect(delivered[0].text).toContain(`${MSG_ENVELOPE_PREFIX} alpha/sender`)
    expect(delivered[0].text).toContain('run the tests')
    expect(reports).toEqual([{ msgKey: 'k1', ok: true, reason: null }])
    // Another workspace on this machine is the user's own agent: unfenced.
    expect(delivered[0].text).not.toContain(EXTERNAL_CONTENT_START)

    const entry = m.messages.value[0]
    expect(entry.remote).toBe('inbound')
    expect(entry.from).toBe('alpha/sender')
    expect(entry.to).toBe('reviewer')
    expect(entry.status).toBe('delivered')
  })

  it('offers the routing key as the correlation id, and links the reply to it', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'run the tests',
      remoteWorkspace: '/ws/alpha',
    })
    await flush()
    expect(delivered[0].text).toContain('re: k1')

    const reply = m.sendMessage('reviewer', 'alpha/sender', 'all green', { replyTo: 'k1' })
    await flush()
    expect(reply.inReplyTo).toBe(m.messages.value[0].uid)
  })

  // ── Correlation across the workspace boundary ─────────────────────────────
  it('carries the correlation id back to the sending window when replying remotely', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'run the tests',
      remoteWorkspace: '/ws/alpha',
    })
    await flush()

    m.sendMessage('reviewer', 'alpha/sender', 'all green', { replyTo: 'k1' })
    await flush()

    expect(routed).toHaveLength(1)
    expect(routed[0].replyTo).toBe('k1')
  })

  it('names an outbound message by the routing key both windows know it by', async () => {
    // The sending window's own row has to carry it too: the log store is
    // global, so a recipient reading its inbox by name can see this row, and
    // the two copies must agree on what the message is called.
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'run the tests')
    await flush()

    expect(msg.correlationId).toBe(routed[0].msgKey)
  })

  it('gives an inbound message the id the sending side already knows it by', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'run the tests',
      remoteWorkspace: '/ws/alpha',
    })
    await flush()

    expect(m.messages.value[0].correlationId).toBe('k1')
  })

  it('links an inbound reply to the outbound message it answers', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const outbound = m.sendMessage('sender', 'beta/reviewer', 'run the tests')
    await flush()
    const corrId = routed[0].msgKey

    // The other window echoes our routing key back as the reply's correlation id.
    const accepted = m.acceptRemoteMessage({
      msgKey: 'beta-1',
      targetPaneId: 'p1',
      fromDisplay: 'beta/reviewer',
      content: 'all green',
      remoteWorkspace: '/ws/beta',
      replyTo: corrId,
    })
    await flush()

    expect(accepted).toBe(true)
    const reply = m.messages.value.find((x) => x.content === 'all green')
    expect(reply?.inReplyTo).toBe(outbound.uid)
  })

  it('leaves an inbound message unlinked when no correlation id came back', async () => {
    m.registerPane('p1', 'claude', 'sender')
    m.sendMessage('sender', 'beta/reviewer', 'run the tests')
    await flush()
    // A fresh message carries no correlation id to the backend.
    expect(routed[0].replyTo).toBeUndefined()

    m.acceptRemoteMessage({
      msgKey: 'beta-1',
      targetPaneId: 'p1',
      fromDisplay: 'beta/reviewer',
      content: 'all green',
      remoteWorkspace: '/ws/beta',
    })
    await flush()

    const reply = m.messages.value.find((x) => x.content === 'all green')
    expect(reply?.inReplyTo).toBeUndefined()
  })

  it('ignores a correlation id this window never handed out', async () => {
    m.registerPane('p1', 'claude', 'sender')
    m.sendMessage('sender', 'beta/reviewer', 'run the tests')
    await flush()

    m.acceptRemoteMessage({
      msgKey: 'beta-1',
      targetPaneId: 'p1',
      fromDisplay: 'beta/reviewer',
      content: 'all green',
      remoteWorkspace: '/ws/beta',
      replyTo: 'never-issued',
    })
    await flush()

    const reply = m.messages.value.find((x) => x.content === 'all green')
    expect(reply?.inReplyTo).toBeUndefined()
  })

  it('honours the idle gate for inbound messages', async () => {
    m.registerPane('p3', 'claude', 'busy')
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p3',
      fromDisplay: 'alpha/sender',
      content: 'hi',
    })
    await flush()
    expect(delivered).toEqual([])
    expect(reports).toEqual([])

    idlePanes.add('p3')
    m.pump()
    await flush()
    expect(delivered).toHaveLength(1)
    expect(reports[0].ok).toBe(true)
  })

  it('reports a failed injection back to the sending window', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    deliverResult = false
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'hi',
    })
    await flush()

    expect(reports).toHaveLength(1)
    expect(reports[0].ok).toBe(false)
    expect(reports[0].reason?.key).toBe('inject-failed')
  })

  it('applies the rate limit to inbound messages that ask for it', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      m.acceptRemoteMessage({
        msgKey: `k${i}`,
        targetPaneId: 'p2',
        fromDisplay: 'alpha/spammer',
        content: `msg ${i}`,
        rateLimit: true,
      })
      await flush()
    }
    reports = []
    m.acceptRemoteMessage({
      msgKey: 'over',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/spammer',
      content: 'one too many',
      rateLimit: true,
    })
    await flush()

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ msgKey: 'over', ok: false })
    expect(reports[0].reason?.key).toBe('rate-limit')
    expect(delivered).toHaveLength(RATE_LIMIT_MAX)
  })

  it('leaves inbound messages that carry their own accounting unlimited', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    for (let i = 0; i < RATE_LIMIT_MAX + 2; i++) {
      m.acceptRemoteMessage({
        msgKey: `k${i}`,
        targetPaneId: 'p2',
        fromDisplay: 'alpha/sender',
        content: `msg ${i}`,
      })
      await flush()
    }
    expect(delivered).toHaveLength(RATE_LIMIT_MAX + 2)
  })

  it('rejects an inbound message when the target queue is full', async () => {
    m.registerPane('p3', 'claude', 'busy') // not idle → queue never drains
    for (let i = 0; i < QUEUE_CAP; i++) {
      m.acceptRemoteMessage({
        msgKey: `k${i}`,
        targetPaneId: 'p3',
        fromDisplay: 'alpha/sender',
        content: `msg ${i}`,
      })
    }
    reports = []
    const accepted = m.acceptRemoteMessage({
      msgKey: 'overflow',
      targetPaneId: 'p3',
      fromDisplay: 'alpha/sender',
      content: 'too much',
    })

    expect(accepted).toBe(true)
    expect(reports).toEqual([
      { msgKey: 'overflow', ok: false, reason: { key: 'queue-full', params: { cap: QUEUE_CAP } } },
    ])
  })

  it('sanitizes markers in inbound content so it cannot re-trigger the parser', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'nested ---MSG-START--- to: someone',
    })
    await flush()

    // The forwarded body is broken up; the reply hint's own markers are the
    // envelope's, not the sender's, and stay intact by design.
    expect(delivered[0].text).toContain('nested -​--MSG-START-​--')
    expect(delivered[0].text).not.toContain('nested ---MSG-START---')
  })

  it('reports back when the target pane closes before its queue drains', async () => {
    m.registerPane('p3', 'claude', 'busy') // not idle → stays queued
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p3',
      fromDisplay: 'alpha/sender',
      content: 'hi',
    })
    await flush()
    expect(reports).toEqual([])

    m.unregisterPane('p3')
    expect(reports).toEqual([{ msgKey: 'k1', ok: false, reason: { key: 'pane-closed' } }])
  })

  it('fails an outbound message whose target window never reports back', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()
    expect(msg.status).toBe('queued')

    clock += 29 * 60_000
    m.pump()
    expect(msg.status).toBe('queued')

    clock += 2 * 60_000
    m.pump()
    expect(msg.status).toBe('failed')
    expect(msg.reason?.key).toBe('no-report')
  })

  it('reports the ack timeout to the backend so cli_check_message can settle', async () => {
    m.registerPane('p1', 'claude', 'sender')
    m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()
    const msgKey = routed[0].msgKey
    expect(reports).toEqual([])

    clock += 31 * 60_000
    m.pump()
    expect(reports).toEqual([{ msgKey, ok: false, reason: { key: 'no-report' } }])

    // The report comes back as a delivery_result broadcast; the row is already
    // resolved and must not be reported or failed a second time.
    m.resolveRemoteDelivery(msgKey, false, encodeReason({ key: 'no-report' }))
    m.pump()
    expect(reports).toHaveLength(1)
  })

  it('expires stale outbound messages even while delivery is paused', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    m.pauseMessaging()
    clock += 31 * 60_000
    m.pump()
    expect(msg.status).toBe('failed')
  })

  it('does not hand out a fresh rate-limit budget per target spelling', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const spellings = [
      'beta/reviewer',
      '/ws/beta/reviewer',
      'parent/beta/reviewer',
      'beta/reviewer',
      '/ws/beta/reviewer',
    ]
    for (const to of spellings) m.sendMessage('sender', to, 'hi')
    await flush()
    const blocked = m.sendMessage('sender', 'parent/beta/reviewer', 'one too many')
    await flush()

    expect(routed).toHaveLength(RATE_LIMIT_MAX)
    expect(blocked.status).toBe('failed')
    expect(blocked.reason?.key).toBe('rate-limit')
  })

  it('keeps separate rate-limit budgets for local panes whose names contain a slash', async () => {
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'claude', 'fix/bug')
    m.registerPane('p3', 'claude', 'feat/bug')
    for (let i = 0; i < RATE_LIMIT_MAX; i++) m.sendMessage('sender', 'fix/bug', `m${i}`)
    const other = m.sendMessage('sender', 'feat/bug', 'still allowed')
    await flush()

    expect(other.status).not.toBe('failed')
    expect(routed).toEqual([])
  })

  // ── Failure feedback to the sending pane ─────────────────────────────────
  it('notifies the sending pane when the target window reports a failure', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'ship it')
    await flush()
    m.resolveRemoteDelivery(routed[0].msgKey, false, encodeReason({ key: 'inject-failed' }))

    expect(msg.status).toBe('failed')
    const notice = m.messages.value.find((entry) => entry.from === 'Navide')
    expect(notice?.to).toBe('sender')

    m.pump()
    await flush()
    const injected = delivered.find((d) => d.paneId === 'p1')
    expect(injected?.text).toContain(`${MSG_NOTICE_PREFIX} — to: beta/reviewer`)
    expect(injected?.text).toContain('reason: Injection failed')
    expect(injected?.text).toContain('ship it')
  })

  it('notifies the sending pane when the route itself is rejected', async () => {
    m.registerPane('p1', 'claude', 'sender')
    routeResult = { ok: false, errorCode: 'unknown-workspace', errorParams: { ws: 'beta' } }
    m.sendMessage('sender', 'beta/reviewer', 'ship it')
    await flush()

    m.pump()
    await flush()
    const injected = delivered.find((d) => d.paneId === 'p1')
    expect(injected?.text).toContain('reason: No open workspace named “beta”')
  })

  it('notifies the sending pane for an MCP send too, which polls instead of listening', async () => {
    m.registerPane('p1', 'claude', 'sender')
    m.noteOutboundMessage({
      msgKey: 'mcp:1',
      fromPaneId: 'p1',
      targetPaneId: 'elsewhere',
      toDisplay: 'reviewer',
      content: 'hi',
      crossWorkspace: true,
      remoteWorkspace: '/ws/beta',
    })
    m.resolveRemoteDelivery('mcp:1', false, encodeReason({ key: 'pane-closed' }))

    m.pump()
    await flush()
    const injected = delivered.find((d) => d.paneId === 'p1')
    expect(injected?.text).toContain(`${MSG_NOTICE_PREFIX} — to: reviewer`)
    expect(injected?.text).toContain('reason: The target pane closed before delivery')
  })

  it('leaves an inbound failure to the sending window, which notifies its own pane', async () => {
    m.registerPane('p2', 'codex', 'reviewer')
    deliverResult = false
    m.acceptRemoteMessage({
      msgKey: 'beta:1',
      targetPaneId: 'p2',
      fromDisplay: 'beta/sender',
      content: 'hi',
    })
    m.pump()
    await flush()

    expect(m.messages.value.some((entry) => entry.from === 'Navide')).toBe(false)
    expect(reports).toEqual([{ msgKey: 'beta:1', ok: false, reason: { key: 'inject-failed' } }])
  })

  it('local same-workspace delivery is untouched by the remote wiring', async () => {
    m.registerPane('p1', 'claude', 'a')
    m.registerPane('p2', 'claude', 'b')
    const msg = m.sendMessage('a', 'b', 'hello')
    m.pump()
    await flush()

    expect(routed).toEqual([])
    expect(reports).toEqual([])
    expect(msg.status).toBe('delivered')
    expect(delivered[0].paneId).toBe('p2')
  })
})
