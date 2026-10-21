/**
 * Step-0 contract for Navide plugin agent tools (plan B, B1 and B2).
 *
 * Types and pure functions only. Since B1-a the Host refuses a manifest whose
 * `backend.agentTools` fails `validateAgentTools` (pluginManifestV2.ts). The
 * normative text is docs/en-US/plugin-agent-tools-contract.md; the Python
 * twin is backend/agent_team_backend/plugins/agent_tools_contract.py, and both
 * are held to docs/plugin-contracts/agent-tools-fixtures/ by their tests.
 */

import { canonicalJson } from './canonicalJson'
import type {
  DisclosureCard,
  DisclosureDiff,
  DisclosurePermissions,
  DisclosureRiskLevel,
  DisclosureSummary,
} from './pluginDisclosure'

// ── manifest: backend.agentTools[] ──────────────────────────────────────────

export type AgentToolRisk = 'read' | 'write'

/** One entry of `backend.agentTools` as a package declares it. */
export interface AgentToolDeclaration {
  /** `<prefix>_<rest>`, see {@link AGENT_TOOL_NAME_PATTERN} and {@link deriveAgentToolPrefix}. */
  name: string
  /** A name listed in `backend.methods`; the Host forwards the call to it. */
  method: string
  risk: AgentToolRisk
  title: string
  description: string
  /** JSON Schema of the arguments; `type` must be `"object"`, numbers must be integers. */
  inputSchema: Record<string, unknown>
  /** 1..{@link AGENT_TOOL_MAX_TIMEOUT_MS}; {@link AGENT_TOOL_DEFAULT_TIMEOUT_MS} when omitted. */
  timeoutMs?: number
}

export const AGENT_TOOL_NAME_PATTERN = /^[a-z][a-z0-9]{1,15}_[a-z0-9_]{1,40}$/
const PREFIX_PATTERN = /^[a-z][a-z0-9]{1,15}$/

export const AGENT_TOOL_DEFAULT_TIMEOUT_MS = 30_000
/** Same bound as the Host's backend calls (pluginBackendLimits.MAX_BACKEND_TIMEOUT_MS). */
export const AGENT_TOOL_MAX_TIMEOUT_MS = 120_000
/**
 * DB9: the technical cap on one description and one canonical input schema, in UTF-8 bytes.
 * Results and arguments have no cap (DB9 decision a): they travel in pieces (section 4.4) and their sizes are
 * disclosed as `resultBytes` and `args_bytes`.
 */
export const AGENT_TOOL_STABILITY_CAP_BYTES = 1_048_576

export const AGENT_TOOL_REQUIRED_FIELDS = ['name', 'method', 'risk', 'title', 'description', 'inputSchema'] as const
const AGENT_TOOL_FIELDS: ReadonlySet<string> = new Set([...AGENT_TOOL_REQUIRED_FIELDS, 'timeoutMs'])

/** Prefixes no plugin may derive. `navide_` is reserved on top of the design list (impersonation), and so
 *  are the prefixes the built-in packages derive (`git_`, `plans_`, `miniide_`). */
export const RESERVED_TOOL_PREFIXES = [
  'cli_', 'credentials_', 'evolve_', 'git_', 'marketplace_', 'mcp_', 'memory_', 'miniide_', 'navide_', 'pipeline_',
  'plan_', 'plans_', 'plugins_', 'preview_', 'prompt_', 'role_', 'scheduler_', 'share_', 'skills_', 'stage_', 'ui_',
  'window_', 'workspace_',
] as const

/** tools/list of the core navide MCP server on origin/main 72c4c2e33, pinned. */
export const CORE_TOOL_NAMES = [
  'cli_account_sign_in',
  'cli_account_switch',
  'cli_accounts_list',
  'cli_answer_prompt', 'cli_cancel_message', 'cli_check_message', 'cli_close_agent', 'cli_extensions_list',
  'cli_failover_state',
  'cli_get_status', 'cli_inbox_summary', 'cli_interrupt', 'cli_list_sessions', 'cli_list_targets',
  'cli_message_log', 'cli_open_agent', 'cli_pending_incoming', 'cli_permission_settings', 'cli_place_pane',
  'cli_read_incoming', 'cli_read_log', 'cli_reclaim_agent', 'cli_send', 'cli_send_and_wait', 'cli_token_stats',
  'cli_usage', 'cli_wait_idle', 'cli_whoami', 'credentials_findings', 'credentials_list', 'evolve_report',
  'marketplace_detail',
  'marketplace_developer_application_fill', 'marketplace_developer_application_open',
  'marketplace_developer_status', 'marketplace_open', 'marketplace_publish_fill', 'marketplace_publish_open',
  'marketplace_publish_status', 'marketplace_publish_yank_fill', 'marketplace_publish_yank_open',
  'marketplace_request_install', 'marketplace_request_rollback',
  'marketplace_request_status', 'marketplace_request_update', 'marketplace_search',
  'marketplace_testplace_invite_fill', 'marketplace_testplace_invite_open', 'mcp_list', 'memory_list',
  'pipeline_abort', 'pipeline_define', 'pipeline_gate', 'pipeline_graph',
  'pipeline_list', 'pipeline_next', 'pipeline_reset', 'pipeline_restart', 'pipeline_restart_from',
  'pipeline_resume', 'pipeline_start', 'pipeline_status', 'plan_add_note', 'plan_add_todo', 'plan_create',
  'plan_list', 'plan_read', 'plan_update_stage', 'plan_update_todo',
  'plugins_developer_mode_open',
  'plugins_disable', 'plugins_enable',
  'plugins_install_file_fill', 'plugins_install_file_open',
  'plugins_list_installed',
  'plugins_package',
  'plugins_request_remove',
  'plugins_validate_package',
  'preview_clear', 'preview_list',
  'preview_record', 'preview_show', 'prompt_list', 'role_define', 'scheduler_list', 'scheduler_remove',
  'scheduler_run_now', 'scheduler_runs', 'scheduler_set_enabled', 'scheduler_upsert', 'share_create',
  'share_list', 'share_revoke', 'skills_inspect', 'skills_install', 'skills_install_status', 'skills_list',
  'skills_prepare_install', 'skills_set_delivery', 'stage_define', 'ui_diagnostics', 'ui_invoke',
  'ui_list_actions', 'ui_snapshot', 'window_close', 'window_focus', 'window_list', 'window_move_pane',
  'workspace_close',
  'workspace_list', 'workspace_open', 'workspace_switch',
] as const

