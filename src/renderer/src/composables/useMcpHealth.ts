// /plan-mcp health in a main window's status bar (MCP outage self-heal, B2).
//
// Main probes the endpoint (src/main/mcp-health.ts) and pushes its verdict
// here. Every change is passed on to the backend (mcp.health_report), which
// restarts MCP's own listener once when the verdict turns "down" — same port,
// no pane touched — and tells the main bot's chat if that did not help. Every
// main window reports; the backend acts on the first report of a change only.
//
// The two recoveries the user can press: restartMcp (the same soft restart)
// and, past that, the whole backend, which ends every pane's PTY: the window
// confirms that one first, naming the panes it interrupts.

import { ref, type Ref } from 'vue'
import type { WsResponse } from '../../../shared/wsClient'

/** What main's probe says (src/main/mcp-health.ts; preload's McpHealthSnapshot). */
export interface McpHealthSnapshot {
  state: 'unknown' | 'ok' | 'degraded' | 'down'
  consecutiveFailures: number
  lastError: string
  checkedAt: number
}

type Send = <T = unknown>(type: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<WsResponse<T>>

/** A soft restart joins the old thread (up to 10 s) and waits for the new
 *  one (up to 15 s) — backend/agent_team_backend/mcp_server/own_loop.py. */
export const SOFT_RESTART_TIMEOUT_MS = 40_000
/** How long after a soft restart the probe is asked again. */
export const RECHECK_AFTER_MS = 2_000

export interface SoftRestartResult {
  ok: boolean
  reason?: string
}

export interface McpHealthDeps {
  send: Send
  api?: {
    getMcpHealth?: () => Promise<McpHealthSnapshot | null>
    checkMcpHealth?: () => Promise<McpHealthSnapshot | null>
    onMcpHealthChanged?: (cb: (snapshot: McpHealthSnapshot) => void) => void
  }
  setTimer?: (fn: () => void, ms: number) => unknown
}

export function useMcpHealth(deps: McpHealthDeps): {
  health: Ref<McpHealthSnapshot>
  restarting: Ref<boolean>
  restartMcp: () => Promise<SoftRestartResult>
  recheck: () => Promise<void>
} {
  const api = deps.api ?? window.agentTeam
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms))
  const health = ref<McpHealthSnapshot>({ state: 'unknown', consecutiveFailures: 0, lastError: '', checkedAt: 0 })
  const restarting = ref(false)
  let reported = ''

  async function recheck(): Promise<void> {
    const next = await api?.checkMcpHealth?.()
    if (next) apply(next)
  }

  function report(snapshot: McpHealthSnapshot): void {
    // "unknown" is main starting over on a new backend, which has heard nothing.
    if (snapshot.state === 'unknown') reported = ''
    if (snapshot.state === 'unknown' || snapshot.state === reported) return
    reported = snapshot.state
    deps.send<{ soft_restart?: SoftRestartResult }>('mcp.health_report', {
      state: snapshot.state,
      failures: snapshot.consecutiveFailures,
      error: snapshot.lastError,
    }, SOFT_RESTART_TIMEOUT_MS).then((res) => {
      // The backend restarted MCP on this report: let the probe see it now
      // rather than at its next retry.
      if (res.ok && res.payload?.soft_restart) setTimer(() => { void recheck() }, RECHECK_AFTER_MS)
    }).catch(() => {
      // Not delivered (backend restarting, say): report the state again next time.
      reported = ''
    })
  }

  function apply(snapshot: McpHealthSnapshot): void {
    health.value = snapshot
    report(snapshot)
  }

  async function restartMcp(): Promise<SoftRestartResult> {
    if (restarting.value) return { ok: false, reason: 'busy' }
    restarting.value = true
    try {
      const res = await deps.send<SoftRestartResult>('mcp.soft_restart', {}, SOFT_RESTART_TIMEOUT_MS)
      const out = res.ok && res.payload ? res.payload : { ok: false, reason: res.error?.message ?? 'failed' }
      await recheck()
      return out
    } catch (err) {
      return { ok: false, reason: String(err) }
    } finally {
      restarting.value = false
    }
  }

  api?.onMcpHealthChanged?.(apply)
  void api?.getMcpHealth?.().then((snapshot) => { if (snapshot) apply(snapshot) })

  return { health, restarting, restartMcp, recheck }
}
