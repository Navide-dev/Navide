import { ref } from 'vue'
import { createPluginCapabilityClient, createPluginViewRuntimeClient, type PublicMethod, type Params } from '@navide/plugin-sdk'
import { fileGrant, directoryGrant, rememberOpenTarget, targetPath } from './selectionTargets'

export interface BackendResponse<T = unknown> {
  ok: boolean
  payload: T | null
  error: { code: string; message: string } | null
}

const client = createPluginCapabilityClient()
const runtime = createPluginViewRuntimeClient()
export const viewRuntime = {
  ...runtime,
  onOpenTarget(listener: (target: Record<string, string>) => void) {
    return runtime.onOpenTarget(target => { rememberOpenTarget(target); listener(target) })
  },
}
const status = ref<'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'>('connected')
const lastError = ref('')
const listeners = new Map<string, Set<(payload: unknown) => void>>()
const disposables = [viewRuntime.onBackendStatus(value => { status.value = value })]
const workspacePath = new URLSearchParams(window.location.search).get('workspace_path') ?? ''

function emit(type: string, payload: unknown): void {
  for (const listener of listeners.get(type) ?? []) listener(payload)
}

// The Host's file-change signal, named for what it is: this window reacts to
// files changing anywhere, not to a Git operation.
disposables.push(client.events.subscribe('workspace.filesChanged', () => emit('workspace.changed', { workspace_path: workspacePath })))

interface ReviewRequest { localId: string; hostId?: string; cancelled: boolean }
let review: ReviewRequest | null = null
const earlyReviewEvents: Array<{ type: string; payload: { reviewId: string; result?: unknown; message?: string } }> = []

function reviewEvent(type: string, payload: { reviewId: string; result?: unknown; message?: string }): void {
  if (!review || review.cancelled) return
  if (!review.hostId) {
    earlyReviewEvents.push({ type, payload })
    return
  }
  if (payload.reviewId !== review.hostId) return
  emit(type, { review_id: review.localId, result: payload.result, message: payload.message })
  if (type !== 'ai.review.result') review = null
}

disposables.push(
  client.events.subscribe('aiCli.reviewResult', payload => reviewEvent('ai.review.result', payload)),
  client.events.subscribe('aiCli.reviewEnd', payload => reviewEvent('ai.review.end', payload)),
  client.events.subscribe('aiCli.reviewError', payload => reviewEvent('ai.review.error', payload)),
)

async function invoke<M extends PublicMethod>(method: M, args: Params<M>): Promise<unknown> {
  return client.capabilities.invoke(method, args)
}