export type AgentToolNameError =
  | 'AGENT_TOOL_PREFIX_UNDERIVABLE'
  | 'AGENT_TOOL_NAME_INVALID'
  | 'AGENT_TOOL_PREFIX_MISMATCH'
  | 'AGENT_TOOL_PREFIX_RESERVED'
  | 'AGENT_TOOL_NAME_RESERVED'

export type AgentToolErrorCode =
  | AgentToolNameError
  | 'AGENT_TOOLS_NOT_ARRAY'
  | 'AGENT_TOOL_NOT_OBJECT'
  | 'AGENT_TOOL_FIELD_UNKNOWN'
  | 'AGENT_TOOL_FIELD_MISSING'
  | 'AGENT_TOOL_NAME_DUPLICATE'
  | 'AGENT_TOOL_METHOD_UNDECLARED'
  | 'AGENT_TOOL_RISK_INVALID'
  | 'AGENT_TOOL_TEXT_INVALID'
  | 'AGENT_TOOL_SCHEMA_INVALID'
  | 'AGENT_TOOL_NON_INTEGER_NUMBER'
  | 'AGENT_TOOL_TOO_LARGE'
  | 'AGENT_TOOL_TIMEOUT_INVALID'

export interface AgentToolValidationError {
  index: number | null
  field: string | null
  code: AgentToolErrorCode
}

/**
 * The tool-name prefix a plugin id yields: its last dot segment with hyphens
 * removed, when that matches `^[a-z][a-z0-9]{1,15}$`; otherwise null and the
 * package cannot declare agent tools.
 */
export function deriveAgentToolPrefix(pluginId: unknown): string | null {
  if (typeof pluginId !== 'string') return null
  const segments = pluginId.split('.')
  const candidate = segments[segments.length - 1].replace(/-/g, '')
  return PREFIX_PATTERN.test(candidate) ? candidate : null
}

/** First failing rule for one tool name, or null when it is accepted. */
export function validateAgentToolName(name: unknown, pluginId: unknown): AgentToolNameError | null {
  const prefix = deriveAgentToolPrefix(pluginId)
  if (prefix === null) return 'AGENT_TOOL_PREFIX_UNDERIVABLE'
  if (typeof name !== 'string' || !AGENT_TOOL_NAME_PATTERN.test(name)) return 'AGENT_TOOL_NAME_INVALID'
  if (name.slice(0, name.indexOf('_')) !== prefix) return 'AGENT_TOOL_PREFIX_MISMATCH'
  if ((RESERVED_TOOL_PREFIXES as readonly string[]).includes(`${prefix}_`)) return 'AGENT_TOOL_PREFIX_RESERVED'
  if ((CORE_TOOL_NAMES as readonly string[]).includes(name)) return 'AGENT_TOOL_NAME_RESERVED'
  return null
}

// ── text rules ──────────────────────────────────────────────────────────────

/** The characters that reorder or hide text: bidi controls, zero-width and
 *  other invisible format characters (soft hyphen, Mongolian vowel separator,
 *  combining grapheme joiner), fillers that render as nothing (Hangul fillers,
 *  the braille blank), variation selectors and tag characters (which
 *  can smuggle ASCII an agent reads but a dialog does not show). One set for
 *  the text rule and for display. */
const INVISIBLE_CHARACTERS =
  '\\u00ad\\u034f\\u061c\\u115f\\u1160\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\u2800\\u3164' +
  '\\ufe00-\\ufe0f\\ufeff\\uffa0\\u{e0000}-\\u{e007f}'
// Cc (C0, DEL, C1), the two Unicode line/paragraph separators, markup, and the
// invisible characters above.
const FORBIDDEN_TEXT = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029<>${INVISIBLE_CHARACTERS}]`, 'u')
const INVISIBLE_TEXT = new RegExp(`[${INVISIBLE_CHARACTERS}]`, 'gu')

/** Text from a package shown to the user verbatim except that every invisible
 *  character is spelled out (`\u{202e}`), so a schema key or enum value cannot
 *  reorder or hide what a consent surface shows. Nothing is refused for it. */
export function revealInvisibleText(text: string): string {
  return text.replace(INVISIBLE_TEXT, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`)
}

/** `revealInvisibleText`, and also every control character and the two
 *  Unicode line and paragraph separators: for package text placed in a native
 *  dialog line, where a line break could forge a line of the Host's own
 *  (card K3, MED-3 on #425). */
