/**
 * planDispatch.ts
 *
 * Pure decision logic for the plan-window "execute" dispatch received by a
 * workspace main window: payload validation and idle-pane reuse selection.
 * Kept free of App.vue state so it is unit-testable.
 */

import { CLI_AGENT_SPECS } from '@navide/plugin-shell'

export interface PlanDispatchPayload {
  workspace_path?: unknown
  rel_path?: unknown
  agent_key?: unknown
}

/** Path-string comparison normalization: trim + strip trailing slashes. */
function normalizeWorkspace(path: string): string {
  return path.trim().replace(/[\\/]+$/, '')
}

/**
 * Validate an incoming dispatch payload against this window's workspace.
 * Returns null (caller ignores the event) unless all fields are non-empty
 * strings, the workspace matches, and the agent is a known CLI agent
 * (never 'terminal').
 */
export function validatePlanDispatch(
  payload: PlanDispatchPayload | null | undefined,
  currentWorkspace: string
): { relPath: string; agentKey: string } | null {
  if (!payload) return null
  const { workspace_path, rel_path, agent_key } = payload
  if (
    typeof workspace_path !== 'string' ||
    typeof rel_path !== 'string' ||
    typeof agent_key !== 'string'
  ) {
    return null
  }
  if (!workspace_path.trim() || !rel_path.trim() || !agent_key.trim()) return null
  if (normalizeWorkspace(workspace_path) !== normalizeWorkspace(currentWorkspace)) return null
  if (!CLI_AGENT_SPECS.some((spec) => spec.agentKey === agent_key)) return null
  return { relPath: rel_path, agentKey: agent_key }
}

/** Outcome of a dispatch attempt inside the main window. */
export type PlanDispatchOutcome =
  | { ok: true }
  | { ok: false; reason: 'pane-spawn-failed' | 'pane-exited' | 'inject-failed' }

/**
 * Run a dispatch attempt and report its outcome exactly once — success,
 * explicit failure, or thrown error (reported as 'error'). Keeps the
 * report-on-every-path contract testable outside App.vue.
 */
export async function runReportedDispatch(
  attempt: () => Promise<PlanDispatchOutcome>,
  report: (ok: boolean, reason?: string) => void
): Promise<void> {
  let outcome: PlanDispatchOutcome
  try {
    outcome = await attempt()
  } catch {
    report(false, 'error')
    return
  }
  report(outcome.ok, outcome.ok ? undefined : outcome.reason)
}

/** Minimal structural view of a pane for reuse selection. */
export interface ReusablePaneCandidate {
  agentKey: string
  workspacePath: string
  /** Live terminal display status ('idle' | 'running' | 'starting' | 'exited' | 'error' | ...). */
  status: string
  /** Backend PTY session id — undefined/empty means no live session to inject into. */
  sessionId?: string
  /** A CLI sign-in pane: never reused (only the user types into one). */
  isLogin?: boolean
}

/**
 * Pick a pane the dispatch can reuse: same agent, same workspace, a live PTY
 * session, and currently 'idle' (the existing displayStatus signal: process
 * alive, agent finished its last turn, sitting at the interactive prompt).
 *
 * A whitelist, so 'awaiting' is excluded and meant to be: that pane is parked
 * on the user, and whether it holds a permission box or a question, both are
 * select widgets on Claude — a dispatched prompt typed into one would be
 * swallowed as the answer instead of starting a turn. Spawning a fresh pane is
 * the correct fallback. (Unlike inter-CLI messaging, which does let a question
 * through, this one types into the box itself, so neither kind is safe.)
 */
export function pickReusablePane<T extends ReusablePaneCandidate>(
  panes: T[],
  agentKey: string,
  workspacePath: string
): T | null {
  const ws = normalizeWorkspace(workspacePath)
  return (
    panes.find(
      (p) =>
        p.agentKey === agentKey &&
        normalizeWorkspace(p.workspacePath) === ws &&
        !!p.sessionId &&
        p.status === 'idle' &&
        !p.isLogin
    ) ?? null
  )
}
