import manifestV2Schema from './schemas/plugin-manifest-v2.schema.json' with { type: 'json' }
import capabilitiesV1 from './schemas/capabilities-v1.json' with { type: 'json' }
import executionPolicyV1Schema from './schemas/execution-policy-v1.schema.json' with { type: 'json' }
import { canonicalHtmlPath, canonicalPackagePath } from './archive.js'
import type { EditorFilesystemParams, EditorFilesystemResults } from './editorFilesystem.js'
import type { EditorAiParams, EditorAiResults, EditorAiEvents } from './editorAi.js'
import type { AiTerminalParams, AiTerminalResults } from './aiTerminal.js'
import type { EditorNativeParams, EditorNativeResults, EditorNativeEvents } from './editorNative.js'
import type { GitCapabilityParams, GitCapabilityResults } from './gitCapabilities.js'
import type { GitAccountParams, GitAccountResults, GitCredentialEvents } from './gitAccounts.js'
import type { IssueParams, IssueResults } from './issues.js'
import type { AgentsParams, AgentsResults } from './agents.js'
import type { EditorPreferenceParams, EditorPreferenceResults, EditorPreferenceEvents } from './editorPreferences.js'
import type { FilePickerRequest } from './filePicker.js'
export { validFilePickerRequest } from './filePicker.js'
export type { FilePickerRequest } from './filePicker.js'

export * from './archive.js'
export * from './aiTerminal.js'
export type { FileSearchOptions, EditorFilesystemParams, EditorFilesystemResults } from './editorFilesystem.js'
export type { EditorAiParams, EditorAiResults, EditorAiEvents, EditorReviewResult } from './editorAi.js'
export type { EditorNativeParams, EditorNativeResults, EditorNativeEvents, EditorFileSelection } from './editorNative.js'
export * from './gitCapabilities.js'
export * from './issues.js'
export * from './agents.js'
export * from './editorPreferences.js'
export * from './staticScan.js'
export { deriveAgentToolPrefix, validateAgentTools } from './agentToolsValidation.js'
export type { AgentToolErrorCode, AgentToolValidationError } from './agentToolsValidation.js'
export type { GitAccountParams, GitAccountResults, GitAccountSummary } from './gitAccounts.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type StoragePartitionScope = 'plugin' | 'workspace'
export type StorageGetResult =
  | { found: true; value: JsonValue }
  | { found: false; value: null }

export const V2_VIEW_LOCATIONS = ['top', 'bottom', 'right', 'left', 'main', 'window', 'detail'] as const
export const V2_RECEIVER_LOCATIONS = ['left', 'detail'] as const
export const V2_SYSTEM_NAMESPACES = ['fs', 'ui', 'aiCli', 'web', 'agents', 'agentMessages'] as const
export const V2_SHELL_MODES = ['allowlist', 'full'] as const
/** Most members one Extension Pack may list. */
export const MAX_EXTENSION_PACK_MEMBERS = 20
export const EXECUTION_POLICY_SCHEMA_VERSION = 1 as const
export const EXECUTION_POLICY_MODES = ['full', 'allowlist', 'denylist'] as const

export type PluginSystemNamespace = (typeof V2_SYSTEM_NAMESPACES)[number]
export type PluginShellMode = (typeof V2_SHELL_MODES)[number]
export type ExecutionPolicyMode = (typeof EXECUTION_POLICY_MODES)[number]

export interface ExecutionPolicy {
  schemaVersion: typeof EXECUTION_POLICY_SCHEMA_VERSION
  mode: ExecutionPolicyMode
  system: PluginSystemNamespace[]
  shell: string[]
}

export const V2_FS_SCOPE_ROOTS = ['workspace', 'repository'] as const
export type PluginFsScopeRoot = (typeof V2_FS_SCOPE_ROOTS)[number]

/** Path patterns a package declares it reads or writes, relative to `root`
 *  (`workspace` by default; `repository` is the nearest enclosing Git root).
 *  `*` matches within one segment and `**` matches zero or more segments; a
 *  pattern covers only the paths it matches. A disclosure for the user: the
 *  Host grants and enforces nothing from it. */
export type PluginManifestV2FsScopes = {
  root?: PluginFsScopeRoot
  read?: string[]
  write?: string[]
}

export type PluginManifestV2Scopes = {
  fs: PluginManifestV2FsScopes
}

export type PluginManifestV2Permissions = {
  system?: PluginSystemNamespace[]
  shell?: PluginShellMode
  /** Optional declared resource scopes; disclosure only, never a grant. */
  scopes?: PluginManifestV2Scopes
}

export type PluginManifestV2Receiver = {
  protocolVersion: 1
  locations: (typeof V2_RECEIVER_LOCATIONS)[number][]
  editorTargets?: { protocolVersion: 1 }
  closeGuard?: { protocolVersion: 1 }
}

export type PluginManifestV2View = {
  id: string
  kind: 'custom'
  location: (typeof V2_VIEW_LOCATIONS)[number]
  title: string
  icon?: string
  entry: string
  detailView?: string
  targetSchema?: string
  receives?: PluginManifestV2Receiver
}

export type PluginManifestV2 = {
  schemaVersion: 2
  apiVersion: string
  id: string
  name: string
  version: string
  publisher: string
  engines?: { navide: string }
  permissions: PluginManifestV2Permissions
  marketplace: {
    description: string
    license: string
    repository?: string
    homepage?: string
    categories?: string[]
    icon?: string
  }
  contributes?: { views: PluginManifestV2View[] }
  backend?: {
    entry: string
    protocolVersion: 1
    activation: 'startup'
    /** Package-local methods the Host may forward to this backend. */
    methods?: string[]
    /** Package-local events this backend may publish. */
    events?: string[]
    /** Tools an agent may call through the core navide MCP server once the
     *  user consents. This parser applies what the manifest schema expresses;
     *  the rules it cannot (name prefix derived from the id, reserved names,
     *  method listed in `methods`, unique names, integers only in
     *  `inputSchema`, the 1 MiB cap) are applied by the Host and the Registry
     *  (docs/en-US/plugin-agent-tools-contract.md section 2). */
    agentTools?: PluginManifestV2AgentTool[]
  }
  /** Extension Pack members (package ids). A pack carries no runtime surface
   *  and no permissions of its own: every member is installed, verified and
   *  confirmed on its own. */
  extensionPack?: string[]
  /** Legacy fields are intentionally unavailable on a v2 manifest. */
  requires?: never
  entry?: never
}

