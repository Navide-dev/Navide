import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  isBroadcastTarget,
  encodeReason,
  RATE_LIMIT_MAX,
  QUEUE_CAP,
  NOTICE_SENDER,
  type AgentMessage,
  type MessagingDeps,
  type PersistedMessageRow,
  type PersistedMessageUpdate,
} from '../useAgentMessaging'
import {
  MSG_ENVELOPE_PREFIX,
  MSG_NOTICE_PREFIX,
  MSG_SPAWN_FAILED_PREFIX,
  MSG_START,
  renderSpawnNotice,
  INJECT_TIMEOUT_RETRY_LIMIT,
} from '../../lib/agentMessaging'

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging', () => {
  let clock: number
  let idlePanes: Set<string>
  let delivered: Array<{ paneId: string; text: string }>
  let deliverResult: boolean
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: async (paneId, text) => {
      delivered.push({ paneId, text })
      return deliverResult
    },
    isPaneIdle: (paneId) => idlePanes.has(paneId),
  }

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    idlePanes = new Set(['p1', 'p2'])
    delivered = []
    deliverResult = true
    m = useAgentMessaging()
    m.configureMessaging(deps)
  })

  describe('name registry', () => {
    it('auto-assigns unique names per agentKey', () => {
      expect(m.registerPane('p1', 'claude')).toBe('claude-1')
      expect(m.registerPane('p2', 'claude')).toBe('claude-2')
      expect(m.registerPane('p3', 'codex')).toBe('codex-1')
    })

    it('is idempotent per pane and honors a free preferred name', () => {
      expect(m.registerPane('p1', 'claude', 'Backend A')).toBe('Backend A')
      expect(m.registerPane('p1', 'claude')).toBe('Backend A')
      // A taken preferred name keeps its base and gains a -N suffix.
      expect(m.registerPane('p2', 'claude', 'Backend A')).toBe('Backend A-2')
    })

    it('rename enforces validity and uniqueness', () => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
      expect(m.renamePane('p1', '前端組')).toBe(true)
      expect(m.nameOf('p1')).toBe('前端組')
      expect(m.paneIdOf('前端組')).toBe('p1')
      expect(m.paneIdOf('claude-1')).toBeNull()
      expect(m.renamePane('p2', '前端組')).toBe(false)
      expect(m.renamePane('p2', '   ')).toBe(false)
    })

    it('reserves the handle Navide speaks under', () => {
      // Suffixed like any other collision, in whatever casing was asked for —
      // a pane answering to it would intercept Navide's own feedback.
      expect(m.registerPane('p1', 'claude', 'Navide')).toBe('Navide-2')
      expect(m.registerPane('p2', 'codex', 'navide')).toBe('navide-2')
      expect(m.paneIdOf('Navide')).toBeNull()
      expect(m.suggestName('Navide')).toBe('Navide-3') // Navide-2 went to p1

      // A manual rename is an explicit choice, so it is refused outright.
      expect(m.renamePane('p1', 'Navide')).toBe(false)
      expect(m.renamePane('p1', 'NAVIDE')).toBe(false)
      expect(m.nameOf('p1')).toBe('Navide-2')

      // A title synced onto the handle takes a suffix instead of failing.
      m.registerPane('p3', 'codex')
      expect(m.setDerivedName('p3', 'Navide', 'codex')).toBe('Navide-3')
    })

    it('keeps a suffixed handle stable when its title is re-synced', () => {
      // setDerivedName runs on every auto-name and rename. It frees the current
      // handle before re-deriving, so a pane already parked on the suffix must
      // reclaim the SAME one — otherwise a pane titled Navide would climb
      // -2, -3, -4… once per sync.
      expect(m.registerPane('p1', 'claude', 'Navide')).toBe('Navide-2')
      expect(m.setDerivedName('p1', 'Navide', 'claude')).toBe('Navide-2')
      expect(m.setDerivedName('p1', 'Navide', 'claude')).toBe('Navide-2')
      expect(m.paneIdOf('Navide-2')).toBe('p1')
    })

    it('suggestName returns the base when free, else a suffixed variant', () => {
      m.registerPane('p1', 'claude') // claude-1
      m.renamePane('p1', '後端')
      expect(m.suggestName('前端')).toBe('前端')
      expect(m.suggestName('後端')).toBe('後端-2')
    })

    it('setDerivedName syncs the handle to a new title, suffixing collisions', () => {
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
      // Title given → handle becomes the title.
      expect(m.setDerivedName('p1', '後端', 'claude')).toBe('後端')
      expect(m.paneIdOf('後端')).toBe('p1')
      expect(m.paneIdOf('claude-1')).toBeNull()
      // Second pane titled the same → suffixed, not stolen.
      expect(m.setDerivedName('p2', '後端', 'codex')).toBe('後端-2')
      // Re-deriving the same title is idempotent (reclaims its own name).
      expect(m.setDerivedName('p1', '後端', 'claude')).toBe('後端')
      // Cleared title → back to the <agent>-N default.
      expect(m.setDerivedName('p1', null, 'claude')).toBe('claude-1')
      // Not a messaging pane (plain terminal) → null.
      expect(m.setDerivedName('ghost', '後端', 'claude')).toBeNull()
    })
  })

  describe('sendMessage validation', () => {
    beforeEach(() => {
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
    })

    it('fails on unknown target', () => {
      const msg = m.sendMessage('claude-1', 'ghost', 'hi')
      expect(msg.status).toBe('failed')
      expect(msg.reason?.key).toBe('unknown-target')
    })

    it('hands a reply to a chat sender to the channel: no failure, no notice, nothing typed', async () => {
      const updates: PersistedMessageUpdate[][] = []
      m.configureMessaging({ ...deps, persistUpdate: (u) => { updates.push(u) } })
      const msg = m.sendMessage('claude-1', 'telegram:neillu123', 'the answer', { replyTo: 'k1' })
      expect(msg.status).toBe('delivered')
      expect(msg.route).toBe('channel')
      expect(msg.reason).toBeUndefined()
      expect(updates.flat()).toContainEqual(expect.objectContaining({ uid: msg.uid, status: 'delivered' }))

      m.pump()
      await flush()
      expect(m.messages.value.filter((entry) => entry.from === NOTICE_SENDER)).toEqual([])
      expect(delivered).toEqual([])
    })

    it('still fails a target that merely looks like a chat sender', () => {
      const msg = m.sendMessage('claude-1', 'nochat:alice', 'hi')
      expect(msg.status).toBe('failed')
      expect(msg.reason?.key).toBe('unknown-target')
    })

    it('fails on self-send', () => {
      const msg = m.sendMessage('claude-1', 'claude-1', 'hi')
      expect(msg.status).toBe('failed')
      expect(msg.reason?.key).toBe('self-send')
    })

    it('rate-limits a sender→target pair independently', () => {
      idlePanes.clear() // keep everything queued
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        expect(m.sendMessage('claude-1', 'codex-1', `n${i}`).status).toBe('queued')
      }
      expect(m.sendMessage('claude-1', 'codex-1', 'over').status).toBe('failed')
      // other pair unaffected
      expect(m.sendMessage('codex-1', 'claude-1', 'x').status).toBe('queued')
    })

    it('rate limit window slides with time', () => {
      idlePanes.clear()
      for (let i = 0; i < RATE_LIMIT_MAX; i++) m.sendMessage('claude-1', 'codex-1', `n${i}`)
      clock += 61_000
      expect(m.sendMessage('claude-1', 'codex-1', 'later').status).toBe('queued')
    })

    it('caps the per-target queue', () => {
      idlePanes.clear()
      m.registerPane('p3', 'grok') // grok-1
      m.registerPane('p4', 'kimi') // kimi-1
      // Fill the target queue from multiple senders (each within its own
      // pair rate limit: QUEUE_CAP = 2 × RATE_LIMIT_MAX).
      for (const sender of ['claude-1', 'grok-1']) {
        for (let i = 0; i < RATE_LIMIT_MAX; i++) {
          expect(m.sendMessage(sender, 'codex-1', `${sender}-${i}`).status).toBe('queued')
        }
      }
      const over = m.sendMessage('kimi-1', 'codex-1', 'over')
      expect(over.status).toBe('failed')
      expect(over.reason?.key).toBe('queue-full')
    })
  })

  describe('delivery', () => {
    beforeEach(() => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
    })

    it('delivers the envelope to the target pane when idle', async () => {
      const msg = m.sendMessage('claude-1', 'codex-1', 'hello codex')
      m.pump()
      await flush()
      expect(msg.status).toBe('delivered')
      expect(delivered).toHaveLength(1)
      expect(delivered[0].paneId).toBe('p2')
      expect(delivered[0].text).toContain(`${MSG_ENVELOPE_PREFIX} claude-1`)
      expect(delivered[0].text).toContain('hello codex')
    })

    it('waits for the target to become idle', async () => {
      idlePanes.delete('p2')
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(msg.status).toBe('queued')
      expect(delivered).toHaveLength(0)
      idlePanes.add('p2')
      m.pump()
      await flush()
      expect(msg.status).toBe('delivered')
    })

    it('marks failed when injection does not verify', async () => {
      deliverResult = false
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(msg.status).toBe('failed')
      expect(msg.reason?.key).toBe('inject-failed')
    })

    // 2026-11-15 10:16: a stalled backend timed the write out and the message
    // was dropped as inject-failed with no second try.
    it('re-queues a delivery that timed out, then fails it as inject-timeout', async () => {
      const outcomes: Array<boolean | { timedOut: true }> = [{ timedOut: true }, true]
      m.configureMessaging({
        ...deps,
        deliver: async (paneId, text) => {
          delivered.push({ paneId, text })
          return outcomes.shift() ?? true
        },
      })
      const ok = m.sendMessage('claude-1', 'codex-1', 'retry me')
      m.pump()
      await flush()
      expect(ok.status).toBe('queued')
      m.pump()
      await flush()
      expect(ok.status).toBe('delivered')
      expect(delivered).toHaveLength(2)

      delivered = []
      m.configureMessaging({
        ...deps,
        deliver: async (paneId, text) => {
          delivered.push({ paneId, text })
          return { timedOut: true }
        },
      })
      const lost = m.sendMessage('claude-1', 'codex-1', 'never answered')
      for (let i = 0; i < 5; i++) {
        m.pump()
        await flush()
      }
      expect(lost.status).toBe('failed')
      expect(lost.reason?.key).toBe('inject-timeout')
      expect(delivered.filter((d) => d.paneId === 'p2')).toHaveLength(INJECT_TIMEOUT_RETRY_LIMIT)
    })

    it('delivers FIFO per target, one at a time', async () => {
      const a = m.sendMessage('claude-1', 'codex-1', 'first')
      const b = m.sendMessage('claude-1', 'codex-1', 'second')
      m.pump()
      await flush()
      m.pump()
      await flush()
      expect(a.status).toBe('delivered')
      expect(b.status).toBe('delivered')
      expect(delivered.map((d) => d.text.includes('first'))).toEqual([true, false])
    })

    it('pause holds the queue; resume flushes it', async () => {
      m.pauseMessaging()
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(msg.status).toBe('queued')
      m.resumeMessaging()
      await flush()
      expect(msg.status).toBe('delivered')
    })

    it('unregisterPane fails its queued messages', () => {
      idlePanes.clear()
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.unregisterPane('p2')
      expect(msg.status).toBe('failed')
      expect(msg.reason?.key).toBe('pane-closed')
      expect(m.paneIdOf('codex-1')).toBeNull()
    })
  })

  describe('broadcast', () => {
    it('isBroadcastTarget matches all/* case-insensitively, not real names', () => {
      expect(isBroadcastTarget('all')).toBe(true)
      expect(isBroadcastTarget('ALL')).toBe(true)
      expect(isBroadcastTarget(' * ')).toBe(true)
      expect(isBroadcastTarget('codex-1')).toBe(false)
      expect(isBroadcastTarget('')).toBe(false)
    })

    it('sendBroadcast fans out to every pane except the sender', async () => {
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
      m.registerPane('p3', 'grok') // grok-1
      idlePanes.add('p3') // harness seeds only p1/p2 as idle
      const msgs = m.sendBroadcast('claude-1', 'hello all')
      expect(msgs.map((x) => x.to).sort()).toEqual(['codex-1', 'grok-1'])
      expect(msgs.every((x) => x.status === 'queued')).toBe(true)
      m.pump()
      await flush()
      expect(delivered.map((d) => d.paneId).sort()).toEqual(['p2', 'p3'])
      expect(delivered.every((d) => d.text.includes('hello all'))).toBe(true)
    })

    it('sendBroadcast returns empty when the sender is the only pane', () => {
      m.registerPane('p1', 'claude')
      expect(m.sendBroadcast('claude-1', 'anyone?')).toEqual([])
    })

    it('broadcast still honours the per-pair rate limit', () => {
      idlePanes.clear() // keep everything queued
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        expect(m.sendBroadcast('claude-1', `n${i}`)[0].status).toBe('queued')
      }
      expect(m.sendBroadcast('claude-1', 'over')[0].status).toBe('failed')
    })
  })

  describe('uid', () => {
    it('is unique per message and shares one boot prefix', () => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
      const a = m.sendMessage('claude-1', 'codex-1', 'one')
      const b = m.sendMessage('claude-1', 'codex-1', 'two')
      expect(a.uid).toMatch(/^[0-9a-f]+:\d+$/)
      expect(a.uid).not.toBe(b.uid)
      expect(a.uid.split(':')[0]).toBe(b.uid.split(':')[0])
      expect(a.uid).toBe(`${a.uid.split(':')[0]}:${a.id}`)
    })

    it('stays stable across the whole message lifecycle', async () => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      const uid = msg.uid
      m.pump()
      await flush()
      expect(msg.status).toBe('delivered')
      expect(msg.uid).toBe(uid)
    })
  })

  describe('reply correlation', () => {
    beforeEach(() => {
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
    })

    it('hands the correlation id to the target in the envelope', async () => {
      const req = m.sendMessage('claude-1', 'codex-1', 'please review')
      m.pump()
      await flush()
      expect(delivered[0].text).toContain(`re: ${req.uid}`)
    })

    it('links a reply that echoes the correlation id back', () => {
      const req = m.sendMessage('claude-1', 'codex-1', 'please review')
      const reply = m.sendMessage('codex-1', 'claude-1', 'done', { replyTo: req.uid })
      expect(reply.inReplyTo).toBe(req.uid)
    })

    it('leaves a reply carrying no correlation id unlinked, and delivers it as before', async () => {
      m.sendMessage('claude-1', 'codex-1', 'please review')
      const reply = m.sendMessage('codex-1', 'claude-1', 'done')
      expect(reply.inReplyTo).toBeUndefined()
      m.pump()
      await flush()
      m.pump()
      await flush()
      expect(reply.status).toBe('delivered')
    })

    it('ignores a correlation id this window never handed out', () => {
      const reply = m.sendMessage('codex-1', 'claude-1', 'done', { replyTo: 'nobody:1' })
      expect(reply.inReplyTo).toBeUndefined()
      expect(reply.status).toBe('queued')
    })

    it('links a rejected reply too, so the log still shows what it answered', () => {
      const req = m.sendMessage('claude-1', 'codex-1', 'please review')
      const reply = m.sendMessage('codex-1', 'ghost', 'done', { replyTo: req.uid })
      expect(reply.status).toBe('failed')
      expect(reply.inReplyTo).toBe(req.uid)
    })

    it('forgets correlation ids once they age past the ack window', () => {
      const req = m.sendMessage('claude-1', 'codex-1', 'please review')
      clock += 29 * 60_000
      m.pump()
      expect(
        m.sendMessage('codex-1', 'claude-1', 'in time', { replyTo: req.uid }).inReplyTo,
      ).toBe(req.uid)

      clock += 2 * 60_000
      m.pump()
      expect(
        m.sendMessage('codex-1', 'claude-1', 'too late', { replyTo: req.uid }).inReplyTo,
      ).toBeUndefined()
    })
  })

  describe('persistence', () => {
    let appended: PersistedMessageRow[][]
    let updated: PersistedMessageUpdate[][]
    let cleared: string[][]

    function persistingDeps(): MessagingDeps {
      return {
        ...deps,
        persistAppend: (rows) => { appended.push(rows) },
        persistUpdate: (updates) => { updated.push(updates) },
        persistClear: (keep) => { cleared.push(keep) },
      }
    }

    beforeEach(() => {
      appended = []
      updated = []
      cleared = []
      m.configureMessaging(persistingDeps())
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
    })

    it('appends every logged row in the backend shape', () => {
      const msg = m.sendMessage('claude-1', 'codex-1', 'hello')
      expect(appended.flat()).toEqual([
        {
          uid: msg.uid,
          created_at: msg.createdAt,
          status: 'queued',
          sender: 'claude-1',
          recipient: 'codex-1',
          content: 'hello',
          reason: undefined,
          delivered_at: undefined,
          remote: undefined,
          remote_workspace: undefined,
          sender_agent: 'claude',
          recipient_agent: 'codex',
        },
      ])
    })

    it('stores the reply link under the column name, never the camelCase field', () => {
      // Unlike `hold`, the link does not stop being true when the row stops
      // being live — a recipient reading its own mail over MCP has to see what
      // a message answers after a reload too. It travels as `reply_to`: the
      // store's columns are snake_case, and a stray `inReplyTo` key would be
      // dropped on the floor by the backend's _normalize.
      const req = m.sendMessage('claude-1', 'codex-1', 'please review')
      const reply = m.sendMessage('codex-1', 'claude-1', 'done', { replyTo: req.uid })
      expect(reply.inReplyTo).toBe(req.uid)
      const rows = appended.flat()
      for (const row of rows) expect(row).not.toHaveProperty('inReplyTo')
      expect(rows.find((r) => r.uid === reply.uid)?.reply_to).toBe(req.uid)
      expect(rows.find((r) => r.uid === req.uid)?.reply_to).toBeUndefined()
    })

    it('stores no correlation id for a message between two panes of this window', () => {
      // Nothing routes it, so no such key is ever minted and both ends already
      // share this row. An invented one would be quoted back in a reply that
      // could never thread.
      const msg = m.sendMessage('claude-1', 'codex-1', 'hello')
      expect(appended.flat().find((r) => r.uid === msg.uid)?.correlation_id).toBeUndefined()
    })

    it('stores the routing key as the correlation id of an inbound message', () => {
      // The whole point of gap two: the recipient's persisted row carries the
      // very string the sender got back from cli_send, so the two can name one
      // message.
      m.registerPane('p3', 'claude', 'reader')
      m.acceptRemoteMessage({
        msgKey: 'pz:mcp:abc',
        targetPaneId: 'p3',
        fromDisplay: 'alpha/sender',
        content: 'run the tests',
      })
      const row = appended.flat().find((r) => r.content === 'run the tests')
      expect(row?.correlation_id).toBe('pz:mcp:abc')
    })

    it('accepts one broadcast of a message once, however many times it arrives', () => {
      // A window holding two sockets to the backend (a connect() race) gets
      // every broadcast twice. The second copy carries the same msg_key, and
      // it must not become a second queued row — that is one message injected
      // twice into the pane, and two rows in the log under one correlation id.
      m.registerPane('p3', 'claude', 'reader')
      const args = {
        msgKey: 'pz:mcp:dup',
        targetPaneId: 'p3',
        fromDisplay: 'alpha/sender',
        content: 'run the tests',
      }
      expect(m.acceptRemoteMessage(args)).toBe(true)
      expect(m.acceptRemoteMessage(args)).toBe(false)
      expect(appended.flat().filter((r) => r.correlation_id === 'pz:mcp:dup')).toHaveLength(1)
      expect(m.queuedCountFor('p3')).toBe(1)
    })

    it('updates on the delivering → delivered transition', async () => {
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(updated.flat()).toEqual([
        { uid: msg.uid, status: 'delivering' },
        { uid: msg.uid, status: 'delivered', delivered_at: msg.deliveredAt },
      ])
    })

    it('updates on failure with the reason', () => {
      const msg = m.sendMessage('claude-1', 'ghost', 'hi')
      expect(updated.flat()).toEqual([
        { uid: msg.uid, status: 'failed', reason: encodeReason(msg.reason!) },
      ])
    })

    it('clearMessageLog forwards the kept statuses', () => {
      m.sendMessage('claude-1', 'ghost', 'hi')
      m.clearMessageLog()
      expect(cleared).toEqual([['queued', 'delivering']])
    })

    it('everything still works with no persist deps configured', async () => {
      m.configureMessaging(deps) // the plain deps, no persistence
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(msg.status).toBe('delivered')
      m.hydrateLog([
        { uid: 'boot:1', created_at: 1, status: 'queued', sender: 'a', recipient: 'b', content: 'x' },
      ])
      expect(m.messages.value.find((x) => x.uid === 'boot:1')?.status).toBe('failed')
      m.clearMessageLog()
      expect(appended).toEqual([])
      expect(updated).toEqual([])
      expect(cleared).toEqual([])
    })
  })

  describe('hydrateLog', () => {
    const snapshot: PersistedMessageRow[] = [
      {
        uid: 'oldboot:1',
        created_at: 10,
        status: 'delivered',
        sender: 'claude-1',
        recipient: 'codex-1',
        content: 'done',
        delivered_at: 12,
      },
      {
        uid: 'oldboot:2',
        created_at: 20,
        status: 'failed',
        sender: 'claude-1',
        recipient: 'ghost',
        content: 'nope',
        reason: encodeReason({ key: 'unknown-target', params: { to: 'ghost' } }),
        remote: 'outbound',
        remote_workspace: '/w/other',
      },
    ]

    it('restores rows into the log, snake_case mapped back', () => {
      m.hydrateLog(snapshot)
      expect(m.messages.value).toHaveLength(2)
      expect(m.messages.value[0]).toMatchObject({
        uid: 'oldboot:1',
        from: 'claude-1',
        to: 'codex-1',
        content: 'done',
        status: 'delivered',
        createdAt: 10,
        deliveredAt: 12,
      })
      expect(m.messages.value[1]).toMatchObject({
        uid: 'oldboot:2',
        status: 'failed',
        reason: { key: 'unknown-target', params: { to: 'ghost' } },
        remote: 'outbound',
        remoteWorkspace: '/w/other',
      })
    })

    it('round-trips `kind`, so a restored notice is still known to be one', () => {
      const appended: PersistedMessageRow[] = []
      m.configureMessaging({ ...deps, persistAppend: (rows) => { appended.push(...rows) } })
      m.registerPane('p1', 'claude') // claude-1
      m.sendMessage('claude-1', 'ghost', 'bounce me')

      // The failed send, then the notice it produced — as the store sees them.
      expect(appended.map((r) => r.kind)).toEqual([undefined, 'notice'])

      // A fresh window restoring that snapshot must not parse text to work out
      // which row Navide wrote.
      _resetMessagingForTest()
      m.configureMessaging(deps)
      m.hydrateLog(appended)

      expect(m.messages.value.map((x) => x.kind)).toEqual([undefined, 'notice'])
    })

    it('round-trips the thread, so a reload does not orphan a reply', () => {
      m.hydrateLog([
        { uid: 'oldboot:1', created_at: 10, status: 'delivered', sender: 'a', recipient: 'b', content: 'ask' },
        {
          uid: 'oldboot:2',
          created_at: 20,
          status: 'delivered',
          sender: 'b',
          recipient: 'a',
          content: 'answer',
          reply_to: 'oldboot:1',
          correlation_id: 'pz:mcp:abc',
        },
      ])
      expect(m.messages.value[1].inReplyTo).toBe('oldboot:1')
      expect(m.messages.value[1].correlationId).toBe('pz:mcp:abc')
      // A row that was neither a reply nor routed keeps both empty.
      expect(m.messages.value[0].inReplyTo).toBeUndefined()
      expect(m.messages.value[0].correlationId).toBeUndefined()
    })

    it('coerces restored in-flight rows to failed WITHOUT persisting the coercion', async () => {
      const updates: PersistedMessageUpdate[][] = []
      m.configureMessaging({ ...deps, persistUpdate: (u) => { updates.push(u) } })
      m.registerPane('p2', 'codex') // codex-1: a live target for the restored row
      m.hydrateLog([
        { uid: 'oldboot:3', created_at: 30, status: 'queued', sender: 'claude-1', recipient: 'codex-1', content: 'a' },
        { uid: 'oldboot:4', created_at: 40, status: 'delivering', sender: 'claude-1', recipient: 'codex-1', content: 'b' },
      ])
      expect(m.messages.value.map((x) => x.status)).toEqual(['failed', 'failed'])
      expect(m.messages.value[0].reason).toEqual({ key: 'window-reloaded' })
      // FINDING 1: the store is GLOBAL. Writing the coercion back would stamp
      // `failed` over a row another live window is still about to deliver.
      expect(updates).toEqual([])
      // Restored rows are history: nothing was enqueued, so nothing delivers.
      m.pump()
      await flush()
      expect(delivered).toEqual([])
      expect(m.messages.value.map((x) => x.status)).toEqual(['failed', 'failed'])
    })

    it('keeps rows this window already logged', () => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
      const live = m.sendMessage('claude-1', 'codex-1', 'live')
      m.hydrateLog(snapshot)
      expect(m.messages.value.map((x) => x.uid)).toEqual(['oldboot:1', 'oldboot:2', live.uid])
      expect(live.status).toBe('queued')
    })

    // FINDING 2: a snapshot that already contains a row this window is still
    // delivering must not replace the live object — the restored copy carries a
    // NEW local id, so envelopes/queues would point at an orphan and the real
    // delivery would never show up in the log.
    it('a live row whose uid is in the snapshot keeps its id and still delivers', async () => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
      const live = m.sendMessage('claude-1', 'codex-1', 'live')
      // The 200 ms append flush beat the snapshot response back: the row is in
      // the store as `queued` while it is still deliverable here.
      m.hydrateLog([
        { uid: live.uid, created_at: live.createdAt, status: 'queued', sender: 'claude-1', recipient: 'codex-1', content: 'live' },
      ])
      const row = m.messages.value.find((x) => x.uid === live.uid)
      expect(m.messages.value.filter((x) => x.uid === live.uid)).toHaveLength(1)
      // Same local id ⇒ still the object envelopes/queues are keyed by.
      expect(row?.id).toBe(live.id)
      expect(row?.status).toBe('queued')

      m.pump()
      await flush()
      expect(delivered).toHaveLength(1)
      expect(m.messages.value.find((x) => x.uid === live.uid)?.status).toBe('delivered')
      // pumpPane mutated the row that is actually in the log, not an orphan.
      expect(live.status).toBe('delivered')
    })
  })

  describe('hold reasons', () => {
    beforeEach(() => {
      m.registerPane('p1', 'claude', 'alpha')
      m.registerPane('p3', 'qwen', 'gamma') // not in idlePanes
    })

    it('annotates the queue head with the target gate and the rest by position', () => {
      m.configureMessaging({ ...deps, idleHoldKey: () => 'mid-turn' })
      m.sendMessage('alpha', 'gamma', 'one')
      m.sendMessage('alpha', 'gamma', 'two')
      m.sendMessage('alpha', 'gamma', 'three')

      m.pump()

      expect(m.messages.value.map((msg) => msg.hold)).toEqual([
        { key: 'mid-turn' },
        { key: 'behind', n: 1 },
        { key: 'behind', n: 2 },
      ])
    })

    it('falls back to a generic reason when the host supplies no gate detail', () => {
      m.sendMessage('alpha', 'gamma', 'one')
      m.pump()

      expect(m.messages.value[0].hold).toEqual({ key: 'busy' })
    })

    it('reports the pause rather than a stale gate reason', () => {
      m.configureMessaging({ ...deps, idleHoldKey: () => 'mid-turn' })
      m.sendMessage('alpha', 'gamma', 'one')
      m.pump()
      expect(m.messages.value[0].hold).toEqual({ key: 'mid-turn' })

      m.pauseMessaging()

      expect(m.messages.value[0].hold).toEqual({ key: 'paused' })
    })

    it('clears the hold once the message leaves the queue', async () => {
      m.sendMessage('alpha', 'p2-none', 'fails immediately')
      idlePanes.add('p3')
      m.sendMessage('alpha', 'gamma', 'goes through')
      m.pump()
      await flush()

      // Failed and delivered rows show an outcome, so a hold would contradict
      // it. Three rows: the two sends plus the failure notice sent back to
      // alpha, which was delivered too.
      expect(m.messages.value.map((msg) => msg.hold)).toEqual([undefined, undefined, undefined])
    })

    it('reuses the hold object across pumps, so an idle queue stops re-rendering', () => {
      m.configureMessaging({ ...deps, idleHoldKey: () => 'mid-turn' })
      m.sendMessage('alpha', 'gamma', 'one')
      m.pump()
      const first = m.messages.value[0].hold

      m.pump()
      m.pump()

      // Identity, not equality: pump() runs every second and a fresh object
      // each tick would invalidate the log panel for no visible change.
      expect(m.messages.value[0].hold).toBe(first)
    })

    it('explains an outbound cross-workspace message that is waiting on a report', () => {
      m.configureMessaging({
        ...deps,
        routeRemote: async () => ({ ok: true, targetWorkspacePath: '/ws/other' }),
      })
      m.sendMessage('alpha', 'other/beta', 'across the boundary')

      expect(m.messages.value[0].hold).toEqual({ key: 'remote-ack' })
    })
  })

  describe('vendor stamping', () => {
    it('records each side\'s CLI on a local send', () => {
      m.registerPane('p1', 'claude', 'alpha')
      m.registerPane('p2', 'codex', 'beta')

      const msg = m.sendMessage('alpha', 'beta', 'hi')

      expect(msg.fromAgent).toBe('claude')
      expect(msg.toAgent).toBe('codex')
    })

    it('persists and restores the vendors', () => {
      const rows: PersistedMessageRow[][] = []
      m.configureMessaging({ ...deps, persistAppend: (r) => { rows.push(r) } })
      m.registerPane('p1', 'claude', 'alpha')
      m.registerPane('p2', 'codex', 'beta')
      m.sendMessage('alpha', 'beta', 'hi')

      expect(rows[0][0]).toMatchObject({ sender_agent: 'claude', recipient_agent: 'codex' })

      _resetMessagingForTest()
      m.configureMessaging(deps)
      m.hydrateLog(rows[0])

      expect(m.messages.value[0]).toMatchObject({ fromAgent: 'claude', toAgent: 'codex' })
    })

    it('takes the remote sender\'s CLI from the event and the target\'s from the registry', () => {
      m.registerPane('p2', 'codex', 'reviewer')

      m.acceptRemoteMessage({
        msgKey: 'k1',
        targetPaneId: 'p2',
        fromDisplay: 'other/analysis',
        fromAgent: 'claude',
        content: 'hi',
      })

      expect(m.messages.value[0]).toMatchObject({ fromAgent: 'claude', toAgent: 'codex' })
    })

    it('leaves the vendor unset when the sender is not a pane', () => {
      m.registerPane('p2', 'codex', 'reviewer')

      m.acceptRemoteMessage({
        msgKey: 'k1',
        targetPaneId: 'p2',
        fromDisplay: 'an external client',
        content: 'hi',
      })

      expect(m.messages.value[0].fromAgent).toBeUndefined()
      expect(m.messages.value[0].toAgent).toBe('codex')
    })

    it('forgets a pane\'s vendor when it unregisters', () => {
      m.registerPane('p1', 'claude', 'alpha')
      m.registerPane('p2', 'codex', 'beta')
      m.unregisterPane('p2')
      m.registerPane('p2', 'grok', 'beta')

      expect(m.sendMessage('alpha', 'beta', 'hi').toAgent).toBe('grok')
    })
  })

  describe('retryMessage', () => {
    beforeEach(() => {
      m.registerPane('p1', 'claude', 'alpha')
    })

    it('re-sends a failed message once the target exists', () => {
      const original = m.sendMessage('alpha', 'beta', 'hello')
      expect(original.status).toBe('failed')

      m.registerPane('p2', 'codex', 'beta')
      const retried = m.retryMessage(original.id)

      expect(retried).not.toBeNull()
      expect(retried?.status).toBe('queued')
      expect(retried?.id).not.toBe(original.id)
      // The original stays as the historical record of what failed.
      expect(original.status).toBe('failed')
      // Original, the failure notice it produced, and the retry.
      expect(m.messages.value).toHaveLength(3)
    })

    it('spends the pair budget, so retrying cannot bypass the rate limit', () => {
      m.registerPane('p2', 'codex', 'beta')
      for (let i = 0; i < RATE_LIMIT_MAX; i++) m.sendMessage('alpha', 'beta', `msg ${i}`)
      const blocked = m.sendMessage('alpha', 'beta', 'over the limit')
      expect(blocked.status).toBe('failed')

      const retried = m.retryMessage(blocked.id)

      expect(retried?.status).toBe('failed')
      expect(retried?.reason?.key).toBe('rate-limit')
    })

    it('ignores an unknown id and anything that did not fail', () => {
      m.registerPane('p2', 'codex', 'beta')
      const queued = m.sendMessage('alpha', 'beta', 'still going')

      expect(m.retryMessage(queued.id)).toBeNull()
      expect(m.retryMessage(9999)).toBeNull()
      expect(m.messages.value).toHaveLength(1)
    })
  })

  describe('delivery failure feedback', () => {
    beforeEach(() => {
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
    })

    const notices = (): readonly AgentMessage[] =>
      m.messages.value.filter((entry) => entry.from === 'Navide')

    it('tells the sending pane why its message failed', async () => {
      m.sendMessage('claude-1', 'ghost', 'please review src/main.ts')

      expect(notices()).toHaveLength(1)
      expect(notices()[0].to).toBe('claude-1')

      m.pump()
      await flush()
      expect(delivered).toHaveLength(1)
      expect(delivered[0].paneId).toBe('p1')
      // Injected verbatim: the first line is what tells an agent this bounced
      // rather than arrived, so no envelope may wrap it.
      expect(delivered[0].text.startsWith(`${MSG_NOTICE_PREFIX} — to: ghost`)).toBe(true)
      expect(delivered[0].text).not.toContain(MSG_ENVELOPE_PREFIX)
      // Nothing invites a reply: `Navide` is not an address.
      expect(delivered[0].text).not.toContain(MSG_START)
      // English regardless of the user's UI locale — the agent reads this.
      expect(delivered[0].text).toContain('reason: No pane named “ghost”')
      expect(delivered[0].text).toContain('please review src/main.ts')
    })

    it('injects spawn feedback the same way — verbatim, as a notice', async () => {
      // What App.vue's sendSpawnFeedback does; the wiring itself is guarded in
      // App.spawnAdvisories.test.ts.
      const sent = m.sendMessage(
        NOTICE_SENDER,
        'claude-1',
        renderSpawnNotice('failed', '名稱已被使用'),
        { kind: 'notice' },
      )
      expect(sent.kind).toBe('notice')

      m.pump()
      await flush()
      expect(delivered[0].paneId).toBe('p1')
      expect(delivered[0].text).toBe(`${MSG_SPAWN_FAILED_PREFIX} — 名稱已被使用`)
      expect(delivered[0].text).not.toContain(MSG_ENVELOPE_PREFIX)
      expect(delivered[0].text).not.toContain(MSG_START)
    })

    it('goes through the ordinary idle gate, not a private path', async () => {
      idlePanes.delete('p1')
      m.sendMessage('claude-1', 'ghost', 'hi')
      m.pump()
      await flush()
      expect(delivered).toHaveLength(0)
      expect(notices()[0].status).toBe('queued')

      idlePanes.add('p1')
      m.pump()
      await flush()
      expect(notices()[0].status).toBe('delivered')
    })

    it('does not answer a bounced notice with another notice', async () => {
      deliverResult = false
      m.sendMessage('claude-1', 'ghost', 'hi')
      m.pump()
      await flush()

      expect(notices()).toHaveLength(1)
      expect(notices()[0].status).toBe('failed')
      expect(notices()[0].reason?.key).toBe('inject-failed')
    })

    it('says nothing when the sender is not a registered CLI pane', () => {
      // A plain terminal pane never registers a handle, and neither does an
      // external MCP client — there is no PTY of ours to write feedback into.
      m.sendMessage('terminal-1', 'ghost', 'hi')
      expect(notices()).toHaveLength(0)
    })

    it('says nothing when the sending pane closed before the failure', () => {
      idlePanes.clear()
      m.sendMessage('claude-1', 'codex-1', 'hi')
      m.unregisterPane('p1')
      m.unregisterPane('p2')
      expect(notices()).toHaveLength(0)
    })

    it('notifies when the target closes and the sender is still open', () => {
      idlePanes.clear()
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.unregisterPane('p2')

      expect(msg.reason?.key).toBe('pane-closed')
      expect(notices()).toHaveLength(1)
      expect(notices()[0].to).toBe('claude-1')
    })

    it('carries its own rate-limit pair, so it cannot flood or starve the sender', () => {
      idlePanes.clear()
      for (let i = 0; i < RATE_LIMIT_MAX + 2; i++) m.sendMessage('claude-1', 'ghost', `n${i}`)

      // Navide→claude-1 is a pair of its own: the overflow notices are dropped
      // (and never answered with further notices)…
      expect(notices().filter((n) => n.status === 'queued')).toHaveLength(RATE_LIMIT_MAX)
      expect(notices().filter((n) => n.reason?.key === 'rate-limit')).toHaveLength(2)
      // …while the sender's own budget is untouched.
      expect(m.sendMessage('claude-1', 'codex-1', 'still allowed').status).toBe('queued')
    })
  })
})
