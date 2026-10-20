/**
 * Step-0 contract for the Registry's publish-time static scan (plan B, D-S).
 *
 * The Registry scans every published artifact and signs the scan report in
 * the disclosure envelope (`scanDigest`). The App cannot rerun the scan; it
 * checks the digest and derives the plain-language sentences, the scan risk
 * reasons and the declared-vs-scanned comparison from the report with the
 * pure functions below. The report holds facts only; everything a surface
 * shows is derived here, in the same way in both languages.
 *
 * Types and pure functions only. Normative text:
 * docs/en-US/plugin-agent-tools-contract.md sections 3.8 and 3.9. Python twin:
 * backend/agent_team_backend/plugins/disclosure_scan_contract.py.
 */

import { HOST_SHELL_ALLOWLIST, type DisclosureRiskLevel, type ManifestDisclosure } from './pluginDisclosure'

export const SCAN_SCHEMA_VERSION = 1
export const SCANNER_ID = 'navide-static-scan'

/** The 9 fields of the disclosure envelope, in documentation order (section 3.5). */
export const DISCLOSURE_ENVELOPE_FIELDS = [
  'schemaVersion', 'artifactDigest', 'packageId', 'version', 'target',
  'keyId', 'signedAt', 'disclosureDigest', 'scanDigest',
] as const

/** Output and work bounds of a v1 scanner (section 3.8). Exceeding one sets
 * `coverage.truncated` or `coverage.timedOut`; it never fails a publish. */
export const SCAN_LIMITS = {
  maxItemsPerKind: 100,
  maxPaths: 50,
  maxPathLength: 200,
  maxScriptBytes: 20 * 1024 * 1024,
  maxNativeBytes: 512 * 1024 * 1024,
  timeBudgetMs: 30_000,
} as const

/** `coverage.skipped` reasons that make a scan incomplete (section 3.8). */
export const INCOMPLETE_SKIP_REASONS = ['scannerError', 'tooComplex'] as const

export type ShellCategory = 'remoteWrite' | 'remoteRead' | 'localWrite' | 'local' | 'other' | 'unknownSubcommand'
export type ScanSource = 'frontend' | 'backend'

/** Shell categories in the order their sentences are listed. */
export const SHELL_CATEGORY_ORDER: readonly ShellCategory[] = [
  'remoteWrite', 'other', 'unknownSubcommand', 'remoteRead', 'localWrite', 'local',
]

const GIT: Record<'remoteWrite' | 'remoteRead' | 'localWrite' | 'local', ReadonlySet<string>> = {
  remoteWrite: new Set(['push', 'send-email', 'request-pull']),
  remoteRead: new Set(['fetch', 'pull', 'clone', 'ls-remote', 'submodule', 'remote']),
  localWrite: new Set([
    'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'config',
    'gc', 'init', 'merge', 'mv', 'notes', 'rebase', 'reset', 'restore', 'revert', 'rm',
    'stash', 'switch', 'tag', 'update-index', 'worktree',
  ]),
  local: new Set([
    'blame', 'cat-file', 'describe', 'diff', 'for-each-ref', 'grep', 'log', 'ls-files',
    'ls-tree', 'merge-base', 'name-rev', 'reflog', 'rev-list', 'rev-parse', 'shortlog',
    'show', 'show-ref', 'status', 'symbolic-ref', 'var', 'version',
  ]),
}
// gh and glab always talk to the forge; only their writes are told apart.
const FORGE_WRITE_ACTIONS = new Set([
  'create', 'edit', 'close', 'reopen', 'merge', 'delete', 'comment', 'review', 'ready',
  'lock', 'unlock', 'transfer', 'pin', 'unpin', 'upload', 'set', 'add', 'remove', 'rename',
  'archive', 'unarchive', 'fork', 'sync', 'approve', 'revoke', 'cancel', 'rerun', 'run',
  'enable', 'disable', 'note',
])
const FORGE_READ_ACTIONS = new Set([
  'list', 'view', 'status', 'diff', 'checks', 'download', 'search', 'browse', 'watch', 'ls',
])
const FORGE_LOCAL = new Set(['version', 'help', 'completion'])
const GH_API_WRITE_FLAGS = new Set(['-f', '-F', '--field', '--raw-field', '--input'])
const GH_API_METHOD_FLAGS = new Set(['-X', '--method'])
/** Options whose next argument is their value, not a subcommand. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const FORGE_VALUE_OPTIONS = new Set(['-R', '--repo', '--hostname'])
/** A subcommand is reported only when it looks like one; anything else (a
 * path, a URL, a value) is never echoed. */
