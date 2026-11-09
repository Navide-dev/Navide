// The local Host bridge of `navide-plugin dev-backend --workspace <dir>`:
// answers the backend's `navide/host/call` requests on the developer's own
// machine under the same admission rules as Navide's Host
// (pluginThirdPartyBackends.packageBridgeDispatcher, plansBridge's
// filesystem port, host_shell's public policy), so that a request the local
// bridge refuses is refused by Navide too. What the manifest does not
// declare is CAPABILITY_DENIED with reason `undeclared`; writes need
// `--allow-writes`, the developer's stand-in for the per-workspace write
// prompt; without `--workspace` every request is denied (`no-workspace`),
// as before 0.2.39. Every request is appended to `<data>/activity.jsonl`
// in the shape of Navide's `plugin_activity` rows.

import {
  appendFileSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeSync, closeSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { HOST_SHELL_EXECUTABLE_ALLOWLIST } from './dev-shell-policy.mjs'
import { declaredExecutables, parseCommand, validatePublicArgv, ShellPolicyError } from './dev-shell-policy.mjs'

export class DevBridgeError extends Error {
  constructor(code, reason, message) {
    super(message ?? code)
    this.code = code
    if (reason) this.reason = reason
  }
}

const PORTS = new Set([
  'filesystem', 'workspace-storage', 'terminal', 'agent-messaging', 'routes', 'streams', 'spawn', 'shell', 'web',
  'agents', 'agent-message-bodies', 'secrets', 'agent-notify',
])
const FS_READ = new Set(['read_file', 'read_range', 'list_dir', 'stat_path'])
const FS_WRITE = new Set(['write_file', 'write_part', 'write_commit', 'write_abort', 'delete', 'rename'])
const MAX_READ_BYTES = 5 * 1024 * 1024
const MAX_RANGE_BYTES = 96 * 1024
const MAX_DIR_ENTRIES = 2_000
const SHELL_OUTPUT_CHARS = 8_000
const SHELL_TIMEOUT_MS = 15_000

function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exactKeys(value, required, optional = []) {
  if (!isRecord(value)) throw new DevBridgeError('INVALID_ARGUMENT')
  const keys = Object.keys(value)
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new DevBridgeError('INVALID_ARGUMENT')
  }
  return value
}

/** The manifest's declared permissions, as the Host projects them. */
export function declaredPermissions(manifest) {
  const permissions = isRecord(manifest.permissions) ? manifest.permissions : {}
  const system = Array.isArray(permissions.system) ? permissions.system.filter((v) => typeof v === 'string') : []
  const shell = typeof permissions.shell === 'string'
    ? { mode: permissions.shell, executables: new Set() }
    : isRecord(permissions.shell) && permissions.shell.mode === 'allowlist'
      ? { mode: 'allowlist', executables: declaredExecutables(permissions.shell.executables) }
      : null
  return { system, shell }
}

