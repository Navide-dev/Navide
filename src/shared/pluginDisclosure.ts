/**
 * Step-0 contract for Navide plugin disclosure (plan B, D1–D5).
 *
 * The disclosure ("揭露資料") is computed from a package manifest only, so the
 * Registry (at publish time, in the signed disclosure envelope) and the App (at
 * prepareInstall, from the package's own manifest) compute the same object and
 * compare their canonical spellings. Registry-only facts (publisher
 * verification, review and scan results) travel beside it, never inside it.
 *
 * Types and pure functions only: nothing in the app imports this module yet.
 * Normative text: docs/en-US/plugin-agent-tools-contract.md. Python twin:
 * backend/agent_team_backend/plugins/disclosure_contract.py.
 */

import { canonicalJson } from './canonicalJson'
import { AGENT_TOOL_DEFAULT_TIMEOUT_MS } from './pluginAgentTools'
import type { AgentToolRisk } from './pluginAgentTools'
import type { ScanReport } from './pluginDisclosureScan'

export const DISCLOSURE_SCHEMA_VERSION = 1
export const DISCLOSURE_SUMMARY_TEMPLATE = 'plugin-disclosure.summary.v1'
/** The Host shell allowlist (plugin-development-v2.md, "Host-managed storage partitions"). */
export const HOST_SHELL_ALLOWLIST = ['gh', 'git', 'glab'] as const

export type DisclosureRiskLevel = 'low' | 'medium' | 'high' | 'highest'
const RISK_RANK: Record<DisclosureRiskLevel, number> = { low: 0, medium: 1, high: 2, highest: 3 }

export type DisclosureRiskReasonKey =
  | 'system.ui'
  | 'system.fs'
  | 'system.aiCli'
  | 'system.web'
  | 'system.agents'
  | 'system.agentMessages'
  | 'shell.allowlist'
  | 'nativeBackend'
  | 'agentTools.write'
  | 'shell.full'
  | 'network'

/** Every reason with its level, in the order reasons are listed. */
export const DISCLOSURE_RISK_RULES: ReadonlyArray<readonly [DisclosureRiskReasonKey, DisclosureRiskLevel]> = [
  ['system.ui', 'low'],
  ['system.fs', 'medium'],
  ['system.aiCli', 'high'],
  ['system.web', 'high'],
  ['system.agents', 'medium'],
  ['system.agentMessages', 'high'],
  ['shell.allowlist', 'high'],
  ['nativeBackend', 'high'],
  ['agentTools.write', 'high'],
  ['shell.full', 'highest'],
  ['network', 'highest'],
]

export type DisclosureSummaryClause =
  | { key: 'nativeBackend'; params: Record<string, never> }
  | { key: 'files'; params: { access: 'read' | 'readWrite' } }
  | { key: 'shell'; params: { mode: 'allowlist'; executables: string[] } | { mode: 'full'; executables: null } }
  | { key: 'aiCli'; params: Record<string, never> }
  | { key: 'web'; params: Record<string, never> }
  | { key: 'agents'; params: Record<string, never> }
  | { key: 'agentMessages'; params: Record<string, never> }
  | { key: 'ui'; params: Record<string, never> }
  | { key: 'agentTools'; params: { read: number; write: number } }
  | { key: 'network'; params: Record<string, never> }
  | { key: 'networkViaShell'; params: Record<string, never> }
  | { key: 'noPermissions'; params: Record<string, never> }

export interface DisclosureSummary {
  template: typeof DISCLOSURE_SUMMARY_TEMPLATE
  clauses: DisclosureSummaryClause[]
}

export interface DisclosurePermissions {
  system: Array<'aiCli' | 'fs' | 'ui' | 'web' | 'agents' | 'agentMessages'>
  shell: { mode: 'allowlist'; executables: string[] } | { mode: 'full'; executables: null } | null
  scopes: { fs: { root: 'workspace' | 'repository'; read: string[]; write: string[] } } | null
}

export interface DisclosureAgentTool {
  name: string
  method: string
  risk: AgentToolRisk
  title: string
  description: string
  timeoutMs: number
  inputSchema: Record<string, unknown>
}

export type DisclosureProjectWrites = 'none' | 'undeclared' | { root: 'workspace' | 'repository'; patterns: string[] }

