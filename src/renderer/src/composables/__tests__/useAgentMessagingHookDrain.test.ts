import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  RATE_LIMIT_MAX,
  type MessageReason,
  type MessagingDeps,
} from '../useAgentMessaging'

/**
 * drainForHook() is the delivery path that never types: a claude pane's Stop
 * hook asks what is queued for it, and the answer becomes the agent's next
 * instruction. What it must get right is which guards still apply (the ones
 * about whether a message may go out) versus which no longer do (the ones
 * about the input box), and that a message taken this way can never also be
 * injected.
 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging — Stop-hook drain', () => {
  let clock: number
  let idlePanes: Set<string>
  let delivered: Array<{ paneId: string; text: string }>
  let deliverGate: ((ok: boolean) => void) | null
  let reports: Array<{ msgKey: string; ok: boolean; reason: MessageReason | null }>
  let updates: Array<{ uid: string; status?: string }>
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: async (paneId, text) => {
      delivered.push({ paneId, text })
      if (deliverGate) return new Promise<boolean>((res) => { deliverGate = res })
      return true
    },
    isPaneIdle: (paneId) => idlePanes.has(paneId),
    reportDelivery: (msgKey, ok, reason) => {
      reports.push({ msgKey, ok, reason })
    },
    persistUpdate: (rows) => {
      updates.push(...rows)
    },
  }

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    idlePanes = new Set(['p1', 'p2'])
    delivered = []
    deliverGate = null
    reports = []
    updates = []
    m = useAgentMessaging()
    m.configureMessaging(deps)
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'claude', 'target')
  })

  it('reserves the queued envelope, and settles it as delivered', () => {
    const msg = m.sendMessage('sender', 'target', 'run the suite')

    const envelope = m.drainForHook('p2')
    expect(envelope).toContain('run the suite')
    expect(envelope).toContain('from: sender')
    expect(msg.status).toBe('delivering')
    expect(msg.route).toBe('hook')

    m.settleHookDrain('p2', true)
    expect(msg.status).toBe('delivered')
    expect(msg.route).toBe('hook')
    expect(msg.deliveredAt).toBe(clock)
  })

  it('never types the message it handed over', async () => {
    // The whole point: the pane's input box is untouched, so the row must be
    // out of pump()'s reach both while reserved and once settled.
    m.sendMessage('sender', 'target', 'run the suite')

    m.drainForHook('p2')
    m.pump()
    await flush()
    expect(delivered).toEqual([])

    m.settleHookDrain('p2', true)
    m.pump()
    await flush()
    expect(delivered).toEqual([])
  })

  it('serves the queue in order, one message per hook', () => {
    m.sendMessage('sender', 'target', 'first')
    m.sendMessage('sender', 'target', 'second')

    expect(m.drainForHook('p2')).toContain('first')
    // Reserved: the next hook gets nothing until this one is settled.
    expect(m.drainForHook('p2')).toBeNull()
    m.settleHookDrain('p2', true)

    expect(m.drainForHook('p2')).toContain('second')
    m.settleHookDrain('p2', true)
    expect(m.drainForHook('p2')).toBeNull()
  })

  // ── The hook gave up before the answer reached it ─────────────────────────
  it('puts a message the hook never received back at the head of the queue', () => {
    const first = m.sendMessage('sender', 'target', 'first')
    m.sendMessage('sender', 'target', 'second')

    expect(m.drainForHook('p2')).toContain('first')
    m.settleHookDrain('p2', false)

    expect(first.status).toBe('queued')
    expect(first.route).toBeUndefined()
    expect(first.deliveredAt).toBeUndefined()
    // Still first in line, ahead of the one queued behind it.
    expect(m.drainForHook('p2')).toContain('first')
  })

  it('delivers a returned message the ordinary way on the next pump', async () => {
    const msg = m.sendMessage('sender', 'target', 'run the suite')
    m.drainForHook('p2')
    m.settleHookDrain('p2', false)

    m.pump()
    await flush()

    expect(delivered).toHaveLength(1)
    expect(delivered[0].paneId).toBe('p2')
    expect(delivered[0].text).toContain('run the suite')
    expect(msg.status).toBe('delivered')
    expect(msg.route).toBeUndefined()
  })

  it('tells the sending window nothing until the hand-over is confirmed', () => {
    idlePanes.clear()
    m.acceptRemoteMessage({
      msgKey: 'k-1',
      targetPaneId: 'p2',
      fromDisplay: 'beta/builder',
      content: 'rebased onto main',
      remoteWorkspace: '/ws/beta',
    })

    m.drainForHook('p2')
    expect(reports).toEqual([])

    m.settleHookDrain('p2', false)
    expect(reports).toEqual([])
  })

  it('restores the persisted row too, so a reload does not find it mid-flight', () => {
    const msg = m.sendMessage('sender', 'target', 'run the suite')
    m.drainForHook('p2')
    m.settleHookDrain('p2', false)

    expect(updates).toEqual([
      { uid: msg.uid, status: 'delivering' },
      { uid: msg.uid, status: 'queued' },
    ])
  })

  it('survives the pane closing while a message is reserved', () => {
    m.sendMessage('sender', 'target', 'run the suite')
    m.drainForHook('p2')
    m.unregisterPane('p2')

    expect(() => m.settleHookDrain('p2', true)).not.toThrow()
    expect(reports).toEqual([])
  })

  it('has nothing to say for a pane with an empty queue', () => {
    expect(m.drainForHook('p2')).toBeNull()
  })

  it('stays quiet while delivery is paused for the window', () => {
    const msg = m.sendMessage('sender', 'target', 'run the suite')
    m.pauseMessaging()

    expect(m.drainForHook('p2')).toBeNull()
    expect(msg.status).toBe('queued')
  })

  it('stays quiet while an injection into the same pane is still in flight', async () => {
    // A message being typed in right now has to finish first — handing a second
    // one to the agent mid-injection would interleave the two.
    deliverGate = () => {}
    m.sendMessage('sender', 'target', 'first')
    m.sendMessage('sender', 'target', 'second')
    m.pump()
    await flush()
    expect(delivered).toHaveLength(1)

    expect(m.drainForHook('p2')).toBeNull()
  })

  it('ignores the idle gate, which is the reason it exists', () => {
    // The pane is mid-turn by every measure the injection path uses — the turn
    // is ending right now, which is what the hook is reporting.
    idlePanes.clear()
    m.sendMessage('sender', 'target', 'run the suite')

    expect(m.drainForHook('p2')).toContain('run the suite')
  })

  it('keeps a message queued while a person\'s STOP still holds the pane', () => {
    // 0.2.39 Linux VM (stopuser): after a person pressed STOP, a background job
    // ending started a turn of Claude's own. Its Stop hook handed over a queued
    // cli_send 47 s later, while the typed path was still holding it for the
    // person to type. The hold is about waking an agent someone stopped on
    // purpose, so it applies however the message would arrive.
    let held = true
    m.configureMessaging({ ...deps, stopHeld: () => held })
    const msg = m.sendMessage('sender', 'target', 'PING')

    expect(m.drainForHook('p2')).toBeNull()
    expect(msg.status).toBe('queued')

    held = false
    expect(m.drainForHook('p2')).toContain('PING')
  })

  it('cannot produce a message the pair rate limit already refused', () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) m.sendMessage('sender', 'target', `m${i}`)
    const refused = m.sendMessage('sender', 'target', 'one too many')

    expect(refused.status).toBe('failed')
    expect(refused.reason?.key).toBe('rate-limit')
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
      expect(m.drainForHook('p2')).not.toBeNull()
      m.settleHookDrain('p2', true)
    }
    expect(m.drainForHook('p2')).toBeNull()
  })

  it('reports a cross-workspace message as delivered to the window that sent it', () => {
    // Mid-turn, so the arriving message waits instead of being injected at once
    // — the state a Stop hook then finds it in.
    idlePanes.clear()
    m.acceptRemoteMessage({
      msgKey: 'k-1',
      targetPaneId: 'p2',
      fromDisplay: 'beta/builder',
      content: 'rebased onto main',
      remoteWorkspace: '/ws/beta',
    })

    expect(m.drainForHook('p2')).toContain('rebased onto main')
    m.settleHookDrain('p2', true)
    expect(reports).toEqual([{ msgKey: 'k-1', ok: true, reason: null }])
  })

  it('mirrors the delivered status into the log store', () => {
    const msg = m.sendMessage('sender', 'target', 'run the suite')

    m.drainForHook('p2')
    m.settleHookDrain('p2', true)

    expect(updates).toContainEqual({
      uid: msg.uid,
      status: 'delivered',
      delivered_at: clock,
    })
  })
})
