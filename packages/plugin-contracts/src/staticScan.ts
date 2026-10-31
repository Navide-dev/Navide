/**
 * The publish-time static scan (contract 3.8) in JavaScript, for the
 * `navide-plugin scan` CLI and for the App's local-install card.
 *
 * A port of the Registry's scanner (marketplace/registry/registry/static_scan,
 * the secret rules of registry/secret_scan.py): the same tokens, rules, bounds
 * and report. Both are held to docs/plugin-contracts/static-scan-fixtures/,
 * so a report built here equals the one the Registry signs except for
 * `scannedAt`. `classifyShellCommand`, `scopePatternMatches` and
 * `declaredVsScanned` are twins of src/shared/pluginDisclosureScan.ts, held to
 * docs/plugin-contracts/agent-tools-fixtures/scan-cases.json.
 *
 * Pure: no Node APIs. The caller unpacks the archive.
 *
 * Known gap: Python's `str.isdigit` also accepts non-decimal digit characters
 * (superscripts, circled digits); here only Unicode decimal digits start a number.
 */

declare const TextDecoder: new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) => {
  decode(input: Uint8Array): string
}
declare const performance: { now(): number }

export const STATIC_SCAN_SCHEMA_VERSION = 1
export const STATIC_SCANNER_ID = 'navide-static-scan'
export const STATIC_SCANNER_VERSION = '1.0.0'
export const STATIC_SCAN_LIMITS = {
  maxItemsPerKind: 100,
  maxPaths: 50,
  maxPathLength: 200,
  maxScriptBytes: 20 * 1024 * 1024,
  maxNativeBytes: 512 * 1024 * 1024,
  timeBudgetMs: 30_000,
} as const
const HOST_SHELL_ALLOWLIST = ['gh', 'git', 'glab']

export type StaticScanShellCategory = 'remoteWrite' | 'remoteRead' | 'localWrite' | 'local' | 'other' | 'unknownSubcommand'
export type StaticScanSource = 'frontend' | 'backend'

export interface StaticScanReport {
  schemaVersion: 1
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
  shell: {
    calls: Array<{
      executable: string
      subcommand: string | null
      category: StaticScanShellCategory
      source: StaticScanSource
      evidence: 'callSite' | 'commandLikeString'
      files: number
    }>
    dynamic: { count: number; files: number }
  }
  network: { hosts: Array<{ host: string; source: StaticScanSource; count: number }> }
  files: { readPaths: string[]; writePaths: string[]; dynamicPaths: number }
  capabilities: Array<{ address: string; source: StaticScanSource }>
  code: {
    frontend: { eval: number; newFunction: number; dynamicImport: number; stringTimers: number; obfuscationSignals: string[] } | null
    backend: null
  }
  native: Array<{
    path: string
    format: 'mach-o' | 'elf' | 'pe' | 'unknown'
    arch: string
    libraries: string[]
    notableImports: string[]
    importCount: number
    packer: string | null
    embeddedRuntime: string | null
  }>
}

// ── bounds (static_scan/limits.py) ──────────────────────────────────────────

class ScanTimeout extends Error {}
class TooComplex extends Error {}

class Deadline {
  private countdown = 512
  constructor(private readonly at: number | null, private readonly clock: () => number) {}
  tick(): void {
    this.countdown -= 1
    if (this.countdown <= 0) {
      this.countdown = 512
      this.check()
    }
  }
  check(): void {
    if (this.at !== null && this.clock() > this.at) throw new ScanTimeout()
  }
}

// ── Python string helpers ───────────────────────────────────────────────────

/** Python's `str.isspace` set, which `str.split()` and `re`'s `\s` use. */
const PY_WS = ' \\t\\n\\r\\f\\v\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_WS_RUN = new RegExp(`[${PY_WS}]+`)
const PY_WS_CHAR = new RegExp(`[${PY_WS}]`)

/** `value.strip()`, in linear time (an anchored `\s+$` regex backtracks quadratically on long runs). */
function pyStrip(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && PY_WS_CHAR.test(value[start])) start += 1
  while (end > start && PY_WS_CHAR.test(value[end - 1])) end -= 1
  return value.slice(start, end)
}

/** `value.split()` (whitespace runs, edges dropped). */
function pySplit(value: string): string[] {
  const trimmed = pyStrip(value)
  return trimmed === '' ? [] : trimmed.split(PY_WS_RUN)
}

const codePointCompare = (a: string, b: string): number => {
  const left = [...a]
  const right = [...b]
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const diff = left[index].codePointAt(0)! - right[index].codePointAt(0)!
    if (diff) return diff
  }
  return left.length - right.length
}

function compareTuples(a: ReadonlyArray<string | number>, b: ReadonlyArray<string | number>): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index]
    const y = b[index]
    const diff = typeof x === 'number' && typeof y === 'number' ? x - y : codePointCompare(String(x), String(y))
    if (diff) return diff
  }
  return a.length - b.length
}

const pySorted = (values: Iterable<string>): string[] => [...values].sort(codePointCompare)

// ── secret rules (registry/secret_scan.py) ──────────────────────────────────

const SECRET_RULES: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /aws_?secret_?access_?key["'\s:=]+[A-Za-z0-9/+]{40}\b/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b[rs]k_live_[0-9A-Za-z]{24,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b|\bsk-proj-[A-Za-z0-9_-]{40,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
]

const redacted = (value: string): boolean => SECRET_RULES.some((rule) => rule.test(value))

// ── shell classification (twin of pluginDisclosureScan.classifyShellCommand) ─

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
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const FORGE_VALUE_OPTIONS = new Set(['-R', '--repo', '--hostname'])
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

export function classifyShellCommand(executable: string, args: readonly string[]): [string | null, StaticScanShellCategory] {
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
  if (HOST_SHELL_ALLOWLIST.includes(executable)) return [word(args[0]), 'unknownSubcommand']
  return [null, 'other']
}

/** Python's `shlex.split(command, posix=True)`; null where it raises ValueError. */
function shlexSplit(text: string): string[] | null {
  const words: string[] = []
  let token = ''
  let quoted = false
  let state: string = ' '
  let escapedState = 'a'
  const emit = (): void => {
    if (token !== '' || quoted) words.push(token)
    token = ''
    quoted = false
  }
  for (let index = 0; index <= text.length; index += 1) {
    const char = index < text.length ? text[index] : ''
    if (state === ' ') {
      if (char === '') break
      if (' \t\r\n'.includes(char)) continue
      if (char === '#') {
        const end = text.indexOf('\n', index)
        index = end === -1 ? text.length : end
        continue
      }
      if (char === '\\') {
        escapedState = 'a'
        state = char
      } else if (char === "'" || char === '"') {
        state = char
      } else {
        token = char
        state = 'a'
      }
    } else if (state === "'" || state === '"') {
      quoted = true
      if (char === '') return null
      if (char === state) state = 'a'
      else if (char === '\\' && state === '"') {
        escapedState = state
        state = char
      } else token += char
    } else if (state === '\\') {
      if (char === '') return null
      if ((escapedState === "'" || escapedState === '"') && char !== '\\' && char !== escapedState) token += '\\'
      token += char
      state = escapedState
    } else {
      // state 'a': inside a word
      if (char === '') {
        emit()
        break
      }
      if (' \t\r\n'.includes(char)) {
        state = ' '
        if (token !== '' || quoted) emit()
      } else if (char === '#') {
        const end = text.indexOf('\n', index)
        index = end === -1 ? text.length : end
        state = ' '
        if (token !== '' || quoted) emit()
      } else if (char === "'" || char === '"') {
        state = char
      } else if (char === '\\') {
        escapedState = 'a'
        state = char
      } else token += char
    }
  }
  return words
}

