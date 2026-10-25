/**
 * The Host side of `marketplace.query` (plan B, B2-a; contract section 4.3).
 *
 * The backend's read-only Marketplace MCP tools ask the Host over its
 * authenticated session. The Host answers from the same functions the
 * Marketplace page uses (`plugins:marketplaceSearch`, `plugins:marketplaceDetail`,
 * `plugins:listInstalled` in pluginIpc.ts); this module only checks the query
 * and maps those answers onto the contract shapes. It decides nothing about
 * trust: install still goes through prepareInstall and the user's consent.
 *
 * A card is built from a row's `disclosure` (the manifest disclosure), `scan`
 * and `registry`, read the same way from a search row and from the selected
 * detail version row (D-b brings them through `plugins:marketplaceDetail`),
 * and only when the disclosure names that row's package and version. Its
 * risk is cardRiskLevel(manifest, scan) (contract 3.3). When the disclosure
 * is missing or anything is malformed, risk, summary and card are null:
 * nothing here invents one.
 */
import type {
  LocalPackageQueryReport,
  MarketplaceInstalledItem,
  MarketplaceListingItem,
  MarketplaceQueryResponse,
} from '../../shared/pluginAgentTools'
import { AGENT_TOOL_NAME_PATTERN } from '../../shared/pluginAgentTools'
import {
  DISCLOSURE_RISK_RULES,
  DISCLOSURE_SUMMARY_TEMPLATE,
  HOST_SHELL_ALLOWLIST,
  type DisclosureAgentTool,
  type DisclosureCard,
  type DisclosurePermissions,
  type DisclosureProjectWrites,
  type DisclosureRiskLevel,
  type DisclosureSummary,
  type DisclosureSummaryClause,
  type ManifestDisclosure,
  type RegistryDisclosureFacts,
} from '../../shared/pluginDisclosure'
import {
  cardRiskLevel,
  SCAN_SCHEMA_VERSION,
  type CodeSignals,
  type NativeSummary,
  type ScanReport,
  type ScanSource,
  type ShellCall,
  type ShellCategory,
} from '../../shared/pluginDisclosureScan'
import { compareSemver, isValidManifestV2PluginId } from './pluginManifestV2'

/** A ListingItem whose disclosure may be missing (null) until the Registry provides one. */
export type MarketplaceQueryListingItem = Omit<MarketplaceListingItem, 'risk' | 'summary'> & {
  risk: MarketplaceListingItem['risk'] | null
  summary: MarketplaceListingItem['summary'] | null
}

export type MarketplaceQueryResult =
  | { kind: 'search'; items: MarketplaceQueryListingItem[]; nextCursor: string | null }
  | { kind: 'detail'; item: MarketplaceQueryListingItem; versions: string[]; card: DisclosureCard | null }
  | { kind: 'installed'; items: MarketplaceInstalledItem[] }
  | { kind: 'localValidate' | 'localPackage' | 'localStage'; report: LocalPackageQueryReport }

type ErrorCode = Extract<MarketplaceQueryResponse, { ok: false }>['error_code']

/** `marketplace.query.result` without its request_id. */
export type MarketplaceQueryAnswer =
  | { ok: true; result: MarketplaceQueryResult }
  | { ok: false; error: string; error_code: ErrorCode }

/** Thrown by the Marketplace fetches with the Registry's HTTP status; the message is unchanged. */
export class MarketplaceHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'MarketplaceHttpError'
  }
}

export interface MarketplaceQuerySources {
  search(
    text: string,
    options: { category?: string; offset?: number; limit: number },
  ): Promise<{ items?: Array<Record<string, unknown>>; total?: unknown }>
  detail(namespace: string, name: string): Promise<Record<string, unknown>>
  installed(): Array<{
    id: string
    packageVersion?: string
    disabled?: boolean
    hasBackend?: boolean
    source?: string
    signatureRevoked?: boolean
  }>
  /** W1: absent, the local package kinds answer HOST_UNAVAILABLE. */
  localValidate?(path: string): Promise<LocalPackageQueryReport>
  localPackage?(path: string, options: { target?: string; out?: string }): Promise<LocalPackageQueryReport>
  localStage?(path: string): Promise<LocalPackageQueryReport>
}

