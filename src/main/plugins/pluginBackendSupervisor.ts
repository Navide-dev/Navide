import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { TextDecoder } from 'node:util'
import {
  isAllowedBackendTimeout,
  MAX_BACKEND_BRIDGE_REQUESTS,
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

/** Private Electron-main seam for Backend Wire v1 conformance tests. */
export const MCP_PROTOCOL_REVISION = '2026-07-28'
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'
const SUBSCRIPTION_ID_KEY = 'io.modelcontextprotocol/subscriptionId'
const EVENT_FILTER_KEY = 'dev.navide/pluginEvents'
const PROTOCOL_ERROR_MESSAGE = 'Backend plugin returned an invalid protocol message.'
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
/** Live cancellation tombstones kept per child; the oldest is evicted past it. */
export const MAX_IGNORED_REQUEST_IDS = 256
const MAX_ACTIVE_SUBSCRIPTIONS = 256
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
}

export class BackendPluginError extends Error {
  readonly code: BackendPluginErrorCode
  readonly requestId?: WireRequestId
  readonly pluginCode?: string
  override readonly cause?: unknown

  constructor(
    code: BackendPluginErrorCode,
    message = ERROR_MESSAGES[code],
    options: { requestId?: WireRequestId; pluginCode?: string; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'BackendPluginError'
    this.code = code
    this.requestId = options.requestId
    this.pluginCode = options.pluginCode
    this.cause = options.cause
  }
}

export type WireRequestId = string | number

export interface BackendPluginCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Host-only origin override; never accepted from child payloads. */
  initiator?: AuthenticatedInitiator
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
}

export interface AuthorizedPlanRootBinding {
  value: string | null
}