/** One `backend.agentTools` entry (contract section 2.1). */
export type PluginManifestV2AgentTool = {
  name: string
  method: string
  risk: 'read' | 'write'
  title: string
  description: string
  inputSchema: Record<string, unknown>
  timeoutMs?: number
}

export type PluginContractErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_MANIFEST'
  | 'INVALID_EXECUTION_POLICY'
  | 'INVALID_PACKAGE'

export class PluginContractError extends Error {
  constructor(
    message: string,
    readonly code: PluginContractErrorCode = 'INVALID_MANIFEST'
  ) {
    super(message)
    this.name = 'PluginContractError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string, code: PluginContractErrorCode = 'INVALID_MANIFEST'): never {
  throw new PluginContractError(message, code)
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be a JSON object`)
  return value
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${label} has unknown field '${key}'`)
  }
}

function required(value: Record<string, unknown>, key: string, label: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    fail(`${label} is missing required field '${key}'`)
  }
  return value[key]
}

function stringValue(value: unknown, label: string, minLength = 0, maxLength?: number): string {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  const length = Array.from(value).length
  if (length < minLength) fail(`${label} must be a string with at least ${minLength} character(s)`)
  if (maxLength !== undefined && length > maxLength) {
    fail(`${label} must be a string with at most ${maxLength} character(s)`)
  }
  return value
}

function displayText(value: unknown, label: string, maxLength = 80): string {
  const text = stringValue(value, label, 1, maxLength)
  if (/\r|\n|[<>]/.test(text)) fail(`${label} contains unsafe characters`)
  return text
}

function uniqueStringArray(
  value: unknown,
  label: string,
  minItems: number,
  maxItems: number
): string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    fail(`${label} must contain ${minItems}-${maxItems} item(s)`)
  }
  const result = value.map((item, index) => stringValue(item, `${label}[${index}]`))
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicate items`)
  return result
}

function requiredUniqueStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`, 'INVALID_EXECUTION_POLICY')
  const result = value.map((item, index) => {
    if (typeof item !== 'string') {
      fail(`${label}[${index}] must be a string`, 'INVALID_EXECUTION_POLICY')
    }
    return item
  })
  if (new Set(result).size !== result.length) {
    fail(`${label} must not contain duplicate items`, 'INVALID_EXECUTION_POLICY')
  }
  return result
}

const EXECUTION_POLICY_SHELL_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