const UNSAFE_LINE_TEXT = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029${INVISIBLE_CHARACTERS}]`, 'gu')

export function revealUnsafeLineText(text: string): string {
  return text.replace(UNSAFE_LINE_TEXT, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`)
}

/** `revealInvisibleText` for a value shown as is: a string is spelled out,
 *  anything else (a missing field) is returned unchanged. */
export function revealInvisibleValue<T>(value: T): T {
  return (typeof value === 'string' ? revealInvisibleText(value) : value) as T
}

// Cc except tab and line feed.
// eslint-disable-next-line no-control-regex
const RESULT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** Title and description: a non-empty single line with no control characters and no `<` `>`. */
export function isValidAgentToolText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && !FORBIDDEN_TEXT.test(value)
}

/** Tool result text as the agent will see it: every Cc character except `\t` and `\n` removed. */
export function sanitizeAgentToolResultText(value: string): string {
  return value.replace(RESULT_CONTROL, '')
}

/** UTF-8 length; a lone surrogate counts 3 bytes, as Python's surrogatepass does. */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

// ── manifest validation ─────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasNonIntegerNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isSafeInteger(value)
  if (Array.isArray(value)) return value.some(hasNonIntegerNumber)
  if (isPlainObject(value)) return Object.values(value).some(hasNonIntegerNumber)
  return false
}

/** Schema keywords whose values are data, not schema: never refused for their
 *  text (the core neutralizes every schema string in tools/list instead). */
const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(['const', 'default', 'enum', 'examples'])
/** Keywords whose value maps names (property names, definition names) to
 *  subschemas (draft-07 `dependencies` also to name lists): a name such as
 *  `enum` there is a name, not a keyword. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies',
])

/** Every `description` / `title` string anywhere in a schema follows the text rules too:
 *  agents read the whole schema in tools/list. */
function hasInvalidSchemaText(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasInvalidSchemaText)
  if (!isPlainObject(value)) return false
  return Object.entries(value).some(([key, item]) =>
    SCHEMA_DATA_KEYWORDS.has(key)
      ? false
      : SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(item)
        ? Object.values(item).some(hasInvalidSchemaText)
        : (key === 'description' || key === 'title') && typeof item === 'string'
          ? !isValidAgentToolText(item)
          : hasInvalidSchemaText(item))
}

function isValidTimeout(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= AGENT_TOOL_MAX_TIMEOUT_MS
}

/**
 * Every rule of section 2.5 that JSON Schema cannot express, plus the shape
 * rules it can, so B1-a has one function to call. Reads only `id` and
 * `backend`; returns all errors ordered by entry index, then check order.
 */
export function validateAgentTools(manifest: { id?: unknown; backend?: unknown }): AgentToolValidationError[] {
  const backend = manifest.backend
  if (!isPlainObject(backend) || !('agentTools' in backend)) return []
  const declared = backend.agentTools
  if (!Array.isArray(declared)) return [{ index: null, field: 'agentTools', code: 'AGENT_TOOLS_NOT_ARRAY' }]
  const methods = Array.isArray(backend.methods) ? backend.methods : []
  const errors: AgentToolValidationError[] = []
  const seen = new Set<string>()
  declared.forEach((tool, index) => {
    const fail = (field: string | null, code: AgentToolErrorCode): void => {
      errors.push({ index, field, code })
    }
    if (!isPlainObject(tool)) return fail(null, 'AGENT_TOOL_NOT_OBJECT')
    for (const field of Object.keys(tool).sort()) {
      if (!AGENT_TOOL_FIELDS.has(field)) fail(field, 'AGENT_TOOL_FIELD_UNKNOWN')
    }
    for (const field of AGENT_TOOL_REQUIRED_FIELDS) {
      if (!(field in tool)) fail(field, 'AGENT_TOOL_FIELD_MISSING')
    }
    if ('name' in tool) {
      const nameError = validateAgentToolName(tool.name, manifest.id)
      if (nameError) fail('name', nameError)
      else if (seen.has(tool.name as string)) fail('name', 'AGENT_TOOL_NAME_DUPLICATE')
      else seen.add(tool.name as string)
    }
    if ('method' in tool && !methods.includes(tool.method)) fail('method', 'AGENT_TOOL_METHOD_UNDECLARED')
    if ('risk' in tool && tool.risk !== 'read' && tool.risk !== 'write') fail('risk', 'AGENT_TOOL_RISK_INVALID')
    if ('title' in tool && !isValidAgentToolText(tool.title)) fail('title', 'AGENT_TOOL_TEXT_INVALID')
    if ('description' in tool) {
      if (!isValidAgentToolText(tool.description)) fail('description', 'AGENT_TOOL_TEXT_INVALID')
      else if (utf8ByteLength(tool.description as string) > AGENT_TOOL_STABILITY_CAP_BYTES) {
        fail('description', 'AGENT_TOOL_TOO_LARGE')
      }
    }
    if ('inputSchema' in tool) {
      const schema = tool.inputSchema
      if (!isPlainObject(schema) || schema.type !== 'object') fail('inputSchema', 'AGENT_TOOL_SCHEMA_INVALID')
      else if (hasNonIntegerNumber(schema)) fail('inputSchema', 'AGENT_TOOL_NON_INTEGER_NUMBER')
      else if (hasInvalidSchemaText(schema)) fail('inputSchema', 'AGENT_TOOL_TEXT_INVALID')
      else if (utf8ByteLength(canonicalJson(schema)) > AGENT_TOOL_STABILITY_CAP_BYTES) {
        fail('inputSchema', 'AGENT_TOOL_TOO_LARGE')
      }
    }
    if ('timeoutMs' in tool && !isValidTimeout(tool.timeoutMs)) fail('timeoutMs', 'AGENT_TOOL_TIMEOUT_INVALID')
  })
  return errors
}