interface PendingRequest {
  readonly generation: ChildGeneration
  readonly origin?: PlansBridgeOrigin
  readonly resolve: (response: BackendWireResponse) => void
  readonly reject: (error: BackendPluginError) => void
  readonly cleanup: () => void
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
  stdoutBuffer: Buffer
  stderrBuffer: Buffer
  stderrTruncated: boolean
  diagnosticEmittedBytes: number
  diagnosticTruncated: boolean
  readonly exitPromise: Promise<void>
  outputQueue: Buffer[]
  outputQueueBytes: number
  outputWriting: boolean
  droppedNotifications: number
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

type BackendWireNotification =
  | SubscriptionAcknowledgedNotification
  | EventNotification
  | ProgressNotification
  | BackendBridgeCancellationNotification

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

function isMethodName(value: unknown): value is string {
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
): PluginSystemNamespace | undefined {
  switch (port) {
    case 'filesystem':
      return 'fs'
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
  if (!hasValue && subscriptionId === undefined) throw new Error(PROTOCOL_ERROR_MESSAGE)
  const value = frame.result.value
  return {
    kind: 'success',
    id: frame.id,
    ...(hasValue ? { value: value as JsonValue } : {}),
    serverInfo: info,
    ...(subscriptionId !== undefined ? { subscriptionId } : {}),
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
  private rootRefreshController?: AbortController
  private state: SupervisorState = 'idle'
  private currentGeneration?: ChildGeneration
  private nextGenerationId = 0
  private readonly pending = new Map<WireRequestId, PendingRequest>()
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
    if (this.subscriptions.size >= MAX_ACTIVE_SUBSCRIPTIONS) {
      throw new BackendPluginError('RESOURCE_LIMIT')
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
    let message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
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
      stdoutBuffer: Buffer.alloc(0),
      stderrBuffer: Buffer.alloc(0),
      stderrTruncated: false,
      diagnosticEmittedBytes: 0,
      diagnosticTruncated: false,
      outputQueue: [],
      outputQueueBytes: 0,
      outputWriting: false,
      droppedNotifications: 0,
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
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    generation.stdoutBuffer = Buffer.concat([generation.stdoutBuffer, bytes])
    if (generation.stdoutBuffer.length > this.maxFrameBytes && !generation.stdoutBuffer.includes(0x0a)) {
      this.failProcess(generation, 'PROTOCOL_ERROR')
      return
    }
    while (true) {
      const newline = generation.stdoutBuffer.indexOf(0x0a)
      if (newline < 0) {
        if (generation.stdoutBuffer.length > this.maxFrameBytes) this.failProcess(generation, 'PROTOCOL_ERROR')
        return
      }
      const line = generation.stdoutBuffer.subarray(0, newline)
      generation.stdoutBuffer = generation.stdoutBuffer.subarray(newline + 1)
      if (line.length > this.maxFrameBytes || line.includes(0x0d)) {
        this.failProcess(generation, 'PROTOCOL_ERROR')
        return
      }
      let frame: BackendWireHostFrame
      try {
        frame = parseBackendWireHostFrame(line)
      } catch {
        this.failProcess(generation, 'PROTOCOL_ERROR')
        return
      }
      try {
        this.handleFrame(generation, frame)
      } catch {
        this.failProcess(generation, 'PROTOCOL_ERROR')
        return
      }
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
      const isProtocolError = generation.stdoutBuffer.length > 0
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
    if (this.bridgeRequests.size >= MAX_BACKEND_BRIDGE_REQUESTS) {
      this.sendBridgeError(generation, request.id, 'RESOURCE_LIMIT')
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
    notification: Exclude<BackendWireNotification, BackendBridgeCancellationNotification>,
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
    const response = await this.sendRequest(
      {
        jsonrpc: '2.0',
        id,
        method: 'navide/call',
        params: {
          _meta: this.clientMeta(),
          name,
          arguments: args,
          runtime: { ...runtime },
        },
      },
      options,
      { kind: 'call', requestId: id },
      runtime,
      workspacePath,
      authorizedPlanRoot,
    )
    const result = this.successResult(response)
    return result.value as Result
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

    // One frame larger than the child's whole input queue can never be
    // written: refuse the request instead of writing it, because an overflow
    // on the write path is fatal to the child.
    const encoded = encodeFrame(frame)
    if (encoded.length > MAX_BACKEND_BRIDGE_QUEUE_BYTES) {
      return Promise.reject(new BackendPluginError('RESOURCE_LIMIT'))
    }

    return new Promise<BackendWireResponse>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        this.cancelPending(requestId, 'TIMEOUT')
      }, timeoutMs)
      const abort = (): void => this.cancelPending(
        requestId,
        options.signal?.reason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'USER_CANCELLED',
      )
      options.signal?.addEventListener('abort', abort, { once: true })
      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        if (origin) {
          this.unregisterBridgeOrigin(origin, generation)
          this.abortBridgeRequestsForOrigin(origin)
        }
      }
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
      }
      this.pending.set(requestId, pending)
      if (origin && runtime) {
        this.registerBridgeOrigin(origin, runtime, generation, workspacePath, authorizedPlanRoot)
      }
      try {
        if (generation.exited || generation.child.stdin.destroyed || generation.child.stdin.writableEnded) {
          throw new Error(
            `child stdin not writable (exited=${generation.exited}, destroyed=${generation.child.stdin.destroyed}, ended=${generation.child.stdin.writableEnded})`,
          )
        }
        this.writeFrame(generation, encoded)
      } catch (error) {
        this.failProcess(generation, 'BACKEND_UNAVAILABLE', false, error)
      }
    })
  }

  private cancelPending(
    requestId: WireRequestId,
    code: 'TIMEOUT' | 'USER_CANCELLED' | 'PLUGIN_STOPPING',
  ): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    this.rememberIgnoredRequestId(requestId)
    pending.cleanup()
    pending.reject(new BackendPluginError(code, undefined, { requestId }))
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
    }
  }

  /**
   * Serialize all Host→child frames and keep the internal Bridge bounded.
   *
   * A 'control' frame - a request, a response, a cancellation - is part of a
   * settled protocol exchange, so an overflow there stays fatal. A
   * 'notification' frame carries a Host event nobody is waiting on; a backlog
   * of those is backpressure, not a dead child, so it is dropped and counted
   * instead of taking the whole generation down.
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
    if (generation.outputQueueBytes + frame.length > MAX_BACKEND_BRIDGE_QUEUE_BYTES) {
      if (kind === 'notification') {
        generation.droppedNotifications += 1
        if (generation.droppedNotifications === 1) {
          this.emitDiagnostic(
            new Error(
              'Host event notification dropped: output queue limit reached. Further drops for this child are counted but not reported.',
            ),
            generation,
          )
        }
        return
      }
      const overflow = new Error('output queue limit reached')
      this.failProcess(generation, 'BACKEND_UNAVAILABLE', false, overflow)
      throw overflow
    }
    generation.outputQueue.push(frame)
    generation.outputQueueBytes += frame.length
    this.flushOutput(generation)
  }

  private flushOutput(generation: ChildGeneration): void {
    if (
      generation.outputWriting ||
      this.currentGeneration !== generation ||
      generation.exited
    ) return
    const frame = generation.outputQueue.shift()
    if (!frame) return
    generation.outputQueueBytes -= frame.length
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