/** Return the stable lowercase spelling used for persisted shell names. */
export function canonicalizeExecutionPolicyShellName(value: unknown): string {
  if (typeof value !== 'string') {
    fail('execution policy.shell entry must be a string', 'INVALID_EXECUTION_POLICY')
  }
  if (!EXECUTION_POLICY_SHELL_ENTRY.test(value)) {
    fail(
      `execution policy.shell contains an unsafe executable spelling '${value}'`,
      'INVALID_EXECUTION_POLICY'
    )
  }
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

/** Parse and validate the global, agent-oriented Execution Policy contract. */
export function parseExecutionPolicy(raw: unknown): ExecutionPolicy {
  if (!isRecord(raw)) fail('execution policy must be a JSON object', 'INVALID_EXECUTION_POLICY')
  const policy = raw
  const policyKeys = ['schemaVersion', 'mode', 'system', 'shell'] as const
  for (const key of Object.keys(policy)) {
    if (!policyKeys.includes(key as (typeof policyKeys)[number])) {
      fail(`execution policy has unknown field '${key}'`, 'INVALID_EXECUTION_POLICY')
    }
  }
  for (const key of policyKeys) {
    if (!Object.prototype.hasOwnProperty.call(policy, key)) {
      fail(`execution policy is missing required field '${key}'`, 'INVALID_EXECUTION_POLICY')
    }
  }
  if (policy.schemaVersion !== EXECUTION_POLICY_SCHEMA_VERSION) {
    fail(
      `execution policy schemaVersion must be ${EXECUTION_POLICY_SCHEMA_VERSION}`,
      'INVALID_EXECUTION_POLICY'
    )
  }
  if (!EXECUTION_POLICY_MODES.includes(policy.mode as ExecutionPolicyMode)) {
    fail('execution policy mode is invalid', 'INVALID_EXECUTION_POLICY')
  }

  const system = requiredUniqueStringArray(policy.system, 'execution policy.system')
  if (system.some((item) => !V2_SYSTEM_NAMESPACES.includes(item as PluginSystemNamespace))) {
    fail('execution policy.system contains an unknown namespace', 'INVALID_EXECUTION_POLICY')
  }

  if (!Array.isArray(policy.shell)) {
    fail('execution policy.shell must be an array', 'INVALID_EXECUTION_POLICY')
  }
  const shell = policy.shell.map((item, index) => {
    if (typeof item !== 'string') {
      fail(`execution policy.shell[${index}] must be a string`, 'INVALID_EXECUTION_POLICY')
    }
    return canonicalizeExecutionPolicyShellName(item)
  })
  if (new Set(shell).size !== shell.length) {
    fail('execution policy.shell must not contain duplicate items', 'INVALID_EXECUTION_POLICY')
  }

  const mode = policy.mode as ExecutionPolicyMode
  if (mode === 'full' && (system.length > 0 || shell.length > 0)) {
    fail('execution policy full mode must have empty system and shell arrays', 'INVALID_EXECUTION_POLICY')
  }

  return {
    schemaVersion: EXECUTION_POLICY_SCHEMA_VERSION,
    mode,
    system: system as PluginSystemNamespace[],
    shell,
  }
}

/** True when a policy grants unrestricted authority, whichever mode expresses
 * it.
 *
 * The judgement is about what a policy *grants*, never about how many entries
 * it lists. `full` grants everything and says so. An `allowlist` can only ever
 * name what it permits, so its grant is bounded by construction and is never
 * high risk — naming every namespace and every Host executable is still a
 * bounded grant, which is why the Host default policy needs no confirmation.
 *
 * A `denylist` is allow-by-default, and this contract cannot bound what
 * "everything except these" grants: `shell` entries are drawn from an open
 * vocabulary (any executable name that is not listed is permitted, including
 * every name the author never thought of, and entries need not name a binary
 * that exists), and the set of enforcement points is Host-defined. Listing a
 * few entries therefore does not demonstrably narrow the grant — a denylist of
 * `{ system: ['aiCli'], shell: ['zzz-not-a-binary'] }` still hands an agent two
 * system namespaces and every executable — so every denylist is high risk,
 * whatever its arrays contain. Counting empty arrays, as this used to, measured
 * the spelling of the policy instead of its authority. */
export function isHighRiskExecutionPolicy(policy: ExecutionPolicy): boolean {
  if (policy.mode === 'full') return true
  return policy.mode === 'denylist'
}

function safePath(value: unknown, label: string): string {
  const path = stringValue(value, label, 1)
  if (canonicalPackagePath(path) === null) {
    fail(`${label} is not a safe package-relative path`)
  }
  return path
}

function htmlPath(value: unknown, label: string): string {
  const path = safePath(value, label)
  if (canonicalHtmlPath(path) === null) {
    fail(`${label} is not a safe package-relative HTML path`)
  }
  return path
}

function httpsUri(value: unknown, label: string): string {
  const uri = stringValue(value, label, 1, 2048)
  if (!/^https:\/\/[^\s]+$/.test(uri)) fail(`${label} must be an https URL`)
  return uri
}

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const VERSION_RANGE = /^[~^]?[0-9]+\.[0-9]+\.[0-9]+$/
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const PUBLISHER = /^[a-z0-9][a-z0-9-]*$/
const VIEW_ID = /^[a-z][a-z0-9-]*$/
const VIEW_ID_RULE = 'a view id is a lower-case letter followed by a-z, 0-9 and -'
const LICENSE = /^[A-Za-z0-9][A-Za-z0-9.()+ -]*$/
const SCRIPT_EXTENSIONS = new Set([
  '.py',
  '.pyw',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.cmd',
  '.bat',
])

/** Return whether a value is a canonical Manifest v2 package id. */
export function isValidManifestV2PluginId(value: unknown): value is string {
  return typeof value === 'string' && PLUGIN_ID.test(value)
}

type ParsedSemver = {
  core: [string, string, string]
  prerelease: string[]
}

function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER.exec(value)
  if (!match) return null
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Compare SemVer 2.0.0 precedence; build metadata is intentionally ignored. */
export function compareSemver(left: string, right: string): number | null {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) return null

  for (let index = 0; index < a.core.length; index += 1) {
    const result = compareNumericIdentifiers(a.core[index], b.core[index])
    if (result !== 0) return result
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftIdentifier = a.prerelease[index]
    const rightIdentifier = b.prerelease[index]
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1
    }
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = /^[0-9]+$/.test(leftIdentifier)
    const rightNumeric = /^[0-9]+$/.test(rightIdentifier)
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier)
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

const MAX_SCOPE_PATHS = 16

function isScopePattern(pattern: string): boolean {
  // Wildcards aside, a pattern obeys the package safe-path rule; `**` must be
  // a whole segment.
  return (
    canonicalPackagePath(pattern.replace(/\*/g, '_')) !== null &&
    pattern.split('/').every((segment) => segment === '**' || !segment.includes('**'))
  )
}

function scopePaths(value: unknown, label: string): string[] {
  const paths = uniqueStringArray(value, label, 1, MAX_SCOPE_PATHS)
  paths.forEach((path, index) => {
    if (!isScopePattern(path)) {
      fail(`${label}[${index}] is not a safe relative path pattern`)
    }
  })
  return paths
}

function parseScopes(value: unknown): PluginManifestV2Scopes {
  const scopes = assertObject(value, 'manifest permissions.scopes')
  assertOnlyKeys(scopes, ['fs'], 'manifest permissions.scopes')
  const fs = assertObject(
    required(scopes, 'fs', 'manifest permissions.scopes'),
    'manifest permissions.scopes.fs'
  )
  assertOnlyKeys(fs, ['root', 'read', 'write'], 'manifest permissions.scopes.fs')
  if (fs.root !== undefined && !V2_FS_SCOPE_ROOTS.includes(fs.root as PluginFsScopeRoot)) {
    fail(`manifest permissions.scopes.fs.root must be workspace or repository, got ${JSON.stringify(fs.root)}`)
  }
  if (fs.read === undefined && fs.write === undefined) {
    fail('manifest permissions.scopes.fs must declare read or write')
  }
  return {
    fs: {
      ...(fs.root !== undefined ? { root: fs.root as PluginFsScopeRoot } : {}),
      ...(fs.read !== undefined ? { read: scopePaths(fs.read, 'manifest permissions.scopes.fs.read') } : {}),
      ...(fs.write !== undefined ? { write: scopePaths(fs.write, 'manifest permissions.scopes.fs.write') } : {}),
    },
  }
}