// ── Host → backend: plugins.agentTools.sync ─────────────────────────────────

/** Why a catalog entry is not callable; `available` is the only callable state. */
export type AgentToolState =
  | 'available'
  | 'consent-required'
  | 'plugin-disabled'
  | 'plugin-quarantined'
  | 'plugin-revoked'
  | 'name-collision'

export interface AgentToolSyncEntry {
  pluginId: string
  pluginVersion: string
  name: string
  title: string
  description: string
  risk: AgentToolRisk
  method: string
  /** Defaulted: always present on the wire. */
  timeoutMs: number
  inputSchema: Record<string, unknown>
  state: AgentToolState
  /** Feeds the D4 source label; the disclosure `permissions` object of the package version. */
  permissions: DisclosurePermissions
}

/** Event `plugins.agentTools.sync`: a full snapshot that replaces the previous one. */
export interface AgentToolsSyncPayload {
  /** Strictly increasing per Host process; the backend drops a snapshot not newer than the last. */
  revision: number
  /** DB8 master switch. False ⇒ `tools` is empty. */
  enabled: boolean
  /** DB4 switch: external MCP clients may call third-party tools. */
  externalCallers: boolean
  tools: AgentToolSyncEntry[]
}

export const AGENT_TOOLS_SYNC_EVENT = 'plugins.agentTools.sync'

// ── backend → Host: the generalized agent call ──────────────────────────────

export interface AgentToolCaller {
  kind: 'pane' | 'external' | 'host'
  /** Set for kind "pane" only. */
  paneId: string | null
  /** The caller pane's workspace; null for external and host callers. */
  workspace: string | null
}

/** Payload of the existing `agent.capability.request` event with operation "agentTool". */
export interface AgentToolCallRequest {
  request_id: string
  operation: 'agentTool'
  target: { plugin_id: string; workspace_path: string }
  tool: { name: string; plugin_version: string; sync_revision: number }
  caller: AgentToolCaller
  payload: { arguments: Record<string, unknown> }
}

export type AgentToolCallErrorCode =
  | 'BAD_REQUEST'
  | 'PLUGIN_TOOL_UNAVAILABLE'
  | 'WORKSPACE_NOT_AUTHORIZED'
  | 'WORKSPACE_WRITE_DECLINED'
  | 'EXECUTION_POLICY_DENIED'
  | 'PLUGIN_TOOL_INVALID_ARGUMENTS'
  | 'PLUGIN_TOOL_TIMEOUT'
  | 'PLUGIN_TOOL_FAILED'
  /** No longer produced: results have no size cap (DB9 decision a). Kept so older readers still type-check. */
  | 'PLUGIN_TOOL_RESULT_TOO_LARGE'
  | 'PLUGIN_TOOL_CHUNKS_INVALID'

/** `reason` of PLUGIN_TOOL_UNAVAILABLE, in Host check order. */
export type AgentToolUnavailableReason =
  | 'master-switch-off'
  | 'external-callers-off'
  | 'plugin-not-installed'
  | 'plugin-disabled'
  | 'plugin-quarantined'
  | 'plugin-revoked'
  | 'plugin-stopping'
  | 'consent-required'
  | 'tool-not-consented'
  | 'name-collision'

export interface AgentToolCallMeta {
  durationMs: number
  /** UTF-8 bytes of the result's compact JSON text as the Host received it ({@link agentToolResultBytes}); 0 without a result. */
  resultBytes: number
  /** True when the target workspace differs from caller.workspace. */
  crossWorkspace: boolean
}

export type AgentToolCallResponse =
  | { ok: true; result: unknown; meta: AgentToolCallMeta }
  | {
      ok: false
      error: string
      error_code: AgentToolCallErrorCode
      /** For PLUGIN_TOOL_UNAVAILABLE an unavailable reason; for PLUGIN_TOOL_CHUNKS_INVALID a join reason; for PLUGIN_TOOL_TIMEOUT which clock ran out. */
      reason?: AgentToolUnavailableReason | AgentToolChunksInvalidReason | AgentToolTimeoutReason
      /** The plugin's own error code, for PLUGIN_TOOL_FAILED. */
      plugin_error?: string
      meta?: AgentToolCallMeta
    }

// ── chunked transfer of results and arguments (section 4.4) ────────────────

/**
 * UTF-8 bytes of the `data` of one piece, in both directions. A transport
 * unit, not a cap: a value of any size is sent as as many pieces as it needs.
 * Even if every byte of a piece were escaped as `\u00XX` (6 bytes) the frame
 * stays under 1 MiB, the frame size child readers use (Plans backend MAX_FRAME_BYTES).
 */
export const AGENT_TOOL_CHUNK_BYTES = 131_072
/** Backend Wire notification, child → Host, one per result piece. */
export const BACKEND_WIRE_RESULT_CHUNK_METHOD = 'notifications/navide/resultChunk'
/**
 * Key of the client capability the Host advertises in `navide/call` `_meta`
 * clientCapabilities, and of the summary in the final success response `_meta`.
 */
