import { ref, effectScope, type EffectScope } from 'vue'
import type { TerminalDockPort } from '../../ports/terminalDock'
import type { PortResponse } from '@navide/plugin-ui/shared'

// Lightweight stand-in for useBackend() used by composable tests. It records
// outgoing send() calls, lets a test preset per-type responses, and exposes
// emit() to simulate backend broadcasts to `on()` subscribers. No real
// WebSocket — every composable that takes `ReturnType<typeof useBackend>` can
// be driven deterministically.

export interface SentRecord {
  type: string
  payload: Record<string, unknown>
  timeoutMs?: number
}

type BackendStatus = TerminalDockPort['status']['value']
type MockAgentTeam = {
  openEditorWindow?: (args: Record<string, unknown>) => Promise<unknown> | unknown
  reportTerminalSelection?: (selection: string) => void
  saveClipboardImage?: (args: { bytes: Uint8Array; mediaType: string }) =>
    Promise<{ ok?: boolean; path?: string } | null> | { ok?: boolean; path?: string } | null
}
type WsResponse<T = unknown> = PortResponse<T> & {
  id: string
  type: string
  timestamp: string
}
type Backend = TerminalDockPort & {
  wsUrl: ReturnType<typeof ref<string>>
  httpUrl: ReturnType<typeof ref<string>>
  lastError: ReturnType<typeof ref<string>>
  send<T = unknown>(type: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<WsResponse<T>>
  on(type: string, cb: (payload: unknown) => void): () => void
}

export function createMockBackend(initialStatus: BackendStatus = 'connected') {
  const status = ref<BackendStatus>(initialStatus)
  const wsUrl = ref('')
  const httpUrl = ref('')
  const lastError = ref('')
  const shell = ref('')

  const autoRestart = ref<{ attempt: number; max: number; reason: string } | null>(null)

  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const responses = new Map<string, WsResponse>()
  const rejections = new Map<string, Error>()
  const sent: SentRecord[] = []
  // Runs inside send(type) before it answers: lets a test model a backend
  // event that reaches the window ahead of that request's response.
  const beforeResponse = new Map<string, () => void>()

  function on(type: string, cb: (p: unknown) => void): () => void {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    set.add(cb)
    return () => set!.delete(cb)
  }

  /** Simulate a backend broadcast to every `on(type)` subscriber. */
  function emit(type: string, payload: unknown): void {
    listeners.get(type)?.forEach((cb) => cb(payload))
  }

  async function send<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<WsResponse<T>> {
    sent.push({ type, payload, timeoutMs })
    const rejection = rejections.get(type)
    if (rejection) throw rejection
    beforeResponse.get(type)?.()
    const preset = responses.get(type)
    if (preset) return preset as WsResponse<T>
    return { id: 't', type, ok: true, payload: null, error: null, timestamp: '' } as WsResponse<T>
  }

  /**
   * Make `send(type)` REJECT, the way the real transport does when the socket
   * is down ('ws not open') or a request times out.
   *
   * Without this the mock could only ever resolve, so every `catch` branch in
   * every composable was unreachable in tests — the disconnected path was
   * uncovered across the whole renderer, which is exactly the path that only
   * runs when something has already gone wrong.
   */
  function setRejection(type: string, error: Error | string = 'ws not open'): void {
    rejections.set(type, typeof error === 'string' ? new Error(error) : error)
  }

  /** Undo setRejection, e.g. to model a reconnect mid-test. */
  function clearRejection(type: string): void {
    rejections.delete(type)
  }

  function setResponse<T>(
    type: string,
    payload: T,
    opts: {
      ok?: boolean
      error?: { code: string; message: string; details?: Record<string, unknown> }
    } = {}
  ): void {
    const ok = opts.ok ?? true
    responses.set(type, {
      id: 't',
      type,
      ok,
      payload: ok ? (payload as unknown) : null,
      error: opts.error ?? null,
      timestamp: ''
    })
  }

  const rawBackend = { status, wsUrl, httpUrl, lastError, shell, autoRestart, send, on } as unknown as Backend
  const agentTeam = () => (window as Window & { agentTeam?: MockAgentTeam }).agentTeam
  const request = <T = unknown>(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number) =>
    timeoutMs === undefined
      ? rawBackend.send<T>(type, payload)
      : rawBackend.send<T>(type, payload, timeoutMs)
  const terminalPort: TerminalDockPort = {
    status,
    shell,
    autoRestart,
    input: (sessionId, data, timeoutMs, opts) => request('terminal.input', { terminal_session_id: sessionId, data, ...(opts?.human ? { human: true } : {}) }, timeoutMs),
    create: (payload, timeoutMs) => request('terminal.create', {
      pane_id: payload.paneId,
      create_generation: payload.createGeneration,
      agent_key: payload.agentKey,
      command: payload.command,
      cwd: payload.cwd,
      env: payload.env,
      cols: payload.cols,
      rows: payload.rows,
      metadata: payload.metadata,
      output_log_file: payload.outputLogFile,
      login_profile_id: payload.loginProfileId,
      is_login: payload.isLogin,
      replaces_terminal_id: payload.replacesTerminalId,
      ...(payload.quotaTransactionId ? { quota_transaction_id: payload.quotaTransactionId } : {}),
      ...(payload.quotaOriginalPaneId ? { quota_original_pane_id: payload.quotaOriginalPaneId } : {}),
    }, timeoutMs),
    cancelCreate: (paneId, createGeneration) => request('terminal.create.cancel', {
      pane_id: paneId,
      create_generation: createGeneration,
    }),
    reattach: (sessionIds, cols, rows) => request('terminal.reattach', {
      terminal_session_ids: sessionIds,
      cols,
      rows,
    }),
    resize: (sessionId, cols, rows) => request('terminal.resize', {
      terminal_session_id: sessionId,
      cols,
      rows,
    }),
    interrupt: (sessionId) => request('terminal.interrupt', { terminal_session_id: sessionId }),
    kill: (sessionId, force) => request('terminal.kill', { terminal_session_id: sessionId, force }),
    redraw: (sessionId, cols, rows) => request('terminal.redraw', {
      terminal_session_id: sessionId,
      cols,
      rows,
    }),
    onOutput: (callback) => rawBackend.on('terminal.output', callback as unknown as (payload: unknown) => void),
    onExit: (callback) => rawBackend.on('terminal.exit', callback as unknown as (payload: unknown) => void),
    listFiles: (workspacePath, query, maxResults) => request('fs.list_files', {
      workspace_path: workspacePath,
      query,
      max_results: maxResults,
    }),
    listAgentPanes: () => request('terminal.list_agent_panes'),
    statPath: (path, timeoutMs) => request('fs.stat_path', { path }, timeoutMs),
    getHomeDirectory: async () => '/tmp',
    openFile: async ({ workspacePath, filepath, fileWorkspace, line }) => {
      const res = await agentTeam()?.openEditorWindow?.({
        workspace_path: workspacePath,
        filepath,
        ...(fileWorkspace ? { file_ws: fileWorkspace } : {}),
        ...(line === undefined ? {} : { line }),
      })
      return res?.ok === true
    },
    openExternal: async () => {},
    reportSelection: (selection) => { agentTeam()?.reportTerminalSelection?.(selection) },
    saveClipboardImage: async (image) => {
      const save = agentTeam()?.saveClipboardImage
      if (!save) return null
      try {
        const bytes = new Uint8Array(await image.arrayBuffer())
        const result = await save({ bytes, mediaType: image.type })
        return result?.ok && result.path ? result.path : null
      } catch {
        return null
      }
    },
    diagnostic: (category, message, level) => { void request('client.diagnostic', { category, message, level }) },
  }
  Object.assign(rawBackend, terminalPort)
  const backend = rawBackend

  return {
    backend,
    terminalPort,
    status,
    autoRestart,
    emit,
    setResponse,
    setRejection,
    clearRejection,
    beforeResponse,
    sent,
  }
}

/** Run a composable inside its own effect scope so `watch`/`onScopeDispose`
 *  behave as they would in a component. Returns the composable result plus a
 *  `stop()` to trigger cleanup (clears intervals/listeners). */
export function withScope<T>(fn: () => T): { result: T; scope: EffectScope } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, scope }
}

/** Flush pending microtasks + a macrotask so awaited send() chains settle. */
export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}