function parsePermissions(value: unknown): PluginManifestV2Permissions {
  const permissions = assertObject(value, 'manifest permissions')
  assertOnlyKeys(permissions, ['system', 'shell', 'scopes'], 'manifest permissions')
  let system: PluginSystemNamespace[] | undefined
  if (Object.prototype.hasOwnProperty.call(permissions, 'system')) {
    const values = uniqueStringArray(permissions.system, 'manifest permissions.system', 1, V2_SYSTEM_NAMESPACES.length)
    const unknown = values.find((item) => !V2_SYSTEM_NAMESPACES.includes(item as PluginSystemNamespace))
    if (unknown !== undefined) {
      fail(`manifest permissions.system contains an unknown namespace ${JSON.stringify(unknown)}; allowed: ${V2_SYSTEM_NAMESPACES.join(', ')}`)
    }
    // Message text is disclosed on top of the agent metadata it belongs to.
    if (values.includes('agentMessages') && !values.includes('agents')) {
      fail('manifest permissions.system declares agentMessages without agents')
    }
    system = values as PluginSystemNamespace[]
  }
  let shell: PluginShellMode | undefined
  if (Object.prototype.hasOwnProperty.call(permissions, 'shell')) {
    if (!V2_SHELL_MODES.includes(permissions.shell as PluginShellMode)) {
      fail(`manifest permissions.shell contains an unknown mode ${JSON.stringify(permissions.shell)}; allowed: ${V2_SHELL_MODES.join(', ')}`)
    }
    shell = permissions.shell as PluginShellMode
  }
  const scopes = Object.prototype.hasOwnProperty.call(permissions, 'scopes')
    ? parseScopes(permissions.scopes)
    : undefined
  return { ...(system ? { system } : {}), ...(shell ? { shell } : {}), ...(scopes ? { scopes } : {}) }
}

function parseMarketplace(value: unknown): PluginManifestV2['marketplace'] {
  const marketplace = assertObject(value, 'manifest marketplace')
  assertOnlyKeys(
    marketplace,
    ['description', 'license', 'repository', 'homepage', 'categories', 'icon'],
    'manifest marketplace'
  )
  const description = displayText(required(marketplace, 'description', 'manifest marketplace'), 'manifest marketplace.description', 280)
  const license = stringValue(required(marketplace, 'license', 'manifest marketplace'), 'manifest marketplace.license', 1, 100)
  if (!LICENSE.test(license)) {
    fail(`manifest marketplace.license ${JSON.stringify(license)} contains invalid characters; allowed: letters, digits, spaces and . ( ) + -`)
  }
  const result: PluginManifestV2['marketplace'] = { description, license }
  if (marketplace.repository !== undefined) result.repository = httpsUri(marketplace.repository, 'manifest marketplace.repository')
  if (marketplace.homepage !== undefined) result.homepage = httpsUri(marketplace.homepage, 'manifest marketplace.homepage')
  if (marketplace.categories !== undefined) {
    const categories = uniqueStringArray(marketplace.categories, 'manifest marketplace.categories', 0, 5)
    const invalid = categories.find((category) => !/^[a-z0-9][a-z0-9-]{0,39}$/.test(category))
    if (invalid !== undefined) {
      fail(`manifest marketplace.categories contains an invalid category ${JSON.stringify(invalid)}; a category is 1-40 of a-z, 0-9 and -, starting with a letter or digit`)
    }
    result.categories = categories
  }
  if (marketplace.icon !== undefined) result.icon = safePath(marketplace.icon, 'manifest marketplace.icon')
  return result
}

