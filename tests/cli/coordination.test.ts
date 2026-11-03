import { describe, expect, it, vi } from 'vitest'
import { createMessagingTurnGate, createPaneSessionPersistence, createTurnTextGate, runPipelineKickoff } from '../../src/renderer/src/lib/cliCoordination'

describe('frontend shared coordination regression', () => {
  it('settles a successful kickoff immediately without sleeping', async () => {
    const inject = vi.fn(async () => ({ injected: true, echo: 'tail' as const }))
    const sleep = vi.fn(async () => {})
    expect(await runPipelineKickoff({ inject, sleep, paneAlive: () => true })).toEqual({ sent: true, cancelled: false })
    expect(inject).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('settles a successful retry without a third injection', async () => {
    const inject = vi.fn().mockResolvedValueOnce({ injected: false, echo: null }).mockResolvedValue({ injected: true, echo: 'tail' })
    const sleep = vi.fn(async () => {})
    expect(await runPipelineKickoff({ inject, sleep, paneAlive: () => true })).toEqual({ sent: true, cancelled: false })
    expect(inject).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls).toEqual([[3000]])
  })
  it('does not resend a kickoff that reached the composer but failed to submit', async () => {
    const inject = vi.fn(async () => ({ injected: false, echo: 'growth' as const }))
    const sleep = vi.fn(async () => {})
    expect(await runPipelineKickoff({ inject, sleep, paneAlive: () => true })).toEqual({ sent: false, cancelled: false })
    expect(inject).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries only empty failed injections and stops after three attempts', async () => {
    const inject = vi.fn(async () => ({ injected: false, echo: null }))
    const sleep = vi.fn(async () => {})
    expect(await runPipelineKickoff({ inject, sleep, paneAlive: () => true })).toEqual({ sent: false, cancelled: false })
    expect(inject).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[3000], [3000]])
  })

  it('cancels a retry when the pane disappears during the delay', async () => {
    let alive = true
    const inject = vi.fn(async () => ({ injected: false, echo: null }))
    expect(await runPipelineKickoff({ inject, sleep: async () => { alive = false }, paneAlive: () => alive })).toEqual({ sent: false, cancelled: true })
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('deduplicates epoch timestamps before dispatch', () => {
    const gate = createTurnTextGate()
    expect(gate.accept('pane', 'first', '1757500000000')).toBe(true)
    expect(gate.accept('pane', 'duplicate from watcher', '1757500000000')).toBe(false)
    expect(gate.accept('pane', 'next', '1757500000001')).toBe(true)
  })

  it('accepts an older turn that arrives after a newer one, and each turn once', () => {
    // The log reader can deliver turn B before turn A (A read late, after B):
    // A's MSG blocks were dropped because its stamp was not the newest.
    const gate = createTurnTextGate()
    const a = '2026-11-03T12:24:27.492Z'
    const b = '2026-11-03T12:24:39.354Z'
    expect(gate.accept('pane', 'B: MSG to router', b)).toBe(true)
    expect(gate.accept('pane', 'A: MSG to n8n', a)).toBe(true)
    expect(gate.accept('pane', 'A: MSG to n8n', a)).toBe(false)
    expect(gate.accept('pane', 'B: MSG to router', b)).toBe(false)
  })

  it('deduplicates unreadable timestamps by text independently per pane and clears teardown state', () => {
    const gate = createTurnTextGate()
    expect(gate.accept('a', 'same reply', 'unknown')).toBe(true)
    expect(gate.accept('a', 'same reply', '')).toBe(false)
    expect(gate.accept('b', 'same reply', '')).toBe(true)
    expect(gate.accept('a', 'new reply', '')).toBe(true)
    gate.delete('a')
    expect(gate.accept('a', 'new reply', '')).toBe(true)
  })

  it('retries unconfirmed session writes after registration then caches only confirmation', async () => {
    const persist = createPaneSessionPersistence()
    const write = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    await persist('pane:session', write)
    await persist('pane:session', write)
    await persist('pane:session', write)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('bounds a permanently missing session record at eight writes without suppressing other sessions', async () => {
    const persist = createPaneSessionPersistence()
    const write = vi.fn(async () => false)
    for (let n = 0; n < 60; n++) await persist('pane:missing', write)
    expect(write).toHaveBeenCalledTimes(8)
    await persist('pane:other', write)
    expect(write).toHaveBeenCalledTimes(9)
  })

  it('does not consume persistence attempts when the caller cannot locate a pipeline stage', async () => {
    const persist = createPaneSessionPersistence()
    const missingStage = vi.fn(async () => undefined)
    for (let n = 0; n < 9; n++) await persist('pane:session', missingStage)
    const write = vi.fn(async () => true)
    await persist('pane:session', write)
    expect(write).toHaveBeenCalledOnce()
  })

  it('allows a later activity event to retry a rejected persistence write', async () => {
    const persist = createPaneSessionPersistence()
    const write = vi.fn().mockRejectedValueOnce(new Error('disconnected')).mockResolvedValue(true)
    await expect(persist('pane:session', write)).rejects.toThrow('disconnected')
    await persist('pane:session', write)
    await persist('pane:session', write)
    expect(write).toHaveBeenCalledTimes(2)
  })
})

describe('messaging turn gate', () => {
  const BOOT = Date.parse('2026-11-03T07:00:00Z')
  const TOLERANCE = 60_000
  const iso = (ms: number) => new Date(ms).toISOString()

  it('scans a turn whose log turn end arrives 300 s late, once', () => {
    vi.useFakeTimers()
    try {
      const gate = createMessagingTurnGate(BOOT)
      const ended = BOOT + 3_600_000
      vi.setSystemTime(ended + 300_000)
      expect(gate.accept('pane', 'MSG to router', iso(ended), TOLERANCE)).toBe(true)
      // The same turn reported again (hook and log, or a backend re-emit).
      expect(gate.accept('pane', 'MSG to router', iso(ended), TOLERANCE)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('scans B then a late A, and a turn replayed twice once', () => {
    vi.useFakeTimers()
    try {
      const gate = createMessagingTurnGate(BOOT)
      const a = BOOT + 3_600_000
      const b = a + 12_000
      vi.setSystemTime(b + 400_000)
      expect(gate.accept('pane', 'B: MSG to router', iso(b), TOLERANCE)).toBe(true)
      expect(gate.accept('pane', 'A: MSG to n8n', iso(a), TOLERANCE)).toBe(true)
      expect(gate.accept('pane', 'A: MSG to n8n', iso(a), TOLERANCE)).toBe(false)
      expect(gate.accept('pane', 'A: MSG to n8n', iso(a), TOLERANCE)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips turns that ended before this window started (a restart replay)', () => {
    vi.useFakeTimers()
    try {
      const gate = createMessagingTurnGate(BOOT)
      vi.setSystemTime(BOOT + 1_000)
      expect(gate.accept('pane', 'old MSG', iso(BOOT - 10 * 60_000), TOLERANCE)).toBe(false)
      expect(gate.accept('pane', 'fresh MSG', iso(BOOT + 500), TOLERANCE)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