// ── tokenizer (static_scan/js_tokens.py) ────────────────────────────────────

interface Token {
  kind: 'str' | 'tmpl' | 'ident' | 'num' | 'regex' | 'punct'
  value: string
  dynamic: boolean
  escapes: number
}

const token = (kind: Token['kind'], value: string, dynamic = false, escapes = 0): Token => ({ kind, value, dynamic, escapes })

// Astral code points are outside Python's \u0080-\uffff, so surrogates are too.
const IDENT_START = /[A-Za-z_$\u0080-\ud7ff\ue000-\uffff]/
const IDENT = /[A-Za-z0-9_$\u0080-\ud7ff\ue000-\uffff]*/y
const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\p{Nd}[\p{Nd}_]*\.?[\p{Nd}_]*|\.\p{Nd}[\p{Nd}_]*)(?:[eE][+-]?\p{Nd}+)?)n?/uy
const DIGIT = /\p{Nd}/u
const PUNCT = />>>=|\.\.\.|===|!==|\*\*=|<<=|>>=|>>>|\?\?=|&&=|\|\|=|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|\*\*|[{}()[\];,<>+\-*/%&|^!~?:=.@#]/y
const WHITESPACE_CHARS = ' \t\r\n\f\v\u00a0\ufeff\u2028\u2029'
const WHITESPACE = /[ \t\r\n\f\v\u00a0\ufeff\u2028\u2029]+/y
const HEX2 = /^[0-9a-fA-F]{2}$/
const HEX4 = /^[0-9a-fA-F]{4}$/
const HEX_CODEPOINT = /^[0-9a-fA-F]{1,6}$/
const SINGLE_QUOTED = /'(?:[^'\\\n]|\\[\s\S])*'/y
const DOUBLE_QUOTED = /"(?:[^"\\\n]|\\[\s\S])*"/y
const MAX_TEMPLATE_DEPTH = 32
const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }
const REGEX_AFTER_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await',
])

function stickyMatch(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index
  return pattern.exec(text)
}

const matchEnd = (match: RegExpExecArray): number => match.index + match[0].length

function decodeEscape(text: string, index: number): [string, number, boolean] {
  if (index + 1 >= text.length) return ['', index + 1, false]
  const char = text[index + 1]
  if (char in SIMPLE_ESCAPES) return [SIMPLE_ESCAPES[char], index + 2, false]
  if (char === 'x') {
    const digits = text.slice(index + 2, index + 4)
    if (HEX2.test(digits)) return [String.fromCodePoint(parseInt(digits, 16)), index + 4, true]
  }
  if (char === 'u') {
    if (text.startsWith('{', index + 2)) {
      const window = text.slice(index + 3, index + 10)
      const close = window.indexOf('}')
      const digits = close !== -1 ? window.slice(0, close) : ''
      if (close !== -1 && HEX_CODEPOINT.test(digits) && parseInt(digits, 16) <= 0x10ffff) {
        return [String.fromCodePoint(parseInt(digits, 16)), index + 3 + close + 1, true]
      }
    } else {
      const digits = text.slice(index + 2, index + 6)
      if (HEX4.test(digits)) return [String.fromCodePoint(parseInt(digits, 16)), index + 6, true]
    }
  }
  if (char === '\r' && text.startsWith('\n', index + 2)) return ['', index + 3, false]
  if ('\n\r\u2028\u2029'.includes(char)) return ['', index + 2, false]
  return [char, index + 2, false]
}

function decodeLiteral(body: string): [string, number] {
  if (!body.includes('\\')) return [body, 0]
  const out: string[] = []
  let escapes = 0
  let index = 0
  while (index < body.length) {
    const next = body.indexOf('\\', index)
    if (next === -1) {
      out.push(body.slice(index))
      break
    }
    out.push(body.slice(index, next))
    const [decoded, after, hex] = decodeEscape(body, next)
    out.push(decoded)
    index = after
    escapes += hex ? 1 : 0
  }
  return [out.join(''), escapes]
}

function readString(text: string, start: number, deadline: Deadline): [Token | null, number] {
  const match = stickyMatch(text[start] === "'" ? SINGLE_QUOTED : DOUBLE_QUOTED, text, start)
  if (match === null) {
    deadline.check()
    return [null, start + 1]
  }
  const [value, escapes] = decodeLiteral(match[0].slice(1, -1))
  return [token('str', value, false, escapes), matchEnd(match)]
}

function readTemplate(text: string, start: number, deadline: Deadline): [Token | null, number] {
  const out: string[] = []
  let escapes = 0
  let dynamic = false
  const stack: number[] = [0]
  let index = start + 1
  const length = text.length
  while (index < length) {
    deadline.tick()
    const char = text[index]
    if (stack[stack.length - 1] === 0) {
      if (char === '\\') {
        if (stack.length === 1) {
          const [decoded, after, hex] = decodeEscape(text, index)
          out.push(decoded)
          index = after
          escapes += hex ? 1 : 0
        } else index += 2
        continue
      }
      if (char === '`') {
        stack.pop()
        index += 1
        if (!stack.length) return [token('tmpl', out.join(''), dynamic, escapes), index]
        continue
      }
      if (char === '$' && text.startsWith('{', index + 1)) {
        if (stack.length === 1) dynamic = true
        stack.push(1)
        index += 2
        continue
      }
      if (stack.length === 1) out.push(char)
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      const match = stickyMatch(char === "'" ? SINGLE_QUOTED : DOUBLE_QUOTED, text, index)
      index = match ? matchEnd(match) : index + 1
      continue
    }
    if (char === '`') {
      if (stack.length >= MAX_TEMPLATE_DEPTH) throw new TooComplex('template nesting')
      stack.push(0)
      index += 1
      continue
    }
    if (char === '/' && text.startsWith('/', index + 1)) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? length : end
      continue
    }
    if (char === '/' && text.startsWith('*', index + 1)) {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? length : end + 2
      continue
    }
    if (char === '{') stack[stack.length - 1] += 1
    else if (char === '}') {
      stack[stack.length - 1] -= 1
      if (stack[stack.length - 1] === 0) stack.pop()
    }
    index += 1
  }
  throw new TooComplex('unterminated template')
}

function readRegex(text: string, start: number, deadline: Deadline): [Token | null, number] {
  let index = start + 1
  let inClass = false
  while (index < text.length) {
    deadline.tick()
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '\n') return [null, start + 1]
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) {
      const end = matchEnd(stickyMatch(IDENT, text, index + 1)!)
      return [token('regex', text.slice(start, end)), end]
    }
    index += 1
  }
  return [null, start + 1]
}

