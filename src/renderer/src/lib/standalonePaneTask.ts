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
  /** The prompt-ready gate opened before typing (fresh panes only). */
  promptReady?: boolean
  /** Not typed at all: the gate never opened and the pane had drawn nothing. */
  untyped?: boolean
  /** injectPane answered false — its content was never seen in the box. */
  injectFailed?: boolean
  /** The pane exited before its task could be typed. */
  paneGone?: boolean
}

/** Ceiling on waiting for a fresh standalone pane's prompt. The same 30s the
 *  pane path's kickoffRequestedPane gives KICKOFF_PROMPT_READY_TIMEOUT_MS. */
export const STANDALONE_PROMPT_READY_TIMEOUT_MS = 30_000

export interface StandaloneTaskInjectionDeps {
  selectPane: (paneId: string, opts: { userInitiated: boolean }) => void
  sendSessionMarkerBootstrap: (paneId: string, tag: string) => Promise<boolean>
  dismissStartupDialog: (paneId: string) => Promise<boolean>
  waitForStartupActivity: (paneId: string) => Promise<boolean>
  waitForQuiet: (paneId: string, requiredQuietMs: number, timeoutMs: number) => Promise<void>
  /** App.vue's waitForPromptReady: idle, drawn something, quiet. */
  waitForPromptReady: (paneId: string, timeoutMs: number) => Promise<boolean>
  /** spawnKickoff.paneStillStarting for the pane as it is now. */
  paneStarting: (paneId: string) => boolean
  paneAlive: (paneId: string) => boolean
  injectPane: (
    paneId: string, text: string, logLabel: string, preserveNewlines: boolean, evidence?: StandaloneKickoffEvidence,
  ) => Promise<boolean>
  onKill: (paneId: string) => Promise<void>
}

/**
 * Settle the pane's CLI startup then inject `task`. An empty task is not an
 * error — it means "open an empty pane", so nothing is injected and the pane
 * is left untouched. Only a pane that died before its task could be typed is
 * killed (rollback). A pane that is alive but whose task was not typed or not
 * seen landing is left standing: it is a real CLI the caller can look at, and
 * killing it reported a pane that had launched as "建立失敗" (Windows VM
 * 0.2.38). Callers that still want the rollback do it themselves.
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
  //
  // A fresh pane waits on the same prompt-ready gate as the pane path. One
  // quiet second was not enough on Windows: Claude Code there had printed only
  // control sequences when the quiet window closed, the task was typed into a
  // CLI that drew nothing for 6s, and the pane was killed (Windows VM 0.2.38).
  let promptReady = false
  if (opts.resume) await deps.waitForQuiet(paneId, 3000, 60_000)
  else promptReady = await deps.waitForPromptReady(paneId, STANDALONE_PROMPT_READY_TIMEOUT_MS)
  if (!deps.paneAlive(paneId)) {
    if (opts.evidence) opts.evidence.paneGone = true
    await deps.onKill(paneId)
    return false
  }
  if (opts.evidence) opts.evidence.promptReady = promptReady
  // A CLI that has drawn nothing is still initialising and flushes its input
  // (see runKickoffAttempts): typing now would be eaten. Leave it untyped.
  if (!opts.resume && !promptReady && deps.paneStarting(paneId)) {
    if (opts.evidence) opts.evidence.untyped = true
    return false
  }
  const injected = opts.evidence
    ? await deps.injectPane(paneId, task, logLabel, true, opts.evidence)
    : await deps.injectPane(paneId, task, logLabel, true)
  if (!injected && opts.evidence) opts.evidence.injectFailed = true
  return injected
}

/** cli_open_agent's kickoff verdict for a standalone (target_workspace) spawn,
 *  judged on the evidence injectStandaloneTask collected. Growth-only evidence
 *  counts only when the prompt-ready gate opened (kickoffVerified); otherwise
 *  it stays 'unverified', which the server answers with "read cli_get_status
 *  before resending". A typed task is never 'failed': the bytes went out and
 *  a resend could run it twice. Only an untyped one is, since a resend is the
 *  right cure for it. */
export function standaloneKickoffVerdict(
  evidence: StandaloneKickoffEvidence,
  opts: { task?: string } = {},
): { kickoff: KickoffVerdict; reason?: string } {
  if (opts.task === '') return { kickoff: 'sent', reason: 'no task — the pane was left as it was' }
  if (evidence.paneGone) return { kickoff: 'failed', reason: 'the pane exited before its task could be typed' }
  if (evidence.untyped) {
    return {
      kickoff: 'failed',
      reason: `no output from the pane reached this window within ${STANDALONE_PROMPT_READY_TIMEOUT_MS}ms — `
        + 'the task was not typed (a CLI still initialising flushes its input); the pane is open, '
        + 'read cli_get_status, then resend the task to it',
    }
  }
  if (!evidence.injectFailed
    && kickoffVerified(evidence.echo ?? null, evidence.submit ?? null, evidence.promptReady ?? false)) {
    return { kickoff: 'sent' }
  }
  return {
    kickoff: 'unverified',
    reason: `the task was typed but its echo/submit was not confirmed (echo=${evidence.echo ?? 'none'}, `
      + `submit=${evidence.submit ?? 'none'}) — the task may be in the pane, read its prompt before resending`,
  }
}