/** The manifest-derived disclosure. Signed by the Registry and recomputed by the App. */
export interface ManifestDisclosure {
  schemaVersion: typeof DISCLOSURE_SCHEMA_VERSION
  plugin: { id: string; version: string; publisher: string }
  summary: DisclosureSummary
  risk: { level: DisclosureRiskLevel; reasons: Array<{ key: DisclosureRiskReasonKey; level: DisclosureRiskLevel }> }
  permissions: DisclosurePermissions
  nativeBackend: { methods: string[]; events: string[] } | null
  /** Commands and the native backend only. The backend sandboxes have no
   * network (DB10, a network permission, is deferred), but a declared shell
   * runs git/gh/glab (or, in full mode, anything), which reach remote hosts:
   * "via-shell" whenever shell is declared, else "none". The scan (section
   * 3.8) names the concrete hosts. Plugin views are not covered here: they are
   * web pages that can reach the network and embed external sites, which the
   * Host does not filter. "none" therefore never means the package has no
   * network; the disclosure card states the view side for a package with
   * views (`pluginDisclosure.viewNetwork`, R2 MED-3 on 0.2.26; `hasViews` from
   * the manifest, R2 MED-6 on #436). Kept out of this signed field so cards
   * the Registry already signed still match. */
  network: 'none' | 'via-shell'
  agentTools: DisclosureAgentTool[]
  dataLocations: { hostStorage: true; backendDataDirectory: boolean; projectWrites: DisclosureProjectWrites }
}

/** Facts only the Registry knows; computed there (not covered by a signature), never derived from the manifest. */
export interface RegistryDisclosureFacts {
  publisher: { name: string; verifiedDomain: string | null; domainVerifiedAt: string | null }
  signature: { signed: boolean; keyId: string | null }
  review: {
    status: 'approved' | 'pending' | 'rejected' | 'not-required'
    reviewedAt: string | null
    /** Native backend versions only: the reviewer confirmed inspecting every target executable. */
    nativeCodeInspected: boolean | null
  }
  scan: {
    secretScan: 'clean' | 'findings' | 'not-run'
    secretFindings: number
    similarityWarning: boolean
    similarTo: string | null
    scannedAt: string | null
  }
}

/** What every disclosure surface (list card, detail, consent, B2 approval card) renders. */
export interface DisclosureCard {
  manifest: ManifestDisclosure
  /** The version's scan report (contract 3.4, 3.8), or null when it has none. */
  scan: ScanReport | null
  registry: RegistryDisclosureFacts | null
}

export type DisclosureItemKind =
  | 'agentTool'
  | 'backendEvent'
  | 'backendMethod'
  | 'fsScopeRead'
  | 'fsScopeRoot'
  | 'fsScopeWrite'
  | 'nativeBackend'
  | 'network'
  | 'shell'
  | 'shellExecutable'
  | 'system'

export interface DisclosureItem {
  kind: DisclosureItemKind
  key: string
  /** agentTool: the tool entry without its name; every other kind: null. */
  detail: Omit<DisclosureAgentTool, 'name'> | null
}

export interface DisclosureDiff {
  schemaVersion: typeof DISCLOSURE_SCHEMA_VERSION
  from: { id: string; version: string; risk: DisclosureRiskLevel }
  to: { id: string; version: string; risk: DisclosureRiskLevel }
  added: DisclosureItem[]
  removed: DisclosureItem[]
  unchanged: DisclosureItem[]
  /** Something was added or the risk level rose: only then does an update ask again (D2).
   *  A declared file scope is informational (see fsScopeChangeWidens), so
   *  declaring one where there was none does not count; dropping or growing
   *  one does. */
  widened: boolean
}

/** The manifest fields the computation reads; the input must already be a valid manifest. */
export interface DisclosureManifestInput {
  id: string
  version: string
  publisher: string
  permissions?: {
    system?: string[]
    shell?: 'allowlist' | 'full'
    scopes?: { fs: { root?: 'workspace' | 'repository'; read?: string[]; write?: string[] } }
  }
  backend?: {
    methods?: string[]
    events?: string[]
    agentTools?: Array<{
      name: string
      method: string
      risk: AgentToolRisk
      title: string
      description: string
      inputSchema: Record<string, unknown>
      timeoutMs?: number
    }>
  }
}

const sorted = (values: readonly string[] | undefined): string[] => [...(values ?? [])].sort(compareCodeUnits)

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The highest level among the reasons; low when there are none. */
export function riskLevelForReasons(reasons: ReadonlyArray<{ key: string; level: DisclosureRiskLevel }>): DisclosureRiskLevel {
  let level: DisclosureRiskLevel = 'low'
  for (const reason of reasons) if (RISK_RANK[reason.level] > RISK_RANK[level]) level = reason.level
  return level
}