const DEFAULT_LIMIT = 20
const RISK_LEVELS: readonly DisclosureRiskLevel[] = ['low', 'medium', 'high', 'highest']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function bad(error: string): MarketplaceQueryAnswer {
  return { ok: false, error, error_code: 'BAD_REQUEST' }
}

// The agent sees only what is rebuilt below from validated fields: every
// enum is checked against the contract's union, ids against the package-id
// grammar, versions against SemVer, and every key the contract does not
// name is dropped. Free text (publisher names, patterns, method names, tool
// texts) is kept as a string; the backend fences it before an agent sees it.

const isSemver = (value: unknown): value is string =>
  typeof value === 'string' && compareSemver(value, value) === 0
const isSafeCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...value] as string[] : null
const nullableString = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' ? value : undefined
const isEmptyParams = (value: unknown): boolean => isRecord(value) && Object.keys(value).length === 0
const REASON_LEVELS = new Map<string, DisclosureRiskLevel>(DISCLOSURE_RISK_RULES.map(([key, level]) => [key, level]))
const SHELL_EXECUTABLES = new Set<string>(HOST_SHELL_ALLOWLIST)

function shellParams(value: unknown): DisclosurePermissions['shell'] | undefined {
  if (!isRecord(value)) return undefined
  if (value.mode === 'full' && value.executables === null) return { mode: 'full', executables: null }
  const executables = strings(value.executables)
  if (value.mode === 'allowlist' && executables && executables.every((name) => SHELL_EXECUTABLES.has(name))) {
    return { mode: 'allowlist', executables }
  }
  return undefined
}

function summaryClause(value: unknown): DisclosureSummaryClause | null {
  if (!isRecord(value)) return null
  const params = value.params
  switch (value.key) {
    case 'nativeBackend': case 'aiCli': case 'ui': case 'web': case 'agents': case 'agentMessages': case 'network': case 'networkViaShell': case 'noPermissions':
      return isEmptyParams(params) ? { key: value.key, params: {} } : null
    case 'files':
      return isRecord(params) && (params.access === 'read' || params.access === 'readWrite')
        ? { key: 'files', params: { access: params.access } }
        : null
    case 'shell': {
      const shell = shellParams(params)
      return shell ? { key: 'shell', params: shell } : null
    }
    case 'agentTools':
      return isRecord(params) && isSafeCount(params.read) && isSafeCount(params.write)
        ? { key: 'agentTools', params: { read: params.read, write: params.write } }
        : null
    default:
      return null
  }
}

function disclosureSummary(value: unknown): DisclosureSummary | null {
  if (!isRecord(value) || value.template !== DISCLOSURE_SUMMARY_TEMPLATE || !Array.isArray(value.clauses)) return null
  const clauses = value.clauses.map(summaryClause)
  return clauses.every((clause) => clause !== null)
    ? { template: DISCLOSURE_SUMMARY_TEMPLATE, clauses: clauses as DisclosureSummaryClause[] }
    : null
}

function riskBlock(value: unknown): ManifestDisclosure['risk'] | null {
  if (!isRecord(value) || !RISK_LEVELS.includes(value.level as DisclosureRiskLevel) || !Array.isArray(value.reasons)) {
    return null
  }
  const reasons: ManifestDisclosure['risk']['reasons'] = []
  for (const reason of value.reasons) {
    if (!isRecord(reason) || typeof reason.key !== 'string') return null
    const level = REASON_LEVELS.get(reason.key)
    if (!level || reason.level !== level) return null
    reasons.push({ key: reason.key as ManifestDisclosure['risk']['reasons'][number]['key'], level })
  }
  return { level: value.level as DisclosureRiskLevel, reasons }
}

