import { watch } from 'vue'
import { invokeCommand, listCommands } from '@navide/plugin-ui/shared'
import { currentDiagnosticSeq, takeDiagnosticsSince } from '../lib/uiDiagnostics'

/**
 * Bridges an external MCP client's `ui.invoke.request` broadcasts into this
 * window's command registry and replies with `ui.invoke.result`. Backend
 * contract (do not change without updating the backend side):
 *   request:  { request_id, workspace_path, op, action, args, global, addressed, caller_pane_id }
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
   *  callers. Read only for PANE_PRIVATE_ACTIONS. */
  caller_pane_id?: string
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
const WORKSPACE_SCOPED_ACTIONS = new Set([
  'ui.pane.create',
  'ui.window.openGit',
  'ui.preview.show',
  'ui.pipeline.start',
  'ui.pipeline.abort',
  'ui.pipeline.next',
  'ui.pipeline.resume',
  'ui.pipeline.reset',
  'ui.pipeline.restart',
])

/** Actions whose args.paneId names a pane's PRIVATE data — its inbox — rather
 *  than a window or a project. They run only when the caller IS that pane:
 *  `caller_pane_id` (from the credential) must be present and equal to
 *  args.paneId. Without this, any holder of a valid credential could read and
 *  consume another pane's mail by naming its id. The check lives here, not in
 *  the commands, so the registry's args-only handler signature stays as is.
 *  Deliberately a short explicit list — focus, close, getStatus and interrupt
 *  are cross-pane by design and must keep working across panes. */
const PANE_PRIVATE_ACTIONS = new Set(['ui.messaging.readIncoming', 'ui.messaging.settleRead'])

const namedPaneId = (args: Record<string, unknown> | null | undefined): string => {
  const v = args?.paneId
  return typeof v === 'string' ? v : ''
}

const normWs = (p: string): string => p.replace(/\/+$/, '')

/** Handles a single ui.invoke.request payload; exported for direct unit testing
 *  without going through a fake backend.on subscription. */
export async function handleUiInvokeRequest(
  raw: unknown,
  opts: UseUiActionBusOptions,
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

  const diagnosticSeq = currentDiagnosticSeq()
  let ok = true
  let result: unknown
  let error: string | undefined
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
    } else if (req.op === 'invoke') {
      if (!req.action) {
        ok = false
        error = 'action is required for op "invoke"'
      } else {
        const outcome = await invokeCommand(req.action, req.args ?? undefined)
        ok = outcome.ok
        result = outcome.result
        error = outcome.error
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
  const off = opts.backend.on('ui.invoke.request', (raw) => { void handleUiInvokeRequest(raw, opts) })
  const status = opts.connectionStatus
  if (!status) return () => { off?.() }

  const announce = (focused: boolean) => {
    if (status.value !== 'connected') return
    opts.backend.send('ui.invoke.ready', { focused })
      .catch(() => { /* best-effort — announced again on reconnect and focus */ })
  }
  const stopWatch = watch(
    () => status.value,
    (s) => { if (s === 'connected') announce(typeof document !== 'undefined' && document.hasFocus()) },
    { immediate: true },
  )
  const focusTarget = opts.focusTarget ?? (typeof window !== 'undefined' ? window : undefined)
  const onFocus = () => announce(true)
  focusTarget?.addEventListener('focus', onFocus)
  return () => {
    off?.()
    stopWatch()
    focusTarget?.removeEventListener('focus', onFocus)
  }
}