export function computeDisclosure(manifest: DisclosureManifestInput): ManifestDisclosure {
  const declared = manifest.permissions ?? {}
  const system = sorted(declared.system) as DisclosurePermissions['system']
  const shell: DisclosurePermissions['shell'] =
    declared.shell === 'allowlist'
      ? { mode: 'allowlist', executables: [...HOST_SHELL_ALLOWLIST] }
      : declared.shell === 'full'
        ? { mode: 'full', executables: null }
        : null
  const fsScope = declared.scopes?.fs
  const scopes: DisclosurePermissions['scopes'] = fsScope
    ? { fs: { root: fsScope.root ?? 'workspace', read: sorted(fsScope.read), write: sorted(fsScope.write) } }
    : null
  const backend = manifest.backend
  const nativeBackend = backend ? { methods: sorted(backend.methods), events: sorted(backend.events) } : null
  const agentTools: DisclosureAgentTool[] = [...(backend?.agentTools ?? [])]
    .map((tool) => ({
      name: tool.name,
      method: tool.method,
      risk: tool.risk,
      title: tool.title,
      description: tool.description,
      timeoutMs: tool.timeoutMs ?? AGENT_TOOL_DEFAULT_TIMEOUT_MS,
      inputSchema: tool.inputSchema,
    }))
    .sort((a, b) => compareCodeUnits(a.name, b.name))
  const readTools = agentTools.filter((tool) => tool.risk === 'read').length
  const writeTools = agentTools.length - readTools
  const hasFs = system.includes('fs')

  const present = new Set<DisclosureRiskReasonKey>()
  if (system.includes('ui')) present.add('system.ui')
  if (hasFs) present.add('system.fs')
  if (system.includes('aiCli')) present.add('system.aiCli')
  if (system.includes('web')) present.add('system.web')
  if (system.includes('agents')) present.add('system.agents')
  if (system.includes('agentMessages')) present.add('system.agentMessages')
  if (shell?.mode === 'allowlist') present.add('shell.allowlist')
  if (nativeBackend) present.add('nativeBackend')
  if (writeTools > 0) present.add('agentTools.write')
  if (shell?.mode === 'full') present.add('shell.full')
  const reasons = DISCLOSURE_RISK_RULES.filter(([key]) => present.has(key)).map(([key, level]) => ({ key, level }))

  const clauses: DisclosureSummaryClause[] = []
  if (nativeBackend) clauses.push({ key: 'nativeBackend', params: {} })
  if (hasFs) {
    const readOnly = scopes !== null && scopes.fs.write.length === 0
    clauses.push({ key: 'files', params: { access: readOnly ? 'read' : 'readWrite' } })
  }
  if (shell) clauses.push({ key: 'shell', params: shell })
  if (shell) clauses.push({ key: 'networkViaShell', params: {} })
  if (system.includes('aiCli')) clauses.push({ key: 'aiCli', params: {} })
  if (system.includes('web')) clauses.push({ key: 'web', params: {} })
  if (system.includes('agents')) clauses.push({ key: 'agents', params: {} })
  if (system.includes('agentMessages')) clauses.push({ key: 'agentMessages', params: {} })
  if (system.includes('ui')) clauses.push({ key: 'ui', params: {} })
  if (agentTools.length > 0) clauses.push({ key: 'agentTools', params: { read: readTools, write: writeTools } })
  if (clauses.length === 0) clauses.push({ key: 'noPermissions', params: {} })

  const projectWrites: DisclosureProjectWrites = !hasFs
    ? 'none'
    : scopes === null
      ? 'undeclared'
      : scopes.fs.write.length === 0
        ? 'none'
        : { root: scopes.fs.root, patterns: scopes.fs.write }

  return {
    schemaVersion: DISCLOSURE_SCHEMA_VERSION,
    plugin: { id: manifest.id, version: manifest.version, publisher: manifest.publisher },
    summary: { template: DISCLOSURE_SUMMARY_TEMPLATE, clauses },
    risk: { level: riskLevelForReasons(reasons), reasons },
    permissions: { system, shell, scopes },
    nativeBackend,
    network: shell ? 'via-shell' : 'none',
    agentTools,
    dataLocations: { hostStorage: true, backendDataDirectory: nativeBackend !== null, projectWrites },
  }
}

