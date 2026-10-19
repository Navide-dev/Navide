import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { TextDecoder } from 'node:util'
import { isLargePieceFrame, OFF_THREAD_FRAME_BYTES, parseFrameOffThread, type OffThreadFrame } from './backendFrameWorker'
import {
  isAllowedBackendTimeout,
  MAX_BACKEND_BRIDGE_QUEUE_BYTES,
  MAX_BACKEND_BRIDGE_RESULT_BYTES,
} from './pluginBackendLimits'
import {
  isPlansBridgeOperation,
  isPlansBridgeOrigin,
  isPlansBridgePort,
  PlansBridgeError,
  type BackendBridgeDispatcher,
  type PlansBridgeContext,
  type PlansBridgeErrorCode,
  type PlansBridgeOrigin,
  type PlansBridgePort,
  type PlansBridgeRequest,
} from './plansBridge'
import {
  executionPolicyAllows,
  isAuthenticatedInitiator,
  type AuthenticatedInitiator,
} from './pluginCapabilityBroker'
import type { ExecutionPolicySnapshot } from './executionPolicy'
import type { PluginSystemNamespace } from './pluginManifestV2'
import type { DisclosureAgentTool, DisclosurePermissions } from '../../shared/pluginDisclosure'
import {
  AGENT_TOOL_CHUNK_BYTES,
  AGENT_TOOL_CHUNK_IDLE_MS,
  BACKEND_WIRE_ARGUMENT_CHUNK_METHOD,
  BACKEND_WIRE_ARGUMENT_CHUNKS_KEY,
  BACKEND_WIRE_RESULT_CHUNK_METHOD,
  BACKEND_WIRE_RESULT_CHUNKS_KEY,
  agentToolChunkArrival,
  reassembleAgentToolPayloadText,
  splitAgentToolPayloadText,
  utf8ByteLength,
} from '../../shared/pluginAgentTools'

/** Private Electron-main seam for Backend Wire v1 conformance tests. */
export const MCP_PROTOCOL_REVISION = '2026-07-28'
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'
const SUBSCRIPTION_ID_KEY = 'io.modelcontextprotocol/subscriptionId'
const EVENT_FILTER_KEY = 'dev.navide/pluginEvents'
const PROTOCOL_ERROR_MESSAGE = 'Backend plugin returned an invalid protocol message.'
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
/** Live cancellation tombstones kept per child; the oldest is evicted past it. */
export const MAX_IGNORED_REQUEST_IDS = 256
const MAX_RETAINED_STDERR_BYTES = 64 * 1024
const MAX_DIAGNOSTIC_EMITTED_BYTES = 64 * 1024
export const MAX_CAUSE_STDERR_CHARS = 8192

export function sanitizeDiagnosticCauseText(text: string, maxChars = MAX_CAUSE_STDERR_CHARS): string {
  const stripped = text
    .replace(/\x1B(?:\].*?(?:\x07|\x1B\\\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_]|.?)/gu, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/gu, '')
  const normalized = stripped.replace(/\r\n|\r|\u2028|\u2029/gu, '\n').trim()
  if (normalized.length <= maxChars) {
    return normalized
  }
  const hasTruncatedMarker = normalized.includes('[stderr truncated]')
  const slice = normalized.slice(0, maxChars).trimEnd()
  return hasTruncatedMarker
    ? `${slice}\n... [stderr truncated]`
    : `${slice}\n... [stderr cause truncated]`
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface BackendRuntimeContext {
  pluginId: string
  packageVersion: string
  workspaceId: string | null
  instanceId: string | null
  contributionKey: string | null
  hostWindowId: string | null
  /** Host-authenticated operation origin; never selected by the child. */
  initiator: AuthenticatedInitiator
}

export interface BackendPluginLaunchSpec {
  pluginId: string
  packageVersion: string
  /** Host-only canonical package root used to bind the selected descriptor. */
  packageDir: string
  entryFile: string
  protocolVersion: 1
  activation: 'startup'
  /** Host-projected package method allowlist; never supplied by the child. */
  approvedMethods: readonly string[]
  /** Explicit package-local adapter methods that an MCP agent may invoke. */
  agentMethods?: readonly string[]
  /** Host-projected package event allowlist; never supplied by the child. */
  approvedEvents: readonly string[]
  /** Host-private core ports projected for this package activation. */
  approvedBridgePorts?: readonly PlansBridgePort[]
  /** Present only for a third-party package: the Host admits and launches it
   *  under the OS sandbox (see pluginThirdPartyBackends.ts). */
  thirdParty?: {
    name: string
    system: readonly PluginSystemNamespace[]
    shell?: 'allowlist' | 'full'
    /** The package's declared agent tools as the disclosure spells them
     *  (defaulted timeouts, sorted by name); absent when it declares none. */
    agentTools?: readonly DisclosureAgentTool[]
    /** The package's disclosure `permissions`; present with `agentTools`. */
    permissions?: DisclosurePermissions
  }
}

const AUTHENTICATED_RUNTIME = Symbol('navide.authenticatedBackendRuntime')
const AUTHENTICATED_AUDIENCE = Symbol('navide.authenticatedBackendAudience')
const AUTHENTICATED_RUNTIMES = new WeakSet<object>()

export type AuthenticatedBackendRuntime = BackendRuntimeContext & {
  readonly [AUTHENTICATED_RUNTIME]: true
  readonly [AUTHENTICATED_AUDIENCE]: object
}

export type BackendPluginErrorCode =
  | 'INVALID_ACTIVATION'
  | 'INVALID_RUNTIME'
  | 'INVALID_ARGUMENT'
  | 'CAPABILITY_DENIED'
  | 'RESOURCE_LIMIT'
  | 'NOT_READY'
  | 'TIMEOUT'
  | 'USER_CANCELLED'
  | 'PLUGIN_ERROR'
  | 'BACKEND_UNAVAILABLE'
  | 'PROTOCOL_ERROR'
  | 'PLUGIN_STOPPING'
  | 'RESULT_TOO_LARGE'
  /** The pieces of a result could not be joined (contract 4.4); `reason` says why. */
  | 'CHUNKS_INVALID'

const ERROR_MESSAGES: Record<BackendPluginErrorCode, string> = {
  INVALID_ACTIVATION: 'Backend plugin activation is invalid.',
  INVALID_RUNTIME: 'Backend runtime is invalid.',
  INVALID_ARGUMENT: 'Backend call arguments are invalid.',
  CAPABILITY_DENIED: 'Backend capability is denied.',
  RESOURCE_LIMIT: 'Backend resource limit reached.',
  NOT_READY: 'Backend plugin is not ready.',
  TIMEOUT: 'Backend plugin call timed out.',
  USER_CANCELLED: 'Backend plugin call was cancelled.',
  PLUGIN_ERROR: 'Plugin request failed.',
  BACKEND_UNAVAILABLE: 'Backend plugin is unavailable.',
  PROTOCOL_ERROR: PROTOCOL_ERROR_MESSAGE,
  PLUGIN_STOPPING: 'Backend plugin is stopping.',
  RESULT_TOO_LARGE: 'Backend plugin result is too large.',
  CHUNKS_INVALID: 'Backend plugin result pieces could not be joined.',
}

export class BackendPluginError extends Error {
  readonly code: BackendPluginErrorCode
  readonly requestId?: WireRequestId
  readonly pluginCode?: string
  /** TIMEOUT: `execution` or `transfer-idle`; CHUNKS_INVALID: the join reason (contract 4.4). */
  readonly reason?: string
  override readonly cause?: unknown

  constructor(
    code: BackendPluginErrorCode,
    message = ERROR_MESSAGES[code],
    options: { requestId?: WireRequestId; pluginCode?: string; cause?: unknown; reason?: string } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'BackendPluginError'
    this.code = code
    this.requestId = options.requestId
    this.pluginCode = options.pluginCode
    this.reason = options.reason
    this.cause = options.cause
  }
}

export type WireRequestId = string | number

export interface BackendPluginCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Host-only origin override; never accepted from child payloads. */
  initiator?: AuthenticatedInitiator
  /** Told each time the call makes progress (contract 4.4, Timing): an argument
   *  piece left the output queue, the call was written, a result piece arrived. */
  onTransferProgress?: (phase: 'arguments' | 'execution' | 'result') => void
  /** Host-only: settle with a {@link BackendResultText} in place of the parsed
   *  value. A result longer than one piece is then never joined or parsed on
   *  this thread (agent tools, contract 4.4, R1 to R2). */
  resultText?: boolean
}

/** A call's result as its compact JSON spelling in pieces, never parsed by the Host. */
export interface BackendResultText {
  /** UTF-8 bytes of the whole spelling. */
  readonly bytes: number
  readonly chunks: number
  /** Piece `index`, decoded when asked for: at most AGENT_TOOL_CHUNK_BYTES bytes. */
  piece(index: number): string
}

export interface BackendPluginEvent {
  subscriptionId: WireRequestId
  event: string
  payload: JsonValue
}

export interface BackendPluginProgress {
  progressToken: WireRequestId
  progress: number
  total?: number
  message?: string
}

export interface BackendPluginSubscriptionOptions {
  signal?: AbortSignal
  timeoutMs?: number
  onProgress?: (progress: BackendPluginProgress) => void
  /** Host-only origin override; never accepted from child payloads. */
  initiator?: AuthenticatedInitiator
}

export type BackendPluginSubscriptionCloseReason =
  | 'backend-closed'
  | 'backend-unavailable'
  | 'cancelled'
  | 'view-destroyed'
  | 'plugin-stopping'
  | 'protocol-error'
  | 'timeout'

export interface BackendPluginSubscriptionResult {
  reason: BackendPluginSubscriptionCloseReason
  error?: BackendPluginError
}

export interface BackendPluginSubscription {
  readonly subscriptionId: WireRequestId | undefined
  readonly acknowledged: Promise<void>
  readonly settled: Promise<BackendPluginSubscriptionResult>
  dispose(reason?: 'cancelled' | 'view-destroyed' | 'plugin-stopping'): void
}

export interface PluginBackendClient {
  call<Result extends JsonValue>(
    name: string,
    args: JsonValue,
    options?: BackendPluginCallOptions
  ): Promise<Result>
  subscribe(
    events: readonly string[],
    listener: (event: BackendPluginEvent) => void,
    options?: BackendPluginSubscriptionOptions
  ): BackendPluginSubscription
}

export interface BackendServerInfo {
  name: string
  version: string
}

export interface BackendHealth {
  value: JsonValue
  serverInfo: BackendServerInfo
}

/** Bytes and frames of one kind waiting in a child's Host→child output queue, now and at the most. */
export interface BackendQueueUsage {
  frames: number
  bytes: number
  peakFrames: number
  peakBytes: number
}

/**
 * What one backend child holds right now and the most it has held since its
 * supervisor was created. None of these are capped (user ruling): they are
 * disclosed instead, for the activity page (D-f).
 */
export interface BackendChildResourceUsage {
  subscriptions: { current: number; peak: number }
  bridgeRequests: { current: number; peak: number }
  outputQueue: { requests: BackendQueueUsage; notifications: BackendQueueUsage }
  /** Always 0 now that notifications are never dropped; kept for older readers. */
  droppedNotifications: number
  /** Result pieces that arrived for a call no longer pending and were dropped (contract 4.4, R1). */
  droppedResultPieces: number
  /**
   * Bytes of a stdout frame the child has started but not ended (no newline
   * yet), held in Host memory; `peakBytes` since this supervisor was created.
   * A frame has no size limit, so a child that never ends one grows this
   * without bound: disclosed, never cut off.
   */
  stdoutPending: { bytes: number; peakBytes: number }
}

export interface PluginBackendSupervisorOptions {
  environment: Readonly<Record<string, string>>
  spawnProcess?: (entryFile: string, options: SpawnOptions) => ChildProcessWithoutNullStreams
  clientCapabilities?: { [key: string]: JsonValue }
  clientInfo?: { name: string; version: string }
  healthTimeoutMs?: number
  callTimeoutMs?: number
  shutdownTimeoutMs?: number
  drainTimeoutMs?: number
  /** Timeout for one child-to-Host Bridge operation; watches are unbounded. */
  bridgeTimeoutMs?: number
  maxFrameBytes?: number
  onStderr?: (chunk: string) => void
  /** Host-private child-to-core Bridge dispatcher. Never exposed to SDK code. */
  bridgeDispatcher?: BackendBridgeDispatcher
  /** Mutable Host-owned root, refreshed before a restarted generation starts. */
  authorizedPlanRoot?: AuthorizedPlanRootBinding
  refreshAuthorizedPlanRoot?: (signal: AbortSignal) => Promise<string>
  /** Host-only activation check run after root refresh and before each child spawn. */
  beforeSpawn?: () => void | Promise<void>
  /** Resolve the current agent policy for a Host-bound bridge operation. */
  resolveExecutionPolicy?: (
    runtime: BackendRuntimeContext,
    workspacePath?: string,
  ) => ExecutionPolicySnapshot | undefined
  /** Notify the Host when this child generation becomes unusable. */
  onFailure?: (error: BackendPluginError) => void
  /** Kept for older callers: Host event notifications are never dropped any
   *  more (user ruling: no queue limit), so this is never called. */
  onNotificationDropped?: () => void
}

export interface AuthorizedPlanRootBinding {
  value: string | null
}

/** One stdout frame: its bytes, or for a frame over the off-thread threshold
 *  the chunks it came in, handed to the worker without being joined here. */
type StdoutLine = Buffer | { readonly parts: Uint8Array[] }

interface PendingRequest {
  readonly generation: ChildGeneration
  readonly origin?: PlansBridgeOrigin
  readonly resolve: (response: BackendWireResponse) => void
  readonly reject: (error: BackendPluginError) => void
  readonly cleanup: () => void
  /** Takes one result piece (contract 4.4, R1); `pieces` holds them in order,
   *  as bytes when they came as bytes and the caller takes text. */
  readonly receivePiece: (seq: JsonValue, data: JsonValue, dataBytes?: Uint8Array) => void
  readonly pieces: Array<string | Uint8Array>
  /** UTF-8 bytes of `pieces`, counted as each arrives. */
  readonly pieceBytes: () => number
  /** The caller takes the result as text (`resultText`). */
  readonly resultText: boolean
}

interface BridgeOriginBinding {
  readonly generation: ChildGeneration
  readonly origin: PlansBridgeOrigin
  readonly runtime: BackendRuntimeContext
  readonly workspacePath?: string
  readonly authorizedPlanRoot?: string
}

interface PendingBridgeRequest {
  readonly generation: ChildGeneration
  readonly originKey: string
  readonly request: BackendBridgeRequestFrame
  readonly runtime: BackendRuntimeContext
  readonly workspacePath?: string
  readonly authorizedPlanRoot?: string
  readonly controller: AbortController
  timeoutTimer?: ReturnType<typeof setTimeout>
}