function parseViews(value: unknown): { views: PluginManifestV2View[] } {
  const contributes = assertObject(value, 'manifest contributes')
  assertOnlyKeys(contributes, ['views'], 'manifest contributes')
  if (!Array.isArray(contributes.views) || contributes.views.length < 1 || contributes.views.length > 16) {
    fail('manifest contributes.views must contain 1-16 view(s)')
  }
  const views = contributes.views.map((raw, index) => {
    const view = assertObject(raw, `manifest contributes.views[${index}]`)
    assertOnlyKeys(view, ['id', 'kind', 'location', 'title', 'icon', 'entry', 'detailView', 'targetSchema', 'receives'], `manifest contributes.views[${index}]`)
    const id = stringValue(required(view, 'id', `manifest contributes.views[${index}]`), `manifest contributes.views[${index}].id`)
    if (!VIEW_ID.test(id)) fail(`manifest contributes.views[${index}].id ${JSON.stringify(id)} is invalid; ${VIEW_ID_RULE}`)
    if (view.kind !== 'custom') fail(`manifest contributes.views[${index}].kind must be 'custom'`)
    if (!V2_VIEW_LOCATIONS.includes(view.location as (typeof V2_VIEW_LOCATIONS)[number])) {
      fail(`manifest contributes.views[${index}].location ${JSON.stringify(view.location)} is invalid; allowed: ${V2_VIEW_LOCATIONS.join(', ')}`)
    }
    const title = displayText(required(view, 'title', `manifest contributes.views[${index}]`), `manifest contributes.views[${index}].title`)
    const entry = htmlPath(required(view, 'entry', `manifest contributes.views[${index}]`), `manifest contributes.views[${index}].entry`)
    const parsed: PluginManifestV2View = {
      id,
      kind: 'custom',
      location: view.location as PluginManifestV2View['location'],
      title,
      entry,
    }
    if (view.icon !== undefined) parsed.icon = safePath(view.icon, `manifest contributes.views[${index}].icon`)
    if (view.detailView !== undefined) {
      parsed.detailView = stringValue(view.detailView, `manifest contributes.views[${index}].detailView`)
      if (!VIEW_ID.test(parsed.detailView)) {
        fail(`manifest contributes.views[${index}].detailView ${JSON.stringify(parsed.detailView)} is invalid; ${VIEW_ID_RULE}`)
      }
    }
    if (view.targetSchema !== undefined) {
      parsed.targetSchema = safePath(view.targetSchema, `manifest contributes.views[${index}].targetSchema`)
      if (!parsed.targetSchema.endsWith('.json')) fail(`manifest contributes.views[${index}].targetSchema must be a JSON file`)
    }
    if (view.receives !== undefined) {
      const receives = assertObject(view.receives, `manifest contributes.views[${index}].receives`)
      assertOnlyKeys(receives, ['protocolVersion', 'locations', 'editorTargets', 'closeGuard'], `manifest contributes.views[${index}].receives`)
      if (receives.protocolVersion !== 1) fail(`manifest contributes.views[${index}].receives.protocolVersion must be 1`)
      const locations = uniqueStringArray(receives.locations, `manifest contributes.views[${index}].receives.locations`, 1, 2)
      const invalidLocation = locations.find((location) => !V2_RECEIVER_LOCATIONS.includes(location as (typeof V2_RECEIVER_LOCATIONS)[number]))
      if (invalidLocation !== undefined) {
        fail(`manifest contributes.views[${index}].receives.locations contains an invalid location ${JSON.stringify(invalidLocation)}; allowed: ${V2_RECEIVER_LOCATIONS.join(', ')}`)
      }
      const receiver: PluginManifestV2Receiver = {
        protocolVersion: 1,
        locations: locations as PluginManifestV2Receiver['locations'],
      }
      if (receives.editorTargets !== undefined) {
        const editorTargets = assertObject(receives.editorTargets, `manifest contributes.views[${index}].receives.editorTargets`)
        assertOnlyKeys(editorTargets, ['protocolVersion'], `manifest contributes.views[${index}].receives.editorTargets`)
        if (editorTargets.protocolVersion !== 1) fail(`manifest contributes.views[${index}].receives.editorTargets.protocolVersion must be 1`)
        receiver.editorTargets = { protocolVersion: 1 }
      }
      if (receives.closeGuard !== undefined) {
        const closeGuard = assertObject(receives.closeGuard, `manifest contributes.views[${index}].receives.closeGuard`)
        assertOnlyKeys(closeGuard, ['protocolVersion'], `manifest contributes.views[${index}].receives.closeGuard`)
        if (closeGuard.protocolVersion !== 1) fail(`manifest contributes.views[${index}].receives.closeGuard.protocolVersion must be 1`)
        receiver.closeGuard = { protocolVersion: 1 }
      }
      parsed.receives = receiver
    }
    if (parsed.detailView !== undefined && parsed.location !== 'left') fail(`manifest contributes.views[${index}].detailView is only valid for a left view`)
    if (parsed.targetSchema !== undefined && parsed.location !== 'detail') fail(`manifest contributes.views[${index}].targetSchema is only valid for a detail view`)
    if (parsed.receives !== undefined && parsed.location !== 'window') fail(`manifest contributes.views[${index}].receives is only valid for a window view`)
    return parsed
  })
  const ids = new Set<string>()
  for (const view of views) {
    if (ids.has(view.id)) fail(`manifest contributes.views contains duplicate id '${view.id}'`)
    ids.add(view.id)
  }
  for (const view of views) {
    if (view.detailView !== undefined && !views.some((candidate) => candidate.id === view.detailView && candidate.location === 'detail')) {
      fail(`manifest contributes.views detailView '${view.detailView}' must reference a detail view in the same package`)
    }
  }
  return { views }
}

function parseBackend(value: unknown): PluginManifestV2['backend'] {
  const backend = assertObject(value, 'manifest backend')
  assertOnlyKeys(backend, ['entry', 'protocolVersion', 'activation', 'methods', 'events', 'agentTools'], 'manifest backend')
  const entry = safePath(required(backend, 'entry', 'manifest backend'), 'manifest backend.entry')
  const filename = entry.slice(entry.lastIndexOf('/') + 1).toLowerCase()
  const extension = filename.slice(filename.lastIndexOf('.'))
  if (SCRIPT_EXTENSIONS.has(extension)) {
    fail('manifest backend.entry must reference a packaged executable, not a raw script')
  }
  if (backend.protocolVersion !== 1) fail('manifest backend.protocolVersion must be 1')
  if (backend.activation !== 'startup') fail("manifest backend.activation must be 'startup'")
  const methods = backend.methods === undefined
    ? undefined
    : backendNameList(backend.methods, 'manifest backend.methods', MAX_BACKEND_METHODS)
  const events = backend.events === undefined
    ? undefined
    : backendNameList(backend.events, 'manifest backend.events', MAX_BACKEND_EVENTS)
  const agentTools = backend.agentTools === undefined ? undefined : agentToolList(backend.agentTools)
  return {
    entry,
    protocolVersion: 1,
    activation: 'startup',
    ...(methods ? { methods } : {}),
    ...(events ? { events } : {}),
    ...(agentTools ? { agentTools } : {}),
  }
}

const AGENT_TOOL_KEYS = ['name', 'method', 'risk', 'title', 'description', 'inputSchema', 'timeoutMs'] as const
const AGENT_TOOL_NAME_PATTERN = /^[a-z][a-z0-9]{1,15}_[a-z0-9_]{1,40}$/
// The Host backend supervisor's method-name rule (isMethodName in
// src/main/plugins/pluginBackendSupervisor.ts): stricter than the manifest
// schema's backend name pattern, and what activation enforces.
const AGENT_TOOL_METHOD_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/
// eslint-disable-next-line no-control-regex
const AGENT_TOOL_TEXT_PATTERN = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029<>]+$/