/**
 * The one spelling used to sign and to compare disclosures: the existing
 * canonicalJson rules (sorted keys, no whitespace, non-ASCII escaped), plus
 * numbers restricted to safe integers so both languages print them the same
 * way. Anything else throws a TypeError.
 */
export function canonicalContractJson(value: unknown): string {
  assertSafeIntegers(value)
  return canonicalJson(value)
}

function assertSafeIntegers(value: unknown): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`canonicalContractJson: ${value} is not a safe integer`)
  } else if (Array.isArray(value)) value.forEach(assertSafeIntegers)
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach(assertSafeIntegers)
}

/** The flat item list a diff compares, sorted by kind and then key. */
export function disclosureItems(disclosure: ManifestDisclosure): DisclosureItem[] {
  const items: DisclosureItem[] = []
  const add = (kind: DisclosureItemKind, key: string, detail: DisclosureItem['detail'] = null): void => {
    items.push({ kind, key, detail })
  }
  const { permissions } = disclosure
  for (const name of permissions.system) add('system', name)
  if (permissions.shell) {
    add('shell', permissions.shell.mode)
    for (const executable of permissions.shell.executables ?? []) add('shellExecutable', executable)
  }
  if (permissions.scopes) {
    add('fsScopeRoot', permissions.scopes.fs.root)
    for (const pattern of permissions.scopes.fs.read) add('fsScopeRead', pattern)
    for (const pattern of permissions.scopes.fs.write) add('fsScopeWrite', pattern)
  }
  if (disclosure.nativeBackend) {
    add('nativeBackend', 'native')
    for (const method of disclosure.nativeBackend.methods) add('backendMethod', method)
    for (const event of disclosure.nativeBackend.events) add('backendEvent', event)
  }
  if (disclosure.network !== 'none') add('network', disclosure.network)
  for (const { name, ...detail } of disclosure.agentTools) add('agentTool', name, detail)
  return items.sort((a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.key, b.key))
}

const FS_SCOPE_KINDS: ReadonlySet<DisclosureItemKind> = new Set(['fsScopeRoot', 'fsScopeRead', 'fsScopeWrite'])

export function isFsScopeItem(item: DisclosureItem): boolean {
  return FS_SCOPE_KINDS.has(item.kind)
}

/**
 * Whether going from the items `before` to `after` widens the declared file
 * scope. A scope is declared, never enforced: the fs capability reaches the
 * same files with or without one. So declaring a scope where there was none
 * claims less than the unscoped fs before it and does not widen. Dropping a
 * scope while fs stays, a new read or write pattern (including a path moving
 * from read to write) and a different root all claim more, and do.
 */
export function fsScopeChangeWidens(before: readonly DisclosureItem[], after: readonly DisclosureItem[]): boolean {
  const was = before.filter(isFsScopeItem)
  const now = after.filter(isFsScopeItem)
  if (was.length === 0) return false
  if (now.length === 0) return after.some((item) => item.kind === 'system' && item.key === 'fs')
  const had = new Set(was.map((item) => `${item.kind}\u0000${item.key}`))
  return now.some((item) => !had.has(`${item.kind}\u0000${item.key}`))
}

/** D2: what an update (or rollback) from `from` to `to` adds, removes and keeps. */
export function diffDisclosure(from: ManifestDisclosure, to: ManifestDisclosure): DisclosureDiff {
  const before = disclosureItems(from)
  const after = disclosureItems(to)
  const beforeKeys = new Set(before.map(canonicalContractJson))
  const afterKeys = new Set(after.map(canonicalContractJson))
  const added = after.filter((item) => !beforeKeys.has(canonicalContractJson(item)))
  return {
    schemaVersion: DISCLOSURE_SCHEMA_VERSION,
    from: { id: from.plugin.id, version: from.plugin.version, risk: from.risk.level },
    to: { id: to.plugin.id, version: to.plugin.version, risk: to.risk.level },
    added,
    removed: before.filter((item) => !afterKeys.has(canonicalContractJson(item))),
    unchanged: after.filter((item) => beforeKeys.has(canonicalContractJson(item))),
    widened:
      added.some((item) => !isFsScopeItem(item)) ||
      fsScopeChangeWidens(before, after) ||
      RISK_RANK[to.risk.level] > RISK_RANK[from.risk.level],
  }
}