export const BACKEND_WIRE_RESULT_CHUNKS_KEY = 'io.navide/resultChunks'
/** Backend Wire notification, Host → child, one per argument piece. */
export const BACKEND_WIRE_ARGUMENT_CHUNK_METHOD = 'notifications/navide/argumentChunk'
/**
 * Key of the capability a child advertises in its `navide/health` success
 * `_meta`, and of the summary in a `navide/call` `_meta` sent without `arguments`.
 */
export const BACKEND_WIRE_ARGUMENT_CHUNKS_KEY = 'io.navide/argumentChunks'
/** WebSocket request, Host → backend, one per result piece; answered like any request. */
export const AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE = 'agent.capability.result_chunk'
/** WebSocket event, backend → Host, one per argument piece, sent before `agent.capability.request`. */
export const AGENT_CAPABILITY_REQUEST_CHUNK_EVENT = 'agent.capability.request_chunk'
/** backend → Host event: the state of the helper process that handles results in pieces (4.4, R2), sent on every change. */
export const AGENT_TOOLS_RESULT_HELPER_EVENT = 'agent.tools.result_helper'

/** The result helper's state, as the backend reports it and resource usage discloses it. */
export interface AgentToolsResultHelperState {
  state: 'idle' | 'ready' | 'unavailable'
  lastError: string
  /** When the state last changed (ms since the epoch). */
  since: number
}

/** A backend report of the result helper's state, or null when it is not one. */
export function parseAgentToolsResultHelperState(value: unknown): AgentToolsResultHelperState | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const { state, lastError, since } = value as Record<string, unknown>
  if (state !== 'idle' && state !== 'ready' && state !== 'unavailable') return null
  if (typeof lastError !== 'string' || typeof since !== 'number' || !Number.isFinite(since)) return null
  return { state, lastError, since }
}
/** WebSocket request, Host → backend: the call is alive (keeps the backend's wait running). */
export const AGENT_CAPABILITY_PROGRESS_MESSAGE = 'agent.capability.progress'
/**
 * Idle timer of a transfer of pieces, restarted by every piece. It detects a
 * stalled peer; it is not a size limit (section 4.4, Timing).
 */
export const AGENT_TOOL_CHUNK_IDLE_MS = 30_000

/** Payload of {@link AGENT_CAPABILITY_PROGRESS_MESSAGE}. */
export interface AgentToolProgressMessage {
  request_id: string
  phase: 'arguments' | 'execution' | 'result'
}

/** `reason` of PLUGIN_TOOL_TIMEOUT: the plugin's own work, or a stalled transfer. */
export type AgentToolTimeoutReason = 'execution' | 'transfer-idle'

/** Backend Wire `params` of both chunk notifications; `requestId` is the `navide/call` id. */
export interface BackendWireChunkParams {
  requestId: string | number
  seq: number
  data: string
}

/** Payload of {@link AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE} and {@link AGENT_CAPABILITY_REQUEST_CHUNK_EVENT}. */
export interface AgentToolChunkMessage {
  request_id: string
  seq: number
  data: string
}

/** Sent with the message that completes a transfer: how many pieces and the UTF-8 bytes of the joined text. */
export interface AgentToolChunksSummary {
  chunks: number
  bytes: number
}

/** The final Host → backend response of a chunked result: `result` is replaced by `resultChunks`. */
export interface AgentToolCallChunkedResponse {
  ok: true
  resultChunks: AgentToolChunksSummary
  meta: AgentToolCallMeta
}

/** `json` is set by the caller when the joined text does not parse. */
export type AgentToolChunksInvalidReason = 'summary' | 'seq' | 'count' | 'short' | 'bytes' | 'json'

export type AgentToolPayloadReassembly =
  | { ok: true; text: string }
  | { ok: false; code: 'PLUGIN_TOOL_CHUNKS_INVALID'; reason: AgentToolChunksInvalidReason }

/** The value of `meta.resultBytes`: UTF-8 bytes of the compact JSON text of a result (`null` when absent). */
export function agentToolResultBytes(result: unknown): number {
  return utf8ByteLength(JSON.stringify(result === undefined ? null : result))
}

/** Cuts `text` into pieces of at most `maxBytes` UTF-8 bytes, never inside a code point. Always at least one piece. */
export function splitAgentToolPayloadText(text: string, maxBytes: number = AGENT_TOOL_CHUNK_BYTES): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new RangeError('maxBytes must be an integer >= 4')
  const pieces: string[] = []
  // A run of ASCII is one byte per unit, so a piece that lies inside one is
  // cut without visiting its characters; everywhere else each code point is
  // measured. `nextWide` is the first non-ASCII unit at or after `start`.
  const wide = /[^\x00-\x7f]/g
  let nextWide = -1
  let start = 0
  while (text.length - start > 0) {
    if (nextWide < start) {
      wide.lastIndex = start
      nextWide = wide.exec(text)?.index ?? text.length
    }
    if (nextWide - start >= maxBytes && text.length - start > maxBytes) {
      pieces.push(text.slice(start, start + maxBytes))
      start += maxBytes
      continue
    }
    let bytes = 0
    let i = start
    while (i < text.length) {
      const point = text.codePointAt(i) as number
      const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point > 0xffff ? 4 : 3
      if (bytes + size > maxBytes) break
      bytes += size
      i += point > 0xffff ? 2 : 1
    }
    if (i === text.length) break
    pieces.push(text.slice(start, i))
    start = i
  }
  pieces.push(text.slice(start))
  return pieces
}

/** What a receiver learns from one piece as it arrives (section 4.4). */
export type AgentToolChunkArrival =
  | { ok: true; short: boolean }
  | { ok: false; code: 'PLUGIN_TOOL_CHUNKS_INVALID'; reason: 'seq' | 'short' }

