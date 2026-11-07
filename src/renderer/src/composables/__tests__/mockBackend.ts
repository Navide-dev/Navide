import { ref, effectScope, type EffectScope } from 'vue'
import type { useBackend, WsResponse, BackendStatus } from '../useBackend'
import {
  createHostIssuePort,
  createHostTerminalDockPort,
} from '../hostSurfacePorts'
import { createHostFileAccessPort } from '../hostFileAccess'
import { createHostSettingsPort } from '../hostSettingsPort'
import type { IssuePort } from '../../ports/gitSurface'
import type { FileAccessPort } from '../../ports/fileAccess'
import type { SettingsPort } from '../../ports/settings'
import type { TerminalDockPort } from '@navide/terminal'

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

type Backend = ReturnType<typeof useBackend>

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
  const fileAccess = createHostFileAccessPort(rawBackend)
  const settingsPort = createHostSettingsPort(rawBackend)
  const issuePort = createHostIssuePort(rawBackend)
  const terminalPort = createHostTerminalDockPort(rawBackend)

  // Keep the legacy-shaped mock usable by existing composable tests while the
  // production code consumes named ports. The assigned methods are the same
  // adapters used by the Host composition roots, so tests exercise the seam
  // rather than a second fake protocol.
  Object.assign(rawBackend, fileAccess, settingsPort, issuePort, terminalPort)
  // `create` is the only name shared by the issue and terminal ports. Preserve
  // the legacy mock's ability to stand in for either consumer while production
  // compositions keep the ports separate and therefore cannot cross-route.
  ;(rawBackend as unknown as {
    create: (...args: unknown[]) => Promise<unknown>
  }).create = ((first: unknown, ...rest: unknown[]) => {
    if (typeof first === 'string') {
      return issuePort.create(first, rest[0] as string, rest[1] as string)
    }
    return terminalPort.create(first as Parameters<TerminalDockPort['create']>[0], rest[0] as number)
  })
  const backend = rawBackend as Backend & FileAccessPort & SettingsPort & IssuePort & TerminalDockPort

  return {
    backend,
    fileAccess,
    settingsPort,
    issuePort,
    terminalPort,
    status,
    autoRestart,
    emit,
    setResponse,
    setRejection,
    clearRejection,
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
