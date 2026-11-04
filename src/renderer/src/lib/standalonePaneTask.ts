/**
 * standalonePaneTask.ts
 *
 * Settle a freshly spawned standalone pane's CLI startup and inject its task
 * prompt, rolling the pane back on failure. Extracted for App.vue's two
 * external-spawn paths (`ui.pane.create`, `createStandaloneRequestedPane`):
 * both create roleless manual panes, and scheduleInjection early-returns for
 * a roleless pane before its kickoff step, so a kickoffPrompt handed to
 * spawnPane is never injected. The caller must inject the task explicitly
 * instead — mirrors App.vue's dispatchPlanToPane create path. Kept free of
 * App.vue state so it is unit-testable.
 */

import { kickoffVerified, type EchoEvidence, type SubmitEvidence } from './injectEcho'
import type { KickoffVerdict } from './spawnKickoff'

/** What injectPane observed while typing the task: the same echo / submit
 *  evidence the pane path's kickoff loop judges. */
export interface StandaloneKickoffEvidence {
  echo?: EchoEvidence | null
  submit?: SubmitEvidence | null
}

export interface StandaloneTaskInjectionDeps {
  selectPane: (paneId: string, opts: { userInitiated: boolean }) => void
  sendSessionMarkerBootstrap: (paneId: string, tag: string) => Promise<boolean>
  dismissStartupDialog: (paneId: string) => Promise<boolean>
  waitForStartupActivity: (paneId: string) => Promise<boolean>
  waitForQuiet: (paneId: string, requiredQuietMs: number, timeoutMs: number) => Promise<void>
  paneAlive: (paneId: string) => boolean
  injectPane: (
    paneId: string, text: string, logLabel: string, preserveNewlines: boolean, evidence?: StandaloneKickoffEvidence,
  ) => Promise<boolean>
  onKill: (paneId: string) => Promise<void>
}

/**
 * Settle the pane's CLI startup then inject `task`. An empty task is not an
 * error — it means "open an empty pane", so nothing is injected and the pane
 * is left untouched. On injection failure the pane is killed (rollback) so
 * the caller never leaves behind a CLI with nothing to do.
 */
export async function injectStandaloneTask(
  paneId: string,
  task: string,
  logLabel: string,
  deps: StandaloneTaskInjectionDeps,
  opts: { resume?: boolean; evidence?: StandaloneKickoffEvidence } = {},
): Promise<boolean> {
  if (!task) return true

  deps.selectPane(paneId, { userInitiated: false })
  const bootstrapped = await deps.sendSessionMarkerBootstrap(paneId, `[pane ${paneId.slice(0, 8)}]`)
  if (!bootstrapped) {
    await deps.dismissStartupDialog(paneId)
    await deps.waitForStartupActivity(paneId)
  }
  // A fresh CLI prints its banner and is ready; a RESUMED one reloads the
  // transcript first, and while it does it prints nothing and accepts nothing.
  // Observed: `claude --resume` on a real session sat silent for 20-30s before
  // its prompt appeared, so the 1s/8s that suits a fresh pane injected into a
  // CLI that was not listening, saw no echo, and killed the pane as a failed
  // launch. A longer quiet threshold and a longer ceiling cover the reload.
  if (opts.resume) await deps.waitForQuiet(paneId, 3000, 60_000)
  else await deps.waitForQuiet(paneId, 1000, 8000)
  if (!deps.paneAlive(paneId)) {
    await deps.onKill(paneId)
    return false
  }
  const injected = opts.evidence
    ? await deps.injectPane(paneId, task, logLabel, true, opts.evidence)
    : await deps.injectPane(paneId, task, logLabel, true)
  if (!injected) {
    await deps.onKill(paneId)
    return false
  }
  return true
}

/** cli_open_agent's kickoff verdict for a standalone (target_workspace) spawn,
 *  judged on the evidence injectStandaloneTask collected. This path has no
 *  prompt-ready gate (it waits for quiet, not idle+quiet), so only the strict
 *  half of kickoffVerified applies: growth-only evidence stays 'unverified',
 *  which the server answers with "read cli_get_status before resending". */
export function standaloneKickoffVerdict(
  evidence: StandaloneKickoffEvidence,
  opts: { task?: string } = {},
): { kickoff: KickoffVerdict; reason?: string } {
  if (opts.task === '') return { kickoff: 'sent', reason: 'no task — the pane was left as it was' }
  if (kickoffVerified(evidence.echo ?? null, evidence.submit ?? null, false)) return { kickoff: 'sent' }
  return {
    kickoff: 'unverified',
    reason: `the task was typed but its echo/submit was not confirmed (echo=${evidence.echo ?? 'none'}, `
      + `submit=${evidence.submit ?? 'none'}) — the task may be in the pane, read its prompt before resending`,
  }
}