/**
 * Checks one piece on arrival. Senders send pieces in `seq` order and only the
 * last may be short (under `chunkBytes - 3` UTF-8 bytes), so any piece after a
 * short one is `short`. A short piece does not restart the idle timer
 * (`short: true`); a full one does. A format rule, not a limit.
 */
export function agentToolChunkArrival(
  shortSeen: boolean,
  data: unknown,
  chunkBytes: number = AGENT_TOOL_CHUNK_BYTES,
  /** The piece's `seq` and the one expected next (0, 1, 2, …): a repeat or a step back is `seq`. */
  seq?: unknown,
  expectedSeq?: number,
  /** The UTF-8 length of `data`, when the receiver already has it (a piece kept as bytes). */
  byteLength?: number,
): AgentToolChunkArrival {
  if (typeof data !== 'string') return { ok: false, code: 'PLUGIN_TOOL_CHUNKS_INVALID', reason: 'seq' }
  if (expectedSeq !== undefined && seq !== expectedSeq) return { ok: false, code: 'PLUGIN_TOOL_CHUNKS_INVALID', reason: 'seq' }
  if (shortSeen) return { ok: false, code: 'PLUGIN_TOOL_CHUNKS_INVALID', reason: 'short' }
  return { ok: true, short: (byteLength ?? utf8ByteLength(data)) < chunkBytes - 3 }
}

function isCount(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
}

/**
 * Joins the pieces received for one request (in any arrival order) and checks
 * them against the summary. Every piece but the last must be full, at least
 * `chunkBytes - 3` UTF-8 bytes (what {@link splitAgentToolPayloadText} always
 * produces): a format rule, so a sender cannot drip a value to stretch the
 * transfer. No size limit beyond memory.
 */
export function reassembleAgentToolPayloadText(
  chunks: ReadonlyArray<{ seq: unknown; data: unknown }>,
  summary: unknown,
  chunkBytes: number = AGENT_TOOL_CHUNK_BYTES,
): AgentToolPayloadReassembly {
  const invalid = (reason: AgentToolChunksInvalidReason): AgentToolPayloadReassembly =>
    ({ ok: false, code: 'PLUGIN_TOOL_CHUNKS_INVALID', reason })
  const s = summary as Partial<AgentToolChunksSummary> | null
  if (!s || typeof s !== 'object' || !isCount(s.chunks, 1) || !isCount(s.bytes, 0)) return invalid('summary')
  // A piece that is not an object (null included) is a malformed piece, not a crash.
  if (chunks.some((c) => c === null || typeof c !== 'object' || !isCount(c.seq, 0) || typeof c.data !== 'string')) {
    return invalid('seq')
  }
  if (chunks.length !== s.chunks) return invalid('count')
  const ordered: string[] = new Array(s.chunks)
  for (const c of chunks as ReadonlyArray<{ seq: number; data: string }>) {
    if (c.seq >= s.chunks || ordered[c.seq] !== undefined) return invalid('seq')
    ordered[c.seq] = c.data
  }
  if (ordered.slice(0, -1).some((piece) => utf8ByteLength(piece) < chunkBytes - 3)) return invalid('short')
  const text = ordered.join('')
  if (utf8ByteLength(text) !== s.bytes) return invalid('bytes')
  return { ok: true, text }
}

// ── backend → Host: marketplace.query (B2 read-only tools) ──────────────────

export type MarketplaceQuery =
  | { kind: 'search'; text: string; category?: string; cursor?: string; limit?: number }
  | { kind: 'detail'; id: string; version?: string }
  | { kind: 'installed' }
  /** plugins_validate_package (W1, S1): check a `.vsix` or a plugin folder. */
  | { kind: 'localValidate'; path: string }
  /** plugins_package (W1, S1b): build a `.vsix` from a plugin folder. */
  | { kind: 'localPackage'; path: string; target?: string; out?: string }
  /** plugins_install_file_fill (W1, S2): read once, check and hold a package
   * for the user's approval; nothing is installed. */
  | { kind: 'localStage'; path: string }

export interface MarketplaceQueryRequest {
  request_id: string
  query: MarketplaceQuery
}

export interface MarketplaceListingItem {
  id: string
  version: string
  name: string
  /** Third-party text: the backend wraps it as external content before an agent sees it. */
  description: string
  publisher: { name: string; verifiedDomain: string | null }
  signed: boolean
  downloads: number
  risk: DisclosureRiskLevel
  summary: DisclosureSummary
}

export interface MarketplaceInstalledItem {
  id: string
  version: string
  /** Where it came from and what review it passed (`PluginSource`); a local
   * file a vetted publisher signed is `local-signed`. Absent when unknown. */
  source?: string
  /** A local file whose publisher key the Registry has since revoked. */
  signatureRevoked?: boolean
  enabled: boolean
  quarantined: boolean
  hasBackend: boolean
  agentTools: Array<{ name: string; state: AgentToolState }>
}

export type MarketplaceQueryResult =
  | { kind: 'search'; items: MarketplaceListingItem[]; nextCursor: string | null }
  | { kind: 'detail'; item: MarketplaceListingItem; versions: string[]; card: DisclosureCard }
  | { kind: 'installed'; items: MarketplaceInstalledItem[] }
  | { kind: 'localValidate' | 'localPackage' | 'localStage'; report: LocalPackageQueryReport }