function permissionsBlock(value: unknown): DisclosurePermissions | null {
  if (!isRecord(value)) return null
  const system = strings(value.system)
  if (!system || !system.every((name) => name === 'aiCli' || name === 'fs' || name === 'ui' || name === 'web' ||
    name === 'agents' || name === 'agentMessages')) return null
  const shell = value.shell === null ? null : shellParams(value.shell)
  if (shell === undefined) return null
  let scopes: DisclosurePermissions['scopes'] = null
  if (value.scopes !== null) {
    const fs = isRecord(value.scopes) ? value.scopes.fs : undefined
    const read = isRecord(fs) ? strings(fs.read) : null
    const write = isRecord(fs) ? strings(fs.write) : null
    if (!isRecord(fs) || (fs.root !== 'workspace' && fs.root !== 'repository') || !read || !write) return null
    scopes = { fs: { root: fs.root, read, write } }
  }
  return { system: system as DisclosurePermissions['system'], shell, scopes }
}

function agentToolEntry(value: unknown): DisclosureAgentTool | null {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' || !AGENT_TOOL_NAME_PATTERN.test(value.name) ||
    typeof value.method !== 'string' ||
    (value.risk !== 'read' && value.risk !== 'write') ||
    typeof value.title !== 'string' || typeof value.description !== 'string' ||
    !isSafeCount(value.timeoutMs) || !isRecord(value.inputSchema)
  ) return null
  return {
    name: value.name,
    method: value.method,
    risk: value.risk,
    title: value.title,
    description: value.description,
    timeoutMs: value.timeoutMs,
    inputSchema: value.inputSchema,
  }
}

function projectWrites(value: unknown): DisclosureProjectWrites | null {
  if (value === 'none' || value === 'undeclared') return value
  const patterns = isRecord(value) ? strings(value.patterns) : null
  return isRecord(value) && (value.root === 'workspace' || value.root === 'repository') && patterns
    ? { root: value.root, patterns }
    : null
}

function manifestDisclosure(value: unknown): ManifestDisclosure | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || (value.network !== 'none' && value.network !== 'via-shell')) {
    return null
  }
  const plugin = value.plugin
  if (
    !isRecord(plugin) || !isValidManifestV2PluginId(plugin.id) || !isSemver(plugin.version) ||
    typeof plugin.publisher !== 'string'
  ) return null
  const summary = disclosureSummary(value.summary)
  const risk = riskBlock(value.risk)
  const permissions = permissionsBlock(value.permissions)
  let nativeBackend: ManifestDisclosure['nativeBackend'] = null
  if (value.nativeBackend !== null) {
    const methods = isRecord(value.nativeBackend) ? strings(value.nativeBackend.methods) : null
    const events = isRecord(value.nativeBackend) ? strings(value.nativeBackend.events) : null
    if (!methods || !events) return null
    nativeBackend = { methods, events }
  }
  const tools = Array.isArray(value.agentTools) ? value.agentTools.map(agentToolEntry) : null
  const locations = value.dataLocations
  const writes = isRecord(locations) ? projectWrites(locations.projectWrites) : null
  if (
    !summary || !risk || !permissions || !tools || tools.some((tool) => tool === null) ||
    !isRecord(locations) || locations.hostStorage !== true || typeof locations.backendDataDirectory !== 'boolean' ||
    writes === null
  ) return null
  return {
    schemaVersion: 1,
    plugin: { id: plugin.id, version: plugin.version, publisher: plugin.publisher },
    summary,
    risk,
    permissions,
    nativeBackend,
    network: value.network,
    agentTools: tools as DisclosureAgentTool[],
    dataLocations: { hostStorage: true, backendDataDirectory: locations.backendDataDirectory, projectWrites: writes },
  }
}

