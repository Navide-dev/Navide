// ACP panes in the main window, kept out of App.vue's terminal-pane code.
//
// The rule (user, 2026-10-23): the existing modes stay exactly as they are and
// ACP is added beside them. So an ACP pane never enters App.vue's paneRefs: it
// has its own registry here, and every existing function that must reach it
// gets one added line, "if this is an ACP pane, hand it to the host", in front
// of its unchanged body (pinned by App.tuiUnchanged.test.ts). Code that looks a
// pane up in paneRefs simply finds no ref for an ACP pane and skips it, which
// is the safe default until a feature is hooked up here on purpose.

import { reactive } from 'vue'
import type { DisplayStatus } from '@navide/terminal'
import type { AcpPort, AcpPromptResult } from '../composables/useAcpSession'
import type { MessageReason } from '../composables/useAgentMessaging'
import { acpMessagingHoldKey } from './acpPane'

/** What AcpPane exposes (its defineExpose, as a template ref unwraps it). */
export interface AcpPaneApi {
  spawn(opts: { cwd: string; agentKey: string; outputLogFile?: string }): Promise<void>
  kill(): Promise<void>
  interrupt(): Promise<boolean>
  /** Send text as a prompt (acp.prompt); how it went. */
  prompt(text: string): Promise<AcpPromptResult>
  /** 'starting' | 'running' | 'exited' | 'error' — the process, like a terminal's status. */
  status: string
  /** The badge word (lib/acpPane.ts acpDisplayStatus). */
  displayStatus: DisplayStatus
  setStopped(stopped: boolean): void
}

/** The fields of a pane record the host reads (and outputLogFile, which it sets). */
export interface AcpHostPane {
  id: string
  agentKey: string
  workspacePath?: string
  isLogin?: boolean
  origin?: string
  stageId?: unknown
  outputLogFile?: string
}

export interface AcpHostDeps {
  port: AcpPort
  /** The pane record, or undefined once it is gone. */
  pane(id: string): AcpHostPane | undefined
  /** After a start: `ok` when the agent is up (App.vue sets the pane's prep state). */
  started(id: string, ok: boolean): void
  /** An explicit interrupt stops the pane's loop, as it does for a terminal pane. */
  stopLoop(id: string): void
  persistPaneStopped(id: string, stopped: boolean): void
  /** The running pipeline's run folder, if any (App.vue's pipeline.runDir). */
  runDir(): string | undefined
  /** The pane's Agent History entry, to record its output log on. */
  history(id: string): { outputLogFile?: string } | undefined
}

/**
 * The output log a pane writes, by the same rule as App.vue's spawnPane uses
 * for a terminal pane (kept identical, pinned by acpHost.test.ts): pipeline
 * panes in their run folder, manual panes under manual/<date>/, none for a
 * sign-in pane. The backend appends an ACP pane's transcript there.
 */
export function acpOutputLogFile(
  id: string,
  pane: { isLogin?: boolean },
  opts: { workspacePath?: string; origin?: string; stageId?: unknown; agentKey: string },
  runDir: string | undefined,
): string | undefined {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return opts.workspacePath && !pane.isLogin
    ? opts.origin === 'pipeline'
      ? runDir
        ? `${opts.workspacePath}/.agent-team/${runDir}/stage-${opts.stageId}-${id.slice(0, 8)}.log`
        : `${opts.workspacePath}/.agent-team/stage-${opts.stageId}-${id.slice(0, 8)}.log`
      : `${opts.workspacePath}/.agent-team/manual/${ymd}/${opts.agentKey}-${id.slice(0, 8)}.log`
    : undefined
}

export type AcpDeliverResult = boolean | null | { failed: MessageReason } | { unconfirmed: true }

export function createAcpHost(deps: AcpHostDeps) {
  // Reactive: the template picks AcpPane or TerminalPane by owns().
  const ids = reactive(new Set<string>())
  const refs = new Map<string, AcpPaneApi>()

  /** Whether `id` is a live ACP pane. False for every other pane, always. */
  function owns(id: string): boolean {
    return ids.has(id) && deps.pane(id) !== undefined
  }

  /** Mark a new pane as an ACP pane, when it asked to be one and may be: never
   *  a plain terminal or a sign-in pane, which are interactive by nature. */
  function claim(
    id: string,
    opts: { display?: string; agentKey: string; isLogin?: boolean; loginProfileId?: string },
  ): boolean {
    if (opts.display !== 'acp' || opts.agentKey === 'terminal' || opts.isLogin || opts.loginProfileId) return false
    ids.add(id)
    return true
  }

  /** AcpPane's template ref. Unmounted with its record gone: the pane is
   *  over, so it is forgotten (a pane kept in the list stays an ACP pane). */
  function setRef(id: string, el: unknown): void {
    if (el) {
      refs.set(id, el as AcpPaneApi)
      return
    }
    refs.delete(id)
    if (deps.pane(id) === undefined) ids.delete(id)
  }

  /** Start the pane's agent (acp.create). Returns the pane id, as spawnPane does. */
  async function start(
    id: string,
    opts: { workspacePath?: string; origin?: string; stageId?: unknown; agentKey: string },
  ): Promise<string> {
    const ref = refs.get(id)
    const pane = deps.pane(id)
    if (!ref || !pane) return id
    let ok = false
    try {
      const outputLogFile = acpOutputLogFile(id, pane, opts, deps.runDir())
      pane.outputLogFile = outputLogFile
      await ref.spawn({ cwd: opts.workspacePath ?? '', agentKey: opts.agentKey, outputLogFile })
      // Agent History reads the transcript the backend appends there.
      const entry = deps.history(id)
      if (entry) entry.outputLogFile = outputLogFile
      ok = ref.status === 'running'
    } finally {
      deps.started(id, ok)
    }
    return id
  }

  /** Stop the agent, also while it is still starting. */
  async function kill(id: string, _opts: { force?: boolean } = {}): Promise<void> {
    try {
      await refs.get(id)?.kill()
    } catch (err) {
      console.warn('[acp] kill failed', id, err)
    }
  }

  /** session/cancel for the running turn; the STOP badge and the loop as for a terminal pane. */
  async function interrupt(id: string, opts: { keepLoop?: boolean } = {}): Promise<boolean> {
    const ref = refs.get(id)
    if (!ref) return false
    if (!opts.keepLoop) deps.stopLoop(id)
    try {
      const issued = await ref.interrupt()
      deps.persistPaneStopped(id, true)
      return issued !== false
    } catch {
      return false
    }
  }

  /** The messaging gate's answer for an ACP pane (its own state is exact). */
  function holdKey(id: string): string | null {
    return acpMessagingHoldKey(refs.get(id)?.displayStatus)
  }

  /**
   * The messaging layer's last step for an ACP pane (option B, 2026-10-23):
   * the queue, rate limit, ack handling and envelope are the messaging
   * layer's; the rendered envelope goes to the agent as a prompt, never typed.
   * Delivered = the backend accepted the prompt (sent, or queued behind a
   * running turn). A lost reply is unconfirmed (it may have arrived; no blind
   * resend); no session yet puts it back at the head of the queue.
   */
  async function deliver(id: string, text: string): Promise<AcpDeliverResult> {
    const ref = refs.get(id)
    if (!ref) return null
    const result = await ref.prompt(text)
    if (result === 'sent' || result === 'queued') return true
    if (result === 'unconfirmed') return { unconfirmed: true }
    if (result === '') return null
    return false
  }

  return { port: deps.port, owns, claim, setRef, start, kill, interrupt, holdKey, deliver }
}

export type AcpHost = ReturnType<typeof createAcpHost>