/** A local package check or build (W1). Package-chosen strings (id, version,
 * errors quoting the manifest) are third-party text to the backend. */
export interface LocalPackageQueryReport {
  path: string
  packageKind: 'file' | 'folder'
  valid: boolean
  errors: string[]
  id: string | null
  version: string | null
  target: string | null
  digest: string | null
  signature: 'none' | 'verified' | 'revoked' | 'unverifiable'
  disclosure: unknown
  risk: DisclosureRiskLevel | null
  scan: unknown
  /** localStage only: the Host's handle on the held copy, for the approval. */
  stagingId?: string
}

export type MarketplaceQueryResponse =
  | { request_id: string; ok: true; result: MarketplaceQueryResult }
  | { request_id: string; ok: false; error: string; error_code: 'BAD_REQUEST' | 'NOT_FOUND' | 'REGISTRY_UNAVAILABLE' | 'HOST_UNAVAILABLE' }

export const MARKETPLACE_QUERY_REQUEST_EVENT = 'marketplace.query.request'
export const MARKETPLACE_QUERY_RESULT_MESSAGE = 'marketplace.query.result'

// ── Host → backend: plugin activity (D-e, section 5) ────────────────────────

/** Host-authenticated: `{rows}`, one row per broker or shell-broker call, batched. */
export const PLUGIN_ACTIVITY_RECORD_MESSAGE = 'plugin.activity.record'
/** Host-authenticated: `{plugin_id, declared?}` → a `PluginActivityReport` (contract 5.1). */
export const PLUGIN_ACTIVITY_REPORT_MESSAGE = 'plugins.activity.report'
/** Host-authenticated: `{plugin_id}`, sent when a plugin is removed. */
export const PLUGIN_ACTIVITY_FORGET_MESSAGE = 'plugin.activity.forget'

// ── approval registry (B2) ──────────────────────────────────────────────────

export type FormApprovalKind = 'developer-application' | 'plugin-publish' | 'plugin-yank' | 'testplace-invite'
export type ApprovalKind = 'skill' | 'plugin-install' | 'plugin-update' | 'plugin-rollback' | 'plugin-remove' | 'plugin-enable'
  /** W1 (S2): a local `.vsix` or developer folder an agent named, staged by the Host. */
  | 'plugin-install-file'
  | FormApprovalKind
export const APPROVAL_KINDS: readonly ApprovalKind[] = [
  'skill', 'plugin-install', 'plugin-update', 'plugin-rollback', 'plugin-remove', 'plugin-enable',
  'plugin-install-file',
  'developer-application', 'plugin-publish', 'plugin-yank', 'testplace-invite',
]
/** Requests that are a draft for a main-window form (P4 *_fill), not an approval
 *  card: the user edits the draft and presses Submit; closing the form rejects it. */
export const FORM_APPROVAL_KINDS: readonly FormApprovalKind[] = ['developer-application', 'plugin-publish', 'plugin-yank', 'testplace-invite']
export function isFormApprovalKind(kind: string): kind is FormApprovalKind {
  return (FORM_APPROVAL_KINDS as readonly string[]).includes(kind)
}
/** created_at + this for a form request (a card's is 15 minutes). */
export const FORM_APPROVAL_TTL_S = 60 * 60
/** Backend -> main windows: open a form for the user to fill in (P4 *_open). */
export const MARKETPLACE_FORM_OPEN_EVENT = 'marketplace.form_open'
export type MarketplaceForm = 'developer-application' | 'publish' | 'publish-yank' | 'testplace-invite'
export const MARKETPLACE_FORMS: readonly MarketplaceForm[] = ['developer-application', 'publish', 'publish-yank', 'testplace-invite']
export interface MarketplaceFormOpen {
  form: MarketplaceForm
  /** Locating data only (a package path, an id and version), never a field value the agent wrote. */
  prefill: Record<string, string>
  requester: PluginApprovalRequest['requester']
}
/** Backend -> Host: `{request_id, query}` for the developer status tools; the Host
 *  answers `marketplace.developer.result` `{request_id, ok, result | error, error_code}`. */
export const MARKETPLACE_DEVELOPER_REQUEST_EVENT = 'marketplace.developer.request'
export const MARKETPLACE_DEVELOPER_RESULT_MESSAGE = 'marketplace.developer.result'
export type MarketplaceDeveloperQuery =
  | { kind: 'developer-status' }
  | { kind: 'publish-status'; id: string }
  /** O3: publish at once when the Host's Registry is this computer's; else `{loopback: false}`. */
  | { kind: 'publish-direct'; path: string; target: string }
export const DEVELOPER_ERROR_CODES = ['NOT_SIGNED_IN', 'QUALIFICATION_REQUIRED'] as const
/** Which side wrote a form field (the Registry's field_sources spelling). */
export type FormFieldSource = 'user' | 'agent-draft'
/** A form request's draft: the agent's field values and, per field, who wrote it. */
export interface FormDraft {
  /** Strings and switches; a Testplace invitation's `invitees` is a list. */
  fields: Record<string, string | boolean | string[]>
  field_sources: Record<string, FormFieldSource>
}
/** The developer application's fields (Registry W2, real-name per DX 5.4). */
export const DEVELOPER_APPLICATION_FIELDS = [
  'applicant_type', 'legal_name', 'display_name', 'contact_email', 'country', 'intended_namespace',
  'description', 'agreed_terms', 'organization_name', 'organization_id', 'website', 'source_url',
  'needs_native_backend', 'domain',
] as const