/** The `agentTool` definition of plugin-manifest-v2.schema.json; returns copies. */
function agentToolList(value: unknown): PluginManifestV2AgentTool[] {
  if (!Array.isArray(value) || value.length === 0) fail('manifest backend.agentTools must be a non-empty array')
  return value.map((raw, index) => {
    const label = `manifest backend.agentTools[${index}]`
    const tool = assertObject(raw, label)
    assertOnlyKeys(tool, AGENT_TOOL_KEYS, label)
    for (const key of AGENT_TOOL_KEYS.slice(0, 6)) required(tool, key, label)
    if (typeof tool.name !== 'string' || !AGENT_TOOL_NAME_PATTERN.test(tool.name)) fail(`${label}.name is invalid`)
    if (typeof tool.method !== 'string' || tool.method.length > 128 || !AGENT_TOOL_METHOD_PATTERN.test(tool.method)) {
      fail(`${label}.method must be a lower-case backend method name (a-z, 0-9, _ and dots), as the Host accepts`)
    }
    if (tool.risk !== 'read' && tool.risk !== 'write') fail(`${label}.risk must be 'read' or 'write'`)
    for (const key of ['title', 'description'] as const) {
      const text = tool[key]
      if (typeof text !== 'string' || !AGENT_TOOL_TEXT_PATTERN.test(text)) {
        fail(`${label}.${key} must be non-empty plain text without control characters or < >`)
      }
    }
    const schema = tool.inputSchema
    if (!isRecord(schema) || schema.type !== 'object') fail(`${label}.inputSchema must be a JSON Schema of type 'object'`)
    if (tool.timeoutMs !== undefined) {
      const timeout = tool.timeoutMs
      if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) {
        fail(`${label}.timeoutMs must be an integer from 1 to 120000`)
      }
    }
    return structuredClone(tool) as PluginManifestV2AgentTool
  })
}

/** Most package-local methods / events one backend may declare. */
export const MAX_BACKEND_METHODS = 64
export const MAX_BACKEND_EVENTS = 32
// Main's rule, unchanged: an installed package without agent tools loads as
// before. agentTools[].method has the stricter AGENT_TOOL_METHOD_PATTERN.
// Pinned by pluginBackendNameRule.test.ts.
const BACKEND_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

function backendNameList(value: unknown, label: string, maxItems: number): string[] {
  const names = uniqueStringArray(value, label, 1, maxItems)
  for (const name of names) {
    if (name.length > 128 || !BACKEND_NAME_PATTERN.test(name)) {
      fail(`${label} contains an invalid name ${JSON.stringify(name)}; a name is dot-separated segments that each start with a lower-case letter followed by letters or digits, for example files.search`)
    }
  }
  return names
}

export function parseManifestV2(raw: unknown): PluginManifestV2 {
  const manifest = assertObject(raw, 'manifest')
  assertOnlyKeys(
    manifest,
    ['schemaVersion', 'apiVersion', 'id', 'name', 'version', 'publisher', 'engines', 'permissions', 'marketplace', 'contributes', 'backend', 'extensionPack'],
    'manifest'
  )
  if (manifest.schemaVersion !== 2) fail('manifest schemaVersion must be 2')
  const apiVersion = stringValue(required(manifest, 'apiVersion', 'manifest'), 'manifest apiVersion')
  if (!VERSION_RANGE.test(apiVersion)) {
    fail(`manifest apiVersion must be a simple semver range such as ^1.0.0, got ${JSON.stringify(apiVersion)}`)
  }
  const id = stringValue(required(manifest, 'id', 'manifest'), 'manifest id')
  if (!PLUGIN_ID.test(id)) {
    fail(`manifest id must be lowercase dot-separated segments, got ${id}`)
  }
  const name = displayText(required(manifest, 'name', 'manifest'), 'manifest name')
  const version = stringValue(required(manifest, 'version', 'manifest'), 'manifest version')
  if (!SEMVER.test(version)) fail(`manifest version must be semver, got ${version}`)
  const publisher = stringValue(required(manifest, 'publisher', 'manifest'), 'manifest publisher')
  if (!PUBLISHER.test(publisher)) {
    fail(`manifest publisher must be lowercase (a-z, 0-9 and -, starting with a letter or digit), got ${JSON.stringify(publisher)}`)
  }
  if (id.split('.', 1)[0] !== publisher) {
    fail(`manifest publisher must match id namespace: publisher ${JSON.stringify(publisher)}, id namespace ${JSON.stringify(id.split('.', 1)[0])}`)
  }
  let engines: PluginManifestV2['engines'] | undefined
  if (manifest.engines !== undefined) {
    const parsedEngines = assertObject(manifest.engines, 'manifest engines')
    assertOnlyKeys(parsedEngines, ['navide'], 'manifest engines')
    engines = { navide: stringValue(required(parsedEngines, 'navide', 'manifest engines'), 'manifest engines.navide', 1) }
  }
  const permissions = parsePermissions(required(manifest, 'permissions', 'manifest'))
  const marketplace = parseMarketplace(required(manifest, 'marketplace', 'manifest'))
  let extensionPack: string[] | undefined
  if (manifest.extensionPack !== undefined) {
    extensionPack = uniqueStringArray(manifest.extensionPack, 'manifest extensionPack', 1, MAX_EXTENSION_PACK_MEMBERS)
    const invalidMember = extensionPack.find((member) => !PLUGIN_ID.test(member))
    if (invalidMember !== undefined) {
      fail(`manifest extensionPack contains an invalid package id ${JSON.stringify(invalidMember)}; a package id is lowercase dot-separated segments, for example acme.tool`)
    }
    if (extensionPack.includes(id)) fail('manifest extensionPack must not list the pack itself')
    if (manifest.contributes !== undefined || manifest.backend !== undefined) {
      fail('an extension pack must not declare contributes or backend')
    }
    if (permissions.system !== undefined || permissions.shell !== undefined || permissions.scopes !== undefined) {
      fail('an extension pack must not request permissions')
    }
  } else if (manifest.contributes === undefined && manifest.backend === undefined) {
    fail('manifest must declare contributes or backend')
  }
  const contributes = manifest.contributes === undefined ? undefined : parseViews(manifest.contributes)
  const backend = manifest.backend === undefined ? undefined : parseBackend(manifest.backend)
  return {
    schemaVersion: 2,
    apiVersion,
    id,
    name,
    version,
    publisher,
    ...(engines ? { engines } : {}),
    permissions,
    marketplace,
    ...(contributes ? { contributes } : {}),
    ...(backend ? { backend } : {}),
    ...(extensionPack ? { extensionPack } : {}),
  }
}

