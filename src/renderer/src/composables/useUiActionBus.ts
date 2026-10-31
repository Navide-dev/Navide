import { watch } from 'vue'
import { invokeCommand, listCommands } from '@navide/plugin-ui/shared'
import { currentDiagnosticSeq, takeDiagnosticsSince } from '../lib/uiDiagnostics'
import { WINDOW_INSTANCE_ID } from '../lib/windowInstanceId'

/**
 * Bridges an external MCP client's `ui.invoke.request` broadcasts into this
 * window's command registry and replies with `ui.invoke.result`. Backend
 * contract (do not change without updating the backend side):
 *   request:  { request_id, workspace_path, op, action, args, global, addressed, caller_pane_id, caller_workspace_path }
 *   response: backend.send('ui.invoke.result', { request_id, ok, result, error, warnings? })
 * `warnings` is a string array and is only present when uiDiagnostics recorded
 * something during the action (e.g. injectText resending content) — it lets
 * the caller see an in-window anomaly even though `ok` is still true.
 */

export type UiInvokeOp = 'invoke' | 'snapshot' | 'list_actions'

export interface UiInvokeRequest {
  request_id: string
  workspace_path: string
  op: UiInvokeOp
  action: string | null
  args: Record<string, unknown> | null
  global: boolean
  /** Backend sent this request to this window alone, because it hosts the pane
   *  that asked for it. Answer it without the ownership check — but still
   *  refuse the actions that act on the project on screen when it is not the
   *  one named (see WORKSPACE_SCOPED_ACTIONS), since being the right WINDOW
   *  does not make this the right PROJECT. */
  addressed?: boolean
  /** The pane the credential behind this request belongs to — taken from the
   *  credential by the backend, never from args. Empty for host / external
   *  callers. Read for PANE_PRIVATE_ACTIONS and SELF_GUARDED_ACTIONS. */
  caller_pane_id?: string
  /** The caller pane's workspace, from the backend's registry — never from
   *  args. Empty for host / external callers. Read for SELF_GUARDED_ACTIONS. */
  caller_workspace_path?: string
}

export interface UiActionBusBackend {
  send: (type: string, payload: Record<string, unknown>) => Promise<unknown>
  on: (type: string, cb: (payload: unknown) => void) => (() => void) | void
}