function regexAllowed(previous: Token | null): boolean {
  if (previous === null) return true
  if (previous.kind === 'num' || previous.kind === 'str' || previous.kind === 'tmpl' || previous.kind === 'regex') return false
  if (previous.kind === 'ident') return REGEX_AFTER_KEYWORDS.has(previous.value)
  return ![')', ']', '}', '++', '--'].includes(previous.value)
}

function* iterTokens(text: string, deadline: Deadline): Generator<Token> {
  let previous: Token | null = null
  let index = 0
  const length = text.length
  while (index < length) {
    deadline.tick()
    const char = text[index]
    if (WHITESPACE_CHARS.includes(char)) {
      index = matchEnd(stickyMatch(WHITESPACE, text, index)!)
      continue
    }
    if (char === '/' && text.startsWith('/', index + 1)) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? length : end
      continue
    }
    if (char === '/' && text.startsWith('*', index + 1)) {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? length : end + 2
      continue
    }
    let next: Token | null
    if (char === "'" || char === '"') {
      ;[next, index] = readString(text, index, deadline)
    } else if (char === '`') {
      ;[next, index] = readTemplate(text, index, deadline)
    } else if (char === '/' && regexAllowed(previous)) {
      const [regex, after] = readRegex(text, index, deadline)
      if (regex === null) {
        next = token('punct', '/')
        index += 1
      } else {
        next = regex
        index = after
      }
    } else if (DIGIT.test(char) || (char === '.' && index + 1 < length && DIGIT.test(text[index + 1]))) {
      const match = stickyMatch(NUMBER, text, index)
      const end = match && matchEnd(match) > index ? matchEnd(match) : index + 1
      next = token('num', text.slice(index, end))
      index = end
    } else if (IDENT_START.test(char)) {
      const end = matchEnd(stickyMatch(IDENT, text, index + 1)!)
      next = token('ident', text.slice(index, end))
      index = end
    } else {
      const match = stickyMatch(PUNCT, text, index)
      if (match) {
        next = token('punct', match[0])
        index = matchEnd(match)
      } else {
        next = null
        // One Python character: a whole astral code point.
        index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1
      }
    }
    if (next !== null) {
      yield next
      previous = next
    }
  }
}

// ── script rules (static_scan/js_scan.py) ───────────────────────────────────

const CAPABILITY_ADDRESS_RE = /^(aiCli|fs|shell|storage|ui|workspace)\.[a-z][A-Za-z0-9]{0,63}$/
const FS_READ_ADDRESSES = new Set(['fs.readFile', 'fs.readImage', 'fs.listDirectory', 'fs.listFilesFlat', 'fs.queryFiles', 'fs.glob', 'fs.stat', 'fs.statPath'])
const FS_WRITE_ADDRESSES = new Set(['fs.writeFile'])
const COMMAND_EXECUTABLES = new Set([
  'git', 'gh', 'glab', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp',
  'bash', 'sh', 'zsh', 'fish', 'python', 'python3', 'node', 'deno', 'bun', 'npm', 'npx', 'pnpm', 'yarn',
  'pip', 'pip3', 'docker', 'kubectl', 'aws', 'gcloud', 'az', 'osascript', 'powershell', 'pwsh', 'cmd',
  'open', 'xdg-open', 'rm', 'chmod', 'sudo',
])
const EXECUTABLE_RE = /^[a-z][a-z0-9-]{0,39}$/
const MAX_COMMAND_LENGTH = 4096
const URL_RE = new RegExp(`(?:https?|wss?|ssh|git|ftp)://(?:[^/${PY_WS}'"?#@]*@)?([A-Za-z0-9.-]+)`, 'g')
// Python's \b is a Unicode word boundary.
const SCP_RE = /(?<![\p{L}\p{N}_])git@([A-Za-z0-9.-]+):/gu
const XML_NAMESPACE_URLS = [
  'http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xhtml', 'http://www.w3.org/1999/xlink',
  'http://www.w3.org/XML/1998/namespace', 'http://www.w3.org/2000/xmlns/', 'http://www.w3.org/1998/Math/MathML',
]
const PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._*/-]+$/
const HEX_IDENTIFIER_RE = /^_0x[0-9a-f]{4,}$/
const BASE64_RE = /^[A-Za-z0-9+/=_-]+$/
const PATH_LOOKAHEAD = 12
const OBFUSCATION_THRESHOLDS = { hexIdentifiers: 20, hexEscapes: 200, longBase64: 2000, charCodeStrings: 20 }
const SHELL_RUN_LITERAL = /['"`]shell\.run['"`]/

type Command = [string, string | null, StaticScanShellCategory]

interface ScriptFacts {
  calls: Map<string, [string, string | null, StaticScanShellCategory, 'callSite' | 'commandLikeString']>
  dynamic: number
  dynamicFiles: number
  hosts: Map<string, number>
  capabilities: Set<string>
  readPaths: Set<string>
  writePaths: Set<string>
  dynamicPaths: number
  eval: number
  newFunction: number
  dynamicImport: number
  stringTimers: number
  obfuscationSignals: Set<string>
}

const emptyFacts = (): ScriptFacts => ({
  calls: new Map(),
  dynamic: 0,
  dynamicFiles: 0,
  hosts: new Map(),
  capabilities: new Set(),
  readPaths: new Set(),
  writePaths: new Set(),
  dynamicPaths: 0,
  eval: 0,
  newFunction: 0,
  dynamicImport: 0,
  stringTimers: 0,
  obfuscationSignals: new Set(),
})

const addCall = (facts: ScriptFacts, call: Command, evidence: 'callSite' | 'commandLikeString'): void => {
  facts.calls.set(JSON.stringify([...call, evidence]), [...call, evidence])
}

const count = (map: Map<string, number>, key: string, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by)
}

function staticValue(item: Token | null): string | null {
  if (item === null) return null
  return item.kind === 'str' || (item.kind === 'tmpl' && !item.dynamic) ? item.value : null
}

function parseCommand(command: string): Command | null {
  if (command.length > MAX_COMMAND_LENGTH) return null
  const words = shlexSplit(command)
  if (!words || !words.length) return null
  const executable = words[0].slice(words[0].lastIndexOf('/') + 1)
  if (!EXECUTABLE_RE.test(executable)) return null
  const [subcommand, category] = classifyShellCommand(executable, words.slice(1))
  return [executable, subcommand, category]
}

function commandLike(value: string): Command | null {
  const head = pySplit(value)
  if (head.length < 2 || !COMMAND_EXECUTABLES.has(head[0])) return null
  return parseCommand(value)
}

function hostsIn(text: string): string[] {
  let value = text
  for (const namespace of XML_NAMESPACE_URLS) value = value.split(namespace).join('')
  const found: string[] = []
  for (const match of [...value.matchAll(URL_RE), ...value.matchAll(SCP_RE)]) {
    const host = match[1].toLowerCase().replace(/^\.+|\.+$/g, '')
    if (host.length > 253) continue
    const digits = /^\d+$/.test(host.replace(/\./g, ''))
    if (host === 'localhost' || (host.includes('.') && !digits)) found.push(host)
    else if (digits && host.split('.').length - 1 === 3) found.push(host)
  }
  return found
}