const SUBCOMMAND_RE = /^[a-z][a-z0-9-]{0,39}$/

function positionals(args: readonly string[], valueOptions: ReadonlySet<string>): string[] {
  const out: string[] = []
  let skip = false
  for (const arg of args) {
    if (skip) skip = false
    else if (valueOptions.has(arg)) skip = true
    else if (!arg.startsWith('-')) out.push(arg)
  }
  return out
}

const word = (value: string | undefined): string | null =>
  value !== undefined && SUBCOMMAND_RE.test(value) ? value : null

export interface ShellCall {
  executable: string
  subcommand: string | null
  category: ShellCategory
  source: ScanSource
  evidence: 'callSite' | 'commandLikeString'
  files: number
}

export interface CodeSignals {
  eval: number
  newFunction: number
  dynamicImport: number
  stringTimers: number
  obfuscationSignals: string[]
}

export interface NativeSummary {
  path: string
  format: 'mach-o' | 'elf' | 'pe'
  arch: string
  libraries: string[]
  notableImports: string[]
  importCount: number
  packer: string | null
  embeddedRuntime: string | null
}

/** The signed facts of one artifact's scan (section 3.8). */
export interface ScanReport {
  schemaVersion: typeof SCAN_SCHEMA_VERSION
  scanner: { id: string; version: string }
  artifactDigest: string
  target: string
  scannedAt: string
  coverage: {
    filesTotal: number
    filesScanned: number
    bytesScanned: number
    skipped: Array<{ reason: string; count: number }>
    truncated: boolean
    timedOut: boolean
  }
  shell: { calls: ShellCall[]; dynamic: { count: number; files: number } }
  network: { hosts: Array<{ host: string; source: ScanSource; count: number }> }
  files: { readPaths: string[]; writePaths: string[]; dynamicPaths: number }
  capabilities: Array<{ address: string; source: ScanSource }>
  code: { frontend: CodeSignals | null; backend: CodeSignals | null }
  native: NativeSummary[]
}

export interface ScanSentence {
  key: string
  params: Record<string, unknown>
}

export interface ScanRiskReason {
  key: string
  level: DisclosureRiskLevel
}

export interface ScanItem {
  kind: string
  key: string
}

/** (subcommand, category) for one parsed invocation; `args` excludes the
 * executable. Executables outside the Host allowlist report no subcommand:
 * their arguments are never echoed. */
export function classifyShellCommand(executable: string, args: readonly string[]): [string | null, ShellCategory] {
  if (executable === 'git') {
    const words = positionals(args, GIT_VALUE_OPTIONS)
    if (!words.length) return [null, 'local']
    const sub = word(words[0])
    if (sub === null) return [null, 'unknownSubcommand']
    for (const category of ['remoteWrite', 'remoteRead', 'localWrite', 'local'] as const) {
      if (GIT[category].has(sub)) return [sub, category]
    }
    return [sub, 'unknownSubcommand']
  }
  if (executable === 'gh' || executable === 'glab') {
    const words = positionals(args, FORGE_VALUE_OPTIONS)
    if (!words.length) return [null, 'local']
    const sub = word(words[0])
    if (sub === null) return [null, 'unknownSubcommand']
    if (FORGE_LOCAL.has(sub)) return [sub, 'local']
    if (executable === 'gh' && sub === 'api') {
      let method = 'GET'
      args.forEach((arg, index) => {
        if (GH_API_METHOD_FLAGS.has(arg) && index + 1 < args.length) method = args[index + 1].toUpperCase()
        else if (arg.startsWith('--method=')) method = arg.slice('--method='.length).toUpperCase()
        else if (arg.startsWith('-X') && arg.length > 2) method = arg.slice(2).toUpperCase()
      })
      const writes = method !== 'GET' ||
        args.some((arg) => GH_API_WRITE_FLAGS.has(arg) || GH_API_WRITE_FLAGS.has(arg.split('=')[0]))
      return [sub, writes ? 'remoteWrite' : 'remoteRead']
    }
    const action = words.length > 1 ? word(words[1]) : null
    if (action !== null && FORGE_WRITE_ACTIONS.has(action)) return [`${sub} ${action}`, 'remoteWrite']
    if (action !== null && FORGE_READ_ACTIONS.has(action)) return [`${sub} ${action}`, 'remoteRead']
    return [action !== null ? `${sub} ${action}` : sub, 'unknownSubcommand']
  }
  if ((HOST_SHELL_ALLOWLIST as readonly string[]).includes(executable)) return [word(args[0]), 'unknownSubcommand']
  return [null, 'other']
}