export interface UseUiActionBusOptions {
  backend: UiActionBusBackend
  /** Reactive-or-plain holder for this window's open workspace path. */
  currentWorkspace: { value: string }
  buildSnapshot: () => unknown | Promise<unknown>
  /** Whether this window holds `path` at all. A window can have several
   *  workspaces open with only one of them showing, so the active one is too
   *  narrow a test for ownership — and it compares raw strings, which a
   *  trailing slash or a symlinked path defeats. Defaults to that narrow test
   *  for callers (tests, plugin hosts) that have nothing better. */
  ownsWorkspace?: (path: string) => boolean
  /** Whether a pane with this id lives in this window. Used to refuse
   *  ui.window.close from a pane this window hosts. Absent: only the
   *  workspace half of that check applies. */
  hostsPane?: (paneId: string) => boolean
  /** The panes the "focused pane" commands act on right now
   *  (workbench.action.closeActivePane, workbench.action.rebuildFocusedPane).
   *  Used to refuse them when that is the caller itself. Absent: not checked. */
  focusedPaneIds?: () => string[]
  /** Whether this pane is a slot of the pipeline run in this window. Used to
   *  refuse a slot restarting, resetting or aborting the run it belongs to,
   *  which would end the caller. Absent: not checked. */
  isPipelineSlot?: (paneId: string) => boolean
  /** The workspaces this window holds, announced with ui.invoke.ready and
   *  again whenever the list changes. The backend counts a window holding an
   *  agent's workspace as that agent's own for the self-close checks. A
   *  detached group window returns []: closing it does not close the
   *  workspace. Absent: nothing is announced (older behaviour). */
  heldWorkspaces?: () => string[]
  /** The backend connection's status. When given, this window announces
   *  `ui.invoke.ready` on every transition to 'connected' (each reconnect is
   *  a new backend session): the backend sends a global request such as
   *  ui.workspace.open only to a window that announced it, because plugin and
   *  editor windows share the same server but never answer one. */
  connectionStatus?: { readonly value: string }
  /** Where window focus events arrive; defaults to `window` when there is
   *  one. A focus re-announces with focused true, so the backend prefers the
   *  window the user touched last. */
  focusTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  /** Commands only a person may run, however they are registered: this bus
   *  serves agents, so it refuses them with ui_human_only. A keystroke does
   *  not come through here. Absent: nothing extra is refused. */
  isHumanOnlyCommand?: (action: string) => boolean
  /** The window's account actions (ui.accounts.*), reached from MCP through
   *  their dedicated tools only. They are deliberately NOT in the command
   *  registry: a keybinding or anything else that runs registered commands
   *  must not start a sign-in. Each gets the request's args, the caller
   *  pane from the credential, and a signal that aborts when the backend
   *  withdraws the request (ui.invoke.cancel) or the window loses the
   *  backend. Absent (tests, plugin hosts): refused. */
  accountActions?: {
    signIn: (args: Record<string, unknown>, callerPaneId: string, signal: AbortSignal) => unknown | Promise<unknown>
    /** ui.accounts.switch (cli_account_switch). Absent: refused. */
    switch?: (args: Record<string, unknown>, callerPaneId: string, signal: AbortSignal) => unknown | Promise<unknown>
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Actions that change state in ONE project and take that project from the
 *  window's own `currentWorkspace` rather than from the request.
 *
 *  Ownership is "does this window hold the workspace", which is wider than
 *  "is it the one on screen" — so an addressed (or held-but-not-showing)
 *  request reaches a window whose currentWorkspace is a DIFFERENT project, and
 *  these actions would then spawn the pane, open Git, or push the preview into
 *  that other project and report ok. Wrong, not merely stale. Everything else
 *  is either read-only (snapshot, list_actions, ui.pane.getStatus,
 *  ui.diagnostics.read — they describe the window as it is), window-scoped
 *  (settings), or keyed by pane id, and stays on the wider rule. */
export const WORKSPACE_SCOPED_ACTIONS = new Set([
  'ui.pane.create',
  'ui.window.openGit',
  'ui.preview.show',
  'ui.pipeline.start',
  'ui.pipeline.abort',
  'ui.pipeline.next',
  'ui.pipeline.resume',
  'ui.pipeline.reset',
  'ui.pipeline.restart',
  'ui.accounts.signIn',
])

/** Prefix of the account actions: see UseUiActionBusOptions.accountActions. */
const ACCOUNT_ACTION_PREFIX = 'ui.accounts.'

/** Actions whose args.paneId names a pane's PRIVATE data — its inbox — rather
 *  than a window or a project. They run only when the caller IS that pane:
 *  `caller_pane_id` (from the credential) must be present and equal to
 *  args.paneId. Without this, any holder of a valid credential could read and
 *  consume another pane's mail by naming its id. The check lives here, not in
 *  the commands, so the registry's args-only handler signature stays as is.
 *  Deliberately a short explicit list — focus, close, getStatus and interrupt
 *  are cross-pane by design and must keep working across panes. */
const PANE_PRIVATE_ACTIONS = new Set(['ui.messaging.readIncoming', 'ui.messaging.settleRead'])

/** Pipeline actions that end the run's slot panes (restart / restart_from kill
 *  the old panes, reset and abort tear the run down). */
const PIPELINE_TEARDOWN_ACTIONS = ['ui.pipeline.abort', 'ui.pipeline.reset', 'ui.pipeline.restart', 'ui.pipeline.restart_from']

/** Workspace paths compared for the self checks. Case-folded: on macOS and
 *  Windows two spellings differing in case are one folder, and refusing a
 *  same-but-for-case folder on a case-sensitive volume errs on the safe side.
 *  The backend compares the folders themselves (device + inode). */
const sameWorkspace = (a: string, b: string): boolean =>
  !!a && !!b && normWs(a).toLowerCase() === normWs(b).toLowerCase()

/** Actions that can close something: an agent may never aim them at its own
 *  pane, its own workspace or its own window. The backend refuses these first
 *  (_self_scope_refusal); this is the same rule again in the window, for any
 *  route a request can take here. "Own" comes from caller_pane_id and
 *  caller_workspace_path, which the backend fills from the credential. */
const SELF_GUARDED_ACTIONS = new Set([
  'ui.pane.close',
  'ui.pane.reclaim',
  'ui.workspace.close',
  'ui.window.close',
  // Keybinding commands are reachable through ui_invoke too (review #534).
  'workbench.action.closeWindow',
  'workbench.action.closeActivePane',
  'workbench.action.rebuildFocusedPane',
  ...PIPELINE_TEARDOWN_ACTIONS,
])

const SELF_RECLAIM_DETAIL = 'that is your own pane — reclaiming it would end the CLI making this call'

/** Why this request would close the caller's own pane, workspace or window, or
 *  null. ui.pane.reclaim is not refused here — the caller's own id is taken out
 *  of its batch instead (see handleUiInvokeRequest). */
function selfCloseRefusal(req: Partial<UiInvokeRequest>, opts: UseUiActionBusOptions): string | null {
  const caller = req.caller_pane_id ?? ''
  if (!caller || !req.action || !SELF_GUARDED_ACTIONS.has(req.action)) return null
  const callerWs = req.caller_workspace_path ?? ''
  if (req.action === 'ui.pane.close' && namedPaneId(req.args) === caller) {
    return 'self-close: that is your own pane — an agent cannot close the pane it runs in'
  }
  if (req.action === 'ui.workspace.close') {
    const path = typeof req.args?.path === 'string' ? req.args.path : ''
    if (path && sameWorkspace(path, callerWs)) {
      return 'self-workspace-close: that is your own workspace — an agent cannot close the workspace it runs in'
    }
  }
  if (req.action === 'ui.window.close' || req.action === 'workbench.action.closeWindow') {
    const owns = opts.ownsWorkspace ?? ((path: string) => path === opts.currentWorkspace.value)
    if (opts.hostsPane?.(caller) || (callerWs && owns(callerWs))) {
      return 'self-window-close: this window holds your own pane or workspace — an agent cannot close it'
    }
  }
  if (
    (req.action === 'workbench.action.closeActivePane' || req.action === 'workbench.action.rebuildFocusedPane') &&
    (opts.focusedPaneIds?.() ?? []).includes(caller)
  ) {
    return `self-close: ${req.action} acts on the focused pane, which is your own pane right now`
  }
  // Reset ends EVERY pane in this window (onKillAll), manual ones included and
  // with no run needed, so any caller this window hosts is refused.
  if (req.action === 'ui.pipeline.reset' && opts.hostsPane?.(caller)) {
    return 'self-close: ui.pipeline.reset ends every pane in this window, your own included'
  }
  if (PIPELINE_TEARDOWN_ACTIONS.includes(req.action) && opts.isPipelineSlot?.(caller)) {
    return `self-close: ${req.action} would end the run your own pane is a slot of`
  }
  return null
}

const namedPaneId = (args: Record<string, unknown> | null | undefined): string => {
  const v = args?.paneId
  return typeof v === 'string' ? v : ''
}

const normWs = (p: string): string => p.replace(/\/+$/, '')

const reclaimIds = (args: Record<string, unknown> | null | undefined): string[] => {
  const v = args?.paneId
  return (Array.isArray(v) ? v : [v]).filter((id): id is string => typeof id === 'string' && !!id)
}

const reclaimNamesCaller = (req: Partial<UiInvokeRequest>): boolean =>
  reclaimIds(req.args).includes(req.caller_pane_id ?? '')

/** Handles a single ui.invoke.request payload; exported for direct unit testing
 *  without going through a fake backend.on subscription. */
export async function handleUiInvokeRequest(
  raw: unknown,
  opts: UseUiActionBusOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const req = raw as Partial<UiInvokeRequest> | null | undefined
  if (!req || !req.request_id || !req.op) return
  // Ownership. `global` and `addressed` requests are already single-cast to
  // this window by the backend and need no test: `global` because any window
  // will do, `addressed` because this window hosts the pane that asked — which
  // is what lets a pane drive its own window while it sits in the background
  // or after it switched project, cases the workspace test below rejects.
  // Everything else is broadcast, and only the window whose open workspace
  // matches answers — mirrors handleMcpSpawnRequest's local-ownership check in
  // App.vue for agent_spawn.request (another window silently owns any
  // mismatch), so a non-owner must stay silent rather than reply with an error.
  const owns = opts.ownsWorkspace ?? ((path: string) => path === opts.currentWorkspace.value)
  const mine = req.global || req.addressed || owns(req.workspace_path ?? '')
  if (!mine) return

  // Reaching this window is not the same as being able to act on the project
  // the request names: see WORKSPACE_SCOPED_ACTIONS. A broadcast one is left
  // to the window that does have it on screen (silence, as above); an
  // addressed one has nowhere else to go, so it is answered with the reason
  // rather than run against the wrong project or left to time out.
  const wrongProject =
    req.op === 'invoke' &&
    !req.global &&
    !!req.action &&
    WORKSPACE_SCOPED_ACTIONS.has(req.action) &&
    !!req.workspace_path &&
    normWs(req.workspace_path) !== normWs(opts.currentWorkspace.value)
  if (wrongProject && !req.addressed) return

  // A pane-private action asked for a pane other than the caller's own (or by
  // a caller with no pane at all). Answered, not ignored: the request reached
  // the right window, and the reason is what the caller needs.
  const notOwnPane =
    req.op === 'invoke' &&
    !!req.action &&
    PANE_PRIVATE_ACTIONS.has(req.action) &&
    (!req.caller_pane_id || req.caller_pane_id !== namedPaneId(req.args))

  const selfRefusal = req.op === 'invoke' ? selfCloseRefusal(req, opts) : null

  const diagnosticSeq = currentDiagnosticSeq()
  let ok = true
  let result: unknown
  let error: string | undefined
  // A handler's coded refusal (code/params on the Error it threw), handed on
  // so an MCP caller gets an error_code next to the sentence.
  let coded: { code?: string; params?: Record<string, unknown> } = {}
  try {
    if (wrongProject) {
      ok = false
      error =
        `${req.action} acts on the project this window is showing, which is ` +
        `"${opts.currentWorkspace.value}", not "${req.workspace_path}". Switch that ` +
        `window to the project first, or call from a pane in a window that has it open.`
    } else if (notOwnPane) {
      ok = false
      error =
        `${req.action} reads a pane's own inbox and can only be invoked by that pane ` +
        `for itself; the caller ${req.caller_pane_id ? `"${req.caller_pane_id}"` : 'has no pane'} ` +
        `and asked for "${namedPaneId(req.args)}".`
    } else if (selfRefusal) {
      ok = false
      error = selfRefusal
    } else if (req.op === 'invoke') {
      if (!req.action) {
        ok = false
        error = 'action is required for op "invoke"'
      } else if (opts.isHumanOnlyCommand?.(req.action)) {
        ok = false
        error = `${req.action} is a Navide plugin command; only the user can run it. An agent reaches a plugin through the agent tools it declares.`
        coded = { code: 'ui_human_only' }
      } else if (req.action.startsWith(ACCOUNT_ACTION_PREFIX)) {
        const handler = req.action === 'ui.accounts.signIn'
          ? opts.accountActions?.signIn
          : req.action === 'ui.accounts.switch' ? opts.accountActions?.switch : undefined
        if (!req.caller_pane_id) {
          ok = false
          error = `${req.action} is reachable only from a CLI pane, through its own MCP tool`
        } else if (!handler) {
          ok = false
          error = `unknown account action: ${req.action}`
        } else {
          result = await handler(req.args ?? {}, req.caller_pane_id, signal)
        }
      } else if (req.action === 'ui.pane.reclaim' && req.caller_pane_id && reclaimNamesCaller(req)) {
        // A batch can half succeed: the caller's own pane becomes one more
        // refused row and the rest are reclaimed as asked.
        const caller = req.caller_pane_id
        const rest = reclaimIds(req.args).filter((id) => id !== caller)
        const own = { paneId: caller, reason: 'self', detail: SELF_RECLAIM_DETAIL }
        if (!rest.length) {
          result = { reclaimed: [], refused: [own] }
        } else {
          const outcome = await invokeCommand(req.action, { ...(req.args ?? {}), paneId: rest })
          ok = outcome.ok
          error = outcome.error
          coded = { code: outcome.code, params: outcome.params }
          const answer = outcome.result as { reclaimed?: unknown[]; refused?: unknown[] } | undefined
          // Kept on a failure too: the caller must still learn its own id was taken out.
          const base = ok && answer ? answer : { reclaimed: [] }
          result = { ...base, refused: [...(base.refused ?? []), own] }
        }
      } else {
        const outcome = await invokeCommand(req.action, req.args ?? undefined)
        ok = outcome.ok
        result = outcome.result
        error = outcome.error
        coded = { code: outcome.code, params: outcome.params }
      }
    } else if (req.op === 'snapshot') {
      result = await opts.buildSnapshot()
    } else if (req.op === 'list_actions') {
      result = listCommands()
    } else {
      ok = false
      error = `unknown op: ${String(req.op)}`
    }
  } catch (err) {
    ok = false
    error = errorMessage(err)
  }

  const diagnostics = takeDiagnosticsSince(diagnosticSeq)
  const payload: Record<string, unknown> = { request_id: req.request_id, ok, result, error: error ?? null }
  if (!ok && coded.code) payload.code = coded.code
  if (!ok && coded.params) payload.params = coded.params
  if (diagnostics.length > 0) {
    payload.warnings = diagnostics.map((d) => `[${d.code}] ${d.message}`)
  }

  await opts.backend
    .send('ui.invoke.result', payload)
    .catch(() => { /* best-effort reply — the requester's own call just times out */ })
}

/** Subscribes to ui.invoke.request for this window's lifetime. Returns an
 *  unsubscribe function; App.vue does not call it (App.vue lives for the
 *  window's lifetime, same as its other backend.on registrations). */
export function useUiActionBus(opts: UseUiActionBusOptions): () => void {
  // In-flight account requests, so a withdrawn one can be called off
  // (review #438 LOW-1). Other actions finish on their own and are not kept.
  const inFlight = new Map<string, AbortController>()
  const off = opts.backend.on('ui.invoke.request', (raw) => {
    const req = raw as Partial<UiInvokeRequest> | null | undefined
    const id = req?.request_id
    if (!id || !req?.action?.startsWith(ACCOUNT_ACTION_PREFIX)) {
      void handleUiInvokeRequest(raw, opts)
      return
    }
    const controller = new AbortController()
    inFlight.set(id, controller)
    void handleUiInvokeRequest(raw, opts, controller.signal).finally(() => inFlight.delete(id))
  })
  const offCancel = opts.backend.on('ui.invoke.cancel', (raw) => {
    const id = (raw as { request_id?: unknown } | null | undefined)?.request_id
    if (typeof id === 'string') inFlight.get(id)?.abort()
  })
  const status = opts.connectionStatus
  if (!status) return () => { off?.(); offCancel?.() }
  // The backend that asked is gone (restart, lost link): nobody waits for the
  // answer any more.
  const stopAbortWatch = watch(
    () => status.value,
    (s) => {
      if (s === 'connected') return
      for (const controller of inFlight.values()) controller.abort()
    },
  )

  // The window may wire the bus before the state behind heldWorkspaces exists
  // (App.vue declares its workspace list further down its setup), so a read
  // that cannot be answered yet is left out rather than thrown; the watch
  // below announces again once it can be.
  const readHeld = (): string[] | undefined => {
    if (!opts.heldWorkspaces) return undefined
    try {
      return [...opts.heldWorkspaces()]
    } catch {
      return undefined
    }
  }
  const announce = (focused: boolean) => {
    if (status.value !== 'connected') return
    const payload: Record<string, unknown> = { focused, window_id: WINDOW_INSTANCE_ID }
    const held = readHeld()
    if (held) payload.workspaces = held
    opts.backend.send('ui.invoke.ready', payload)
      .catch(() => { /* best-effort — announced again on reconnect and focus */ })
  }
  const stopWatch = watch(
    () => status.value,
    (s) => { if (s === 'connected') announce(typeof document !== 'undefined' && document.hasFocus()) },
    { immediate: true },
  )
  // Re-announced on change so the backend's view of what this window holds
  // never lags an adopt or a close.
  // Created after the current setup finishes, for the same reason as readHeld.
  let stopHeldWatch: () => void = () => {}
  let disposed = false
  if (opts.heldWorkspaces) {
    void Promise.resolve().then(() => {
      if (disposed) return
      stopHeldWatch = watch(() => (readHeld() ?? []).join('\n'), () => announce(false), { immediate: true })
    })
  }
  const focusTarget = opts.focusTarget ?? (typeof window !== 'undefined' ? window : undefined)
  const onFocus = () => announce(true)
  focusTarget?.addEventListener('focus', onFocus)
  return () => {
    off?.()
    offCancel?.()
    stopAbortWatch()
    stopWatch()
    disposed = true
    stopHeldWatch()
    focusTarget?.removeEventListener('focus', onFocus)
  }
}