class TokenWindow {
  private buffer: Token[] = []
  private offset = 0
  private done = false
  constructor(private readonly tokens: Iterator<Token>, private readonly keep = 2) {}
  at(index: number): Token | null {
    if (index < this.offset) return null
    while (!this.done && index >= this.offset + this.buffer.length) {
      const next = this.tokens.next()
      if (next.done) this.done = true
      else this.buffer.push(next.value)
    }
    const position = index - this.offset
    return position < this.buffer.length ? this.buffer[position] : null
  }
  release(index: number): void {
    const drop = index - this.keep - this.offset
    if (drop > 256) {
      this.buffer.splice(0, drop)
      this.offset += drop
    }
  }
}

type At = (index: number) => Token | null

function isKey(at: At, index: number, name: string): boolean {
  const item = at(index)
  if (item === null || !((item.kind === 'ident' || item.kind === 'str') && item.value === name)) return false
  const previous = at(index - 1)
  const next = at(index + 1)
  if (previous === null || !['{', ','].includes(previous.value)) return false
  return next !== null && [':', ',', '}'].includes(next.value)
}

function collectCommand(at: At, index: number, facts: ScriptFacts): void {
  const separator = at(index + 1)
  if (separator === null || separator.value !== ':') {
    facts.dynamic += 1
    return
  }
  const value = staticValue(at(index + 2))
  const end = at(index + 3)
  if (value === null || end === null || ![',', '}'].includes(end.value)) {
    facts.dynamic += 1
    return
  }
  const parsed = parseCommand(value)
  if (parsed === null) {
    facts.dynamic += 1
    return
  }
  addCall(facts, parsed, 'callSite')
}

function collectPath(at: At, index: number, write: boolean, facts: ScriptFacts, maximum: number): void {
  for (let offset = 1; offset <= PATH_LOOKAHEAD; offset += 1) {
    const position = index + offset
    if (at(position + 2) === null) break
    if (isKey(at, position, 'path') || isKey(at, position, 'pattern')) {
      const separator = at(position + 1)
      if (separator === null || separator.value !== ':') break
      const value = staticValue(at(position + 2))
      const path = value !== null && value.length <= maximum && PATH_RE.test(value) ? value : null
      if (path === null) break
      ;(write ? facts.writePaths : facts.readPaths).add(path)
      return
    }
  }
  facts.dynamicPaths += 1
}

function scanScript(text: string, maxPathLength: number, deadline: Deadline): ScriptFacts {
  const window = new TokenWindow(iterTokens(text, deadline))
  const at: At = (index) => window.at(index)
  const facts = emptyFacts()
  const hasShellRun = SHELL_RUN_LITERAL.test(text)
  let escapes = 0
  let hexIdentifiers = 0
  let charCodes = 0
  let index = 0
  let item: Token | null
  while ((item = at(index)) !== null) {
    window.release(index)
    const next = at(index + 1)
    const value = staticValue(item)
    if (item.kind === 'str' || item.kind === 'tmpl') {
      escapes += item.escapes
      for (const host of hostsIn(item.value)) count(facts.hosts, host)
      if (
        item.kind === 'str' && [...item.value].length >= OBFUSCATION_THRESHOLDS.longBase64 &&
        !item.value.startsWith('data:') && BASE64_RE.test(item.value)
      ) facts.obfuscationSignals.add('longBase64')
    }
    if (value !== null) {
      if (CAPABILITY_ADDRESS_RE.test(value)) {
        facts.capabilities.add(value)
        if (FS_READ_ADDRESSES.has(value) || FS_WRITE_ADDRESSES.has(value)) {
          collectPath(at, index, FS_WRITE_ADDRESSES.has(value), facts, maxPathLength)
        }
        if (value === 'shell.run' && next !== null && next.value === ',') {
          const after = at(index + 2)
          if (after !== null && after.value !== '{') facts.dynamic += 1
        }
      }
      const parsed = commandLike(value)
      if (parsed !== null) addCall(facts, parsed, 'commandLikeString')
    } else if (item.kind === 'tmpl' && item.dynamic && hasShellRun) {
      const head = pySplit(item.value)
      if (head.length && COMMAND_EXECUTABLES.has(head[0])) facts.dynamic += 1
    }
    if (item.kind === 'ident') {
      if (HEX_IDENTIFIER_RE.test(item.value)) hexIdentifiers += 1
      else if (item.value === 'fromCharCode') charCodes += 1
      const previous = at(index - 1)
      const called = next !== null && next.value === '('
      const member = previous !== null && (previous.value === '.' || previous.value === '?.')
      if (item.value === 'eval' && called && !member) facts.eval += 1
      else if (item.value === 'Function' && called && !member) facts.newFunction += 1
      else if (item.value === 'import' && called) {
        const argument = at(index + 2)
        if (argument === null || staticValue(argument) === null) facts.dynamicImport += 1
      } else if ((item.value === 'setTimeout' || item.value === 'setInterval') && called && !member) {
        const argument = at(index + 2)
        if (argument !== null && (argument.kind === 'str' || argument.kind === 'tmpl')) facts.stringTimers += 1
      }
    }
    if (hasShellRun && isKey(at, index, 'command')) collectCommand(at, index, facts)
    index += 1
  }
  const sites = new Set([...facts.calls.values()].filter((call) => call[3] === 'callSite').map((call) => JSON.stringify([call[0], call[1]])))
  for (const [key, call] of facts.calls) {
    if (call[3] !== 'callSite' && sites.has(JSON.stringify([call[0], call[1]]))) facts.calls.delete(key)
  }
  if (hexIdentifiers >= OBFUSCATION_THRESHOLDS.hexIdentifiers) facts.obfuscationSignals.add('hexIdentifiers')
  if (escapes >= OBFUSCATION_THRESHOLDS.hexEscapes) facts.obfuscationSignals.add('hexEscapes')
  if (charCodes >= OBFUSCATION_THRESHOLDS.charCodeStrings) facts.obfuscationSignals.add('charCodeStrings')
  return facts
}

// ── native executables (static_scan/native.py) ──────────────────────────────

const NOTABLE_IMPORTS = new Set([
  'execve', 'execv', 'execvp', 'posix_spawn', 'posix_spawnp', 'system', 'popen', 'fork', 'vfork',
  'socket', 'connect', 'getaddrinfo', 'gethostbyname', 'dlopen', 'NSTask',
  'CreateProcessA', 'CreateProcessW', 'ShellExecuteA', 'ShellExecuteW', 'ShellExecuteExW', 'WinExec',
  'URLDownloadToFileA', 'URLDownloadToFileW', 'InternetOpenA', 'InternetOpenW', 'WinHttpOpen',
  'WSAStartup', 'LoadLibraryA', 'LoadLibraryW', 'LoadLibraryExW',
])
const EMBEDDED_RUNTIME_MARKERS: Array<[string, string[]]> = [
  ['pyinstaller', ['MEI\x0c\x0b\x0a\x0b\x0e', '_MEIPASS', 'pyi-runtime-tmpdir']],
  ['node-sea', ['NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', 'NODE_SEA_BLOB']],
  ['bun', ['---- Bun! ----']],
  ['deno', ['d3n0l4nd']],
]
const MACHO_ARCH: Record<number, string> = { 0x01000007: 'x64', 0x0100000c: 'arm64' }
const ELF_ARCH: Record<number, string> = { 62: 'x64', 183: 'arm64' }
const PE_ARCH: Record<number, string> = { 0x8664: 'x64', 0xaa64: 'arm64' }
const MAX_LOAD_COMMANDS = 4096
const MAX_SECTIONS = 1024
const MAX_DYNAMIC_ENTRIES = 65536
const MAX_SYMBOLS = 200_000
const MAX_IMPORT_DESCRIPTORS = 1024
const MAX_IMPORT_THUNKS = 200_000

