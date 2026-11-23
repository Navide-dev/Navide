import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  type MessageReason,
  type MessagingDeps,
  type PushOutcome,
} from '../useAgentMessaging'

/**
 * Push routing: some CLIs take a message through something that is not their
 * PTY. What the queue has to get right is that a push is chosen only when the
 * caller says the channel is open, that a message is never delivered twice,
 * and that a push which does not land always ends in the typed path — either
 * straight away, or on a later tick when the pane is ready for typing.
 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging — push channels', () => {
  let clock: number
  let idlePanes: Set<string>
  let holdKey: string | null
  let pushablePanes: Map<string, string>
  let pushResult: PushOutcome
  let typed: Array<{ paneId: string; text: string }>
  let pushed: Array<{ paneId: string; text: string }>
  let pushIds: string[]
  let pushResults: PushOutcome[]
  let reports: Array<{ msgKey: string; ok: boolean; reason: MessageReason | null }>
  let updates: Array<{ uid: string; status?: string }>
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: async (paneId, text) => {
      typed.push({ paneId, text })
      return true
    },
    isPaneIdle: (paneId) => idlePanes.has(paneId),
    idleHoldKey: (paneId) => (idlePanes.has(paneId) ? null : holdKey),
    pushTarget: (paneId) => {
      const kind = pushablePanes.get(paneId)
      return kind ? { kind } : null
    },
    pushDeliver: async (paneId, text, pushId) => {
      pushed.push({ paneId, text })
      pushIds.push(pushId)
      return pushResults.shift() ?? pushResult
    },
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
    holdKey = 'typing'
    pushablePanes = new Map()
    pushResult = 'landed'
    typed = []
    pushed = []
    pushIds = []
    pushResults = []
    reports = []
    updates = []
    m = useAgentMessaging()
    m.configureMessaging(deps)
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'opencode', 'target')
  })

  it('types the message when the target has no push channel', async () => {
    m.sendMessage('sender', 'target', 'hello')
    m.pump()
    await flush()
    expect(pushed).toEqual([])
    expect(typed).toHaveLength(1)
    expect(m.messages.value.at(-1)!.status).toBe('delivered')
    expect(m.messages.value.at(-1)!.route).toBeUndefined()
  })

  it('pushes instead of typing, and records which channel it used', async () => {
    pushablePanes.set('p2', 'tui-http')
    const sent = m.sendMessage('sender', 'target', 'hello')
    m.pump()
    await flush()
    expect(pushed).toHaveLength(1)
    expect(pushed[0].text).toContain('hello')
    expect(typed).toEqual([])
    const row = m.messages.value.find((x) => x.id === sent.id)!
    expect(row.status).toBe('delivered')
    expect(row.route).toBe('push:tui-http')
  })

  it('pushes to a pane the typed path would hold, and does not also type it', async () => {
    // The whole point of a channel that never touches the composer: someone is
    // typing in the pane, so isPaneIdle says no, and the message still lands.
    idlePanes.delete('p2')
    pushablePanes.set('p2', 'rewake')
    m.sendMessage('sender', 'target', 'hello')
    m.pump()
    await flush()
    expect(pushed).toHaveLength(1)
    expect(typed).toEqual([])
  })

  it('falls back to typing when the push does not land', async () => {
    pushablePanes.set('p2', 'tui-http')
    pushResult = 'declined'
    const sent = m.sendMessage('sender', 'target', 'hello')
    m.pump()
    await flush()
    expect(pushed).toHaveLength(1)
    expect(typed).toHaveLength(1)
    const row = m.messages.value.find((x) => x.id === sent.id)!
    expect(row.status).toBe('delivered')
    // The route describes how it actually got out, which was not the push.
    expect(row.route).toBeUndefined()
  })

  it('never types after an unclear push, even into a pane ready for typing', async () => {
    // 'unclear' means the CLI may still be holding the envelope in its
    // composer. Typing the same message in on top would submit it twice over,
    // concatenated — so the pane being idle is not permission to do it.
    pushablePanes.set('p2', 'tui-http')
    pushResult = 'unclear'
    const sent = m.sendMessage('sender', 'target', 'hello')
    m.pump()
    await flush()
    expect(pushed).toHaveLength(1)
    expect(typed).toEqual([])
    const row = m.messages.value.find((x) => x.id === sent.id)!
    expect(row.status).toBe('queued')
    expect(row.route).toBeUndefined()

    // The next pump decides again. The push channel is now in cooldown, and
    // the pane's own gate answers 'composer' until it shows activity — the
    // text is still in the box, and typing would paste the envelope after it.
    pushablePanes.delete('p2')
    idlePanes.delete('p2')
    holdKey = 'composer'
    m.pump()
    await flush()
    expect(typed).toEqual([])
    expect(m.messages.value.find((x) => x.id === sent.id)!.status).toBe('queued')
    expect(m.messages.value.find((x) => x.id === sent.id)!.hold).toEqual({ key: 'composer' })

    // Activity in the pane lifts the hold: the box has moved on, so the typed
    // path is safe again.
    idlePanes.add('p2')
    holdKey = null
    m.pump()
    await flush()
    expect(typed).toHaveLength(1)
    expect(m.messages.value.find((x) => x.id === sent.id)!.status).toBe('delivered')
  })

  it('fails a message whose push comes back unclear twice', async () => {
    // A composer that will not clear twice running is one the message will
    // never get through; parking the whole queue behind it forever helps
    // nobody, so the sender is told instead.
    pushablePanes.set('p2', 'tui-http')
    pushResult = 'unclear'
    const sent = m.sendMessage('sender', 'target', 'hello')
    m.pump()
    await flush()
    expect(m.messages.value.find((x) => x.id === sent.id)!.status).toBe('queued')
    m.pump()
    await flush()
    expect(pushed).toHaveLength(2)
    const row = m.messages.value.find((x) => x.id === sent.id)!
    expect(row.status).toBe('failed')
    expect(row.reason).toEqual({ key: 'push-stuck' })
    expect(typed).toEqual([])
    // Gone from the queue: a later pump has nothing left to push or type into
    // the target. The only injection is the failure notice, which goes back
    // to the sender.
    m.pump()
    await flush()
    expect(pushed).toHaveLength(2)
    expect(typed.filter((t) => t.paneId === 'p2')).toEqual([])
    expect(typed.filter((t) => t.paneId === 'p1')).toHaveLength(1)
    expect(typed[0].text).toContain('delivery failed')
  })

  it('counts unclear pushes per message, not per pane', async () => {
    // One unclear push that then lands must not leave a count behind for the
    // next message to inherit: that one starts from zero again.
    pushablePanes.set('p2', 'tui-http')
    pushResult = 'unclear'
    const first = m.sendMessage('sender', 'target', 'first')
    m.pump()
    await flush()
    expect(m.messages.value.find((x) => x.id === first.id)!.status).toBe('queued')
    pushResult = 'landed'
    m.pump()
    await flush()
    expect(m.messages.value.find((x) => x.id === first.id)!.status).toBe('delivered')

    pushResult = 'unclear'
    const second = m.sendMessage('sender', 'target', 'second')
    m.pump()
    await flush()
    // First unclear for this message: re-queued, not failed.
    expect(m.messages.value.find((x) => x.id === second.id)!.status).toBe('queued')
    m.pump()
    await flush()
    expect(m.messages.value.find((x) => x.id === second.id)!.status).toBe('failed')
  })

  it('re-queues rather than typing into a pane the typed path would hold', async () => {
    idlePanes.delete('p2')
    pushablePanes.set('p2', 'rewake')
    pushResult = 'declined'
    const sent = m.sendMessage('sender', 'target', 'hello')
    m.pump()
    await flush()
    expect(pushed).toHaveLength(1)
    expect(typed).toEqual([])
    const row = m.messages.value.find((x) => x.id === sent.id)!
    expect(row.status).toBe('queued')
    expect(row.route).toBeUndefined()

    // ... and it goes out the ordinary way once the pane is ready for typing.
    pushablePanes.delete('p2')
    idlePanes.add('p2')
    m.pump()
    await flush()
    expect(typed).toHaveLength(1)
    expect(m.messages.value.find((x) => x.id === sent.id)!.status).toBe('delivered')
  })

  it('delivers a re-queued message exactly once', async () => {
    idlePanes.delete('p2')
    pushablePanes.set('p2', 'rewake')
    pushResult = 'declined'
    m.sendMessage('sender', 'target', 'hello')
    m.pump()
    await flush()
    m.pump()
    await flush()
    expect(pushed).toHaveLength(2)
    expect(typed).toEqual([])
    // One row, still queued — nothing was duplicated into the log or the queue.
    expect(m.messages.value.filter((x) => x.content === 'hello')).toHaveLength(1)

    pushablePanes.delete('p2')
    idlePanes.add('p2')
    m.pump()
    await flush()
    expect(typed).toHaveLength(1)
  })

  it('keeps FIFO order when the first message pushes and the second types', async () => {
    pushablePanes.set('p2', 'input-file')
    m.sendMessage('sender', 'target', 'first')
    m.sendMessage('sender', 'target', 'second')
    m.pump()
    await flush()
    pushablePanes.delete('p2')
    m.pump()
    await flush()
    expect(pushed[0].text).toContain('first')
    expect(typed[0].text).toContain('second')
  })

  it('reports a cross-workspace message only once it has been pushed', async () => {
    pushablePanes.set('p2', 'input-file')
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'other/builder',
      content: 'remote hello',
    })
    await flush()
    expect(pushed).toHaveLength(1)
    expect(reports).toEqual([{ msgKey: 'k1', ok: true, reason: null }])
  })

  it('does not report a cross-workspace message that was only re-queued', async () => {
    idlePanes.delete('p2')
    pushablePanes.set('p2', 'rewake')
    pushResult = 'declined'
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'other/builder',
      content: 'remote hello',
    })
    await flush()
    expect(reports).toEqual([])
  })

  it('never pushes while delivery is paused', async () => {
    pushablePanes.set('p2', 'tui-http')
    m.pauseMessaging()
    m.sendMessage('sender', 'target', 'hello')
    m.pump()
    await flush()
    expect(pushed).toEqual([])
    expect(typed).toEqual([])
    expect(m.messages.value.at(-1)!.hold).toEqual({ key: 'paused' })
  })

  it('persists the same status transitions a typed delivery would', async () => {
    pushablePanes.set('p2', 'tui-http')
    const sent = m.sendMessage('sender', 'target', 'hello')
    m.pump()
    await flush()
    const mine = updates.filter((u) => u.uid === sent.uid).map((u) => u.status)
    expect(mine).toEqual(['delivering', 'delivered'])
  })

  it('persists a re-queued message back to queued', async () => {
    idlePanes.delete('p2')
    pushablePanes.set('p2', 'rewake')
    pushResult = 'declined'
    const sent = m.sendMessage('sender', 'target', 'hello')
    m.pump()
    await flush()
    const mine = updates.filter((u) => u.uid === sent.uid).map((u) => u.status)
    expect(mine).toEqual(['delivering', 'queued'])
  })

  describe('a push whose answer was lost', () => {
    // The backend runs a push to its end and keeps its outcome under the
    // push id for 120 s; a lost answer says nothing about whether the CLI
    // took the text. Typing it in, or pushing under a fresh id, could deliver
    // it twice.

    it('is asked about again under the same push id, never typed', async () => {
      pushablePanes.set('p2', 'tui-http')
      pushResults = ['lost', 'landed']
      const sent = m.sendMessage('sender', 'target', 'hello')
      m.pump()
      await flush()
      const row = m.messages.value.find((x) => x.id === sent.id)!
      expect(row.status).toBe('queued')
      expect(typed).toEqual([])

      // The channel has since closed (cooldown, a gate): still asked, not typed.
      pushablePanes.delete('p2')
      clock += 30_000
      m.pump()
      await flush()
      expect(pushIds).toHaveLength(2)
      expect(pushIds[1]).toBe(pushIds[0])
      expect(typed).toEqual([])
      expect(row.status).toBe('delivered')
    })

    it('a later, separate push of another message gets its own id', async () => {
      pushablePanes.set('p2', 'tui-http')
      m.sendMessage('sender', 'target', 'one')
      m.pump()
      await flush()
      m.sendMessage('sender', 'target', 'two')
      m.pump()
      await flush()
      expect(pushIds).toHaveLength(2)
      expect(pushIds[1]).not.toBe(pushIds[0])
    })

    it('past the backend\'s memory of it, is marked possibly delivered and not sent again', async () => {
      pushablePanes.set('p2', 'tui-http')
      pushResult = 'lost'
      const sent = m.sendMessage('sender', 'target', 'hello')
      m.pump()
      await flush()
      clock += 101_000
      m.pump()
      await flush()
      expect(pushIds).toHaveLength(1)
      expect(typed).toEqual([])
      const row = m.messages.value.find((x) => x.id === sent.id)!
      expect(row.status).toBe('delivered')
      expect(row.reason).toEqual({ key: 'delivery-unconfirmed' })
    })
  })
})
