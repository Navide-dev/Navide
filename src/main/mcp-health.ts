// /plan-mcp health probe (MCP outage self-heal, plan mcp-outage-self-heal B1).
//
// On 2026-11-08 every new MCP connection failed at initialize for hours while
// the backend itself answered /health fine, so nothing noticed until the user
// did. The main process now sends the endpoint an initialize of its own every
// few minutes and tells the windows how it went: ok, degraded (1–2 failures in
// a row) or down (DOWN_AFTER in a row).
//
// It never restarts anything. A whole-backend restart ends every pane's PTY
// (the backend's shutdown sweep), so that stays the user's button; the soft
// recovery — restarting only /plan-mcp's own listener thread, same port — is
// the backend's to run when a window reports "down" (mcp_server/health.py).
//
// The probe must not mistake a busy backend for a broken endpoint. It asks
// /health (served on the backend's main loop) only for the port the CLIs are
// wired to, once per backend; the initialize itself is answered on the
// listener's own loop. Anything it cannot judge — no backend yet, /health
// slow before the port is known — is "skipped", which counts for nothing.

export type McpHealthState = 'unknown' | 'ok' | 'degraded' | 'down'

export interface McpHealthSnapshot {
  state: McpHealthState
  consecutiveFailures: number
  /** Why the last probe failed, without the URL or any credential. */
  lastError: string
  /** Epoch ms of the last probe that counted, 0 before the first. */
  checkedAt: number
}

export interface McpProbeTarget {
  host: string
  port: number
  /** The main process' bearer; the backend accepts it as `client=probe`,
   *  which passes the endpoint's gate but calls no tool. */
  hostSessionToken: string
  /** Identifies one backend process, so a cached MCP port never outlives it. */
  pid: number
}

export type McpProbeResult = { kind: 'ok' } | { kind: 'failed'; error: string } | { kind: 'skipped' }

export const PROBE_INTERVAL_MS = 5 * 60_000
export const RETRY_INTERVAL_MS = 30_000
export const PROBE_TIMEOUT_MS = 10_000
export const DOWN_AFTER = 3

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 'navide-health-probe',
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'navide-health-probe', version: '1' },
  },
})

type Fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** The port /plan-mcp listens on for the CLIs: its own loop's, or the main
 *  port when it runs without one. null when /health did not say. */
async function mcpPortFrom(target: McpProbeTarget, fetchFn: Fetch, timeoutMs: number): Promise<number | null> {
  const res = await fetchFn(`http://${target.host}:${target.port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) return null
  const body = (await res.json()) as { mcp?: { port?: unknown } } | null
  const mcp = body?.mcp
  if (!mcp) return null
  return typeof mcp.port === 'number' && mcp.port > 0 ? mcp.port : target.port
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out'
    const cause = (err as { cause?: { code?: unknown } }).cause
    if (cause && typeof cause.code === 'string') return cause.code
    return err.message.slice(0, 200)
  }
  return String(err).slice(0, 200)
}

/** One probe: initialize on the CLIs' port. */
export function createMcpProber(fetchFn: Fetch = fetch as unknown as Fetch, timeoutMs = PROBE_TIMEOUT_MS) {
  let cached: { pid: number; port: number } | null = null
  return async function probe(target: McpProbeTarget | null): Promise<McpProbeResult> {
    if (!target || !target.hostSessionToken) return { kind: 'skipped' }
    if (!cached || cached.pid !== target.pid) {
      let port: number | null = null
      try {
        port = await mcpPortFrom(target, fetchFn, timeoutMs)
      } catch {
        port = null
      }
      // A slow /health is the main loop being busy, not MCP failing.
      if (port === null) return { kind: 'skipped' }
      cached = { pid: target.pid, port }
    }
    try {
      const res = await fetchFn(`http://${target.host}:${cached.port}/plan-mcp?client=probe`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${target.hostSessionToken}`,
        },
        body: INITIALIZE_BODY,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) return { kind: 'failed', error: `HTTP ${res.status}` }
      const doc = (await res.json()) as { result?: unknown; error?: { message?: unknown } } | null
      if (doc && doc.result) return { kind: 'ok' }
      const message = doc?.error?.message
      return { kind: 'failed', error: typeof message === 'string' ? message.slice(0, 200) : 'no result' }
    } catch (err) {
      return { kind: 'failed', error: describe(err) }
    }
  }
}

export interface McpHealthMonitorDeps {
  target: () => McpProbeTarget | null
  probe: (target: McpProbeTarget | null) => Promise<McpProbeResult>
  onChange: (snapshot: McpHealthSnapshot) => void
  now?: () => number
}

/** The schedule and the verdict. Every PROBE_INTERVAL_MS while healthy,
 *  RETRY_INTERVAL_MS while failing or before a first verdict; onChange fires when the state or the
 *  failure count moves. */
export function createMcpHealthMonitor(deps: McpHealthMonitorDeps) {
  const now = deps.now ?? Date.now
  let snap: McpHealthSnapshot = { state: 'unknown', consecutiveFailures: 0, lastError: '', checkedAt: 0 }
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let inFlight: Promise<McpHealthSnapshot> | null = null
  // Bumped by reset(): a probe of the backend before it must not count.
  let epoch = 0

  function set(next: McpHealthSnapshot): void {
    const moved = next.state !== snap.state || next.consecutiveFailures !== snap.consecutiveFailures
    snap = next
    if (moved) deps.onChange({ ...snap })
  }

  function schedule(): void {
    if (!running) return
    if (timer) clearTimeout(timer)
    // No verdict yet (just started, or reset() for a new backend) counts as
    // "check soon", like a failure: the long interval is for a backend
    // already seen healthy. reset() used to reschedule at the long interval and
    // so pushed the first probe 5 minutes out (0.2.49 VM).
    const delay = snap.consecutiveFailures > 0 || snap.state === 'unknown' ? RETRY_INTERVAL_MS : PROBE_INTERVAL_MS
    timer = setTimeout(() => { void checkNow() }, delay)
  }

  async function run(): Promise<McpHealthSnapshot> {
    const started = epoch
    const result = await deps.probe(deps.target())
    if (started !== epoch) return { ...snap }
    if (result.kind === 'ok') {
      set({ state: 'ok', consecutiveFailures: 0, lastError: '', checkedAt: now() })
    } else if (result.kind === 'failed') {
      const failures = snap.consecutiveFailures + 1
      set({
        state: failures >= DOWN_AFTER ? 'down' : 'degraded',
        consecutiveFailures: failures,
        lastError: result.error,
        checkedAt: now(),
      })
    }
    return { ...snap }
  }

  /** Probe now (the status bar, after a restart). Joins a probe in flight. */
  function checkNow(): Promise<McpHealthSnapshot> {
    if (!inFlight) {
      inFlight = run().finally(() => {
        inFlight = null
        schedule()
      })
    }
    return inFlight
  }

  return {
    start(firstDelayMs = RETRY_INTERVAL_MS): void {
      if (running) return
      running = true
      timer = setTimeout(() => { void checkNow() }, firstDelayMs)
    },
    stop(): void {
      running = false
      if (timer) clearTimeout(timer)
      timer = null
    },
    /** A new backend (or none): what was said about the old one no longer holds. */
    reset(): void {
      epoch++
      set({ state: 'unknown', consecutiveFailures: 0, lastError: '', checkedAt: 0 })
      schedule()
    },
    checkNow,
    snapshot: (): McpHealthSnapshot => ({ ...snap }),
  }
}