interface NativeFacts {
  path: string
  format: StaticScanReport['native'][number]['format']
  arch: string
  libraries: Set<string>
  imports: Set<string>
  packer: string | null
  embeddedRuntime: string | null
  commands: Map<string, Command>
  hosts: Map<string, number>
  capabilities: Set<string>
  tooComplex: boolean
}

/** Little- or big-endian fixed-width reads that return null past the end, like `struct.unpack_from` guarded by `_u`. */
class Bytes {
  private readonly view: DataView
  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }
  get length(): number {
    return this.data.length
  }
  private ok(offset: number, size: number): boolean {
    return offset >= 0 && offset + size <= this.data.length
  }
  u8(offset: number): number | null {
    return this.ok(offset, 1) ? this.data[offset] : null
  }
  u16(offset: number, little = true): number | null {
    return this.ok(offset, 2) ? this.view.getUint16(offset, little) : null
  }
  u32(offset: number, little = true): number | null {
    return this.ok(offset, 4) ? this.view.getUint32(offset, little) : null
  }
  u64(offset: number, little = true): bigint | null {
    return this.ok(offset, 8) ? this.view.getBigUint64(offset, little) : null
  }
  i64(offset: number, little = true): bigint | null {
    return this.ok(offset, 8) ? this.view.getBigInt64(offset, little) : null
  }
  has(offset: number, size: number): boolean {
    return this.ok(offset, size)
  }
  cstring(offset: number, maximum = 1024): string | null {
    if (offset < 0 || offset >= this.data.length) return null
    const limit = Math.min(this.data.length, offset + maximum)
    let end = -1
    for (let index = offset; index < limit; index += 1) {
      if (this.data[index] === 0) {
        end = index
        break
      }
    }
    if (end === -1) return null
    let out = ''
    for (let index = offset; index < end; index += 1) {
      if (this.data[index] > 0x7f) return null
      out += String.fromCharCode(this.data[index])
    }
    return out
  }
}

/** A Python int read as a JS number; offsets past 2^53 only ever fail a bounds check. */
const num = (value: bigint): number => Number(value)

function boundedCount(declared: number, available: number, entrySize: number, ceiling: number, facts: NativeFacts): number {
  let total = Math.min(Math.max(declared, 0), Math.floor(Math.max(available, 0) / entrySize))
  if (total > ceiling) {
    facts.tooComplex = true
    total = ceiling
  }
  return total
}

function startsWithAscii(data: Uint8Array, offset: number, end: number, prefix: string): boolean {
  let stop = end
  for (let index = offset; index < end; index += 1) {
    if (data[index] === 0) {
      stop = index
      break
    }
  }
  if (stop - offset < prefix.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (data[offset + index] !== prefix.charCodeAt(index)) return false
  }
  return true
}

function macho(bytes: Bytes, facts: NativeFacts, deadline: Deadline): void {
  if (!bytes.has(0, 28)) return
  let ncmds = bytes.u32(16)!
  if (ncmds > MAX_LOAD_COMMANDS) {
    facts.tooComplex = true
    ncmds = MAX_LOAD_COMMANDS
  }
  let offset = 32
  let symtab: [number, number, number, number] | null = null
  for (let step = 0; step < ncmds; step += 1) {
    deadline.tick()
    const cmd = bytes.u32(offset)
    const size = bytes.u32(offset + 4)
    if (cmd === null || size === null || size < 8) return
    if (cmd === 0xc || cmd === (0x18 | 0x80000000) >>> 0 || cmd === (0x1f | 0x80000000) >>> 0 || cmd === 0x23) {
      const nameOffset = bytes.u32(offset + 8)
      if (nameOffset !== null) {
        const name = bytes.cstring(offset + nameOffset)
        if (name) facts.libraries.add(name)
      }
    } else if (cmd === 0x2) {
      symtab = bytes.has(offset + 8, 16)
        ? [bytes.u32(offset + 8)!, bytes.u32(offset + 12)!, bytes.u32(offset + 16)!, bytes.u32(offset + 20)!]
        : null
    } else if (cmd === 0x19) {
      const end = Math.min(bytes.length, offset + 24)
      if (offset + 8 < end && startsWithAscii(bytes.data, offset + 8, end, 'UPX')) facts.packer = 'upx'
    }
    offset += size
  }
  if (symtab === null) return
  const [symoff, nsyms, stroff] = symtab
  const total = boundedCount(nsyms, bytes.length - symoff, 16, MAX_SYMBOLS, facts)
  for (let index = 0; index < total; index += 1) {
    deadline.tick()
    const at = symoff + index * 16
    if (!bytes.has(at, 16)) break
    const strx = bytes.u32(at)!
    const nType = bytes.u8(at + 4)!
    if (nType & 0xe0) continue
    if ((nType & 0x0e) === 0 && nType & 0x01) {
      const name = bytes.cstring(stroff + strx)
      if (name) facts.imports.add(name.startsWith('_') ? name.slice(1) : name)
    }
  }
}

function elf(bytes: Bytes, facts: NativeFacts, deadline: Deadline): void {
  const little = bytes.data[5] === 1
  if (!bytes.has(16, 48)) return
  const shoff = num(bytes.u64(40, little)!)
  const shentsize = bytes.u16(58, little)!
  let shnum = bytes.u16(60, little)!
  if (shnum === 0) return
  if (shentsize !== 64) {
    facts.tooComplex = true
    return
  }
  shnum = boundedCount(shnum, bytes.length - shoff, 64, MAX_SECTIONS, facts)
  const sections: Array<{ type: number; offset: number; size: number; link: number; entsize: number }> = []
  for (let index = 0; index < shnum; index += 1) {
    deadline.tick()
    const at = shoff + index * 64
    if (!bytes.has(at, 64)) break
    sections.push({
      type: bytes.u32(at + 4, little)!,
      offset: num(bytes.u64(at + 24, little)!),
      size: num(bytes.u64(at + 32, little)!),
      link: bytes.u32(at + 40, little)!,
      entsize: num(bytes.u64(at + 56, little)!),
    })
  }
  for (const section of sections) {
    if (section.type === 6 && section.link < sections.length) {
      const strtab = sections[section.link].offset
      const total = boundedCount(Math.floor(section.size / 16), bytes.length - section.offset, 16, MAX_DYNAMIC_ENTRIES, facts)
      for (let index = 0; index < total; index += 1) {
        deadline.tick()
        const at = section.offset + index * 16
        if (!bytes.has(at, 16)) break
        const tag = bytes.i64(at, little)!
        if (tag === 0n) break
        if (tag === 1n) {
          const name = bytes.cstring(strtab + num(bytes.u64(at + 8, little)!))
          if (name) facts.libraries.add(name)
        }
      }
    } else if (section.type === 11 && section.entsize === 24 && section.link < sections.length) {
      const strtab = sections[section.link].offset
      const total = boundedCount(Math.floor(section.size / 24), bytes.length - section.offset, 24, MAX_SYMBOLS, facts)
      for (let index = 1; index < total; index += 1) {
        deadline.tick()
        const at = section.offset + index * 24
        if (!bytes.has(at, 24)) break
        const stName = bytes.u32(at, little)!
        const shndx = bytes.u16(at + 6, little)!
        if (shndx === 0 && stName) {
          const name = bytes.cstring(strtab + stName)
          if (name) facts.imports.add(name.split('@', 1)[0])
        }
      }
    }
  }
  if (latin1(bytes.data.subarray(0, 4096)).includes('UPX!')) facts.packer = 'upx'
}