function registryFacts(value: unknown): RegistryDisclosureFacts | null {
  if (!isRecord(value)) return null
  const { publisher, signature, review, scan } = value
  if (!isRecord(publisher) || !isRecord(signature) || !isRecord(review) || !isRecord(scan)) return null
  const verifiedDomain = nullableString(publisher.verifiedDomain)
  const domainVerifiedAt = nullableString(publisher.domainVerifiedAt)
  const keyId = nullableString(signature.keyId)
  const reviewedAt = nullableString(review.reviewedAt)
  const similarTo = nullableString(scan.similarTo)
  const scannedAt = nullableString(scan.scannedAt)
  const statuses = ['approved', 'pending', 'rejected', 'not-required']
  const scans = ['clean', 'findings', 'not-run']
  if (
    typeof publisher.name !== 'string' || verifiedDomain === undefined || domainVerifiedAt === undefined ||
    typeof signature.signed !== 'boolean' || keyId === undefined ||
    !statuses.includes(review.status as string) || reviewedAt === undefined ||
    (review.nativeCodeInspected !== null && typeof review.nativeCodeInspected !== 'boolean') ||
    !scans.includes(scan.secretScan as string) || !isSafeCount(scan.secretFindings) ||
    typeof scan.similarityWarning !== 'boolean' || similarTo === undefined || scannedAt === undefined
  ) return null
  return {
    publisher: { name: publisher.name, verifiedDomain, domainVerifiedAt },
    signature: { signed: signature.signed, keyId },
    review: {
      status: review.status as RegistryDisclosureFacts['review']['status'],
      reviewedAt,
      nativeCodeInspected: review.nativeCodeInspected as boolean | null,
    },
    scan: {
      secretScan: scan.secretScan as RegistryDisclosureFacts['scan']['secretScan'],
      secretFindings: scan.secretFindings,
      similarityWarning: scan.similarityWarning,
      similarTo,
      scannedAt,
    },
  }
}

const SCAN_SOURCES: readonly ScanSource[] = ['frontend', 'backend']
const SHELL_CATEGORIES: readonly ShellCategory[] = [
  'remoteWrite', 'remoteRead', 'localWrite', 'local', 'other', 'unknownSubcommand',
]
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)

/** Each entry rebuilt by `build`, or null when the value is not an array or any entry is malformed. */
function entries<T>(value: unknown, build: (entry: Record<string, unknown>) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const out: T[] = []
  for (const entry of value) {
    const built = isRecord(entry) ? build(entry) : null
    if (built === null) return null
    out.push(built)
  }
  return out
}

function codeSignals(value: unknown): CodeSignals | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const obfuscationSignals = strings(value.obfuscationSignals)
  if (
    !isSafeCount(value.eval) || !isSafeCount(value.newFunction) || !isSafeCount(value.dynamicImport) ||
    !isSafeCount(value.stringTimers) || !obfuscationSignals
  ) return undefined
  return {
    eval: value.eval,
    newFunction: value.newFunction,
    dynamicImport: value.dynamicImport,
    stringTimers: value.stringTimers,
    obfuscationSignals,
  }
}

