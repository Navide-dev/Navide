/**
 * Host-private Plans-to-core port inventory and adapter composition.
 *
 * This module is intentionally not exported through the plugin SDK. A packaged
 * child can address only the validated `port`/`operation` pair below; it never
 * receives a filesystem handle, WebSocket, route table, terminal object, or
 * runtime identity. The supervisor supplies the authenticated runtime to the
 * adapter context after resolving the child request's parent origin.
 */

import {
  appendFileSync,
  constants,
  mkdirSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch as watchPath,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { shell } from 'electron'
import type {
  BackendRuntimeContext,
  JsonValue,
  WireRequestId,
} from './pluginBackendSupervisor'
import {
  MAX_BACKEND_BRIDGE_CHUNK_BYTES,
  MAX_BACKEND_BRIDGE_QUEUE_BYTES,
  MAX_BACKEND_BRIDGE_RANGE_BYTES,
  MAX_BACKEND_BRIDGE_RESULT_BYTES,
} from './pluginBackendLimits'
import {
  canonicalExistingDirectory,
  resolveWorkspaceRelativePath,
  workspaceMutationPathError,
} from './workspacePathPolicy'
import { PLAN_DOC_DIRS, isPlanDocumentChangePath } from './plansDirectories'

export const PLANS_BRIDGE_PORTS = [
  'filesystem',
  'workspace-storage',
  'terminal',
  'agent-messaging',
  'routes',
  'streams',
  'spawn',
  'shell',
  // First-party navide.browser only (pluginFirstPartyBackends.ts). Plans
  // never declares it.
  'web',
] as const

export type PlansBridgePort = (typeof PLANS_BRIDGE_PORTS)[number]

export type PlansBridgeErrorCode =
  | 'CAPABILITY_DENIED'
  | 'METHOD_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'WORKSPACE_SCOPE_VIOLATION'
  | 'USER_CANCELLED'
  | 'TIMEOUT'
  | 'RESOURCE_LIMIT'
  | 'RESULT_TOO_LARGE'
  | 'BACKEND_UNAVAILABLE'
  | 'PLUGIN_STOPPING'
  | 'INTERNAL_ERROR'

export class PlansBridgeError extends Error {
  readonly code: PlansBridgeErrorCode

  constructor(code: PlansBridgeErrorCode, message?: string) {
    super(message)
    this.name = 'PlansBridgeError'
    this.code = code
  }
}

export interface PlansBridgeOrigin {
  kind: 'call' | 'subscription'
  requestId: WireRequestId
}

export interface PlansBridgeRequest {
  id: WireRequestId
  origin: PlansBridgeOrigin
  port: PlansBridgePort
  operation: string
  arguments: JsonValue
}

export interface PlansBridgeContext {
  readonly runtime: BackendRuntimeContext
  /** Host-bound workspace path; never serialized into the child request. */
  readonly workspacePath?: string
  /** Canonical Host-authorized Plans repository root; never payload-selected. */
  readonly authorizedPlanRoot?: string
  readonly requestId: WireRequestId
  readonly signal: AbortSignal
  /** Emit one bounded internal stream event back to the child. */
  emit(event: string, payload: JsonValue): void
}

export interface PlansFilesystemPort {
  readFile(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  /** Read `length` bytes at `offset`; returns `{ data_base64, size, mtime, eof }`.
   * Unlike `readFile` a file of any size can be read by paging ranges. */
  readRange(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  writeFile(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  /** Chunked write, step 1..n: append one part (`upload_id`, in-order `offset`,
   * `data_base64` of at most one range) to the staging file of `rel_path`. */
  writePart(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  /** Chunked write, last step: atomically swap the staged bytes in, with the
   * same `expected_mtime` conflict check `writeFile` has. */
  writeCommit(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  /** Discard a staged chunked write. */
  writeAbort(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  listDir(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  listFilesFlat(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  statPath(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  delete(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  rename(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  resolveRoot(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  watch(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

/** Host-owned filesystem service used by the production bridge. The service
 * receives a Host-selected workspace root and relative arguments; package
 * payloads never choose the root and the bridge context is never serialized. */
export type PlansFilesystemServiceOperation =
  | 'fs.read_file'
  | 'fs.read_range'
  | 'fs.write_file'
  | 'fs.write_part'
  | 'fs.write_commit'
  | 'fs.write_abort'
  | 'fs.list_dir'
  | 'fs.stat_workspace_path'
  | 'fs.delete'
  | 'fs.rename'

export interface PlansFilesystemService {
  call(
    operation: PlansFilesystemServiceOperation,
    payload: Record<string, JsonValue>,
    context: PlansBridgeContext,
  ): Promise<JsonValue>
}

export interface PlansWorkspaceStoragePort {
  get(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  set(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  delete(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansTerminalPort {
  create(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  input(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  resize(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  interrupt(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  kill(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  reattach(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  redraw(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansAgentMessagingPort {
  list(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  send(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  subscribe(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansRoutesPort {
  invoke(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansStreamsPort {
  open(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  write(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  end(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
  cancel(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansSpawnPort {
  transform(arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue>
}

export interface PlansCorePorts {
  filesystem: PlansFilesystemPort
  workspaceStorage: PlansWorkspaceStoragePort
  terminal: PlansTerminalPort
  agentMessaging: PlansAgentMessagingPort
  routes: PlansRoutesPort
  streams: PlansStreamsPort
  spawn: PlansSpawnPort
}

export interface BackendBridgeDispatcher {
  dispatch(request: PlansBridgeRequest, context: PlansBridgeContext): Promise<JsonValue>
}

type PortOperation = {
  [P in PlansBridgePort]: readonly string[]
}

const PORT_OPERATIONS: PortOperation = {
  filesystem: [
    'read_file',
    'read_range',
    'write_file',
    'write_part',
    'write_commit',
    'write_abort',
    'list_dir',
    'list_files_flat',
    'stat_path',
    'delete',
    'rename',
    'resolve_root',
    'watch',
  ],
  'workspace-storage': ['get', 'set', 'delete'],
  terminal: ['create', 'input', 'resize', 'interrupt', 'kill', 'reattach', 'redraw'],
  'agent-messaging': ['list', 'send', 'subscribe'],
  routes: ['invoke'],
  streams: ['open', 'write', 'end', 'cancel'],
  spawn: ['transform'],
  // Third-party package backends only (pluginThirdPartyBackends.ts): the Host
  // shell broker, under the same allowlist as a view's shell.run.
  shell: ['run'],
  // Section 9.3 of the browser contract; dispatched by the Host's web port.
  web: ['list', 'create', 'close', 'cdp', 'setState'],
}

export function isPlansBridgePort(value: unknown): value is PlansBridgePort {
  return typeof value === 'string' && (PLANS_BRIDGE_PORTS as readonly string[]).includes(value)
}

export function isPlansBridgeOrigin(value: unknown): value is PlansBridgeOrigin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 2 &&
    (record.kind === 'call' || record.kind === 'subscription') &&
    ((typeof record.requestId === 'string' && record.requestId.length > 0) ||
      (typeof record.requestId === 'number' && Number.isInteger(record.requestId) && Number.isFinite(record.requestId)))
  )
}

export function isPlansBridgeOperation(port: PlansBridgePort, value: unknown): value is string {
  return typeof value === 'string' && PORT_OPERATIONS[port].includes(value)
}

function recordArguments(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlansBridgeError('INVALID_ARGUMENT', 'Bridge arguments must be an object.')
  }
  return value as Record<string, JsonValue>
}

function requiredString(arguments_: JsonValue, key: string): string {
  const value = recordArguments(arguments_)[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new PlansBridgeError('INVALID_ARGUMENT', `Bridge argument '${key}' is invalid.`)
  }
  return value
}

function pathString(arguments_: JsonValue, key: string): string {
  const value = recordArguments(arguments_)[key]
  if (typeof value !== 'string') {
    throw new PlansBridgeError('INVALID_ARGUMENT', `Bridge argument '${key}' is invalid.`)
  }
  return value
}

function authorizedPlanRoot(context: PlansBridgeContext): string {
  const root = context.authorizedPlanRoot
  if (!root) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
  const canonical = canonicalExistingDirectory(root)
  if (!canonical || canonical !== root) {
    throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
  }
  return canonical
}

function safePlanPath(
  arguments_: JsonValue,
  key: string,
  context: PlansBridgeContext,
  allowRoot = true,
): string {
  const relPath = pathString(arguments_, key)
  if (relPath.includes('\u0000')) {
    throw new PlansBridgeError('INVALID_ARGUMENT', `Bridge argument '${key}' is invalid.`)
  }
  const candidate = resolveWorkspaceRelativePath(authorizedPlanRoot(context), relPath, allowRoot)
  if (!candidate) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
  return candidate
}

function exactPathArguments(
  arguments_: JsonValue,
  key: string,
  context: PlansBridgeContext,
  allowRoot = true,
): string {
  exactArguments(arguments_, [key])
  return safePlanPath(arguments_, key, context, allowRoot)
}

function mutationPath(context: PlansBridgeContext, path: string): string {
  const violation = workspaceMutationPathError(authorizedPlanRoot(context), path)
  if (violation) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION', violation)
  return path
}

function exactArguments(
  arguments_: JsonValue,
  expectedKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): void {
  const values = recordArguments(arguments_)
  const allowed = new Set([...expectedKeys, ...optionalKeys])
  if (Object.keys(values).some((key) => !allowed.has(key)) ||
      expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(values, key))) {
    throw new PlansBridgeError('INVALID_ARGUMENT')
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function readFileBounded(path: string): string {
  const flags = constants.O_RDONLY |
    (constants.O_NONBLOCK ?? 0) |
    (constants.O_NOFOLLOW ?? 0)
  const fd = openSync(path, flags)
  const buffer = Buffer.allocUnsafe(MAX_BACKEND_BRIDGE_RESULT_BYTES + 1)
  let offset = 0
  try {
    if (!fstatSync(fd).isFile()) {
      throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace path is not a regular file.')
    }
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null)
      if (count === 0) break
      offset += count
    }
  } finally {
    closeSync(fd)
  }
  if (offset > MAX_BACKEND_BRIDGE_RESULT_BYTES) {
    throw new PlansBridgeError('RESULT_TOO_LARGE', 'Workspace file exceeds the Bridge result limit.')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
  } catch {
    throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file is not valid UTF-8.')
  }
}

interface RangeArguments {
  offset: number
  length: number
}

function rangeArguments(values: Record<string, JsonValue>): RangeArguments {
  const { offset, length } = values
  if (
    Object.keys(values).some((key) => !['rel_path', 'offset', 'length'].includes(key)) ||
    !Object.prototype.hasOwnProperty.call(values, 'rel_path') ||
    typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
    typeof length !== 'number' || !Number.isSafeInteger(length) ||
    length < 1 || length > MAX_BACKEND_BRIDGE_RANGE_BYTES
  ) throw new PlansBridgeError('INVALID_ARGUMENT')
  return { offset, length }
}

/** Read one byte range through an open descriptor; never allocates more than
 * the (bounded) range and never reads the rest of the file. */
function readRangeBounded(path: string, { offset, length }: RangeArguments): {
  data_base64: string
  size: number
  mtime: number
  eof: boolean
} {
  const flags = constants.O_RDONLY |
    (constants.O_NONBLOCK ?? 0) |
    (constants.O_NOFOLLOW ?? 0)
  const fd = openSync(path, flags)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace path is not a regular file.')
    }
    const buffer = Buffer.allocUnsafe(length)
    let filled = 0
    while (filled < length) {
      const count = readSync(fd, buffer, filled, length - filled, offset + filled)
      if (count === 0) break
      filled += count
    }
    return {
      data_base64: buffer.subarray(0, filled).toString('base64'),
      size: stat.size,
      mtime: stat.mtimeMs,
      eof: offset + filled >= stat.size,
    }
  } finally {
    closeSync(fd)
  }
}

const UPLOAD_ID_RE = /^[0-9a-f]{32}$/
/** Base64 of one full range, the most a single write part may carry. */
const MAX_WRITE_PART_BASE64_CHARS = Math.ceil(MAX_BACKEND_BRIDGE_RANGE_BYTES / 3) * 4

function uploadId(values: Record<string, JsonValue>): string {
  const id = values.upload_id
  if (typeof id !== 'string' || !UPLOAD_ID_RE.test(id)) throw new PlansBridgeError('INVALID_ARGUMENT')
  return id
}

function nonNegativeInteger(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new PlansBridgeError('INVALID_ARGUMENT')
  }
  return value
}

interface WritePartArguments { id: string; offset: number; data: string }
interface WriteCommitArguments { id: string; totalSize: number; expectedMtime: number | undefined }

function writePartArguments(values: Record<string, JsonValue>): WritePartArguments {
  if (
    Object.keys(values).some((key) => !['rel_path', 'upload_id', 'offset', 'data_base64'].includes(key)) ||
    !Object.prototype.hasOwnProperty.call(values, 'rel_path') ||
    typeof values.data_base64 !== 'string' ||
    values.data_base64.length > MAX_WRITE_PART_BASE64_CHARS
  ) throw new PlansBridgeError('INVALID_ARGUMENT')
  return { id: uploadId(values), offset: nonNegativeInteger(values.offset), data: values.data_base64 }
}

function writeCommitArguments(values: Record<string, JsonValue>): WriteCommitArguments {
  const { expected_mtime: expected } = values
  if (
    Object.keys(values).some((key) => !['rel_path', 'upload_id', 'total_size', 'expected_mtime'].includes(key)) ||
    !Object.prototype.hasOwnProperty.call(values, 'rel_path') ||
    (expected !== undefined && (typeof expected !== 'number' || !Number.isFinite(expected)))
  ) throw new PlansBridgeError('INVALID_ARGUMENT')
  return {
    id: uploadId(values),
    totalSize: nonNegativeInteger(values.total_size),
    expectedMtime: expected as number | undefined,
  }
}

function writeAbortArguments(values: Record<string, JsonValue>): string {
  if (
    Object.keys(values).some((key) => !['rel_path', 'upload_id'].includes(key)) ||
    !Object.prototype.hasOwnProperty.call(values, 'rel_path')
  ) throw new PlansBridgeError('INVALID_ARGUMENT')
  return uploadId(values)
}

function backendResultRecord(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Filesystem service returned an invalid response.')
  }
  return value as Record<string, JsonValue>
}

function backendFailure(value: Record<string, JsonValue>, message: string): PlansBridgeError {
  if (value.conflict === true) {
    return new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file changed while it was being updated.')
  }
  if (typeof value.error === 'string' && /too large|content too large/i.test(value.error)) {
    return new PlansBridgeError('RESULT_TOO_LARGE', 'Workspace file exceeds the Bridge result limit.')
  }
  return new PlansBridgeError('BACKEND_UNAVAILABLE', message)
}

async function callFilesystemService(
  service: PlansFilesystemService,
  operation: PlansFilesystemServiceOperation,
  arguments_: Record<string, JsonValue>,
  context: PlansBridgeContext,
  options: { allowConflict?: boolean; allowMissing?: boolean } = {},
): Promise<Record<string, JsonValue>> {
  if (context.signal.aborted) throw new PlansBridgeError('USER_CANCELLED')
  const root = authorizedPlanRoot(context)
  try {
    const result = backendResultRecord(await service.call(
      operation,
      { ...arguments_, workspace_path: root },
      context,
    ))
    if (
      result.ok !== true &&
      !(options.allowConflict && result.conflict === true) &&
      !(options.allowMissing && result.exists === false)
    ) {
      throw backendFailure(result, 'Workspace filesystem operation failed.')
    }
    return result
  } catch (error) {
    if (error instanceof PlansBridgeError) throw error
    throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace filesystem service is unavailable.')
  }
}

/** Adapt the existing Host filesystem service to the private Plans port. All
 * mutation and read paths are delegated to the service; only the long-lived
 * watcher remains a local Host notification primitive. */
export function createHostPlansFilesystemPort(
  service: PlansFilesystemService,
): PlansFilesystemPort {
  const localWatcher = createTestPlansFilesystemPort().watch
  return {
    async readFile(arguments_, context): Promise<JsonValue> {
      const values = recordArguments(arguments_)
      if (
        Object.keys(values).some((key) => !['rel_path', 'include_mtime'].includes(key)) ||
        !Object.prototype.hasOwnProperty.call(values, 'rel_path') ||
        (values.include_mtime !== undefined && typeof values.include_mtime !== 'boolean')
      ) throw new PlansBridgeError('INVALID_ARGUMENT')
      const result = await callFilesystemService(
        service,
        'fs.read_file',
        { rel_path: pathString(arguments_, 'rel_path') },
        context,
      )
      if (typeof result.content !== 'string') {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file content is unavailable.')
      }
      const normalized: Record<string, JsonValue> = { content: result.content }
      if (typeof result.mtime === 'number' && Number.isFinite(result.mtime)) {
        normalized.mtime = result.mtime
      }
      return normalized
    },
    async readRange(arguments_, context): Promise<JsonValue> {
      const values = recordArguments(arguments_)
      const { offset, length } = rangeArguments(values)
      const result = await callFilesystemService(
        service,
        'fs.read_range',
        { rel_path: pathString(arguments_, 'rel_path'), offset, length },
        context,
      )
      if (
        typeof result.data_base64 !== 'string' ||
        typeof result.size !== 'number' ||
        typeof result.eof !== 'boolean'
      ) {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file range is unavailable.')
      }
      const normalized: Record<string, JsonValue> = {
        data_base64: result.data_base64,
        size: result.size,
        eof: result.eof,
      }
      if (typeof result.mtime === 'number' && Number.isFinite(result.mtime)) {
        normalized.mtime = result.mtime
      }
      return normalized
    },
    async writeFile(arguments_, context): Promise<JsonValue> {
      const values = recordArguments(arguments_)
      if (
        Object.keys(values).some((key) => !['rel_path', 'content', 'expected_mtime'].includes(key)) ||
        !Object.prototype.hasOwnProperty.call(values, 'rel_path') ||
        !Object.prototype.hasOwnProperty.call(values, 'content') ||
        typeof values.content !== 'string' ||
        (values.expected_mtime !== undefined &&
          (typeof values.expected_mtime !== 'number' || !Number.isFinite(values.expected_mtime)))
      ) throw new PlansBridgeError('INVALID_ARGUMENT')
      const payload: Record<string, JsonValue> = {
        rel_path: pathString(arguments_, 'rel_path'),
        content: values.content,
      }
      if (values.expected_mtime !== undefined) payload.expected_mtime = values.expected_mtime
      const result = await callFilesystemService(
        service,
        'fs.write_file',
        payload,
        context,
        { allowConflict: true },
      )
      if (result.conflict === true) {
        return {
          ok: false,
          conflict: true,
          ...(typeof result.mtime === 'number' && Number.isFinite(result.mtime)
            ? { mtime: result.mtime }
            : {}),
        }
      }
      return {
        ok: true,
        ...(typeof result.mtime === 'number' && Number.isFinite(result.mtime)
          ? { mtime: result.mtime }
          : {}),
      }
    },
    async writePart(arguments_, context): Promise<JsonValue> {
      const part = writePartArguments(recordArguments(arguments_))
      const result = await callFilesystemService(
        service,
        'fs.write_part',
        {
          rel_path: pathString(arguments_, 'rel_path'),
          upload_id: part.id,
          offset: part.offset,
          data_base64: part.data,
        },
        context,
      )
      return { ok: true, size: typeof result.size === 'number' ? result.size : part.offset }
    },
    async writeCommit(arguments_, context): Promise<JsonValue> {
      const commit = writeCommitArguments(recordArguments(arguments_))
      const payload: Record<string, JsonValue> = {
        rel_path: pathString(arguments_, 'rel_path'),
        upload_id: commit.id,
        total_size: commit.totalSize,
      }
      if (commit.expectedMtime !== undefined) payload.expected_mtime = commit.expectedMtime
      const result = await callFilesystemService(
        service,
        'fs.write_commit',
        payload,
        context,
        { allowConflict: true },
      )
      const outcome: Record<string, JsonValue> = result.conflict === true
        ? { ok: false, conflict: true }
        : { ok: true }
      if (typeof result.mtime === 'number' && Number.isFinite(result.mtime)) outcome.mtime = result.mtime
      return outcome
    },
    async writeAbort(arguments_, context): Promise<JsonValue> {
      const id = writeAbortArguments(recordArguments(arguments_))
      await callFilesystemService(
        service,
        'fs.write_abort',
        { rel_path: pathString(arguments_, 'rel_path'), upload_id: id },
        context,
      )
      return { ok: true }
    },
    async listDir(arguments_, context): Promise<JsonValue> {
      exactArguments(arguments_, ['rel_path'], ['mode'])
      const mode = (arguments_ as Record<string, JsonValue>).mode
      if (mode !== undefined && mode !== 'discovery' && mode !== 'display') {
        throw new PlansBridgeError('INVALID_ARGUMENT', "Bridge argument 'mode' must be 'discovery' or 'display'.")
      }
      const result = await callFilesystemService(
        service,
        'fs.list_dir',
        {
          rel_path: pathString(arguments_, 'rel_path'),
          ...(typeof mode === 'string' ? { mode } : {}),
        },
        context,
      )
      if (!Array.isArray(result.entries)) {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace directory listing is unavailable.')
      }
      return {
        entries: result.entries.flatMap((entry) => {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
          const name = (entry as Record<string, JsonValue>).name
          return typeof name === 'string' ? [name] : []
        }),
        ...(result.truncated === true ? { truncated: true } : {}),
      }
    },
    async listFilesFlat(arguments_, context): Promise<JsonValue> {
      exactArguments(arguments_, ['rel_path'])
      const result = await callFilesystemService(
        service,
        'fs.list_dir',
        { rel_path: pathString(arguments_, 'rel_path') },
        context,
      )
      if (!Array.isArray(result.entries)) {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace directory listing is unavailable.')
      }
      return {
        entries: result.entries.flatMap((entry) => {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
          const item = entry as Record<string, JsonValue>
          const name = item.name
          return typeof name === 'string' && item.is_dir !== true && extname(name) !== '' ? [name] : []
        }),
      }
    },
    async statPath(arguments_, context): Promise<JsonValue> {
      exactArguments(arguments_, ['rel_path'])
      const result = await callFilesystemService(
        service,
        'fs.stat_workspace_path',
        { rel_path: pathString(arguments_, 'rel_path') },
        context,
        { allowMissing: true },
      )
      return {
        exists: result.exists === true,
        isDirectory: result.is_directory === true || result.isDirectory === true,
        size: typeof result.size === 'number' && Number.isFinite(result.size) ? result.size : 0,
      }
    },
    async delete(arguments_, context): Promise<JsonValue> {
      exactArguments(arguments_, ['rel_path'])
      await callFilesystemService(
        service,
        'fs.delete',
        { rel_path: pathString(arguments_, 'rel_path') },
        context,
      )
      return { ok: true }
    },
    async rename(arguments_, context): Promise<JsonValue> {
      exactArguments(arguments_, ['from', 'to'])
      await callFilesystemService(
        service,
        'fs.rename',
        {
          src_path: pathString(arguments_, 'from'),
          dst_path: pathString(arguments_, 'to'),
        },
        context,
      )
      return { ok: true }
    },
    async resolveRoot(arguments_, context): Promise<JsonValue> {
      exactArguments(arguments_, [])
      return { root: authorizedPlanRoot(context) }
    },
    watch: localWatcher,
  }
}

function ensureWorkspaceRuntime(context: PlansBridgeContext): void {
  if (
    typeof context.runtime.pluginId !== 'string' ||
    context.runtime.pluginId.length === 0 ||
    typeof context.runtime.packageVersion !== 'string' ||
    context.runtime.packageVersion.length === 0 ||
    typeof context.runtime.workspaceId !== 'string' ||
    context.runtime.workspaceId.length === 0
  ) {
    throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
  }
}

function runtimeOwnerKey(runtime: BackendRuntimeContext): string {
  return JSON.stringify([
    runtime.pluginId,
    runtime.packageVersion,
    runtime.workspaceId,
    runtime.instanceId,
    runtime.contributionKey,
    runtime.hostWindowId,
    runtime.initiator.kind,
    runtime.initiator.kind === 'agent' ? runtime.initiator.source : '',
    runtime.initiator.id,
  ])
}

function deniedPort<T extends object>(port: string): T {
  const fail = async (): Promise<JsonValue> => {
    throw new PlansBridgeError('CAPABILITY_DENIED', `Plans port '${port}' is not connected.`)
  }
  return fail as unknown as T
}

function deniedCorePorts(): PlansCorePorts {
  return {
    filesystem: {
      readFile: deniedPort('filesystem'),
      readRange: deniedPort('filesystem'),
      writeFile: deniedPort('filesystem'),
      writePart: deniedPort('filesystem'),
      writeCommit: deniedPort('filesystem'),
      writeAbort: deniedPort('filesystem'),
      listDir: deniedPort('filesystem'),
      listFilesFlat: deniedPort('filesystem'),
      statPath: deniedPort('filesystem'),
      delete: deniedPort('filesystem'),
      rename: deniedPort('filesystem'),
      resolveRoot: deniedPort('filesystem'),
      watch: deniedPort('filesystem'),
    },
    workspaceStorage: {
      get: deniedPort('workspace-storage'),
      set: deniedPort('workspace-storage'),
      delete: deniedPort('workspace-storage'),
    },
    terminal: {
      create: deniedPort('terminal'),
      input: deniedPort('terminal'),
      resize: deniedPort('terminal'),
      interrupt: deniedPort('terminal'),
      kill: deniedPort('terminal'),
      reattach: deniedPort('terminal'),
      redraw: deniedPort('terminal'),
    },
    agentMessaging: {
      list: deniedPort('agent-messaging'),
      send: deniedPort('agent-messaging'),
      subscribe: deniedPort('agent-messaging'),
    },
    routes: { invoke: deniedPort('routes') },
    streams: {
      open: deniedPort('streams'),
      write: deniedPort('streams'),
      end: deniedPort('streams'),
      cancel: deniedPort('streams'),
    },
    spawn: { transform: deniedPort('spawn') },
  }
}

export function createPlansBridgeDispatcher(ports: PlansCorePorts): BackendBridgeDispatcher {
  return Object.freeze({
    async dispatch(request: PlansBridgeRequest, context: PlansBridgeContext): Promise<JsonValue> {
      if (context.signal.aborted) {
        throw new PlansBridgeError('USER_CANCELLED')
      }
      if (!isPlansBridgePort(request.port) || !isPlansBridgeOperation(request.port, request.operation)) {
        throw new PlansBridgeError('METHOD_NOT_FOUND')
      }
      switch (request.port) {
        case 'filesystem': {
          const operations: Record<string, (arguments_: JsonValue, context: PlansBridgeContext) => Promise<JsonValue>> = {
            read_file: ports.filesystem.readFile.bind(ports.filesystem),
            read_range: ports.filesystem.readRange.bind(ports.filesystem),
            write_file: ports.filesystem.writeFile.bind(ports.filesystem),
            write_part: ports.filesystem.writePart.bind(ports.filesystem),
            write_commit: ports.filesystem.writeCommit.bind(ports.filesystem),
            write_abort: ports.filesystem.writeAbort.bind(ports.filesystem),
            list_dir: ports.filesystem.listDir.bind(ports.filesystem),
            list_files_flat: ports.filesystem.listFilesFlat.bind(ports.filesystem),
            stat_path: ports.filesystem.statPath.bind(ports.filesystem),
            delete: ports.filesystem.delete.bind(ports.filesystem),
            rename: ports.filesystem.rename.bind(ports.filesystem),
            resolve_root: ports.filesystem.resolveRoot.bind(ports.filesystem),
            watch: ports.filesystem.watch.bind(ports.filesystem),
          }
          return operations[request.operation](request.arguments, context)
        }
        case 'workspace-storage': {
          ensureWorkspaceRuntime(context)
          const operations: Record<string, (arguments_: JsonValue, context: PlansBridgeContext) => Promise<JsonValue>> = {
            get: ports.workspaceStorage.get.bind(ports.workspaceStorage),
            set: ports.workspaceStorage.set.bind(ports.workspaceStorage),
            delete: ports.workspaceStorage.delete.bind(ports.workspaceStorage),
          }
          return operations[request.operation](request.arguments, context)
        }
        case 'terminal': {
          const operations: Record<string, (arguments_: JsonValue, context: PlansBridgeContext) => Promise<JsonValue>> = {
            create: ports.terminal.create.bind(ports.terminal),
            input: ports.terminal.input.bind(ports.terminal),
            resize: ports.terminal.resize.bind(ports.terminal),
            interrupt: ports.terminal.interrupt.bind(ports.terminal),
            kill: ports.terminal.kill.bind(ports.terminal),
            reattach: ports.terminal.reattach.bind(ports.terminal),
            redraw: ports.terminal.redraw.bind(ports.terminal),
          }
          return operations[request.operation](request.arguments, context)
        }
        case 'agent-messaging': {
          const operations: Record<string, (arguments_: JsonValue, context: PlansBridgeContext) => Promise<JsonValue>> = {
            list: ports.agentMessaging.list.bind(ports.agentMessaging),
            send: ports.agentMessaging.send.bind(ports.agentMessaging),
            subscribe: ports.agentMessaging.subscribe.bind(ports.agentMessaging),
          }
          return operations[request.operation](request.arguments, context)
        }
        case 'routes':
          return ports.routes.invoke.call(ports.routes, request.arguments, context)
        case 'streams': {
          const operations: Record<string, (arguments_: JsonValue, context: PlansBridgeContext) => Promise<JsonValue>> = {
            open: ports.streams.open.bind(ports.streams),
            write: ports.streams.write.bind(ports.streams),
            end: ports.streams.end.bind(ports.streams),
            cancel: ports.streams.cancel.bind(ports.streams),
          }
          return operations[request.operation](request.arguments, context)
        }
        case 'spawn':
          return ports.spawn.transform.call(ports.spawn, request.arguments, context)
        case 'shell':
          // Plans never declares shell; only third-party package bridges serve it.
          throw new PlansBridgeError('CAPABILITY_DENIED', 'Plans has no shell port.')
        case 'web':
          // Served by the Host's web port, never by the Plans core ports.
          throw new PlansBridgeError('CAPABILITY_DENIED', 'Plans has no web port.')
      }
    },
  })
}

/** Local filesystem adapter retained for isolated bridge tests. The app's
 * production composition uses createHostPlansFilesystemPort instead, so this
 * direct Node filesystem implementation is never selected by default. */
export function createTestPlansFilesystemPort(): PlansFilesystemPort {
  const emitChanged = (context: PlansBridgeContext, root: string, event: string, path: string | null): void => {
    if (context.signal.aborted) return
    context.emit('filesystem.changed', {
      workspace_path: root,
      event,
      ...(path === null ? {} : { path }),
    })
  }
  const watcher = async (arguments_: JsonValue, context: PlansBridgeContext): Promise<JsonValue> => {
    const root = exactPathArguments(arguments_, 'rel_path', context)
    if (!canonicalExistingDirectory(root)) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
    // Only plan documents reach the child. Forwarding every workspace event
    // (database and log writes, git, builds) as its own Bridge frame is what
    // overflowed the Host→child output queue and took the child down; an
    // event without a filename cannot be classified and is still forwarded.
    const onEvent = (event: string, path: string | null): void => {
      // fs.watch reports the host's own separator, and this wire is posix:
      // the classifier normalises before matching, the child rejects a path
      // with a backslash outright, and the Plans app compares what arrives
      // here against paths it built itself. Normalise once, at the boundary,
      // so the half that classifies and the half that reports cannot disagree.
      const relPath = path === null ? null : path.replace(/\\/g, '/')
      if (relPath !== null && !isPlanDocumentChangePath(relPath, root)) return
      emitChanged(context, root, event, relPath)
    }
    const watcherHandles: FSWatcher[] = []
    try {
      watcherHandles.push(watchPath(root, { recursive: true }, (event, filename) => {
        onEvent(event, filename ? String(filename) : null)
      }))
    } catch {
      // Linux does not support recursive fs.watch. Watching each canonical plan
      // directory that exists keeps a bounded change signal on every supported
      // Host platform; nested repositories stay out of reach there, and a
      // workspace without any plan directory simply has nothing to report.
      let attempted = 0
      for (const planDir of PLAN_DOC_DIRS) {
        const directory = resolve(root, planDir)
        if (!canonicalExistingDirectory(directory)) continue
        attempted += 1
        try {
          watcherHandles.push(watchPath(directory, (event, filename) => {
            onEvent(event, filename ? `${planDir}/${String(filename)}` : null)
          }))
        } catch {
          // Counted through `attempted`; the loop keeps the other directories.
        }
      }
      if (attempted > 0 && watcherHandles.length === 0) {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace watcher is unavailable.')
      }
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false
      const closeAll = (): void => {
        for (const handle of watcherHandles) handle.close()
      }
      const finish = (error?: PlansBridgeError): void => {
        if (settled) return
        settled = true
        context.signal.removeEventListener('abort', onAbort)
        for (const handle of watcherHandles) {
          handle.removeListener('error', onError)
          handle.removeListener('close', onClose)
        }
        if (error) rejectPromise(error)
        else resolvePromise()
      }
      const onAbort = (): void => {
        closeAll()
        finish()
      }
      const onError = (): void => {
        closeAll()
        finish(new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace watcher failed.'))
      }
      const onClose = (): void => {
        if (context.signal.aborted) finish()
        else {
          closeAll()
          finish(new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace watcher closed.'))
        }
      }
      for (const handle of watcherHandles) {
        handle.on('error', onError)
        handle.on('close', onClose)
      }
      if (context.signal.aborted) {
        onAbort()
        return
      }
      context.signal.addEventListener('abort', onAbort, { once: true })
    })
    return null
  }
  return {
    async readFile(arguments_, context): Promise<JsonValue> {
      const values = recordArguments(arguments_)
      if (
        Object.keys(values).some((key) => !['rel_path', 'include_mtime'].includes(key)) ||
        !Object.prototype.hasOwnProperty.call(values, 'rel_path') ||
        (values.include_mtime !== undefined && typeof values.include_mtime !== 'boolean')
      ) throw new PlansBridgeError('INVALID_ARGUMENT')
      const file = safePlanPath(arguments_, 'rel_path', context)
      try {
        const beforeMtime = values.include_mtime === true ? statSync(file).mtimeMs : undefined
        const content = readFileBounded(file)
        const result: Record<string, JsonValue> = { content }
        if (values.include_mtime === true) {
          const afterMtime = statSync(file).mtimeMs
          if (afterMtime !== beforeMtime) {
            throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file changed while reading.')
          }
          result.mtime = beforeMtime
        }
        return result
      } catch (error) {
        if (error instanceof PlansBridgeError) throw error
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file is unavailable.')
      }
    },
    async readRange(arguments_, context): Promise<JsonValue> {
      const values = recordArguments(arguments_)
      const range = rangeArguments(values)
      const file = safePlanPath(arguments_, 'rel_path', context)
      try {
        return readRangeBounded(file, range)
      } catch (error) {
        if (error instanceof PlansBridgeError) throw error
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file is unavailable.')
      }
    },
    async writeFile(arguments_, context): Promise<JsonValue> {
      const values = recordArguments(arguments_)
      if (
        Object.keys(values).some((key) => !['rel_path', 'content', 'expected_mtime'].includes(key)) ||
        !Object.prototype.hasOwnProperty.call(values, 'rel_path') ||
        !Object.prototype.hasOwnProperty.call(values, 'content')
      ) throw new PlansBridgeError('INVALID_ARGUMENT')
      const file = mutationPath(context, safePlanPath(arguments_, 'rel_path', context, false))
      if (typeof values.content !== 'string') throw new PlansBridgeError('INVALID_ARGUMENT')
      const expectedMtime = values.expected_mtime
      if (
        expectedMtime !== undefined &&
        (typeof expectedMtime !== 'number' || !Number.isFinite(expectedMtime))
      ) throw new PlansBridgeError('INVALID_ARGUMENT')
      if (expectedMtime !== undefined) {
        try {
          const currentMtime = statSync(file).mtimeMs
          if (currentMtime !== expectedMtime) {
            return { ok: false, conflict: true, mtime: currentMtime }
          }
        } catch {
          return { ok: false, conflict: true }
        }
      }
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, values.content, 'utf8')
      } catch {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file could not be written.')
      }
      return expectedMtime === undefined ? { ok: true } : { ok: true, mtime: statSync(file).mtimeMs }
    },
    async writePart(arguments_, context): Promise<JsonValue> {
      const part = writePartArguments(recordArguments(arguments_))
      const file = mutationPath(context, safePlanPath(arguments_, 'rel_path', context, false))
      const staging = `${file}.${part.id}.upload`
      const data = Buffer.from(part.data, 'base64')
      try {
        if (part.offset === 0) {
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(staging, data)
        } else {
          if (statSync(staging).size !== part.offset) throw new PlansBridgeError('BACKEND_UNAVAILABLE')
          appendFileSync(staging, data)
        }
      } catch (error) {
        rmSync(staging, { force: true })
        if (error instanceof PlansBridgeError) throw error
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file could not be written.')
      }
      return { ok: true, size: part.offset + data.length }
    },
    async writeCommit(arguments_, context): Promise<JsonValue> {
      const commit = writeCommitArguments(recordArguments(arguments_))
      const file = mutationPath(context, safePlanPath(arguments_, 'rel_path', context, false))
      const staging = `${file}.${commit.id}.upload`
      try {
        if (statSync(staging).size !== commit.totalSize) throw new PlansBridgeError('BACKEND_UNAVAILABLE')
        if (commit.expectedMtime !== undefined) {
          let current: number | undefined
          try { current = statSync(file).mtimeMs } catch { current = undefined }
          if (current !== commit.expectedMtime) {
            rmSync(staging, { force: true })
            return current === undefined ? { ok: false, conflict: true } : { ok: false, conflict: true, mtime: current }
          }
        }
        renameSync(staging, file)
      } catch (error) {
        rmSync(staging, { force: true })
        if (error instanceof PlansBridgeError) throw error
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace file could not be written.')
      }
      return { ok: true, mtime: statSync(file).mtimeMs }
    },
    async writeAbort(arguments_, context): Promise<JsonValue> {
      const id = writeAbortArguments(recordArguments(arguments_))
      const file = mutationPath(context, safePlanPath(arguments_, 'rel_path', context, false))
      rmSync(`${file}.${id}.upload`, { force: true })
      return { ok: true }
    },
    async listDir(arguments_, context) {
      const directory = exactPathArguments(arguments_, 'rel_path', context)
      try {
        return { entries: readdirSync(directory).sort() }
      } catch {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace directory is unavailable.')
      }
    },
    async listFilesFlat(arguments_, context) {
      const directory = exactPathArguments(arguments_, 'rel_path', context)
      try {
        return {
          entries: readdirSync(directory).sort().filter((entry) => extname(entry) !== ''),
        }
      } catch {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace directory is unavailable.')
      }
    },
    async statPath(arguments_, context) {
      const path = exactPathArguments(arguments_, 'rel_path', context)
      try {
        const entry = statSync(path)
        return { exists: true, isDirectory: entry.isDirectory(), size: entry.size }
      } catch {
        return { exists: false, isDirectory: false, size: 0 }
      }
    },
    async delete(arguments_, context) {
      const path = mutationPath(context, exactPathArguments(arguments_, 'rel_path', context, false))
      try {
        await shell.trashItem(path)
      } catch {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace path could not be moved to Trash.')
      }
      return { ok: true }
    },
    async rename(arguments_, context) {
      exactArguments(arguments_, ['from', 'to'])
      const from = mutationPath(context, safePlanPath(arguments_, 'from', context, false))
      const to = mutationPath(context, safePlanPath(arguments_, 'to', context, false))
      try {
        if (pathExists(to)) {
          throw new PlansBridgeError('INVALID_ARGUMENT', 'Workspace rename destination already exists.')
        }
        mkdirSync(dirname(to), { recursive: true })
        renameSync(from, to)
      } catch (error) {
        if (error instanceof PlansBridgeError) throw error
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace path could not be renamed.')
      }
      return { ok: true }
    },
    async resolveRoot(arguments_, context) {
      exactArguments(arguments_, [])
      return { root: authorizedPlanRoot(context) }
    },
    watch: watcher,
  }
}

function createProductionStoragePort(): PlansWorkspaceStoragePort {
  return {
    async get() {
      throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace storage adapter is not connected.')
    },
    async set() {
      throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace storage adapter is not connected.')
    },
    async delete() {
      throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Workspace storage adapter is not connected.')
    },
  }
}

export function createProductionPlansCorePorts(
  overrides: Partial<PlansCorePorts> = {},
): PlansCorePorts {
  const denied = deniedCorePorts()
  return {
    ...denied,
    ...overrides,
    filesystem: overrides.filesystem ?? denied.filesystem,
    workspaceStorage: overrides.workspaceStorage ?? createProductionStoragePort(),
  }
}

interface InMemoryWatch {
  readonly root: string
  readonly context: PlansBridgeContext
}

interface InMemoryOwnedStream {
  readonly owner: string
  usedBytes: number
}

export interface InMemoryPlansCoreOptions {
  files?: Readonly<Record<string, string>>
  root?: string
}

function workspaceRootFor(context: PlansBridgeContext, fallback: string): string {
  return resolve(context.authorizedPlanRoot ?? fallback)
}

function virtualMutationPathError(root: string, candidate: string): string | null {
  const resolvedCandidate = resolve(candidate)
  if (resolvedCandidate !== root && !resolvedCandidate.startsWith(`${root}${sep}`)) {
    return 'path escapes the Host workspace binding'
  }
  if (resolvedCandidate === root) return 'workspace root cannot be mutated'
  const relativePath = resolvedCandidate.slice(root.length).replace(/^[/\\]/u, '')
  if (relativePath.split(/[\\/]/u).some((segment) => segment === '.git')) {
    return 'Git metadata paths are protected'
  }
  return null
}

export function createInMemoryPlansCorePorts(options: InMemoryPlansCoreOptions = {}): PlansCorePorts {
  const root = resolve(options.root ?? '/workspace')
  const files = new Map(Object.entries(options.files ?? {}))
  const mtimes = new Map<string, number>()
  const uploads = new Map<string, Buffer[]>()
  let nextMtime = 1
  const storage = new Map<string, JsonValue>()
  const sessions = new Map<string, string>()
  const streams = new Map<string, InMemoryOwnedStream>()
  const watchers = new Set<InMemoryWatch>()
  const notify = (path: string, event: string): void => {
    for (const watcher of watchers) {
      const prefix = watcher.root.endsWith(sep) ? watcher.root : `${watcher.root}${sep}`
      if (path !== watcher.root && !path.startsWith(prefix)) continue
      watcher.context.emit('filesystem.changed', { workspace_path: watcher.root, event, path })
    }
  }
  const pathFor = (
    arguments_: JsonValue,
    context?: PlansBridgeContext,
    pathKey = 'rel_path',
    allowRoot = true,
  ): string => {
    const workspace = context?.authorizedPlanRoot ?? root
    if (resolve(workspace) !== root) {
      throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
    }
    const relPath = pathString(arguments_, pathKey)
    if (relPath.includes('\u0000')) {
      throw new PlansBridgeError('INVALID_ARGUMENT')
    }
    const normalized = relPath.replace(/\\/g, '/')
    if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) {
      throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
    }
    const candidate = resolve(workspace, normalized)
    const prefix = workspace.endsWith(sep) ? workspace : `${workspace}${sep}`
    if (candidate !== workspace && !candidate.startsWith(prefix)) {
      throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
    }
    if (!allowRoot && candidate === workspace) {
      throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
    }
    return candidate
  }
  const ownerFor = (context: PlansBridgeContext): string => runtimeOwnerKey(context.runtime)
  const filesystem: PlansFilesystemPort = {
    async readFile(arguments_, context): Promise<JsonValue> {
      const values = recordArguments(arguments_)
      if (
        Object.keys(values).some((key) => !['rel_path', 'include_mtime'].includes(key)) ||
        !Object.prototype.hasOwnProperty.call(values, 'rel_path') ||
        (values.include_mtime !== undefined && typeof values.include_mtime !== 'boolean')
      ) throw new PlansBridgeError('INVALID_ARGUMENT')
      const path = pathFor(arguments_, context)
      const content = files.get(path)
      if (content === undefined) throw new PlansBridgeError('BACKEND_UNAVAILABLE')
      if (Buffer.byteLength(content, 'utf8') > MAX_BACKEND_BRIDGE_RESULT_BYTES) {
        throw new PlansBridgeError('RESULT_TOO_LARGE', 'Workspace file exceeds the Bridge result limit.')
      }
      return values.include_mtime === true
        ? { content, mtime: mtimes.get(path) ?? 1 }
        : { content }
    },
    async readRange(arguments_, context): Promise<JsonValue> {
      const values = recordArguments(arguments_)
      const { offset, length } = rangeArguments(values)
      const path = pathFor(arguments_, context)
      const content = files.get(path)
      if (content === undefined) throw new PlansBridgeError('BACKEND_UNAVAILABLE')
      const bytes = Buffer.from(content, 'utf8')
      const slice = bytes.subarray(offset, offset + length)
      return {
        data_base64: slice.toString('base64'),
        size: bytes.length,
        mtime: mtimes.get(path) ?? 1,
        eof: offset + slice.length >= bytes.length,
      }
    },
    async writeFile(arguments_, context): Promise<JsonValue> {
      const values = recordArguments(arguments_)
      if (
        Object.keys(values).some((key) => !['rel_path', 'content', 'expected_mtime'].includes(key)) ||
        !Object.prototype.hasOwnProperty.call(values, 'rel_path') ||
        !Object.prototype.hasOwnProperty.call(values, 'content')
      ) throw new PlansBridgeError('INVALID_ARGUMENT')
      if (typeof values.content !== 'string') throw new PlansBridgeError('INVALID_ARGUMENT')
      const path = pathFor(arguments_, context)
      if (virtualMutationPathError(workspaceRootFor(context, root), path)) {
        throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
      }
      const expectedMtime = values.expected_mtime
      if (
        expectedMtime !== undefined &&
        (typeof expectedMtime !== 'number' || !Number.isFinite(expectedMtime))
      ) throw new PlansBridgeError('INVALID_ARGUMENT')
      if (expectedMtime !== undefined && files.has(path) && (mtimes.get(path) ?? 1) !== expectedMtime) {
        return { ok: false, conflict: true, mtime: mtimes.get(path) ?? 1 }
      }
      if (expectedMtime !== undefined && !files.has(path)) return { ok: false, conflict: true }
      files.set(path, values.content)
      const mtime = ++nextMtime
      mtimes.set(path, mtime)
      notify(path, 'change')
      return expectedMtime === undefined ? { ok: true } : { ok: true, mtime }
    },
    async writePart(arguments_, context): Promise<JsonValue> {
      const part = writePartArguments(recordArguments(arguments_))
      const path = pathFor(arguments_, context)
      if (virtualMutationPathError(workspaceRootFor(context, root), path)) {
        throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
      }
      const key = `${path}\u0000${part.id}`
      const data = Buffer.from(part.data, 'base64')
      const staged = part.offset === 0 ? [] : uploads.get(key)
      if (!staged || staged.reduce((sum, chunk) => sum + chunk.length, 0) !== part.offset) {
        uploads.delete(key)
        throw new PlansBridgeError('BACKEND_UNAVAILABLE')
      }
      staged.push(data)
      uploads.set(key, staged)
      return { ok: true, size: part.offset + data.length }
    },
    async writeCommit(arguments_, context): Promise<JsonValue> {
      const commit = writeCommitArguments(recordArguments(arguments_))
      const path = pathFor(arguments_, context)
      if (virtualMutationPathError(workspaceRootFor(context, root), path)) {
        throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
      }
      const key = `${path}\u0000${commit.id}`
      const staged = uploads.get(key)
      uploads.delete(key)
      const bytes = staged ? Buffer.concat(staged) : undefined
      if (!bytes || bytes.length !== commit.totalSize) throw new PlansBridgeError('BACKEND_UNAVAILABLE')
      if (commit.expectedMtime !== undefined && files.has(path) && (mtimes.get(path) ?? 1) !== commit.expectedMtime) {
        return { ok: false, conflict: true, mtime: mtimes.get(path) ?? 1 }
      }
      if (commit.expectedMtime !== undefined && !files.has(path)) return { ok: false, conflict: true }
      files.set(path, bytes.toString('utf8'))
      const mtime = ++nextMtime
      mtimes.set(path, mtime)
      notify(path, 'change')
      return { ok: true, mtime }
    },
    async writeAbort(arguments_, context): Promise<JsonValue> {
      const id = writeAbortArguments(recordArguments(arguments_))
      uploads.delete(`${pathFor(arguments_, context)}\u0000${id}`)
      return { ok: true }
    },
    async listDir(arguments_, context) {
      exactArguments(arguments_, ['rel_path'])
      const directory = pathFor(arguments_, context)
      const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`
      const entries = new Set<string>()
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) entries.add(path.slice(prefix.length).split(sep)[0])
      }
      return { entries: [...entries] }
    },
    async listFilesFlat(arguments_, context) {
      exactArguments(arguments_, ['rel_path'])
      return filesystem.listDir(arguments_, context)
    },
    async statPath(arguments_, context) {
      exactArguments(arguments_, ['rel_path'])
      const path = pathFor(arguments_, context)
      const content = files.get(path)
      return {
        exists: content !== undefined,
        isDirectory: false,
        size: content === undefined ? 0 : Buffer.byteLength(content, 'utf8'),
      }
    },
    async delete(arguments_, context) {
      exactArguments(arguments_, ['rel_path'])
      const path = pathFor(arguments_, context, 'rel_path', false)
      if (virtualMutationPathError(workspaceRootFor(context, root), path)) {
        throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
      }
      files.delete(path)
      notify(path, 'delete')
      return { ok: true }
    },
    async rename(arguments_, context) {
      exactArguments(arguments_, ['from', 'to'])
      const from = pathFor(arguments_, context, 'from', false)
      const to = pathFor(arguments_, context, 'to', false)
      if (virtualMutationPathError(workspaceRootFor(context, root), from) ||
          virtualMutationPathError(workspaceRootFor(context, root), to)) {
        throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
      }
      if (files.has(to)) {
        throw new PlansBridgeError('INVALID_ARGUMENT', 'Workspace rename destination already exists.')
      }
      const content = files.get(from)
      if (content !== undefined) {
        files.delete(from)
        files.set(to, content)
      }
      notify(to, 'rename')
      return { ok: true }
    },
    async resolveRoot(arguments_, context) {
      exactArguments(arguments_, [])
      const workspace = workspaceRootFor(context, root)
      if (workspace !== root) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
      return { root }
    },
    async watch(arguments_, context) {
      exactArguments(arguments_, ['rel_path'])
      const watchRoot = pathFor(arguments_, context)
      if (watchRoot !== root) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
      const registration = { root: watchRoot, context }
      watchers.add(registration)
      await new Promise<void>((resolvePromise) => {
        const close = (): void => {
          watchers.delete(registration)
          resolvePromise()
        }
        if (context.signal.aborted) close()
        else context.signal.addEventListener('abort', close, { once: true })
      })
      return null
    },
  }
  const workspaceStorage: PlansWorkspaceStoragePort = {
    async get(arguments_, context) {
      const values = recordArguments(arguments_)
      const key = storageKey(values, context, ['scope', 'key'])
      return { found: storage.has(key), ...(storage.has(key) ? { value: storage.get(key)! } : {}) }
    },
    async set(arguments_, context) {
      const values = recordArguments(arguments_)
      const key = storageKey(values, context, ['scope', 'key', 'value'])
      if (!Object.prototype.hasOwnProperty.call(values, 'value') || !isJsonValue(values.value)) {
        throw new PlansBridgeError('INVALID_ARGUMENT')
      }
      storage.set(key, values.value)
      return null
    },
    async delete(arguments_, context) {
      const values = recordArguments(arguments_)
      const key = storageKey(values, context, ['scope', 'key'])
      const deleted = storage.delete(key)
      return deleted
    },
  }
  const terminal: PlansTerminalPort = {
    async create(_arguments_, context) {
      const id = `terminal-${randomUUID()}`
      sessions.set(id, ownerFor(context))
      return { terminal_session_id: id }
    },
    async input(arguments_, context) {
      requireSession(arguments_, sessions, context)
      return { ok: true }
    },
    async resize(arguments_, context) {
      requireSession(arguments_, sessions, context)
      return { ok: true }
    },
    async interrupt(arguments_, context) {
      requireSession(arguments_, sessions, context)
      return { ok: true }
    },
    async kill(arguments_, context) {
      const id = requireSession(arguments_, sessions, context)
      sessions.delete(id)
      return { ok: true }
    },
    async reattach(arguments_, context) {
      requireSession(arguments_, sessions, context)
      return { ok: true }
    },
    async redraw(arguments_, context) {
      requireSession(arguments_, sessions, context)
      return { ok: true }
    },
  }
  const agentMessaging: PlansAgentMessagingPort = {
    async list() { return { agents: [] } },
    async send() { return { ok: true } },
    async subscribe() { return { ok: true } },
  }
  const routes: PlansRoutesPort = {
    async invoke(arguments_, context) {
      const values = recordArguments(arguments_)
      if (values.route !== 'plans.resolve_root' || Object.keys(values).length !== 1) {
        throw new PlansBridgeError('METHOD_NOT_FOUND')
      }
      return filesystem.resolveRoot({}, context)
    },
  }
  const streamsPort: PlansStreamsPort = {
    async open(_arguments_, context) {
      const id = `stream-${randomUUID()}`
      streams.set(id, { owner: ownerFor(context), usedBytes: 0 })
      return { stream_id: id, credit_bytes: MAX_BACKEND_BRIDGE_QUEUE_BYTES }
    },
    async write(arguments_, context) {
      const values = recordArguments(arguments_)
      const id = requiredString(arguments_, 'stream_id')
      const stream = streams.get(id)
      if (!stream) throw new PlansBridgeError('INVALID_ARGUMENT')
      if (stream.owner !== ownerFor(context)) throw new PlansBridgeError('CAPABILITY_DENIED')
      if (typeof values.chunk_base64 !== 'string') throw new PlansBridgeError('INVALID_ARGUMENT')
      const bytes = Buffer.from(values.chunk_base64, 'base64')
      if (bytes.length > MAX_BACKEND_BRIDGE_CHUNK_BYTES) throw new PlansBridgeError('RESOURCE_LIMIT')
      const usedBytes = stream.usedBytes
      if (usedBytes + bytes.length > MAX_BACKEND_BRIDGE_QUEUE_BYTES) {
        throw new PlansBridgeError('RESOURCE_LIMIT')
      }
      stream.usedBytes = usedBytes + bytes.length
      return { accepted_bytes: bytes.length, credit_bytes: MAX_BACKEND_BRIDGE_QUEUE_BYTES - usedBytes - bytes.length }
    },
    async end(arguments_, context) {
      const id = requireStream(arguments_, streams, context)
      streams.delete(id)
      return { ok: true }
    },
    async cancel(arguments_, context) {
      const id = requireStream(arguments_, streams, context)
      streams.delete(id)
      return { ok: true }
    },
  }
  return {
    filesystem,
    workspaceStorage,
    terminal,
    agentMessaging,
    routes,
    streams: streamsPort,
    spawn: {
      async transform(arguments_) {
        if (!isJsonValue(arguments_)) throw new PlansBridgeError('INVALID_ARGUMENT')
        return arguments_
      },
    },
  }
}

function storageKey(
  values: Record<string, JsonValue>,
  context: PlansBridgeContext,
  allowedKeys: readonly string[],
): string {
  if (Object.keys(values).some((key) => !allowedKeys.includes(key))) {
    throw new PlansBridgeError('INVALID_ARGUMENT')
  }
  if (values.scope !== 'plugin' && values.scope !== 'workspace') {
    throw new PlansBridgeError('INVALID_ARGUMENT')
  }
  if (typeof values.key !== 'string' || values.key.length === 0 || values.key.includes('\u0000')) {
    throw new PlansBridgeError('INVALID_ARGUMENT')
  }
  if (values.scope === 'workspace') ensureWorkspaceRuntime(context)
  return [
    context.runtime.pluginId,
    context.runtime.packageVersion,
    values.scope,
    values.scope === 'workspace' ? context.runtime.workspaceId : '',
    values.key,
  ].join('\u0000')
}

function requireSession(
  arguments_: JsonValue,
  sessions: Map<string, string>,
  context: PlansBridgeContext,
): string {
  const id = requiredString(arguments_, 'terminal_session_id')
  if (sessions.get(id) !== runtimeOwnerKey(context.runtime)) throw new PlansBridgeError('CAPABILITY_DENIED')
  return id
}

function requireStream(
  arguments_: JsonValue,
  streams: Map<string, InMemoryOwnedStream>,
  context: PlansBridgeContext,
): string {
  const id = requiredString(arguments_, 'stream_id')
  const stream = streams.get(id)
  const owner = runtimeOwnerKey(context.runtime)
  if (!stream) throw new PlansBridgeError('INVALID_ARGUMENT')
  if (stream.owner !== owner) throw new PlansBridgeError('CAPABILITY_DENIED')
  return id
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || value === null || seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.values(value).every((item) => isJsonValue(item, seen))
  seen.delete(value)
  return valid
}

/** Default Host composition is fail-closed until the application wires the
 * existing core filesystem service and any other core owners. */
export function createProductionPlansBridgeDispatcher(
  overrides: Partial<PlansCorePorts> = {},
): BackendBridgeDispatcher {
  return createPlansBridgeDispatcher(createProductionPlansCorePorts(overrides))
}

export function createInMemoryPlansBridgeDispatcher(
  options: InMemoryPlansCoreOptions = {},
): BackendBridgeDispatcher {
  return createPlansBridgeDispatcher(createInMemoryPlansCorePorts(options))
}
