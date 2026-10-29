/**
 * The manifest rules for `backend.agentTools` (contract section 2.5), for
 * `navide-plugin validate`: the Registry refuses a package with
 * `validate_agent_tools` (marketplace/registry/registry/agent_tools_contract.py)
 * and the Host with src/shared/pluginAgentTools.ts. This is a copy of the
 * validation half of that file, held to the same
 * docs/plugin-contracts/agent-tools-fixtures/agent-tools-validation.json.
 */

// ── manifest: backend.agentTools[] ──────────────────────────────────────────

export const AGENT_TOOL_NAME_PATTERN = /^[a-z][a-z0-9]{1,15}_[a-z0-9_]{1,40}$/
const PREFIX_PATTERN = /^[a-z][a-z0-9]{1,15}$/

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
  'workspace_',
] as const

/** tools/list of the core navide MCP server on origin/main 72c4c2e33, pinned. */
export const CORE_TOOL_NAMES = [
  'cli_account_sign_in',
  'cli_accounts_list',
  'cli_answer_prompt', 'cli_cancel_message', 'cli_check_message', 'cli_close_agent', 'cli_extensions_list',
  'cli_failover_state',
  'cli_get_status', 'cli_inbox_summary', 'cli_interrupt', 'cli_list_sessions', 'cli_list_targets',
  'cli_message_log', 'cli_open_agent', 'cli_pending_incoming', 'cli_permission_settings', 'cli_place_pane',
  'cli_read_incoming', 'cli_read_log', 'cli_reclaim_agent', 'cli_send', 'cli_send_and_wait', 'cli_token_stats',
  'cli_usage', 'cli_wait_idle', 'cli_whoami', 'credentials_findings', 'credentials_list', 'evolve_report', 'evolve_retro',
  'marketplace_detail', 'marketplace_request_install', 'marketplace_request_rollback',
  'marketplace_request_status', 'marketplace_request_update', 'marketplace_search', 'mcp_list', 'memory_list',
  'pipeline_abort', 'pipeline_define', 'pipeline_gate', 'pipeline_graph',
  'pipeline_list', 'pipeline_next', 'pipeline_reset', 'pipeline_restart', 'pipeline_restart_from',
  'pipeline_resume', 'pipeline_start', 'pipeline_status', 'plan_add_note', 'plan_add_todo', 'plan_create',
  'plan_list', 'plan_read', 'plan_update_stage', 'plan_update_todo', 'plugins_disable', 'plugins_enable',
  'plugins_list_installed', 'plugins_request_remove',
  'preview_clear', 'preview_list',
  'preview_record', 'preview_show', 'prompt_list', 'role_define', 'scheduler_list', 'scheduler_remove',
  'scheduler_run_now', 'scheduler_runs', 'scheduler_set_enabled', 'scheduler_upsert', 'share_create',
  'share_list', 'share_revoke', 'skills_inspect', 'skills_install', 'skills_install_status', 'skills_list',
  'skills_prepare_install', 'skills_set_delivery', 'stage_define', 'ui_diagnostics', 'ui_invoke',
  'ui_list_actions', 'ui_snapshot', 'workspace_list', 'workspace_open', 'workspace_switch',
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

/** Title and description: a non-empty single line with no control characters and no `<` `>`. */
export function isValidAgentToolText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && !FORBIDDEN_TEXT.test(value)
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

// ── canonical JSON (src/shared/canonicalJson.ts) ─────────────────────────────

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return escapeNonAscii(JSON.stringify(value))
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const body = keys.map(
      (k) => `${escapeNonAscii(JSON.stringify(k))}:${canonicalJson((value as Record<string, unknown>)[k])}`,
    )
    return `{${body.join(',')}}`
  }
  // undefined / functions have no JSON spelling; Python would refuse them too.
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`)
}

/** JSON.stringify already escapes `"`, `\\` and control characters the way
 *  Python does (short forms for \n \r \t \b \f, `\u00xx` otherwise); what
 *  it keeps raw and Python does not is everything from DEL upward. */
function escapeNonAscii(quoted: string): string {
  return quoted.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