/** The Registry's scan report (contract 3.8) rebuilt from validated fields, or null when malformed. */
export function scanReport(value: unknown): ScanReport | null {
  if (!isRecord(value) || value.schemaVersion !== SCAN_SCHEMA_VERSION) return null
  const { scanner, coverage, shell, network, files, code } = value
  if (
    !isRecord(scanner) || typeof scanner.id !== 'string' || typeof scanner.version !== 'string' ||
    typeof value.artifactDigest !== 'string' || typeof value.target !== 'string' ||
    typeof value.scannedAt !== 'string' || !isRecord(coverage) || !isRecord(shell) ||
    !isRecord(shell.dynamic) || !isRecord(network) || !isRecord(files) || !isRecord(code)
  ) return null
  const skipped = entries(coverage.skipped, (entry) =>
    typeof entry.reason === 'string' && isSafeCount(entry.count) ? { reason: entry.reason, count: entry.count } : null)
  const calls = entries(shell.calls, (entry): ShellCall | null =>
    typeof entry.executable === 'string' && nullableString(entry.subcommand) !== undefined &&
    isOneOf(SHELL_CATEGORIES, entry.category) && isOneOf(SCAN_SOURCES, entry.source) &&
    isOneOf(['callSite', 'commandLikeString'] as const, entry.evidence) && isSafeCount(entry.files)
      ? {
          executable: entry.executable,
          subcommand: entry.subcommand as string | null,
          category: entry.category,
          source: entry.source,
          evidence: entry.evidence,
          files: entry.files,
        }
      : null)
  const hosts = entries(network.hosts, (entry) =>
    typeof entry.host === 'string' && isOneOf(SCAN_SOURCES, entry.source) && isSafeCount(entry.count)
      ? { host: entry.host, source: entry.source, count: entry.count }
      : null)
  const capabilities = entries(value.capabilities, (entry) =>
    typeof entry.address === 'string' && isOneOf(SCAN_SOURCES, entry.source)
      ? { address: entry.address, source: entry.source }
      : null)
  const native = entries(value.native, (entry): NativeSummary | null => {
    const libraries = strings(entry.libraries)
    const notableImports = strings(entry.notableImports)
    const packer = nullableString(entry.packer)
    const embeddedRuntime = nullableString(entry.embeddedRuntime)
    return typeof entry.path === 'string' && isOneOf(['mach-o', 'elf', 'pe'] as const, entry.format) &&
      typeof entry.arch === 'string' && libraries && notableImports && isSafeCount(entry.importCount) &&
      packer !== undefined && embeddedRuntime !== undefined
      ? { path: entry.path, format: entry.format, arch: entry.arch, libraries, notableImports, importCount: entry.importCount, packer, embeddedRuntime }
      : null
  })
  const readPaths = strings(files.readPaths)
  const writePaths = strings(files.writePaths)
  const frontend = codeSignals(code.frontend)
  const backend = codeSignals(code.backend)
  if (
    !isSafeCount(coverage.filesTotal) || !isSafeCount(coverage.filesScanned) || !isSafeCount(coverage.bytesScanned) ||
    !skipped || typeof coverage.truncated !== 'boolean' || typeof coverage.timedOut !== 'boolean' ||
    !calls || !isSafeCount(shell.dynamic.count) || !isSafeCount(shell.dynamic.files) || !hosts ||
    !readPaths || !writePaths || !isSafeCount(files.dynamicPaths) || !capabilities ||
    frontend === undefined || backend === undefined || !native
  ) return null
  return {
    schemaVersion: SCAN_SCHEMA_VERSION,
    scanner: { id: scanner.id, version: scanner.version },
    artifactDigest: value.artifactDigest,
    target: value.target,
    scannedAt: value.scannedAt,
    coverage: {
      filesTotal: coverage.filesTotal,
      filesScanned: coverage.filesScanned,
      bytesScanned: coverage.bytesScanned,
      skipped,
      truncated: coverage.truncated,
      timedOut: coverage.timedOut,
    },
    shell: { calls, dynamic: { count: shell.dynamic.count, files: shell.dynamic.files } },
    network: { hosts },
    files: { readPaths, writePaths, dynamicPaths: files.dynamicPaths },
    capabilities,
    code: { frontend, backend },
    native,
  }
}

/** The Registry's DisclosureCard rebuilt from validated fields, or null when it is absent or malformed. */
function disclosureCard(value: unknown): DisclosureCard | null {
  if (!isRecord(value)) return null
  const manifest = manifestDisclosure(value.manifest)
  if (!manifest) return null
  const scan = value.scan === null || value.scan === undefined ? null : scanReport(value.scan)
  if (scan === null && value.scan !== null && value.scan !== undefined) return null
  const registry = value.registry === null || value.registry === undefined ? null : registryFacts(value.registry)
  if (registry === null && value.registry !== null && value.registry !== undefined) return null
  return { manifest, scan, registry }
}

/** A version row's DisclosureCard rebuilt from validated fields: `disclosure`
 *  (the manifest disclosure), `scan` and `registry`, the same for a search row
 *  and a detail version row (review L1 on #345). Null when the disclosure is
 *  absent, anything is malformed, or the disclosure names another package or
 *  version than the row it came with. */
