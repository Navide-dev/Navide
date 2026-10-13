import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentMessaging, _resetMessagingForTest, type MessagingDeps } from '../useAgentMessaging'

// cli_send to a restore placeholder answers `target_state: "not-opened"` and
// promises the message waits until the pane is opened. It waited in the queue
// filed under the placeholder's id — and opening the pane spawns a replacement
// under a FRESH id, releasing the old one with unregisterPane, which fails
// every queued message as 'pane-closed'. The pane came back, the message did
// not. Seen three times on 2026-10-07; each time the sender had to resend.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('a message queued for a restore placeholder survives the pane being opened', () => {
  let m: ReturnType<typeof useAgentMessaging>
  let idlePanes: Set<string>
  let delivered: Array<{ paneId: string; text: string }>
  let reports: Array<{ msgKey: string; ok: boolean; reason?: string }>

  const deps: MessagingDeps = {
    now: () => 1_000_000,
    deliver: async (paneId, text) => {
      delivered.push({ paneId, text })
      return true
    },
    isPaneIdle: (paneId) => idlePanes.has(paneId),
    reportDelivery: (msgKey, ok, reason) => {
      reports.push({ msgKey, ok, reason: typeof reason === 'string' ? reason : reason?.key })
    },
  }

  beforeEach(() => {
    _resetMessagingForTest()
    // A placeholder has no CLI behind it, so it is never idle.
    idlePanes = new Set()
    delivered = []
    reports = []
    m = useAgentMessaging()
    m.configureMessaging(deps)
  })

  function queueForPlaceholder(): void {
    m.registerPane('placeholder-id', 'claude', 'evolve-scout')
    const accepted = m.acceptRemoteMessage({
      msgKey: 'sender:mcp:abc',
      targetPaneId: 'placeholder-id',
      fromDisplay: 'Agent-Team/research',
      content: 'run the daily scout',
      rateLimit: true,
    })
    expect(accepted).toBe(true)
    m.pump()
    expect(delivered).toHaveLength(0)
  }

  it('delivers to the replacement once it is idle, and never reports the message failed', async () => {
    queueForPlaceholder()

    // What createPane does for a replacement, in order: hand over, release, claim.
    m.handOverQueue('placeholder-id', 'realized-id')
    m.unregisterPane('placeholder-id')
    expect(m.registerPane('realized-id', 'claude', 'evolve-scout')).toBe('evolve-scout')

    expect(reports.filter((r) => !r.ok)).toEqual([])
    expect(m.queuedCountFor('realized-id')).toBe(1)
    const row = m.messages.value.find((x) => x.correlationId === 'sender:mcp:abc')
    expect(row?.status).toBe('queued')

    // The resumed CLI is silent for a while; nothing goes in until it is idle.
    m.pump()
    await flush()
    expect(delivered).toHaveLength(0)

    idlePanes.add('realized-id')
    m.pump()
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].paneId).toBe('realized-id')
    expect(delivered[0].text).toContain('run the daily scout')
    expect(reports).toEqual([{ msgKey: 'sender:mcp:abc', ok: true, reason: undefined }])
  })

  it('appends behind anything already queued for the replacement id', () => {
    queueForPlaceholder()
    m.handOverQueue('placeholder-id', 'realized-id')
    m.handOverQueue('placeholder-id', 'realized-id')
    expect(m.queuedCountFor('placeholder-id')).toBe(0)
    expect(m.queuedCountFor('realized-id')).toBe(1)
  })

  it('is a no-op for a pane replaced with its own id', () => {
    queueForPlaceholder()
    m.handOverQueue('placeholder-id', 'placeholder-id')
    expect(m.queuedCountFor('placeholder-id')).toBe(1)
  })

  it('without the hand-over the release fails the message (the bug this guards)', () => {
    queueForPlaceholder()
    m.unregisterPane('placeholder-id')
    expect(reports).toEqual([{ msgKey: 'sender:mcp:abc', ok: false, reason: 'pane-closed' }])
  })

  it('App.vue hands the queue over before it releases the replaced id', () => {
    const handOver = appSource.indexOf('messaging.handOverQueue(opts.replacePaneId, id)')
    const release = appSource.indexOf('unregisterPaneMessaging(opts.replacePaneId')
    expect(handOver).toBeGreaterThan(0)
    expect(release).toBeGreaterThan(handOver)
    // Inside the same guard: replacing a pane with its own id moves nothing.
    expect(appSource.slice(handOver - 300, handOver)).toContain('opts.replacePaneId !== id')
  })
})
