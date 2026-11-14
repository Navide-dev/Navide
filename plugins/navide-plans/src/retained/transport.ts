/** Private ports for the retained Plans UI. No renderer selects a Host root. */
import { plansBackend } from '../backend'
import { needsChunkedWrite, readWholeDocument, writeDocumentChunked } from '../planPaging'

export interface PlansTransport {
  send<T = unknown>(type: string, payload?: Record<string, unknown>): Promise<{ payload: T }>
  on(type: string, listener: (payload: unknown) => void): () => void
}

const fileMethods: Record<string, string> = {
  'fs.read_file': 'plans.read_document',
  'fs.write_file': 'plans.write_document',
  'fs.list_dir': 'plans.list_directory',
  'fs.delete': 'plans.delete',
  'history.preserve': 'plans.history_preserve',
  'history.list': 'plans.history_list',
  'history.read': 'plans.history_read',
  'history.restore': 'plans.history_restore',
}

export const plansTransport: PlansTransport = {
  async send<T>(type: string, payload: Record<string, unknown> = {}): Promise<{ payload: T }> {
    const name = fileMethods[type]
    if (!name) throw new Error(`Unsupported Plans transport operation: ${type}`)
    // The legacy interface supplies workspace_path; the package boundary
    // deliberately drops it. The Host binds the root to the calling instance.
    const { workspace_path: _workspacePath, ...args } = payload
    const result = type === 'fs.read_file' || type === 'history.read'
      // A document (or a version of one) is returned page by page when it
      // does not fit one response.
      ? await readWholeDocument(plansBackend.call.bind(plansBackend) as never, name as 'plans.read_document' | 'plans.history_read', 'content', args)
      : type === 'fs.write_file' && typeof args.content === 'string' && needsChunkedWrite(args.content)
        // Too large for one request: stage it in parts, then commit atomically.
        ? await writeDocumentChunked(
          plansBackend.call.bind(plansBackend) as never,
          String(args.rel_path),
          args.content,
          typeof args.expected_mtime === 'number' ? args.expected_mtime : undefined,
          typeof args.expected_sha256 === 'string' ? args.expected_sha256 : undefined,
        )
        : await plansBackend.call(name, args as never)
    return { payload: (type === 'fs.delete' ? { ok: true } : result) as T }
  },
  on(type, listener) {
    if (type !== 'plans.changed') throw new Error(`Unsupported Plans event: ${type}`)
    const subscription = plansBackend.subscribe(type, listener)
    void subscription.ready.catch(() => undefined)
    return () => subscription.dispose()
  },
}

interface ExecutionResult {
  workspace_path: string
  rel_path: string
  ok: boolean
  reason?: string
}

interface ShellBridge {
  callHostAction?(action: string, args: Record<string, unknown>): Promise<{
    ok: boolean
    result?: unknown
    error?: { code: string; message?: string }
  }>
  on?(event: string, listener: (value: unknown) => void): () => void
}

function shellBridge(): ShellBridge {
  return (globalThis as typeof globalThis & { nav?: ShellBridge }).nav ?? {}
}

async function shellAction<T>(args: Record<string, unknown>): Promise<T> {
  const call = shellBridge().callHostAction
  if (!call) throw new Error('Plans shell is unavailable')
  const response = await call('plans.shell', args)
  if (!response.ok) throw new Error(response.error?.message ?? response.error?.code ?? 'Plans shell action failed')
  return response.result as T
}

export const plansShell = {
  dispatchPlanExecution(args: { workspace_path: string; rel_path: string; agent_key: string }) {
    return shellAction<{ delivered: boolean }>({ operation: 'dispatch_execution', rel_path: args.rel_path, agent_key: args.agent_key })
  },
  openPath(relPath: string) {
    return shellAction<{ ok: boolean; error?: string }>({ operation: 'open_path', rel_path: relPath })
  },
  onPlanExecutionResult(listener: (result: ExecutionResult) => void): () => void {
    return shellBridge().on?.('plans.execution-result', (value) => listener(value as ExecutionResult)) ?? (() => undefined)
  },
}
