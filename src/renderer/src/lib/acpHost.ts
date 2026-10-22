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
import type { AcpPort } from '../composables/useAcpSession'
import { rawReason, type MessageReason } from '../composables/useAgentMessaging'
import { ACP_PANE_DELIVERY_REFUSAL, acpMessagingHoldKey } from './acpPane'

/** What AcpPane exposes (its defineExpose, as a template ref unwraps it). */
export interface AcpPaneApi {
  spawn(opts: { cwd: string; agentKey: string; outputLogFile?: string }): Promise<void>
  kill(): Promise<void>
  interrupt(): Promise<boolean>
  /** 'starting' | 'running' | 'exited' | 'error' — the process, like a terminal's status. */
  status: string
  /** The badge word (lib/acpPane.ts acpDisplayStatus). */
  displayStatus: DisplayStatus
  setStopped(stopped: boolean): void
}

/** The fields of a pane record the host reads. */
export interface AcpHostPane {
  id: string
  agentKey: string
  workspacePath?: string
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

  /** AcpPane's template ref. */
  function setRef(id: string, el: unknown): void {
    if (el) refs.set(id, el as AcpPaneApi)
    else refs.delete(id)
  }

  /** Start the pane's agent (acp.create). Returns the pane id, as spawnPane does. */
  async function start(id: string, opts: { workspacePath?: string; agentKey: string }): Promise<string> {
    const ref = refs.get(id)
    if (!ref) return id
    let ok = false
    try {
      await ref.spawn({ cwd: opts.workspacePath ?? '', agentKey: opts.agentKey })
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

  /** A message for an ACP pane: never typed. Refused until the backend delivers to ACP panes. */
  async function deliver(_id: string, _text: string): Promise<AcpDeliverResult> {
    return { failed: rawReason(ACP_PANE_DELIVERY_REFUSAL) }
  }

  return { port: deps.port, owns, claim, setRef, start, kill, interrupt, holdKey, deliver }
}

export type AcpHost = ReturnType<typeof createAcpHost>