export function rowCard(row: Record<string, unknown>, id: string, version: string): DisclosureCard | null {
  const card = disclosureCard({ manifest: row.disclosure, scan: row.scan, registry: row.registry })
  return card && card.manifest.plugin.id === id && card.manifest.plugin.version === version ? card : null
}

function listingItem(
  raw: Record<string, unknown>,
  version: string,
  signed: boolean,
  publisher: string,
  card: DisclosureCard | null,
): MarketplaceQueryListingItem | null {
  const namespace = text(raw.namespace)
  const name = text(raw.name)
  const id = `${namespace}.${name}`
  if (!isValidManifestV2PluginId(id)) return null
  return {
    id,
    version: isSemver(version) ? version : '',
    name: text(raw.display_name) || name,
    description: text(raw.description),
    publisher: { name: publisher, verifiedDomain: card?.registry?.publisher.verifiedDomain ?? null },
    signed,
    downloads: typeof raw.download_count === 'number' ? raw.download_count : 0,
    // Contract 3.3: every surface shows the level with the scan's reasons.
    risk: card ? cardRiskLevel(card.manifest, card.scan) : null,
    summary: card ? card.manifest.summary : null,
  }
}

function registryFailure(error: unknown, notFound: boolean): MarketplaceQueryAnswer {
  const message = error instanceof Error ? error.message : String(error)
  if (notFound && error instanceof MarketplaceHttpError && error.status === 404) {
    return { ok: false, error: message, error_code: 'NOT_FOUND' }
  }
  return { ok: false, error: message, error_code: 'REGISTRY_UNAVAILABLE' }
}