/** The token values a provider CLI's config carries, for redaction (host_shell._project_provider_auth). */
function providerSecrets(configDir) {
  const secrets = new Set()
  for (const name of ['hosts.yml', 'config.yml']) {
    let text = ''
    try { text = readFileSync(join(configDir, name), 'utf8') } catch { continue }
    for (const match of text.matchAll(/^\s*(?:oauth_token|token|job_token|refresh_token|oauth2_refresh_token):\s*(\S+)\s*$/gm)) {
      const value = match[1].replace(/^['"]|['"]$/g, '')
      if (value.length >= 8) secrets.add(value)
    }
  }
  return [...secrets]
}

const UNSAFE_CORE_KEYS = new Set([
  'fsmonitor', 'hookspath', 'sshcommand', 'gitproxy', 'worktree', 'editor', 'pager', 'askpass', 'attributesfile',
  'alternaterefscommand', 'excludesfile',
])
/** Whole config sections that select programs, credentials, transports or signing. */
const UNSAFE_SECTIONS = new Set([
  'include', 'includeif', 'alias', 'credential', 'filter', 'gpg', 'protocol', 'ssh', 'safe', 'sendemail', 'submodule',
  'interactive', 'pager', 'mergetool', 'difftool', 'uploadpack', 'receive',
])
const UNSAFE_KEYS = new Set([
  'init.templatedir', 'gc.recentobjectshook', 'push.gpgsign', 'commit.gpgsign', 'tag.gpgsign', 'log.showsignature',
  'sequence.editor', 'diff.external',
])
/** `section.<subsection>.key` tails that select a program or rewrite a remote. */
const UNSAFE_SUBSECTION_KEYS = new Set([
  'diff.command', 'diff.textconv', 'merge.driver', 'remote.uploadpack', 'remote.receivepack', 'remote.proxy', 'remote.vcs',
  'url.insteadof', 'url.pushinsteadof',
])

/** The git argv and environment the Host broker runs git with: signing,
 *  hooks, helpers and transports off, and the repository discovery stopped at
 *  the workspace (no implicit bare repository above or at the root). */
export const PUBLIC_GIT_OVERRIDES = [
  '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.sshCommand=', '-c', 'credential.helper=',
  '-c', 'protocol.ext.allow=never', '-c', 'core.gitProxy=', '-c', 'safe.bareRepository=explicit',
  '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'log.showSignature=false',
  '-c', 'gpg.program=false', '-c', 'gpg.ssh.program=false', '-c', 'gpg.x509.program=false',
]

/** git_security.assert_public_git_config_safe: refuse a workspace Git config
 *  that selects a program (global and system config are off for the run).
 *  git parses the files itself (`git config --file … --list -z`, includes
 *  not followed), so no second parser can read them differently; a config
 *  git cannot read, or a missing git, refuses. The list is at least as
 *  strict as the Host's. */
export function assertPublicGitConfigSafe(cwd, workspaceRoot) {
  const refuse = () => new DevBridgeError('CAPABILITY_DENIED', 'policy', 'command is not permitted by the public shell policy')
  const root = realpathSync(workspaceRoot)
  const inside = (path) => {
    const real = realpathOrResolve(path)
    if (real !== root && !real.startsWith(`${root}${sep}`)) throw refuse()
    return real
  }
  let dir = realpathOrResolve(cwd)
  let gitDir = null
  while (dir === root || dir.startsWith(`${root}${sep}`)) {
    const candidate = join(dir, '.git')
    if (existsSync(candidate)) {
      const stat = statSync(candidate)
      if (stat.isDirectory()) gitDir = inside(candidate)
      else {
        const text = readFileSync(candidate, 'utf8').trim()
        if (!text.startsWith('gitdir:')) throw refuse()
        gitDir = inside(resolve(dir, text.slice('gitdir:'.length).trim()))
      }
      break
    }
    if (dir === root) break
    dir = dirname(dir)
  }
  // A workspace that is itself a bare repository (HEAD and config at the root).
  if (!gitDir && existsSync(join(root, 'HEAD')) && existsSync(join(root, 'config'))) gitDir = root
  if (!gitDir) return
  const configs = [join(gitDir, 'config'), join(gitDir, 'config.worktree')]
  const commondir = join(gitDir, 'commondir')
  if (existsSync(commondir)) {
    const value = readFileSync(commondir, 'utf8').trim()
    if (!value) throw refuse()
    configs.push(join(inside(resolve(gitDir, value)), 'config'))
  }
  for (const path of new Set(configs)) {
    if (!existsSync(path)) continue
    if (statSync(path).size > 1024 * 1024) throw refuse()
    const listed = spawnSync('git', ['config', '--file', path, '--list', '-z'], {
      encoding: 'utf8', timeout: 5_000, shell: false,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    })
    if (listed.status !== 0) throw refuse()
    for (const entry of (listed.stdout ?? '').split('\0')) {
      if (!entry) continue
      const fullKey = entry.split('\n')[0]
      const parts = fullKey.split('.')
      if (parts.length < 2) throw refuse()
      const section = parts[0].toLowerCase()
      const key = parts[parts.length - 1].toLowerCase()
      if (UNSAFE_SECTIONS.has(section)) throw refuse()
      if (section === 'core' && parts.length === 2 && UNSAFE_CORE_KEYS.has(key)) throw refuse()
      if (parts.length === 2 && UNSAFE_KEYS.has(`${section}.${key}`)) throw refuse()
      if (parts.length >= 3 && UNSAFE_SUBSECTION_KEYS.has(`${section}.${key}`)) throw refuse()
    }
  }
}

function realpathOrResolve(path) {
  try { return realpathSync(path) } catch { return resolve(path) }
}

export function createDevBridge({ manifest, workspaceRoot = null, allowWrites = false, providerAuth = false, activityFile, dataDir, runShell, now = Date.now }) {
  const declared = declaredPermissions(manifest)
  const root = workspaceRoot === null ? null : realpathSync(workspaceRoot)
  if (root !== null && !statSync(root).isDirectory()) throw new Error(`--workspace is not a directory: ${workspaceRoot}`)
  const rows = []
  const staging = new Map()

  function record(row) {
    const full = {
      at: now(),
      plugin_id: manifest.id,
      plugin_version: manifest.version,
      workspace: root ?? '',
      source: row.source,
      address: row.address,
      outcome: row.outcome,
      denied_reason: row.denied_reason ?? '',
      fs_path: row.fs_path ?? '',
      shell_command: row.shell_command ?? '',
    }
    rows.push(full)
    if (activityFile) {
      mkdirSync(dirname(activityFile), { recursive: true })
      appendFileSync(activityFile, `${JSON.stringify(full)}\n`)
    }
    return full
  }

  /** A workspace-relative path as the Host's filesystem service resolves it:
   *  inside the root, through no symbolic link that leaves it. */
  function workspacePath(value) {
    if (typeof value !== 'string' || value.includes('\0')) throw new DevBridgeError('INVALID_ARGUMENT')
    if (isAbsolute(value)) throw new DevBridgeError('WORKSPACE_SCOPE_VIOLATION')
    const target = resolve(root, value)
    const rel = relative(root, target)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new DevBridgeError('WORKSPACE_SCOPE_VIOLATION')
    // The nearest existing ancestor must still be inside the root (symbolic
    // links resolved), and the path itself must not be a dangling link, which
    // a write would follow out of the workspace.
    let probe = target
    while (!existsSync(probe)) {
      let link = null
      try { link = lstatSync(probe) } catch { link = null }
      if (link?.isSymbolicLink()) throw new DevBridgeError('WORKSPACE_SCOPE_VIOLATION')
      probe = dirname(probe)
    }
    const real = realpathSync(probe)
    if (real !== root && !real.startsWith(`${root}${sep}`)) throw new DevBridgeError('WORKSPACE_SCOPE_VIOLATION')
    return target
  }

  /** Write a whole file without following a link at the final component. */
  function writeWhole(path, data) {
    mkdirSync(dirname(path), { recursive: true })
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644)
    try { writeSync(fd, data) } finally { closeSync(fd) }
  }

  function mtimeOf(path) { return Math.floor(statSync(path).mtimeMs) }

  function filesystem(operation, args) {
    switch (operation) {
      case 'read_file': {
        const values = exactKeys(args, ['rel_path'], ['include_mtime'])
        if (values.include_mtime !== undefined && typeof values.include_mtime !== 'boolean') throw new DevBridgeError('INVALID_ARGUMENT')
        const path = workspacePath(values.rel_path)
        const stat = statSync(path)
        if (stat.size > MAX_READ_BYTES) throw new DevBridgeError('RESULT_TOO_LARGE')
        return { content: readFileSync(path, 'utf8'), mtime: Math.floor(stat.mtimeMs) }
      }
      case 'read_range': {
        const values = exactKeys(args, ['rel_path', 'offset', 'length'])
        const { offset, length } = values
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_RANGE_BYTES) {
          throw new DevBridgeError('INVALID_ARGUMENT')
        }
        const path = workspacePath(values.rel_path)
        const stat = statSync(path)
        const buffer = Buffer.alloc(Math.min(length, Math.max(0, stat.size - offset)))
        const fd = openSync(path, 'r')
        try { readSync(fd, buffer, 0, buffer.length, offset) } finally { closeSync(fd) }
        return { data_base64: buffer.toString('base64'), size: stat.size, eof: offset + buffer.length >= stat.size, mtime: Math.floor(stat.mtimeMs) }
      }
      case 'list_dir': {
        const values = exactKeys(args, ['rel_path'], ['mode'])
        if (values.mode !== undefined && values.mode !== 'discovery' && values.mode !== 'display') throw new DevBridgeError('INVALID_ARGUMENT')
        const path = workspacePath(values.rel_path)
        const names = readdirSync(path).sort()
        const truncated = names.length > MAX_DIR_ENTRIES
        return { entries: names.slice(0, MAX_DIR_ENTRIES), ...(truncated ? { truncated: true } : {}) }
      }
      case 'stat_path': {
        const path = workspacePath(exactKeys(args, ['rel_path']).rel_path)
        if (!existsSync(path)) return { exists: false, isDirectory: false, size: 0 }
        const stat = statSync(path)
        return { exists: true, isDirectory: stat.isDirectory(), size: stat.size }
      }
      case 'write_file': {
        const values = exactKeys(args, ['rel_path', 'content'], ['expected_mtime'])
        if (typeof values.content !== 'string' || (values.expected_mtime !== undefined && !Number.isFinite(values.expected_mtime))) {
          throw new DevBridgeError('INVALID_ARGUMENT')
        }
        const path = workspacePath(values.rel_path)
        if (values.expected_mtime !== undefined && existsSync(path) && mtimeOf(path) !== values.expected_mtime) {
          return { ok: false, conflict: true, mtime: mtimeOf(path) }
        }
        writeWhole(path, values.content)
        return { ok: true, mtime: mtimeOf(path) }
      }
      case 'write_part': {
        const values = exactKeys(args, ['rel_path', 'upload_id', 'offset', 'data_base64'])
        if (typeof values.upload_id !== 'string' || !values.upload_id || typeof values.data_base64 !== 'string' || !Number.isSafeInteger(values.offset) || values.offset < 0) {
          throw new DevBridgeError('INVALID_ARGUMENT')
        }
        const path = workspacePath(values.rel_path)
        const key = `${values.upload_id}\0${path}`
        const part = staging.get(key) ?? { chunks: [], size: 0 }
        if (part.size !== values.offset) throw new DevBridgeError('INVALID_ARGUMENT', undefined, 'parts must arrive in order')
        const bytes = Buffer.from(values.data_base64, 'base64')
        if (bytes.length > MAX_RANGE_BYTES) throw new DevBridgeError('INVALID_ARGUMENT')
        part.chunks.push(bytes)
        part.size += bytes.length
        staging.set(key, part)
        return { ok: true, size: part.size }
      }
      case 'write_commit': {
        const values = exactKeys(args, ['rel_path', 'upload_id', 'total_size'], ['expected_mtime'])
        const path = workspacePath(values.rel_path)
        const part = staging.get(`${values.upload_id}\0${path}`)
        if (!part || !Number.isSafeInteger(values.total_size) || part.size !== values.total_size) throw new DevBridgeError('INVALID_ARGUMENT')
        if (values.expected_mtime !== undefined && existsSync(path) && mtimeOf(path) !== values.expected_mtime) {
          return { ok: false, conflict: true, mtime: mtimeOf(path) }
        }
        staging.delete(`${values.upload_id}\0${path}`)
        writeWhole(path, Buffer.concat(part.chunks))
        return { ok: true, mtime: mtimeOf(path) }
      }
      case 'write_abort': {
        const values = exactKeys(args, ['rel_path', 'upload_id'])
        staging.delete(`${values.upload_id}\0${workspacePath(values.rel_path)}`)
        return { ok: true }
      }
      case 'delete': {
        const path = workspacePath(exactKeys(args, ['rel_path']).rel_path)
        rmSync(path, { recursive: true, force: false })
        return { ok: true }
      }
      case 'rename': {
        const values = exactKeys(args, ['from', 'to'])
        renameSync(workspacePath(values.from), workspacePath(values.to))
        return { ok: true }
      }
    }
    throw new DevBridgeError('METHOD_NOT_FOUND')
  }

  /** host_shell.run_public_allowlisted_text's execution wrapper: git, gh and
   *  glab run in a throw-away home with global and system Git config off,
   *  prompts, pagers and editors disabled, and git's process-selecting keys
   *  overridden; a declared executable runs as the user runs it from a
   *  terminal. gh and glab see the user's own sign-in only with
   *  --provider-auth (the Host projects it for an installed package), and
   *  the token values are redacted from what the backend reads. */
  const defaultRunShell = (argv, cwd) => {
    const hostFamily = HOST_SHELL_EXECUTABLE_ALLOWLIST.has(argv[0])
    let command = argv
    let env = process.env
    let isolated = null
    let secrets = []
    if (hostFamily) {
      isolated = mkdtempSync(join(tmpdir(), 'navide-public-cli-'))
      const configHome = join(isolated, 'config')
      mkdirSync(join(configHome, 'gh'), { recursive: true, mode: 0o700 })
      mkdirSync(join(configHome, 'glab'), { recursive: true, mode: 0o700 })
      const hooks = join(isolated, 'hooks')
      mkdirSync(hooks, { recursive: true, mode: 0o700 })
      env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: isolated,
        TMPDIR: `${isolated}/`,
        XDG_CONFIG_HOME: configHome,
        GH_CONFIG_DIR: join(configHome, 'gh'),
        GLAB_CONFIG_DIR: join(configHome, 'glab'),
        LANG: process.env.LANG ?? 'C',
        LC_ALL: process.env.LC_ALL ?? 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
        GH_PAGER: 'cat',
        GH_EDITOR: 'true',
        GLAB_PAGER: 'cat',
        GLAB_CHECK_UPDATE: 'false',
        GLAB_SEND_TELEMETRY: 'false',
        GH_NO_UPDATE_NOTIFIER: '1',
        EDITOR: 'true',
        VISUAL: 'true',
      }
      if (argv[0] === 'git') {
        command = ['git', ...PUBLIC_GIT_OVERRIDES, '-c', `core.hooksPath=${hooks}`, ...argv.slice(1)]
        env.GIT_CEILING_DIRECTORIES = dirname(cwd)
      } else if (providerAuth) {
        const userConfig = argv[0] === 'gh' ? (process.env.GH_CONFIG_DIR ?? join(xdgConfigHome(), 'gh')) : (process.env.GLAB_CONFIG_DIR ?? join(xdgConfigHome(), 'glab-cli'))
        if (argv[0] === 'gh') env.GH_CONFIG_DIR = userConfig
        else env.GLAB_CONFIG_DIR = userConfig
        secrets = providerSecrets(userConfig)
      }
    }
    try {
      const result = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8', timeout: SHELL_TIMEOUT_MS, shell: false, env })
      if (result.error && result.error.code === 'ENOENT') throw new DevBridgeError('BACKEND_UNAVAILABLE', undefined, `${argv[0]} is not installed`)
      const redact = (text) => secrets.reduce((acc, secret) => acc.split(secret).join('[redacted]'), text ?? '')
      const stdout = redact(result.stdout)
      const stderr = redact(result.stderr)
      return {
        exitCode: result.status ?? 126,
        stdout: stdout.slice(0, SHELL_OUTPUT_CHARS),
        stderr: stderr.slice(0, SHELL_OUTPUT_CHARS),
        ...(stdout.length > SHELL_OUTPUT_CHARS || stderr.length > SHELL_OUTPUT_CHARS ? { truncated: true } : {}),
      }
    } finally {
      if (isolated) rmSync(isolated, { recursive: true, force: true })
    }
  }

  function shell(operation, args) {
    if (operation !== 'run') throw new DevBridgeError('METHOD_NOT_FOUND')
    if (!isRecord(args) || Object.keys(args).length !== 1 || typeof args.command !== 'string') {
      throw new DevBridgeError('INVALID_ARGUMENT', undefined, 'shell.run takes exactly { command }')
    }
    let argv
    try {
      argv = validatePublicArgv(parseCommand(args.command), { workspaceRoot: root, allowedExecutables: declared.shell.executables })
    } catch (error) {
      if (error instanceof ShellPolicyError) throw new DevBridgeError('CAPABILITY_DENIED', 'policy', error.message)
      throw error
    }
    // Policy, not execution: a workspace Git config that selects a program
    // is refused before anything runs, whichever runner is in use.
    if (argv[0] === 'git') assertPublicGitConfigSafe(root, root)
    return (runShell ?? defaultRunShell)(argv, root)
  }

  function xdgConfigHome() {
    return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  }

  /** One `navide/host/call` `params`; returns `{ value }` or `{ error: { code, reason?, message? } }`. */
  async function handle(params) {
    if (!isRecord(params) || Object.keys(params).length !== 4 || !isRecord(params.origin) || typeof params.port !== 'string' ||
      typeof params.operation !== 'string' || !('arguments' in params)) {
      return { error: { code: 'PROTOCOL_ERROR' } }
    }
    if (!PORTS.has(params.port)) return { error: { code: 'PROTOCOL_ERROR' } }
    const address = `${params.port}.${params.operation}`
    const source = params.port === 'shell' ? 'shell' : 'broker'
    const argsRecord = isRecord(params.arguments) ? params.arguments : {}
    const detail = params.port === 'filesystem'
      ? { fs_path: typeof argsRecord.rel_path === 'string' ? argsRecord.rel_path : typeof argsRecord.from === 'string' ? argsRecord.from : '' }
      : params.port === 'shell' ? { shell_command: typeof argsRecord.command === 'string' ? argsRecord.command : '' } : {}
    const deny = (code, reason, message) => {
      record({ source, address, outcome: 'denied', denied_reason: reason ?? code, ...detail })
      return { error: { code, ...(reason ? { reason } : {}), ...(message ? { message } : {}) } }
    }
    const declaredPort = params.port === 'filesystem' ? declared.system.includes('fs')
      : params.port === 'shell' ? declared.shell?.mode === 'allowlist'
        : params.port === 'agents' ? declared.system.includes('agents')
          : params.port === 'agent-message-bodies' ? declared.system.includes('agentMessages')
            : params.port === 'secrets' ? declared.system.includes('secrets')
              : params.port === 'agent-notify' ? declared.system.includes('agentNotify')
                : false
    if (!declaredPort) return deny('CAPABILITY_DENIED', 'undeclared', `the manifest does not declare what '${params.port}' needs`)
    if (root === null) return deny('CAPABILITY_DENIED', 'no-workspace', 'run dev-backend with --workspace <dir> to serve this request')
    if (params.port === 'agents' || params.port === 'agent-message-bodies') {
      return deny('BACKEND_UNAVAILABLE', 'dev-backend', 'there are no agents in dev-backend; Navide serves this port')
    }
    if (params.port === 'secrets') {
      return deny('BACKEND_UNAVAILABLE', 'dev-backend', 'dev-backend keeps no secrets; Navide serves this port')
    }
    if (params.port === 'agent-notify') {
      return deny('BACKEND_UNAVAILABLE', 'dev-backend', 'there are no agent panes in dev-backend; Navide serves this port')
    }
    if (params.port === 'filesystem' && FS_WRITE.has(params.operation) && !allowWrites) {
      return deny('CAPABILITY_DENIED', 'write-not-granted', 'run dev-backend with --allow-writes to let the backend change the workspace')
    }
    if (params.port === 'filesystem' && !FS_READ.has(params.operation) && !FS_WRITE.has(params.operation)) {
      return deny('METHOD_NOT_FOUND')
    }
    try {
      const value = params.port === 'filesystem' ? filesystem(params.operation, params.arguments) : shell(params.operation, params.arguments)
      record({ source, address, outcome: 'allowed', ...detail })
      return { value }
    } catch (error) {
      if (error instanceof DevBridgeError) {
        if (error.code === 'CAPABILITY_DENIED') return deny(error.code, error.reason, error.message !== error.code ? error.message : undefined)
        record({ source, address, outcome: 'error', denied_reason: error.code, ...detail })
        return { error: { code: error.code, ...(error.reason ? { reason: error.reason } : {}), ...(error.message !== error.code ? { message: error.message } : {}) } }
      }
      const code = error?.code === 'ENOENT' ? 'INVALID_ARGUMENT' : 'INTERNAL_ERROR'
      record({ source, address, outcome: 'error', denied_reason: code, ...detail })
      return { error: { code, message: error instanceof Error ? error.message : String(error) } }
    }
  }

  return { handle, rows, root, declared, dataDir }
}