const command = (call: ShellCall): string => (call.subcommand === null ? call.executable : `${call.executable} ${call.subcommand}`)

const codeCount = (signals: CodeSignals | null): number =>
  signals ? signals.eval + signals.newFunction + signals.dynamicImport + signals.stringTimers : 0

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(compareCodeUnits)

function incompleteReasons(scan: ScanReport): string[] {
  const reasons: string[] = []
  if (scan.coverage.timedOut) reasons.push('timedOut')
  if (scan.coverage.truncated) reasons.push('truncated')
  // A scanner failure on a file, or a structural ceiling it hit, means part of
  // the package was not scanned (DS2).
  for (const skipped of scan.coverage.skipped) {
    if ((INCOMPLETE_SKIP_REASONS as readonly string[]).includes(skipped.reason) && skipped.count) reasons.push(skipped.reason)
  }
  for (const source of ['frontend', 'backend'] as const) {
    if (scan.code[source]?.obfuscationSignals.length) reasons.push('obfuscated')
  }
  for (const binary of scan.native) {
    if (binary.packer !== null) reasons.push('packed')
    if (binary.embeddedRuntime !== null) reasons.push('embeddedRuntime')
  }
  return sortedUnique(reasons)
}

/** The ordered plain-language sentences of a report (section 3.8); i18n key
 * `pluginDisclosure.scan.<key>`. Absent kinds become `notFound.<kind>`, never
 * an empty list. */
export function scanSentences(scan: ScanReport): ScanSentence[] {
  const out: ScanSentence[] = []
  const calls = scan.shell.calls
  for (const category of SHELL_CATEGORY_ORDER) {
    const commands = sortedUnique(calls.filter((call) => call.category === category).map(command))
    if (commands.length) out.push({ key: `shell.${category}`, params: { commands } })
  }
  const dynamic = scan.shell.dynamic
  if (dynamic.count) out.push({ key: 'shell.dynamic', params: { count: dynamic.count } })
  const files = scan.files
  if (files.writePaths.length || files.dynamicPaths) {
    out.push({ key: 'files.write', params: { paths: files.writePaths, dynamic: files.dynamicPaths } })
  }
  if (files.readPaths.length) out.push({ key: 'files.read', params: { paths: files.readPaths } })
  const hosts = sortedUnique(scan.network.hosts.map((entry) => entry.host))
  if (hosts.length) out.push({ key: 'network.hosts', params: { hosts } })
  for (const source of ['frontend', 'backend'] as const) {
    const count = codeCount(scan.code[source])
    if (count) out.push({ key: `code.eval.${source}`, params: { count } })
  }
  const signals = sortedUnique([
    ...(scan.code.frontend?.obfuscationSignals ?? []),
    ...(scan.code.backend?.obfuscationSignals ?? []),
  ])
  if (signals.length) out.push({ key: 'code.obfuscated', params: { signals } })
  for (const binary of scan.native) {
    out.push({
      key: 'native.summary',
      params: { path: binary.path, format: binary.format, arch: binary.arch, libraries: binary.libraries },
    })
    const reason = binary.packer !== null ? 'packed' : binary.embeddedRuntime !== null ? 'embeddedRuntime' : null
    if (reason !== null) {
      out.push({
        key: 'native.unscannable',
        params: { path: binary.path, reason, detail: reason === 'packed' ? binary.packer : binary.embeddedRuntime },
      })
    }
  }
  const incomplete = incompleteReasons(scan)
  if (incomplete.length) out.push({ key: 'coverage.incomplete', params: { reasons: incomplete } })
  if (!calls.length && !dynamic.count) out.push({ key: 'notFound.shell', params: {} })
  if (!hosts.length) out.push({ key: 'notFound.network', params: {} })
  if (!(files.writePaths.length || files.readPaths.length || files.dynamicPaths)) out.push({ key: 'notFound.files', params: {} })
  if (!(codeCount(scan.code.frontend) || codeCount(scan.code.backend))) out.push({ key: 'notFound.dynamicCode', params: {} })
  out.push({
    key: 'coverage',
    params: {
      scannerVersion: scan.scanner.version,
      scannedAt: scan.scannedAt,
      filesScanned: scan.coverage.filesScanned,
      filesTotal: scan.coverage.filesTotal,
    },
  })
  return out
}