/** Answer one `marketplace.query` from the Marketplace page's own functions. */
export async function answerMarketplaceQuery(
  query: unknown,
  sources: MarketplaceQuerySources,
): Promise<MarketplaceQueryAnswer> {
  if (!isRecord(query)) return bad('query must be an object')
  if (query.kind === 'installed') {
    if (Object.keys(query).length !== 1) return bad('an installed query has no fields')
    const items = sources.installed().map((summary): MarketplaceInstalledItem => ({
      id: summary.id,
      version: summary.packageVersion ?? '',
      enabled: summary.disabled !== true,
      // A package that fails trust verification is unloaded from the
      // inventory, so a listed package is never in quarantine.
      quarantined: false,
      hasBackend: summary.hasBackend === true,
      // No package can declare agent tools before B1 accepts the field.
      agentTools: [],
      ...(summary.source ? { source: summary.source } : {}),
      ...(summary.signatureRevoked ? { signatureRevoked: true } : {}),
    }))
    return { ok: true, result: { kind: 'installed', items } }
  }
  if (query.kind === 'localValidate' || query.kind === 'localPackage' || query.kind === 'localStage') {
    const allowed = new Set(query.kind === 'localPackage' ? ['kind', 'path', 'target', 'out'] : ['kind', 'path'])
    if (Object.keys(query).some((key) => !allowed.has(key))) return bad(`unknown ${query.kind} field`)
    if (typeof query.path !== 'string' || !query.path) return bad('path must be an absolute path')
    for (const key of ['target', 'out'] as const) {
      if (query[key] !== undefined && typeof query[key] !== 'string') return bad(`${key} must be a string`)
    }
    const run = query.kind === 'localValidate'
      ? sources.localValidate?.bind(sources, query.path)
      : query.kind === 'localStage'
      ? sources.localStage?.bind(sources, query.path)
      : sources.localPackage?.bind(sources, query.path, {
          ...(typeof query.target === 'string' ? { target: query.target } : {}),
          ...(typeof query.out === 'string' ? { out: query.out } : {}),
        })
    if (!run) return { ok: false, error: 'Navide Host cannot check local packages now', error_code: 'HOST_UNAVAILABLE' }
    try {
      return { ok: true, result: { kind: query.kind, report: await run() } }
    } catch (error) {
      // A path the Host cannot use (missing, not absolute, a protected folder).
      // Not BAD_REQUEST: that code is reserved for this file's own literals,
      // and this text may quote a file name, so the backend fences it.
      return { ok: false, error: error instanceof Error ? error.message : String(error), error_code: 'NOT_FOUND' }
    }
  }
  if (query.kind === 'search') {
    const allowed = new Set(['kind', 'text', 'category', 'cursor', 'limit'])
    if (Object.keys(query).some((key) => !allowed.has(key))) return bad('unknown search field')
    if (typeof query.text !== 'string') return bad('text must be a string')
    if (query.category !== undefined && query.category !== null && typeof query.category !== 'string') {
      return bad('category must be a string')
    }
    let offset = 0
    if (query.cursor !== undefined && query.cursor !== null) {
      if (typeof query.cursor !== 'string' || !/^(0|[1-9][0-9]{0,8})$/.test(query.cursor)) {
        return bad('cursor must be a nextCursor of a previous page')
      }
      offset = Number(query.cursor)
    }
    const limit = query.limit ?? DEFAULT_LIMIT
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
      return bad('limit must be an integer from 1 to 100')
    }
    let body: Awaited<ReturnType<MarketplaceQuerySources['search']>>
    try {
      body = await sources.search(query.text, {
        ...(typeof query.category === 'string' && query.category ? { category: query.category } : {}),
        ...(offset > 0 ? { offset } : {}),
        limit: limit as number,
      })
    } catch (error) {
      return registryFailure(error, false)
    }
    // The agent's own limit is honored even when the Registry sends more.
    const rows = (body.items ?? []).filter(isRecord).slice(0, limit as number)
    const items = rows
      .map((row) =>
        listingItem(
          row, text(row.latest_version), row.trust_tier === 'signed-verified',
          text(row.publisher) || text(row.namespace),
          rowCard(row, `${text(row.namespace)}.${text(row.name)}`, text(row.latest_version)),
        ))
      .filter((item): item is MarketplaceQueryListingItem => item !== null)
    const next = offset + rows.length
    const nextCursor = typeof body.total === 'number' && rows.length > 0 && next < body.total ? String(next) : null
    return { ok: true, result: { kind: 'search', items, nextCursor } }
  }
  if (query.kind === 'detail') {
    if (Object.keys(query).some((key) => !['kind', 'id', 'version'].includes(key))) return bad('unknown detail field')
    const id = query.id
    const dot = typeof id === 'string' ? id.indexOf('.') : -1
    if (typeof id !== 'string' || dot <= 0 || dot === id.length - 1) return bad('id must be <namespace>.<name>')
    if (query.version !== undefined && query.version !== null && typeof query.version !== 'string') {
      return bad('version must be a string')
    }
    let detail: Record<string, unknown>
    try {
      detail = await sources.detail(id.slice(0, dot), id.slice(dot + 1))
    } catch (error) {
      return registryFailure(error, true)
    }
    const rows = (Array.isArray(detail.versions) ? detail.versions : []).filter(isRecord)
    const published = rows.filter((row) => row.yanked !== true && typeof row.version === 'string')
    const versions = [...new Set(published.map((row) => row.version as string).filter(isSemver))]
    const wanted = typeof query.version === 'string' && query.version ? query.version : text(detail.latest_version)
    if (typeof query.version === 'string' && query.version && !versions.includes(wanted)) {
      return { ok: false, error: `${id} has no published version ${wanted}`, error_code: 'NOT_FOUND' }
    }
    const signed = published.some((row) => row.version === wanted && row.trust_tier === 'signed-verified')
    // D-b: each version row carries its manifest disclosure, scan report and
    // the Registry facts. A card that names another package or version is not this one's.
    const card = published
      .filter((row) => row.version === wanted)
      .map((row) => rowCard(row, id, wanted))
      .find((entry) => entry !== null) ?? null
    const item = listingItem(detail, wanted, signed, text(detail.publisher) || text(detail.namespace), card)
    if (!item) return { ok: false, error: `${id} is not a valid Navide plugin id`, error_code: 'NOT_FOUND' }
    return { ok: true, result: { kind: 'detail', item, versions, card } }
  }
  return bad('query.kind must be search, detail or installed')
}