export function manifestReferencedFiles(manifest: PluginManifestV2): string[] {
  const paths: string[] = []
  for (const view of manifest.contributes?.views ?? []) {
    paths.push(view.entry)
    if (view.icon) paths.push(view.icon)
    if (view.targetSchema) paths.push(view.targetSchema)
  }
  if (manifest.marketplace.icon) paths.push(manifest.marketplace.icon)
  if (manifest.backend) paths.push(manifest.backend.entry)
  return [...new Set(paths)]
}

function parseJsonString(text: string, start: number): { value: string; next: number } {
  if (text[start] !== '"') throw new Error('invalid JSON string')
  let cursor = start + 1
  while (cursor < text.length) {
    const char = text[cursor++]
    if (char === '\\') {
      cursor++
      continue
    }
    if (char === '"') {
      const raw = text.slice(start, cursor)
      const value = JSON.parse(raw)
      if (typeof value !== 'string') throw new Error('invalid JSON string')
      return { value, next: cursor }
    }
    if (char < ' ') throw new Error('invalid JSON string')
  }
  throw new Error('unterminated JSON string')
}

function assertUniqueJsonKeys(text: string): void {
  let cursor = 0
  const skipWhitespace = (): void => {
    while (/\s/.test(text[cursor] ?? '')) cursor += 1
  }
  const parseValue = (): void => {
    skipWhitespace()
    const char = text[cursor]
    if (char === '{') return parseObject()
    if (char === '[') return parseArray()
    if (char === '"') {
      cursor = parseJsonString(text, cursor).next
      return
    }
    if (text.startsWith('true', cursor)) {
      cursor += 4
      return
    }
    if (text.startsWith('false', cursor)) {
      cursor += 5
      return
    }
    if (text.startsWith('null', cursor)) {
      cursor += 4
      return
    }
    const number = text.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (number) {
      cursor += number[0].length
      return
    }
    throw new Error('invalid JSON value')
  }
  const parseObject = (): void => {
    cursor += 1
    skipWhitespace()
    const keys = new Set<string>()
    if (text[cursor] === '}') {
      cursor += 1
      return
    }
    while (cursor < text.length) {
      skipWhitespace()
      const key = parseJsonString(text, cursor)
      cursor = key.next
      if (keys.has(key.value)) throw new PluginContractError(`duplicate JSON object key: ${key.value}`, 'INVALID_JSON')
      keys.add(key.value)
      skipWhitespace()
      if (text[cursor++] !== ':') throw new Error('invalid JSON object')
      parseValue()
      skipWhitespace()
      if (text[cursor] === '}') {
        cursor += 1
        return
      }
      if (text[cursor++] !== ',') throw new Error('invalid JSON object')
    }
    throw new Error('unterminated JSON object')
  }
  const parseArray = (): void => {
    cursor += 1
    skipWhitespace()
    if (text[cursor] === ']') {
      cursor += 1
      return
    }
    while (cursor < text.length) {
      parseValue()
      skipWhitespace()
      if (text[cursor] === ']') {
        cursor += 1
        return
      }
      if (text[cursor++] !== ',') throw new Error('invalid JSON array')
    }
    throw new Error('unterminated JSON array')
  }
  parseValue()
  skipWhitespace()
  if (cursor !== text.length) throw new Error('trailing JSON data')
}

export function parseStrictJson(text: string, label = 'JSON'): unknown {
  if (text.charCodeAt(0) === 0xfeff) fail(`${label} must not start with UTF-8 BOM`, 'INVALID_JSON')
  try {
    assertUniqueJsonKeys(text)
  } catch (error) {
    if (error instanceof PluginContractError) throw error
    fail(`${label} is not valid: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_JSON')
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof PluginContractError) throw error
    fail(`${label} is not valid: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_JSON')
  }
}

export function parseManifestJson(text: string): Record<string, unknown> {
  const parsed = parseStrictJson(text, 'manifest JSON')
  if (!isRecord(parsed)) fail('manifest must be a JSON object')
  return parsed
}

export function parseExecutionPolicyJson(text: string): ExecutionPolicy {
  return parseExecutionPolicy(parseStrictJson(text, 'execution policy JSON'))
}

export const PLUGIN_ERROR_CODES = [
  'CAPABILITY_DENIED',
  'METHOD_NOT_FOUND',
  'INVALID_ARGUMENT',
  'WORKSPACE_SCOPE_VIOLATION',
  'USER_CANCELLED',
  'TIMEOUT',
  'BACKEND_UNAVAILABLE',
  'PLUGIN_STOPPING',
  'STORAGE_QUOTA_EXCEEDED',
  'RESOURCE_LIMIT',
  'INTERNAL_ERROR',
] as const

export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number]

export class PluginError extends Error {
  constructor(
    readonly code: PluginErrorCode,
    message: string,
    readonly details?: JsonValue
  ) {
    super(message)
    this.name = 'PluginError'
  }
}