export type PluginApprovalStatus = 'pending' | 'applying' | 'completed' | 'rejected' | 'failed' | 'expired'

export interface PluginApprovalRequest {
  approval_id: string
  kind: Exclude<ApprovalKind, 'skill'>
  /** Coalescing key: kind + plugin id + version; a duplicate returns the pending record. */
  owner: string
  /** `tainted`: present (true) only when the asking pane read third-party content (S8-M1, a disclosure). */
  requester: { paneId: string | null; paneName: string | null; workspace: string | null; callerKind: AgentToolCaller['kind']; tainted?: true }
  /** Written by the agent; the card labels it as such. */
  reason: string
  target: {
    id: string
    namespace: string
    name: string
    version: string | null
    fromVersion: string | null
    /** plugin-install-file (W1, S2): what the Host staged for the agent. */
    path?: string
    digest?: string | null
    stagingId?: string
    packageKind?: 'file' | 'folder'
    signature?: 'none' | 'verified' | 'revoked' | 'unverifiable'
  }
  card: DisclosureCard | null
  diff: DisclosureDiff | null
  /** Form kinds: the agent's draft for the form; null for every other kind. */
  draft?: FormDraft | null
  /** plugin-enable: who disabled the package (`at` in Unix seconds, null when not recorded); null for every other kind. */
  disabled: { by: 'user' | 'agent'; at: number | null; agent: PluginDisabledBy['agent'] } | null
  status: PluginApprovalStatus
  error: string | null
  created_at: number
  /** created_at + 15 minutes (a form request: FORM_APPROVAL_TTL_S). */
  expires_at: number
}

export interface PluginApprovalDecision {
  approval_id: string
  approve: boolean
  /** Trust confirmation minted by the main window for {@link PLUGIN_APPROVAL_DECIDE_ACTION}, subject `<approval_id>:approve` or `<approval_id>:reject`. */
  confirmation: string
}

export const PLUGIN_APPROVAL_DECIDE_ACTION = 'plugins.agent_request.decide'
/** Window -> backend: end an approved request (`applying` -> completed | failed); confirmation subject approval_id. */
export const PLUGIN_APPROVAL_FINISH_ACTION = 'plugins.agent_request.finish'
/** Window -> backend: the plugin requests the registry holds (pending and applying). */
export const PLUGIN_APPROVAL_LIST_MESSAGE = 'plugins.agent_requests.list'
/** Backend -> windows: a plugin request was filed, or a pending one was asked for again. */
export const PLUGIN_APPROVAL_REQUEST_EVENT = 'plugins.agent_request'
/** Backend -> windows: a plugin request was decided, finished or expired. */
export const PLUGIN_APPROVAL_RESOLVED_EVENT = 'plugins.agent_request_resolved'
/** Backend -> main windows: a main window went away while carrying out these approved requests; settle them. `{approval_ids}`. */
export const PLUGIN_APPROVAL_RECOVER_EVENT = 'plugins.agent_requests.recover'

// ── backend -> Host: plugins.agent_action (B2-c disable / enable) ───────────

export const PLUGIN_AGENT_ACTION_REQUEST_EVENT = 'plugins.agent_action.request'
export const PLUGIN_AGENT_ACTION_RESULT_MESSAGE = 'plugins.agent_action.result'
/** `update`: marketplace_request_update, carried out at once only when the
 *  new version discloses exactly what the installed one does (O1). */
export type PluginAgentActionKind = 'disable' | 'enable' | 'update'
export type PluginAgentActionErrorCode =
  | 'BAD_REQUEST' | 'NOT_INSTALLED' | 'BUILTIN_PLUGIN' | 'ACTION_FAILED' | 'HOST_UNAVAILABLE' | 'APPROVAL_REQUIRED'

/** Who disabled an installed package (B2-c option B); `at` is Unix ms here, Unix seconds in an approval record. */
export interface PluginDisabledBy {
  by: 'user' | 'agent'
  at: number | null
  agent: { callerKind: 'pane' | 'external' | 'host'; paneId: string | null; paneName: string | null } | null
}

export interface PluginAgentActionRequest {
  request_id: string
  action: PluginAgentActionKind
  plugin_id: string
  /** `update` only: the version to update to. */
  version?: string
  requester: PluginApprovalRequest['requester']
}

export type PluginAgentActionAnswer =
  | { ok: true; pluginId: string; pluginVersion: string; disabled: boolean; changed: boolean }
  | { ok: false; error: string; error_code: Exclude<PluginAgentActionErrorCode, 'APPROVAL_REQUIRED'> }
  /** enable of a package the user disabled (or with no recorded source): the backend files a plugin-enable request. */
  | { ok: false; error: string; error_code: 'APPROVAL_REQUIRED'; pluginId: string; pluginVersion: string; disabled: PluginDisabledBy }
  /** update (O1): carried out at once; the disclosure did not change. */
  | { ok: true; updated: true; pluginId: string; fromVersion: string; pluginVersion: string }
  /** update (O1): staged, but switching to it failed; `fromVersion` still runs
   *  and the main window offers to apply it. */
  | { ok: true; updated: true; switched: false; switchError: string; pluginId: string; fromVersion: string; pluginVersion: string }
  /** update (O1): something changed or could not be compared; the backend files a plugin-update request. */
  | { ok: false; error: string; error_code: 'APPROVAL_REQUIRED'; pluginId: string; pluginVersion: string }
export const PLUGIN_APPROVAL_TTL_MS = 15 * 60_000