function pe(bytes: Bytes, facts: NativeFacts, peOffset: number, deadline: Deadline): void {
  if (!bytes.has(peOffset + 4, 20)) return
  const nsections = bytes.u16(peOffset + 6)!
  const optionalSize = bytes.u16(peOffset + 20)!
  const optional = peOffset + 24
  const magic = bytes.u16(optional)
  if (magic === null || magic !== 0x20b) return
  const importRva = bytes.has(optional + 120, 8) ? bytes.u32(optional + 120)! : null
  const sectionTable = optional + optionalSize
  const ranges: Array<[number, number, number]> = []
  for (let index = 0; index < Math.min(nsections, 96); index += 1) {
    const at = sectionTable + index * 40
    if (!bytes.has(at, 40)) break
    const vsize = bytes.u32(at + 8)!
    const vaddr = bytes.u32(at + 12)!
    const rawsize = bytes.u32(at + 16)!
    const rawptr = bytes.u32(at + 20)!
    ranges.push([vaddr, vaddr + Math.max(vsize, rawsize), rawptr])
    // `name.rstrip(b"\0").startswith(b"UPX")`
    if (bytes.data[at] === 0x55 && bytes.data[at + 1] === 0x50 && bytes.data[at + 2] === 0x58) facts.packer = 'upx'
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  const offsetOf = (rva: number): number | null => {
    let position = -1
    for (let index = 0; index < ranges.length && ranges[index][0] <= rva; index += 1) position = index
    if (position < 0) return null
    const [start, end, raw] = ranges[position]
    return rva < end ? raw + (rva - start) : null
  }
  if (importRva === null || importRva === 0) return
  let descriptor = offsetOf(importRva)
  let thunksLeft = MAX_IMPORT_THUNKS
  for (let step = 0; step < MAX_IMPORT_DESCRIPTORS; step += 1) {
    deadline.tick()
    if (descriptor === null) return
    if (!bytes.has(descriptor, 20)) return
    const fields = [0, 4, 8, 12, 16].map((delta) => bytes.u32(descriptor! + delta)!)
    if (fields.every((value) => value === 0)) return
    const [originalThunk, , , nameRva, firstThunk] = fields
    const nameOffset = offsetOf(nameRva)
    const library = nameOffset !== null ? bytes.cstring(nameOffset) : null
    if (library) facts.libraries.add(library)
    let thunk = offsetOf(originalThunk || firstThunk)
    while (thunk !== null) {
      deadline.tick()
      if (thunksLeft === 0) {
        facts.tooComplex = true
        return
      }
      thunksLeft -= 1
      const value = bytes.u64(thunk)
      if (value === null || value === 0n) break
      if (!(value & (1n << 63n))) {
        const hint = offsetOf(num(value & 0x7fffffffn))
        const name = hint !== null ? bytes.cstring(hint + 2) : null
        if (name) facts.imports.add(name)
      }
      thunk += 8
    }
    descriptor += 20
  }
  facts.tooComplex = true
}

/** Bytes as a string of the same length, one char per byte. */
function latin1(data: Uint8Array): string {
  let out = ''
  for (let index = 0; index < data.length; index += 8192) {
    out += String.fromCharCode(...data.subarray(index, index + 8192))
  }
  return out
}

/** `marker in data` for an ASCII marker, without building one string of the whole executable
 *  (512 MiB is past V8's string length limit). */
function containsBytes(data: Uint8Array, marker: string): boolean {
  const first = marker.charCodeAt(0)
  for (let index = data.indexOf(first); index !== -1 && index + marker.length <= data.length; index = data.indexOf(first, index + 1)) {
    let match = true
    for (let offset = 1; offset < marker.length; offset += 1) {
      if (data[index + offset] !== marker.charCodeAt(offset)) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}

const printable = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x20 && byte <= 0x7e

/** The matches of `rb"[\x20-\x7e]{4,}"` (`step` 1) or `rb"(?:[\x20-\x7e]\x00){4,}"` (`step` 2),
 *  leftmost and greedy like `re.finditer`, decoded to text. */
function* printableRuns(data: Uint8Array, step: 1 | 2, deadline: Deadline): Generator<string> {
  let index = 0
  while (index < data.length) {
    deadline.tick()
    let units = 0
    while (printable(data[index + units * step]) && (step === 1 || data[index + units * step + 1] === 0)) units += 1
    if (units >= 4) {
      let text = ''
      for (let unit = 0; unit < units; unit += 1) text += String.fromCharCode(data[index + unit * step])
      yield text
      index += units * step
    } else index += 1
  }
}

function classifyNativeString(text: string, facts: NativeFacts): void {
  for (const host of hostsIn(text)) count(facts.hosts, host)
  for (const item of pySplit(text)) {
    if (CAPABILITY_ADDRESS_RE.test(item)) facts.capabilities.add(item)
  }
  const parsed = commandLike(pyStrip(text))
  if (parsed !== null) facts.commands.set(JSON.stringify(parsed), parsed)
}

function summarizeExecutable(path: string, data: Uint8Array, deadline: Deadline): NativeFacts {
  const bytes = new Bytes(data)
  const facts: NativeFacts = {
    path, format: 'unknown', arch: 'unknown', libraries: new Set(), imports: new Set(), packer: null,
    embeddedRuntime: null, commands: new Map(), hosts: new Map(), capabilities: new Set(), tooComplex: false,
  }
  if (data[0] === 0xcf && data[1] === 0xfa && data[2] === 0xed && data[3] === 0xfe) {
    facts.format = 'mach-o'
    facts.arch = MACHO_ARCH[bytes.u32(4) ?? 0] ?? 'unknown'
    macho(bytes, facts, deadline)
  } else if (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46 && data.length > 20 && data[4] === 2) {
    facts.format = 'elf'
    facts.arch = ELF_ARCH[bytes.u16(18, data[5] === 1) ?? 0] ?? 'unknown'
    elf(bytes, facts, deadline)
  } else if (data[0] === 0x4d && data[1] === 0x5a) {
    facts.format = 'pe'
    const peOffset = bytes.u32(0x3c) ?? 0
    const signed = data[peOffset] === 0x50 && data[peOffset + 1] === 0x45 && data[peOffset + 2] === 0 && data[peOffset + 3] === 0 &&
      peOffset + 4 <= data.length
    const machine = signed ? bytes.u16(peOffset + 4) : null
    facts.arch = PE_ARCH[machine ?? 0] ?? 'unknown'
    if (machine !== null) pe(bytes, facts, peOffset, deadline)
  }
  for (const [runtime, markers] of EMBEDDED_RUNTIME_MARKERS) {
    if (markers.some((marker) => containsBytes(data, marker))) {
      facts.embeddedRuntime = runtime
      break
    }
  }
  for (const step of [1, 2] as const) {
    for (const text of printableRuns(data, step, deadline)) classifyNativeString(text, facts)
  }
  return facts
}

function nativeSummary(facts: NativeFacts, limit: number): StaticScanReport['native'][number] {
  return {
    path: facts.path,
    format: facts.format,
    arch: facts.arch,
    libraries: pySorted(facts.libraries).slice(0, limit),
    notableImports: pySorted([...facts.imports].filter((name) => NOTABLE_IMPORTS.has(name))).slice(0, limit),
    importCount: facts.imports.size,
    packer: facts.packer,
    embeddedRuntime: facts.embeddedRuntime,
  }
}

// ── report (static_scan/report.py) ──────────────────────────────────────────

const SCRIPT_SUFFIXES = ['.js', '.mjs', '.cjs']

/** Same rule as the Registry's backend_entry_for_target: only a bare entry gains `.exe` on win32. */
function backendEntryForTarget(entry: string, target: string): string {
  if (!target.startsWith('win32-')) return entry
  const base = entry.slice(entry.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 && base.slice(0, dot).replace(/^\.+/, '') !== '' ? entry : `${entry}.exe`
}

function timestamp(value: Date): string {
  return `${value.toISOString().slice(0, 19)}Z`
}

export interface ScanPackageFilesInput {
  /** Archive path → bytes, including manifest.json (which is not scanned). */
  files: ReadonlyMap<string, Uint8Array>
  artifactDigest: string
  target: string
  manifest: unknown
  now?: Date
  /** Milliseconds; tests replace it to run out the time budget. */
  clock?: () => number
}

/** The scan report of one package, or null for a manifest that is not v2 (it has no disclosure). */
export function scanPackageFiles(input: ScanPackageFilesInput): StaticScanReport | null {
  const manifest = input.manifest as { schemaVersion?: unknown; backend?: { entry?: unknown } } | null
  if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== 2) return null
  const clock = input.clock ?? (() => performance.now())
  const entry = manifest.backend && typeof manifest.backend.entry === 'string' ? manifest.backend.entry : null
  const backendPath = entry !== null ? backendEntryForTarget(entry, input.target) : null
  const started = clock()
  const budget = STATIC_SCAN_LIMITS.timeBudgetMs
  const deadline = new Deadline(started + budget, clock)
  const limit = STATIC_SCAN_LIMITS.maxItemsPerKind
  const skipped = new Map<string, number>()
  let truncated = false
  let timedOut = false
  let filesTotal = 0
  let filesScanned = 0
  let bytesScanned = 0
  const merged = emptyFacts()
  const callFiles = new Map<string, [string, string | null, StaticScanShellCategory, string, StaticScanSource, number]>()
  const backendHosts = new Map<string, number>()
  const backendCapabilities = new Set<string>()
  const natives: NativeFacts[] = []
  let anyScript = false
  const skip = (reason: string, by = 1): void => count(skipped, reason, by)
  const addCallFile = (call: Command, evidence: string, source: StaticScanSource): void => {
    const key = JSON.stringify([...call, evidence, source])
    const existing = callFiles.get(key)
    if (existing) existing[5] += 1
    else callFiles.set(key, [...call, evidence, source, 1])
  }
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

  for (const path of pySorted(input.files.keys())) {
    if (path === 'manifest.json') continue
    const data = input.files.get(path)!
    filesTotal += 1
    if (path === backendPath) {
      if (timedOut || clock() - started > budget) {
        timedOut = true
        skip('unsupported')
        continue
      }
      let binary = data
      if (binary.length > STATIC_SCAN_LIMITS.maxNativeBytes) {
        binary = binary.subarray(0, STATIC_SCAN_LIMITS.maxNativeBytes)
        truncated = true
      }
      let native: NativeFacts
      try {
        native = summarizeExecutable(path, binary, deadline)
      } catch (error) {
        if (error instanceof ScanTimeout) {
          timedOut = true
          continue
        }
        skip('scannerError')
        continue
      }
      if (native.tooComplex) skip('tooComplex')
      natives.push(native)
      filesScanned += 1
      bytesScanned += binary.length
      for (const call of native.commands.values()) addCallFile(call, 'commandLikeString', 'backend')
      for (const [host, hostCount] of native.hosts) count(backendHosts, host, hostCount)
      for (const address of native.capabilities) backendCapabilities.add(address)
      continue
    }
    if (!SCRIPT_SUFFIXES.some((suffix) => path.toLowerCase().endsWith(suffix))) {
      skip('binaryAsset')
      continue
    }
    if (timedOut || clock() - started > budget) {
      timedOut = true
      skip('unsupported')
      continue
    }
    let content = data
    if (content.length > STATIC_SCAN_LIMITS.maxScriptBytes) {
      content = content.subarray(0, STATIC_SCAN_LIMITS.maxScriptBytes)
      truncated = true
    }
    let facts: ScriptFacts
    try {
      facts = scanScript(decoder.decode(content), STATIC_SCAN_LIMITS.maxPathLength, deadline)
    } catch (error) {
      if (error instanceof ScanTimeout) {
        timedOut = true
        continue
      }
      skip(error instanceof TooComplex ? 'tooComplex' : 'scannerError')
      continue
    }
    anyScript = true
    filesScanned += 1
    bytesScanned += content.length
    for (const [executable, subcommand, category, evidence] of facts.calls.values()) {
      addCallFile([executable, subcommand, category], evidence, 'frontend')
    }
    merged.dynamic += facts.dynamic
    for (const [host, hostCount] of facts.hosts) count(merged.hosts, host, hostCount)
    for (const address of facts.capabilities) merged.capabilities.add(address)
    for (const path of facts.readPaths) merged.readPaths.add(path)
    for (const path of facts.writePaths) merged.writePaths.add(path)
    merged.dynamicPaths += facts.dynamicPaths
    merged.eval += facts.eval
    merged.newFunction += facts.newFunction
    merged.dynamicImport += facts.dynamicImport
    merged.stringTimers += facts.stringTimers
    for (const signal of facts.obfuscationSignals) merged.obfuscationSignals.add(signal)
    if (facts.dynamic) merged.dynamicFiles += 1
  }

  let redactions = 0
  const keep = (values: string[]): string[] => {
    const kept: string[] = []
    for (const value of values) {
      if (redacted(value)) redactions += 1
      else kept.push(value)
    }
    if (kept.length > limit) {
      truncated = true
      return kept.slice(0, limit)
    }
    return kept
  }

  let calls: StaticScanReport['shell']['calls'] = []
  const orderedCalls = [...callFiles.values()].sort((a, b) =>
    compareTuples([a[0], a[1] ?? '', a[4], a[3], a[2]], [b[0], b[1] ?? '', b[4], b[3], b[2]]))
  for (const [executable, subcommand, category, evidence, source, files] of orderedCalls) {
    const command = subcommand === null ? executable : `${executable} ${subcommand}`
    if (redacted(command)) {
      redactions += 1
      continue
    }
    calls.push({ executable, subcommand, category, source, evidence: evidence as 'callSite' | 'commandLikeString', files })
  }
  const sites = new Set(calls.filter((call) => call.evidence === 'callSite').map((call) => JSON.stringify([call.executable, call.subcommand, call.source])))
  calls = calls.filter((call) => call.evidence === 'callSite' || !sites.has(JSON.stringify([call.executable, call.subcommand, call.source])))
  if (calls.length > limit) {
    truncated = true
    calls = calls.slice(0, limit)
  }
  let hostEntries: Array<[string, StaticScanSource, number]> = [
    ...[...merged.hosts].map(([host, hostCount]): [string, StaticScanSource, number] => [host, 'frontend', hostCount]),
    ...[...backendHosts].map(([host, hostCount]): [string, StaticScanSource, number] => [host, 'backend', hostCount]),
  ].sort(compareTuples)
  const keptHosts = new Set(keep(pySorted(new Set(hostEntries.map((item) => item[0])))))
  hostEntries = hostEntries.filter((item) => keptHosts.has(item[0]))
  const capabilityEntries: Array<[string, StaticScanSource]> = [
    ...[...merged.capabilities].map((address): [string, StaticScanSource] => [address, 'frontend']),
    ...[...backendCapabilities].map((address): [string, StaticScanSource] => [address, 'backend']),
  ].sort(compareTuples)
  const readPaths = keep(pySorted(merged.readPaths)).slice(0, STATIC_SCAN_LIMITS.maxPaths)
  const writePaths = keep(pySorted(merged.writePaths)).slice(0, STATIC_SCAN_LIMITS.maxPaths)
  if (merged.readPaths.size > STATIC_SCAN_LIMITS.maxPaths || merged.writePaths.size > STATIC_SCAN_LIMITS.maxPaths) truncated = true
  if (redactions) skip('redacted', redactions)
  return {
    schemaVersion: STATIC_SCAN_SCHEMA_VERSION,
    scanner: { id: STATIC_SCANNER_ID, version: STATIC_SCANNER_VERSION },
    artifactDigest: input.artifactDigest,
    target: input.target,
    scannedAt: timestamp(input.now ?? new Date()),
    coverage: {
      filesTotal,
      filesScanned,
      bytesScanned,
      skipped: pySorted(skipped.keys()).map((reason) => ({ reason, count: skipped.get(reason)! })),
      truncated,
      timedOut,
    },
    shell: { calls, dynamic: { count: merged.dynamic, files: merged.dynamicFiles } },
    network: { hosts: hostEntries.map(([host, source, hostCount]) => ({ host, source, count: hostCount })).slice(0, limit) },
    files: { readPaths, writePaths, dynamicPaths: merged.dynamicPaths },
    capabilities: capabilityEntries.map(([address, source]) => ({ address, source })).slice(0, limit),
    code: {
      frontend: anyScript
        ? {
            eval: merged.eval,
            newFunction: merged.newFunction,
            dynamicImport: merged.dynamicImport,
            stringTimers: merged.stringTimers,
            obfuscationSignals: pySorted(merged.obfuscationSignals),
          }
        : null,
      backend: null,
    },
    native: natives.map((native) => nativeSummary(native, limit)),
  }
}

// ── declared vs scanned (twin of pluginDisclosureScan.declaredVsScanned) ─────

export interface StaticScanPermissions {
  system: string[]
  shell: { mode: 'allowlist'; executables: string[] } | { mode: 'full'; executables: null } | null
  scopes: { fs: { root: 'workspace' | 'repository'; read: string[]; write: string[] } } | null
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const sortedStrings = (values: readonly string[] | undefined): string[] => [...(values ?? [])].sort(compareCodeUnits)

/** The `permissions` part of the manifest's disclosure (pluginDisclosure.computeDisclosure). */
export function disclosurePermissions(manifest: unknown): StaticScanPermissions {
  const declared = ((manifest as { permissions?: unknown } | null)?.permissions ?? {}) as {
    system?: string[]
    shell?: string
    scopes?: { fs?: { root?: 'workspace' | 'repository'; read?: string[]; write?: string[] } }
  }
  const shell: StaticScanPermissions['shell'] =
    declared.shell === 'allowlist'
      ? { mode: 'allowlist', executables: [...HOST_SHELL_ALLOWLIST] }
      : declared.shell === 'full'
        ? { mode: 'full', executables: null }
        : null
  const fsScope = declared.scopes?.fs
  return {
    system: sortedStrings(declared.system),
    shell,
    scopes: fsScope ? { fs: { root: fsScope.root ?? 'workspace', read: sortedStrings(fsScope.read), write: sortedStrings(fsScope.write) } } : null,
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

export function scopePatternMatches(pattern: string, path: string): boolean {
  const segments = pattern.split('/')
  const parts = segments.map((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') return last ? '(?:[^/]+(?:/[^/]+)*)?' : '(?:[^/]+/)*'
    return segment.split('*').map(escapeRegExp).join('[^/]*') + (last ? '' : '/')
  })
  return new RegExp(`^${parts.join('')}$`).test(path)
}

export interface StaticScanItem {
  kind: string
  key: string
}

const listed = (items: Set<string>): StaticScanItem[] =>
  [...items]
    .map((joined) => {
      const [kind, key] = JSON.parse(joined) as [string, string]
      return { kind, key }
    })
    .sort((a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.key, b.key))

/** Contract 3.9: what the scan found that the manifest does not declare, and what it declares that the scan did not find. */
export function declaredVsScanned(
  disclosure: { permissions: StaticScanPermissions },
  scan: StaticScanReport
): { undeclared: StaticScanItem[]; declaredNotSeen: StaticScanItem[] } {
  const { system, shell, scopes } = disclosure.permissions
  const declared = new Set<string>(system)
  const undeclared = new Set<string>()
  const add = (set: Set<string>, kind: string, key: string): void => {
    set.add(JSON.stringify([kind, key]))
  }
  const calls = scan.shell.calls
  for (const call of calls) {
    if (shell === null) add(undeclared, 'shell', call.subcommand === null ? call.executable : `${call.executable} ${call.subcommand}`)
    else if (shell.mode === 'allowlist' && !(shell.executables ?? []).includes(call.executable)) {
      add(undeclared, 'shellExecutable', call.executable)
    }
  }
  if (shell === null && scan.shell.dynamic.count) add(undeclared, 'shellDynamic', 'dynamic')
  const namespaces = new Set(scan.capabilities.map((item) => item.address.split('.')[0]))
  if (shell === null && namespaces.has('shell')) add(undeclared, 'shell', 'shell.run')
  for (const namespace of ['aiCli', 'fs', 'ui']) {
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
  if (shell !== null && !calls.length && !scan.shell.dynamic.count && !namespaces.has('shell')) add(notSeen, 'shell', shell.mode)
  for (const namespace of system) {
    const seen = namespaces.has(namespace) ||
      (namespace === 'fs' && Boolean(files.readPaths.length || files.writePaths.length || files.dynamicPaths))
    if (!seen) add(notSeen, 'system', namespace)
  }
  return { undeclared: listed(undeclared), declaredNotSeen: listed(notSeen) }
}