interface ChildGeneration {
  readonly id: number
  readonly child: ChildProcessWithoutNullStreams
  exited: boolean
  /** Bytes of the unterminated frame so far, joined once its newline arrives. */
  stdoutPending: Buffer[]
  stdoutPendingBytes: number
  /** Frames that arrived while a larger one is parsed off the main thread, in order. */
  parkedLines: StdoutLine[] | null
  /** An exit that came while frames were still parsed off the main thread: handled after them. */
  exitAfterFrames?: { code: number | null; signal: NodeJS.Signals | null }
  /** Time spent on this child's stdout in the current event-loop turn, and the pause it may cause. */
  stdoutTurnMs: number
  stdoutTurnScheduled: boolean
  stdoutPaused: boolean
  stderrBuffer: Buffer
  stderrTruncated: boolean
  diagnosticEmittedBytes: number
  diagnosticTruncated: boolean
  readonly exitPromise: Promise<void>
  outputQueue: Buffer[]
  outputQueueBytes: number
  /** The queued frames that are Host event notifications, and their bytes:
   *  only these count against the notification backlog bound. */
  outputNotificationFrames: Set<Buffer>
  outputNotificationBytes: number
  outputWriting: boolean
  droppedNotifications: number
  /** Resolved each time the output queue runs empty (argument pieces wait on it). */
  drainWaiters: Array<() => void>
  /** The child's navide/health said it reads argument pieces (contract 4.4, A3). */
  acceptsArgumentChunks: boolean
  resolveExit?: () => void
  terminationTask?: Promise<void>
  listeners: {
    stdout: (chunk: Buffer | string) => void
    stderr: (chunk: Buffer | string) => void
    error: (err?: unknown) => void
    exit: (code?: number | null, signal?: NodeJS.Signals | null) => void
  }
}

interface SuccessResponse {
  kind: 'success'
  id: WireRequestId
  value?: JsonValue
  serverInfo: BackendServerInfo
  subscriptionId?: WireRequestId
  /** `{chunks, bytes}` of a result sent in pieces, in place of `value` (contract 4.4, R1). */
  resultChunks?: JsonValue
  /** navide/health only: the child reads argument pieces (contract 4.4, A3). */
  argumentChunks?: boolean
  /** A value parsed off the main thread, as its UTF-8 spelling and piece cuts (`value` is null). */
  offThreadValue?: { bytes: Uint8Array; cuts: number[] }
  /** A result received in pieces and kept as text, for a `resultText` call. */
  resultPieces?: { pieces: Array<string | Uint8Array>; bytes: number }
}

interface PluginErrorResponse {
  kind: 'plugin-error'
  id: WireRequestId
  pluginCode: string
}

interface ProtocolErrorResponse {
  kind: 'protocol-error'
  id?: WireRequestId
}

type BackendWireResponse = SuccessResponse | PluginErrorResponse | ProtocolErrorResponse

interface SubscriptionAcknowledgedNotification {
  kind: 'subscription-acknowledged'
  subscriptionId: WireRequestId
  events: readonly string[]
}

interface EventNotification {
  kind: 'event'
  subscriptionId: WireRequestId
  event: string
  payload: JsonValue
}

interface ProgressNotification {
  kind: 'progress'
  progressToken: WireRequestId
  progress: number
  total?: number
  message?: string
}

export interface BackendBridgeRequestFrame {
  kind: 'bridge-request'
  id: string
  origin: PlansBridgeOrigin
  port: PlansBridgePort
  operation: string
  arguments: JsonValue
}

interface BackendBridgeCancellationNotification {
  kind: 'bridge-cancelled'
  requestId: WireRequestId
  reason?: string
}

interface ResultChunkNotification {
  kind: 'result-chunk'
  requestId: WireRequestId
  seq: JsonValue
  data: JsonValue
  /** The data as UTF-8, when the frame was parsed off the main thread (`data` is ""). */
  dataBytes?: Uint8Array
}

type BackendWireNotification =
  | SubscriptionAcknowledgedNotification
  | EventNotification
  | ProgressNotification
  | BackendBridgeCancellationNotification
  | ResultChunkNotification

export type BackendWireHostFrame = BackendWireResponse | BackendWireNotification | BackendBridgeRequestFrame

type SubscriptionPhase = 'pending-ack' | 'active' | 'reconnecting' | 'settled'

interface SubscriptionState {
  readonly events: readonly string[]
  readonly runtime: BackendRuntimeContext
  readonly workspacePath?: string
  readonly authorizedPlanRoot?: string
  readonly binding: AuthenticatedBackendRuntime
  readonly listener: (event: BackendPluginEvent) => void
  readonly onProgress?: (progress: BackendPluginProgress) => void
  readonly signal?: AbortSignal
  readonly acknowledged: Promise<void>
  readonly resolveAcknowledged: () => void
  readonly rejectAcknowledged: (error: BackendPluginError) => void
  readonly settled: Promise<BackendPluginSubscriptionResult>
  readonly resolveSettled: (result: BackendPluginSubscriptionResult) => void
  publicSubscription: BackendPluginSubscription
  readonly timeoutAt?: number
  timeoutTimer?: ReturnType<typeof setTimeout>
  abortListener?: () => void
  phase: SubscriptionPhase
  generation?: ChildGeneration
  requestId?: WireRequestId
  progressToken?: WireRequestId
  settledOnce: boolean
  acknowledgedOnce: boolean
}

type SupervisorState = 'idle' | 'starting' | 'ready' | 'draining' | 'restarting' | 'failed' | 'closed'

class JsonScanner {
  private index = 0

  constructor(private readonly text: string) {}

  parse(): void {
    this.parseValue()
    if (this.index !== this.text.length) throw new Error('trailing JSON data')
  }

  private parseValue(): void {
    const character = this.text[this.index]
    if (character === '"') {
      this.parseString()
      return
    }
    if (character === '{') {
      this.parseObject()
      return
    }
    if (character === '[') {
      this.parseArray()
      return
    }
    if (character === 't') {
      this.parseLiteral('true')
      return
    }
    if (character === 'f') {
      this.parseLiteral('false')
      return
    }
    if (character === 'n') {
      this.parseLiteral('null')
      return
    }
    if (character === '-' || (character >= '0' && character <= '9')) {
      this.parseNumber()
      return
    }
    throw new Error('invalid JSON value')
  }

  private parseString(): string {
    const start = this.index
    this.index += 1
    while (this.index < this.text.length) {
      const character = this.text[this.index]
      if (character === '"') {
        this.index += 1
        return this.text.slice(start, this.index)
      }
      if (character === '\\') {
        const escape = this.text[this.index + 1]
        if (escape === 'u') {
          const digits = this.text.slice(this.index + 2, this.index + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new Error('invalid Unicode escape')
          this.index += 6
        } else if (escape && '"\\/bfnrt'.includes(escape)) {
          this.index += 2
        } else {
          throw new Error('invalid string escape')
        }
        continue
      }
      if (character.charCodeAt(0) < 0x20) throw new Error('control character in string')
      this.index += 1
    }
    throw new Error('unterminated string')
  }

  private parseObject(): void {
    this.index += 1
    const keys = new Set<string>()
    if (this.text[this.index] === '}') {
      this.index += 1
      return
    }
    while (true) {
      if (this.text[this.index] !== '"') throw new Error('object key is not a string')
      const rawKey = this.parseString()
      let key: unknown
      try {
        key = JSON.parse(rawKey)
      } catch {
        throw new Error('invalid object key')
      }
      if (typeof key !== 'string' || keys.has(key)) throw new Error('duplicate object key')
      keys.add(key)
      if (this.text[this.index] !== ':') throw new Error('object key has no value')
      this.index += 1
      this.parseValue()
      if (this.text[this.index] === '}') {
        this.index += 1
        return
      }
      if (this.text[this.index] !== ',') throw new Error('invalid object separator')
      this.index += 1
    }
  }

  private parseArray(): void {
    this.index += 1
    if (this.text[this.index] === ']') {
      this.index += 1
      return
    }
    while (true) {
      this.parseValue()
      if (this.text[this.index] === ']') {
        this.index += 1
        return
      }
      if (this.text[this.index] !== ',') throw new Error('invalid array separator')
      this.index += 1
    }
  }

  private parseLiteral(literal: string): void {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      throw new Error('invalid JSON literal')
    }
    this.index += literal.length
  }

  private parseNumber(): void {
    const number = this.text
      .slice(this.index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0]
    if (!number) throw new Error('invalid JSON number')
    this.index += number.length
  }
}

export function parseBackendWireFrame(raw: Uint8Array | string): JsonValue {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
  if (bytes.length === 0) throw new Error(PROTOCOL_ERROR_MESSAGE)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (bytes.includes(0x0a) || bytes.includes(0x0d)) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (text.length === 0 || text.includes('\ufeff')) throw new Error(PROTOCOL_ERROR_MESSAGE)

  try {
    new JsonScanner(text).parse()
    const value: unknown = JSON.parse(text)
    if (!isJsonValue(value)) throw new Error('not a JSON value')
    return value
  } catch {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : isRecord(value) && Object.values(value).every((item) => isJsonValue(item, seen))
  seen.delete(value)
  return valid
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is { [key: string]: unknown } {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function hasOnlyKeys(value: unknown, keys: readonly string[]): value is { [key: string]: unknown } {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key))
}

function isRequestId(value: unknown): value is WireRequestId {
  return (
    (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value))
  )
}

function isClientMeta(value: unknown): value is { [key: string]: JsonValue } {
  if (
    !isRecord(value) ||
    value['io.modelcontextprotocol/protocolVersion'] !== MCP_PROTOCOL_REVISION ||
    !isRecord(value['io.modelcontextprotocol/clientCapabilities'])
  ) {
    return false
  }
  const clientInfo = value['io.modelcontextprotocol/clientInfo']
  return (
    clientInfo === undefined ||
    (hasExactKeys(clientInfo, ['name', 'version']) &&
      typeof clientInfo.name === 'string' &&
      clientInfo.name.length > 0 &&
      typeof clientInfo.version === 'string' &&
      clientInfo.version.length > 0)
  )
}

function isRuntimeContext(value: unknown): value is BackendRuntimeContext {
  return (
    hasExactKeys(value, [
      'pluginId',
      'packageVersion',
      'workspaceId',
      'instanceId',
      'contributionKey',
      'hostWindowId',
      'initiator',
    ]) &&
    typeof value.pluginId === 'string' &&
    value.pluginId.length > 0 &&
    typeof value.packageVersion === 'string' &&
    value.packageVersion.length > 0 &&
    ['workspaceId', 'instanceId', 'contributionKey', 'hostWindowId'].every(
      (key) => value[key] === null || typeof value[key] === 'string'
    ) &&
    isAuthenticatedInitiator(value.initiator)
  )
}

/** The method/event name rule every backend frame and launch spec is held to.
 * Exported so manifest validation refuses at install what activation would. */
export function isMethodName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u.test(value)
}

function isApprovedBridgePortList(value: unknown): value is readonly PlansBridgePort[] {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      new Set(value).size === value.length &&
      value.every((port) => isPlansBridgePort(port)))
  )
}

/** Map Bridge ports to the agent Execution Policy namespace they represent.
 * Ports without an established policy namespace remain unavailable to agents
 * until a later contract assigns one explicitly. */
function executionPolicyNamespaceForBridgePort(
  port: PlansBridgePort,
): PluginSystemNamespace | 'shell' | undefined {
  switch (port) {
    case 'filesystem':
      return 'fs'
    case 'web':
      return 'web'
    case 'shell':
      // The agent shell policy is judged on the command itself, like shell.run.
      return 'shell'
    case 'workspace-storage':
    case 'terminal':
    case 'agent-messaging':
    case 'routes':
    case 'streams':
    case 'spawn':
      return undefined
  }
  const exhaustive: never = port
  return exhaustive
}

/** The command of a shell Bridge request, or '' (which no shell policy allows). */
function bridgeShellCommand(value: JsonValue): string {
  return isRecord(value) && typeof value.command === 'string' ? value.command : ''
}

function serverInfo(value: unknown): BackendServerInfo | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    typeof value.version !== 'string' ||
    value.version.length === 0
  ) {
    return undefined
  }
  return { name: value.name, version: value.version }
}