/** Scan reasons with their level, in the order they are listed (section 3.8). */
export const SCAN_RISK_RULES: ReadonlyArray<readonly [string, DisclosureRiskLevel]> = [
  ['scan.shell.remoteWrite', 'highest'],
  ['scan.shell.other', 'highest'],
  ['scan.shell.dynamic', 'high'], // highest when the manifest declares shell "full"
  ['scan.shell.remoteRead', 'high'],
  ['scan.shell.localWrite', 'high'],
  ['scan.shell.unknownSubcommand', 'high'],
  ['scan.code.eval.backend', 'high'],
  ['scan.incomplete', 'high'],
]

export function scanRiskReasons(scan: ScanReport, disclosure: ManifestDisclosure): ScanRiskReason[] {
  const categories = new Set(scan.shell.calls.map((call) => call.category as string))
  const shell = disclosure.permissions.shell
  const out: ScanRiskReason[] = []
  for (const [key, base] of SCAN_RISK_RULES) {
    let level = base
    let applies = false
    if (key === 'scan.shell.dynamic') {
      applies = scan.shell.dynamic.count > 0 && shell !== null
      if (applies && shell!.mode === 'full') level = 'highest'
    } else if (key.startsWith('scan.shell.')) {
      applies = categories.has(key.slice('scan.shell.'.length))
    } else if (key === 'scan.code.eval.backend') {
      applies = codeCount(scan.code.backend) > 0
    } else if (key === 'scan.incomplete') {
      applies = incompleteReasons(scan).length > 0
    }
    if (applies) out.push({ key, level })
  }
  return out
}

const RANK: Record<DisclosureRiskLevel, number> = { low: 0, medium: 1, high: 2, highest: 3 }

