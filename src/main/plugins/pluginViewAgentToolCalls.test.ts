import { describe, expect, it, vi } from 'vitest'
import { parseViewAgentToolReply, ViewAgentToolCalls } from './pluginViewAgentToolCalls'

describe('ViewAgentToolCalls', () => {
  it('settles a call with the reply that carries its callId, from its own instance only', async () => {
    const calls = new ViewAgentToolCalls()
    let sent: { callId: string; name: string; arguments: Record<string, unknown>; timeoutMs: number } | undefined
    const outcome = calls.call('view-1', (payload) => { sent = payload; return true }, 'hello_greet', { who: 'x' }, Date.now() + 5_000)
    expect(sent).toMatchObject({ name: 'hello_greet', arguments: { who: 'x' } })
    expect(sent!.timeoutMs).toBeGreaterThan(4_000)
    expect(calls.resolve('view-2', { callId: sent!.callId, ok: true, result: 1 })).toBe(false)
    expect(calls.resolve('view-1', { callId: 'other', ok: true, result: 1 })).toBe(false)
    expect(calls.resolve('view-1', { callId: sent!.callId, ok: true, result: { message: 'hi' } })).toBe(true)
    await expect(outcome).resolves.toEqual({ kind: 'result', result: { message: 'hi' } })
    expect(calls.inFlight()).toBe(0)
    // A second reply to a settled call is ignored.
    expect(calls.resolve('view-1', { callId: sent!.callId, ok: true, result: 2 })).toBe(false)
  })

  it('reports the view error, the deadline, a refused send and a closed view', async () => {
    vi.useFakeTimers()
    try {
      const calls = new ViewAgentToolCalls()
      const sends: string[] = []
      const failed = calls.call('v', (p) => { sends.push(p.callId); return true }, 'hello_greet', {}, Date.now() + 1_000)
      expect(calls.resolve('v', { callId: sends[0], ok: false, error: { code: 'NOT_READY', message: 'later' } })).toBe(true)
      await expect(failed).resolves.toEqual({ kind: 'failed', code: 'NOT_READY', message: 'later' })

      const late = calls.call('v', (p) => { sends.push(p.callId); return true }, 'hello_greet', {}, Date.now() + 1_000)
      vi.advanceTimersByTime(1_001)
      await expect(late).resolves.toEqual({ kind: 'timeout' })
      expect(calls.resolve('v', { callId: sends[1], ok: true, result: null })).toBe(false)

      await expect(calls.call('v', () => false, 'hello_greet', {}, Date.now() + 1_000)).resolves.toEqual({ kind: 'not-delivered' })

      const closed = calls.call('v', () => true, 'hello_greet', {}, Date.now() + 1_000)
      const other = calls.call('w', () => true, 'hello_greet', {}, Date.now() + 1_000)
      calls.cancelInstance('v')
      await expect(closed).resolves.toEqual({ kind: 'view-closed' })
      expect(calls.inFlight()).toBe(1)
      calls.cancelInstance('w')
      await expect(other).resolves.toEqual({ kind: 'view-closed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts only the exact reply shapes', () => {
    expect(parseViewAgentToolReply({ callId: 'c', ok: true, result: [1] })).toEqual({ callId: 'c', ok: true, result: [1] })
    expect(parseViewAgentToolReply({ callId: 'c', ok: false, error: { code: 'E_X', message: 'm' } })).toEqual({ callId: 'c', ok: false, error: { code: 'E_X', message: 'm' } })
    for (const bad of [
      null, 'x', { ok: true, result: 1 }, { callId: '', ok: true, result: 1 }, { callId: 'c', ok: true },
      { callId: 'c', ok: true, result: 1, extra: 1 }, { callId: 'c', ok: false }, { callId: 'c', ok: false, error: 'boom' },
      { callId: 'c', ok: false, error: { code: 'lower', message: 'm' } }, { callId: 'c', ok: false, error: { code: 'E', message: 1 } },
    ]) expect(parseViewAgentToolReply(bad)).toBeNull()
  })
})