async function request(type: string, payload: Record<string, unknown>): Promise<unknown> {
  const path = String(payload.rel_path ?? payload.path ?? '')
  const sourceWorkspace = typeof payload.workspace_path === 'string' ? payload.workspace_path : workspacePath
  const selectionGrant = fileGrant(targetPath(sourceWorkspace, path))
  if ((type.startsWith('fs.') || type.startsWith('search.')) &&
    targetPath('', sourceWorkspace) !== targetPath('', workspacePath) && !selectionGrant) {
    throw new Error('file is not covered by a Host selection')
  }
  // A granted call is resolved by the Host against the selected file's own
  // directory, so a workspace-relative path must be narrowed to that file's
  // name; an external file already arrives as (parent directory, name).
  const selectionPath = selectionGrant ? path.slice(path.lastIndexOf('/') + 1) : path
  const selectedPath = { path: selectionPath, ...(selectionGrant ? { selectionGrant } : {}) }
  const search = {
    query: String(payload.query ?? ''), isRegex: Boolean(payload.is_regex),
    caseSensitive: Boolean(payload.case_sensitive), wholeWord: Boolean(payload.whole_word),
  }
  switch (type) {
    case 'fs.read_file': return invoke('fs.readFile', { ...selectedPath, ...(typeof payload.encoding_override === 'string' ? { encoding: payload.encoding_override } : {}) })
    case 'fs.write_file': return invoke('fs.writeFile', {
      ...selectedPath, content: String(payload.content ?? ''),
      ...(typeof payload.encoding === 'string' ? { encoding: payload.encoding } : {}),
      ...(typeof payload.expected_mtime === 'number' ? { expectedMtime: payload.expected_mtime } : {}),
    })
    case 'fs.read_image': return invoke('fs.readImage', selectedPath)
    case 'fs.list_dir': return invoke('fs.listDirectory', { path: path || '.', showHidden: Boolean(payload.show_hidden) })
    case 'fs.list_files_flat': return invoke('fs.listFilesFlat', { query: String(payload.query ?? ''), ...(typeof payload.max_results === 'number' ? { maxResults: payload.max_results } : {}) })
    case 'fs.query_files': return invoke('fs.queryFiles', {
      query: String(payload.query ?? ''),
      matchOn: payload.match_on as 'name' | 'path',
      mode: payload.mode as 'substring' | 'subsequence',
      limit: Number(payload.limit),
    })
    case 'fs.stat_path': return invoke('fs.statPath', selectedPath)
    case 'fs.mkdir': return invoke('fs.createDirectory', { path })
    case 'fs.create_file': return invoke('fs.createFile', { path, content: String(payload.content ?? '') })
    case 'fs.delete': return invoke('fs.delete', { path })
    case 'fs.rename': return invoke('fs.rename', { path: String(payload.src_path ?? ''), destination: String(payload.dst_path ?? '') })
    case 'fs.list_archive': return invoke('fs.listArchive', selectedPath)
    case 'fs.convert_office': return invoke('fs.convertOffice', selectedPath)
    case 'fs.preview_resource': return invoke('fs.previewResource', selectedPath)
    case 'search.find_in_files': return invoke('fs.findInFiles', { ...search, includes: String(payload.includes ?? ''), excludes: String(payload.excludes ?? '') })
    case 'search.replace_in_files': return invoke('fs.replaceInFiles', { ...search, replacement: String(payload.replacement ?? ''), files: payload.files as string[] })
    case 'editor.rewrite': return invoke('aiCli.rewrite', { code: String(payload.code ?? ''), instruction: String(payload.instruction ?? ''), language: String(payload.language ?? ''), model: String(payload.model ?? '') })
    case 'editor.complete': return invoke('aiCli.complete', { prefix: String(payload.prefix ?? ''), suffix: String(payload.suffix ?? ''), language: String(payload.language ?? ''), model: String(payload.model ?? '') })
    case 'ai.chat.settings.get': return invoke('aiCli.getModelPreferences', {})
    case 'ai.chat.settings.set': return invoke('aiCli.setModelPreferences', { provider: String(payload.provider ?? ''), model: String(payload.model ?? '') })
    case 'analyzer.models': return invoke('aiCli.listModels', {})
    case 'ai.review.start': {
      const pending: ReviewRequest = { localId: String(payload.review_id ?? ''), cancelled: false }
      review = pending
      earlyReviewEvents.length = 0
      const result = await client.capabilities.invoke('aiCli.reviewStart', {
        mode: payload.mode === 'branch' ? 'branch' : 'working',
        base: String(payload.base ?? ''), compare: String(payload.compare ?? ''),
      })
      pending.hostId = result.reviewId
      if (pending.cancelled || review !== pending) {
        await client.capabilities.invoke('aiCli.reviewStop', { reviewId: result.reviewId })
      } else {
        for (const event of earlyReviewEvents.splice(0)) reviewEvent(event.type, event.payload)
      }
      return { ok: true }
    }
    case 'ai.review.stop': {
      const pending = review
      if (!pending || payload.review_id !== pending.localId) return { ok: true }
      pending.cancelled = true
      review = null
      earlyReviewEvents.length = 0
      if (pending.hostId) return invoke('aiCli.reviewStop', { reviewId: pending.hostId })
      return { ok: true }
    }
    default: throw new Error(`Unmapped miniIDE operation: ${type}`)
  }
}

const backend = {
  status, lastError,
  async send<T = unknown>(type: string, payload: Record<string, unknown> = {}, _timeoutMs?: number): Promise<BackendResponse<T>> {
    try {
      return { ok: true, payload: await request(type, payload) as T, error: null }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      return { ok: false, payload: null, error: { code: typeof code === 'string' && code ? code : 'CAPABILITY_ERROR', message: error instanceof Error ? error.message : String(error) } }
    }
  },
  on(type: string, listener: (payload: unknown) => void): () => void {
    const group = listeners.get(type) ?? new Set()
    listeners.set(type, group)
    group.add(listener)
    return () => { group.delete(listener) }
  },
  async restart(): Promise<void> { /* Backend lifecycle stays with the Host. */ },
}

export function useBackend() { return backend }
export function disposeBackend(): void {
  for (const disposable of disposables) disposable.dispose()
  listeners.clear()
  earlyReviewEvents.length = 0
}