function validateSuccessResponse(frame: { [key: string]: unknown }): SuccessResponse {
  if (!hasExactKeys(frame, ['jsonrpc', 'id', 'result']) || frame.jsonrpc !== '2.0') {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (!isRequestId(frame.id) || !isRecord(frame.result)) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (
    !hasOnlyKeys(frame.result, ['resultType', 'value', '_meta']) ||
    !Object.prototype.hasOwnProperty.call(frame.result, 'resultType') ||
    !Object.prototype.hasOwnProperty.call(frame.result, '_meta') ||
    frame.result.resultType !== 'complete'
  ) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  const hasValue = Object.prototype.hasOwnProperty.call(frame.result, 'value')
  if (hasValue && !isJsonValue(frame.result.value)) throw new Error(PROTOCOL_ERROR_MESSAGE)
  const meta = frame.result._meta
  if (!isRecord(meta)) throw new Error(PROTOCOL_ERROR_MESSAGE)
  const info = serverInfo(meta[SERVER_INFO_KEY])
  if (!info) throw new Error(PROTOCOL_ERROR_MESSAGE)
  const subscriptionId = meta[SUBSCRIPTION_ID_KEY]
  if (subscriptionId !== undefined && !isRequestId(subscriptionId)) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  // A result sent in pieces ends with its summary in place of `value`; the
  // summary itself is checked when the pieces are joined.
  const resultChunks = meta[BACKEND_WIRE_RESULT_CHUNKS_KEY]
  if (resultChunks !== undefined && (hasValue || subscriptionId !== undefined || !isJsonValue(resultChunks))) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (!hasValue && subscriptionId === undefined && resultChunks === undefined) throw new Error(PROTOCOL_ERROR_MESSAGE)
  const value = frame.result.value
  return {
    kind: 'success',
    id: frame.id,
    ...(hasValue ? { value: value as JsonValue } : {}),
    serverInfo: info,
    ...(subscriptionId !== undefined ? { subscriptionId } : {}),
    ...(resultChunks !== undefined ? { resultChunks: resultChunks as JsonValue } : {}),
    ...(isRecord(meta[BACKEND_WIRE_ARGUMENT_CHUNKS_KEY]) ? { argumentChunks: true } : {}),
  }
}

function validateErrorResponse(frame: { [key: string]: unknown }): BackendWireResponse {
  if (
    !hasOnlyKeys(frame, ['jsonrpc', 'id', 'error']) ||
    !Object.prototype.hasOwnProperty.call(frame, 'jsonrpc') ||
    !Object.prototype.hasOwnProperty.call(frame, 'error') ||
    frame.jsonrpc !== '2.0'
  ) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  const hasId = Object.prototype.hasOwnProperty.call(frame, 'id')
  if ((hasId && !isRequestId(frame.id)) || !isRecord(frame.error)) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  const errorKeys = Object.keys(frame.error)
  if (
    !Object.prototype.hasOwnProperty.call(frame.error, 'code') ||
    !Object.prototype.hasOwnProperty.call(frame.error, 'message') ||
    errorKeys.some((key) => key !== 'code' && key !== 'message' && key !== 'data')
  ) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (
    typeof frame.error.code !== 'number' ||
    !Number.isInteger(frame.error.code) ||
    typeof frame.error.message !== 'string' ||
    frame.error.message.length === 0 ||
    (frame.error.data !== undefined && !isJsonValue(frame.error.data))
  ) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (frame.error.code === 1000) {
    if (
      !hasId ||
      !isRecord(frame.error.data) ||
      typeof frame.error.data.code !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/u.test(frame.error.data.code)
    ) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    return { kind: 'plugin-error', id: frame.id as WireRequestId, pluginCode: frame.error.data.code }
  }
  return {
    kind: 'protocol-error',
    ...(hasId ? { id: frame.id as WireRequestId } : {}),
  }
}

function validateResponse(frame: JsonValue): BackendWireResponse {
  if (!isRecord(frame)) throw new Error(PROTOCOL_ERROR_MESSAGE)
  if (Object.prototype.hasOwnProperty.call(frame, 'result')) return validateSuccessResponse(frame)
  if (Object.prototype.hasOwnProperty.call(frame, 'error')) return validateErrorResponse(frame)
  throw new Error(PROTOCOL_ERROR_MESSAGE)
}

function subscriptionMeta(value: unknown): WireRequestId {
  if (!hasExactKeys(value, [SUBSCRIPTION_ID_KEY]) || !isRequestId(value[SUBSCRIPTION_ID_KEY])) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  return value[SUBSCRIPTION_ID_KEY]
}

function eventFilter(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(PROTOCOL_ERROR_MESSAGE)
  const events = value.map((event) => {
    if (!isMethodName(event)) throw new Error(PROTOCOL_ERROR_MESSAGE)
    return event
  })
  if (new Set(events).size !== events.length) throw new Error(PROTOCOL_ERROR_MESSAGE)
  return events
}

function validateBridgeRequest(frame: JsonValue): BackendBridgeRequestFrame {
  if (
    !isRecord(frame) ||
    !hasExactKeys(frame, ['jsonrpc', 'id', 'method', 'params']) ||
    frame.jsonrpc !== '2.0' ||
    typeof frame.id !== 'string' ||
    !frame.id.startsWith('bridge:') ||
    frame.id.length === 'bridge:'.length ||
    frame.method !== 'navide/host/call' ||
    !hasExactKeys(frame.params, ['origin', 'port', 'operation', 'arguments']) ||
    !isPlansBridgeOrigin(frame.params.origin) ||
    !isPlansBridgePort(frame.params.port) ||
    !isPlansBridgeOperation(frame.params.port, frame.params.operation) ||
    !isJsonValue(frame.params.arguments)
  ) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  return {
    kind: 'bridge-request',
    id: frame.id,
    origin: frame.params.origin,
    port: frame.params.port,
    operation: frame.params.operation,
    arguments: frame.params.arguments,
  }
}

function validateBridgeCancellation(frame: JsonValue): BackendBridgeCancellationNotification {
  if (
    !isRecord(frame) ||
    !hasExactKeys(frame, ['jsonrpc', 'method', 'params']) ||
    frame.jsonrpc !== '2.0' ||
    frame.method !== 'notifications/cancelled' ||
    !isRecord(frame.params) ||
    !Object.keys(frame.params).every((key) => key === 'requestId' || key === 'reason') ||
    !isRequestId(frame.params.requestId) ||
    (frame.params.reason !== undefined && typeof frame.params.reason !== 'string')
  ) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  return {
    kind: 'bridge-cancelled',
    requestId: frame.params.requestId,
    ...(frame.params.reason === undefined ? {} : { reason: frame.params.reason }),
  }
}

function validateNotification(frame: JsonValue): BackendWireNotification {
  if (!isRecord(frame) || !hasExactKeys(frame, ['jsonrpc', 'method', 'params']) || frame.jsonrpc !== '2.0') {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  if (frame.method === 'notifications/subscriptions/acknowledged') {
    if (!hasExactKeys(frame.params, ['_meta', 'notifications'])) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    const notifications = frame.params.notifications
    if (!hasExactKeys(notifications, [EVENT_FILTER_KEY])) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    return {
      kind: 'subscription-acknowledged',
      subscriptionId: subscriptionMeta(frame.params._meta),
      events: eventFilter(notifications[EVENT_FILTER_KEY]),
    }
  }
  if (frame.method === 'notifications/navide/event') {
    if (!hasExactKeys(frame.params, ['_meta', 'event', 'payload']) || !isMethodName(frame.params.event)) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    if (!isJsonValue(frame.params.payload)) throw new Error(PROTOCOL_ERROR_MESSAGE)
    return {
      kind: 'event',
      subscriptionId: subscriptionMeta(frame.params._meta),
      event: frame.params.event,
      payload: frame.params.payload,
    }
  }
  if (frame.method === BACKEND_WIRE_RESULT_CHUNK_METHOD) {
    if (!hasExactKeys(frame.params, ['requestId', 'seq', 'data']) || !isRequestId(frame.params.requestId)) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    if (!isJsonValue(frame.params.seq) || !isJsonValue(frame.params.data)) throw new Error(PROTOCOL_ERROR_MESSAGE)
    return { kind: 'result-chunk', requestId: frame.params.requestId, seq: frame.params.seq, data: frame.params.data }
  }
  if (frame.method === 'notifications/progress') {
    if (!hasOnlyKeys(frame.params, ['progressToken', 'progress', 'total', 'message'])) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    if (
      !isRecord(frame.params) ||
      !isRequestId(frame.params.progressToken) ||
      typeof frame.params.progress !== 'number' ||
      !Number.isFinite(frame.params.progress) ||
      (frame.params.total !== undefined &&
        (typeof frame.params.total !== 'number' || !Number.isFinite(frame.params.total))) ||
      (frame.params.message !== undefined && typeof frame.params.message !== 'string')
    ) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    return {
      kind: 'progress',
      progressToken: frame.params.progressToken,
      progress: frame.params.progress,
      ...(frame.params.total !== undefined ? { total: frame.params.total } : {}),
      ...(frame.params.message !== undefined ? { message: frame.params.message } : {}),
    }
  }
  throw new Error(PROTOCOL_ERROR_MESSAGE)
}

/** Host-owned framing and semantic seam for child-to-Host Backend Wire frames. */
export function parseBackendWireHostFrame(raw: Uint8Array | string): BackendWireHostFrame {
  const frame = parseBackendWireFrame(raw)
  try {
    if (isRecord(frame) && frame.method === 'navide/host/call') return validateBridgeRequest(frame)
    if (isRecord(frame) && frame.method === 'notifications/cancelled') {
      return validateBridgeCancellation(frame)
    }
    if (isRecord(frame) && typeof frame.method === 'string') return validateNotification(frame)
    return validateResponse(frame)
  } catch {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
}

function sameEventFilter(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((event) => right.includes(event))
}

function requestIdKey(requestId: WireRequestId): string {
  return `${typeof requestId}:${String(requestId)}`
}

function originKey(origin: PlansBridgeOrigin): string {
  return `${origin.kind}:${requestIdKey(origin.requestId)}`
}

function encodeFrame(frame: JsonValue): Buffer {
  const encoded = JSON.stringify(frame)
  if (typeof encoded !== 'string' || encoded.includes('\n') || encoded.includes('\r')) {
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }
  return Buffer.from(`${encoded}\n`, 'utf8')
}

function defaultSpawnProcess(entryFile: string, options: SpawnOptions): ChildProcessWithoutNullStreams {
  return spawn(entryFile, [], options) as ChildProcessWithoutNullStreams
}

/** Milliseconds of stdout work per event-loop turn before reading yields (see paceStdout). */
const STDOUT_TURN_MS = 8

// spawn() is synchronous (fork and exec). A hundred plugins starting at once
// used to spawn back to back in one turn and hold the event loop for about a
// second. Each spawn now takes its own turn so I/O runs in between; every
// child still starts, in the order its start reached this point.
let spawnTurn: Promise<unknown> = Promise.resolve()

function takeSpawnTurn(): Promise<void> {
  const turn = spawnTurn.then(() => nextTurn())
  spawnTurn = turn
  return turn
}

function waitForExit(exitPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, timeoutMs)
    void exitPromise.then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export function createAuthenticatedBackendRuntime(
  runtime: BackendRuntimeContext
): AuthenticatedBackendRuntime {
  // The future Host adapter calls this only after resolving its authenticated
  // binding. The private symbol prevents a plugin-supplied plain object from
  // being accepted by clientFor().
  if (!isRuntimeContext(runtime)) {
    throw new BackendPluginError('INVALID_RUNTIME')
  }
  const initiator: AuthenticatedInitiator = runtime.initiator.kind === 'agent'
    ? Object.freeze({
        kind: 'agent' as const,
        source: 'mcp' as const,
        id: runtime.initiator.id,
        ...(runtime.initiator.caller ? { caller: Object.freeze({ ...runtime.initiator.caller }) } : {}),
      })
    : Object.freeze({
        kind: 'user' as const,
        id: runtime.initiator.id,
      })
  const copy = { ...runtime, initiator }
  Object.defineProperty(copy, AUTHENTICATED_RUNTIME, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  Object.defineProperty(copy, AUTHENTICATED_AUDIENCE, {
    value: Object.freeze({}),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  AUTHENTICATED_RUNTIMES.add(copy)
  return Object.freeze(copy) as AuthenticatedBackendRuntime
}

export class PluginBackendSupervisor {
  private readonly spawnProcess: NonNullable<PluginBackendSupervisorOptions['spawnProcess']>
  private readonly environment: Readonly<Record<string, string>>
  private readonly approvedMethods: readonly string[]
  private readonly approvedEvents: readonly string[]
  private readonly approvedBridgePorts: readonly PlansBridgePort[]
  private readonly clientCapabilities: { [key: string]: JsonValue }
  private readonly clientInfo?: { name: string; version: string }
  private readonly healthTimeoutMs: number
  private readonly callTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly drainTimeoutMs: number
  private readonly bridgeTimeoutMs: number
  private readonly maxFrameBytes: number
  private readonly onStderr?: (chunk: string) => void
  private readonly bridgeDispatcher?: BackendBridgeDispatcher
  private readonly authorizedPlanRoot?: AuthorizedPlanRootBinding
  private readonly refreshAuthorizedPlanRoot?: (signal: AbortSignal) => Promise<string>
  private readonly beforeSpawn?: () => void | Promise<void>
  private readonly resolveExecutionPolicy?: (
    runtime: BackendRuntimeContext,
    workspacePath?: string,
  ) => ExecutionPolicySnapshot | undefined
  private readonly onFailure?: (error: BackendPluginError) => void
  private subscriptionPeak = 0
  private bridgeRequestPeak = 0
  private readonly queuePeaks = { requestFrames: 0, requestBytes: 0, notificationFrames: 0, notificationBytes: 0 }
  private rootRefreshController?: AbortController
  private state: SupervisorState = 'idle'
  private currentGeneration?: ChildGeneration
  private nextGenerationId = 0
  private readonly pending = new Map<WireRequestId, PendingRequest>()
  /** Result pieces that arrived for a call no longer pending (contract 4.4: dropped and counted). */
  private droppedResultPieces = 0
  private stdoutPendingPeak = 0
  private readonly subscriptions = new Set<SubscriptionState>()
  private readonly subscriptionsByRequestId = new Map<WireRequestId, SubscriptionState>()
  private readonly subscriptionsByProgressToken = new Map<WireRequestId, SubscriptionState>()
  private readonly ignoredRequestIds = new Set<WireRequestId>()
  private readonly bridgeOrigins = new Map<string, BridgeOriginBinding>()
  private readonly bridgeRequests = new Map<string, PendingBridgeRequest>()
  private readonly bridgeWatchOrigins = new Map<string, PendingBridgeRequest>()
  private startTask?: Promise<BackendHealth>
  private restartTask?: Promise<BackendHealth>
  private closeTask?: Promise<void>
  private health?: BackendHealth
  private failure?: BackendPluginError
  private readonly activation: BackendPluginLaunchSpec

  constructor(
    activation: BackendPluginLaunchSpec,
    options: PluginBackendSupervisorOptions
  ) {
    if (
      !activation ||
      typeof activation.pluginId !== 'string' ||
      activation.pluginId.length === 0 ||
      typeof activation.packageVersion !== 'string' ||
      activation.packageVersion.length === 0 ||
      typeof activation.packageDir !== 'string' ||
      activation.packageDir.length === 0 ||
      typeof activation.entryFile !== 'string' ||
      activation.entryFile.length === 0 ||
      activation.protocolVersion !== 1 ||
      activation.activation !== 'startup' ||
      !isApprovedMethodList(activation.approvedMethods) ||
      !isAgentMethodList(activation.agentMethods, activation.approvedMethods) ||
      !isApprovedEventList(activation.approvedEvents) ||
      !isApprovedBridgePortList(activation.approvedBridgePorts) ||
      !options ||
      !isEnvironmentMap(options.environment)
    ) {
      throw new BackendPluginError('INVALID_ACTIVATION')
    }
    this.activation = Object.freeze({
      ...activation,
      approvedMethods: Object.freeze([...activation.approvedMethods]),
      ...(activation.agentMethods === undefined
        ? { agentMethods: Object.freeze([]) }
        : { agentMethods: Object.freeze([...activation.agentMethods]) }),
      approvedEvents: Object.freeze([...activation.approvedEvents]),
      ...(activation.approvedBridgePorts === undefined
        ? {}
        : { approvedBridgePorts: Object.freeze([...activation.approvedBridgePorts]) }),
    })
    this.environment = Object.freeze({ ...options.environment })
    this.approvedMethods = this.activation.approvedMethods
    this.approvedEvents = this.activation.approvedEvents
    this.approvedBridgePorts = this.activation.approvedBridgePorts ?? []
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess
    this.clientCapabilities = options.clientCapabilities ?? {}
    this.clientInfo = options.clientInfo
    // A packaged one-file backend pays PyInstaller self-extraction, CPython
    // boot and imports before it can answer. Measured on this project's own
    // 8.5 MB Plans bundle: 1.4s cold at load 36, 0.4s warm at load 14 - so the
    // former 5s budget held only about 3.5x headroom, and a loaded machine ate
    // it, dropping Plans into legacy recovery three days running. The cost of a
    // longer budget falls only on a child that is genuinely dead.
    this.healthTimeoutMs = options.healthTimeoutMs ?? 30_000
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 250
    this.drainTimeoutMs = options.drainTimeoutMs ?? this.shutdownTimeoutMs
    this.bridgeTimeoutMs = options.bridgeTimeoutMs ?? this.callTimeoutMs
    this.maxFrameBytes = options.maxFrameBytes ?? 1_048_576
    this.onStderr = options.onStderr
    this.bridgeDispatcher = options.bridgeDispatcher
    this.authorizedPlanRoot = options.authorizedPlanRoot
    this.refreshAuthorizedPlanRoot = options.refreshAuthorizedPlanRoot
    this.beforeSpawn = options.beforeSpawn
    this.resolveExecutionPolicy = options.resolveExecutionPolicy
    this.onFailure = options.onFailure
    if (
      !isRecord(this.clientCapabilities) ||
      !isJsonValue(this.clientCapabilities) ||
      (this.clientInfo !== undefined &&
        (!hasExactKeys(this.clientInfo, ['name', 'version']) ||
          typeof this.clientInfo.name !== 'string' ||
          this.clientInfo.name.length === 0 ||
          typeof this.clientInfo.version !== 'string' ||
          this.clientInfo.version.length === 0)) ||
      !isPositiveFiniteNumber(this.healthTimeoutMs) ||
      !isAllowedBackendTimeout(this.callTimeoutMs) ||
      !isPositiveFiniteNumber(this.shutdownTimeoutMs) ||
      !isAllowedBackendTimeout(this.drainTimeoutMs) ||
      !isAllowedBackendTimeout(this.bridgeTimeoutMs) ||
      !isPositiveFiniteNumber(this.maxFrameBytes)
    ) {
      throw new BackendPluginError('INVALID_ACTIVATION')
    }
  }

  /** Subscriptions, Bridge requests and output-queue backlog now and at the most; see {@link BackendChildResourceUsage}. */
  resourceUsage(): BackendChildResourceUsage {
    const generation = this.currentGeneration
    const notificationFrames = generation?.outputNotificationFrames.size ?? 0
    const notificationBytes = generation?.outputNotificationBytes ?? 0
    const peaks = this.queuePeaks
    return {
      subscriptions: { current: this.subscriptions.size, peak: this.subscriptionPeak },
      bridgeRequests: { current: this.bridgeRequests.size, peak: this.bridgeRequestPeak },
      outputQueue: {
        requests: {
          frames: (generation?.outputQueue.length ?? 0) - notificationFrames,
          bytes: (generation?.outputQueueBytes ?? 0) - notificationBytes,
          peakFrames: peaks.requestFrames,
          peakBytes: peaks.requestBytes,
        },
        notifications: {
          frames: notificationFrames,
          bytes: notificationBytes,
          peakFrames: peaks.notificationFrames,
          peakBytes: peaks.notificationBytes,
        },
      },
      droppedNotifications: generation?.droppedNotifications ?? 0,
      droppedResultPieces: this.droppedResultPieces,
      stdoutPending: { bytes: generation?.stdoutPendingBytes ?? 0, peakBytes: this.stdoutPendingPeak },
    }
  }

  async start(): Promise<BackendHealth> {
    if (this.state === 'ready' && this.health) return this.health
    if (this.state === 'starting' && this.startTask) return this.startTask
    if (this.state === 'restarting' && this.restartTask) return this.restartTask
    if (this.state === 'draining') throw new BackendPluginError('PLUGIN_STOPPING')
    if (this.state === 'failed') {
      throw this.failure ?? new BackendPluginError('BACKEND_UNAVAILABLE')
    }
    if (this.state === 'closed') throw new BackendPluginError('PLUGIN_STOPPING')

    this.state = 'starting'
    this.startTask = this.startInternal()
    try {
      return await this.startTask
    } finally {
      this.startTask = undefined
    }
  }

  clientFor(
    binding: AuthenticatedBackendRuntime,
    bridgeContext: { workspacePath?: string; authorizedPlanRoot?: string } = {},
  ): PluginBackendClient {
    if (!isAuthenticatedRuntime(binding) || !isRuntimeContext(binding)) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    if (
      binding.pluginId !== this.activation.pluginId ||
      binding.packageVersion !== this.activation.packageVersion
    ) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    const runtime = { ...binding }
    const authorizedPlanRoot = bridgeContext.authorizedPlanRoot ?? bridgeContext.workspacePath
    return Object.freeze({
      call: <Result extends JsonValue>(
        name: string,
        args: JsonValue,
        options?: BackendPluginCallOptions
      ): Promise<Result> => this.callWithRuntime<Result>(
        runtime,
        name,
        args,
        options,
        bridgeContext.workspacePath,
        authorizedPlanRoot,
      ),
      subscribe: (
        events: readonly string[],
        listener: (event: BackendPluginEvent) => void,
        options?: BackendPluginSubscriptionOptions
      ): BackendPluginSubscription => this.subscribeWithRuntime(
        binding,
        runtime,
        events,
        listener,
        options,
        bridgeContext.workspacePath,
        authorizedPlanRoot,
      ),
    })
  }

  async restart(): Promise<BackendHealth> {
    if (this.state === 'closed') throw new BackendPluginError('PLUGIN_STOPPING')
    if (this.state === 'draining') {
      if (this.restartTask) return this.restartTask
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    if (this.state === 'idle' || this.state === 'starting') {
      throw new BackendPluginError('NOT_READY')
    }
    if (this.state === 'restarting' && this.restartTask) return this.restartTask

    this.restartTask = this.restartInternal()
    try {
      return await this.restartTask
    } finally {
      this.restartTask = undefined
    }
  }

  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    if (this.state === 'closed' && !this.currentGeneration) return
    this.closeTask = this.closeInternal()
    try {
      await this.closeTask
    } finally {
      this.closeTask = undefined
    }
  }

  private async closeInternal(): Promise<void> {
    this.state = 'draining'
    this.rootRefreshController?.abort()
    const generation = this.currentGeneration
    if (generation) await this.drainPending(generation)
    this.rejectPending(new BackendPluginError('PLUGIN_STOPPING'), true, 'stopping')
    this.settleAllSubscriptions({
      reason: 'plugin-stopping',
      error: new BackendPluginError('PLUGIN_STOPPING'),
    })
    this.abortAllBridgeRequests()
    this.ignoredRequestIds.clear()
    this.state = 'closed'
    if (generation) {
      await this.requestTermination(generation, false)
      this.disposeGeneration(generation)
      if (this.currentGeneration === generation) this.currentGeneration = undefined
    }
    if (this.authorizedPlanRoot) this.authorizedPlanRoot.value = null
  }

  private subscribeWithRuntime(
    binding: AuthenticatedBackendRuntime,
    runtime: BackendRuntimeContext,
    events: readonly string[],
    listener: (event: BackendPluginEvent) => void,
    options: BackendPluginSubscriptionOptions = {},
    workspacePath?: string,
    authorizedPlanRoot?: string,
  ): BackendPluginSubscription {
    if (this.state !== 'ready') {
      throw this.failure ?? new BackendPluginError(this.lifecycleErrorCode())
    }
    if (
      !isRecord(options) ||
      (options.signal !== undefined && !isAbortSignalLike(options.signal)) ||
      (options.onProgress !== undefined && typeof options.onProgress !== 'function')
    ) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    if (!isViewRuntime(runtime) || !isAuthenticatedRuntime(binding) || !isRuntimeContext(binding)) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    if (
      !isApprovedEventList(events) ||
      events.length === 0 ||
      events.some((event) => !this.approvedEvents.includes(event)) ||
      typeof listener !== 'function' ||
      (options.timeoutMs !== undefined && !isAllowedBackendTimeout(options.timeoutMs))
    ) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    if (options.signal?.aborted) {
      throw new BackendPluginError('USER_CANCELLED')
    }

    let resolveAcknowledged!: () => void
    let rejectAcknowledged!: (error: BackendPluginError) => void
    const acknowledged = new Promise<void>((resolve, reject) => {
      resolveAcknowledged = resolve
      rejectAcknowledged = reject
    })
    let resolveSettled!: (result: BackendPluginSubscriptionResult) => void
    const settled = new Promise<BackendPluginSubscriptionResult>((resolve) => {
      resolveSettled = resolve
    })
    const timeoutAt = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs
    const state = {
      events: Object.freeze([...events]),
      runtime: Object.freeze({ ...runtime }),
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(authorizedPlanRoot === undefined ? {} : { authorizedPlanRoot }),
      binding,
      listener,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      acknowledged,
      resolveAcknowledged,
      rejectAcknowledged,
      settled,
      resolveSettled,
      publicSubscription: undefined as unknown as BackendPluginSubscription,
      ...(timeoutAt !== undefined ? { timeoutAt } : {}),
      phase: 'pending-ack' as SubscriptionPhase,
      settledOnce: false,
      acknowledgedOnce: false,
    } as SubscriptionState
    const publicSubscription: BackendPluginSubscription = {
      get subscriptionId(): WireRequestId | undefined {
        return state.requestId
      },
      acknowledged,
      settled,
      dispose: (reason = 'cancelled'): void => {
        this.cancelSubscription(state, reason)
      },
    }
    state.publicSubscription = publicSubscription
    this.subscriptions.add(state)
    this.subscriptionPeak = Math.max(this.subscriptionPeak, this.subscriptions.size)
    if (options.timeoutMs !== undefined) {
      state.timeoutTimer = setTimeout(() => this.timeoutSubscription(state), options.timeoutMs)
    }
    if (options.signal) {
      state.abortListener = (): void => this.cancelSubscription(state, 'cancelled')
      options.signal.addEventListener('abort', state.abortListener, { once: true })
    }
    this.issueSubscription(state)
    return publicSubscription
  }

  private issueSubscription(state: SubscriptionState): void {
    if (state.settledOnce || this.state !== 'ready') return
    const generation = this.currentGeneration
    if (!generation) {
      this.failProcess(
        undefined,
        'BACKEND_UNAVAILABLE',
        false,
        new Error('subscription issued while no child generation is live'),
      )
      return
    }
    const requestId = this.nextRequestId()
    state.generation = generation
    state.requestId = requestId
    state.progressToken = requestId
    state.phase = 'pending-ack'
    this.subscriptionsByRequestId.set(requestId, state)
    this.subscriptionsByProgressToken.set(requestId, state)
    this.registerBridgeOrigin(
      { kind: 'subscription', requestId },
      state.runtime,
      generation,
      state.workspacePath,
      this.currentAuthorizedPlanRoot(state.authorizedPlanRoot),
    )
    try {
      if (generation.exited || generation.child.stdin.destroyed || generation.child.stdin.writableEnded) {
        throw new Error('closed')
      }
      this.writeFrame(
        generation,
        encodeFrame({
          jsonrpc: '2.0',
          id: requestId,
          method: 'subscriptions/listen',
          params: {
            _meta: this.clientMeta(requestId),
            notifications: { [EVENT_FILTER_KEY]: [...state.events] },
            runtime: { ...state.runtime },
          },
        }),
      )
    } catch (error) {
      this.failProcess(generation, 'BACKEND_UNAVAILABLE', false, error)
    }
  }

  private timeoutSubscription(state: SubscriptionState): void {
    if (state.settledOnce) return
    this.cancelSubscription(state, 'cancelled', 'timeout')
  }

  private cancelSubscription(
    state: SubscriptionState,
    reason: 'cancelled' | 'view-destroyed' | 'plugin-stopping',
    timeout?: 'timeout'
  ): void {
    if (state.settledOnce) return
    const requestId = state.requestId
    const error = new BackendPluginError(
      timeout === 'timeout' ? 'TIMEOUT' : reason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'USER_CANCELLED',
      undefined,
      requestId === undefined ? {} : { requestId }
    )
    this.settleSubscription(
      state,
      {
        reason: timeout === 'timeout'
          ? 'timeout'
          : reason === 'plugin-stopping'
            ? 'plugin-stopping'
            : reason === 'view-destroyed'
              ? 'view-destroyed'
              : 'cancelled',
        error,
      },
      true
    )
  }

  private settleSubscription(
    state: SubscriptionState,
    result: BackendPluginSubscriptionResult,
    sendCancellation: boolean
  ): void {
    if (state.settledOnce) return
    state.settledOnce = true
    state.phase = 'settled'
    const requestId = state.requestId
    const generation = state.generation
    if (requestId !== undefined) {
      this.unregisterBridgeOrigin({ kind: 'subscription', requestId }, generation)
      this.abortBridgeRequestsForOrigin({ kind: 'subscription', requestId })
      this.subscriptionsByRequestId.delete(requestId)
      this.subscriptionsByProgressToken.delete(requestId)
      if (sendCancellation) {
        this.rememberIgnoredRequestId(requestId)
        this.sendCancellation(requestId, result.reason, generation)
      }
    }
    state.generation = undefined
    if (state.timeoutTimer !== undefined) clearTimeout(state.timeoutTimer)
    if (state.abortListener && state.signal) {
      state.signal.removeEventListener('abort', state.abortListener)
    }
    state.abortListener = undefined
    if (!state.acknowledgedOnce) {
      state.acknowledgedOnce = true
      state.rejectAcknowledged(
        result.error ?? new BackendPluginError('BACKEND_UNAVAILABLE', undefined, requestId === undefined ? {} : { requestId })
      )
    }
    this.subscriptions.delete(state)
    state.resolveSettled(result)
  }

  private settleAllSubscriptions(result: BackendPluginSubscriptionResult): void {
    for (const state of [...this.subscriptions]) {
      this.settleSubscription(state, result, false)
    }
  }

  private detachSubscriptionsForRestart(): void {
    for (const state of [...this.subscriptions]) {
      if (state.settledOnce) continue
      if (state.timeoutAt !== undefined && state.timeoutAt <= Date.now()) {
        this.cancelSubscription(state, 'cancelled', 'timeout')
        continue
      }
      if (!this.isRestorableSubscription(state)) {
        this.settleSubscription(
          state,
          { reason: 'backend-unavailable', error: new BackendPluginError('BACKEND_UNAVAILABLE') },
          false
        )
        continue
      }
      if (state.requestId !== undefined) {
        this.unregisterBridgeOrigin(
          { kind: 'subscription', requestId: state.requestId },
          state.generation,
        )
        this.abortBridgeRequestsForOrigin({ kind: 'subscription', requestId: state.requestId })
        this.rememberIgnoredRequestId(state.requestId)
        this.subscriptionsByRequestId.delete(state.requestId)
        this.subscriptionsByProgressToken.delete(state.requestId)
      }
      state.requestId = undefined
      state.progressToken = undefined
      state.generation = undefined
      state.phase = 'reconnecting'
    }
  }

  private restoreSubscriptions(): void {
    for (const state of [...this.subscriptions]) {
      if (state.settledOnce) continue
      if (state.timeoutAt !== undefined && state.timeoutAt <= Date.now()) {
        this.cancelSubscription(state, 'cancelled', 'timeout')
        continue
      }
      if (!this.isRestorableSubscription(state)) {
        this.settleSubscription(
          state,
          { reason: 'backend-unavailable', error: new BackendPluginError('BACKEND_UNAVAILABLE') },
          false
        )
        continue
      }
      this.issueSubscription(state)
    }
  }

  private isRestorableSubscription(state: SubscriptionState): boolean {
    return (
      isAuthenticatedRuntime(state.binding) &&
      isRuntimeContext(state.binding) &&
      state.binding.pluginId === this.activation.pluginId &&
      state.binding.packageVersion === this.activation.packageVersion &&
      isViewRuntime(state.runtime) &&
      state.events.every((event) => this.approvedEvents.includes(event))
    )
  }

  private async restartInternal(): Promise<BackendHealth> {
    this.state = 'draining'
    const generation = this.currentGeneration
    if (generation) await this.drainPending(generation)
    this.rejectPending(new BackendPluginError('BACKEND_UNAVAILABLE'), true, 'restarting')
    this.detachSubscriptionsForRestart()
    this.abortBridgeRequestsForGeneration(generation)
    if ((this.state as SupervisorState) === 'closed') {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    this.state = 'restarting'
    if (generation) await this.requestTermination(generation, false)
    if (generation) {
      this.disposeGeneration(generation)
      if (this.currentGeneration === generation) this.currentGeneration = undefined
    }
    if ((this.state as SupervisorState) === 'closed' || this.closeTask) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    this.failure = undefined
    if (this.authorizedPlanRoot && this.refreshAuthorizedPlanRoot) {
      this.authorizedPlanRoot.value = null
    }
    this.state = 'starting'
    this.startTask = this.startInternal()
    try {
      const health = await this.startTask
      if ((this.state as SupervisorState) !== 'ready') {
        throw this.failure ?? new BackendPluginError('BACKEND_UNAVAILABLE')
      }
      this.restoreSubscriptions()
      return health
    } catch (value) {
      const error = value instanceof BackendPluginError
        ? value
        : new BackendPluginError('BACKEND_UNAVAILABLE')
      this.settleAllSubscriptions({ reason: 'backend-unavailable', error })
      throw error
    } finally {
      this.startTask = undefined
    }
  }

  private async drainPending(generation: ChildGeneration): Promise<void> {
    if (this.pendingForGeneration(generation) === 0) return
    await new Promise<void>((resolvePromise) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        resolvePromise()
      }
      const deadline = setTimeout(finish, this.drainTimeoutMs)
      const check = (): void => {
        if (settled) return
        if (this.pendingForGeneration(generation) !== 0) {
          setImmediate(check)
          return
        }
        finish()
      }
      setImmediate(check)
    })
  }

  private pendingForGeneration(generation: ChildGeneration): number {
    let count = 0
    for (const pending of this.pending.values()) {
      if (pending.generation === generation) count += 1
    }
    return count
  }

  private lifecycleErrorCode(): 'NOT_READY' | 'PLUGIN_STOPPING' {
    return this.state === 'draining' || this.state === 'restarting' || this.state === 'closed'
      ? 'PLUGIN_STOPPING'
      : 'NOT_READY'
  }

  private currentAuthorizedPlanRoot(fallback?: string): string | undefined {
    return this.authorizedPlanRoot?.value ?? fallback
  }

  private currentExecutionPolicy(
    runtime: BackendRuntimeContext,
    workspacePath?: string,
  ): ExecutionPolicySnapshot | undefined {
    try {
      return this.resolveExecutionPolicy?.(runtime, workspacePath)
    } catch {
      return undefined
    }
  }

  private async refreshRootIfNeeded(): Promise<void> {
    if (!this.authorizedPlanRoot || this.authorizedPlanRoot.value !== null) return
    if (!this.refreshAuthorizedPlanRoot) return
    const controller = new AbortController()
    this.rootRefreshController = controller
    try {
      const root = await this.refreshAuthorizedPlanRoot(controller.signal)
      if (controller.signal.aborted || this.state !== 'starting') {
        throw new BackendPluginError(this.lifecycleErrorCode())
      }
      if (typeof root !== 'string' || root.length === 0) throw new Error('invalid authorized root')
      this.authorizedPlanRoot.value = root
    } catch (error) {
      this.authorizedPlanRoot.value = null
      if (error instanceof BackendPluginError) throw error
      throw new BackendPluginError('BACKEND_UNAVAILABLE')
    } finally {
      if (this.rootRefreshController === controller) this.rootRefreshController = undefined
    }
  }

  private async startInternal(): Promise<BackendHealth> {
    try {
      await this.refreshRootIfNeeded()
      if (this.state !== 'starting') throw new BackendPluginError(this.lifecycleErrorCode())
      await this.beforeSpawn?.()
      if (this.state !== 'starting') throw new BackendPluginError(this.lifecycleErrorCode())
      await takeSpawnTurn()
      if (this.state !== 'starting') throw new BackendPluginError(this.lifecycleErrorCode())
      this.spawnChild()
      const id = this.nextRequestId()
      const response = await this.sendRequest(
        {
          jsonrpc: '2.0',
          id,
          method: 'navide/health',
          params: { _meta: this.clientMeta() },
        },
        { timeoutMs: this.healthTimeoutMs }
      )
      const health = this.successResult(response)
      if (this.state !== 'starting') {
        throw new BackendPluginError(this.lifecycleErrorCode())
      }
      if (this.currentGeneration) {
        this.currentGeneration.acceptsArgumentChunks = response.kind === 'success' && response.argumentChunks === true
      }
      this.health = health
      this.state = 'ready'
      return health
    } catch (value) {
      const error = value instanceof BackendPluginError
        ? value
        : new BackendPluginError('BACKEND_UNAVAILABLE', undefined, { cause: value })
      if (this.state !== 'closed' && this.state !== 'failed' && this.state !== 'draining') {
        this.failProcess(
          this.currentGeneration,
          error.code === 'PROTOCOL_ERROR' ? 'PROTOCOL_ERROR' : 'BACKEND_UNAVAILABLE',
          true,
          // A BackendPluginError raised in here - a health-request TIMEOUT, most
          // of all - carries no cause of its own, and the Host's diagnostic
          // emitter returns early without one. That made every startup failure
          // on this path invisible: three of them left no line at all. Hand the
          // originating error over so the reason reaches the log.
          error.cause ?? error,
        )
      }
      throw error
    }
  }

  private emitDiagnostic(cause: unknown, generation?: ChildGeneration): void {
    if (!this.onStderr) return
    const targetGen = generation ?? this.currentGeneration
    if (targetGen?.diagnosticTruncated) return
    let message = String(cause)
    if (cause instanceof Error) {
      // A stack can hold only a bare `Error` header on some runtimes; keep the
      // message. V8 stacks already carry it, so their output is unchanged.
      const stack = cause.stack
      message = stack === undefined ? cause.message : stack.includes(cause.message) ? stack : `${cause.message}\n${stack}`
    }
    message = message
      .replace(/\x1B(?:\].*?(?:\x07|\x1B\\\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_]|.?)/gu, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/gu, '')
    if (!message.endsWith('\n')) message += '\n'
    if (message.length > MAX_DIAGNOSTIC_EMITTED_BYTES) {
      message = `${message.slice(0, MAX_DIAGNOSTIC_EMITTED_BYTES)}\n... [diagnostic truncated]\n`
    }
    if (targetGen) {
      const remaining = MAX_DIAGNOSTIC_EMITTED_BYTES - targetGen.diagnosticEmittedBytes
      if (remaining <= 0) {
        targetGen.diagnosticTruncated = true
        return
      }
      if (message.length > remaining) {
        targetGen.diagnosticTruncated = true
        message = `${message.slice(0, remaining)}\n... [diagnostic truncated]\n`
      }
      targetGen.diagnosticEmittedBytes += message.length
    }
    try {
      this.onStderr(message)
    } catch {
      /* Diagnostic sinks must not affect protocol ownership. */
    }
  }

  private spawnChild(): void {
    const options: SpawnOptions = {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...this.environment },
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawnProcess(this.activation.entryFile, options)
    } catch (cause) {
      this.emitDiagnostic(cause)
      this.failProcess(undefined, 'BACKEND_UNAVAILABLE', false, cause)
      throw new BackendPluginError('BACKEND_UNAVAILABLE', undefined, { cause })
    }
    if (!child?.stdin || !child.stdout || !child.stderr) {
      const cause = new Error('Child process spawned without stdio streams')
      this.emitDiagnostic(cause)
      this.failProcess(undefined, 'BACKEND_UNAVAILABLE', false, cause)
      throw new BackendPluginError('BACKEND_UNAVAILABLE', undefined, { cause })
    }
    let resolveExit!: () => void
    const generation: ChildGeneration = {
      id: ++this.nextGenerationId,
      child,
      exited: false,
      stdoutPending: [],
      stdoutPendingBytes: 0,
      parkedLines: null,
      stdoutTurnMs: 0,
      stdoutTurnScheduled: false,
      stdoutPaused: false,
      stderrBuffer: Buffer.alloc(0),
      stderrTruncated: false,
      diagnosticEmittedBytes: 0,
      diagnosticTruncated: false,
      outputQueue: [],
      outputQueueBytes: 0,
      outputNotificationFrames: new Set(),
      outputNotificationBytes: 0,
      outputWriting: false,
      droppedNotifications: 0,
      drainWaiters: [],
      acceptsArgumentChunks: false,
      exitPromise: new Promise<void>((resolve) => {
        resolveExit = resolve
      }),
      resolveExit: undefined,
      listeners: undefined as never,
    }
    generation.resolveExit = resolveExit
    generation.listeners = {
      stdout: (chunk) => this.onStdout(generation, chunk),
      stderr: (chunk) => this.onStderrChunk(generation, chunk),
      error: (err) => this.onChildError(generation, err),
      exit: (code, signal) => this.onChildExit(generation, code, signal),
    }
    this.currentGeneration = generation
    child.stdout.on('data', generation.listeners.stdout)
    child.stderr.on('data', generation.listeners.stderr)
    child.on('error', generation.listeners.error)
    child.on('exit', generation.listeners.exit)
  }

  private onChildError(generation: ChildGeneration, cause: unknown): void {
    if (this.currentGeneration !== generation || this.state === 'closed' || this.state === 'restarting') return
    this.emitDiagnostic(cause, generation)
    this.failProcess(generation, 'BACKEND_UNAVAILABLE', false, cause)
  }

  private disposeGeneration(generation: ChildGeneration): void {
    generation.child.stdout.removeListener('data', generation.listeners.stdout)
    generation.child.stderr.removeListener('data', generation.listeners.stderr)
    generation.child.removeListener('error', generation.listeners.error)
    generation.child.removeListener('exit', generation.listeners.exit)
  }

  private onStdout(generation: ChildGeneration, chunk: Buffer | string): void {
    if (
      this.currentGeneration !== generation ||
      this.state === 'closed' ||
      this.state === 'failed' ||
      this.state === 'restarting'
    ) return
    const started = performance.now()
    try {
      this.readStdout(generation, chunk)
    } finally {
      this.paceStdout(generation, performance.now() - started)
    }
  }

  /**
   * A child that writes fast hands over many frames in one event-loop turn
   * (libuv reads up to 2 MiB per wakeup). Once a turn has spent
   * STDOUT_TURN_MS on this child's frames, reading pauses until the next
   * turn, so timers, IPC and other children run in between. Pacing, not a
   * limit: every byte is read, a few milliseconds later.
   */
  private paceStdout(generation: ChildGeneration, elapsedMs: number): void {
    generation.stdoutTurnMs += elapsedMs
    if (!generation.stdoutTurnScheduled) {
      generation.stdoutTurnScheduled = true
      setImmediate(() => {
        generation.stdoutTurnMs = 0
        generation.stdoutTurnScheduled = false
      })
    }
    if (generation.stdoutTurnMs <= STDOUT_TURN_MS || generation.stdoutPaused || generation.exited) return
    generation.stdoutPaused = true
    generation.child.stdout.pause()
    setTimeout(() => {
      generation.stdoutPaused = false
      if (!generation.exited) generation.child.stdout.resume()
    }, 0)
  }

  private readStdout(generation: ChildGeneration, chunk: Buffer | string): void {
    let rest = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    // Frames of any size are read (contract 4.4, R1): a frame's size never
    // fails or restarts the child. Only a malformed frame is a protocol error.
    // Only the new bytes are scanned, and a frame's bytes are joined once, when
    // its newline arrives, so a large frame costs linear time.
    while (true) {
      const newline = rest.indexOf(0x0a)
      if (newline < 0) {
        if (rest.length > 0) {
          generation.stdoutPending.push(rest)
          generation.stdoutPendingBytes += rest.length
          this.stdoutPendingPeak = Math.max(this.stdoutPendingPeak, generation.stdoutPendingBytes)
        }
        return
      }
      const head = rest.subarray(0, newline)
      const line: StdoutLine = generation.stdoutPendingBytes + head.length > OFF_THREAD_FRAME_BYTES
        ? { parts: [...generation.stdoutPending, head] }
        : generation.stdoutPending.length === 0 ? head : Buffer.concat([...generation.stdoutPending, head])
      generation.stdoutPending = []
      generation.stdoutPendingBytes = 0
      rest = rest.subarray(newline + 1)
      if (generation.parkedLines) {
        generation.parkedLines.push(line)
        continue
      }
      if (!this.acceptLine(generation, line)) return
    }
  }

  /** Parse and handle one frame; false once the child has failed. */
  private acceptLine(generation: ChildGeneration, line: StdoutLine): boolean {
    if (!Buffer.isBuffer(line) || line.length > OFF_THREAD_FRAME_BYTES || isLargePieceFrame(line)) {
      // A large frame is joined, decoded, checked (a carriage return fails
      // the same scan) and parsed in a worker thread; the frames after it
      // wait, so frames are still handled in the order they came.
      generation.parkedLines = []
      parseFrameOffThread(Buffer.isBuffer(line) ? [line] : line.parts, AGENT_TOOL_CHUNK_BYTES, JsonScanner).then(
        (parsed) => this.resumeAfterOffThread(generation, parsed),
        () => this.resumeAfterOffThread(generation, null),
      )
      return true
    }
    if (line.includes(0x0d)) {
      this.failProcess(generation, 'PROTOCOL_ERROR')
      return false
    }
    let frame: BackendWireHostFrame
    try {
      frame = parseBackendWireHostFrame(line)
    } catch {
      this.failProcess(generation, 'PROTOCOL_ERROR')
      return false
    }
    try {
      this.handleFrame(generation, frame)
    } catch {
      this.failProcess(generation, 'PROTOCOL_ERROR')
      return false
    }
    return true
  }

  private resumeAfterOffThread(generation: ChildGeneration, parsed: OffThreadFrame | null): void {
    try {
      this.handleOffThreadFrame(generation, parsed)
    } finally {
      // An exit held back for these frames is handled once none is left.
      const exit = generation.exitAfterFrames
      if (exit && generation.parkedLines === null) {
        generation.exitAfterFrames = undefined
        this.finishChildExit(generation, exit.code, exit.signal)
      }
    }
  }

  private handleOffThreadFrame(generation: ChildGeneration, parsed: OffThreadFrame | null): void {
    const parked = generation.parkedLines ?? []
    generation.parkedLines = null
    if (
      this.currentGeneration !== generation ||
      this.state === 'closed' ||
      this.state === 'failed' ||
      this.state === 'restarting'
    ) return
    let frame: BackendWireHostFrame
    try {
      if (!parsed) throw new Error(PROTOCOL_ERROR_MESSAGE)
      frame = parseBackendWireHostFrame(parsed.envelope)
      if (parsed.value && frame.kind === 'success') frame = { ...frame, offThreadValue: parsed.value }
      if (parsed.data && frame.kind === 'result-chunk') frame = { ...frame, dataBytes: parsed.data }
      this.handleFrame(generation, frame)
    } catch {
      this.failProcess(generation, 'PROTOCOL_ERROR')
      return
    }
    for (const [index, line] of parked.entries()) {
      // acceptLine may have parked again on a large frame: the rest wait behind it.
      const parkedAgain = generation.parkedLines as StdoutLine[] | null
      if (parkedAgain) {
        parkedAgain.push(...parked.slice(index))
        return
      }
      if (!this.acceptLine(generation, line)) return
    }
  }

  private onStderrChunk(generation: ChildGeneration, chunk: Buffer | string): void {
    if (this.currentGeneration !== generation || this.state === 'closed' || this.state === 'restarting') return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (!generation.stderrTruncated) {
      const remaining = MAX_RETAINED_STDERR_BYTES - generation.stderrBuffer.length
      if (bytes.length <= remaining) {
        generation.stderrBuffer = Buffer.concat([generation.stderrBuffer, bytes])
      } else {
        generation.stderrTruncated = true
        const kept = bytes.subarray(0, Math.max(0, remaining))
        generation.stderrBuffer = Buffer.concat([
          generation.stderrBuffer,
          kept,
          Buffer.from('\n... [stderr truncated]\n', 'utf8'),
        ])
      }
    }
    if (!this.onStderr) return
    if (generation.diagnosticTruncated) return
    const emitRemaining = MAX_DIAGNOSTIC_EMITTED_BYTES - generation.diagnosticEmittedBytes
    if (bytes.length <= emitRemaining) {
      generation.diagnosticEmittedBytes += bytes.length
      try {
        this.onStderr(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      } catch {
        /* Diagnostic sinks must not affect protocol ownership. */
      }
    } else {
      generation.diagnosticTruncated = true
      const rawText = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const kept = rawText.slice(0, Math.max(0, emitRemaining))
      const text = `${kept}\n... [stderr emission truncated]\n`
      generation.diagnosticEmittedBytes += text.length
      try {
        this.onStderr(text)
      } catch {
        /* Diagnostic sinks must not affect protocol ownership. */
      }
    }
  }

  private onChildExit(
    generation: ChildGeneration,
    code: number | null = null,
    signal: NodeJS.Signals | null = null,
  ): void {
    if (generation.exited) return
    generation.exited = true
    generation.resolveExit?.()
    generation.resolveExit = undefined
    // Frames the child wrote before it exited are still parsed off the main
    // thread: they are answers, so they are handled first.
    if (generation.parkedLines !== null && this.currentGeneration === generation) {
      generation.exitAfterFrames = { code, signal }
      return
    }
    this.finishChildExit(generation, code, signal)
  }

  private finishChildExit(
    generation: ChildGeneration,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.disposeGeneration(generation)
    if (this.currentGeneration !== generation) return
    this.ignoredRequestIds.clear()
    if (this.state === 'draining') {
      const error = new BackendPluginError(this.closeTask ? 'PLUGIN_STOPPING' : 'BACKEND_UNAVAILABLE')
      this.abortBridgeRequestsForGeneration(generation)
      this.rejectPending(error, true, this.closeTask ? 'stopping' : 'restarting')
      return
    }
    if (this.state !== 'closed' && this.state !== 'failed' && this.state !== 'restarting') {
      const isProtocolError = generation.stdoutPending.length > 0
      const isEarlyExit = this.state === 'starting' || this.state === 'idle'
      let exitCause: Error | undefined
      const stderrText = generation.stderrBuffer.length > 0 ? generation.stderrBuffer.toString('utf8') : ''
      if (isEarlyExit || stderrText || code !== 0 || signal) {
        const parts: string[] = []
        if (code !== null) parts.push(`exit code ${code}`)
        if (signal) parts.push(`signal ${signal}`)
        if (stderrText) parts.push(`stderr: ${sanitizeDiagnosticCauseText(stderrText)}`)
        const reason = isEarlyExit
          ? `Child process exited prematurely during startup (${parts.length > 0 ? parts.join(', ') : 'exit code 0 before health check'})`
          : `Child process exited unexpectedly (${parts.length > 0 ? parts.join(', ') : 'exit code 0'})`
        exitCause = new Error(reason)
        if (!stderrText) {
          this.emitDiagnostic(exitCause, generation)
        }
      } else {
        exitCause = new Error('Child process exited cleanly while ready (exit code 0)')
        this.emitDiagnostic(exitCause, generation)
      }
      this.failProcess(generation, isProtocolError ? 'PROTOCOL_ERROR' : 'BACKEND_UNAVAILABLE', false, exitCause)
    }
  }

  private handleFrame(generation: ChildGeneration, frame: BackendWireHostFrame): void {
    if (this.currentGeneration !== generation) return
    if (frame.kind === 'bridge-request') {
      this.handleBridgeRequest(generation, frame)
      return
    }
    if (frame.kind === 'bridge-cancelled') {
      this.cancelBridgeRequest(frame.requestId, frame.reason ?? 'cancelled')
      return
    }
    if (frame.kind === 'result-chunk') {
      const pending = this.pending.get(frame.requestId)
      // A piece for a call that is no longer pending (cancelled, timed out,
      // settled) is dropped and counted, never a protocol error (contract 4.4).
      if (!pending || pending.generation !== generation) {
        this.droppedResultPieces += 1
        return
      }
      pending.receivePiece(frame.seq, frame.data, frame.dataBytes)
      return
    }
    if (
      frame.kind === 'subscription-acknowledged' ||
      frame.kind === 'event' ||
      frame.kind === 'progress'
    ) {
      this.handleNotification(generation, frame)
      return
    }
    this.handleResponse(generation, frame)
  }

  private handleBridgeRequest(generation: ChildGeneration, request: BackendBridgeRequestFrame): void {
    const originBinding = this.bridgeOrigins.get(originKey(request.origin))
    const parent = request.origin.kind === 'call'
      ? this.pending.get(request.origin.requestId)
      : undefined
    const drainingCall = this.state === 'draining' &&
      request.origin.kind === 'call' &&
      parent?.generation === generation &&
      parent.origin?.kind === 'call' &&
      parent.origin.requestId === request.origin.requestId
    if (this.state !== 'ready' && !drainingCall) {
      this.sendBridgeError(
        generation,
        request.id,
        this.state === 'draining' ? 'PLUGIN_STOPPING' : 'BACKEND_UNAVAILABLE',
      )
      return
    }
    if (this.bridgeRequests.has(request.id)) {
      this.sendBridgeError(generation, request.id, 'PROTOCOL_ERROR')
      return
    }
    if (!this.approvedBridgePorts.includes(request.port)) {
      this.sendBridgeError(generation, request.id, 'CAPABILITY_DENIED')
      return
    }
    if (!originBinding || originBinding.generation !== generation) {
      this.sendBridgeError(generation, request.id, 'INVALID_RUNTIME')
      return
    }
    if (request.port === 'filesystem' && originBinding.authorizedPlanRoot === undefined) {
      this.sendBridgeError(generation, request.id, 'WORKSPACE_SCOPE_VIOLATION')
      return
    }
    const policyNamespace = executionPolicyNamespaceForBridgePort(request.port)
    if (
      originBinding.runtime.initiator.kind === 'agent' &&
      (policyNamespace === undefined || !executionPolicyAllows(
        originBinding.runtime.initiator,
        this.currentExecutionPolicy(originBinding.runtime, originBinding.workspacePath),
        policyNamespace,
        policyNamespace === 'shell' ? bridgeShellCommand(request.arguments) : undefined,
      ))
    ) {
      this.sendBridgeError(generation, request.id, 'CAPABILITY_DENIED')
      return
    }
    const requestOriginKey = originKey(request.origin)
    if (request.operation === 'watch' && this.bridgeWatchOrigins.has(requestOriginKey)) {
      this.sendBridgeError(generation, request.id, 'RESOURCE_LIMIT')
      return
    }
    const controller = new AbortController()
    const pending: PendingBridgeRequest = {
      generation,
      originKey: requestOriginKey,
      request,
      runtime: Object.freeze({ ...originBinding.runtime }),
      ...(originBinding.workspacePath === undefined ? {} : { workspacePath: originBinding.workspacePath }),
      ...(originBinding.authorizedPlanRoot === undefined
        ? {}
        : { authorizedPlanRoot: originBinding.authorizedPlanRoot }),
      controller,
    }
    if (request.operation !== 'watch') {
      pending.timeoutTimer = setTimeout(
        () => this.timeoutBridgeRequest(request.id),
        this.bridgeTimeoutMs,
      )
    }
    this.bridgeRequests.set(request.id, pending)
    this.bridgeRequestPeak = Math.max(this.bridgeRequestPeak, this.bridgeRequests.size)
    if (request.operation === 'watch') this.bridgeWatchOrigins.set(requestOriginKey, pending)
    const context: PlansBridgeContext = {
      runtime: pending.runtime,
      ...(pending.workspacePath === undefined ? {} : { workspacePath: pending.workspacePath }),
      ...(pending.authorizedPlanRoot === undefined
        ? {}
        : { authorizedPlanRoot: pending.authorizedPlanRoot }),
      requestId: request.id,
      signal: controller.signal,
      emit: (event, payload): void => {
        this.sendBridgeEvent(pending, event, payload)
      },
    }
    void (async (): Promise<void> => {
      try {
        if (!this.bridgeDispatcher) throw new PlansBridgeError('CAPABILITY_DENIED')
        const value = await this.bridgeDispatcher.dispatch(request, context)
        if (!isJsonValue(value)) throw new BackendPluginError('PROTOCOL_ERROR')
        if (!controller.signal.aborted) this.sendBridgeSuccess(generation, request.id, value)
      } catch (error) {
        if (!controller.signal.aborted) {
          this.sendBridgeError(generation, request.id, this.bridgeErrorCode(error))
        }
      } finally {
        if (this.bridgeRequests.get(request.id) === pending) {
          this.bridgeRequests.delete(request.id)
        }
        this.releaseBridgeWatchOrigin(pending)
        if (pending.timeoutTimer !== undefined) clearTimeout(pending.timeoutTimer)
      }
    })()
  }

  private timeoutBridgeRequest(requestId: string): void {
    const pending = this.bridgeRequests.get(requestId)
    if (!pending) return
    this.sendBridgeError(pending.generation, requestId, 'TIMEOUT')
    this.bridgeRequests.delete(requestId)
    this.releaseBridgeWatchOrigin(pending)
    pending.controller.abort()
    this.sendCancellation(requestId, 'timeout', pending.generation)
  }

  private bridgeErrorCode(error: unknown): PlansBridgeErrorCode | BackendPluginErrorCode {
    if (error instanceof PlansBridgeError) return error.code
    if (error instanceof BackendPluginError) return error.code
    return 'INTERNAL_ERROR'
  }

  private releaseBridgeWatchOrigin(pending: PendingBridgeRequest): void {
    if (this.bridgeWatchOrigins.get(pending.originKey) === pending) {
      this.bridgeWatchOrigins.delete(pending.originKey)
    }
  }

  private sendBridgeSuccess(generation: ChildGeneration, requestId: WireRequestId, value: JsonValue): void {
    if (this.currentGeneration !== generation || generation.exited) return
    try {
      const encoded = encodeFrame({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          resultType: 'complete',
          value,
          _meta: {
            [SERVER_INFO_KEY]: { name: 'navide.host-bridge', version: '1.0.0' },
          },
        },
      })
      if (encoded.length > MAX_BACKEND_BRIDGE_RESULT_BYTES) {
        this.sendBridgeError(generation, requestId, 'RESULT_TOO_LARGE')
        return
      }
      this.writeFrame(generation, encoded)
    } catch {
      /* The generation has already failed or is being terminated. */
    }
  }

  private sendBridgeError(
    generation: ChildGeneration,
    requestId: WireRequestId,
    code: PlansBridgeErrorCode | BackendPluginErrorCode,
  ): void {
    if (this.currentGeneration !== generation || generation.exited) return
    try {
      this.writeFrame(
        generation,
        encodeFrame({
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: 1000,
            message: 'Host Bridge request failed.',
            data: { code },
          },
        }),
      )
    } catch {
      /* The generation has already failed or is being terminated. */
    }
  }

  private sendBridgeEvent(
    pending: PendingBridgeRequest,
    event: string,
    payload: JsonValue,
  ): void {
    if (
      !isMethodName(event) ||
      !isJsonValue(payload) ||
      pending.controller.signal.aborted ||
      this.bridgeRequests.get(pending.request.id) !== pending ||
      this.currentGeneration !== pending.generation ||
      pending.generation.exited
    ) return
    let encoded: Buffer
    try {
      encoded = encodeFrame({
        jsonrpc: '2.0',
        method: 'navide/host/event',
        params: {
          origin: {
            kind: pending.request.origin.kind,
            requestId: pending.request.origin.requestId,
          },
          event,
          payload,
        },
      })
    } catch {
      this.cancelBridgeRequest(pending.request.id, 'protocol-error')
      return
    }
    if (encoded.length > MAX_BACKEND_BRIDGE_QUEUE_BYTES) {
      this.cancelBridgeRequest(pending.request.id, 'resource-limit')
      return
    }
    try {
      this.writeFrame(pending.generation, encoded, 'notification')
    } catch {
      /* The generation has already failed or is being terminated. */
    }
  }

  private cancelBridgeRequest(requestId: WireRequestId, reason: string): void {
    if (typeof requestId !== 'string') return
    const pending = this.bridgeRequests.get(requestId)
    if (!pending) return
    this.bridgeRequests.delete(requestId)
    this.releaseBridgeWatchOrigin(pending)
    if (pending.timeoutTimer !== undefined) clearTimeout(pending.timeoutTimer)
    pending.controller.abort()
    this.sendCancellation(requestId, reason, pending.generation)
  }

  private registerBridgeOrigin(
    origin: PlansBridgeOrigin,
    runtime: BackendRuntimeContext,
    generation: ChildGeneration,
    workspacePath?: string,
    authorizedPlanRoot?: string,
  ): void {
    this.bridgeOrigins.set(originKey(origin), {
      generation,
      origin,
      runtime: Object.freeze({ ...runtime }),
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(authorizedPlanRoot === undefined ? {} : { authorizedPlanRoot }),
    })
  }

  private unregisterBridgeOrigin(origin: PlansBridgeOrigin, generation?: ChildGeneration): void {
    const key = originKey(origin)
    const binding = this.bridgeOrigins.get(key)
    if (!binding || (generation && binding.generation !== generation)) return
    this.bridgeOrigins.delete(key)
  }

  private abortBridgeRequestsForOrigin(origin: PlansBridgeOrigin): void {
    const key = originKey(origin)
    for (const [requestId, pending] of this.bridgeRequests) {
      if (pending.originKey !== key) continue
      this.bridgeRequests.delete(requestId)
      this.releaseBridgeWatchOrigin(pending)
      if (pending.timeoutTimer !== undefined) clearTimeout(pending.timeoutTimer)
      pending.controller.abort()
      this.sendCancellation(requestId, 'cancelled', pending.generation)
    }
  }

  private abortBridgeRequestsForGeneration(generation: ChildGeneration | undefined): void {
    if (!generation) return
    for (const [requestId, pending] of this.bridgeRequests) {
      if (pending.generation !== generation) continue
      this.bridgeRequests.delete(requestId)
      this.releaseBridgeWatchOrigin(pending)
      if (pending.timeoutTimer !== undefined) clearTimeout(pending.timeoutTimer)
      pending.controller.abort()
      this.sendCancellation(requestId, 'stopping', generation)
    }
    for (const [key, binding] of this.bridgeOrigins) {
      if (binding.generation === generation) this.bridgeOrigins.delete(key)
    }
  }

  private abortAllBridgeRequests(): void {
    for (const [requestId, pending] of this.bridgeRequests) {
      this.bridgeRequests.delete(requestId)
      this.releaseBridgeWatchOrigin(pending)
      if (pending.timeoutTimer !== undefined) clearTimeout(pending.timeoutTimer)
      pending.controller.abort()
      this.sendCancellation(requestId, 'stopping', pending.generation)
    }
    this.bridgeOrigins.clear()
    this.bridgeWatchOrigins.clear()
  }

  private handleNotification(
    generation: ChildGeneration,
    notification: Exclude<BackendWireNotification, BackendBridgeCancellationNotification | ResultChunkNotification>,
  ): void {
    if (this.currentGeneration !== generation) return
    if (notification.kind === 'subscription-acknowledged') {
      const state = this.subscriptionsByRequestId.get(notification.subscriptionId)
      if (!state) {
        if (this.ignoredRequestIds.has(notification.subscriptionId)) return
        throw new Error(PROTOCOL_ERROR_MESSAGE)
      }
      if (
        state.generation !== generation ||
        state.phase !== 'pending-ack' ||
        !sameEventFilter(state.events, notification.events)
      ) {
        throw new Error(PROTOCOL_ERROR_MESSAGE)
      }
      state.phase = 'active'
      if (!state.acknowledgedOnce) {
        state.acknowledgedOnce = true
        state.resolveAcknowledged()
      }
      return
    }
    if (notification.kind === 'event') {
      const state = this.subscriptionsByRequestId.get(notification.subscriptionId)
      if (!state) {
        if (this.ignoredRequestIds.has(notification.subscriptionId)) return
        throw new Error(PROTOCOL_ERROR_MESSAGE)
      }
      if (state.generation !== generation || state.phase !== 'active' || !state.events.includes(notification.event)) {
        throw new Error(PROTOCOL_ERROR_MESSAGE)
      }
      try {
        state.listener({
          subscriptionId: notification.subscriptionId,
          event: notification.event,
          payload: notification.payload,
        })
      } catch {
        /* Listener failures must not alter protocol ownership. */
      }
      return
    }
    const state = this.subscriptionsByProgressToken.get(notification.progressToken)
    if (!state) {
      if (this.ignoredRequestIds.has(notification.progressToken)) return
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    if (
      state.generation !== generation ||
      (state.phase !== 'pending-ack' && state.phase !== 'active')
    ) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    if (state.onProgress) {
      try {
        state.onProgress({
          progressToken: notification.progressToken,
          progress: notification.progress,
          ...(notification.total !== undefined ? { total: notification.total } : {}),
          ...(notification.message !== undefined ? { message: notification.message } : {}),
        })
      } catch {
        /* Diagnostic listeners must not affect protocol ownership. */
      }
    }
  }

  private handleResponse(generation: ChildGeneration, response: BackendWireResponse): void {
    if (this.currentGeneration !== generation) return
    const requestId = response.id
    if (requestId === undefined) {
      throw new Error(PROTOCOL_ERROR_MESSAGE)
    }
    const pending = this.pending.get(requestId)
    if (pending) {
      if (pending.generation !== generation) return
      if (response.kind === 'success' && response.resultChunks !== undefined && pending.resultText) {
        // Kept as the pieces that came: never joined or parsed here. The
        // pieces were checked as they arrived; the summary must match them.
        const summary = response.resultChunks
        const reason = !isRecord(summary) || !Number.isSafeInteger(summary.chunks) || (summary.chunks as number) < 1 ||
          !Number.isSafeInteger(summary.bytes) || (summary.bytes as number) < 0
          ? 'summary'
          : summary.chunks !== pending.pieces.length
            ? 'count'
            : summary.bytes !== pending.pieceBytes() ? 'bytes' : null
        if (reason) {
          this.rememberIgnoredRequestId(requestId)
          this.settle(requestId, () => pending.reject(new BackendPluginError('CHUNKS_INVALID', undefined, { requestId, reason })))
          return
        }
        const kept: SuccessResponse = {
          kind: 'success', id: response.id, value: null, serverInfo: response.serverInfo,
          resultPieces: { pieces: pending.pieces, bytes: pending.pieceBytes() },
        }
        this.settle(requestId, () => pending.resolve(kept))
        return
      }
      if (response.kind === 'success' && response.resultChunks !== undefined) {
        const joined = reassembleAgentToolPayloadText(
          pending.pieces.map((data, seq) => ({ seq, data: data as string })),
          response.resultChunks,
        )
        let value: JsonValue | undefined
        const reason: string = joined.ok ? 'json' : joined.reason
        if (joined.ok) {
          try {
            const parsed: unknown = JSON.parse(joined.text)
            if (isJsonValue(parsed)) value = parsed
          } catch {
            // reason stays 'json'
          }
        }
        if (value === undefined) {
          this.rememberIgnoredRequestId(requestId)
          this.settle(requestId, () => pending.reject(new BackendPluginError('CHUNKS_INVALID', undefined, { requestId, reason })))
          return
        }
        const whole: SuccessResponse = { kind: 'success', id: response.id, value, serverInfo: response.serverInfo }
        this.settle(requestId, () => pending.resolve(whole))
        return
      }
      if (response.kind === 'success') {
        this.settle(requestId, () => pending.resolve(response))
        return
      }
      if (response.kind === 'plugin-error') {
        this.settle(
          requestId,
          () =>
            pending.reject(
              new BackendPluginError(this.pluginErrorCode(response.pluginCode), undefined, {
                requestId,
                pluginCode: response.pluginCode,
              })
            )
        )
        return
      }
      this.settle(
        requestId,
        () => pending.reject(new BackendPluginError('PROTOCOL_ERROR', undefined, { requestId }))
      )
      return
    }

    const subscription = this.subscriptionsByRequestId.get(requestId)
    if (subscription) {
      if (subscription.generation !== generation) return
      if (
        response.kind === 'success' &&
        response.subscriptionId === requestId &&
        subscription.phase === 'active'
      ) {
        this.settleSubscription(subscription, { reason: 'backend-closed' }, false)
        return
      }
      const error = response.kind === 'plugin-error'
        ? new BackendPluginError(this.pluginErrorCode(response.pluginCode), undefined, {
            requestId,
            pluginCode: response.pluginCode,
          })
        : new BackendPluginError('PROTOCOL_ERROR', undefined, { requestId })
      this.settleSubscription(
        subscription,
        {
          reason: response.kind === 'plugin-error' ? 'backend-unavailable' : 'protocol-error',
          error,
        },
        false
      )
      return
    }
    if (this.ignoredRequestIds.delete(requestId)) return
    throw new Error(PROTOCOL_ERROR_MESSAGE)
  }

  private pluginErrorCode(pluginCode: string): BackendPluginErrorCode {
    return pluginCode === 'RESULT_TOO_LARGE' ? 'RESULT_TOO_LARGE' : 'PLUGIN_ERROR'
  }

  private async callWithRuntime<Result extends JsonValue>(
    runtime: BackendRuntimeContext,
    name: string,
    args: JsonValue,
    options: BackendPluginCallOptions = {},
    workspacePath?: string,
    authorizedPlanRoot?: string,
  ): Promise<Result> {
    if (this.state !== 'ready') {
      throw this.failure ?? new BackendPluginError(this.lifecycleErrorCode())
    }
    if (
      !isMethodName(name) ||
      !this.approvedMethods.includes(name) ||
      !isJsonValue(args)
    ) throw new BackendPluginError('INVALID_ARGUMENT')
    const id = this.nextRequestId()
    const meta = this.clientMeta()
    // Every call advertises that the Host joins result pieces (contract 4.4, R1).
    meta['io.modelcontextprotocol/clientCapabilities'] = {
      ...(meta['io.modelcontextprotocol/clientCapabilities'] as { [key: string]: JsonValue }),
      [BACKEND_WIRE_RESULT_CHUNKS_KEY]: {},
    }
    // Arguments longer than one piece go in pieces to a child that reads them
    // (A3); any other child gets them in one frame of any size.
    let pieces: string[] | undefined
    if (this.currentGeneration?.acceptsArgumentChunks) {
      const text = JSON.stringify(args)
      const bytes = utf8ByteLength(text)
      if (bytes > AGENT_TOOL_CHUNK_BYTES) {
        pieces = splitAgentToolPayloadText(text)
        meta[BACKEND_WIRE_ARGUMENT_CHUNKS_KEY] = { chunks: pieces.length, bytes }
      }
    }
    const response = await this.sendRequest(
      {
        jsonrpc: '2.0',
        id,
        method: 'navide/call',
        params: {
          _meta: meta,
          name,
          ...(pieces ? {} : { arguments: args }),
          runtime: { ...runtime },
        },
      },
      options,
      { kind: 'call', requestId: id },
      runtime,
      workspacePath,
      authorizedPlanRoot,
      pieces?.map((data, seq) => encodeFrame({
        jsonrpc: '2.0',
        method: BACKEND_WIRE_ARGUMENT_CHUNK_METHOD,
        params: { requestId: id, seq, data },
      })),
    )
    if (options.resultText) return this.resultTextOf(response) as unknown as Result
    const result = this.successResult(response)
    if (response.kind === 'success' && response.offThreadValue) {
      // A caller that needs the value parses it here; agent tools take text.
      const value: unknown = JSON.parse(new TextDecoder('utf-8').decode(response.offThreadValue.bytes))
      if (!isJsonValue(value)) throw new BackendPluginError('PROTOCOL_ERROR')
      return value as Result
    }
    return result.value as Result
  }

  /** A `resultText` call's result: the pieces as they came, the off-thread
   *  spelling, or (a frame within the synchronous path) the value spelled here. */
  private resultTextOf(response: BackendWireResponse): BackendResultText {
    if (response.kind === 'success' && response.resultPieces) {
      const { pieces, bytes } = response.resultPieces
      const decoder = new TextDecoder('utf-8')
      return {
        bytes,
        chunks: pieces.length,
        piece: (index) => {
          const piece = pieces[index]
          return typeof piece === 'string' ? piece : decoder.decode(piece)
        },
      }
    }
    const result = this.successResult(response)
    if (response.kind === 'success' && response.offThreadValue) {
      const { bytes, cuts } = response.offThreadValue
      const decoder = new TextDecoder('utf-8')
      return {
        bytes: bytes.length,
        chunks: cuts.length,
        piece: (index) => decoder.decode(bytes.subarray(index === 0 ? 0 : cuts[index - 1], cuts[index])),
      }
    }
    const text = JSON.stringify(result.value)
    const pieces = splitAgentToolPayloadText(text)
    return { bytes: utf8ByteLength(text), chunks: pieces.length, piece: (index) => pieces[index] }
  }

  private successResult(response: BackendWireResponse): BackendHealth {
    if (response.kind !== 'success' || response.value === undefined || response.subscriptionId !== undefined) {
      throw new BackendPluginError(response.kind === 'plugin-error' ? 'PLUGIN_ERROR' : 'PROTOCOL_ERROR')
    }
    return { value: response.value, serverInfo: response.serverInfo }
  }

  private clientMeta(progressToken?: WireRequestId): { [key: string]: JsonValue } {
    const meta: { [key: string]: JsonValue } = {
      'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_REVISION,
      'io.modelcontextprotocol/clientCapabilities': { ...this.clientCapabilities },
    }
    if (this.clientInfo) meta['io.modelcontextprotocol/clientInfo'] = { ...this.clientInfo }
    if (progressToken !== undefined) meta.progressToken = progressToken
    return meta
  }

  private sendRequest(
    frame: JsonValue,
    options: BackendPluginCallOptions,
    origin?: PlansBridgeOrigin,
    runtime?: BackendRuntimeContext,
    workspacePath?: string,
    authorizedPlanRoot?: string,
    /** Argument pieces written before the request itself (contract 4.4, A3). */
    argumentPieces?: Buffer[],
  ): Promise<BackendWireResponse> {
    const requestId = isRecord(frame) && isRequestId(frame.id) ? frame.id : undefined
    const generation = this.currentGeneration
    if (requestId === undefined || !generation || generation.exited) {
      return Promise.reject(new BackendPluginError('BACKEND_UNAVAILABLE'))
    }
    const timeoutMs = options.timeoutMs ?? this.callTimeoutMs
    if (!isAllowedBackendTimeout(timeoutMs)) {
      return Promise.reject(new BackendPluginError('INVALID_ARGUMENT'))
    }
    if (options.signal?.aborted) {
      return Promise.reject(new BackendPluginError(
        options.signal.reason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'USER_CANCELLED',
        undefined,
        { requestId },
      ))
    }

    // A request frame of any size is written (contract 4.4, A3): it waits in
    // the output queue like any other control frame and never fails the child.
    const encoded = encodeFrame(frame)
    const progress = (phase: 'arguments' | 'execution' | 'result'): void => {
      try {
        options.onTransferProgress?.(phase)
      } catch {
        // An observer must not change the call.
      }
    }

    return new Promise<BackendWireResponse>((resolve, reject) => {
      let settled = false
      // Two clocks (contract 4.4, Timing): `timeoutMs` covers the plugin's own
      // work, from writing the request to its first result frame; transfers of
      // pieces run on an idle timer that every full piece restarts.
      let executionTimer: ReturnType<typeof setTimeout> | undefined
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const startIdle = (): void => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => this.cancelPending(requestId, 'TIMEOUT', 'transfer-idle'), AGENT_TOOL_CHUNK_IDLE_MS)
        idleTimer.unref?.()
      }
      const startExecution = (): void => {
        clearTimeout(idleTimer)
        executionTimer = setTimeout(() => this.cancelPending(requestId, 'TIMEOUT', 'execution'), timeoutMs)
      }
      const abort = (): void => this.cancelPending(
        requestId,
        options.signal?.reason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'USER_CANCELLED',
      )
      options.signal?.addEventListener('abort', abort, { once: true })
      const cleanup = (): void => {
        clearTimeout(executionTimer)
        clearTimeout(idleTimer)
        options.signal?.removeEventListener('abort', abort)
        if (origin) {
          this.unregisterBridgeOrigin(origin, generation)
          this.abortBridgeRequestsForOrigin(origin)
        }
      }
      const pieces: Array<string | Uint8Array> = []
      let pieceBytes = 0
      let shortSeen = false
      const pending: PendingRequest = {
        generation,
        ...(origin ? { origin } : {}),
        resolve: (response) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(response)
        },
        reject: (error) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        },
        cleanup,
        pieces,
        pieceBytes: () => pieceBytes,
        resultText: options.resultText === true,
        receivePiece: (seq, data, dataBytes) => {
          if (settled) return
          const arrival = agentToolChunkArrival(shortSeen, data, AGENT_TOOL_CHUNK_BYTES, seq, pieces.length, dataBytes?.length)
          if (!arrival.ok) {
            this.cancelPending(requestId, 'CHUNKS_INVALID', arrival.reason)
            return
          }
          // The first result frame ends the execution clock; from there the
          // transfer runs on the idle timer, which a short piece never restarts.
          if (pieces.length === 0) {
            clearTimeout(executionTimer)
            startIdle()
          } else if (!arrival.short) {
            startIdle()
          }
          // Bytes stay bytes for a caller that takes text; one that needs the
          // value joins strings.
          pieces.push(dataBytes && options.resultText ? dataBytes : dataBytes ? new TextDecoder('utf-8').decode(dataBytes) : data as string)
          pieceBytes += dataBytes?.length ?? utf8ByteLength(data as string)
          shortSeen = arrival.short
          progress('result')
        },
      }
      this.pending.set(requestId, pending)
      if (origin && runtime) {
        this.registerBridgeOrigin(origin, runtime, generation, workspacePath, authorizedPlanRoot)
      }
      const write = (bytes: Buffer): boolean => {
        try {
          if (generation.exited || generation.child.stdin.destroyed || generation.child.stdin.writableEnded) {
            throw new Error(
              `child stdin not writable (exited=${generation.exited}, destroyed=${generation.child.stdin.destroyed}, ended=${generation.child.stdin.writableEnded})`,
            )
          }
          this.writeFrame(generation, bytes)
          return true
        } catch (error) {
          this.failProcess(generation, 'BACKEND_UNAVAILABLE', false, error)
          return false
        }
      }
      if (!argumentPieces || argumentPieces.length === 0) {
        if (write(encoded)) {
          startExecution()
          progress('execution')
        }
        return
      }
      // Argument pieces: each is written once the output queue is empty, so
      // frames of other calls interleave; a queue that does not drain within
      // the idle time ends the call as transfer-idle.
      void (async (): Promise<void> => {
        for (const piece of argumentPieces) {
          if (settled) return
          startIdle()
          if (!write(piece)) return
          if (!(await this.waitForDrain(generation))) {
            if (!settled) this.cancelPending(requestId, 'TIMEOUT', 'transfer-idle')
            return
          }
          progress('arguments')
        }
        if (settled) return
        if (write(encoded)) {
          startExecution()
          progress('execution')
        }
      })()
    })
  }

  /** Resolves true once the generation's output queue is empty, false after the idle time or when it ends. */
  private waitForDrain(generation: ChildGeneration): Promise<boolean> {
    if (!generation.outputWriting && generation.outputQueue.length === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      let done = false
      const finish = (drained: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(drained)
      }
      const timer = setTimeout(() => finish(false), AGENT_TOOL_CHUNK_IDLE_MS)
      timer.unref?.()
      generation.drainWaiters.push(() => finish(!generation.exited && this.currentGeneration === generation))
    })
  }

  private cancelPending(
    requestId: WireRequestId,
    code: 'TIMEOUT' | 'USER_CANCELLED' | 'PLUGIN_STOPPING' | 'CHUNKS_INVALID',
    reason?: string,
  ): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    this.rememberIgnoredRequestId(requestId)
    pending.cleanup()
    pending.reject(new BackendPluginError(code, undefined, { requestId, ...(reason ? { reason } : {}) }))
    this.sendCancellation(requestId, undefined, pending.generation)
  }

  private sendCancellation(
    requestId: WireRequestId,
    reason?: string,
    generation?: ChildGeneration
  ): void {
    try {
      if (
        !generation ||
        this.currentGeneration !== generation ||
        generation.exited ||
        generation.child.stdin.destroyed
      ) return
      this.writeFrame(
        generation,
        encodeFrame({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId, ...(reason ? { reason } : {}) },
        }),
      )
    } catch {
      /* Cancellation is best effort; the original safe error has already settled. */
    }
  }

  private settle(requestId: WireRequestId, action: () => void): void {
    const pending = this.pending.get(requestId)
    if (!pending) throw new Error(PROTOCOL_ERROR_MESSAGE)
    this.pending.delete(requestId)
    pending.cleanup()
    action()
  }

  private rejectPending(
    error: BackendPluginError,
    rememberRequestIds = false,
    cancellationReason?: string,
  ): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId)
      if (rememberRequestIds) this.rememberIgnoredRequestId(requestId)
      pending.cleanup()
      pending.reject(error)
      if (cancellationReason) this.sendCancellation(requestId, cancellationReason, pending.generation)
    }
  }

  private failProcess(
    generation: ChildGeneration | undefined,
    code: 'BACKEND_UNAVAILABLE' | 'PROTOCOL_ERROR',
    terminate = true,
    cause?: unknown,
  ): void {
    if (generation && this.currentGeneration !== generation) return
    if (this.state === 'closed' || this.state === 'restarting') return
    if (this.state === 'draining') {
      const error = new BackendPluginError(this.closeTask ? 'PLUGIN_STOPPING' : 'BACKEND_UNAVAILABLE', undefined, { cause })
      this.abortBridgeRequestsForGeneration(generation)
      this.rejectPending(error, true, this.closeTask ? 'stopping' : 'restarting')
      return
    }
    const firstFailure = this.failure === undefined
    const error = this.failure ?? new BackendPluginError(code, undefined, { cause })
    if (code === 'PROTOCOL_ERROR') {
      this.settleAllSubscriptions({ reason: 'protocol-error', error })
    } else {
      this.detachSubscriptionsForRestart()
    }
    this.failure = error
    if (this.authorizedPlanRoot) this.authorizedPlanRoot.value = null
    this.state = 'failed'
    this.ignoredRequestIds.clear()
    this.abortBridgeRequestsForGeneration(generation)
    this.rejectPending(error)
    if (firstFailure) {
      try {
        this.onFailure?.(error)
      } catch {
        // Failure observation must not interrupt child teardown or reject the
        // calls already being settled above.
      }
    }
    if (terminate && generation && !generation.exited) {
      void this.requestTermination(generation, code === 'PROTOCOL_ERROR')
    }
  }

  private requestTermination(generation: ChildGeneration, force: boolean): Promise<void> {
    if (generation.exited) return Promise.resolve()
    if (generation.terminationTask && !force) return generation.terminationTask
    const child = generation.child
    const task = (async (): Promise<void> => {
      if (force) {
        generation.outputQueue = []
        generation.outputQueueBytes = 0
        generation.outputNotificationFrames.clear()
        generation.outputNotificationBytes = 0
        try {
          child.stdin.destroy()
        } catch {
          /* already closed */
        }
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
      } else {
        await this.waitForOutputQueue(generation)
        try {
          child.stdin.end()
        } catch {
          /* already closed */
        }
      }
      if (await waitForExit(generation.exitPromise, this.shutdownTimeoutMs)) return
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      if (await waitForExit(generation.exitPromise, this.shutdownTimeoutMs)) return
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      await waitForExit(generation.exitPromise, this.shutdownTimeoutMs)
    })()
    generation.terminationTask = task
    return task
  }

  private async waitForOutputQueue(generation: ChildGeneration): Promise<void> {
    const drained = await new Promise<boolean>((resolvePromise) => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        resolvePromise(value)
      }
      const deadline = setTimeout(() => finish(false), this.shutdownTimeoutMs)
      const check = (): void => {
        if (generation.outputQueue.length === 0 && !generation.outputWriting) {
          finish(true)
          return
        }
        if (!generation.exited) setTimeout(check, 0)
        else finish(true)
      }
      check()
    })
    if (!drained) {
      generation.outputQueue = []
      generation.outputQueueBytes = 0
      generation.outputNotificationFrames.clear()
      generation.outputNotificationBytes = 0
    }
  }

  /**
   * Serialize all Host→child frames.
   *
   * A 'control' frame - a request, a response, a cancellation - is part of a
   * protocol exchange someone is waiting on, so it is always queued: a backlog
   * of requests is load, not a dead child (with no cap on in-flight calls, 500
   * concurrent calls used to overflow the queue and kill the child). A
   * 'notification' frame carries a Host event; it is queued too and never
   * dropped (user ruling: no queue limit). Both backlogs are counted apart and
   * disclosed through resourceUsage().
   */
  private writeFrame(
    generation: ChildGeneration,
    frame: Buffer,
    kind: 'control' | 'notification' = 'control',
  ): void {
    if (
      this.currentGeneration !== generation ||
      generation.exited ||
      generation.child.stdin.destroyed ||
      generation.child.stdin.writableEnded
    ) throw new Error('closed')
    generation.outputQueue.push(frame)
    generation.outputQueueBytes += frame.length
    if (kind === 'notification') {
      generation.outputNotificationFrames.add(frame)
      generation.outputNotificationBytes += frame.length
    }
    const peaks = this.queuePeaks
    peaks.requestFrames = Math.max(peaks.requestFrames, generation.outputQueue.length - generation.outputNotificationFrames.size)
    peaks.requestBytes = Math.max(peaks.requestBytes, generation.outputQueueBytes - generation.outputNotificationBytes)
    peaks.notificationFrames = Math.max(peaks.notificationFrames, generation.outputNotificationFrames.size)
    peaks.notificationBytes = Math.max(peaks.notificationBytes, generation.outputNotificationBytes)
    this.flushOutput(generation)
  }

  private flushOutput(generation: ChildGeneration): void {
    if (
      generation.outputWriting ||
      this.currentGeneration !== generation ||
      generation.exited
    ) return
    const frame = generation.outputQueue.shift()
    if (!frame) {
      for (const waiter of generation.drainWaiters.splice(0)) waiter()
      return
    }
    generation.outputQueueBytes -= frame.length
    if (generation.outputNotificationFrames.delete(frame)) generation.outputNotificationBytes -= frame.length
    generation.outputWriting = true
    try {
      generation.child.stdin.write(frame, (error?: Error | null) => {
        generation.outputWriting = false
        if (error) {
          // Keep the write error as the cause. Dropping it here left every
          // stdin failure - EPIPE, a child that never came up, a spawn that
          // failed after the first write - reported as a bare
          // BACKEND_UNAVAILABLE with nothing to read.
          this.failProcess(generation, 'BACKEND_UNAVAILABLE', false, error)
          return
        }
        this.flushOutput(generation)
      })
    } catch (error) {
      generation.outputWriting = false
      this.failProcess(generation, 'BACKEND_UNAVAILABLE', false, error)
    }
  }

  private nextRequestId(): string {
    let requestId: string
    do {
      requestId = randomUUID()
    } while (
      this.pending.has(requestId) ||
      this.subscriptionsByRequestId.has(requestId) ||
      this.ignoredRequestIds.has(requestId)
    )
    return requestId
  }

  private rememberIgnoredRequestId(requestId: WireRequestId): void {
    this.ignoredRequestIds.delete(requestId)
    this.ignoredRequestIds.add(requestId)
    while (this.ignoredRequestIds.size > MAX_IGNORED_REQUEST_IDS) {
      const oldest = this.ignoredRequestIds.values().next()
      if (oldest.done) return
      this.ignoredRequestIds.delete(oldest.value)
    }
  }
}

