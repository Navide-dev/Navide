import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMcpHealthMonitor,
  createMcpProber,
  DOWN_AFTER,
  PROBE_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  type McpProbeResult,
  type McpProbeTarget,
} from './mcp-health'

// Built at run time: not a real credential.
const TOKEN = ['probe', 'token', String(Date.now())].join('-')
const TARGET: McpProbeTarget = { host: '127.0.0.1', port: 4100, hostSessionToken: TOKEN, pid: 11 }

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('createMcpProber', () => {
  it('asks /health for the CLIs port once, then initializes there with the probe credential', async () => {
    const calls: { url: string; init: Record<string, unknown> }[] = []
    const fetchFn = vi.fn(async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init })
      if (url.endsWith('/health')) return response(200, { status: 'ok', mcp: { port: 4200 } })
      return response(200, { jsonrpc: '2.0', id: 'x', result: { serverInfo: { name: 'navide' } } })
    })
    const probe = createMcpProber(fetchFn)
    expect(await probe(TARGET)).toEqual({ kind: 'ok' })
    expect(await probe(TARGET)).toEqual({ kind: 'ok' })
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:4100/health',
      'http://127.0.0.1:4200/plan-mcp?client=probe',
      'http://127.0.0.1:4200/plan-mcp?client=probe',
    ])
    // The bearer travels in a header, never in the URL.
    expect(calls[1].url).not.toContain(TOKEN)
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(calls[1].init.body as string).method).toBe('initialize')
  })

  it('uses the main port when the backend serves MCP without its own loop', async () => {
    const urls: string[] = []
    const probe = createMcpProber(async (url: string) => {
      urls.push(url)
      return url.endsWith('/health')
        ? response(200, { mcp: { port: null } })
        : response(200, { result: {} })
    })
    expect(await probe(TARGET)).toEqual({ kind: 'ok' })
    expect(urls[1]).toBe('http://127.0.0.1:4100/plan-mcp?client=probe')
  })

  it('skips (not fails) while /health cannot name the port: a busy main loop is not a broken MCP', async () => {
    const probe = createMcpProber(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }) })
    expect(await probe(TARGET)).toEqual({ kind: 'skipped' })
    expect(await probe(null)).toEqual({ kind: 'skipped' })
    expect(await probe({ ...TARGET, hostSessionToken: '' })).toEqual({ kind: 'skipped' })
  })

  it('fails on an initialize error, a 5xx or a timeout, and asks /health again for a new backend', async () => {
    let mode: 'error' | '500' | 'timeout' = 'error'
    const healthCalls: string[] = []
    const probe = createMcpProber(async (url: string) => {
      if (url.endsWith('/health')) {
        healthCalls.push(url)
        return response(200, { mcp: { port: 4200 } })
      }
      if (mode === 'timeout') throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
      if (mode === '500') return response(500, null)
      return response(200, { error: { code: -32603, message: 'Error handling POST request' } })
    })
    expect(await probe(TARGET)).toEqual({ kind: 'failed', error: 'Error handling POST request' })
    mode = '500'
    expect(await probe(TARGET)).toEqual({ kind: 'failed', error: 'HTTP 500' })
    mode = 'timeout'
    expect(await probe(TARGET)).toEqual({ kind: 'failed', error: 'timed out' })
    expect(healthCalls).toHaveLength(1)
    await probe({ ...TARGET, pid: 12 })
    expect(healthCalls).toHaveLength(2)
  })
})

describe('createMcpHealthMonitor', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function harness(results: McpProbeResult[]) {
    const changes: string[] = []
    const probe = vi.fn(async () => results.shift() ?? { kind: 'ok' as const })
    const monitor = createMcpHealthMonitor({
      target: () => TARGET,
      probe,
      onChange: (s) => changes.push(`${s.state}:${s.consecutiveFailures}`),
    })
    return { monitor, probe, changes }
  }

  it(`goes degraded on a failure, down after ${DOWN_AFTER} in a row, retrying sooner while failing`, async () => {
    const fail = { kind: 'failed' as const, error: 'timed out' }
    const { monitor, probe, changes } = harness([{ kind: 'ok' }, fail, fail, fail, { kind: 'ok' }])
    monitor.start(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(changes).toEqual(['ok:0'])
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)
    expect(probe).toHaveBeenCalledTimes(1) // healthy: next one is the long interval
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS - RETRY_INTERVAL_MS)
    expect(changes.at(-1)).toBe('degraded:1')
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)
    expect(changes.slice(-2)).toEqual(['degraded:2', 'down:3'])
    expect(monitor.snapshot().lastError).toBe('timed out')
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)
    expect(changes.at(-1)).toBe('ok:0')
    monitor.stop()
  })

  it('probes a newly started backend within the first-probe delay, not the healthy interval', async () => {
    // VM 0.2.49: start() armed the 30 s first probe, then the backend came up,
    // its broadcast reset() the monitor and rescheduled it 5 minutes out — the
    // light read "Checking MCP" for 5 min 17 s after launch.
    const { monitor, probe, changes } = harness([{ kind: 'ok' }])
    monitor.start()
    monitor.reset()
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(changes).toEqual(['ok:0'])
    monitor.stop()
  })

  it('probes again soon after a backend restart even when the old one was healthy', async () => {
    const { monitor, probe } = harness([{ kind: 'ok' }, { kind: 'ok' }])
    monitor.start(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(probe).toHaveBeenCalledTimes(1)
    monitor.reset()
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)
    expect(probe).toHaveBeenCalledTimes(2)
    monitor.stop()
  })

  it('counts nothing for a skipped probe', async () => {
    const { monitor, changes } = harness([{ kind: 'skipped' }, { kind: 'skipped' }])
    await monitor.checkNow()
    await monitor.checkNow()
    expect(changes).toEqual([])
    expect(monitor.snapshot().state).toBe('unknown')
  })

  it('drops a probe of the previous backend that lands after a reset', async () => {
    let release: (r: McpProbeResult) => void = () => {}
    const monitor = createMcpHealthMonitor({
      target: () => TARGET,
      probe: () => new Promise<McpProbeResult>((r) => { release = r }),
      onChange: () => {},
    })
    const pending = monitor.checkNow()
    monitor.reset()
    release({ kind: 'failed', error: 'ECONNREFUSED' })
    await pending
    expect(monitor.snapshot()).toMatchObject({ state: 'unknown', consecutiveFailures: 0 })
  })

  it('joins a probe already in flight', async () => {
    const { monitor, probe } = harness([{ kind: 'ok' }])
    await Promise.all([monitor.checkNow(), monitor.checkNow()])
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