/** The level every surface shows: the manifest level raised by the scan reasons. */
export function cardRiskLevel(disclosure: ManifestDisclosure, scan: ScanReport | null): DisclosureRiskLevel {
  let level = disclosure.risk.level
  for (const reason of scan ? scanRiskReasons(scan, disclosure) : []) {
    if (RANK[reason.level] > RANK[level]) level = reason.level
  }
  return level
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

/** Section 3.9 glob: `**` is zero or more whole segments, `*` any run of
 * characters inside one segment; everything else is literal. */
export function scopePatternMatches(pattern: string, path: string): boolean {
  const segments = pattern.split('/')
  const parts = segments.map((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') return last ? '(?:[^/]+(?:/[^/]+)*)?' : '(?:[^/]+/)*'
    return segment.split('*').map(escapeRegExp).join('[^/]*') + (last ? '' : '/')
  })
  return new RegExp(`^${parts.join('')}$`).test(path)
}

const listed = (items: Set<string>): ScanItem[] =>
  [...items]
    .map((joined) => {
      const [kind, key] = JSON.parse(joined) as [string, string]
      return { kind, key }
    })
    .sort((a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.key, b.key))

/** Section 3.9: what the scan found that the manifest does not declare
 * (`undeclared`, shown first and in red) and what the manifest declares that
 * the scan did not find (`declaredNotSeen`, shown in grey). */
export function declaredVsScanned(
  disclosure: ManifestDisclosure,
  scan: ScanReport
): { undeclared: ScanItem[]; declaredNotSeen: ScanItem[] } {
  const { system, shell, scopes } = disclosure.permissions
  const declared = new Set<string>(system)
  const undeclared = new Set<string>()
  const add = (set: Set<string>, kind: string, key: string): void => {
    set.add(JSON.stringify([kind, key]))
  }
  const calls = scan.shell.calls
  for (const call of calls) {
    if (shell === null) add(undeclared, 'shell', command(call))
    else if (shell.mode === 'allowlist' && !(shell.executables ?? []).includes(call.executable)) {
      add(undeclared, 'shellExecutable', call.executable)
    }
  }
  if (shell === null && scan.shell.dynamic.count) add(undeclared, 'shellDynamic', 'dynamic')
  const namespaces = new Set(scan.capabilities.map((entry) => entry.address.split('.')[0]))
  if (shell === null && namespaces.has('shell')) add(undeclared, 'shell', 'shell.run')
  for (const namespace of ['aiCli', 'fs', 'ui', 'web']) {
    if (namespaces.has(namespace) && !declared.has(namespace)) add(undeclared, 'system', namespace)
  }
  const files = scan.files
  if ((files.readPaths.length || files.writePaths.length) && !declared.has('fs')) add(undeclared, 'system', 'fs')
  if (scopes !== null && declared.has('fs')) {
    const writePatterns = scopes.fs.write
    const readPatterns = [...scopes.fs.read, ...scopes.fs.write]
    for (const path of files.writePaths) {
      if (!writePatterns.some((pattern) => scopePatternMatches(pattern, path))) add(undeclared, 'fsScopeWrite', path)
    }
    for (const path of files.readPaths) {
      if (!readPatterns.some((pattern) => scopePatternMatches(pattern, path))) add(undeclared, 'fsScopeRead', path)
    }
  }
  const notSeen = new Set<string>()
  if (shell !== null && !calls.length && !scan.shell.dynamic.count && !namespaces.has('shell')) {
    add(notSeen, 'shell', shell.mode)
  }
  for (const namespace of system) {
    const seen = namespaces.has(namespace) ||
      (namespace === 'fs' && Boolean(files.readPaths.length || files.writePaths.length || files.dynamicPaths))
    if (!seen) add(notSeen, 'system', namespace)
  }
  return { undeclared: listed(undeclared), declaredNotSeen: listed(notSeen) }
}

/** Section 3.6: the flat scan items an update diff compares. */
export function scanItems(scan: ScanReport | null): ScanItem[] {
  if (scan === null) return []
  const items = new Set<string>()
  const add = (kind: string, key: string): void => {
    items.add(JSON.stringify([kind, key]))
  }
  for (const call of scan.shell.calls) add('scanShell', command(call))
  if (scan.shell.dynamic.count) add('scanShellDynamic', 'dynamic')
  for (const entry of scan.network.hosts) add('scanHost', entry.host)
  for (const path of scan.files.writePaths) add('scanWritePath', path)
  for (const path of scan.files.readPaths) add('scanReadPath', path)
  for (const entry of scan.capabilities) add('scanCapability', entry.address)
  for (const source of ['frontend', 'backend'] as const) {
    if (codeCount(scan.code[source])) add('scanDynamicCode', source)
  }
  return listed(items)
}

/** Scan half of the D2 diff: `widened` when the newer scan found anything new. */
export function diffScan(
  from: ScanReport | null,
  to: ScanReport | null
): { added: ScanItem[]; removed: ScanItem[]; widened: boolean } {
  const key = (item: ScanItem): string => JSON.stringify([item.kind, item.key])
  const before = new Set(scanItems(from).map(key))
  const after = scanItems(to)
  const afterKeys = new Set(after.map(key))
  const added = after.filter((item) => !before.has(key(item)))
  const removed = scanItems(from).filter((item) => !afterKeys.has(key(item)))
  return { added, removed, widened: added.length > 0 }
}
