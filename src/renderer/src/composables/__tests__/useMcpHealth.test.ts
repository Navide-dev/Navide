import { describe, expect, it, vi } from 'vitest'
import { useMcpHealth, type McpHealthSnapshot } from '../useMcpHealth'

function snap(state: McpHealthSnapshot['state'], failures = 0): McpHealthSnapshot {
  return { state, consecutiveFailures: failures, lastError: failures ? 'timed out' : '', checkedAt: 1 }
}

function harness(initial: McpHealthSnapshot | null = null) {
  let push: (s: McpHealthSnapshot) => void = () => {}
  const timers: (() => void)[] = []
  const sends: { type: string; payload: Record<string, unknown> }[] = []
  const send = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    sends.push({ type, payload })
    if (type === 'mcp.health_report') {
      return { id: '1', type, ok: true, payload: payload.state === 'down' ? { soft_restart: { ok: true } } : {}, error: null, timestamp: '' }
    }
    return { id: '2', type, ok: true, payload: { ok: true, port: 1 }, error: null, timestamp: '' }
  })
  const api = {
    getMcpHealth: vi.fn(async () => initial),
    checkMcpHealth: vi.fn(async () => snap('ok')),
    onMcpHealthChanged: (cb: (s: McpHealthSnapshot) => void) => { push = cb },
  }
  // The soft restart itself; Windows' refusal is McpRestartButton.test.ts.
  const mcp = useMcpHealth({ send: send as never, api, setTimer: (fn) => { timers.push(fn) }, restartSupported: true })
  return { mcp, sends, api, push: (s: McpHealthSnapshot) => push(s), timers }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('useMcpHealth', () => {
  it('passes each change of verdict to the backend once and rechecks after its soft restart', async () => {
    const h = harness()
    h.push(snap('degraded', 1))
    h.push(snap('degraded', 2))
    h.push(snap('down', 3))
    await flush()
    expect(h.sends.map((s) => s.payload.state)).toEqual(['degraded', 'down'])
    expect(h.mcp.health.value.state).toBe('down')
    expect(h.timers).toHaveLength(1)
    h.timers[0]()
    await flush()
    expect(h.api.checkMcpHealth).toHaveBeenCalled()
    expect(h.mcp.health.value.state).toBe('ok')
    expect(h.sends.at(-1)?.payload.state).toBe('ok')
  })

  it('reports again to a new backend after main started over', async () => {
    const h = harness()
    h.push(snap('down', 3))
    h.push(snap('unknown'))
    h.push(snap('down', 3))
    await flush()
    expect(h.sends.filter((s) => s.payload.state === 'down')).toHaveLength(2)
  })

  it('restartMcp asks the backend for the soft restart only, then probes', async () => {
    const h = harness(snap('down', 3))
    await flush()
    const out = await h.mcp.restartMcp()
    expect(out.ok).toBe(true)
    expect(h.sends.some((s) => s.type === 'mcp.soft_restart')).toBe(true)
    expect(h.api.checkMcpHealth).toHaveBeenCalled()
    expect(h.mcp.restarting.value).toBe(false)
  })
})