function isAuthenticatedRuntime(value: unknown): value is AuthenticatedBackendRuntime {
  return (
    isRecord(value) &&
    AUTHENTICATED_RUNTIMES.has(value) &&
    (value as { [AUTHENTICATED_RUNTIME]?: true })[AUTHENTICATED_RUNTIME] === true &&
    typeof (value as { [AUTHENTICATED_AUDIENCE]?: object })[AUTHENTICATED_AUDIENCE] === 'object'
  )
}

function isViewRuntime(value: BackendRuntimeContext): boolean {
  return (
    typeof value.workspaceId === 'string' &&
    value.workspaceId.length > 0 &&
    typeof value.instanceId === 'string' &&
    value.instanceId.length > 0 &&
    typeof value.contributionKey === 'string' &&
    value.contributionKey.length > 0 &&
    (value.hostWindowId === null || (
      typeof value.hostWindowId === 'string' &&
      value.hostWindowId.length > 0
    ))
  )
}

function isApprovedMethodList(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((method) => isMethodName(method))
}

function isAgentMethodList(
  value: unknown,
  approvedMethods: readonly string[],
): value is readonly string[] {
  return value === undefined || (
    isApprovedMethodList(value) &&
    value.every((method) => approvedMethods.includes(method))
  )
}

function isApprovedEventList(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((event) => isMethodName(event))
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
  )
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isEnvironmentMap(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string' || !ENVIRONMENT_KEY_PATTERN.test(key)) return false
    const environmentValue = value[key]
    return typeof environmentValue === 'string' && !environmentValue.includes('\u0000')
  })
}