export interface PublicMethodParams extends EditorFilesystemParams, EditorAiParams, AiTerminalParams, EditorNativeParams, GitCapabilityParams, GitAccountParams, IssueParams, EditorPreferenceParams, AgentsParams {
  'ui.openFilePicker': FilePickerRequest
  'fs.readFile': { path: string; encoding?: string; selectionGrant?: string }
  'fs.writeFile': { path: string; content: string; encoding?: string; expectedMtime?: number; selectionGrant?: string }
  'fs.readImage': { path: string; selectionGrant?: string }
  'fs.listDirectory': { path: string; showHidden?: boolean }
  'fs.listFilesFlat': { query?: string; maxResults?: number }
  'fs.queryFiles': {
    query: string
    matchOn?: 'name' | 'path'
    mode?: 'substring' | 'subsequence' | 'glob'
    exclude?: string[]
    respectGitignore?: boolean
    includeHidden?: boolean
    includeNoiseDirs?: boolean
    limit?: number
    cursor?: string
  }
  'fs.glob': { pattern: string }
  'fs.stat': { path: string; selectionGrant?: string }
  'fs.statPath': { path: string; selectionGrant?: string }
  'ui.openInEditor': { path: string; line?: number; column?: number }
  'ui.openPlansWindow': { path: string }
  'ui.shareCaps': Record<string, never>
  'ui.shareCreate': { path: string; ttlSeconds?: number; requireLogin?: boolean; sendToChat?: boolean; chatId?: string }
  'ui.shareChatTargets': Record<string, never>
  'ui.openExternal': { url: string }
  'aiCli.listProfiles': { terminalView?: boolean }
  'aiCli.startSession': { profileId: string; requestId?: string; cols: number; rows: number; yolo?: boolean; persistView?: boolean }
  'aiCli.resumeSession': { cols: number; rows: number; persistView?: boolean }
  'aiCli.cancelStart': { requestId: string }
  'aiCli.reattachSession': { sessionId: string; cols: number; rows: number }
  'aiCli.sendInput': { sessionId: string; data: string }
  'aiCli.resizeSession': { sessionId: string; cols: number; rows: number }
  'aiCli.redrawSession': { sessionId: string; cols: number; rows: number }
  'aiCli.interruptSession': { sessionId: string }
  'aiCli.stopSession': { sessionId: string; force: boolean }
  'shell.run': { command: string }
  'storage.get': { scope: StoragePartitionScope; key: string }
  'storage.set': { scope: StoragePartitionScope; key: string; value: JsonValue }
  'storage.delete': { scope: StoragePartitionScope; key: string }
}

export interface PublicMethodResults extends EditorFilesystemResults, EditorAiResults, AiTerminalResults, EditorNativeResults, GitCapabilityResults, GitAccountResults, IssueResults, EditorPreferenceResults, AgentsResults {
  'ui.openFilePicker': { opened: boolean }
  'fs.readFile': {
    content: string
    ok?: boolean
    error?: string
    encoding?: string
    bom?: boolean
    mtime?: number
    is_binary?: boolean
    is_image?: boolean
    size?: number
    ext?: string
  }
  'fs.writeFile': { ok: boolean; error?: string; mtime?: number; conflict?: boolean }
  'fs.readImage': { ok: boolean; data_url?: string; mime?: string; size?: number; error?: string }
  'fs.listDirectory': {
    entries: Array<{ name: string; kind: 'file' | 'directory'; rel_path?: string; is_dir?: boolean; is_hidden?: boolean; is_noise?: boolean }>
    ok?: boolean
    truncated?: boolean
    error?: string
  }
  'fs.listFilesFlat': { files?: string[]; ok?: boolean; truncated?: boolean; error?: string }
  'fs.queryFiles': {
    ok: boolean
    files?: Array<{ path: string; name: string; matchSpans: Array<[number, number]>; size: number; mtime: number }>
    nextCursor?: string
    gitignoreApplied?: boolean
    listingTruncated?: boolean
    timedOut?: boolean
    error?: string
  }
  'fs.glob': { paths: string[] }
  'fs.stat': { kind: 'file' | 'directory'; size: number; modifiedAt: string }
  'fs.statPath': { exists: boolean }
  'ui.openInEditor': { opened: boolean }
  'ui.openPlansWindow': { opened: boolean }
  'ui.shareCaps': { ok: true } | { ok: false; code: string; message: string }
  'ui.shareCreate':
    | { ok: true; link: { linkId: string; url: string; expiresAt: string; masked: Array<{ line: number; category: string; action: string }> } }
    | { ok: false; code: string; message: string; reason?: string }
  'ui.shareChatTargets':
    | { ok: true; chats: Array<{ chatId: string; platform: string; name: string }> }
    | { ok: false; code: string; message: string }
  'ui.openExternal': { opened: boolean }
  'aiCli.listProfiles': { profiles: Array<{ id: string; label: string; fullScreenTui?: boolean; bracketedPaste?: boolean; shiftEnterSequence?: string }> }
  'aiCli.startSession': { sessionId: string }
  'aiCli.resumeSession': { sessionId: string; profileId: string } | null
  'aiCli.cancelStart': Record<string, never>
  'aiCli.reattachSession': { sessionId: string }
  'aiCli.sendInput': Record<string, never>
  'aiCli.resizeSession': Record<string, never>
  'aiCli.redrawSession': Record<string, never>
  'aiCli.interruptSession': Record<string, never>
  'aiCli.stopSession': Record<string, never>
  /** stdout and stderr are cut at 8000 characters each; `truncated` and the
   *  full UTF-8 sizes say so (`stderrBytes` only when stderr was cut). */
  'shell.run': {
    exitCode: number; stdout: string; stderr: string
    truncated?: boolean; stdoutBytes?: number; stderrBytes?: number
  }
  'storage.get': StorageGetResult
  'storage.set': null
  'storage.delete': boolean
}

export type PublicMethod = keyof PublicMethodParams
export type Params<M extends PublicMethod> = PublicMethodParams[M]
export type Result<M extends PublicMethod> = PublicMethodResults[M]

export interface PublicEventPayloads extends EditorAiEvents, EditorNativeEvents, EditorPreferenceEvents, GitCredentialEvents {
  /** UI notification for a write to this receiver's own selected snapshot. */
  'ui.pluginStorageChanged': { scope: StoragePartitionScope; key: string; value: JsonValue; deleted: boolean }
  'workspace.filesChanged': {
    changes: Array<{ path: string; kind: 'created' | 'changed' | 'deleted' }>
  }
  'aiCli.output': { sessionId: string; data: string }
  'aiCli.exited': { sessionId: string; exitCode: number | null }
}

export type PublicEvent = keyof PublicEventPayloads
export type Payload<E extends PublicEvent> = PublicEventPayloads[E]

export interface Disposable {
  dispose(): void
}

export { manifestV2Schema, capabilitiesV1, executionPolicyV1Schema }
export { PLUGIN_API_VERSION, isPluginApiSupported, pluginApiMajor } from './apiVersion.js'
